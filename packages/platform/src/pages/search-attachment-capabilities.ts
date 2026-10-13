import "server-only";

import {
  applicationRootIdSchema,
  attachmentListPayloadSchema,
  attachmentValueSchema,
  fieldIdSchema,
  fileIdSchema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  type AttachmentListPayload,
  isRecord,
  sameId,
} from "../schema";

export type ReadOnlyAttachmentOwner = Readonly<{
  organizationId: string;
  applicationRootId: string;
  recordTypeId: string;
  recordId: string;
  fieldId: string;
}>;

export type ReadOnlyAttachmentDecision = Readonly<{
  outcome: string;
  organizationId: string;
  applicationRootId: string;
  recordTypeId: string;
  recordId: string;
  fieldId: string;
}>;

export type ReadOnlyAttachmentFileMetadata = Readonly<{
  fileId: string;
  organizationId: string;
  applicationRootId?: string;
  ownerRecordTypeId?: string;
  ownerRecordId?: string;
  ownerFieldId?: string;
  lifecycleState: string;
  scannerResult: string;
  originalSafeDisplayName: string;
  detectedMediaType: string;
  sizeBytes: number;
}>;

export type ReadOnlyAttachmentFileEvidence =
  | Readonly<{
      kind: "read";
      decision: ReadOnlyAttachmentDecision;
      metadata: ReadOnlyAttachmentFileMetadata;
    }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "unavailable" }>;

/** Why a projection was refused; the page reader logs it so a refusal always has a cause. */
export type ReadOnlyAttachmentRefusalReason =
  | "owner_tuple_invalid"
  | "field_value_absent"
  | "field_value_invalid"
  | "file_count_exceeds_maximum"
  | "file_id_invalid_or_duplicate"
  | "file_read_refused"
  | "file_evidence_mismatch"
  | "payload_invalid";

export type ReadOnlyAttachmentListProjection =
  | Readonly<{ kind: "ready"; values: AttachmentListPayload }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "refused"; reason: ReadOnlyAttachmentRefusalReason }>
  | Readonly<{ kind: "unavailable" }>;

/**
 * Projects one protected attachment field only after each current File decision and metadata read
 * agree with the exact installed subject tuple. A failed item discards the whole list.
 */
export const projectReadOnlyAttachmentList = async (input: Readonly<{
  owner: ReadOnlyAttachmentOwner;
  subjectValues: unknown;
  maximumFiles: number;
  readFile: (fileId: string) => Promise<ReadOnlyAttachmentFileEvidence>;
}>): Promise<ReadOnlyAttachmentListProjection> => {
  const organizationId = organizationIdSchema.safeParse(input.owner.organizationId);
  const applicationRootId = applicationRootIdSchema.safeParse(input.owner.applicationRootId);
  const recordTypeId = recordTypeIdSchema.safeParse(input.owner.recordTypeId);
  const recordId = recordIdSchema.safeParse(input.owner.recordId);
  const fieldId = fieldIdSchema.safeParse(input.owner.fieldId);
  if (
    !organizationId.success ||
    !applicationRootId.success ||
    !recordTypeId.success ||
    !recordId.success ||
    !fieldId.success ||
    !Number.isSafeInteger(input.maximumFiles) ||
    input.maximumFiles < 1
  )
    return { kind: "refused", reason: "owner_tuple_invalid" };

  if (!isRecord(input.subjectValues) || !Object.hasOwn(input.subjectValues, fieldId.data))
    return { kind: "refused", reason: "field_value_absent" };
  // A readable attachment field that was never set is stored as null: it holds no files.
  if (input.subjectValues[fieldId.data] === null) return { kind: "empty" };
  const attachmentIds = attachmentValueSchema.safeParse(input.subjectValues[fieldId.data]);
  if (!attachmentIds.success) return { kind: "refused", reason: "field_value_invalid" };
  const maximumFiles = Math.min(100, input.maximumFiles);
  if (attachmentIds.data.length > maximumFiles)
    return { kind: "refused", reason: "file_count_exceeds_maximum" };
  if (attachmentIds.data.length === 0) return { kind: "empty" };

  const seen = new Set<string>();
  const files: Array<AttachmentListPayload["files"][number]> = [];
  try {
    for (const candidate of attachmentIds.data) {
      const parsedId = fileIdSchema.safeParse(candidate);
      if (!parsedId.success || seen.has(parsedId.data.toLowerCase()))
        return { kind: "refused", reason: "file_id_invalid_or_duplicate" };
      seen.add(parsedId.data.toLowerCase());
      const evidence = await input.readFile(parsedId.data);
      if (evidence.kind === "unavailable") return { kind: "unavailable" };
      if (evidence.kind !== "read" || evidence.decision.outcome !== "allowed")
        return { kind: "refused", reason: "file_read_refused" };
      const decision = evidence.decision;
      const metadata = evidence.metadata;
      if (
        !sameId(decision.organizationId, organizationId.data) ||
        !sameId(decision.applicationRootId, applicationRootId.data) ||
        !sameId(decision.recordTypeId, recordTypeId.data) ||
        !sameId(decision.recordId, recordId.data) ||
        !sameId(decision.fieldId, fieldId.data) ||
        !sameId(metadata.fileId, parsedId.data) ||
        !sameId(metadata.organizationId, organizationId.data) ||
        metadata.applicationRootId === undefined ||
        !sameId(metadata.applicationRootId, applicationRootId.data) ||
        metadata.ownerRecordTypeId === undefined ||
        !sameId(metadata.ownerRecordTypeId, recordTypeId.data) ||
        metadata.ownerRecordId === undefined ||
        !sameId(metadata.ownerRecordId, recordId.data) ||
        metadata.ownerFieldId === undefined ||
        !sameId(metadata.ownerFieldId, fieldId.data) ||
        metadata.lifecycleState !== "active" ||
        metadata.scannerResult !== "clean"
      )
        return { kind: "refused", reason: "file_evidence_mismatch" };
      files.push({
        displayName: metadata.originalSafeDisplayName,
        mediaType: metadata.detectedMediaType,
        sizeBytes: metadata.sizeBytes,
        downloadHref: `/api/files/${organizationId.data}/${parsedId.data}`,
      });
    }
  } catch {
    return { kind: "unavailable" };
  }

  const payload = attachmentListPayloadSchema.safeParse({ kind: "attachment_list", files });
  if (!payload.success) return { kind: "refused", reason: "payload_invalid" };
  return { kind: "ready", values: payload.data };
};
