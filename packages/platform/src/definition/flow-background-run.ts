import "server-only";

import { randomUUID } from "node:crypto";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "../access/human-organization-request";
import {
  identitySessionSchema,
  organizationSelectionCandidateSchema,
  type IdentitySession,
} from "../access/identity-access";
import type { JsonValue } from "../catalogue/common";
import { isRecord } from "../catalogue/runtime-primitives";
import { withRuntimeTransaction } from "../db/request-transaction";
import { createPageSubjectReader } from "../pages/page-subject-read";
import { createViewerSafeRecordLinkReadService } from "../queries/viewer-safe-record-link-read";
import { createRecordSaveService } from "../records/save-record";
import {
  resumeFlowRun,
  startFlowRun,
  type FlowRunStep,
  type FlowRuntimeValues,
} from "../rules/flow-interpreter";
import type {
  BackendAdapter,
  BackendRunOutcome,
  ClaimedBackendRun,
} from "../workflows/backend-adapters";
import { createFlowCurrentRecordReader } from "./flow-current-record";
import { createFlowRecordChangePort } from "./flow-record-changes";
import { installedFlowRelease } from "./flow-installed-release";
import type { FlowOrchestratorDependencies, FlowRelease, Run } from "./flow-orchestrator-types";
import { createFlowProtectedExecutor } from "./flow-protected-executor";
import { createFlowTaskRunner } from "./flow-task-runner";
import type { ApplicationStoreService } from "./installation-application-store";
import { createInstalledContextLoader } from "./installed-page-bundle-context";

/** How long the internal session minted for one back-end run stays valid. */
const mintedSessionSeconds = 300;

