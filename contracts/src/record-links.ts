import { z } from "zod";
import { jsonValueSchema } from "./common";
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
export type ViewerSafeRecordLinkTitle = z.infer<typeof viewerSafeRecordLinkTitleSchema>;
export type ViewerSafeRecordLinkDetailAddress = z.infer<
  typeof viewerSafeRecordLinkDetailAddressSchema
>;
export type ViewerSafeRecordLinkResult = z.infer<typeof viewerSafeRecordLinkResultSchema>;
