import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  executeNamedActionCommandSchema,
  executionAuthorityContextSchema,
  flowMaximumServerSeconds,
  identitySessionSchema,
  isRecord,
  organizationSelectionCandidateSchema,
  ruleIdSchema,
  type ExecuteNamedActionCommand,
  type FlowDefinition,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "../schema";
import { readFlowRunAsPrincipalForRun } from "../access/index";
import { withRuntimeTransaction } from "../db/index";
import {
  collectActionFlowTasks,
  flowLibraryOf,
  resumeFlowRun,
  startFlowRun,
  type FlowLibrary,
  type FlowRunResume,
  type FlowRunState,
  type FlowRunStep,
} from "../rules/index";
import type { FlowContinuationStore } from "./flow-continuation-store";
import { reportUnexpectedFailure } from "./definition-error";
import {
  carriesSensitive,
  runFlowTargets,
  safeIntent,
  sha256,
  withinPayload,
} from "./flow-orchestrator-support";
import {
  committedFlowStartIntentSchema,
  flowReleaseIdentityMatches,
  flowReleaseIdentitySchema,
  releaseIdentityForIntent,
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

  /** The library of validated flows of one release; an invalid flow is unavailable, never trusted. */
  const libraryOf = (release: FlowRelease): FlowLibrary => flowLibraryOf(release.flows);

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
      if (failedTaskId === undefined || !run.refusalLoggedTaskIds.includes(failedTaskId))
        console.error(
          `[flows] run ${step.state.runId} of flow ${run.flowId} ended ${step.result.failure.outcome} (${step.result.failure.code}) at task ${failedTaskId ?? "(none)"}${step.result.failure.reason === undefined ? "" : `: ${step.result.failure.reason}`}`,
        );
      return {
        kind: "finished",
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
      console.error(`[flows] flow ${flow.id} was started without the record its input ${flow.recordInput} names`);
      return "unavailable";
    }
    if (dependencies.currentRecords === undefined) {
      console.error(`[flows] flow ${flow.id} reads its record, but this host reads no records`);
      return "unavailable";
    }
    const read = await dependencies.currentRecords.read(session, selection, { recordTypeId, recordId });
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
    let stored: Awaited<ReturnType<FlowContinuationStore["issue"]>> | undefined;
    try {
      // A run holding a sensitive value (in a task output, variable or intent) is never stored, so
      // it ends here instead of waiting for the person.
      if (!carriesSensitive(state, run.sensitive))
        stored = await dependencies.continuations.issue({
          tokenHash: sha256(token),
          runId: step.state.runId,
          organizationId: selection.organizationId,
          identityId: session.identityId,
          flowId: run.flowId,
          releaseKey: run.release.releaseKey,
          state,
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
    command: ExecuteNamedActionCommand,
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

  const runProtectedTask = createFlowTaskRunner(dependencies, runNamedAction);

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
        const command = executeNamedActionCommandSchema.safeParse(commandCandidate);
        if (!parsed.success || !command.success) return { kind: "unavailable" };
        return await runNamedAction(parsed.data.session, parsed.data.selection, command.data);
      } catch (error) {
        reportUnexpectedFailure("named action execution", error);
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
          release: prepared.release,
          library: prepared.library,
          carriedMilliseconds: 0,
          segmentStart: clock(),
          unavailable: [],
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
          refusalLoggedTaskIds: [],
          sensitive: [],
          selectedRecordReadSeen: false,
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
      } catch (error) {
        reportUnexpectedFailure("committed intent start", error);
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
        const root = state.activations[0];
        const rootFlow = root === undefined ? undefined : prepared.library(root.flowId);
        const triggerRecord = await readRunRecord(
          session,
          selection,
          rootFlow,
          rootFlow?.recordInput === undefined ? undefined : root?.inputs[rootFlow.recordInput]?.value,
        );
        if (triggerRecord === "unavailable") return refused;
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