type ResolvedActor =
  | Readonly<{ kind: "available"; identityId: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

const resolveActor = async (organizationId: string, actorId: string): Promise<ResolvedActor> => {
  const rows = await withRuntimeTransaction(
    (transaction) => transaction.query`
      select vortex_platform.resolve_backend_actor(${organizationId}::uuid, ${actorId}::uuid) as result
    `,
  );
  const result = rows.length === 1 && isRecord(rows[0]) ? rows[0].result : undefined;
  if (isRecord(result) && result.kind === "available" && typeof result.identityId === "string")
    return { kind: "available", identityId: result.identityId };
  if (isRecord(result) && result.kind === "refused" && typeof result.reason === "string")
    return { kind: "refused", reason: result.reason };
  throw new Error("BACKEND_ACTOR_RESULT_INVALID");
};

/**
 * A session minted for this run alone, in memory: single-factor and with no authentication
 * evidence, so a step that needs recent sign-in or two-step verification is refused by the same
 * checks that refuse a person without them. It is never stored, logged, returned or reused.
 */
const mintSession = (identityId: string): IdentitySession => {
  const issued = Date.now() - 1_000;
  return identitySessionSchema.parse({
    identityId,
    sessionId: randomUUID(),
    authenticationStrength: "single_factor",
    accessTokenIssuedAt: new Date(issued).toISOString(),
    accessTokenExpiresAt: new Date(issued + mintedSessionSeconds * 1_000).toISOString(),
  });
};

const refused = (failureCode: string): BackendRunOutcome => ({ state: "refused", failureCode });

export type BackgroundRunDependencies = Readonly<{
  /** The request dependencies the host's other flow services run under. */
  requests: HumanOrganizationRequestDependencies;
  applicationStore: ApplicationStoreService;
  /** The adapter a back-end flow's own Run on back end step hands its child to. */
  backend: () => BackendAdapter;
}>;

/** The acting organisation account's open scope on one installed application. */
export type BackendActorScope = Readonly<{
  identityId: string;
  session: IdentitySession;
  selection: ReturnType<typeof organizationSelectionCandidateSchema.parse>;
  installation: ReturnType<typeof installedFlowRelease>;
  release: FlowRelease;
}>;

/**
 * Opens the scope a back-end run works in: the account must be active now, and its own current
 * access to the application decides whether the run can start at all.
 */
export const openBackendActorScope = async (
  requestDependencies: HumanOrganizationRequestDependencies,
  organizationId: string,
  applicationRootId: string,
  actorId: string,
): Promise<BackendActorScope | Readonly<{ reason: string }>> => {
  const actor = await resolveActor(organizationId, actorId);
  if (actor.kind === "refused") return { reason: actor.reason };
  const session = mintSession(actor.identityId);
  const selection = organizationSelectionCandidateSchema.parse({
    organizationId,
    applicationRootId,
  });
  const loaded = await createHumanOrganizationRequestService(requestDependencies).run(
    session,
    selection,
    async (transaction, scope) => {
      if (scope.applicationRootId === undefined) throw new Error("BACKEND_RUN_SCOPE_UNAVAILABLE");
      return createInstalledContextLoader(transaction, scope).load();
    },
  );
  if (loaded.kind !== "available") return { reason: "application_unavailable" };
  const installation = installedFlowRelease(loaded.value);
  if (installation.applicationRootId !== applicationRootId)
    return { reason: "application_unavailable" };
  const release: FlowRelease = {
    releaseKey: installation.releaseKey,
    installationRevision: installation.installationRevision,
    flows: installation.flows,
    plans: installation.plans,
    ...(installation.recordTypes === undefined ? {} : { recordTypes: installation.recordTypes }),
    ...(installation.namedActions === undefined ? {} : { namedActions: installation.namedActions }),
  };
  return { identityId: actor.identityId, session, selection, installation, release };
};

/**
 * Runs one claimed back-end run with the shared interpreter and the existing task runner, as the
 * organisation account that started it. Every protected task claims its effect in the ledger as
 * the system principal for that account, with the run as its source, so a repeat never writes
 * twice and nothing looks like a person's own change.
 */
export const createBackgroundFlowExecutor =
  (dependencies: BackgroundRunDependencies) =>
  async (claimed: ClaimedBackendRun): Promise<BackendRunOutcome> => {
    const opened = await openBackendActorScope(
      dependencies.requests,
      claimed.organizationId,
      claimed.applicationRootId,
      claimed.actorId,
    );
    if ("reason" in opened) return refused(opened.reason);
    const { identityId, session, selection, installation, release } = opened;
    const requests = createHumanOrganizationRequestService(dependencies.requests);
    const flow = release.flows.get(claimed.flowId);
    if (flow === undefined) return refused("flow_unavailable");
    if (flow.execution !== "background") return refused("flow_not_background");

    // Each record change runs in its own request transaction under the actor's current scope.
    const inActor = async <Result>(
      operation: (bound: Parameters<typeof createFlowRecordChangePort>[0]) => Promise<Result>,
    ): Promise<Result> => {
      const result = await requests.runChange(
        session,
        selection,
        async (transaction, scope, issuedAt) =>
          operation({ transaction, session, selection, scope, issuedAt, mode: "shared" }),
      );
      if (result.kind !== "available") throw new Error("BACKEND_RUN_REQUEST_UNAVAILABLE");
      return result.value;
    };
    const subjectReader = createPageSubjectReader(dependencies.requests);
    const ports: FlowOrchestratorDependencies = {
      continuationKey: undefined as never,
      admitSegment: () => Promise.reject(new Error("BACKEND_RUN_HAS_NO_SEGMENTS")),
      admitContinuation: () => Promise.reject(new Error("BACKEND_RUN_HAS_NO_CONTINUATION")),
      admitPageStart: () => Promise.reject(new Error("BACKEND_RUN_HAS_NO_PAGE")),
      executor: createFlowProtectedExecutor(dependencies.requests, dependencies.applicationStore),
      records: createRecordSaveService(dependencies.requests),
      recordChanges: {
        readTargets: (targets, lock) =>
          inActor((bound) => createFlowRecordChangePort(bound).readTargets(targets, lock)),
        readRevisions: (targets) =>
          inActor((bound) => createFlowRecordChangePort(bound).readRevisions(targets)),
        apply: (commandId, intents) =>
          inActor((bound) => createFlowRecordChangePort(bound).apply(commandId, intents)),
        restoreRevision: (recordTypeId, recordId) =>
          inActor((bound) =>
            createFlowRecordChangePort(bound).restoreRevision(recordTypeId, recordId),
          ),
      },
      subjects: {
        read: async (subjectSession, subjectSelection, subject) => {
          const result = await subjectReader.read(subjectSession, subjectSelection, subject);
          if (result.kind === "read" && result.row.revision === undefined)
            throw new Error("FLOW_RECORD_REVISION_MISSING");
          return result.kind === "read" ? { kind: "read", revision: result.row.revision! } : result;
        },
      },
      currentRecords: createFlowCurrentRecordReader({
        requests,
        reader: createViewerSafeRecordLinkReadService(),
        installation,
        identityId,
      }),
      backend: { run: (request) => dependencies.backend().run(request) },
      resolveActor: () => Promise.resolve(claimed.actorId),
      resolveRelease: () => Promise.resolve(release),
    };

    const inputs: Record<string, unknown> = { ...claimed.inputs };
    let triggerValues: FlowRuntimeValues | undefined;
    let subject: Readonly<{ recordId: string; revision: number }> | undefined;
    // The record the run acts on: the occurrence's record for a subscriber, else the record input.
    const eventTrigger = flow.triggers.find((trigger) => trigger.type === "Event");
    const recordTypeId =
      flow.recordInput === undefined
        ? eventTrigger?.recordTypeId
        : flow.inputs[flow.recordInput]?.recordTypeIds?.[0];
    if (claimed.origin === "event") {
      if (flow.recordInput !== undefined) inputs[flow.recordInput] = inputs.recordId;
      delete inputs.occurrenceId;
      if (flow.recordInput !== undefined) delete inputs.recordId;
    }
    const recordId =
      claimed.origin === "event"
        ? claimed.inputs.recordId
        : flow.recordInput === undefined
          ? undefined
          : inputs[flow.recordInput];
    if (recordTypeId !== undefined && recordId !== undefined) {
      if (typeof recordId !== "string") return refused("record_unavailable");
      const target = { recordTypeId, recordId };
      const read = await ports.currentRecords!.read(session, selection, target);
      const revision = await ports.subjects!.read(session, selection, target);
      if (read.outcome !== "read" || revision.kind !== "read") return refused("record_unavailable");
      triggerValues = read.values;
      subject = { recordId, revision: revision.revision };
    }

    const run: Run = {
      authority: { kind: "actor", actorId: claimed.actorId, session, selection },
      origin: "event",
      originId: claimed.backendRunId,
      flowId: claimed.flowId,
      bindingId: claimed.backendRunId,
      gestureId: claimed.backendRunId,
      release,
      library: (flowId) => release.flows.get(flowId),
      carriedMilliseconds: 0,
      segmentStart: performance.now(),
      unavailable: [],
      warnings: [],
      refusalLoggedTaskIds: [],
      sensitive: [],
      selectedRecordReadSeen: false,
    };
    const runner = createFlowTaskRunner(ports, () => Promise.resolve({ kind: "unavailable" }));

    let step: FlowRunStep = startFlowRun(
      {
        runId: claimed.backendRunId,
        flowId: claimed.flowId,
        inputs,
        now: new Date().toISOString(),
        actor: claimed.actorId,
        executionKinds: ["background"],
        ...(triggerValues === undefined ? {} : { triggerRecord: triggerValues }),
        ...(subject === undefined ? {} : { subject }),
      },
      run.library,
    );
    while (step.kind === "protected_task") {
      const result = await runner.run(run, step.state, step.call);
      step = resumeFlowRun(step.state, { kind: "task_result", ...result }, run.library);
    }
    if (step.kind !== "finished") return refused("step_not_available_on_back_end");
    if (step.result.status === "failed") {
      const failure = step.result.failure;
      return {
        state:
          failure.outcome === "failed" || failure.outcome === "uncertain" ? "failed" : "refused",
        failureCode: failure.diagnostic?.code ?? failure.code,
      };
    }
    const outputs: Record<string, JsonValue> = Object.fromEntries(
      Object.entries(step.result.outputs).map(([name, value]) => [name, value.value as JsonValue]),
    );
    return { state: "succeeded", outputs };
  };
