import { z } from "zod";
import { jsonValueSchema } from "./common";
import { sourceQualifiedRecordTypeSchema } from "./definition-source-common";
import {
  applicationRootIdSchema,
  builderKeySchema,
  fieldIdSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  pageIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
} from "./identifiers";

/** The exact installed record identity a viewer-safe link read selects. */
export const viewerSafeRecordLinkIdentitySchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    moduleRootId: moduleRootIdSchema,
    moduleReleaseRevision: revisionSchema,
    recordTypeId: recordTypeIdSchema,
    storageContractId: storageContractIdSchema,
    recordId: recordIdSchema,
  })
  .strict();

/** Candidate keys select a current permitted target; they never supply its installed identity. */
export const viewerSafeRecordPinSelectorSchema = z
  .object({
    applicationKey: namespacedKeySchema,
    recordTypeKey: sourceQualifiedRecordTypeSchema,
    recordId: recordIdSchema,
  })
  .strict();

/** Acquisition returns only the exact identity, without the protected record's display values. */
export const viewerSafeRecordPinAcquisitionResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), identity: viewerSafeRecordLinkIdentitySchema }).strict(),
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);

/** A configured title value suitable for a compact record link. */
export const viewerSafeRecordLinkTitleSchema = jsonValueSchema.refine(
  (value) => value !== null && (typeof value !== "string" || value.trim().length > 0),
  { message: "A record link title must have a readable value" },
);

/** Route identity for one configured detail page in the currently installed target Application. */
export const viewerSafeRecordLinkDetailAddressSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    applicationKey: namespacedKeySchema,
    pageId: pageIdSchema,
    pageKey: builderKeySchema,
    recordId: recordIdSchema,
  })
  .strict();

/** One current viewer-safe record link, or one neutral result for every unavailable cause. */
export const viewerSafeRecordLinkResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      title: viewerSafeRecordLinkTitleSchema,
      detailAddress: viewerSafeRecordLinkDetailAddressSchema,
    })
    .strict(),
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);

export type ViewerSafeRecordLinkIdentity = z.infer<typeof viewerSafeRecordLinkIdentitySchema>;
export type ViewerSafeRecordPinSelector = z.infer<typeof viewerSafeRecordPinSelectorSchema>;
export type ViewerSafeRecordPinAcquisitionResult = z.infer<
  typeof viewerSafeRecordPinAcquisitionResultSchema
>;
export type ViewerSafeRecordLinkTitle = z.infer<typeof viewerSafeRecordLinkTitleSchema>;
export type ViewerSafeRecordLinkDetailAddress = z.infer<
  typeof viewerSafeRecordLinkDetailAddressSchema
>;
export type ViewerSafeRecordLinkResult = z.infer<typeof viewerSafeRecordLinkResultSchema>;
