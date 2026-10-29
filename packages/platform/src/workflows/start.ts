import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { requireRequestSavepoint } from "../db/request-transaction";
import {
  createHumanOrganizationRequestService,
  HumanOrganizationRequestRestart,
  type BoundHumanOrganizationRequest,
  type HumanOrganizationRequestDependencies,
} from "../access/human-organization-request";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import { jsonValueSchema } from "../catalogue/common";
import { describeFailure } from "../catalogue/runtime-primitives";
import { flowRefusalFeedbackCodeSchema } from "./flow-refusal-feedback";
import { flowEntrySegmentsMatch, type FlowPlan, type FlowServerSegment } from "./flow-plan";
import type { FlowSegmentReplay, FlowTaskOutcome } from "../rules/flow-interpreter";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";
import { storedFlowWarningSchema, storeFlowWarning } from "./flow-warning-replay";

const effectSchema = z
  .object({
    kind: z.literal("task_result"),
    outcome: z.enum([
      "completed",
      "committed",
      "background_pending",
      "refused",
      "conflict",
      "validation",
      "uncertain",
      "failed",
    ]),
    outputs: z.record(z.string(), jsonValueSchema).optional(),
    diagnostic: z.object({ code: flowRefusalFeedbackCodeSchema }).strict().optional(),
  })
  .strict();
const receiptSchema = z
  .object({
    effects: z.record(z.string(), effectSchema.nullable()),
    warnings: z.record(z.string(), z.array(storedFlowWarningSchema)),
  })
  .strict();
const claimSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("claimed") }),
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("identity_conflict") }),
  z.object({ status: z.literal("completed"), result: receiptSchema }),
]);

