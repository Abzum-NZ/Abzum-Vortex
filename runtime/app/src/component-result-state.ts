import "server-only";

import { randomUUID } from "node:crypto";

import {
  componentSemanticEventKindSchema,
  recordIdSchema,
  revisionSchema,
  safeFlowResultDescriptors,
  type ContainedComponentId,
  type SafeFlowResultDescriptor,
  type SafeFlowResultKind,
} from "@vortex/contracts";
import { z } from "zod";
import type {
  ComponentEventDataResult,
  ComponentEventDispatchResult,
} from "./component-event-dispatch";
import type { FlowOrchestratorResponse } from "./flow-orchestrator";

/**
 * #585: the viewer-safe result state of one data component. A data component owns one view, and
 * #584 (`component-event-dispatch.ts`) is the only way that view changes. This module sits beside
 * it and keeps the three facts a surface needs once a dispatch returns, without fetching,
 * resolving or executing anything itself:
 *
 * - **A viewer-safe projection.** Every dispatch result becomes exactly one closed display
 *   outcome — `completed`, `empty`, `refused`, `partial` or `unavailable`. The projection carries
 *   only what the viewer may already see: the engine's own permitted page and the shared safe
 *   result descriptor. Flow outputs, intents, unavailable notices and raw failure detail are
 *   never projected, so a result the viewer may not read can never be presented as empty data or
 *   as success (specification, frontend-rule-designer.md: "Errors, permission refusal and partial
 *   flow failure are distinct from an empty table").
 *
 * - **A reducer with an obsolete-response guard.** An invocation is tracked by its invocation id,
 *   its cause, the selected row it belongs to and a per-component request generation. A response
 *   whose generation is older than the component's current generation, or that belongs to a
 *   selection the component has moved past, is discarded: a late response can never replace newer
 *   rows or restore revoked content. Discarding a stale display response never cancels a confirmed
 *   write outcome, which is held separately (specification, frontend-rule-designer.md: "Discard
 *   obsolete display responses without pretending that a committed write was cancelled").
 *
 * - **A write-triggered refresh that cannot write.** `refreshComponentAfterSave` re-reads a
 *   component's dataset through a callback whose result type carries no flow, so the action that
 *   made the saved change can never run again (specification, frontend-rule-designer.md: "A
 *   write's own invalidation refreshes affected read results without recursively rerunning its
 *   originating write path").
 *
 * The module is pure apart from that read callback: it reads no identity, authority, organisation
 * or record from its inputs. The dispatch result it receives is already the viewer's permitted
 * projection, and the read callback is the composition's read-only query path.
 */

/** The five closed display outcomes of one component result (issue #585). */
export const componentDisplayOutcomeKinds = [
  "completed",
  "empty",
  "refused",
  "partial",
  "unavailable",
] as const;
export type ComponentDisplayOutcomeKind = (typeof componentDisplayOutcomeKinds)[number];

/**
 * What the viewer may do next. The shared safe result descriptor's own recovery vocabulary, plus
 * `retry` for a transient unavailable read and `await_person` while an interactive flow waits for
 * an answer. It is viewer-safe guidance only, never a retry instruction for a committed effect.
 */
export type ComponentDisplayRecovery =
  | SafeFlowResultDescriptor["recovery"]
  | "retry"
  | "await_person";

export const componentDisplayRefusalReasons = [
  /** The viewer may not run the query, or the verified context was not the one it resolved for. */
  "not_permitted",
  /** The request, its values or its filter did not parse against the declaration. */
  "invalid_request",
  /** The event or its placement is not declared, so nothing can be dispatched. */
  "unsupported",
  /** The event's bound flow refused, conflicted, failed validation or failed with no commit. */
  "flow_refused",
] as const;
export type ComponentDisplayRefusalReason = (typeof componentDisplayRefusalReasons)[number];

