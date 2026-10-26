import { z } from "zod";
import { builderKeySchema } from "../catalogue/identifiers";
import { displayRowsSchema } from "./display-payload-rows";

/**
 * The ready rows a launcher block renders: one row per application the viewer may open, with the
 * cell key of its heading and, when shown, of its secondary line.
 */
export const launcherRowsPayloadSchema = z
  .object({
    kind: z.literal("launcher_rows"),
    rows: displayRowsSchema,
    headingKey: builderKeySchema,
    secondaryKey: builderKeySchema.exactOptional(),
  })
  .strict()
  .readonly();
export type LauncherRowsPayload = z.output<typeof launcherRowsPayloadSchema>;
