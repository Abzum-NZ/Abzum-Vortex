import "server-only";

import { randomUUID } from "node:crypto";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import type { ExecuteNamedActionCommand } from "../records/named-actions";
import type { NamedActionBatchResult } from "../records/action-record-port";
import type { FlowBindingInput, FlowDefinition } from "../workflows/flow-contracts";
import { resolveFlowValue } from "../rules/flow-value-runtime";
import { parseFlowSegmentSeed } from "../rules/flow-segment-seed";
import type { FlowRuntimeValues } from "../rules/flow-interpreter";
import { namedActionFlowRunner } from "./flow-action-run";
import {
  continueFlowRun,
  resumeFlowRun,
  startFlowRun,
  startFlowSegment,
  type FlowLibrary,
  type FlowRunState,
  type FlowRunStep,
} from "../rules/flow-interpreter";
import { runFlowSegment, runFlowSegmentFromBoundary } from "./flow-segment-run";
import { createFlowTaskRunner } from "./flow-task-runner";
import { reportUnexpectedFailure } from "./definition-error";
import {
  runFlowTargets,
  withinPayload,
} from "./flow-orchestrator-support";
import {
  startRequestSchema,
  type FlowOrchestratorDependencies,
  type FlowOrchestratorResponse,
  type FlowRelease,
  type FlowStartRequest,
  type NamedActionExecutionResult,
  type NamedActionRunner,
  type PreparedPersonRun,
  type Run,
} from "./flow-orchestrator-types";
import { flowMaximumServerSeconds } from "../workflows/flow-limits";
import { flowEntrySegmentsMatch } from "../workflows/flow-plan";

/** Orchestrates flows with verified authority and revision-bound writes. */

const serverMilliseconds = flowMaximumServerSeconds * 1_000;

const refused: FlowOrchestratorResponse = Object.freeze({ kind: "refused", committedNow: false });

