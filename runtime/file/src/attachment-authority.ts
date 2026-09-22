import "server-only";

import type {
  FieldId,
  OrganizationId,
  SessionContext,
  VerifiedFileActor,
} from "@vortex/contracts";

export type ResolveVerifiedFileActorResult =
  | Readonly<{ authorized: true; actor: VerifiedFileActor }>
  | Readonly<{ authorized: false; reason: string }>;

/**
 * Resolves the verified file actor from trusted server-side request context, for the
 * organisation that will own the file. A human caller is attributed to its verified
 * organisation account and global identity; a scoped system caller is attributed to
 * its registered system actor and never to an invented organisation account.
 *
 * Request parameters, browser-supplied metadata and an ordinary Auth token are not
 * accepted here: only the already-resolved server context is. A caller acting in a
 * different organisation than the file's confers no authority over that file, and a
 * federated caller's cross-organisation upload is admitted by the source File
 * service rather than attributed directly here.
 */
export const resolveVerifiedFileActor = (
  context: SessionContext,
  owningOrganizationId: OrganizationId,
): ResolveVerifiedFileActorResult => {
  if (context.organizationId !== owningOrganizationId) {
    return {
      authorized: false,
      reason: "Caller organisation does not own the file being recorded",
    };
  }

  switch (context.callerKind) {
    case "human":
      return {
        authorized: true,
        actor: {
          kind: "human",
          organizationAccountId: context.organizationAccountId,
          identityId: context.identityId,
        },
      };
    case "system":
      return {
        authorized: true,
        actor: { kind: "system", systemActorId: context.systemActorId },
      };
    case "federated":
      return {
        authorized: false,
        reason:
          "A federated caller's attachment upload is admitted by the source File service, not attributed as a local uploader",
      };
    default:
      return {
        authorized: false,
        reason: "Public and anonymous callers confer no private file authority",
      };
  }
};

export type VerifyAttachmentFieldAuthorityInput = Readonly<{
  fieldId: FieldId;
  readableFieldIds: readonly FieldId[];
  changeableFieldIds: readonly FieldId[];
  operation: "read" | "write" | "delete";
}>;

export type AttachmentFieldAuthorityResult =
  | Readonly<{ authorized: true }>
  | Readonly<{ authorized: false; reason: string }>;

/**
 * Applies the current record and field authority to one attachment field. File
 * metadata is not more visible than the field that holds it: access to the record
 * without the attachment field named readable lists and reveals nothing, and
 * changing or removing its files additionally needs the field changeable. The same
 * check covers a record-sharing grant, which must name the attachment field.
 */
export const verifyAttachmentFieldAuthority = (
  input: VerifyAttachmentFieldAuthorityInput,
): AttachmentFieldAuthorityResult => {
  if (!input.readableFieldIds.includes(input.fieldId)) {
    return {
      authorized: false,
      reason: `Attachment field '${input.fieldId}' is not readable under the current record and field authority`,
    };
  }

  if (input.operation !== "read" && !input.changeableFieldIds.includes(input.fieldId)) {
    return {
      authorized: false,
      reason: `Attachment field '${input.fieldId}' is not changeable under the current record and field authority, so '${input.operation}' is refused`,
    };
  }

  return { authorized: true };
};