export const componentDisplayUnavailableReasons = [
  /** The query engine could not answer; the state is transient, not a permission decision. */
  "query_unavailable",
  /** A protected effect's outcome is uncertain and must be reconciled before any retry. */
  "reconcile_before_retry",
  /** An interactive flow is suspended waiting for the person; no terminal result exists yet. */
  "awaiting_person",
] as const;
export type ComponentDisplayUnavailableReason = (typeof componentDisplayUnavailableReasons)[number];

/**
 * The viewer-safe summary of the flow an event ran. It holds only the shared safe descriptor (the
 * fixed commit state, output availability and recovery path) and how many protected effects
 * committed; it never holds outputs, intents, messages or errors.
 */
export type ComponentFlowDisplay = Readonly<{
  descriptor: SafeFlowResultDescriptor;
  committedEffects: number;
}>;

/**
 * The viewer-safe result of one component event. `completed` carries an optional page and an
 * optional flow (a committed flow's rows are fresh; a completed flow keeps the read's own state);
 * `empty` always carries a valid page with zero rows; `refused` and `unavailable` carry no data and
 * never fall back to an earlier page; `partial` carries the flow whose effects were preserved.
 */
export type ComponentDisplayOutcome =
  | Readonly<{
      kind: "completed";
      data?: ComponentEventDataResult;
      flow?: ComponentFlowDisplay;
    }>
  | Readonly<{ kind: "empty"; data: ComponentEventDataResult }>
  | Readonly<{
      kind: "refused";
      reason: ComponentDisplayRefusalReason;
      recovery: ComponentDisplayRecovery;
    }>
  | Readonly<{
      kind: "partial";
      flow: ComponentFlowDisplay;
      data?: ComponentEventDataResult;
    }>
  | Readonly<{
      kind: "unavailable";
      reason: ComponentDisplayUnavailableReason;
      recovery: ComponentDisplayRecovery;
    }>;

/**
 * Summarises a finished flow response through the shared safe descriptor. A failure that preserved
 * earlier commits is reported as `partial`, regardless of which task ended the run, so a later
 * display failure can never present a committed effect as rolled back. A suspended or refused
 * response is not a finished result and is reported by the caller's own state instead.
 */
const flowDisplay = (
  flow: FlowOrchestratorResponse | undefined,
): ComponentFlowDisplay | undefined => {
  if (flow === undefined || flow.kind !== "finished") return undefined;
  const effective: SafeFlowResultKind =
    flow.outcome === "committed" || flow.outcome === "completed" || flow.outcome === "uncertain"
      ? flow.outcome
      : flow.committedEffects > 0
        ? "partial"
        : flow.outcome;
  return {
    descriptor: safeFlowResultDescriptors[effective],
    committedEffects: flow.committedEffects,
  };
};

/** Refusal codes that are a permission or verified-context decision rather than a malformed one. */
const notPermittedRefusalCodes: ReadonlySet<string> = new Set([
  "invalid_context",
  "untrusted_identity_input",
  "unexpected_event_context",
  "query_refused",
]);

/** Refusal codes for an event, placement or target that is not declared for this component. */
const unsupportedRefusalCodes: ReadonlySet<string> = new Set([
  "unsupported_event",
  "missing_placement",
  "local_filter_without_page",
  "unknown_binding",
  "unknown_flow",
  "unknown_query",
  "ambiguous_query",
]);

/** The outcome of a top-level dispatch refusal, classified without exposing its raw detail. */
const projectDispatchRefusal = (code: string): ComponentDisplayOutcome => {
  if (code === "query_unavailable")
    return { kind: "unavailable", reason: "query_unavailable", recovery: "retry" };
  if (notPermittedRefusalCodes.has(code))
    return { kind: "refused", reason: "not_permitted", recovery: "change_request" };
  if (unsupportedRefusalCodes.has(code))
    return { kind: "refused", reason: "unsupported", recovery: "change_request" };
  return { kind: "refused", reason: "invalid_request", recovery: "correct_inputs" };
};

