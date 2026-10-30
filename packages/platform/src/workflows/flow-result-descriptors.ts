import type { SafeFlowResultKind } from "./flow-effects";
import type { SafeFlowResultDescriptor } from "../definition/application-flow-bindings";

/** The one shared result map: every safe flow result kind to its fixed descriptor. */
export const safeFlowResultDescriptors: Readonly<{
  [Outcome in SafeFlowResultKind]: Extract<SafeFlowResultDescriptor, { outcome: Outcome }>;
}> = Object.freeze({
  completed: { outcome: "completed", commit: "none", outputs: "available", recovery: "none" },
  committed: { outcome: "committed", commit: "confirmed", outputs: "available", recovery: "none" },
  refused: {
    outcome: "refused",
    commit: "none",
    outputs: "unavailable",
    recovery: "change_request",
  },
  conflict: {
    outcome: "conflict",
    commit: "none",
    outputs: "unavailable",
    recovery: "refresh_and_review",
  },
  validation: {
    outcome: "validation",
    commit: "none",
    outputs: "unavailable",
    recovery: "correct_inputs",
  },
  partial: {
    outcome: "partial",
    commit: "partial",
    outputs: "unavailable",
    recovery: "review_committed_effects",
  },
  uncertain: {
    outcome: "uncertain",
    commit: "unknown",
    outputs: "unavailable",
    recovery: "reconcile_before_retry",
  },
  background_pending: {
    outcome: "background_pending",
    commit: "accepted",
    outputs: "unavailable",
    recovery: "await_background_result",
  },
  failed: { outcome: "failed", commit: "none", outputs: "unavailable", recovery: "new_invocation" },
});
