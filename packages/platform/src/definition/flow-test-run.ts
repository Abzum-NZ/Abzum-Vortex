import "server-only";

import { randomUUID } from "node:crypto";
import type {
  BoundHumanOrganizationRequest,
  HumanOrganizationRequestDependencies,
} from "../access/human-organization-request";
import type { JsonValue } from "../catalogue/common";
import { sameId } from "../catalogue/runtime-primitives";
import { findPlatformServiceOperation } from "../catalogue/platform-service-operation-catalogue";
import { requireRequestSavepoint } from "../db/request-transaction";
import { orderSubscribers, subscribes } from "../events/flow-subscriber-consumer";
import { createViewerSafeRecordLinkReadService } from "../queries/viewer-safe-record-link-read";
import type { QueryContinuationKey } from "../queries/continuation-token";
import { createNamedActionRecordPort } from "../records/action-record-port";
import { executeNamedActionCommandSchema } from "../records/named-actions";
import { createRecordSaveService } from "../records/save-record";
import type { BackendRunRequest, BackendRunResult } from "../workflows/backend-adapters";
import { flowTaskChildLists, type FlowTask } from "../workflows/flow-contracts";
import type { FlowRefusalFeedback } from "../workflows/flow-refusal-feedback";
import type { FlowServerSegment } from "../workflows/flow-plan";
import type { ApplicationStoreService } from "./installation-application-store";
import { runBackendFlow, type BackgroundRunDependencies } from "./flow-background-run";
import { installedFlowRelease } from "./flow-installed-release";
import { createFlowOrchestrator } from "./flow-orchestrator";
import type {
  FlowOrchestratorDependencies,
  FlowOrchestratorResponse,
  FlowRelease,
} from "./flow-orchestrator-types";
import { createFlowRunPorts, type FlowRunPortsHost } from "./flow-run-ports";
import {
  createFlowTraceCollector,
  type FlowTraceLocation,
  type FlowTraceNotRun,
  type FlowTraceStep,
} from "./flow-test-trace";
import type { InstalledRuntimeContext } from "./installed-runtime-context";
import { createInstalledContextLoader } from "./installed-page-bundle-context";
import { protectedOperationMetadata } from "./protected-operation-metadata";
import { createViewerSafeRecordLinkService } from "./viewer-safe-record-link";
import type { createDatabaseApplicationBoundReleaseSetService } from "./application-bound-release-set";

/** What the host supplies besides the builder's own request. */
export type FlowTestRunDependencies = Readonly<{
  requests: HumanOrganizationRequestDependencies;
  applicationStore: ApplicationStoreService;
  continuationKey: QueryContinuationKey;
  permissions: Parameters<typeof createDatabaseApplicationBoundReleaseSetService>[0]["permissions"];
}>;

export type FlowTestRunRequest = Readonly<{
  flowId: string;
  inputs: Readonly<Record<string, unknown>>;
}>;

/** How a test run ended: the flow's own outcome, or why it stopped early. */
type FlowTestRunEnd =
  | Readonly<{
      kind: "finished";
      outcome: string;
      failureCode?: string;
      diagnostic?: FlowRefusalFeedback;
      ruleRefusalMessage?: string;
      outputs: Readonly<Record<string, JsonValue>>;
    }>
  | Readonly<{ kind: "stopped"; reason: "needs_a_person" | FlowTraceNotRun | "refused" }>;

export type FlowTestRunResult = Readonly<{
  end: FlowTestRunEnd;
  steps: readonly FlowTraceStep[];
  totalMs: number;
}>;

/** A test run delivers at most this many occurrences, so subscribers that save cannot loop. */
const maximumOccurrences = 50;

const notRunReason = (segment: FlowServerSegment): FlowTraceNotRun | undefined =>
  segment.multiTransaction
    ? "multi_transaction"
    : segment.accessChange
      ? "access_change"
      : segment.preScopeLock !== null
        ? "scope_lock"
        : undefined;

const allTasks = (tasks: readonly FlowTask[]): FlowTask[] =>
  tasks.flatMap((task) => [
    task,
    ...allTasks(flowTaskChildLists(task).flatMap((child) => child.tasks)),
  ]);

/**
 * Runs the draft flow of the builder's preview for real against the preview's data, in the
 * builder's own request, with the same orchestrator, interpreter and task runner as every run. Only
 * the gate around each segment differs: a segment is not claimed, rate limited or recorded, a step
 * with an effect beyond the database is not run, and a back-end step runs inline. The caller
 * rolls the whole request back, so nothing a step changed remains.
 */