/**
 * Projects one #584 dispatch result into exactly one viewer-safe display outcome.
 *
 * A confirmed protected effect is never masked by a stale or empty read: a committed flow is
 * `completed` and a failure that preserved commits is `partial`. A plain completed flow defers to
 * the read's own state, so a zero-row page stays `empty` and is never reported as an error. A flow
 * refusal or failure with no commit is `refused`; an uncertain effect is `unavailable` with
 * `reconcile_before_retry`; a transient query failure is `unavailable` with `retry`; and a
 * suspended interactive flow is `unavailable` with `awaiting_person` (or `partial` when it already
 * committed effects). Nothing here reads authority or content beyond the already-permitted page.
 */
export const projectComponentResult = (
  result: ComponentEventDispatchResult,
): ComponentDisplayOutcome => {
  if (result.kind === "refused") return projectDispatchRefusal(result.code);

  const data = result.data;
  const flow = flowDisplay(result.flow);

  if (flow !== undefined) {
    const descriptor = flow.descriptor;
    if (descriptor.commit === "partial")
      return { kind: "partial", flow, ...(data === undefined ? {} : { data }) };
    if (descriptor.outcome === "uncertain")
      return {
        kind: "unavailable",
        reason: "reconcile_before_retry",
        recovery: descriptor.recovery,
      };
    if (descriptor.commit === "confirmed")
      return { kind: "completed", flow, ...(data === undefined ? {} : { data }) };
    // A completed flow made no commit, so the read below decides the outcome. Any other finished
    // outcome made no commit and is a refusal.
    if (descriptor.outcome !== "completed")
      return { kind: "refused", reason: "flow_refused", recovery: descriptor.recovery };
  }

  if (result.dataRefusal !== undefined)
    return result.dataRefusal.code === "query_refused"
      ? { kind: "refused", reason: "not_permitted", recovery: "change_request" }
      : { kind: "unavailable", reason: "query_unavailable", recovery: "retry" };

  if (data !== undefined)
    return data.rows.length === 0 ? { kind: "empty", data } : { kind: "completed", data };

  // No read and no finished flow. A suspended flow awaits the person; a refused flow could not be
  // resolved or was not permitted; anything else is a completed event that reads no page.
  if (result.flow?.kind === "suspended")
    return result.flow.committedEffects > 0
      ? {
          kind: "partial",
          flow: {
            descriptor: safeFlowResultDescriptors.partial,
            committedEffects: result.flow.committedEffects,
          },
        }
      : { kind: "unavailable", reason: "awaiting_person", recovery: "await_person" };
  if (result.flow?.kind === "refused")
    return { kind: "refused", reason: "flow_refused", recovery: "change_request" };
  return { kind: "completed" };
};

/** A row/selection identity with the revision the viewer last saw, used to scope an invocation. */
export const componentSelectionSchema = z
  .object({ recordId: recordIdSchema, revision: revisionSchema })
  .strict();
export type ComponentSelection = z.infer<typeof componentSelectionSchema>;

/** Why an invocation ran: a semantic event, or a read-only refresh after a write. */
export const componentInvocationCauseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("semantic_event"), event: componentSemanticEventKindSchema }).strict(),
  z.object({ kind: z.literal("write_invalidation") }).strict(),
]);
export type ComponentInvocationCause = z.infer<typeof componentInvocationCauseSchema>;

export const componentInvocationIdSchema = z.uuid().brand<"ComponentInvocationId">();
export type ComponentInvocationId = z.infer<typeof componentInvocationIdSchema>;

/**
 * One tracked component invocation. The invocation id names this exact call; the cause says why it
 * ran; the selected row scopes its result; and the generation is the component's strictly
 * increasing request counter, so a response for an older generation is provably obsolete.
 */
export type ComponentInvocation = Readonly<{
  invocationId: ComponentInvocationId;
  componentId: ContainedComponentId;
  cause: ComponentInvocationCause;
  selectedRow?: ComponentSelection;
  generation: number;
}>;

/**
 * A confirmed protected effect (at least one committed change) that a stale display must not
 * cancel.
 */
export type ComponentConfirmedWrite = Readonly<{
  flow: ComponentFlowDisplay;
  invocationId: ComponentInvocationId;
  generation: number;
  selectedRow?: ComponentSelection;
}>;

