import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import { isRecord } from "../catalogue/runtime-primitives";
import type { ExecuteNamedActionCommand } from "../records/named-actions";
import type { FlowDefinition } from "../workflows/flow-contracts";
import { flowWarningNoticeSchema } from "../workflows/form-continuation-contracts";
import { collectActionFlowTasks } from "../rules/action-flow-run";
import {
  resumeFlowRun,
  startFlowRun,
  type FlowLibrary,
  type FlowRunResume,
  type FlowRunState,
  type FlowRunStep,
} from "../rules/flow-interpreter";
import { consumeFlowContinuation, issueFlowContinuation } from "./flow-continuation-store";
import { reportUnexpectedFailure } from "./definition-error";
import {
  carriesSensitive,
  runFlowTargets,
  safeIntent,
  sha256,
  withinPayload,
} from "./flow-orchestrator-support";
import {
  resumeRequestSchema,
  startRequestSchema,
  subjectSchema,
  type FlowOrchestratorDependencies,
  type FlowOrchestratorResponse,
  type FlowRelease,
  type FlowResumeRequest,
  type FlowRunExpectation,
  type FlowStartRequest,
  type NamedActionExecutionResult,
  type PreparedPersonRun,
  type Run,
} from "./flow-orchestrator-types";
import { createFlowTaskRunner } from "./flow-task-runner";
import { flowMaximumServerSeconds } from "../workflows/flow-limits";

/** Orchestrates flows with verified authority, revision-bound writes and single-use continuations. */

/** The seconds a suspended run may wait for the person's answer. */
const flowContinuationLifetimeSeconds = 900;
const serverMilliseconds = flowMaximumServerSeconds * 1_000;

const refused: FlowOrchestratorResponse = Object.freeze({ kind: "refused" });

