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

/** Deepest inline nesting a paragraph, heading or list item may use; top-level inlines are level 1. */
export const richTextInlineMaximumDepth = 8;

export type RichTextInlineV2 =
  | { kind: "text"; text: string }
  | { kind: "emphasis"; style: "strong" | "emphasis" | "code"; children: RichTextInlineV2[] }
  | { kind: "link"; address: string; children: RichTextInlineV2[] };

const tooDeepInlineChildrenSchema = z.custom<RichTextInlineV2[]>(() => false, {
  error: `Rich-text inline nesting cannot exceed ${richTextInlineMaximumDepth} levels`,
});

const inlineSchemas = new Map<string, z.ZodType<RichTextInlineV2>>();

/**
 * One schema per nesting level, so parsing never recurses past the bound however deep the
 * input is, and a link's descendants refuse another link.
 */
const inlineSchemaAt = (depth: number, insideLink: boolean): z.ZodType<RichTextInlineV2> => {
  const key = `${depth}:${insideLink}`;
  const cached = inlineSchemas.get(key);
  if (cached !== undefined) return cached;
  const children = (childrenInsideLink: boolean): z.ZodType<RichTextInlineV2[]> =>
    depth >= richTextInlineMaximumDepth
      ? tooDeepInlineChildrenSchema
      : z.array(inlineSchemaAt(depth + 1, childrenInsideLink)).min(1);
  const link = z
    .object({ kind: z.literal("link"), address: safeHttpsUrlSchema, children: children(true) })
    .strict();
  const schema: z.ZodType<RichTextInlineV2> = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string() }).strict(),
    z
      .object({
        kind: z.literal("emphasis"),
        style: z.enum(["strong", "emphasis", "code"]),
        children: children(insideLink),
      })
      .strict(),
    insideLink
      ? link.superRefine((_, context) => {
          context.addIssue({ code: "custom", message: "A link cannot be placed inside another link" });
        })
      : link,
  ]);
  inlineSchemas.set(key, schema);
  return schema;
};

export const richTextInlineV2Schema: z.ZodType<RichTextInlineV2> = inlineSchemaAt(1, false);

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
