import { flowRefusalFeedbackSentences } from "@vortex/platform/schema";
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
    text: "This was not allowed. Check your access and the values, or ask your administrator.",
  },
  conflict: { tone: "problem", text: "This changed since you opened it. Refresh and review it." },
  validation: {
    tone: "problem",
    text: "Some values were not accepted. Check each field and try again.",
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

export const unavailableNotice: Notice = {
  tone: "problem",
  text: "That is not available right now.",
};

/**
 * A run that reached a task the platform cannot run yet. It is not a refusal, so the person is
 * never told they lack a permission for it.
 */
const notAvailableNotice: Notice = { tone: "problem", text: "This is not available yet." };

/** A failed run that committed nothing: the person may simply try again. */
const failedUnchangedNotice: Notice = {
  tone: "problem",
  text: "That did not work, and nothing was changed. Try again.",
};

/** The notice for a finished run: its safe outcome, unless a task was not available. */
export const finishedNotice = (
  outcome: string | undefined,
  failureCode: unknown,
  commit: string | undefined,
): Notice =>
  failureCode === "task_not_available"
    ? notAvailableNotice
    : (outcome ?? "failed") === "failed" && commit === "none"
      ? failedUnchangedNotice
      : (outcomeNotices[outcome ?? "failed"] ?? unavailableNotice);

/** Signing in again for a recent sign-in; the dispatcher adds where to come back to. */
export const reauthenticationPath = "/auth/session-ended?status=reauthenticate";

export const refusalNotices: Readonly<
  Record<Extract<FormFlowFeedback, { kind: "refusal" }>["code"], Notice>
> = Object.fromEntries(
  Object.entries(flowRefusalFeedbackSentences).map(([code, text]) => [
    code,
    code === "recent_authentication_required"
      ? { tone: "problem", text, link: { label: "Sign in again", href: reauthenticationPath } }
      : { tone: "problem", text },
  ]),
) as Readonly<Record<Extract<FormFlowFeedback, { kind: "refusal" }>["code"], Notice>>;