export const createFlowOrchestrator = (dependencies: FlowOrchestratorDependencies) => {
  const now = dependencies.now ?? (() => new Date());
  const clock = dependencies.clock ?? (() => performance.now());
  const newRunId = dependencies.newRunId ?? (() => randomUUID());

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
        committedNow: false,
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
        unavailable: run.unavailable,
      };
    }
    return {
      kind: "finished",
      committedNow: false,
      warnings: run.warnings,
      runId: step.state.runId,
      outcome: step.state.committedEffects > 0 ? "committed" : "completed",
      committedEffects: step.state.committedEffects,
      ...(step.result.stopped === undefined ? {} : { stopped: step.result.stopped }),
      outputs: Object.fromEntries(
        Object.entries(step.result.outputs).map(([name, value]) => [name, value.value]),
      ),
      unavailable: run.unavailable,
    };
  };

  const limitExceeded = (run: Run, state: FlowRunState): FlowOrchestratorResponse => ({
    kind: "finished",
    committedNow: false,
    warnings: run.warnings,
    runId: state.runId,
    outcome: "failed",
    committedEffects: state.committedEffects,
    failure: { code: "server_time_limit" },
    outputs: {},
    unavailable: run.unavailable,
  });

  /**
   * The record a flow with a record input runs for, read afresh for the verified initiator from the
   * input the binding supplied. `undefined` when the flow names no record input.
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

  /** Server tasks stop at compiled boundaries and enter the one transactional gate. */
  const boundariesOf = (run: Run): ReadonlySet<string> => {
    const plan = run.release.plans.get(run.flowId);
    const server = new Set(
      plan?.segments.filter((part) => part.kind === "server").map((part) => part.id),
    );
    return new Set(
      [...(plan?.taskSegmentIds ?? [])].filter(([, id]) => server.has(id)).map(([id]) => id),
    );
  };

  const drive = async (run: Run, first: FlowRunStep): Promise<FlowOrchestratorResponse> => {
    let step = first;
    let committedNow = false;
    let replayedCommitted = false;
    const withCommit = (response: FlowOrchestratorResponse): FlowOrchestratorResponse => ({
      ...response,
      committedNow: committedNow || response.committedNow,
      ...(replayedCommitted || response.replayedCommitted === true
        ? { replayedCommitted: true as const }
        : {}),
    });
    const boundaries = boundariesOf(run);
    for (;;) {
      if (step.kind === "finished") return withCommit(finished(run, step));
      // A whole-flow run (Studio's test run) stops at a page step: the trace shows it waiting.
      if (step.kind === "interface") return withCommit(refused);
      if (elapsedMilliseconds(run) > serverMilliseconds)
        return withCommit(limitExceeded(run, step.state));
      // The segment that ended before a Run on back end task has committed: the task runs now, in
      // its own claim, so its child never sees or blocks on the caller's uncommitted changes.
      if (step.kind === "protected_task" && step.call.taskType === "backend.run") {
        const result = await createFlowTaskRunner(dependencies, namedRunner()).run(
          run,
          step.state,
          step.call,
        );
        step = resumeFlowRun(
          step.state,
          { kind: "task_result", ...result },
          run.library,
          dependencies.trace?.observer,
          undefined,
          undefined,
          boundaries,
        );
        continue;
      }
      if (step.kind !== "boundary" || step.nextTaskId === undefined) return withCommit(refused);
      const plan = run.release.plans.get(run.flowId);
      const segmentId = plan?.taskSegmentIds.get(step.nextTaskId);
      const segment = plan?.segments.find(
        (part) => part.kind === "server" && part.id === segmentId,
      );
      if (segment === undefined || segment.kind !== "server") return withCommit(refused);
      const boundary = step.state;
      const admitted = await dependencies.admitSegment(run, boundary, segment, (ports, replay) =>
        runFlowSegmentFromBoundary(ports, namedRunner(ports), run, boundary, segment, replay),
      );
      committedNow ||= admitted.committedNow;
      replayedCommitted ||= admitted.replayedCommitted === true;
      if (admitted.kind !== "completed") return withCommit(admitted);
      Object.assign(run, admitted.value.run);
      step = admitted.value.step;
      // A segment that committed nothing in this request (refused or failed, so it rolled back)
      // leaves no effect to count: partial is reported only when something persisted.
      if (
        !admitted.committedNow &&
        admitted.replayedCommitted !== true &&
        step.state.committedEffects !== boundary.committedEffects
      )
        step = { ...step, state: { ...step.state, committedEffects: boundary.committedEffects } };
      if (step.kind === "boundary")
        step = continueFlowRun(
          step.state,
          run.library,
          undefined,
          undefined,
          boundaries,
          dependencies.trace?.observer,
        );
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
   * inside its transaction, where the action's permission, precondition, subject and revision are
   * decided.
   */
  const runNamedAction = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: ExecuteNamedActionCommand | readonly ExecuteNamedActionCommand[],
    ports: FlowOrchestratorDependencies = dependencies,
  ): Promise<NamedActionExecutionResult | NamedActionBatchResult> => {
    const commands = Array.isArray(command) ? command : [command as ExecuteNamedActionCommand];
    if (ports.actionRecords === undefined || commands.length === 0) return { kind: "unavailable" };
    const head = commands[0]!;
    const installed = await ports.resolveRelease(selection.organizationId, head.action.actionId);
    const flowId = [...(installed?.namedActions?.values() ?? [])].find(
      (named) => named.action.actionId.toLowerCase() === head.action.actionId.toLowerCase(),
    )?.flowId;
    if (flowId === undefined) return { kind: "unavailable" };
    const prepared = await prepare(session, selection, flowId, "action", ports);
    if (prepared === undefined) return { kind: "unavailable" };
    if (prepared.release.recordTypes === undefined) return { kind: "unavailable" };
    const runner = namedActionFlowRunner(
      prepared.library,
      prepared.release.recordTypes,
      flowId,
      newRunId(),
    );
    return Array.isArray(command)
      ? ports.actionRecords.executeMany(session, selection, commands, runner)
      : ports.actionRecords.execute(session, selection, head, runner);
  };
  /** The one named-action path as the task runner calls it, bound to the ports of its attempt. */
  const namedRunner = (ports?: FlowOrchestratorDependencies): NamedActionRunner =>
    ((session: IdentitySession, selection: OrganizationSelectionCandidate, command: never) =>
      runNamedAction(session, selection, command, ports)) as NamedActionRunner;

  return Object.freeze({
    /** The one named-action path, for a host that runs flow steps itself (a back-end run). */
    namedActionRunner: namedRunner(),
    /** Admits and executes exactly the server segment selected by the page. */
    async invokeSegment(
      request: FlowStartRequest,
      input: Readonly<{
        segmentId: string;
        seed: Readonly<Record<string, unknown>>;
        pageResolvedInputs: readonly string[];
        bindingSources: Readonly<Record<string, FlowBindingInput>>;
        carriedValues: FlowRuntimeValues;
        runId?: string;
        entrySegments: readonly Readonly<{ segmentId: string; fingerprint: string }>[];
      }>,
    ) {
      try {
        const parsed = startRequestSchema.safeParse(request);
        if (
          !parsed.success ||
          !withinPayload(parsed.data.binding.inputs) ||
          !withinPayload(input.seed)
        )
          return refused;
        const { session, selection, binding, subject, bindingId, gestureId } = parsed.data;
        const prepared = await prepare(session, selection, binding.flowId);
        if (prepared === undefined) return refused;
        const plan = prepared.release.plans.get(binding.flowId);
        if (plan === undefined) return refused;
        if (!flowEntrySegmentsMatch(plan, input.entrySegments))
          return { kind: "reload", committedNow: false } as const;
        const segment = plan.segments.find(
          (part) => part.kind === "server" && part.id === input.segmentId,
        );
        if (segment === undefined || segment.kind !== "server") return refused;
        const actor = await dependencies.resolveActor?.(session, selection);
        const flow = prepared.library(prepared.flowId);
        const triggerRecord = await readRunRecord(
          session,
          selection,
          flow,
          flow?.recordInput === undefined
            ? undefined
            : (binding.inputs[flow.recordInput] ?? input.seed[`inputs.${flow.recordInput}`]),
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
        const instant = now().toISOString();
        let formValues: ReturnType<typeof parseFlowSegmentSeed>["forms"];
        try {
          formValues = parseFlowSegmentSeed(plan.definition, segment, input.seed, {
            pageResolvedInputs: input.pageResolvedInputs,
            carriedValues: input.carriedValues,
          }).forms;
        } catch (error) {
          console.error("[flows] invalid detached segment seed", error);
          return refused;
        }
        const resolvedInputs: Record<string, unknown> = { ...binding.inputs };
        for (const [name, source] of Object.entries(input.bindingSources)) {
          if (Object.hasOwn(resolvedInputs, name) || input.pageResolvedInputs.includes(name))
            continue;
          if (typeof source === "object" && source.kind === "caller") return refused;
          const value = resolveFlowValue(source, {
            now: instant,
            reference: (reference) => {
              if (reference.source === "execution_now")
                return { type: "date_time", value: instant };
              if (reference.source === "execution_actor" && actor !== undefined)
                return { type: "organization_account_reference", value: actor };
              if (reference.source === "trigger_record") return triggerRecord?.[reference.field];
              if (reference.source === "form") return formValues[reference.form]?.[reference.field];
              return undefined;
            },
          });
          if (value === undefined) return refused;
          resolvedInputs[name] = value.value;
        }
        const start = {
          runId: input.runId ?? newRunId(),
          flowId: binding.flowId,
          inputs: resolvedInputs,
          now: instant,
          pageResolvedInputs: input.pageResolvedInputs,
          carriedValues: input.carriedValues,
          ...(actor === undefined ? {} : { actor }),
          ...(subject === undefined ? {} : { subject }),
          ...(triggerRecord === undefined ? {} : { triggerRecord }),
        };
        const first = startFlowSegment(plan, segment.id, start, input.seed, run.library);
        const admitted = await dependencies.admitSegment(
          run,
          first.state,
          segment,
          async (ports, replay) => {
            const attempt: Run = {
              ...run,
              unavailable: [],
              warnings: [],
              refusalLoggedTaskIds: [],
              sensitive: [],
            };
            const initial = startFlowSegment(
              plan,
              segment.id,
              start,
              input.seed,
              attempt.library,
              replay?.effects,
            );
            const executed = await runFlowSegment(
              ports,
              namedRunner(ports),
              attempt,
              segment,
              initial,
              replay,
            );
            return {
              value: { step: executed.step, run: attempt },
              outcome: executed.outcome,
              effects: executed.effects,
              warnings: executed.warnings,
            };
          },
          first,
        );
        if (admitted.kind !== "completed") return admitted;
        const { run: attempt } = admitted.value;
        let step = admitted.value.step;
        // The segment committed before its Run on back end task; the task runs now.
        if (step.kind === "protected_task" && step.call.taskType === "backend.run") {
          const result = await createFlowTaskRunner(dependencies, namedRunner()).run(
            attempt,
            step.state,
            step.call,
          );
          step = resumeFlowRun(
            step.state,
            { kind: "task_result", ...result },
            attempt.library,
            undefined,
            segment,
          );
        }
        if ((step.kind !== "boundary" && step.kind !== "finished") || step.result === undefined)
          return refused;
        const response = finished(attempt, {
          kind: "finished",
          state: step.state,
          intents: step.kind === "finished" ? step.intents : [],
          result: step.result,
        });
        if (response.kind !== "finished") return response;
        return {
          ...response,
          committedNow: admitted.committedNow,
          ...(admitted.replayedCommitted === true ? { replayedCommitted: true as const } : {}),
          runId: admitted.runId,
          ...(step.result.status === "completed"
            ? {
                outputs: Object.fromEntries(
                  Object.entries({ ...step.result.outputs, ...step.result.finalOutputs }).map(
                    ([name, value]) => [name, value.value],
                  ),
                ),
                carriedOutputs: step.result.carriedOutputs ?? {},
              }
            : {}),
        };
      } catch (error) {
        reportUnexpectedFailure("flow segment start", error);
        return refused;
      }
    },
    /**
     * Runs a whole flow on the server for Studio's test run (flow id and typed inputs) for the
     * verified initiator; it stops at the first page step. The run id is issued here. The inputs and
     * the subject are values only: authority, organisation and actor never come from them.
     */
    async invokeBinding(request: FlowStartRequest): Promise<FlowOrchestratorResponse> {
      try {
        const parsed = startRequestSchema.safeParse(request);
        if (!parsed.success || !withinPayload(parsed.data.binding.inputs)) return refused;
        const { session, selection, binding, subject, bindingId, gestureId } = parsed.data;
        const prepared = await prepare(session, selection, binding.flowId);
        if (prepared === undefined) return refused;
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
          dependencies.trace?.observer,
          boundariesOf(run),
        );
        if (first.kind === "finished" || first.kind === "interface") {
          const admitted = await dependencies.admitPageStart(run, first.state);
          if (admitted.kind !== "completed") return admitted;
        }
        return await drive(run, first);
      } catch (error) {
        reportUnexpectedFailure("flow start", error);
        return refused;
      }
    },

  });
};

export type FlowOrchestrator = ReturnType<typeof createFlowOrchestrator>;
