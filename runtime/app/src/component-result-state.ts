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
 *   rows or restore revoked content. A confirmed write is recorded whenever its response arrives,
 *   even when that response is too late to change the display, and is never removed (specification,
 *   frontend-rule-designer.md: "Discard obsolete display responses without pretending that a
 *   committed write was cancelled").
 *
 * - **A write-triggered refresh that cannot write.** `refreshComponentAfterSave` re-reads a
 *   component's dataset through a callback whose result type carries no flow, so the action that
 *   made the saved change can never run again. Each confirmed write refreshes at most once, and the
 *   re-read is accepted through the same generation guard, so a slow refresh can never replace a
 *   newer result (specification, frontend-rule-designer.md: "A write's own invalidation
 *   refreshes affected read results without recursively rerunning its originating write path").
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
 * `reconcile_before_retry`; a transient query failure is `unavailable` with `retry`; a
 * suspended interactive flow is `unavailable` with `awaiting_person` (or `partial`, with any page,
 * when it already committed effects); and a bound flow the orchestrator refused is `refused` even
 * when the page was read. Nothing here reads authority or content beyond the already-permitted page.
 */
export const projectComponentResult = (
  result: ComponentEventDispatchResult,
): ComponentDisplayOutcome => {
  if (result.kind === "refused") return projectDispatchRefusal(result.code);

  const data = result.data;
  // A bound flow the orchestrator refused could not be resolved or was not permitted: the event is
  // refused whether or not its page was read, so a refusal never renders as ordinary data.
  if (result.flow?.kind === "refused")
    return { kind: "refused", reason: "flow_refused", recovery: "change_request" };
  // A suspended flow that already committed effects is partial even when a page came back, so the
  // confirmed commits are never hidden behind the read.
  if (result.flow?.kind === "suspended" && result.flow.committedEffects > 0)
    return {
      kind: "partial",
      flow: {
        descriptor: safeFlowResultDescriptors.partial,
        committedEffects: result.flow.committedEffects,
      },
      ...(data === undefined ? {} : { data }),
    };

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

  // No read and no finished flow. A suspended flow with no commit awaits the person; anything else
  // is a completed event that reads no page.
  if (result.flow?.kind === "suspended")
    return { kind: "unavailable", reason: "awaiting_person", recovery: "await_person" };
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
 * A confirmed protected effect (at least one committed change). It is recorded whenever its
 * response arrives, even when that response is too late to change the display, so a stale display
 * never cancels it. `refreshedBy` names the one read-only refresh this write has started.
 */
export type ComponentConfirmedWrite = Readonly<{
  flow: ComponentFlowDisplay;
  invocationId: ComponentInvocationId;
  generation: number;
  selectedRow?: ComponentSelection;
  refreshedBy?: ComponentInvocationId;
}>;

/**
 * The current viewer-safe state of one component. `generation` is the newest request issued for the
 * component; `display` is the accepted projection of that newest request for the current
 * selection; and `writes` holds every confirmed protected effect the component has seen, in
 * generation order. A write is never removed: not by a discarded display response, a changed
 * selection or a later refusal.
 */
export type ComponentResultState = Readonly<{
  componentId: ContainedComponentId;
  generation: number;
  selectedRow?: ComponentSelection;
  display?: ComponentDisplayOutcome;
  displayInvocation?: ComponentInvocation;
  writes: readonly ComponentConfirmedWrite[];
}>;

/** The state of a component before any invocation has run. */
export const openComponentResultState = (
  componentId: ContainedComponentId,
): ComponentResultState => ({ componentId, generation: 0, writes: [] });

export type ComponentInvocationStartInput = Readonly<{
  componentId: ContainedComponentId;
  /** Only a semantic event starts here; a write invalidation starts via `refreshComponentAfterSave`. */
  cause: Extract<ComponentInvocationCause, { kind: "semantic_event" }>;
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

const startInvocation = (
  state: ComponentResultState | undefined,
  componentId: ContainedComponentId,
  cause: ComponentInvocationCause,
  selectedRowInput: ComponentSelection | undefined,
  invocationIdInput: string | undefined,
): ComponentInvocationStart => {
  const base = state !== undefined && sameId(state.componentId, componentId) ? state : undefined;
  const generation = (base?.generation ?? 0) + 1;
  const selectedRow = selectedRowInput === undefined ? base?.selectedRow : selectedRowInput;
  const selectionChanged = !sameSelection(base?.selectedRow, selectedRow);
  const carriedDisplay = base !== undefined && !selectionChanged ? base.display : undefined;
  const parsedId = componentInvocationIdSchema.safeParse(invocationIdInput);
  const invocation: ComponentInvocation = {
    invocationId: parsedId.success
      ? parsedId.data
      : componentInvocationIdSchema.parse(randomUUID()),
    componentId,
    cause,
    generation,
    ...(selectedRow === undefined ? {} : { selectedRow }),
  };
  const nextState: ComponentResultState = {
    componentId,
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
    writes: base?.writes ?? [],
  };
  return { state: nextState, invocation };
};

/**
 * Starts one semantic-event invocation for a component: it issues the invocation record at the next
 * generation and moves the state onto that request. A changed selection discards the now-stale
 * display immediately, so it can never be shown for the new selection, while every confirmed write
 * is carried forward. When the same selection is kept, the current display stays until a newer
 * result replaces it, but its older generation means a late response can no longer be accepted.
 * Two concurrent invocations therefore resolve by generation, not by arrival order: only the newer
 * one may set the display, whichever finishes first.
 */
export const beginComponentInvocation = (
  state: ComponentResultState | undefined,
  input: ComponentInvocationStartInput,
): ComponentInvocationStart =>
  startInvocation(state, input.componentId, input.cause, input.selectedRow, input.invocationId);

export type ComponentResultReductionReason =
  | "accepted"
  | "refresh_after_save"
  | "obsolete_generation"
  | "superseded_selection"
  | "malformed_invocation"
  | "no_confirmed_write"
  | "already_refreshed";

/**
 * The outcome of one reduction. `accepted` says whether the display changed; `state` is always the
 * state to keep, because a rejected display response may still have recorded a confirmed write.
 */
export type ComponentResultReduction = Readonly<{
  state: ComponentResultState;
  accepted: boolean;
  reason: ComponentResultReductionReason;
}>;

const unchanged = (
  state: ComponentResultState,
  reason: ComponentResultReductionReason,
): ComponentResultReduction => ({ state, accepted: false, reason });

/**
 * The confirmed write a dispatch result proves: any finished or suspended flow that committed at
 * least one protected effect, whatever its display outcome. An uncertain run that committed earlier
 * effects is displayed as `reconcile_before_retry`, but its confirmed commits are still recorded.
 */
const confirmedWriteOf = (
  result: ComponentEventDispatchResult,
  invocation: ComponentInvocation,
): ComponentConfirmedWrite | undefined => {
  if (result.kind !== "completed") return undefined;
  const flow = result.flow;
  if (flow === undefined || flow.kind === "refused" || flow.committedEffects <= 0) return undefined;
  // A suspended run has no finished descriptor; its commits are reported as partial, as displayed.
  const display: ComponentFlowDisplay = flowDisplay(flow) ?? {
    descriptor: safeFlowResultDescriptors.partial,
    committedEffects: flow.committedEffects,
  };
  return {
    flow: display,
    invocationId: invocation.invocationId,
    generation: invocation.generation,
    ...(invocation.selectedRow === undefined ? {} : { selectedRow: invocation.selectedRow }),
  };
};

/** Records a confirmed write once, in generation order; a repeated response keeps the first record. */
const recordWrite = (
  state: ComponentResultState,
  write: ComponentConfirmedWrite | undefined,
): ComponentResultState => {
  if (write === undefined) return state;
  if (state.writes.some((existing) => sameId(existing.invocationId, write.invocationId)))
    return state;
  const writes = [...state.writes, write].sort((left, right) => left.generation - right.generation);
  return { ...state, writes };
};

/** Whether an invocation's generation is one this state issued (a positive integer not beyond it). */
const issuedGeneration = (state: ComponentResultState, invocation: ComponentInvocation): boolean =>
  Number.isInteger(invocation.generation) &&
  invocation.generation > 0 &&
  invocation.generation <= state.generation;

/**
 * Reduces one semantic-event dispatch result into the component state. A confirmed write the result
 * proves is recorded first, whatever happens to the display. The display changes only for the
 * component's newest generation and current selection: a result for an older generation or a
 * selection the component has moved past leaves the display unchanged, so a late response never
 * replaces newer rows or restores revoked content, and an out-of-order completion of two concurrent
 * invocations can never let the older one win. A refresh after save is never accepted here: its data
 * is accepted only as a flow-free re-read through `acceptComponentReread`.
 */
export const acceptComponentResult = (
  state: ComponentResultState,
  invocation: ComponentInvocation,
  result: ComponentEventDispatchResult,
): ComponentResultReduction => {
  if (
    !sameId(invocation.componentId, state.componentId) ||
    invocation.cause.kind !== "semantic_event" ||
    !issuedGeneration(state, invocation)
  )
    return unchanged(state, "malformed_invocation");
  const recorded = recordWrite(state, confirmedWriteOf(result, invocation));
  if (invocation.generation !== recorded.generation)
    return unchanged(recorded, "obsolete_generation");
  if (!sameSelection(invocation.selectedRow, recorded.selectedRow))
    return unchanged(recorded, "superseded_selection");
  return {
    state: { ...recorded, display: projectComponentResult(result), displayInvocation: invocation },
    accepted: true,
    reason: "accepted",
  };
};

/**
 * The read-only result of re-reading a component's dataset after a saved change. It carries no flow
 * by construction and is not assignable from a dispatch result, so a dispatcher response (which may
 * have run a flow) cannot be passed off as a re-read.
 */
export type ComponentDatasetReread =
  | Readonly<{ kind: "page"; data: ComponentEventDataResult; flow?: never }>
  | Readonly<{ kind: "refused"; code: "query_refused" | "query_unavailable"; flow?: never }>;

/**
 * The composition's read-only dataset query for this component. It receives nothing it could use to
 * start a flow and must be built from the protected query path alone, never from the component
 * event dispatcher, which may run the event's bound flow.
 */
export type ComponentDatasetRereader = () => Promise<ComponentDatasetReread>;

const unavailableReread: ComponentDatasetReread = Object.freeze({
  kind: "refused",
  code: "query_unavailable",
});

/** Projects a re-read; anything that is not exactly a page or a read refusal is unavailable. */
const projectDatasetReread = (read: ComponentDatasetReread): ComponentDisplayOutcome => {
  if (typeof read !== "object" || read === null || "flow" in read)
    return { kind: "unavailable", reason: "query_unavailable", recovery: "retry" };
  if (read.kind === "page")
    return read.data.rows.length === 0
      ? { kind: "empty", data: read.data }
      : { kind: "completed", data: read.data };
  return read.kind === "refused" && read.code === "query_refused"
    ? { kind: "refused", reason: "not_permitted", recovery: "change_request" }
    : { kind: "unavailable", reason: "query_unavailable", recovery: "retry" };
};

/**
 * A started (or refused) refresh after save. When started, the state has already moved to the
 * refresh's generation; the caller awaits `read` and hands it, with `invocation`, to
 * `acceptComponentReread` against its then-current state, so a refresh that finishes after a newer
 * invocation began is discarded like any other obsolete response.
 */
export type ComponentRefreshAfterSave =
  | Readonly<{ started: false; state: ComponentResultState; reason: ComponentResultReductionReason }>
  | Readonly<{
      started: true;
      state: ComponentResultState;
      invocation: ComponentInvocation;
      read: Promise<ComponentDatasetReread>;
    }>;

/**
 * Refreshes one component after one of its own confirmed writes. The refresh runs at a new
 * generation with cause `write_invalidation`, and its data comes only from `reread`, whose result
 * type carries no flow: the changing flow is never invoked again. It is refused when the write is
 * not a confirmed write this state recorded, when that write already started its refresh (so each
 * write refreshes exactly once and a refresh can never cause another), or when the write belongs to
 * a selection the component has moved past. The write record stays in the state, and a read that
 * throws becomes a safe unavailable re-read rather than an error.
 */
export const refreshComponentAfterSave = (
  state: ComponentResultState,
  write: ComponentInvocation,
  reread: ComponentDatasetRereader,
): ComponentRefreshAfterSave => {
  if (!sameId(write.componentId, state.componentId))
    return { started: false, state, reason: "malformed_invocation" };
  if (write.cause.kind !== "semantic_event")
    return { started: false, state, reason: "already_refreshed" };
  const recorded = state.writes.find((entry) => sameId(entry.invocationId, write.invocationId));
  if (recorded === undefined) return { started: false, state, reason: "no_confirmed_write" };
  if (recorded.refreshedBy !== undefined)
    return { started: false, state, reason: "already_refreshed" };
  if (!sameSelection(recorded.selectedRow, state.selectedRow))
    return { started: false, state, reason: "superseded_selection" };

  const started = startInvocation(
    state,
    state.componentId,
    { kind: "write_invalidation" },
    undefined,
    undefined,
  );
  const refreshedBy = started.invocation.invocationId;
  const writes = started.state.writes.map((entry) =>
    entry === recorded ? { ...entry, refreshedBy } : entry,
  );
  const read = (async (): Promise<ComponentDatasetReread> => {
    try {
      return await reread();
    } catch {
      return unavailableReread;
    }
  })();
  return {
    started: true,
    state: { ...started.state, writes },
    invocation: started.invocation,
    read,
  };
};

/**
 * Accepts the re-read of a refresh after save. Only an invocation that `refreshComponentAfterSave`
 * issued for a recorded write is accepted, and only while it is still the component's newest
 * generation for the current selection; otherwise the state is returned unchanged. Every confirmed
 * write stays recorded either way.
 */
export const acceptComponentReread = (
  state: ComponentResultState,
  invocation: ComponentInvocation,
  read: ComponentDatasetReread,
): ComponentResultReduction => {
  if (
    !sameId(invocation.componentId, state.componentId) ||
    invocation.cause.kind !== "write_invalidation" ||
    !issuedGeneration(state, invocation) ||
    !state.writes.some(
      (entry) =>
        entry.refreshedBy !== undefined && sameId(entry.refreshedBy, invocation.invocationId),
    )
  )
    return unchanged(state, "malformed_invocation");
  if (invocation.generation !== state.generation) return unchanged(state, "obsolete_generation");
  if (!sameSelection(invocation.selectedRow, state.selectedRow))
    return unchanged(state, "superseded_selection");
  return {
    state: { ...state, display: projectDatasetReread(read), displayInvocation: invocation },
    accepted: true,
    reason: "refresh_after_save",
  };
};