export const createFlowOrchestrator = (dependencies: FlowOrchestratorDependencies) => {
  const now = dependencies.now ?? (() => new Date());
  const clock = dependencies.clock ?? (() => performance.now());
  const newRunId = dependencies.newRunId ?? (() => randomUUID());
  const newToken = dependencies.newToken ?? (() => randomBytes(32).toString("base64url"));

  /** The library of one release: its planned flows; a flow that is not planned is unavailable. */
  const libraryOf =
    (release: FlowRelease): FlowLibrary =>
    (flowId) =>
      release.flows.get(flowId);

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
        failedTaskId !== undefined &&
        run.unavailable.some((notice) => notice.taskId === failedTaskId);
      if (failedTaskId === undefined || !run.refusalLoggedTaskIds.includes(failedTaskId))
        console.error(
          `[flows] run ${step.state.runId} of flow ${run.flowId} ended ${step.result.failure.outcome} (${step.result.failure.code}) at task ${failedTaskId ?? "(none)"}${step.result.failure.reason === undefined ? "" : `: ${step.result.failure.reason}`}`,
        );
      return {
        kind: "finished",
        warnings: run.warnings,
        runId: step.state.runId,
        outcome: step.result.failure.outcome,
        committedEffects: step.state.committedEffects,
        failure: {
          code: notAvailable ? "task_not_available" : step.result.failure.code,
          ...(failedTaskId === undefined ? {} : { taskId: failedTaskId }),
          ...(!notAvailable && step.result.failure.diagnostic !== undefined
            ? { diagnostic: step.result.failure.diagnostic }
            : {}),
        },
        outputs: {},
        intents,
        unavailable: run.unavailable,
      };
    }
    return {
      kind: "finished",
      warnings: run.warnings,
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
    warnings: run.warnings,
    runId: state.runId,
    outcome: "failed",
    committedEffects: state.committedEffects,
    failure: { code: "server_time_limit" },
    outputs: {},
    intents: [],
    unavailable: run.unavailable,
  });

  /**
   * The record a flow with a record input runs for, read afresh for the verified initiator: at the
   * start from the input the binding supplied, and at every resume from the run's own input, so a
   * stored run never holds record values. `undefined` when the flow names no record input.
   */
  const readRunRecord = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    flow: FlowDefinition | undefined,
    recordId: unknown,
  ): Promise<FlowRunState["triggerRecord"] | "unavailable"> => {
    if (flow?.recordInput === undefined) return undefined;
    const recordTypeId = flow.inputs[flow.recordInput]?.recordTypeIds?.[0];
    if (recordTypeId === undefined || typeof recordId !== "string" || recordId.length === 0) {
      console.error(
        `[flows] flow ${flow.id} was started without the record its input ${flow.recordInput} names`,
      );
      return "unavailable";
    }
    if (dependencies.currentRecords === undefined) {
      console.error(`[flows] flow ${flow.id} reads its record, but this host reads no records`);
      return "unavailable";
    }
    const read = await dependencies.currentRecords.read(session, selection, {
      recordTypeId,
      recordId,
    });
    if (read.outcome === "read") return read.values;
    console.error(`[flows] the record of flow ${flow.id} is not available to the initiator`);
    return "unavailable";
  };

  /** Suspends at a form or confirmation: stores the run and returns the intent and continuation. */
  const suspend = async (
    run: Run,
    step: Extract<FlowRunStep, { kind: "interface" }>,
  ): Promise<FlowOrchestratorResponse> => {
    if (run.authority.kind !== "person") return refused;
    // A selected-record result is safe to use in this segment, but the interpreter snapshot now
    // contains readable data. Refuse before issuing a continuation or saving that state.
    if (run.selectedRecordReadSeen)
      return {
        kind: "finished",
        warnings: run.warnings,
        runId: step.state.runId,
        outcome: "failed",
        committedEffects: step.state.committedEffects,
        failure: { code: "continuation_unavailable" },
        outputs: {},
        intents: [],
        unavailable: run.unavailable,
      };
    const { session, selection } = run.authority;
    // The record the run reads is read again when it resumes, so its values are never stored.
    const state: FlowRunState = { ...step.state };
    delete (state as { triggerRecord?: unknown }).triggerRecord;
    const token = newToken();
    let stored: Awaited<ReturnType<typeof issueFlowContinuation>> | undefined;
    try {
      // A run holding a sensitive value (in a task output, variable or intent) is never stored, so
      // it ends here instead of waiting for the person.
      if (!carriesSensitive(state, run.sensitive))
        stored = await issueFlowContinuation({
          tokenHash: sha256(token),
          runId: step.state.runId,
          organizationId: selection.organizationId,
          identityId: session.identityId,
          flowId: run.flowId,
          releaseKey: run.release.releaseKey,
          state: {
            state,
            warnings: run.warnings,
            bindingId: run.bindingId,
            gestureId: run.gestureId,
          },
          elapsedMilliseconds: Math.min(elapsedMilliseconds(run), 3_600_000),
          lifetimeSeconds: flowContinuationLifetimeSeconds,
        });
    } catch (error) {
      reportUnexpectedFailure("flow continuation storage", error);
    }
    // A run that cannot be stored cannot be resumed, so it ends without continuing.
    if (stored === undefined)
      return {
        kind: "finished",
        warnings: run.warnings,
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
      if (step.kind === "boundary") return refused;
      // The limit stops a run before more server work. A run that already committed a change and
      // now waits for the person still shows them what it did; any later task is refused.
      const answersCommitted = step.kind === "interface" && step.state.committedEffects > 0;
      if (!answersCommitted && elapsedMilliseconds(run) > serverMilliseconds)
        return limitExceeded(run, step.state);
      if (step.kind === "interface")
        return run.authority.kind === "person" ? suspend(run, step) : refused;
      const result = await runProtectedTask(run, step.state, step.call);
      const resume: FlowRunResume = {
        kind: "task_result",
        outcome: result.outcome,
        ...(result.outputs === undefined ? {} : { outputs: result.outputs }),
        ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
      };
      step = resumeFlowRun(step.state, resume, run.library);
    }
  };

  const prepare = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    flowId: string,
    kind: "interactive" | "action" = "interactive",
    ports: FlowOrchestratorDependencies = dependencies,
  ): Promise<PreparedPersonRun | undefined> => {
    // An expired session is not a verified initiator, on a start or on any resume.
    if (!(Date.parse(session.accessTokenExpiresAt) > now().valueOf())) return undefined;
    const release = await ports.resolveRelease(selection.organizationId, flowId);
    if (release === undefined) return undefined;
    const validated = libraryOf(release);
    const permitted = async (flow: FlowDefinition): Promise<boolean> =>
      flow.invocationPermissionId === undefined ||
      (ports.authorizeInvocation !== undefined &&
        (await ports.authorizeInvocation(session, selection, flow)));

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
    command: ExecuteNamedActionCommand,
    ports: FlowOrchestratorDependencies = dependencies,
  ): Promise<NamedActionExecutionResult> => {
    if (ports.actionRecords === undefined) return { kind: "unavailable" };
    const flowId = command.action.actionId;
    const prepared = await prepare(session, selection, flowId, "action", ports);
    if (prepared === undefined) return { kind: "unavailable" };
    const runId = newRunId();
    return ports.actionRecords.execute(session, selection, command, (seed) =>
      collectActionFlowTasks(prepared.library, flowId, runId, seed),
    );
  };

  const { run: runProtectedTask } = createFlowTaskRunner(dependencies, runNamedAction);

  return Object.freeze({
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
        const { session, selection, binding, subject, bindingId, gestureId } = parsed.data;
        const prepared = await prepare(session, selection, binding.flowId);
        if (prepared === undefined) return refused;
        if (expectation !== undefined && expectation.releaseKey !== prepared.release.releaseKey)
          return refused;
        const actor = await dependencies.resolveActor?.(session, selection);
        const flow = prepared.library(prepared.flowId);
        const triggerRecord = await readRunRecord(
          session,
          selection,
          flow,
          flow?.recordInput === undefined ? undefined : binding.inputs[flow.recordInput],
        );
        if (triggerRecord === "unavailable") return refused;
        const run: Run = {
          authority: { kind: "person", session, selection },
          origin: "person",
          originId: session.identityId,
          flowId: prepared.flowId,
          bindingId,
          gestureId,
          release: prepared.release,
          library: prepared.library,
          carriedMilliseconds: 0,
          segmentStart: clock(),
          unavailable: [],
          warnings: [],
          refusalLoggedTaskIds: [],
          sensitive: [],
          selectedRecordReadSeen: false,
        };
        const first = startFlowRun(
          {
            runId: newRunId(),
            flowId: binding.flowId,
            inputs: binding.inputs,
            now: now().toISOString(),
            ...(actor === undefined ? {} : { actor }),
            ...(subject === undefined ? {} : { subject }),
            ...(triggerRecord === undefined ? {} : { triggerRecord }),
          },
          run.library,
        );
        return await drive(run, first);
      } catch (error) {
        reportUnexpectedFailure("flow start", error);
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
        const stored = await consumeFlowContinuation({
          tokenHash: sha256(continuation),
          organizationId: selection.organizationId,
          identityId: session.identityId,
          flowId,
          releaseKey: prepared.release.releaseKey,
        });
        if (stored === undefined) return refused;
        const snapshot = z
          .object({
            state: z.unknown(),
            warnings: z.array(flowWarningNoticeSchema),
            bindingId: z.uuid(),
            gestureId: z.uuid(),
          })
          .strict()
          .parse(stored.state);
        const state = snapshot.state as FlowRunState;
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
        const root = state.activations[0];
        const rootFlow = root === undefined ? undefined : prepared.library(root.flowId);
        const triggerRecord = await readRunRecord(
          session,
          selection,
          rootFlow,
          rootFlow?.recordInput === undefined
            ? undefined
            : root?.inputs[rootFlow.recordInput]?.value,
        );
        if (triggerRecord === "unavailable") return refused;
        const run: Run = {
          authority: { kind: "person", session, selection },
          origin: "person",
          originId: session.identityId,
          flowId: prepared.flowId,
          bindingId: snapshot.bindingId,
          gestureId: snapshot.gestureId,
          release: prepared.release,
          library: prepared.library,
          carriedMilliseconds: stored.elapsedMilliseconds,
          segmentStart: clock(),
          unavailable: [],
          warnings: snapshot.warnings,
          refusalLoggedTaskIds: [],
          sensitive: [],
          selectedRecordReadSeen: false,
        };
        return await drive(
          run,
          resumeFlowRun(
            triggerRecord === undefined ? state : { ...state, triggerRecord },
            answer,
            run.library,
          ),
        );
      } catch (error) {
        reportUnexpectedFailure("flow resume", error);
        return refused;
      }
    },
  });
};

export type FlowOrchestrator = ReturnType<typeof createFlowOrchestrator>;