export const runFlowTest = async (
  bound: BoundHumanOrganizationRequest,
  context: InstalledRuntimeContext,
  dependencies: FlowTestRunDependencies,
  request: FlowTestRunRequest,
): Promise<FlowTestRunResult> => {
  const installation = installedFlowRelease(context);
  const release: FlowRelease = {
    releaseKey: installation.releaseKey,
    installationRevision: installation.installationRevision,
    flows: installation.flows,
    plans: installation.plans,
    ...(installation.recordTypes === undefined ? {} : { recordTypes: installation.recordTypes }),
    ...(installation.namedActions === undefined ? {} : { namedActions: installation.namedActions }),
    ...(installation.selectedRecordReadProjections === undefined
      ? {}
      : { selectedRecordReadProjections: installation.selectedRecordReadProjections }),
  };
  const locate = (flowId: string, taskId: string, backEnd: boolean): FlowTraceLocation => {
    if (backEnd) return "back end";
    const plan = release.plans.get(flowId);
    const segmentId = plan?.taskSegmentIds.get(taskId);
    return plan?.segments.some((part) => part.kind === "server" && part.id === segmentId) === true
      ? "server"
      : "page";
  };
  const trace = createFlowTraceCollector(locate);
  const requestDependencies = dependencies.requests;
  const host: FlowRunPortsHost = {
    requestDependencies,
    identitySession: bound.session,
    applicationKey: context.releaseSet.application.definitionKey,
    applicationStore: dependencies.applicationStore,
    records: createRecordSaveService(requestDependencies),
    actionRecords: createNamedActionRecordPort(requestDependencies),
    backend: { run: () => Promise.reject(new Error("FLOW_TEST_RUN_BACKEND_IS_INLINE")) },
    continuationKey: dependencies.continuationKey,
    selectedRecordReader: createViewerSafeRecordLinkReadService(),
    recordPinService: createViewerSafeRecordLinkService({
      ...requestDependencies,
      permissions: dependencies.permissions,
      createInstalledContextLoader: (transaction, scope) => {
        if (scope.applicationRootId === undefined) throw new Error("RECORD_PIN_TARGET_UNAVAILABLE");
        return createInstalledContextLoader(transaction, scope);
      },
      // A step that reaches another application runs several transactions: it is not run.
      resolveTargetApplication: () => Promise.resolve(undefined),
    }),
  };

  /** What the flow saved, in order: each is an occurrence its after-save subscribers would receive. */
  const occurrences: {
    recordTypeId: string;
    recordId: string;
    eventKind: "created" | "changed" | "deleted" | "restored";
    occurrenceId: string;
  }[] = [];
  const note = (
    recordTypeId: string,
    recordId: string,
    eventKind: (typeof occurrences)[number]["eventKind"],
  ): void => {
    occurrences.push({ recordTypeId, recordId, eventKind, occurrenceId: randomUUID() });
  };

  /** Subscribers to events the flow's named actions announced: listed in the trace, never run. */
  const announced: { flowId: string; flowKey: string }[] = [];
  const noteAnnouncements = (command: unknown): void => {
    const parsed = executeNamedActionCommandSchema.safeParse(command);
    if (!parsed.success) return;
    const { application, modules } = context.releaseSet;
    const action = [
      ...application.content.actions,
      ...modules.flatMap((m) => m.content.actions),
    ].find((candidate) => sameId(candidate.actionId, parsed.data.action.actionId));
    const events = [...application.content.events, ...modules.flatMap((m) => m.content.events)];
    for (const eventKey of action?.writePolicy?.eventKeys ?? []) {
      const event = events.find((candidate) => candidate.key === eventKey);
      if (event?.recordTypeId === undefined) continue;
      for (const subscriber of release.flows.values())
        if (
          subscribes(subscriber, {
            kind: "declared",
            key: eventKey,
            recordTypeId: String(event.recordTypeId),
          })
        )
          announced.push({ flowId: subscriber.id, flowKey: subscriber.key });
    }
  };

  /** The back end of one request: a child runs inline, in that request, as the builder. */
  const inlineFor = (current: BoundHumanOrganizationRequest) => {
    const backgroundDependencies: BackgroundRunDependencies = {
      requests: requestDependencies,
      applicationStore: dependencies.applicationStore,
      backend: () => inline,
    };
    /** A back-end child runs here, in the same request, as the builder; no run is recorded. */
    const inline: { run(request: BackendRunRequest): Promise<BackendRunResult> } = {
      run: async (backendRequest) => {
        const childRunId = randomUUID();
        const outcome = await trace.insideBackEnd(() =>
          runBackendFlow(
            backgroundDependencies,
            { ...requestDependencies, boundRequest: current },
            {
              identityId: current.session.identityId,
              session: current.session,
              selection: current.selection,
              installation,
              release,
            },
            {
              runId: childRunId,
              flowId: backendRequest.flowId,
              actorId: backendRequest.actorId,
              origin: backendRequest.origin,
              inputs: backendRequest.inputs,
            },
            trace,
          ),
        );
        if (outcome.state !== "succeeded")
          return {
            kind: "not_finished",
            backendRunId: childRunId,
            state: outcome.state,
            failureCode: outcome.failureCode ?? "unspecified",
          };
        return backendRequest.mode === "start"
          ? { kind: "started", backendRunId: childRunId }
          : { kind: "finished", backendRunId: childRunId, outputs: outcome.outputs ?? {} };
      },
    };
    return inline;
  };

  const portsFor = (current: BoundHumanOrganizationRequest): FlowOrchestratorDependencies => {
    const runId = randomUUID();
    const inline = inlineFor(current);
    const admission: Pick<
      FlowOrchestratorDependencies,
      "admitSegment" | "admitContinuation" | "admitPageStart"
    > = {
      admitPageStart: () =>
        Promise.resolve({ kind: "completed", value: null, runId, committedNow: false }),
      admitContinuation: async (_run, _state, execute) => {
        const executed = await execute();
        return {
          kind: "completed",
          value: executed.kind === "finished" ? executed.value : executed.value(""),
          runId,
          committedNow: false,
        };
      },
      admitSegment: async (run, _state, segment, execute) => {
        const reason = notRunReason(segment);
        if (reason !== undefined) {
          for (const task of allTasks(segment.tasks)) trace.notRun(run.flowId, task, reason);
          return { kind: "refused", committedNow: false };
        }
        // A refused or failed segment undoes its own changes, as in a normal run.
        const declined = new Error("FLOW_TEST_SEGMENT_DECLINED");
        const noted = occurrences.length;
        const announcedBefore = announced.length;
        let lost: Awaited<ReturnType<typeof execute>> | undefined;
        try {
          return await requireRequestSavepoint(current.transaction).withSavepoint(async (child) => {
            const executed = await execute(portsFor({ ...current, transaction: child }), undefined);
            if (executed.outcome !== "succeeded") {
              lost = executed;
              occurrences.length = noted;
              announced.length = announcedBefore;
              throw declined;
            }
            return {
              kind: "completed" as const,
              value: executed.value,
              runId,
              committedNow: false,
            };
          });
        } catch (error) {
          if (error === declined && lost !== undefined)
            return { kind: "completed", value: lost.value, runId, committedNow: false };
          throw error;
        }
      },
    };
    const ports = createFlowRunPorts(host, release, undefined, installation, admission, current);
    const { records, recordChanges, actionRecords } = ports;
    return {
      ...ports,
      trace,
      ...(records === undefined
        ? {}
        : {
            records: {
              save: async (session, selection, command) => {
                const result = await records.save(session, selection, command);
                if (result.kind === "available" && result.value.outcome === "saved")
                  note(
                    command.recordTypeId,
                    result.value.recordId,
                    command.operation === "create" ? "created" : "changed",
                  );
                return result;
              },
            },
          }),
      ...(recordChanges === undefined
        ? {}
        : {
            recordChanges: {
              ...recordChanges,
              apply: async (commandId, intents) => {
                const result = await recordChanges.apply(commandId, intents);
                if (result.kind === "completed")
                  result.results.forEach((saved, index) => {
                    const intent = intents[index];
                    if (intent === undefined || !("recordId" in saved)) return;
                    note(
                      intent.recordTypeId,
                      saved.recordId,
                      intent.operation === "create"
                        ? "created"
                        : intent.operation === "update"
                          ? "changed"
                          : intent.operation === "delete"
                            ? "deleted"
                            : "restored",
                    );
                  });
                return result;
              },
            },
          }),
      ...(actionRecords === undefined
        ? {}
        : {
            actionRecords: {
              execute: async (session, selection, command, run) => {
                const result = await actionRecords.execute(session, selection, command, run);
                if (result.kind === "available" && result.value.outcome === "completed")
                  noteAnnouncements(command);
                return result;
              },
            },
          }),
      // The builder's own authority opens the draft, so the flow's invocation permission is not asked.
      authorizeInvocation: () => Promise.resolve(true),
      backend: inline,
      executor: {
        execute: async (executorRequest) => {
          const registered = findPlatformServiceOperation(
            executorRequest.operation.serviceId,
            executorRequest.operation.operationId,
            executorRequest.operation.releaseVersion,
          );
          if (
            registered !== undefined &&
            protectedOperationMetadata[registered.key as keyof typeof protectedOperationMetadata]
              .externalEffect === true
          ) {
            if (executorRequest.effectKey !== undefined)
              trace.skip(
                executorRequest.effectKey.taskPath,
                executorRequest.effectKey.iteration,
                "external_effect",
              );
            return { outcome: "completed", outputs: {} };
          }
          return ports.executor.execute(executorRequest);
        },
      },
    };
  };

  // A flow that runs for a record gets that record as the page's subject, with its current revision.
  const ports = portsFor(bound);
  const flow = release.flows.get(request.flowId);
  const recordInput =
    flow?.recordInput ??
    Object.entries(flow?.inputs ?? {}).find(([, input]) => input.type === "record_reference")?.[0];
  const recordId = recordInput === undefined ? undefined : request.inputs[recordInput];
  const recordTypeId =
    recordInput === undefined ? undefined : flow?.inputs[recordInput]?.recordTypeIds?.[0];
  const subjectRead =
    typeof recordId === "string" && recordTypeId !== undefined
      ? await ports.subjects?.read(bound.session, bound.selection, { recordTypeId, recordId })
      : undefined;
  const started = performance.now();
  const response: FlowOrchestratorResponse = await createFlowOrchestrator(ports).invokeBinding({
    session: bound.session,
    selection: bound.selection,
    bindingId: randomUUID(),
    gestureId: randomUUID(),
    binding: { flowId: request.flowId, inputs: { ...request.inputs } },
    ...(subjectRead?.kind === "read" && typeof recordId === "string"
      ? { subject: { recordId, revision: subjectRead.revision } }
      : {}),
  });
  // After the flow, each occurrence reaches the subscribers its record type and event name, as
  // they would after a commit: in order, each in the back end's own run, in this same request.
  const scope = {
    identityId: bound.session.identityId,
    session: bound.session,
    selection: bound.selection,
    installation,
    release,
  };
  const backend = inlineFor(bound);
  for (let next = 0; next < occurrences.length && next < maximumOccurrences; next += 1) {
    const occurrence = occurrences[next]!;
    const subscribers = orderSubscribers(
      [...release.flows.values()].filter((candidate) =>
        subscribes(candidate, {
          kind: "standard",
          eventKind: occurrence.eventKind,
          recordTypeId: occurrence.recordTypeId,
        }),
      ),
    );
    for (const subscriber of subscribers) {
      const startedAt = performance.now();
      const outcome = await trace.insideBackEnd(() =>
        runBackendFlow(
          {
            requests: requestDependencies,
            applicationStore: dependencies.applicationStore,
            backend: () => backend,
          },
          { ...requestDependencies, boundRequest: bound },
          scope,
          {
            runId: randomUUID(),
            flowId: subscriber.id,
            actorId: bound.scope.organizationAccountId,
            origin: "event",
            inputs: { recordId: occurrence.recordId, occurrenceId: occurrence.occurrenceId },
          },
          trace,
        ),
      );
      trace.subscriber(
        subscriber.id,
        subscriber.key,
        outcome.state,
        outcome.failureCode,
        startedAt,
      );
    }
  }
  for (const subscriber of announced) trace.subscriberNotRun(subscriber.flowId, subscriber.flowKey);
  const totalMs = Math.round((performance.now() - started) * 100) / 100;
  const steps = trace.steps();
  const paused = steps.at(-1)?.outcome === "paused";
  const skipped = steps.find((step) => step.notRun !== undefined && step.outcome === "not_run");
  const end: FlowTestRunEnd =
    response.kind === "finished"
      ? {
          kind: "finished",
          outcome: response.outcome,
          ...(response.failure === undefined ? {} : { failureCode: response.failure.code }),
          ...(response.failure?.diagnostic === undefined
            ? {}
            : { diagnostic: response.failure.diagnostic }),
          outputs: response.outputs,
        }
      : paused
        ? { kind: "stopped", reason: "needs_a_person" }
        : skipped?.notRun !== undefined && steps.at(-1)?.notRun !== undefined
          ? { kind: "stopped", reason: skipped.notRun }
          : { kind: "stopped", reason: "refused" };
  return { end, steps, totalMs };
};
