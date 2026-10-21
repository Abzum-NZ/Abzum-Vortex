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

export const unavailableNotice: Notice = {
  tone: "problem",
  text: "That is not available right now.",
};

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

const iamPeople = {
  link_label: "Open IAM People",
  destination: { application_key: "vortex.app.iam", page_key: "iam_people" },
} as const;

export const refusalNotices: Readonly<
  Record<Extract<FormFlowFeedback, { kind: "refusal" }>["code"], Notice>
> = {
  invalid_command: { tone: "problem", text: "The supplied inputs are invalid." },
  duplicate_conflict: { tone: "problem", text: "A conflicting item already exists." },
  stale_revision: { tone: "problem", text: "This item changed. Refresh and try again." },
  recent_authentication_required: {
    tone: "problem",
    text: "To protect your organisation, this change needs a sign-in within the last 15 minutes. Sign in again, then retry the change.",
    link: { label: "Sign in again", href: "/auth/session-ended" },
  },
  role_acceptance_required: {
    tone: "problem",
    text: "This role revision needs accepting before it can be assigned.",
  },
  role_settings_change_required: {
    tone: "problem",
    text: "Accepting application role changes keeps the role settings. Use Manage roles to change its name, description, classification or assignment and activation settings.",
  },
  application_storage_incompatible: {
    tone: "problem",
    text: "This version changes stored fields in a way existing records cannot accept. Keep existing choice options unchanged when adding options, and preserve field types, storage and ownership settings.",
  },
  applications_manage_required: {
    tone: "problem",
    text: "Installing or upgrading applications needs the Manage applications permission. An organisation steward can give you a role that has it in IAM.",
  },
  installation_delegation_required: {
    tone: "problem",
    text: "Installing this application needs app-installation authority over the permissions its roles grant. An organisation steward can grant it in IAM > People with Grant app-installation authority.",
  },
  assignments_manage_required: {
    tone: "problem",
    text: "Taking this application's role yourself needs the Manage access assignments permission. Install without taking the role, or ask an organisation steward for that permission in IAM.",
  },
};

/**
 * Where a refusal that names a missing permission sends the person: the platform's IAM People
 * page, opened through the same destination resolution an authored presentation uses.
 */
export const refusalDestinations: Readonly<
  Partial<
    Record<
      keyof typeof refusalNotices,
      Readonly<{ link_label: string; destination: { application_key: string; page_key: string } }>
    >
  >
> = {
  applications_manage_required: iamPeople,
  installation_delegation_required: iamPeople,
  assignments_manage_required: iamPeople,
};
