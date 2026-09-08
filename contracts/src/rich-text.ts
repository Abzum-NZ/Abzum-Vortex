import { z } from "zod";
import { safeHttpsUrlSchema } from "./common";

export const richTextElementKindV2Schema = z.enum([
  "paragraph",
  "heading",
  "bulleted_list",
  "numbered_list",
  "emphasis",
  "link",
]);

export type RichTextInlineV2 =
  | { kind: "text"; text: string }
  | { kind: "emphasis"; style: "strong" | "emphasis" | "code"; children: RichTextInlineV2[] }
  | { kind: "link"; address: string; children: RichTextInlineV2[] };

export const richTextInlineV2Schema: z.ZodType<RichTextInlineV2> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string() }).strict(),
    z
      .object({
        kind: z.literal("emphasis"),
        style: z.enum(["strong", "emphasis", "code"]),
        children: z.array(richTextInlineV2Schema).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("link"),
        address: safeHttpsUrlSchema,
        children: z.array(richTextInlineV2Schema).min(1),
      })
      .strict(),
  ]),
);

export const richTextBlockV2Schema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("paragraph"), children: z.array(richTextInlineV2Schema).min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("heading"),
      level: z.enum(["2", "3", "4"]),
      children: z.array(richTextInlineV2Schema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["bulleted_list", "numbered_list"]),
      items: z.array(z.array(richTextInlineV2Schema).min(1)).min(1),
    })
    .strict(),
]);

export const richTextDocumentV2Schema = z
  .object({ blocks: z.array(richTextBlockV2Schema) })
  .strict();
