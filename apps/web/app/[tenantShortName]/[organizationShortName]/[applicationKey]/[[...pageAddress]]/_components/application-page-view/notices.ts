import { flowRefusalFeedbackSentences } from "@vortex/platform/schema";
import type { FormFlowFeedback } from "@vortex/ui";
import type { PageMessageDraft } from "./types";

/**
 * The fixed sentence for each safe flow outcome. The endpoint returns the outcome and, for a rule
 * refusal, the rule's own authored message (shown instead of the sentence here); never a service message.
 */
export const outcomeNotices: Readonly<Record<string, PageMessageDraft>> = {
  completed: { target: "toast", severity: "success", text: "Done." },
  committed: { target: "toast", severity: "success", text: "Saved.", dismissAfterMs: 5_000 },
  refused: {
    target: "banner",
    severity: "error",
    text: "This was not allowed. Check your access and the values, or ask your administrator.",
  },
  conflict: {
    target: "banner",
    severity: "error",
    text: "This changed since you opened it. Refresh and review it.",
  },
  validation: {
    target: "banner",
    severity: "error",
    text: "Some values were not accepted. Check each field and try again.",
  },
  partial: {
    target: "banner",
    severity: "error",
    text: "Only part of this was saved. Refresh and review what changed.",
  },
  uncertain: {
    target: "banner",
    severity: "error",
    text: "The result is not certain yet. Refresh before trying again.",
  },
  background_pending: {
    target: "toast",
    severity: "success",
    text: "Started. It will finish in the background.",
  },
  failed: { target: "banner", severity: "error", text: "That did not work. Try again." },
};

/** A board move the person backed out of at its form: nothing was saved. */
export const cancelledMoveNotice: PageMessageDraft = {
  target: "toast",
  severity: "success",
  text: "Move cancelled.",
};

export const unavailableNotice: PageMessageDraft = {
  target: "banner",
  severity: "error",
  text: "That is not available right now.",
};

/**
 * A run that reached a task the platform cannot run yet. It is not a refusal, so the person is
 * never told they lack a permission for it.
 */
const notAvailableNotice: PageMessageDraft = {
  target: "banner",
  severity: "error",
  text: "This is not available yet.",
};

/** A failed run that committed nothing: the person may simply try again. */
const failedUnchangedNotice: PageMessageDraft = {
  target: "banner",
  severity: "error",
  text: "That did not work, and nothing was saved. Try again.",
};

/** The notice for a finished run: its safe outcome, unless a task was not available. */
export const finishedNotice = (
  outcome: string | undefined,
  failureCode: unknown,
  commit: string | undefined,
): PageMessageDraft =>
  failureCode === "task_not_available"
    ? notAvailableNotice
    : (outcome ?? "failed") === "failed" && commit === "none"
      ? failedUnchangedNotice
      : (outcomeNotices[outcome ?? "failed"] ?? unavailableNotice);

/** Signing in again for a recent sign-in; the dispatcher adds where to come back to. */
export const reauthenticationPath = "/auth/session-ended?status=reauthenticate";

/** Verifying with, or setting up, an authenticator for the two-step verification a change needs. */
export const multiFactorPath = "/auth/sign-in?mfa=1";

/** The reply of a deliberate release adoption; a committed switch also carries the new page. */
export type ReleaseAdoptionOutcome =
  "adopted" | "refused" | "recent_authentication_required" | "multi_factor_required";

/** What the page tells the person after an adoption that changed nothing. */
export const releaseAdoptionNotices: Readonly<
  Record<Exclude<ReleaseAdoptionOutcome, "adopted">, PageMessageDraft>
> = {
  refused: {
    target: "banner",
    severity: "error",
    text: "The release could not be adopted. The current release is still in use.",
  },
  recent_authentication_required: {
    target: "banner",
    severity: "error",
    text: "A recent sign-in is required to adopt this release. Sign out, then sign in again with your email address and password before adopting. The current release is still in use.",
  },
  multi_factor_required: {
    target: "banner",
    severity: "error",
    text: flowRefusalFeedbackSentences.multi_factor_required,
    action: { kind: "link", label: "Verify", href: multiFactorPath },
  },
};

export const refusalNotices: Readonly<
  Record<Extract<FormFlowFeedback, { kind: "refusal" }>["code"], PageMessageDraft>
> = Object.fromEntries(
  Object.entries(flowRefusalFeedbackSentences).map(([code, text]) => [
    code,
    code === "recent_authentication_required"
      ? {
          target: "banner",
          severity: "error",
          text,
          action: { kind: "link", label: "Sign in again", href: reauthenticationPath },
        }
      : code === "multi_factor_required"
        ? {
            target: "banner",
            severity: "error",
            text,
            action: { kind: "link", label: "Verify", href: multiFactorPath },
          }
        : { target: "banner", severity: "error", text },
  ]),
) as Readonly<Record<Extract<FormFlowFeedback, { kind: "refusal" }>["code"], PageMessageDraft>>;