/**
 * The current viewer-safe state of one component. `generation` is the newest request issued for the
 * component; `display` is the accepted projection for the current selection; and `write` is the
 * latest confirmed protected effect, which survives a discarded display response and is never
 * cleared by a later refusal.
 */
export type ComponentResultState = Readonly<{
  componentId: ContainedComponentId;
  generation: number;
  selectedRow?: ComponentSelection;
  display?: ComponentDisplayOutcome;
  displayInvocation?: ComponentInvocation;
  write?: ComponentConfirmedWrite;
}>;

/** The state of a component before any invocation has run. */
export const openComponentResultState = (
  componentId: ContainedComponentId,
): ComponentResultState => ({ componentId, generation: 0 });

export type ComponentInvocationStartInput = Readonly<{
  componentId: ContainedComponentId;
  cause: ComponentInvocationCause;
  selectedRow?: ComponentSelection;
  /** The caller's own invocation id; a valid one is kept, otherwise a fresh one is issued. */
  invocationId?: string;
}>;

export type ComponentInvocationStart = Readonly<{
  state: ComponentResultState;
  invocation: ComponentInvocation;
}>;

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const sameSelection = (
  left: ComponentSelection | undefined,
  right: ComponentSelection | undefined,
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : sameId(left.recordId, right.recordId) && left.revision === right.revision;

/**
 * Starts one invocation for a component: it issues the invocation record at the next generation and
 * moves the state onto that request. A changed selection discards the now-stale display
 * immediately, so it can never be shown for the new selection, while a confirmed write outcome is
 * carried forward. When the same selection is kept, the current display stays until a newer result
 * replaces it, but its older generation means a late response can no longer be accepted.
 */
export const beginComponentInvocation = (
  state: ComponentResultState | undefined,
  input: ComponentInvocationStartInput,
): ComponentInvocationStart => {
  const base =
    state !== undefined && sameId(state.componentId, input.componentId) ? state : undefined;
  const generation = (base?.generation ?? 0) + 1;
  const selectedRow = input.selectedRow === undefined ? base?.selectedRow : input.selectedRow;
  const selectionChanged = !sameSelection(base?.selectedRow, selectedRow);
  const carriedDisplay = base !== undefined && !selectionChanged ? base.display : undefined;
  const parsedId = componentInvocationIdSchema.safeParse(input.invocationId);
  const invocation: ComponentInvocation = {
    invocationId: parsedId.success
      ? parsedId.data
      : componentInvocationIdSchema.parse(randomUUID()),
    componentId: input.componentId,
    cause: input.cause,
    generation,
    ...(selectedRow === undefined ? {} : { selectedRow }),
  };
  const nextState: ComponentResultState = {
    componentId: input.componentId,
    generation,
    ...(selectedRow === undefined ? {} : { selectedRow }),
    ...(carriedDisplay === undefined
      ? {}
      : {
          display: carriedDisplay,
          ...(base?.displayInvocation === undefined
            ? {}
            : { displayInvocation: base.displayInvocation }),
        }),
    ...(base?.write === undefined ? {} : { write: base.write }),
  };
  return { state: nextState, invocation };
};

export type ComponentResultReductionReason =
  | "accepted"
  | "refresh_after_save"
  | "obsolete_generation"
  | "superseded_selection"
  | "malformed_invocation"
  | "no_confirmed_write"
  | "already_refreshed";

export type ComponentResultReduction = Readonly<{
  state: ComponentResultState;
  accepted: boolean;
  reason: ComponentResultReductionReason;
}>;

const unchanged = (
  state: ComponentResultState,
  reason: ComponentResultReductionReason,
): ComponentResultReduction => ({ state, accepted: false, reason });

/** The confirmed write an outcome proves, if it committed at least one protected effect. */
const confirmedWriteOf = (
  outcome: ComponentDisplayOutcome,
  invocation: ComponentInvocation,
): ComponentConfirmedWrite | undefined => {
  const flow =
    outcome.kind === "partial"
      ? outcome.flow
      : outcome.kind === "completed" && outcome.flow?.descriptor.commit === "confirmed"
        ? outcome.flow
        : undefined;
  if (flow === undefined) return undefined;
  return {
    flow,
    invocationId: invocation.invocationId,
    generation: invocation.generation,
    ...(invocation.selectedRow === undefined ? {} : { selectedRow: invocation.selectedRow }),
  };
};

/**
 * Reduces one dispatch result into the component state. A result for a different component, an
 * older generation, or a selection the component has moved past is discarded and the state is
 * returned unchanged, so a late response never replaces newer rows or restores revoked content. An
 * accepted result replaces the display and records a confirmed commit as the component's write;
 * a refusal never clears that write.
 */
export const acceptComponentResult = (
  state: ComponentResultState,
  invocation: ComponentInvocation,
  result: ComponentEventDispatchResult,
): ComponentResultReduction => {
  if (!sameId(invocation.componentId, state.componentId))
    return unchanged(state, "malformed_invocation");
  if (!Number.isInteger(invocation.generation) || invocation.generation < state.generation)
    return unchanged(state, "obsolete_generation");
  if (!sameSelection(invocation.selectedRow, state.selectedRow))
    return unchanged(state, "superseded_selection");
  const display = projectComponentResult(result);
  const write = confirmedWriteOf(display, invocation);
  return {
    state: {
      ...state,
      display,
      displayInvocation: invocation,
      ...(write === undefined ? {} : { write }),
    },
    accepted: true,
    reason: "accepted",
  };
};

/**
 * The read-only result of re-reading a component's dataset after a saved change. It carries no flow
 * by construction, so the callback that produces it cannot run the action that made the change.
 */
export type ComponentDatasetReread =
  | Readonly<{ kind: "page"; data: ComponentEventDataResult }>
  | Readonly<{ kind: "refused"; code: "query_refused" | "query_unavailable" }>;

const projectDatasetReread = (read: ComponentDatasetReread): ComponentDisplayOutcome => {
  if (read.kind === "page")
    return read.data.rows.length === 0
      ? { kind: "empty", data: read.data }
      : { kind: "completed", data: read.data };
  return read.code === "query_refused"
    ? { kind: "refused", reason: "not_permitted", recovery: "change_request" }
    : { kind: "unavailable", reason: "query_unavailable", recovery: "retry" };
};

/**
 * Refreshes one component after its own write committed. The refresh runs at a new generation with
 * cause `write_invalidation`, and the data comes from `reread`, whose result type carries no flow:
 * the changing flow can never be invoked again. The refresh is refused when the write is not the
 * component's current invocation, when it belongs to a selection the component has moved past, when
 * it did not commit, or when it was already a refresh (explicit same-cause re-entry is refused).
 * The confirmed write outcome is preserved, and a read failure becomes a safe unavailable outcome
 * rather than throwing.
 */
export const refreshComponentAfterSave = async (
  state: ComponentResultState,
  write: ComponentInvocation,
  reread: () => Promise<ComponentDatasetReread>,
): Promise<ComponentResultReduction> => {
  if (!sameId(write.componentId, state.componentId))
    return unchanged(state, "malformed_invocation");
  if (write.cause.kind !== "semantic_event") return unchanged(state, "already_refreshed");
  if (!sameSelection(write.selectedRow, state.selectedRow))
    return unchanged(state, "superseded_selection");
  if (state.write === undefined || !sameId(state.write.invocationId, write.invocationId))
    return unchanged(state, "no_confirmed_write");
  if (write.generation < state.generation) return unchanged(state, "obsolete_generation");

  const started = beginComponentInvocation(state, {
    componentId: state.componentId,
    cause: { kind: "write_invalidation" },
  });
  let read: ComponentDatasetReread;
  try {
    read = await reread();
  } catch {
    read = { kind: "refused", code: "query_unavailable" };
  }
  return {
    state: {
      ...started.state,
      display: projectDatasetReread(read),
      displayInvocation: started.invocation,
    },
    accepted: true,
    reason: "refresh_after_save",
  };
};
