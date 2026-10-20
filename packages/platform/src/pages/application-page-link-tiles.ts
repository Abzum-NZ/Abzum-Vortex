import { z } from "zod";
import { applicationPageLinkTargetSchema } from "./application-page-links";
import { recordIdSchema, revisionSchema } from "../catalogue/identifiers";
import { projectedRecordPinTargetSchema } from "../records/record-links";

const openBehaviour = z.enum(["replace", "new_page"]);

/** One typed target per tile, discriminated by kind; application and page evidence never manufactures Record identity. */
export const projectedLinkTileTargetSchema = z.union([
  projectedRecordPinTargetSchema,
  applicationPageLinkTargetSchema.options[0].extend({ openBehaviour }).strict(),
  applicationPageLinkTargetSchema.options[1].extend({ openBehaviour }).strict(),
]);

/** A neutral target retains only its protected source row's removal identity. */
export const projectedLinkTilesSchema = z
  .object({
    kind: z.literal("link_tiles"),
    rows: z
      .array(
        z
          .object({
            sourceRecordId: recordIdSchema,
            sourceRevision: revisionSchema,
            target: projectedLinkTileTargetSchema,
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.rows.map((row) => row.sourceRecordId.toLowerCase())).size !== value.rows.length
    )
      context.addIssue({ code: "custom", message: "Each source tile must occur once" });
  });

export type ProjectedLinkTileTarget = z.infer<typeof projectedLinkTileTargetSchema>;
export type ProjectedLinkTiles = z.infer<typeof projectedLinkTilesSchema>;
