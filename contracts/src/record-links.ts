import { z } from "zod";
import { jsonValueSchema, safeHttpsUrlSchema } from "./common";
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

/** Content-free membership of one protected target, separate from its source tile revision. */
export const mountedRecordPinAssociationSchema = z.object({
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
  applicationKey: namespacedKeySchema,
  recordTypeId: recordTypeIdSchema,
  recordId: recordIdSchema,
}).strict();

/** Only a successful current read can supply a record destination or display value. */
export const projectedRecordPinTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("record"),
    title: viewerSafeRecordLinkTitleSchema,
    detailAddress: viewerSafeRecordLinkDetailAddressSchema,
    association: mountedRecordPinAssociationSchema,
    openBehaviour: z.enum(["replace", "new_page"]),
  }).strict().superRefine((value, context) => {
    if (value.association.applicationRootId.toLowerCase() !== value.detailAddress.applicationRootId.toLowerCase() ||
        value.association.applicationKey !== value.detailAddress.applicationKey ||
        value.association.recordId.toLowerCase() !== value.detailAddress.recordId.toLowerCase())
      context.addIssue({ code: "custom", message: "The target association must match its detail address" });
  }),
  z.object({
    kind: z.literal("external"),
    label: z.string(),
    address: safeHttpsUrlSchema,
    description: z.string().optional(),
    openBehaviour: z.enum(["replace", "new_page"]),
  }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);

/** Closed LinkTiles1.1 projection; neutral rows contain only source removal identity. */
export const projectedRecordPinTilesSchema = z.object({
  kind: z.literal("record_pin_tiles"),
  rows: z.array(z.object({
    sourceRecordId: recordIdSchema,
    sourceRevision: revisionSchema,
    target: projectedRecordPinTargetSchema,
  }).strict()).max(10_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.rows.map((row) => row.sourceRecordId.toLowerCase())).size !== value.rows.length)
    context.addIssue({ code: "custom", message: "Each source tile must occur once" });
});

export type MountedRecordPinAssociation = z.infer<typeof mountedRecordPinAssociationSchema>;
export type ProjectedRecordPinTarget = z.infer<typeof projectedRecordPinTargetSchema>;
export type ProjectedRecordPinTiles = z.infer<typeof projectedRecordPinTilesSchema>;

/** A mounted element returns membership only while its current row is actually visible. */
export const mountedRecordPinElementProperty = "vortexRecordPinAssociation" as const;
export const mountedRecordPinFrameSchema = z.object({
  pageId: pageIdSchema,
  installationRevision: revisionSchema,
  releaseKey: z.string().min(1).max(512),
}).strict();
export type MountedRecordPinFrame = z.infer<typeof mountedRecordPinFrameSchema>;
export type MountedRecordPinMembership = MountedRecordPinAssociation & Readonly<{
  placementId: string;
  sourceRecordId: string;
  sourceRevision: number;
  frame: MountedRecordPinFrame;
}>;
