import { z } from "zod";
import { applicationPageLinkTargetSchema } from "./application-page-links";
import { recordIdSchema, revisionSchema } from "./identifiers";
import { projectedRecordPinTargetSchema } from "./record-links";

const openBehaviour = z.enum(["replace", "new_page"]);

/** LinkTiles1.2 has distinct App/Page evidence; it never manufactures Record identity. */
export const applicationPageLinkTileTargetSchema = z.union([
  projectedRecordPinTargetSchema,
  applicationPageLinkTargetSchema.options[0].extend({ openBehaviour }).strict(),
  applicationPageLinkTargetSchema.options[1].extend({ openBehaviour }).strict(),
]);

/** A neutral target retains only its protected source row's removal identity. */
export const projectedApplicationPageLinkTilesSchema = z.object({
  kind: z.literal("application_page_link_tiles"),
  rows: z.array(z.object({
    sourceRecordId: recordIdSchema,
    sourceRevision: revisionSchema,
    target: applicationPageLinkTileTargetSchema,
  }).strict()).max(10_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.rows.map((row) => row.sourceRecordId.toLowerCase())).size !== value.rows.length)
    context.addIssue({ code: "custom", message: "Each source tile must occur once" });
});

export type ApplicationPageLinkTileTarget = z.infer<typeof applicationPageLinkTileTargetSchema>;
export type ProjectedApplicationPageLinkTiles = z.infer<typeof projectedApplicationPageLinkTilesSchema>;
