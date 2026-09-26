import { z } from "zod";
import { searchPrioritySchema } from "./catalogues";
import {
  applicationRootIdSchema,
  clusterIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  grantIdSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
} from "./identifiers";
import { federatedRefusalCodeSchema } from "./integration-contracts";

/**
 * Request-only Shared result groups (#646).
 *
 * Application search may add one Shared result group for each active sharing
 * grant the recipient knows from its non-content grant mirrors, and never more
 * than one group for the same grant. The source
 * executes that search itself and returns its own approved projection of the
 * records it chose; the recipient merges those projections into the current
 * response only. A group is therefore the complete unit of shared searchability:
 * it names exactly one grant, one source cluster, one source organisation, one
 * Module revision and one record type, and it carries no persisted state, so a
 * group can never become a recipient search document, a cache entry, a
 * recipient-owned record or a copy of a source record. Remote execution of the
 * source search is #739 and the signed gateway is #738; this contract only
 * describes what one source response may contribute to one response.
 */

/**
 * Bounded size of one Shared result group. The recipient asks each source for a
 * page within these bounds, so one response can never grow with the source's
 * record set.
 */
export const sharedResultGroupLimits = Object.freeze({
  /** A grant's readable field projection is bounded at 500 by its own contract. */
  fieldProjection: 500,
  records: 200,
  entriesPerRecord: 100,
  entryTextLength: 4_000,
});

/**
 * One source-owned field the source approved for shared search in this group,
 * with the published search priority the source searched it under. A field the
 * source did not list is not searchable here, so a secret, hidden,
 * non-searchable or otherwise unshared value cannot enter a group at all: a
 * schema is never treated as an indexer.
 */
export const sharedResultFieldProjectionSchema = z
  .object({ fieldId: fieldIdSchema, searchPriority: searchPrioritySchema })
  .strict();

/** The source's own search words for one approved field of one source record. */
export const sharedResultEntrySchema = z
  .object({
    fieldId: fieldIdSchema,
    text: z.string().min(1).max(sharedResultGroupLimits.entryTextLength),
  })
  .strict();

/**
 * One source-owned record reference with its approved search words. The source
 * identities repeat the group's own identities, so a record reference can never
 * be moved between groups, sources or grants.
 */
export const sharedResultRecordSchema = z
  .object({
    sourceClusterId: clusterIdSchema,
    sourceOrganizationId: organizationIdSchema,
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
    concurrencyNumber: revisionSchema,
    entries: z.array(sharedResultEntrySchema).min(1).max(sharedResultGroupLimits.entriesPerRecord),
  })
  .strict();

/**
 * The one grant, source and definition revision a group belongs to. Every
 * variant carries it, so a group is never attributable to a second grant.
 */
const sharedResultGroupIdentity = {
  grantId: grantIdSchema,
  /** The source grant's own contract fingerprint; the recipient binds its mirror to it. */
  contractFingerprint: fingerprintSchema,
  sourceClusterId: clusterIdSchema,
  sourceOrganizationId: organizationIdSchema,
  moduleRootId: moduleRootIdSchema,
  recordTypeId: recordTypeIdSchema,
  publishedModuleRevision: revisionSchema,
};

