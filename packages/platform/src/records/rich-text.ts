import { z } from "zod";
import {
  isRichTextBlock,
  normalizeRecordRichTextBlock,
  type RichTextBlock,
} from "./rich-text-predicates";

export type { RichTextInline } from "./rich-text-predicates";

export const richTextElementKindSchema = z.enum([
  "paragraph",
  "heading",
  "bulleted_list",
  "numbered_list",
  "emphasis",
  "link",
]);

/** Both the page and server use the same bounded inline and block grammar. */
const richTextBlockSchema: z.ZodType<RichTextBlock> = z
  .custom<RichTextBlock>(isRichTextBlock, { error: "Use a valid rich-text block" })
  .transform((block) => normalizeRecordRichTextBlock(block) as RichTextBlock);

export const richTextDocumentSchema = z.object({ blocks: z.array(richTextBlockSchema) }).strict();
