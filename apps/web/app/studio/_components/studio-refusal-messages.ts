/** Messages for a create or save the server declined, each naming what the person can change. */
export const refusalMessage = (reason: string | undefined, subject: string): string =>
  reason === "session_ended"
    ? `Your session has ended. Sign in again, then retry. ${subject}`
    : reason === "permission_missing"
    ? `You do not have permission to manage definition drafts in this organization. ${subject}`
    : reason === "source_invalid"
      ? `The draft source is not valid, so it was not accepted. ${subject}`
      : reason === "context_changed"
        ? `Your session or access changed while this was being checked. Sign in again or ask an administrator, then retry. ${subject}`
        : `The request was refused. ${subject}`;

export const conflictMessage = (reason: string | undefined, subject: string): string =>
  reason === "key_exists"
    ? `An application with this key already exists. Choose a different key. ${subject}`
    : reason === "alias_conflict"
      ? `A name this draft uses was already used by an earlier component of this application and cannot be reassigned. Rename the component you changed or restore its previous name. ${subject}`
      : reason === "draft_missing"
      ? `This draft no longer exists. ${subject}`
      : reason === "draft_changed"
        ? `The saved draft changed since you opened it. ${subject}`
        : `The draft changed or already exists. ${subject}`;

export type StudioUnavailableKind =
  | "refused" | "conflict" | "temporarily_unavailable"
  | "validation_failed" | "dependency_unavailable" | "no_change";

/** What a loader declined and why, in words that name the real cause and what the person can change. */
export const unavailableMessage = (kind: StudioUnavailableKind, reason: string | undefined): string => {
  switch (reason) {
    case "session_ended":
      return "Your session has ended. Sign in again to continue.";
    case "recent_authentication_required":
      return "This needs a recent sign-in. Sign in again, then reload this page.";
    case "permission_missing":
    case "release_permission_missing":
      return "Your account does not have permission to manage this in the organization. Ask an administrator for access.";
    case "release_permission_not_eligible":
      return "Your account is not currently eligible to release in this organization. Ask an administrator.";
    case "organization_unavailable":
    case "organization_mismatch":
      return "This organization is not available to your account. Check the address or switch organization.";
    case "request_invalid":
    case "command_invalid":
      return "The address of this page is not valid, so nothing was read.";
    case "draft_missing":
      return "This draft does not exist in this organization.";
    case "draft_kind_mismatch":
      return "This address names a different kind of draft than this page edits.";
    case "draft_changed":
    case "draft_stale_or_missing":
      return "The saved draft changed while it was loading. Reload to read its current state.";
    case "context_changed":
    case "session_context_changed":
    case "request_deadline_passed":
      return "Your session or access changed while this was being checked. Reload the page; sign in again if it persists.";
    case "source_invalid":
      return "The saved draft source is not valid, so it cannot be opened here.";
    case "session_unavailable":
    case "request_failed":
    case "unexpected_failure":
      return "The platform could not read this because of a temporary problem, not a permission problem. Try again in a moment.";
    default:
      break;
  }
  switch (kind) {
    case "refused": return "The request was refused.";
    case "conflict": return "The saved draft changed while it was loading. Reload to read its current state.";
    case "temporarily_unavailable": return "The platform could not read this because of a temporary problem. Try again in a moment.";
    case "validation_failed": return "The saved draft did not pass validation, so it cannot be opened here.";
    case "dependency_unavailable": return "A published release this draft depends on is unavailable or incompatible.";
    case "no_change": return "Nothing has changed since the last release.";
    default: return kind satisfies never;
  }
};

/** Why the saved draft is not running as a preview, and what the person can do. */
export const previewProblem = (
  result: Readonly<{ kind: "refused"; reason: string } | { kind: "conflict" } | { kind: "temporarily_unavailable" }>,
): string =>
  result.kind === "conflict"
    ? "The saved draft changed while the preview was being prepared. Preview again."
    : result.kind === "temporarily_unavailable"
      ? "The preview is temporarily unavailable. Your changes are kept; try again."
      : result.reason === "permission_refused"
        ? "Previewing needs permission to publish this application. Ask an administrator."
        : "The preview request was not accepted. Reload Studio and try again.";
