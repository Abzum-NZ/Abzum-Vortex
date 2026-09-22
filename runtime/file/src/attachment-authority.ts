import "server-only";

import type {
  FieldId,
  FileUploaderActor,
  SessionContext,
} from "@vortex/contracts";

export type ResolveUploaderResult =
  | Readonly<{ authorized: true; uploader: FileUploaderActor }>
  | Readonly<{ authorized: false; reason: string }>;

/**
 * Extracts a verified uploader actor union directly from trusted server session context.
 * Replaces human-only uploader with verified union for human and scoped system uploads.
 * Never fabricates an organization account for system actors.
 * Ordinary auth tokens, browser metadata, and anonymous callers confer no authority.
 */
export const resolveUploaderActorFromContext = (
  context: SessionContext,
): ResolveUploaderResult => {
  if (context.callerKind === "human") {
    if (!context.organizationAccountId) {
      return {
        authorized: false,
        reason: "Human caller missing required verified organization account",
      };
    }
    return {
      authorized: true,
      uploader: {
        kind: "human",
        organizationAccountId: context.organizationAccountId,
        ...(context.identityId ? { identityId: context.identityId } : {}),
      },
    };
  }

  if (context.callerKind === "system") {
    if (!context.systemActorId) {
      return {
        authorized: false,
        reason: "System caller missing required registered system actor ID",
      };
    }
    return {
      authorized: true,
      uploader: {
        kind: "system",
        systemActorId: context.systemActorId,
      },
    };
  }

  return {
    authorized: false,
    reason: "Public or anonymous callers confer no private file authority",
  };
};

export type VerifyAttachmentFieldAccessInput = Readonly<{
  fieldId: FieldId;
  permittedFieldIds: readonly FieldId[];
  operation: "read" | "write" | "delete";
}>;

export type AttachmentFieldAccessResult =
  | Readonly<{ authorized: true }>
  | Readonly<{ authorized: false; reason: string }>;

/**
 * Enforces attachment field authority matching record and field access rules.
 * A user or share grant with record access but without the attachment field named
 * cannot access or view file metadata or content.
 */
export const verifyAttachmentFieldAuthority = (
  input: VerifyAttachmentFieldAccessInput,
): AttachmentFieldAccessResult => {
  const isFieldPermitted = input.permittedFieldIds.includes(input.fieldId);
  if (!isFieldPermitted) {
    return {
      authorized: false,
      reason: `Attachment field '${input.fieldId}' is not permitted for operation '${input.operation}' by current record/field authority`,
    };
  }
  return { authorized: true };
};
