import type { FormFlowFeedback } from "@vortex/ui";
import type { Notice } from "./types";

/**
 * The fixed sentence for each safe flow outcome. The endpoint returns the outcome and, for a rule
 * refusal, the rule's own authored message (shown instead of the sentence here); never a service message.
 */
export const outcomeNotices: Readonly<Record<string, Notice>> = {
  completed: { tone: "info", text: "Done." },
  committed: { tone: "info", text: "Saved." },
  refused: {
    tone: "problem",
    text: "The operation was refused by current access rules or operation policy. Review your access and the submitted values.",
  },
  conflict: { tone: "problem", text: "This changed since you opened it. Refresh and review it." },
  validation: {
    tone: "problem",
    text: "One or more submitted values do not match the operation's required format or rules. Review each field and its allowed values.",
  },
  partial: {
    tone: "problem",
    text: "Only part of this was saved. Refresh and review what changed.",
  },
  uncertain: {
    tone: "problem",
    text: "The result is not certain yet. Refresh before trying again.",
  },
  background_pending: { tone: "info", text: "Started. It will finish in the background." },
  failed: { tone: "problem", text: "That did not work. Try again." },
};

/** A board move the person backed out of at its form: nothing was saved. */
export const cancelledMoveNotice: Notice = { tone: "info", text: "Move cancelled." };

export const unavailableNotice: Notice = { tone: "problem", text: "That is not available right now." };

/**
 * A run that reached a task the platform cannot run yet. It is not a refusal, so the person is
 * never told they lack a permission for it.
 */
const notAvailableNotice: Notice = { tone: "problem", text: "This is not available yet." };

/** The notice for a finished run: its safe outcome, unless a task was not available. */
export const finishedNotice = (outcome: string | undefined, failureCode: unknown): Notice =>
  failureCode === "task_not_available"
    ? notAvailableNotice
    : (outcomeNotices[outcome ?? "failed"] ?? unavailableNotice);

export const refusalNotices: Readonly<
  Record<Extract<FormFlowFeedback, { kind: "refusal" }>["code"], Notice>
> = {
  invalid_command: { tone: "problem", text: "The supplied inputs are invalid." },
  duplicate_conflict: { tone: "problem", text: "A conflicting item already exists." },
  stale_revision: { tone: "problem", text: "This item changed. Refresh and try again." },
  role_acceptance_required: {
    tone: "problem",
    text: "This role revision needs accepting before it can be assigned.",
  },
};