/** A gesture, segment and loop iteration identify one logical command for this actor. */
const commandIdOf = (
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  gestureId: string,
  segmentId: string,
  iteration: string,
): string => {
  const bytes = createHash("sha256")
    .update(
      JSON.stringify([
        selection.organizationId.toLowerCase(),
        session.identityId.toLowerCase(),
        gestureId.toLowerCase(),
        segmentId,
        iteration,
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

type SegmentIdentity = Readonly<{ segmentId: string; fingerprint: string }> | null;
type SegmentContext = BoundHumanOrganizationRequest;
export type FlowSegmentReceipt = Readonly<{
  effects: FlowSegmentReplay;
  warnings: Readonly<Record<string, readonly z.infer<typeof storedFlowWarningSchema>[]>>;
}>;
type SegmentExecution<Value> = Readonly<{
  value: Value;
  /** Unsuccessful segments roll back their effects and receipt. */
  outcome: "succeeded" | "refused" | "failed";
  /** Only task outcomes and declared non-sensitive effect outputs; null means not replayable. */
  effects: Readonly<
    Record<
      string,
      Readonly<{
        outcome: FlowTaskOutcome;
        replay: FlowSegmentReplay[string];
      }>
    >
  >;
  warnings: Readonly<Record<string, readonly BeforeSaveRuleWarning[]>>;
}>;
export type StartFlowResult<Value> =
  | Readonly<{ kind: "completed"; value: Value; runId: string }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "rate_limited"; retryAfterSeconds: number }>
  | Readonly<{ kind: "refused" }>;

/** The host resolves the page and its binding; protected decisions use the supplied transaction. */
type StartFlowDependencies<Value> = Readonly<{
  requests: HumanOrganizationRequestDependencies;
  authorizeBinding: (context: SegmentContext) => Promise<boolean>;
  authorizeInvocation: (context: SegmentContext) => Promise<boolean>;
  /** Resolve the installed plan under the same scope that authorizes this admission. */
  currentPlan: (context: SegmentContext) => Promise<FlowPlan | undefined>;
  /** Rebuild the segment frame for each call: a restart rolls back the entire transaction. */
  execute: (
    context: SegmentContext,
    segment: FlowServerSegment | null,
    replay: FlowSegmentReceipt | undefined,
    runId: string,
  ) => Promise<SegmentExecution<Value>>;
}>;

/** Opens completion evidence only for a flow that can reach another server segment first. */
export const openFlowAdmissionRun = async (
  dependencies: Pick<StartFlowDependencies<never>, "requests" | "authorizeBinding" | "authorizeInvocation">,
  request: Readonly<{
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    plan: FlowPlan;
    bindingId: string;
  }>,
): Promise<Readonly<{ kind: "opened"; runId: string }> | Readonly<{ kind: "refused" }>> => {
  const bindingId = z.uuid().safeParse(request.bindingId);
  const serverSegments = request.plan.segments.filter((part) => part.kind === "server");
  if (
    !bindingId.success ||
    !serverSegments.some((part) => part.tasks.length === 0) ||
    !serverSegments.some((part) => part.tasks.length > 0)
  )
    return { kind: "refused" };
  const requests = createHumanOrganizationRequestService(dependencies.requests);
  const result = await requests.run(request.session, request.selection, async (transaction, scope, issuedAt) => {
    const context: SegmentContext = {
      transaction,
      scope,
      issuedAt,
      mode: "shared",
      session: request.session,
      selection: request.selection,
    };
    if (!(await dependencies.authorizeBinding(context))) return { kind: "refused" } as const;
    if (
      request.plan.definition.invocationPermissionId !== undefined &&
      !(await dependencies.authorizeInvocation(context))
    )
      return { kind: "refused" } as const;
    const rows = await transaction.query`select vortex_access.flow_run_evidence(${'start'}::text, ${null}::uuid, ${request.plan.flowId}::uuid, ${bindingId.data}::uuid, ${null}::uuid) as result`;
    const opened = z.object({ state: z.literal("started"), runId: z.uuid() }).strict().parse(rows[0]?.result);
    return { kind: "opened", runId: opened.runId } as const;
  });
  return result.kind === "available" ? result.value : { kind: "refused" };
};

/** Admits and executes one server segment under the same current human request transaction. */
export const startFlow = async <Value>(
  dependencies: StartFlowDependencies<Value>,
  request: Readonly<{
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    plan: FlowPlan;
    expected: SegmentIdentity;
    /** The entry set shown by the page, when this admission starts a binding. */
    entrySegments?: readonly Readonly<{ segmentId: string; fingerprint: string }>[];
    gestureId: string;
    runId?: string;
    /** Required when the plan has a completion segment; resolved from the trusted binding. */
    bindingId?: string;
    iteration: string;
    channel: "page" | "headless";
    /** Resolved by the server before opening a profile-change scope. */
    profileAccountId?: string;
  }>,
): Promise<StartFlowResult<Value>> => {
  const id = z.uuid().safeParse(request.gestureId);
  const suppliedRunId = z.uuid().safeParse(request.runId);
  const bindingId = z.uuid().safeParse(request.bindingId);
  const serverSegments = request.plan.segments.filter((part) => part.kind === "server");
  const hasCompletion = serverSegments.some((part) => part.tasks.length === 0);
  const completionOnly = serverSegments.length === 1 && hasCompletion;
  if (
    !id.success ||
    (!suppliedRunId.success && !(completionOnly && request.runId === undefined)) ||
    (hasCompletion && !bindingId.success) ||
    request.iteration.length > 200
  )
    return { kind: "refused" };
  const segment =
    request.expected === null
      ? null
      : request.plan.segments.find(
          (part): part is FlowServerSegment =>
            part.kind === "server" && part.id === request.expected?.segmentId,
        );
  // The mode is selected from the trusted plan before entering its Access scope.
  if (
    segment?.preScopeLock === "organization_account" &&
    !z.uuid().safeParse(request.profileAccountId).success
  )
    return { kind: "refused" };
  const requests = createHumanOrganizationRequestService(dependencies.requests);
  const mode = segment?.accessChange === true ? "access_change" : "shared";
  const operation = async (
    transaction: SegmentContext["transaction"],
    scope: SegmentContext["scope"],
    issuedAt: string,
  ): Promise<StartFlowResult<Value>> => {
    const context: SegmentContext = {
      transaction,
      scope,
      issuedAt,
      mode,
      session: request.session,
      selection: request.selection,
      ...(segment?.preScopeLock === "organization_account"
        ? { profileAccountId: request.profileAccountId! }
        : {}),
    };
    if (request.channel === "page" && !(await dependencies.authorizeBinding(context)))
      return { kind: "refused" };
    const currentPlan = await dependencies.currentPlan(context);
    if (currentPlan === undefined || currentPlan.flowId !== request.plan.flowId)
      return { kind: "refused" };
    if (currentPlan.definition.invocationPermissionId === undefined) {
      if (request.channel === "headless") return { kind: "refused" };
    } else if (!(await dependencies.authorizeInvocation(context))) return { kind: "refused" };
    if (
      request.entrySegments !== undefined &&
      !flowEntrySegmentsMatch(currentPlan, request.entrySegments)
    )
      return { kind: "reload" };
    if (request.expected === null) {
      if (currentPlan.segments.some((part) => part.kind === "server")) return { kind: "reload" };
      return {
        kind: "completed",
        value: (await dependencies.execute(context, null, undefined, suppliedRunId.data!)).value,
        runId: suppliedRunId.data!,
      };
    }
    const currentSegment = currentPlan.segments.find(
      (part): part is FlowServerSegment =>
        part.kind === "server" && part.id === request.expected?.segmentId,
    );
    if (
      segment === null ||
      segment === undefined ||
      currentSegment === undefined ||
      segment.fingerprint !== request.expected.fingerprint ||
      currentSegment.fingerprint !== request.expected.fingerprint
    )
      return { kind: "reload" };
    // Completion evidence must agree with the captured run's plan before any lock or effect.
    const currentServerSegments = currentPlan.segments.filter((part) => part.kind === "server");
    if (
      currentServerSegments.some((part) => part.tasks.length === 0) !== hasCompletion ||
      (currentServerSegments.length === 1 && hasCompletion) !== completionOnly
    )
      return { kind: "reload" };
    if (segment.multiTransaction) return { kind: "refused" };
    const commandId = commandIdOf(
      request.session,
      request.selection,
      id.data,
      segment.id,
      request.iteration,
    );
    let runId = suppliedRunId.success ? suppliedRunId.data : undefined;
    let evidenceState: "started" | "pending" | "succeeded" | "refused" | "failed" | "closed" | undefined;
    if (hasCompletion) {
      if (runId === undefined) {
        const opened = await transaction.query`select vortex_access.flow_run_evidence(${'start'}::text, ${null}::uuid, ${request.plan.flowId}::uuid, ${bindingId.data!}::uuid, ${null}::uuid) as result`;
        runId = z.object({ state: z.literal("started"), runId: z.uuid() }).strict().parse(opened[0]?.result).runId;
      }
      const locked = await transaction.query`select vortex_access.flow_run_evidence(${'lock'}::text, ${runId}::uuid, ${request.plan.flowId}::uuid, ${bindingId.data!}::uuid, ${null}::uuid) as result`;
      const evidence = z.discriminatedUnion("state", [
        z.object({ state: z.literal("unavailable") }).strict(),
        z.object({ state: z.enum(["started", "pending", "succeeded", "refused", "failed", "closed"]), pendingCommandId: z.uuid().nullable(), completionCommandId: z.uuid().nullable() }).strict(),
      ]).parse(locked[0]?.result);
      if (evidence.state === "unavailable") return { kind: "refused" };
      evidenceState = evidence.state;
      if (segment.tasks.length === 0) {
        if (evidence.state === "pending" || evidence.state === "refused" || evidence.state === "failed" ||
          (evidence.state === "closed" && evidence.completionCommandId !== commandId))
          return { kind: "refused" };
      } else if (evidence.state === "closed" ||
        (evidence.state === "pending" && (!segment.multiTransaction || evidence.pendingCommandId !== commandId)))
        return { kind: "refused" };
    }
    if (runId === undefined) return { kind: "refused" };
    const recordOutcome = async (outcome: SegmentExecution<Value>["outcome"]): Promise<void> => {
      if (!hasCompletion || evidenceState === "closed") return;
      const action = segment.tasks.length === 0 && outcome === "succeeded" ? "close" : outcome;
      const updated = await transaction.query`select vortex_access.flow_run_evidence(${action}::text, ${runId}::uuid, ${request.plan.flowId}::uuid, ${bindingId.data!}::uuid, ${action === "close" || evidenceState === "pending" ? commandId : null}::uuid) as result`;
      const expectedState = action === "close" ? "closed" : action;
      z.object({ state: z.literal(expectedState) }).strict().parse(updated[0]?.result);
    };
    let replay: FlowSegmentReceipt | undefined;
    if (segment.changes) {
      await transaction.query`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`${scope.organizationId}:flow_segment:${commandId}`}, 818))`;
      const rows =
        await transaction.query`select vortex_record.flow_segment_receipt(${commandId}::uuid, true) as result`;
      const found = claimSchema.parse(rows[0]?.result);
      if (found.status === "completed")
        replay = {
          effects: Object.fromEntries(
            Object.entries(found.result.effects).map(([key, effect]) => [
              key,
              effect === null
                ? null
                : {
                    kind: effect.kind,
                    outcome: effect.outcome,
                    ...(effect.outputs === undefined ? {} : { outputs: effect.outputs }),
                    ...(effect.diagnostic === undefined ? {} : { diagnostic: effect.diagnostic }),
                  },
            ]),
          ),
          warnings: found.result.warnings,
        };
      else if (found.status !== "none") return { kind: "refused" };
    }
    if (replay === undefined) {
      const rows =
        await transaction.query`select * from vortex_access.admit_flow_segment_rate(${segment.changes ? "change" : "read"}::text)`;
      const rate = z
        .object({ admitted: z.boolean(), retry_after_seconds: z.number().int().nonnegative() })
        .parse(rows[0]);
      if (!rate.admitted)
        return { kind: "rate_limited", retryAfterSeconds: rate.retry_after_seconds };
    }
    if (!segment.changes || replay !== undefined) {
      let executed: SegmentExecution<Value>;
      try {
        executed = hasCompletion
          ? await requireRequestSavepoint(transaction).withSavepoint((child) =>
              dependencies.execute({ ...context, transaction: child }, segment, replay, runId),
            )
          : await dependencies.execute(context, segment, replay, runId);
        if (Object.keys(executed.effects).length > 0)
          throw new Error("FLOW_SEGMENT_UNEXPECTED_EFFECT");
      } catch (error) {
        if (error instanceof HumanOrganizationRequestRestart || !hasCompletion) throw error;
        console.error(`[flows] segment execution failed: ${describeFailure(error)}`);
        await recordOutcome("failed");
        return { kind: "refused" };
      }
      await recordOutcome(executed.outcome);
      return { kind: "completed", value: executed.value, runId };
    }
    const rollback = new Error("FLOW_SEGMENT_REFUSED_ROLLBACK");
    let declined: Readonly<{ value: Value; outcome: "refused" | "failed" }> | undefined;
    try {
      const value = await requireRequestSavepoint(transaction).withSavepoint(async (child) => {
        const rows =
          await child.query`select vortex_record.flow_segment_receipt(${commandId}::uuid, false) as result`;
        if (claimSchema.parse(rows[0]?.result).status !== "claimed")
          throw new Error("FLOW_SEGMENT_CLAIM_INVALID");
        const executed = await dependencies.execute(
          { ...context, transaction: child },
          segment,
          undefined,
          runId,
        );
        if (executed.outcome !== "succeeded") {
          declined = { value: executed.value, outcome: executed.outcome };
          throw rollback;
        }
        const safeEffects: Record<string, FlowSegmentReplay[string]> = {};
        for (const [key, effect] of Object.entries(executed.effects)) {
          const [taskPath, iteration] = z
            .tuple([z.string().min(1).max(1000), z.string().min(1).max(200)])
            .parse(JSON.parse(key));
          if (effect.replay !== null && effect.replay.outcome !== effect.outcome)
            throw new Error("FLOW_SEGMENT_EFFECT_OUTCOME_MISMATCH");
          safeEffects[key] = effect.replay;
          const outputs = effect.replay?.outputs ?? {};
          await child.query`select vortex_platform.record_flow_segment_effect(${runId}::uuid, ${taskPath}::text, ${iteration}::text, ${effect.outcome}::text, ${JSON.stringify(outputs)}::text::jsonb)`;
        }
        const warnings = Object.fromEntries(
          Object.entries(executed.warnings).map(([key, entries]) => [
            key,
            entries.map(storeFlowWarning),
          ]),
        );
        const receipt = receiptSchema.parse({ effects: safeEffects, warnings });
        await child.query`select vortex_record.complete_flow_segment_receipt(${commandId}::uuid, ${JSON.stringify(receipt)}::text::jsonb)`;
        return executed.value;
      });
      await recordOutcome("succeeded");
      return { kind: "completed", value, runId };
    } catch (error) {
      if (error === rollback && declined !== undefined) {
        await recordOutcome(declined.outcome);
        return { kind: "completed", value: declined.value, runId };
      }
      if (!(error instanceof HumanOrganizationRequestRestart) && hasCompletion) {
        console.error(`[flows] segment execution failed: ${describeFailure(error)}`);
        await recordOutcome("failed");
        return { kind: "refused" };
      }
      throw error;
    }
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result =
        segment?.preScopeLock === "organization_account"
          ? await requests.runProfileChange(
              request.session,
              request.selection,
              request.profileAccountId!,
              operation,
              () => undefined,
            )
          : mode === "access_change"
            ? await requests.runAccessChange(request.session, request.selection, operation)
            : await requests.run(request.session, request.selection, operation);
      return result.kind === "available" ? result.value : { kind: "refused" };
    } catch (error) {
      if (!(error instanceof HumanOrganizationRequestRestart)) throw error;
    }
  }
  console.error(
    "[flows] segment could not acquire stable relationship totals after three attempts",
  );
  return { kind: "refused" };
};
