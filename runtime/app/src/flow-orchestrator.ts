import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  isRecord,
  PLATFORM_SERVICE_OPERATIONS,
  executeNamedActionCommandV2Schema,
  applicationRootIdSchema,
  correlationIdSchema,
  flowIdSchema,
  flowLiteralSchema,
  groupIdSchema,
  flowMaximumServerSeconds,
  flowSchema,
  flowTaskChildLists,
  executionAuthorityContextSchema,
  formContinuationAnswerSchema,
  identitySessionSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  organizationSelectionCandidateSchema,
  platformOperationKey,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  ruleIdSchema,
  saveRecordCommandV2Schema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
  type ExecutionAuthorityContext,
  type ExecuteNamedActionCommandV2,
  type FlowDefinition,
  type ExecuteNamedActionResultV2,
  type FlowTask,
  type IdentitySession,
  type InstalledNamedActionReferenceV2,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type SaveRecordCommandV2,
  type SaveRecordResultV2,
  type FlowTriggerOrigin,
} from "@vortex/contracts";
import {
  readFlowRunAsPrincipalForRun,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import { withRuntimeTransaction } from "@vortex/db";
import {
  collectActionFlowTasks,
  resumeFlowRun,
  startFlowRun,
  type ActionFlowRunner,
  type BeforeSaveRuleWarning,
  type FlowFailureCode,
  type FlowFailureOutcome,
  type FlowInterfaceIntent,
  type FlowLibrary,
  type FlowProtectedTaskCall,
  type FlowRunResume,
  type FlowRunState,
  type FlowRunStep,
  type FlowSubject,
  type FlowTaskOutcome,
} from "@vortex/rule";
import { z } from "zod";
import type {
  FlowContinuationStore,
  FlowEffectLedger,
  FlowEffectPrincipal,
} from "./flow-continuation-store";
import type { ProtectedOperationExecutor } from "./protected-operation-executor";

export type { FlowSubject };

/**
 * The server orchestrator of the in-house flow engine (architecture decision 1, "Who drives a
 * flow"). Any flow that contains a protected task is driven from its first task here, for the
 * person who started it. The pure interpreter (`@vortex/rule`) decides what each task does; this
 * module supplies everything the interpreter must not have: the trusted session, the run id, the
 * clock, the continuation store and the protected-operation executor.
 *
 * What it guarantees:
 * - Person starts and resumes use only the verified session and selected organisation. A
 *   committed Event start accepts only its stored intent ID, reloads the exact retained release,
 *   and resolves the Access-owned non-person principal without creating or borrowing a session.
 * - Person protected tasks run through the one executor (`protected-operation-executor.ts`), in
 *   their own short transaction, and only after the effect ledger claims the run, task path,
 *   iteration, principal and origin. Event protected tasks fail closed until exact per-task grant
 *   resolution is available; neither path can repeat an uncertain effect.
 * - A person continuation is a random token whose hash keys one server-stored row bound to the run,
 *   the initiator, the organisation and the exact flow release. It expires, is handed back once,
 *   and a token that is unknown, expired, used, foreign or for another release is one neutral result.
 * - The page subject and revision are kept in that server-stored run state as evidence. Protected
 *   tasks recheck current read access and pass the same expected revision to the owning operation.
 * - The run limits are enforced here and in the interpreter: 100 For each items, 25 protected
 *   operations, 10 seconds of server time (across every resume) and a Run flow depth of 3.
 * - A task the platform cannot run yet fails with a located `not_yet_available` notice and the
 *   `task_not_available` failure code, never as a refusal, so a person is not told they lack a
 *   permission for something that does not exist yet. It is never run inline and never guessed.
 * - A Save record task runs through the record save port (`records`): the ordinary-human protected
 *   save, in its own transaction under the initiator's verified request. Its values are named by the
 *   exact release's field keys or field identities, and a change to an existing record is bound to
 *   the revision the surface was rendered at, never to one read at save time.
 * - A named action is a `transaction` flow started through its binding (`executeAction`), or by a
 *   Call protected operation task that names the action's key for the surface's subject record.
 *   The same interpreter runs it for that record inside the transaction the record port owns, and
 *   the record changes it asks for are applied by that port in one apply record changes call, so a
 *   web button and an agent tool reach one entry point. Its actor is the verified session's
 *   organisation account, never anything the command carries.
 *
 * Every failure is a safe outcome; the orchestrator never throws to its caller.
 */

/** The seconds a suspended run may wait for the person's answer. */
export const flowContinuationLifetimeSeconds = 900;
const maximumPayloadCharacters = 65_536;
const serverMilliseconds = flowMaximumServerSeconds * 1_000;

/**
 * The exact set of compiled flows one run is bound to. `releaseKey` identifies that exact release
 * (for example the installed application's release evidence), so a continuation can only ever
 * resume against the flows it started with.
 */
export type FlowRelease = Readonly<{
  releaseKey: string;
  flows: ReadonlyMap<string, unknown>;
  /** The release's record types by lower-case record type id, for the values of a Save record task. */
  recordTypes?: ReadonlyMap<string, FlowRecordType>;
  /** The release's named actions by action key, for a Call protected operation task naming one. */
  namedActions?: ReadonlyMap<string, FlowNamedAction>;
}>;

/** Exact installation and compiled-flow release identity retained on a committed start intent. */
export const flowReleaseIdentitySchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    applicationReleaseVersion: stableDefinitionReleaseVersionSchema,
    flowOwnerKind: z.enum(["application", "module"]),
    flowOwnerRootId: z.union([applicationRootIdSchema, moduleRootIdSchema]),
    flowReleaseRevision: revisionSchema,
    flowReleaseVersion: stableDefinitionReleaseVersionSchema,
    flowReleaseFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type FlowReleaseIdentity = z.infer<typeof flowReleaseIdentitySchema>;

/** Trusted read shape of one committed Event start; callers supply only its intent identifier. */
export const committedFlowStartIntentSchema = z
  .object({
    intentId: z.uuid(),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    applicationReleaseVersion: stableDefinitionReleaseVersionSchema,
    flowRelease: z.discriminatedUnion("ownerKind", [
      z
        .object({
          ownerKind: z.literal("application"),
          rootId: applicationRootIdSchema,
          revision: revisionSchema,
          version: stableDefinitionReleaseVersionSchema,
          fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        })
        .strict(),
      z
        .object({
          ownerKind: z.literal("module"),
          rootId: moduleRootIdSchema,
          revision: revisionSchema,
          version: stableDefinitionReleaseVersionSchema,
          fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
    flowId: flowIdSchema,
    origin: z.literal("event"),
    originId: z.uuid(),
    trigger: z.object({ type: z.literal("Event"), id: z.string().min(1).max(1300) }).strict(),
    inputs: z.record(z.string().min(1).max(200), flowLiteralSchema),
    triggerValues: z.record(z.string().min(1).max(200), flowLiteralSchema),
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      intent.flowRelease.ownerKind === "application" &&
      (intent.flowRelease.rootId !== intent.applicationRootId ||
        intent.flowRelease.revision !== intent.applicationReleaseRevision ||
        intent.flowRelease.version !== intent.applicationReleaseVersion)
    )
      context.addIssue({
        code: "custom",
        path: ["flowRelease"],
        message: "Application flow release differs from the installation",
      });
  });
export type CommittedFlowStartIntent = z.infer<typeof committedFlowStartIntentSchema>;

const releaseIdentityForIntent = (intent: CommittedFlowStartIntent): FlowReleaseIdentity => ({
  organizationId: intent.organizationId,
  applicationRootId: intent.applicationRootId,
  applicationReleaseRevision: intent.applicationReleaseRevision,
  applicationReleaseVersion: intent.applicationReleaseVersion,
  flowOwnerKind: intent.flowRelease.ownerKind,
  flowOwnerRootId: intent.flowRelease.rootId,
  flowReleaseRevision: intent.flowRelease.revision,
  flowReleaseVersion: intent.flowRelease.version,
  flowReleaseFingerprint: intent.flowRelease.fingerprint,
});

const flowReleaseIdentityMatches = (
  expected: FlowReleaseIdentity,
  actual: FlowReleaseIdentity,
): boolean =>
  expected.organizationId.toLowerCase() === actual.organizationId.toLowerCase() &&
  expected.applicationRootId.toLowerCase() === actual.applicationRootId.toLowerCase() &&
  expected.applicationReleaseRevision === actual.applicationReleaseRevision &&
  expected.applicationReleaseVersion === actual.applicationReleaseVersion &&
  expected.flowOwnerKind === actual.flowOwnerKind &&
  expected.flowOwnerRootId.toLowerCase() === actual.flowOwnerRootId.toLowerCase() &&
  expected.flowReleaseRevision === actual.flowReleaseRevision &&
  expected.flowReleaseVersion === actual.flowReleaseVersion &&
  expected.flowReleaseFingerprint === actual.flowReleaseFingerprint;

/** One record type of a release: each field's identity by its key and by its own identity. */
export type FlowRecordType = Readonly<{
  /** Lower-case field key or field id, to the field id. */
  fieldIds: ReadonlyMap<string, string>;
}>;

/** A named action of a release: the one installed action a task names by its key. */
export type FlowNamedAction = Readonly<{
  action: InstalledNamedActionReferenceV2;
  /** The record type the action runs on. */
  subjectRecordTypeId: string;
}>;

/**
 * The protected save a Save record task runs through (#1369): the ordinary-human base save of the
 * record service (`createRecordSaveService`), in its own transaction under the initiator's verified
 * request. It owns every access, field, rule, calculation and revision decision.
 */
export type RecordSaveTaskPort = Readonly<{
  save(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: SaveRecordCommandV2,
  ): Promise<HumanOrganizationRequestResult<SaveRecordResultV2>>;
}>;

/** Confirms that the initiator can currently read a claimed page subject of the exact record type. */
export type FlowSubjectReadPort = Readonly<{
  read(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    subject: Readonly<{ recordTypeId: string; recordId: string }>,
  ): Promise<"read" | "refused" | "temporarily_unavailable">;
}>;

/**
 * What the record service runs for a named action (#1063): it prepares the action's subject under
 * the actor's authority, calls the supplied flow run inside its own transaction, and applies every
 * record change the flow collected in one apply record changes call. The result is the closed
 * named-action result; any before-save rule warnings travel beside it.
 */
export type NamedActionRecordPort = Readonly<{
  execute(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: unknown,
    run: ActionFlowRunner,
  ): Promise<
    HumanOrganizationRequestResult<ExecuteNamedActionResultV2> &
      Readonly<{ warnings?: readonly BeforeSaveRuleWarning[] }>
  >;
}>;

export type NamedActionExecutionResult = Awaited<ReturnType<NamedActionRecordPort["execute"]>>;

export type FlowOrchestratorDependencies = Readonly<{
  executor: Pick<ProtectedOperationExecutor, "execute">;
  /** Runs named-action flows; without it an action is unavailable. */
  actionRecords?: NamedActionRecordPort;
  /** Runs Save record tasks; without it a Save record task is unavailable. */
  records?: RecordSaveTaskPort;
  /** Verifies the viewer's read access to a claimed page subject before a protected change. */
  subjects?: FlowSubjectReadPort;
  continuations: FlowContinuationStore;
  ledger: FlowEffectLedger;
  /**
   * Resolves the flows of the release the organisation runs for a flow id, from trusted
   * installation state. `undefined` refuses the start without saying why.
   */
  resolveRelease: (
    organizationId: string,
    flowId: string,
  ) => Promise<FlowRelease | undefined>;
  /** Reads a committed Event intent by ID; the caller cannot supply its tenant, release or actor. */
  readCommittedStartIntent?: (intentId: string) => Promise<unknown>;
  /** Resolves the exact immutable release named by the committed intent, never the current pointer. */
  resolveCommittedStartRelease?: (
    intent: CommittedFlowStartIntent,
  ) => Promise<(FlowRelease & Readonly<{ identity: FlowReleaseIdentity }>) | undefined>;
  /**
   * Checks a flow's invocation permission for the initiator. Required whenever the started flow, or
   * any flow it can reach through Run flow, declares one; such a flow is unavailable to the run when
   * this is not supplied.
   */
  authorizeInvocation?: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    flow: FlowDefinition,
  ) => Promise<boolean>;
  /** The initiator's organisation account, for `{{ execution.actor }}`; absent means unresolved. */
  resolveActor?: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
  ) => Promise<string | undefined>;
  now?: () => Date;
  /** A monotonic clock in milliseconds, for the server-time limit. */
  clock?: () => number;
  newRunId?: () => string;
  newToken?: () => string;
}>;

const subjectSchema = z
  .object({
    recordId: recordIdSchema,
    revision: revisionSchema.max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();

const startRequestSchema = z
  .object({
    session: identitySessionSchema,
    selection: organizationSelectionCandidateSchema,
    binding: z
      .object({
        flowId: flowIdSchema,
        inputs: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
    /** The page record and revision the surface showed; it remains evidence across pauses. */
    subject: subjectSchema.optional(),
  })
  .strict();

const resumeRequestSchema = z
  .object({
    session: identitySessionSchema,
    selection: organizationSelectionCandidateSchema,
    flowId: flowIdSchema,
    continuation: z.string().min(16).max(128),
    answer: formContinuationAnswerSchema,
  })
  .strict();

export type FlowStartRequest = z.input<typeof startRequestSchema>;
export type FlowResumeRequest = z.input<typeof resumeRequestSchema>;

/**
 * What a caller last saw, compared with trusted server state before a run starts or resumes. It is
 * evidence, never authority: any difference refuses the call. A mismatch found only in the stored
 * run (its node, run id or committed effects) is found after the single-use continuation is
 * consumed, so a stale or forged continuation is spent and the person restarts.
 */
export type FlowRunExpectation = Readonly<{
  /** The exact release of the flow set; must equal the release trusted installation state resolves. */
  releaseKey: string;
  /** The paused node the caller answers; the stored run must be paused at exactly this node. */
  pausedAt?: Readonly<{ nodeId: string; awaiting: "form" | "confirm" }>;
  /** The receipt the caller holds; the stored run must be that run with that many committed effects. */
  receipt?: Readonly<{ runId: string; committedEffects: number }>;
}>;

/** Why a task did not run: the located, fail-closed "not yet available" outcome. */
export type FlowUnavailableNotice = Readonly<{
  taskId: string;
  taskType: string;
  code: "not_yet_available";
  /** The work that makes the task available. */
  requires: string;
}>;

type SafeIntent = Readonly<{
  kind: FlowInterfaceIntent["kind"];
  taskId: string;
  properties: Readonly<Record<string, JsonValue>>;
}>;

export type FlowOrchestratorResponse =
  | Readonly<{
      kind: "finished";
      runId: string;
      /**
       * `committed` when at least one protected effect committed, `completed` when the flow ran to
       * its end without one, and otherwise the safe failure outcome.
       */
      outcome: "committed" | "completed" | FlowFailureOutcome;
      /** Set only for a failure: which rule ended the run, and at which task. */
      failure?: Readonly<{ code: FlowFailureCode; taskId?: string }>;
      stopped?: string;
      /** Protected effects this run committed, across every resume: a later failure is then partial. */
      committedEffects: number;
      outputs: Readonly<Record<string, JsonValue>>;
      intents: readonly SafeIntent[];
      unavailable: readonly FlowUnavailableNotice[];
    }>
  | Readonly<{
      kind: "suspended";
      runId: string;
      awaiting: "form" | "confirm";
      /** The paused node (task id) the continuation resumes, and the release the run is bound to. */
      nodeId: string;
      releaseKey: string;
      committedEffects: number;
      /** The typed intent for the page or MCP client, ending with the form or confirmation. */
      intents: readonly SafeIntent[];
      continuation: string;
      expiresAt: string;
      unavailable: readonly FlowUnavailableNotice[];
    }>
  | Readonly<{ kind: "refused" }>;

const refused: FlowOrchestratorResponse = Object.freeze({ kind: "refused" });

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * The command identity of one protected task's record change: stable for the run, task path and
 * iteration, so a replayed run reaches the same record receipt instead of writing again. Version
 * and variant bits are set so it is a strictly valid UUID.
 */
const effectCommandId = (runId: string, taskPath: string, iteration: string): string => {
  const bytes = createHash("sha256")
    .update(["flow-task-command", runId.toLowerCase(), taskPath, iteration].join("|"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The task outcome of a protected record path's safe refusal code. */
const refusalOutcome = (code: string): FlowTaskOutcome =>
  code === "conflict" ? "conflict" : code === "invalid_request" ? "validation" : "refused";

/**
 * The task outcome of a protected record path that returned no result: a request the person's own
 * access refused, or whose refusal was recorded, is refused; one that could not run is failed.
 */
const requestOutcome = (kind: "unavailable" | "temporarily_unavailable"): FlowTaskOutcome =>
  kind === "unavailable" ? "refused" : "failed";

/** Tasks the platform cannot run on the server yet, and what each waits for. */
const notYetAvailable: Readonly<Record<string, string>> = Object.freeze({
  // A named action's record tasks run in its transaction flow through the record port; an
  // interactive flow runs only Save record, through the record save port.
  "record.save": "the interactive record task port",
  "record.create": "the interactive record task port",
  "record.set_fields": "the interactive record task port",
  "record.link": "the interactive record task port",
  "record.delete": "the interactive record task port",
  "record.restore": "the interactive record task port",
  "record.changes": "the interactive record task port",
  "record.query": "the interactive record task port",
  "flow.run_background": "#666 committed start intents",
  "event.announce": "the server event writer task",
  "message.acknowledge": "the message trigger (#1133)",
  "file.export": "the server file export task",
  "connection.call": "the durable Kestra runner",
});

const withinPayload = (candidate: unknown): boolean => {
  try {
    return (JSON.stringify(candidate) ?? "").length <= maximumPayloadCharacters;
  } catch {
    return false;
  }
};

/** The flows one flow starts through Run flow, anywhere in its tasks, errors or finally lists. */
const runFlowTargets = (flow: FlowDefinition): string[] => {
  const targets: string[] = [];
  const visit = (tasks: readonly FlowTask[]) => {
    for (const task of tasks) {
      if (task.type === "run_flow")
        targets.push((task as Extract<FlowTask, { type: "run_flow" }>).flowId);
      for (const child of flowTaskChildLists(task)) visit(child.tasks);
    }
  };
  visit(flow.tasks);
  visit(flow.errors);
  visit(flow.finally);
  return targets;
};

const safeIntent = (intent: FlowInterfaceIntent): SafeIntent => ({
  kind: intent.kind,
  taskId: intent.taskId,
  properties: Object.fromEntries(
    Object.entries(intent.properties).map(([name, value]) => [name, value.value]),
  ),
});

/**
 * A declared sensitive output (for example a raw invitation secret) is returned once in the live
 * result but never persisted: the stored effect records only `<output>_issued: true` in its place,
 * so replaying the same run reports the same outcome without re-revealing the value.
 */
const redactSensitiveOutputs = (
  outputs: Readonly<Record<string, JsonValue>>,
  sensitive: readonly string[],
): Record<string, JsonValue> => {
  if (sensitive.length === 0) return { ...outputs };
  const stored: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(outputs))
    if (!sensitive.includes(name)) stored[name] = value;
  for (const name of sensitive) if (Object.hasOwn(outputs, name)) stored[`${name}_issued`] = true;
  return stored;
};

/** The raw sensitive values of one result, as they appear inside serialized JSON. */
const sensitiveValues = (
  outputs: Readonly<Record<string, JsonValue>>,
  sensitive: readonly string[],
): string[] =>
  sensitive
    .filter((name) => Object.hasOwn(outputs, name))
    .map((name) => {
      const value = outputs[name];
      const text = JSON.stringify(value) ?? "";
      return typeof value === "string" ? text.slice(1, -1) : text;
    })
    .filter((text) => text.length > 0);

/** Whether a candidate that is about to leave memory carries any held sensitive value. */
const carriesSensitive = (candidate: unknown, sensitive: readonly string[]): boolean => {
  if (sensitive.length === 0) return false;
  let text: string;
  try {
    text = JSON.stringify(candidate) ?? "";
  } catch {
    return true;
  }
  return sensitive.some((value) => text.includes(value));
};

export const createFlowOrchestrator = (dependencies: FlowOrchestratorDependencies) => {
  const now = dependencies.now ?? (() => new Date());
  const clock = dependencies.clock ?? (() => performance.now());
  const newRunId = dependencies.newRunId ?? (() => randomUUID());
  const newToken = dependencies.newToken ?? (() => randomBytes(32).toString("base64url"));

  /** The library of validated flows of one release; an invalid flow is unavailable, never trusted. */
  const libraryOf = (release: FlowRelease): FlowLibrary => {
    const parsed = new Map<string, FlowDefinition | undefined>();
    return (flowId) => {
      if (parsed.has(flowId)) return parsed.get(flowId);
      const candidate = release.flows.get(flowId);
      const result = candidate === undefined ? undefined : flowSchema.safeParse(candidate);
      const flow = result?.success ? result.data : undefined;
      parsed.set(flowId, flow?.id === flowId ? flow : undefined);
      return parsed.get(flowId);
    };
  };

  type RunAuthority =
    | Readonly<{
        kind: "person";
        session: IdentitySession;
        selection: OrganizationSelectionCandidate;
      }>
    | Readonly<{
        kind: "execution_authority";
        context: ExecutionAuthorityContext;
        organizationId: string;
      }>;

  type PreparedPersonRun = Readonly<{
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    flowId: string;
    release: FlowRelease;
    library: FlowLibrary;
  }>;

  type Run = Readonly<{
    authority: RunAuthority;
    origin: FlowTriggerOrigin;
    originId: string;
    flowId: string;
    release: FlowRelease;
    library: FlowLibrary;
    /** Server milliseconds already spent by earlier segments of this run. */
    carriedMilliseconds: number;
    segmentStart: number;
    unavailable: FlowUnavailableNotice[];
    /**
     * The raw values of declared sensitive outputs this segment received, held in memory only, so
     * nothing that carries one is stored or handed to another protected operation.
     */
    sensitive: string[];
  }>;

  const elapsedMilliseconds = (run: Run): number =>
    Math.max(0, Math.round(run.carriedMilliseconds + (clock() - run.segmentStart)));

  const finished = (
    run: Run,
    step: Extract<FlowRunStep, { kind: "finished" }>,
  ): FlowOrchestratorResponse => {
    const intents = step.intents.map(safeIntent);
    if (step.result.status === "failed") {
      const failedTaskId = step.result.failure.taskId;
      // A task the platform could not run ends the run as not available, never as a refusal.
      const notAvailable =
        failedTaskId !== undefined && run.unavailable.some((notice) => notice.taskId === failedTaskId);
      return {
        kind: "finished",
        runId: step.state.runId,
        outcome: step.result.failure.outcome,
        committedEffects: step.state.committedEffects,
        failure: {
          code: notAvailable ? "task_not_available" : step.result.failure.code,
          ...(failedTaskId === undefined ? {} : { taskId: failedTaskId }),
        },
        outputs: {},
        intents,
        unavailable: run.unavailable,
      };
    }
    return {
      kind: "finished",
      runId: step.state.runId,
      outcome: step.state.committedEffects > 0 ? "committed" : "completed",
      committedEffects: step.state.committedEffects,
      ...(step.result.stopped === undefined ? {} : { stopped: step.result.stopped }),
      outputs: Object.fromEntries(
        Object.entries(step.result.outputs).map(([name, value]) => [name, value.value]),
      ),
      intents,
      unavailable: run.unavailable,
    };
  };

  const limitExceeded = (run: Run, state: FlowRunState): FlowOrchestratorResponse => ({
    kind: "finished",
    runId: state.runId,
    outcome: "failed",
    committedEffects: state.committedEffects,
    failure: { code: "server_time_limit" },
    outputs: {},
    intents: [],
    unavailable: run.unavailable,
  });

  type PlatformOperation =
    (typeof PLATFORM_SERVICE_OPERATIONS)[keyof typeof PLATFORM_SERVICE_OPERATIONS];

  /** What one protected task will run, decided before its effect is claimed. */
  type TaskPlan =
    | Readonly<{ kind: "operation"; entry: PlatformOperation; inputs: Record<string, unknown> }>
    | Readonly<{ kind: "save"; command: SaveRecordCommandV2 }>
    | Readonly<{ kind: "action"; command: ExecuteNamedActionCommandV2 }>;

  type TaskResult = { outcome: FlowTaskOutcome; outputs?: Record<string, JsonValue> };

  /** Records a task the platform cannot run here: it fails as not available, never as refused. */
  const notAvailable = (run: Run, call: FlowProtectedTaskCall, requires: string): TaskResult => {
    run.unavailable.push({
      taskId: call.taskId,
      taskType: call.taskType,
      code: "not_yet_available",
      requires,
    });
    return { outcome: "failed" };
  };

  /** A Call protected operation task's inputs: its own input map, or the flow's inputs by name. */
  const operationInputs = (call: FlowProtectedTaskCall): Record<string, unknown> | undefined => {
    const suppliedInputs = call.properties.inputs?.value;
    if (suppliedInputs !== undefined && !isRecord(suppliedInputs)) return undefined;
    return isRecord(suppliedInputs)
      ? suppliedInputs
      : Object.fromEntries(
          Object.entries(call.flowInputs).map(([name, value]) => [name, value.value]),
        );
  };

  /**
   * Decides what one protected task runs, from the task, the exact release and the segment's
   * subject only. Nothing runs here, so a task that cannot run is settled before any claim.
   */
  const planTask = (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
  ): Readonly<{ plan: TaskPlan }> | TaskResult => {
    const commandId = effectCommandId(state.runId, call.taskPath, call.iteration);

    if (call.taskType === "record.save") {
      if (dependencies.records === undefined)
        return notAvailable(run, call, "the interactive record task port");
      const recordTypeId = recordTypeIdSchema.safeParse(call.properties.record_type?.value);
      const recordType = recordTypeId.success
        ? run.release.recordTypes?.get(recordTypeId.data.toLowerCase())
        : undefined;
      if (!recordTypeId.success || recordType === undefined)
        return notAvailable(run, call, "a record type of this release");
      // The values are named by the release's field keys or field identities; any other name is
      // refused as invalid, never dropped.
      const values = call.properties.values?.value;
      if (!isRecord(values) || carriesSensitive(values, run.sensitive))
        return { outcome: "validation" };
      const submittedValues: Record<string, JsonValue> = {};
      for (const [name, value] of Object.entries(values)) {
        const fieldId = recordType.fieldIds.get(name.toLowerCase());
        if (fieldId === undefined || Object.hasOwn(submittedValues, fieldId))
          return { outcome: "validation" };
        submittedValues[fieldId] = value as JsonValue;
      }
      // A task that names a record changes it; one that names none creates a record.
      if (!Object.hasOwn(call.properties, "record")) {
        const selectedOwnerGroupId = call.properties.selected_owner_group_id?.value;
        const selectedGroup = selectedOwnerGroupId === undefined
          ? undefined
          : groupIdSchema.safeParse(selectedOwnerGroupId);
        if (selectedGroup !== undefined && !selectedGroup.success)
          return { outcome: "validation" };
        const command = saveRecordCommandV2Schema.safeParse({
          contractVersion: "2.0.0",
          commandId,
          operation: "create",
          recordTypeId: recordTypeId.data,
          submittedValues,
          ...(selectedGroup === undefined ? {} : { selectedOwnerGroupId: selectedGroup.data }),
        });
        return command.success
          ? { plan: { kind: "save", command: command.data } }
          : { outcome: "validation" };
      }
      const recordId = recordIdSchema.safeParse(call.properties.record?.value);
      if (Object.hasOwn(call.properties, "selected_owner_group_id"))
        return { outcome: "validation" };
      if (!recordId.success) return { outcome: "validation" };
      // A change is bound to the revision the person saw: the surface's subject. Without it the
      // change cannot be checked against what the person was shown, so it does not run.
      const subject = state.subject;
      if (subject === undefined || subject.recordId.toLowerCase() !== recordId.data.toLowerCase())
        return notAvailable(run, call, "the revision of the record the page shows");
      if (dependencies.subjects === undefined)
        return notAvailable(run, call, "a protected read of the page's record");
      const command = saveRecordCommandV2Schema.safeParse({
        contractVersion: "2.0.0",
        commandId,
        operation: "update",
        recordTypeId: recordTypeId.data,
        recordId: recordId.data,
        expectedConcurrencyNumber: subject.revision,
        submittedValues,
      });
      return command.success
        ? { plan: { kind: "save", command: command.data } }
        : { outcome: "validation" };
    }

    if (call.taskType !== "operation.call")
      return notAvailable(run, call, notYetAvailable[call.taskType] ?? "a server task runner");

    const operationKey = call.properties.operation?.value;
    const inputs = operationInputs(call);
    // A sensitive value is shown to the person once; it is never passed on to another effect.
    if (inputs === undefined || carriesSensitive(inputs, run.sensitive))
      return { outcome: "validation" };
    const entry = Object.values(PLATFORM_SERVICE_OPERATIONS).find(
      (candidate) => platformOperationKey(candidate.key) === operationKey,
    );
    if (entry !== undefined) return { plan: { kind: "operation", entry, inputs } };

    // Otherwise the key may name one named action of the exact release, run for the surface's
    // subject record through the same path as its binding (`executeAction`).
    const named =
      typeof operationKey === "string" ? run.release.namedActions?.get(operationKey) : undefined;
    if (named === undefined || dependencies.actionRecords === undefined)
      return notAvailable(run, call, "a registered protected operation");
    if (state.subject === undefined)
      return notAvailable(run, call, "the record the action runs on");
    if (dependencies.subjects === undefined)
      return notAvailable(run, call, "a protected read of the page's record");
    const command = executeNamedActionCommandV2Schema.safeParse({
      contractVersion: "2.0.0",
      commandId,
      action: named.action,
      recordTypeId: named.subjectRecordTypeId,
      recordId: state.subject.recordId,
      expectedConcurrencyNumber: state.subject.revision,
      inputs,
    });
    return command.success
      ? { plan: { kind: "action", command: command.data } }
      : { outcome: "validation" };
  };

  /** Runs a planned task's effect, holding the claim. Every failure is a safe outcome. */
  const runPlan = async (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
    plan: TaskPlan,
  ): Promise<{ result: TaskResult; stored: Record<string, JsonValue> }> => {
    // Non-person execution contexts stay fail-closed until exact per-task grants are implemented.
    if (run.authority.kind !== "person")
      return { result: { outcome: "failed" }, stored: {} };
    const { session, selection } = run.authority;
    // The page subject is retained as run evidence. A fresh read under this initiator's request
    // scope verifies the exact record type and identity before either protected change is attempted.
    // The record service still checks change or action permission inside its own transaction.
    const target =
      plan.kind === "action"
        ? { recordTypeId: plan.command.recordTypeId, recordId: plan.command.recordId }
        : plan.kind === "save" && plan.command.operation === "update"
          ? { recordTypeId: plan.command.recordTypeId, recordId: plan.command.recordId }
          : undefined;
    if (target !== undefined) {
      const subject = await dependencies.subjects!.read(session, selection, target);
      if (subject !== "read")
        return {
          result: { outcome: subject === "refused" ? "refused" : "failed" },
          stored: {},
        };
    }
    if (plan.kind === "save") {
      const saved = await dependencies.records!.save(session, selection, plan.command);
      if (saved.kind !== "available")
        return { result: { outcome: requestOutcome(saved.kind) }, stored: {} };
      const value = saved.value;
      if (value.outcome === "saved") {
        const outputs = { record: value.recordId };
        return { result: { outcome: "committed", outputs }, stored: outputs };
      }
      const outcome =
        value.outcome === "correction_required" ? "validation" : refusalOutcome(value.error.code);
      return { result: { outcome }, stored: {} };
    }

    if (plan.kind === "action") {
      const executed = await runNamedAction(session, selection, plan.command);
      if (executed.kind !== "available")
        return { result: { outcome: requestOutcome(executed.kind) }, stored: {} };
      const value = executed.value;
      if (value.outcome === "completed") {
        // Only the record's identity and revision are kept: its readable values stay with the port.
        const outputs = {
          result: { recordId: value.recordId, concurrencyNumber: value.concurrencyNumber },
        };
        return { result: { outcome: "committed", outputs }, stored: outputs };
      }
      return { result: { outcome: refusalOutcome(value.error.code) }, stored: {} };
    }

    const executed = await dependencies.executor.execute({
      operation: {
        serviceId: plan.entry.release.serviceId,
        operationId: plan.entry.release.operationId,
        releaseVersion: plan.entry.release.releaseVersion,
      },
      session,
      selection,
      inputs: plan.inputs,
      effectKey: { runId: state.runId, taskPath: call.taskPath, iteration: call.iteration },
    });
    const outcome: FlowTaskOutcome = executed.outcome;
    // Read results keep their outputs for later tasks but do not count as committed changes.
    const operationSucceeded =
      executed.outcome === "completed" || executed.outcome === "committed";
    const outputs: Record<string, JsonValue> = operationSucceeded
      ? { result: { ...executed.outputs } }
      : {};
    const sensitive = plan.entry.descriptor.sensitiveOutputs ?? [];
    if (operationSucceeded)
      run.sensitive.push(...sensitiveValues(executed.outputs, sensitive));
    const stored: Record<string, JsonValue> =
      operationSucceeded
        ? { result: redactSensitiveOutputs(executed.outputs, sensitive) }
        : {};
    return { result: { outcome, outputs }, stored };
  };

  /**
   * Runs one protected task of the interpreter. The effect ledger claims the duplicate key first,
   * the task's protected path runs only when this call holds the claim, and the safe outcome is
   * recorded so any repeat replays it.
   */
  const runProtectedTask = async (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
  ): Promise<TaskResult> => {
    const principal: FlowEffectPrincipal =
      run.authority.kind === "person"
        ? { kind: "person", id: run.authority.session.identityId }
        : run.authority.context.actor.kind === "specified_account"
          ? {
              kind: "specified_account",
              id: run.authority.context.actor.organizationAccountId,
            }
          : { kind: "system", id: run.authority.context.actor.systemActorId };
    const organizationId =
      run.authority.kind === "person"
        ? run.authority.selection.organizationId
        : run.authority.organizationId;
    if (run.authority.kind === "execution_authority")
      return notAvailable(run, call, "per-task Access grant resolution (#1562)");
    const planned = planTask(run, state, call);
    if (!("plan" in planned)) return planned;

    const key = {
      runId: state.runId,
      organizationId,
      principal,
      origin: run.origin,
      originId: run.originId,
      taskPath: call.taskPath,
      iteration: call.iteration,
    } as const;
    let claim: Awaited<ReturnType<FlowEffectLedger["begin"]>>;
    try {
      claim = await dependencies.ledger.begin(key);
    } catch {
      // Nothing was claimed, so nothing ran.
      return { outcome: "failed" };
    }
    if (claim.kind === "completed")
      return {
        outcome: claim.outcome as FlowTaskOutcome,
        outputs: isRecord(claim.outputs) ? (claim.outputs as Record<string, JsonValue>) : {},
      };
    if (claim.kind === "in_progress") return { outcome: "uncertain" };
    if (claim.kind !== "claimed") return { outcome: "refused" };

    let ran: Awaited<ReturnType<typeof runPlan>>;
    try {
      ran = await runPlan(run, state, call, planned.plan);
    } catch {
      // Whether the effect committed is unknown; the open claim reports any repeat as uncertain.
      return { outcome: "uncertain" };
    }
    try {
      await dependencies.ledger.complete(key, ran.result.outcome, ran.stored);
    } catch {
      // The effect ran. Leaving the claim open makes any repeat report it uncertain, never re-run it.
    }
    return ran.result;
  };

  /** Suspends at a form or confirmation: stores the run and returns the intent and continuation. */
  const suspend = async (
    run: Run,
    step: Extract<FlowRunStep, { kind: "interface" }>,
  ): Promise<FlowOrchestratorResponse> => {
    if (run.authority.kind !== "person") return refused;
    const { session, selection } = run.authority;
    const token = newToken();
    let stored: Awaited<ReturnType<FlowContinuationStore["issue"]>>;
    try {
      // A run holding a sensitive value (in a task output, variable or intent) is never stored, so
      // it ends here instead of waiting for the person.
      if (carriesSensitive(step.state, run.sensitive)) throw new Error("FLOW_RUN_HOLDS_SENSITIVE");
      stored = await dependencies.continuations.issue({
        tokenHash: sha256(token),
        runId: step.state.runId,
        organizationId: selection.organizationId,
        identityId: session.identityId,
        flowId: run.flowId,
        releaseKey: run.release.releaseKey,
        state: step.state,
        elapsedMilliseconds: Math.min(elapsedMilliseconds(run), 3_600_000),
        lifetimeSeconds: flowContinuationLifetimeSeconds,
      });
    } catch {
      stored = undefined;
    }
    // A run that cannot be stored cannot be resumed, so it ends without continuing.
    if (stored === undefined)
      return {
        kind: "finished",
        runId: step.state.runId,
        outcome: "failed",
        committedEffects: step.state.committedEffects,
        failure: { code: "continuation_unavailable" },
        outputs: {},
        intents: [],
        unavailable: run.unavailable,
      };
    return {
      kind: "suspended",
      runId: step.state.runId,
      awaiting: step.awaiting,
      nodeId: step.state.awaiting?.taskId ?? "",
      releaseKey: run.release.releaseKey,
      committedEffects: step.state.committedEffects,
      intents: step.intents.map(safeIntent),
      continuation: token,
      expiresAt: stored.expiresAt,
      unavailable: run.unavailable,
    };
  };

  /** Drives the run until it finishes or must wait for the person. */
  const drive = async (run: Run, first: FlowRunStep): Promise<FlowOrchestratorResponse> => {
    let step = first;
    for (;;) {
      if (step.kind === "finished") return finished(run, step);
      if (elapsedMilliseconds(run) > serverMilliseconds) return limitExceeded(run, step.state);
      if (step.kind === "interface")
        return run.authority.kind === "person" ? suspend(run, step) : refused;
      const result = await runProtectedTask(run, step.state, step.call);
      const resume: FlowRunResume = {
        kind: "task_result",
        outcome: result.outcome,
        ...(result.outputs === undefined ? {} : { outputs: result.outputs }),
      };
      step = resumeFlowRun(step.state, resume, run.library);
    }
  };

  const prepare = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    flowId: string,
    kind: "interactive" | "action" = "interactive",
  ): Promise<PreparedPersonRun | undefined> => {
    // An expired session is not a verified initiator, on a start or on any resume.
    if (!(Date.parse(session.accessTokenExpiresAt) > now().valueOf())) return undefined;
    const release = await dependencies.resolveRelease(selection.organizationId, flowId);
    if (release === undefined) return undefined;
    const validated = libraryOf(release);
    const permitted = async (flow: FlowDefinition): Promise<boolean> =>
      flow.invocationPermissionId === undefined ||
      (dependencies.authorizeInvocation !== undefined &&
        (await dependencies.authorizeInvocation(session, selection, flow)));

    const flow = validated(flowId);
    // A flow the platform runs for a person runs as that person, and only that. A named action's
    // flow is a transaction flow with no trigger that runs as the saver: the verified person whose
    // action it is.
    if (
      flow === undefined ||
      (kind === "interactive"
        ? flow.execution !== "interactive" || flow.runAs.kind !== "initiator"
        : flow.execution !== "transaction" ||
          flow.runAs.kind !== "saver" ||
          flow.triggers.length > 0)
    )
      return undefined;
    // A named action's invocation permission is its own action permission, which the record port
    // decides for the exact subject record inside its transaction, recording a refusal, just as it
    // decides an action with permission alternatives. Every other flow is checked here.
    if (kind === "interactive" && !(await permitted(flow))) return undefined;

    // Run flow never starts a flow the initiator may not invoke: every flow the run can reach is
    // checked now, and one that is refused is unavailable to the run, so its Run flow task fails.
    const available = new Set<string>([flowId]);
    const visited = new Set<string>([flowId]);
    const pending = runFlowTargets(flow);
    while (pending.length > 0) {
      const targetId = pending.shift()!;
      if (visited.has(targetId)) continue;
      visited.add(targetId);
      const target = validated(targetId);
      if (target === undefined || !(await permitted(target))) continue;
      available.add(targetId);
      pending.push(...runFlowTargets(target));
    }
    const library: FlowLibrary = (candidate) =>
      available.has(candidate) ? validated(candidate) : undefined;
    return { session, selection, flowId, release, library };
  };

  /**
   * The one path of a named action, from its binding or from a Call protected operation task:
   * resolves the exact release's action flow and hands the record port a run of that flow to call
   * inside its transaction, where the action's permission, subject and revision are decided.
   */
  const runNamedAction = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: ExecuteNamedActionCommandV2,
  ): Promise<NamedActionExecutionResult> => {
    if (dependencies.actionRecords === undefined) return { kind: "unavailable" };
    const flowId = command.action.actionId;
    const prepared = await prepare(session, selection, flowId, "action");
    if (prepared === undefined) return { kind: "unavailable" };
    const runId = newRunId();
    return dependencies.actionRecords.execute(session, selection, command, (seed) =>
      collectActionFlowTasks(prepared.library, flowId, runId, seed),
    );
  };

  return Object.freeze({
    /**
     * Runs one named action for the verified person: resolves the exact release's action flow and
     * hands the record port a run of that flow to call inside its transaction, where the action's
     * permission is decided. The port applies every record change the flow asks for in one apply
     * record changes call. Nothing about the actor or the organisation is read from the command.
     */
    async executeAction(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<NamedActionExecutionResult> {
      try {
        const parsed = z
          .object({ session: identitySessionSchema, selection: organizationSelectionCandidateSchema })
          .safeParse({ session, selection });
        const command = executeNamedActionCommandV2Schema.safeParse(commandCandidate);
        if (!parsed.success || !command.success) return { kind: "unavailable" };
        return await runNamedAction(parsed.data.session, parsed.data.selection, command.data);
      } catch {
        return { kind: "unavailable" };
      }
    },

    /**
     * Starts a run from a binding (flow id and typed inputs) for the verified initiator. The run id
     * is issued here. The inputs and the surface's subject are values only: authority,
     * organisation and actor never come from them.
     */
    async start(
      request: FlowStartRequest,
      expectation?: Pick<FlowRunExpectation, "releaseKey">,
    ): Promise<FlowOrchestratorResponse> {
      try {
        const parsed = startRequestSchema.safeParse(request);
        if (!parsed.success || !withinPayload(parsed.data.binding.inputs)) return refused;
        const { session, selection, binding, subject } = parsed.data;
        const prepared = await prepare(session, selection, binding.flowId);
        if (prepared === undefined) return refused;
        if (expectation !== undefined && expectation.releaseKey !== prepared.release.releaseKey)
          return refused;
        const actor = await dependencies.resolveActor?.(session, selection);
        const run: Run = {
          authority: { kind: "person", session, selection },
          origin: "person",
          originId: session.identityId,
          flowId: prepared.flowId,
          release: prepared.release,
          library: prepared.library,
          carriedMilliseconds: 0,
          segmentStart: clock(),
          unavailable: [],
          sensitive: [],
        };
        const first = startFlowRun(
          {
            runId: newRunId(),
            flowId: binding.flowId,
            inputs: binding.inputs,
            now: now().toISOString(),
            ...(actor === undefined ? {} : { actor }),
            ...(subject === undefined ? {} : { subject }),
          },
          run.library,
        );
        return await drive(run, first);
      } catch {
        return refused;
      }
    },

    /** Starts one verified background Event flow using only its committed start-intent ID. */
    async startCommittedIntent(intentIdCandidate: string): Promise<FlowOrchestratorResponse> {
      try {
        const intentId = z.uuid().safeParse(intentIdCandidate);
        if (
          !intentId.success ||
          dependencies.readCommittedStartIntent === undefined ||
          dependencies.resolveCommittedStartRelease === undefined
        )
          return refused;

        const storedIntent = await dependencies.readCommittedStartIntent(intentId.data);
        const parsedIntent = committedFlowStartIntentSchema.safeParse(storedIntent);
        if (
          !parsedIntent.success ||
          parsedIntent.data.intentId.toLowerCase() !== intentId.data.toLowerCase()
        )
          return refused;
        const intent = parsedIntent.data;
        // Trigger field values are not yet mapped by the Event dispatcher; never silently ignore them.
        if (
          Object.keys(intent.triggerValues).length > 0 ||
          !withinPayload(intent.inputs) ||
          !withinPayload(intent.triggerValues)
        )
          return refused;

        const resolvedRelease = await dependencies.resolveCommittedStartRelease(intent);
        if (resolvedRelease === undefined) return refused;
        const resolvedIdentity = flowReleaseIdentitySchema.safeParse(resolvedRelease.identity);
        if (
          !resolvedIdentity.success ||
          !flowReleaseIdentityMatches(releaseIdentityForIntent(intent), resolvedIdentity.data)
        )
          return refused;

        const library = libraryOf(resolvedRelease);
        const flow = library(intent.flowId);
        if (
          flow === undefined ||
          flow.execution !== "background" ||
          (flow.runAs.kind !== "specified_account" && flow.runAs.kind !== "system") ||
          !flow.triggers.some(
            (trigger) => trigger.type === "Event" && trigger.id === intent.trigger.id,
          )
        )
          return refused;

        const executionBindingId = flow.runAs.executionBindingId;
        // Access retains the flow identity under its RuleId brand; both contracts validate
        // the same non-nil UUID, so cross that boundary explicitly before the scoped read.
        const accessFlowId = ruleIdSchema.safeParse(intent.flowId);
        if (!accessFlowId.success) return refused;
        const principalRead = await withRuntimeTransaction((transaction) =>
          readFlowRunAsPrincipalForRun(transaction, {
            executionBindingId,
            organizationId: intent.organizationId,
            applicationRootId: intent.applicationRootId,
            releaseVersion: intent.applicationReleaseVersion,
            flowId: accessFlowId.data,
          }),
        );
        if (principalRead.outcome !== "available") return refused;
        const principal = principalRead.principal;
        if (
          principal.state !== "active" ||
          principal.actor.kind !== flow.runAs.kind ||
          principal.executionBindingId.toLowerCase() !== flow.runAs.executionBindingId.toLowerCase() ||
          principal.organizationId.toLowerCase() !== intent.organizationId.toLowerCase() ||
          principal.applicationRootId.toLowerCase() !== intent.applicationRootId.toLowerCase() ||
          principal.releaseVersion !== intent.applicationReleaseVersion ||
          principal.flowId.toLowerCase() !== intent.flowId.toLowerCase()
        )
          return refused;

        const issuedAt = now();
        const executionAuthority = executionAuthorityContextSchema.safeParse({
          kind: "execution_authority",
          organizationId: intent.organizationId,
          applicationRootId: intent.applicationRootId,
          releaseVersion: intent.applicationReleaseVersion,
          flowId: intent.flowId,
          executionBindingId: flow.runAs.executionBindingId,
          actor: principal.actor,
          correlationId: intent.correlationId,
          issuedAt: issuedAt.toISOString(),
          expiresAt: new Date(issuedAt.valueOf() + serverMilliseconds).toISOString(),
        });
        if (!executionAuthority.success) return refused;

        const run: Run = {
          authority: {
            kind: "execution_authority",
            context: executionAuthority.data,
            organizationId: intent.organizationId,
          },
          origin: intent.origin,
          originId: intent.originId,
          flowId: intent.flowId,
          release: resolvedRelease,
          library,
          carriedMilliseconds: 0,
          segmentStart: clock(),
          unavailable: [],
          sensitive: [],
        };
        const actor =
          principal.actor.kind === "specified_account"
            ? principal.actor.organizationAccountId
            : principal.actor.systemActorId;
        const first = startFlowRun(
          {
            runId: intent.intentId,
            flowId: intent.flowId,
            inputs: intent.inputs,
            now: issuedAt.toISOString(),
            actor,
            executionKinds: ["background"],
          },
          run.library,
        );
        return await drive(run, first);
      } catch {
        return refused;
      }
    },

    /**
     * Resumes a suspended run from its continuation and the person's answer. The continuation is
     * consumed exactly once, and only for the initiator, organisation and flow release it was
     * issued for; a replay of it is refused, so no protected effect is repeated.
     */
    async resume(
      request: FlowResumeRequest,
      expectation?: FlowRunExpectation,
    ): Promise<FlowOrchestratorResponse> {
      try {
        const parsed = resumeRequestSchema.safeParse(request);
        if (!parsed.success || !withinPayload(parsed.data.answer)) return refused;
        const { session, selection, flowId, continuation, answer } = parsed.data;
        const prepared = await prepare(session, selection, flowId);
        if (prepared === undefined) return refused;
        // A different release is refused before the continuation is spent.
        if (expectation !== undefined && expectation.releaseKey !== prepared.release.releaseKey)
          return refused;
        const stored = await dependencies.continuations.consume({
          tokenHash: sha256(continuation),
          organizationId: selection.organizationId,
          identityId: session.identityId,
          flowId,
          releaseKey: prepared.release.releaseKey,
        });
        if (stored === undefined) return refused;
        const state = stored.state as FlowRunState;
        // The stored run must be the run the row is bound to; anything else is never resumed.
        if (!isRecord(state) || state.runId !== stored.runId) return refused;
        if (!subjectSchema.optional().safeParse(state.subject).success) return refused;
        if (expectation !== undefined) {
          const paused = state.awaiting;
          if (
            expectation.pausedAt !== undefined &&
            (paused === undefined ||
              paused.kind !== expectation.pausedAt.awaiting ||
              paused.taskId !== expectation.pausedAt.nodeId)
          )
            return refused;
          if (
            expectation.receipt !== undefined &&
            (expectation.receipt.runId !== state.runId ||
              expectation.receipt.committedEffects !== state.committedEffects)
          )
            return refused;
        }
        const run: Run = {
          authority: { kind: "person", session, selection },
          origin: "person",
          originId: session.identityId,
          flowId: prepared.flowId,
          release: prepared.release,
          library: prepared.library,
          carriedMilliseconds: stored.elapsedMilliseconds,
          segmentStart: clock(),
          unavailable: [],
          sensitive: [],
        };
        return await drive(run, resumeFlowRun(state, answer, run.library));
      } catch {
        return refused;
      }
    },
  });
};

export type FlowOrchestrator = ReturnType<typeof createFlowOrchestrator>;