const uniqueFieldIds = (
  fieldIds: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void => {
  const canonical = fieldIds.map((fieldId) => fieldId.toLowerCase());
  if (new Set(canonical).size !== canonical.length)
    context.addIssue({
      code: "custom",
      path,
      message: "Field identities must be unique",
    });
};

/**
 * The source executed the search and returned its approved projection. The
 * group is complete on its own: it carries no continuation token, no count and
 * no stored state, and an available group with no records is a real empty
 * answer rather than a failure.
 */
const availableSharedResultGroupSchema = z
  .object({
    ...sharedResultGroupIdentity,
    state: z.literal("available"),
    fieldProjection: z
      .array(sharedResultFieldProjectionSchema)
      .min(1)
      .max(sharedResultGroupLimits.fieldProjection),
    records: z.array(sharedResultRecordSchema).max(sharedResultGroupLimits.records),
  })
  .strict();

/**
 * The source could not answer this time. The group carries no records, so an
 * unavailable source produces an unavailable source group instead of a failed
 * local search, a stale result or a guessed count.
 */
const unavailableSharedResultGroupSchema = z
  .object({
    ...sharedResultGroupIdentity,
    state: z.literal("unavailable"),
    safeErrorCode: z.literal("source_unavailable"),
  })
  .strict();
const retryableSharedResultGroupSchema = z
  .object({
    ...sharedResultGroupIdentity,
    state: z.literal("retryable"),
    safeErrorCode: z.literal("retry_later"),
  })
  .strict();

/** The source refused this grant. The closed federation code carries no record fact. */
const refusedSharedResultGroupSchema = z
  .object({
    ...sharedResultGroupIdentity,
    state: z.literal("refused"),
    safeErrorCode: federatedRefusalCodeSchema,
  })
  .strict();

/**
 * A group is internally exact: every record keeps its own group's source,
 * record type and grant, one source record appears once, and search words exist
 * only for a field the source itself approved as searchable for this response.
 * A value the source withheld therefore cannot arrive in a group at all, which
 * is what keeps a secret, hidden or non-searchable field out of a recipient
 * response and out of any recipient index.
 */
export const sharedResultGroupSchema = z
  .discriminatedUnion("state", [
    availableSharedResultGroupSchema,
    unavailableSharedResultGroupSchema,
    retryableSharedResultGroupSchema,
    refusedSharedResultGroupSchema,
  ])
  .superRefine((group, context) => {
    if (group.state !== "available") return;
    uniqueFieldIds(
      group.fieldProjection.map((field) => field.fieldId),
      context,
      ["fieldProjection"],
    );
    const projected = new Set(group.fieldProjection.map((field) => field.fieldId.toLowerCase()));
    const seenRecords = new Set<string>();
    for (const [index, record] of group.records.entries()) {
      if (
        record.sourceClusterId !== group.sourceClusterId ||
        record.sourceOrganizationId !== group.sourceOrganizationId ||
        record.recordTypeId !== group.recordTypeId
      )
        context.addIssue({
          code: "custom",
          path: ["records", index],
          message: "A record reference must keep the source and record type of its group",
        });
      const recordKey = record.recordId.toLowerCase();
      if (seenRecords.has(recordKey))
        context.addIssue({
          code: "custom",
          path: ["records", index, "recordId"],
          message: "A source record appears once per group",
        });
      seenRecords.add(recordKey);
      uniqueFieldIds(
        record.entries.map((entry) => entry.fieldId),
        context,
        ["records", index, "entries"],
      );
      for (const [entryIndex, entry] of record.entries.entries())
        if (!projected.has(entry.fieldId.toLowerCase()))
          context.addIssue({
            code: "custom",
            path: ["records", index, "entries", entryIndex, "fieldId"],
            message: "Search words are accepted only for a field the source approved",
          });
    }
  });

/**
 * The recipient's current capability for one grant, read by the recipient's own
 * adapter at decision time rather than carried by the request: the current state
 * of its own non-content grant mirror, the one complete grant identity that
 * mirror holds, and the definition scope and readable field projection of the
 * recipient's own federated search query under that grant. Only an `active`
 * mirror whose grant identity, fingerprint, source and definition scope all
 * match the group may be searched, so a pending, suspended, revoked or expired
 * grant, a second grant, another record type or Module revision, or another
 * recipient application cannot contribute scope or fields to the same result.
 */
export const sharedRecipientCapabilitySchema = z
  .object({
    recipientOrganizationId: organizationIdSchema,
    recipientApplicationRootId: applicationRootIdSchema,
    grantId: grantIdSchema,
    contractFingerprint: fingerprintSchema,
    sourceClusterId: clusterIdSchema,
    sourceOrganizationId: organizationIdSchema,
    moduleRootId: moduleRootIdSchema,
    recordTypeId: recordTypeIdSchema,
    publishedModuleRevision: revisionSchema,
    // A grant's readable fields name one record type's fields, bounded at 500 by the grant.
    readableFieldIds: z.array(fieldIdSchema).min(1).max(500),
    /** Exactly the states a recipient grant mirror can hold. */
    state: z.enum(["pending", "active", "suspended", "revoked", "expired"]),
  })
  .strict()
  .superRefine((capability, context) => {
    uniqueFieldIds(capability.readableFieldIds, context, ["readableFieldIds"]);
  });

/** The closed federation refusal code one source may return for one group. */
export type SharedResultSourceRefusalCode = z.infer<typeof federatedRefusalCodeSchema>;

export type SharedResultFieldProjection = z.infer<typeof sharedResultFieldProjectionSchema>;
export type SharedResultEntry = z.infer<typeof sharedResultEntrySchema>;
export type SharedResultRecord = z.infer<typeof sharedResultRecordSchema>;
export type SharedResultGroup = z.infer<typeof sharedResultGroupSchema>;
export type SharedRecipientCapability = z.infer<typeof sharedRecipientCapabilitySchema>;
