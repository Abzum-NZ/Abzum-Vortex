import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  PLATFORM_SERVICE_OPERATIONS,
  flowIdSchema,
  flowMaximumServerSeconds,
  flowSchema,
  flowTaskChildLists,
  identitySessionSchema,
  organizationSelectionCandidateSchema,
  platformOperationKey,
  type FlowDefinition,
  type FlowTask,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import {
  resumeFlowRun,
  startFlowRun,
  type FlowFailureCode,
  type FlowFailureOutcome,
  type FlowInterfaceIntent,
  type FlowLibrary,
  type FlowProtectedTaskCall,
  type FlowRunResume,
  type FlowRunState,
  type FlowRunStep,
  type FlowTaskOutcome,
} from "@vortex/rule";
import { z } from "zod";
import type { FlowContinuationStore, FlowEffectLedger } from "./flow-continuation-store";
import type { ProtectedOperationExecutor } from "./protected-operation-executor";

/**
 * The server orchestrator of the in-house flow engine (architecture decision 1, "Who drives a
 * flow"). Any flow that contains a protected task is driven from its first task here, for the
 * person who started it. The pure interpreter (`@vortex/rule`) decides what each task does; this
 * module supplies everything the interpreter must not have: the trusted session, the run id, the
 * clock, the continuation store and the protected-operation executor.
 *
 * What it guarantees:
 * - The actor is always the initiator's verified session and the organisation that person
 *   selected. Neither is ever read from the inputs, a continuation body or the page, and a flow
 *   that does not run as its initiator is refused.
 * - Every protected task runs through the one executor (`protected-operation-executor.ts`), in its
 *   own short transaction, and only after the effect ledger claims (run id, task path, iteration).
 *   A replayed continuation, a redelivered run or a retried resume therefore replays the recorded
 *   safe outcome, or reports the effect uncertain, and never repeats it.
 * - A continuation is a random token whose hash keys one server-stored row bound to the run, the
 *   initiator, the organisation and the exact flow release. It expires, is handed back once, and a
 *   token that is unknown, expired, used, foreign or for another release is one neutral result.
 * - The run limits are enforced here and in the interpreter: 100 For each items, 25 protected
 *   operations, 10 seconds of server time (across every resume) and a Run flow depth of 3.
 * - A task the platform cannot run yet is refused with a located `not_yet_available` notice. It is
 *   never run inline and never guessed.
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
}>;

export type FlowOrchestratorDependencies = Readonly<{
  executor: Pick<ProtectedOperationExecutor, "execute">;
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
  })
  .strict();

const resumeRequestSchema = z
  .object({
    session: identitySessionSchema,
    selection: organizationSelectionCandidateSchema,
    flowId: flowIdSchema,
    continuation: z.string().min(16).max(128),
    answer: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("form_answered"), submitted: z.boolean(), values: z.unknown() }),
      z.object({ kind: z.literal("confirmed"), confirmed: z.boolean() }),
    ]),
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

/** Tasks the platform cannot run on the server yet, and what each waits for. */
const notYetAvailable: Readonly<Record<string, string>> = Object.freeze({
  "record.save": "#1061 apply record changes",
  "record.create": "#1061 apply record changes",
  "record.set_fields": "#1061 apply record changes",
  "record.link": "#1061 apply record changes",
  "record.delete": "#1061 apply record changes",
  "record.restore": "#1061 apply record changes",
  "record.changes": "#1061 apply record changes",
  "record.query": "#1061 apply record changes",
  "flow.run_background": "#666 committed start intents",
  "event.announce": "the server event writer task",
  "message.acknowledge": "the message trigger (#1133)",
  "file.export": "the server file export task",
  "connection.call": "the durable Kestra runner",
});

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

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

  type Run = Readonly<{
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    flowId: string;
    release: FlowRelease;
    library: FlowLibrary;
    /** Server milliseconds already spent by earlier segments of this run. */
    carriedMilliseconds: number;
    segmentStart: number;
    unavailable: FlowUnavailableNotice[];
  }>;

  const elapsedMilliseconds = (run: Run): number =>
    Math.max(0, Math.round(run.carriedMilliseconds + (clock() - run.segmentStart)));

  const finished = (
    run: Run,
    step: Extract<FlowRunStep, { kind: "finished" }>,
  ): FlowOrchestratorResponse => {
    const intents = step.intents.map(safeIntent);
    if (step.result.status === "failed")
      return {
        kind: "finished",
        runId: step.state.runId,
        outcome: step.result.failure.outcome,
        committedEffects: step.state.committedEffects,
        failure: {
          code: step.result.failure.code,
          ...(step.result.failure.taskId === undefined ? {} : { taskId: step.result.failure.taskId }),
        },
        outputs: {},
        intents,
        unavailable: run.unavailable,
      };
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

  /**
   * Runs one protected task of the interpreter. The effect ledger claims the duplicate key first,
   * the executor runs only when this call holds the claim, and the safe outcome is recorded so any
   * repeat replays it.
   */
  const runProtectedTask = async (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
  ): Promise<{ outcome: FlowTaskOutcome; outputs?: Record<string, JsonValue> }> => {
    if (call.taskType !== "operation.call") {
      run.unavailable.push({
        taskId: call.taskId,
        taskType: call.taskType,
        code: "not_yet_available",
        requires: notYetAvailable[call.taskType] ?? "a server task runner",
      });
      return { outcome: "refused" };
    }

    const operationKey = call.properties.operation?.value;
    const entry = Object.values(PLATFORM_SERVICE_OPERATIONS).find(
      (candidate) => platformOperationKey(candidate.key) === operationKey,
    );
    if (entry === undefined) {
      // A named action of a module has no executor path yet; nothing else is registered.
      run.unavailable.push({
        taskId: call.taskId,
        taskType: call.taskType,
        code: "not_yet_available",
        requires: "the named-action executor",
      });
      return { outcome: "refused" };
    }
    const suppliedInputs = call.properties.inputs?.value;
    if (suppliedInputs !== undefined && !isRecord(suppliedInputs)) return { outcome: "validation" };
    const inputs: Record<string, unknown> = isRecord(suppliedInputs)
      ? suppliedInputs
      : Object.fromEntries(
          Object.entries(call.flowInputs).map(([name, value]) => [name, value.value]),
        );

    const key = {
      runId: state.runId,
      organizationId: run.selection.organizationId,
      identityId: run.session.identityId,
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

    const executed = await dependencies.executor.execute({
      operation: {
        serviceId: entry.release.serviceId,
        operationId: entry.release.operationId,
        releaseVersion: entry.release.releaseVersion,
      },
      session: run.session,
      selection: run.selection,
      inputs,
    });
    const outcome: FlowTaskOutcome = executed.outcome;
    const outputs: Record<string, JsonValue> =
      executed.outcome === "committed" ? { result: { ...executed.outputs } } : {};
    try {
      await dependencies.ledger.complete(key, outcome, outputs);
    } catch {
      // The effect ran. Leaving the claim open makes any repeat report it uncertain, never re-run it.
    }
    return { outcome, outputs };
  };

  /** Suspends at a form or confirmation: stores the run and returns the intent and continuation. */
  const suspend = async (
    run: Run,
    step: Extract<FlowRunStep, { kind: "interface" }>,
  ): Promise<FlowOrchestratorResponse> => {
    const token = newToken();
    let stored: Awaited<ReturnType<FlowContinuationStore["issue"]>>;
    try {
      stored = await dependencies.continuations.issue({
        tokenHash: sha256(token),
        runId: step.state.runId,
        organizationId: run.selection.organizationId,
        identityId: run.session.identityId,
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
      if (step.kind === "interface") return suspend(run, step);
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
  ): Promise<Omit<Run, "carriedMilliseconds" | "segmentStart" | "unavailable"> | undefined> => {
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
    // A flow the platform runs for a person runs as that person, and only that.
    if (flow === undefined || flow.execution !== "interactive" || flow.runAs.kind !== "initiator")
      return undefined;
    if (!(await permitted(flow))) return undefined;

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

  return Object.freeze({
    /**
     * Starts a run from a binding (flow id and typed inputs) for the verified initiator. The run id
     * is issued here. The inputs are values only: authority, organisation and actor never come
     * from them.
     */
    async start(
      request: FlowStartRequest,
      expectation?: Pick<FlowRunExpectation, "releaseKey">,
    ): Promise<FlowOrchestratorResponse> {
      try {
        const parsed = startRequestSchema.safeParse(request);
        if (!parsed.success || !withinPayload(parsed.data.binding.inputs)) return refused;
        const { session, selection, binding } = parsed.data;
        const prepared = await prepare(session, selection, binding.flowId);
        if (prepared === undefined) return refused;
        if (expectation !== undefined && expectation.releaseKey !== prepared.release.releaseKey)
          return refused;
        const actor = await dependencies.resolveActor?.(session, selection);
        const run: Run = {
          ...prepared,
          carriedMilliseconds: 0,
          segmentStart: clock(),
          unavailable: [],
        };
        const first = startFlowRun(
          {
            runId: newRunId(),
            flowId: binding.flowId,
            inputs: binding.inputs,
            now: now().toISOString(),
            ...(actor === undefined ? {} : { actor }),
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
          ...prepared,
          carriedMilliseconds: stored.elapsedMilliseconds,
          segmentStart: clock(),
          unavailable: [],
        };
        const resume: FlowRunResume =
          answer.kind === "confirmed"
            ? { kind: "confirmed", confirmed: answer.confirmed }
            : {
                kind: "form_answered",
                submitted: answer.submitted,
                values: (answer.values ?? null) as JsonValue,
              };
        return await drive(run, resumeFlowRun(state, resume, run.library));
      } catch {
        return refused;
      }
    },
  });
};

export type FlowOrchestrator = ReturnType<typeof createFlowOrchestrator>;
