import { z } from "zod";
import { richTextDocumentSchema } from "../records/rich-text";
import { displayScalarCellSchema } from "./display-payload-parts";

/** The ready values a plain-text block renders: one scalar display value. */
export const textPayloadSchema = z
  .object({ kind: z.literal("text"), value: displayScalarCellSchema })
  .strict()
  .readonly();
export type TextPayload = z.output<typeof textPayloadSchema>;

/** The ready values a structured rich-text block renders. */
export const richTextPayloadSchema = z
  .object({ kind: z.literal("rich_text"), document: richTextDocumentSchema })
  .strict()
  .readonly();
export type RichTextPayload = z.output<typeof richTextPayloadSchema>;
