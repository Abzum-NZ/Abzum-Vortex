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
    : reason === "draft_missing"
      ? `This draft no longer exists. ${subject}`
      : reason === "draft_changed"
        ? `The saved draft changed since you opened it. ${subject}`
        : `The draft changed or already exists. ${subject}`;

/** A Module draft save the server refused: the reason the person can act on, without a subject. */
export const moduleSaveRefusal = (reason: string | undefined): string =>
  refusalMessage(reason, "").trim();
