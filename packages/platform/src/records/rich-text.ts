import { z } from "zod";
import { safeHttpsUrlSchema } from "../catalogue/common";

export const richTextElementKindSchema = z.enum([
  "paragraph",
  "heading",
  "bulleted_list",
  "numbered_list",
  "emphasis",
  "link",
]);

/** Deepest inline nesting a paragraph, heading or list item may use; top-level inlines are level 1. */
const richTextInlineMaximumDepth = 8;

export type RichTextInline =
  | { kind: "text"; text: string }
  | { kind: "emphasis"; style: "strong" | "emphasis" | "code"; children: RichTextInline[] }
  | { kind: "link"; address: string; children: RichTextInline[] };

const tooDeepInlineChildrenSchema = z.custom<RichTextInline[]>(() => false, {
  error: `Rich-text inline nesting cannot exceed ${richTextInlineMaximumDepth} levels`,
});

const inlineSchemas = new Map<string, z.ZodType<RichTextInline>>();

/**
 * One schema per nesting level, so parsing never recurses past the bound however deep the
 * input is, and a link's descendants refuse another link.
 */
const inlineSchemaAt = (depth: number, insideLink: boolean): z.ZodType<RichTextInline> => {
  const key = `${depth}:${insideLink}`;
  const cached = inlineSchemas.get(key);
  if (cached !== undefined) return cached;
  const children = (childrenInsideLink: boolean): z.ZodType<RichTextInline[]> =>
    depth >= richTextInlineMaximumDepth
      ? tooDeepInlineChildrenSchema
      : z.array(inlineSchemaAt(depth + 1, childrenInsideLink)).min(1);
  const link = z
    .object({ kind: z.literal("link"), address: safeHttpsUrlSchema, children: children(true) })
    .strict();
  const schema: z.ZodType<RichTextInline> = z.discriminatedUnion("kind", [
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
          context.addIssue({
            code: "custom",
            message: "A link cannot be placed inside another link",
          });
        })
      : link,
  ]);
  inlineSchemas.set(key, schema);
  return schema;
};

export const richTextInlineSchema: z.ZodType<RichTextInline> = inlineSchemaAt(1, false);

export const richTextBlockSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("paragraph"), children: z.array(richTextInlineSchema).min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("heading"),
      level: z.enum(["2", "3", "4"]),
      children: z.array(richTextInlineSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["bulleted_list", "numbered_list"]),
      items: z.array(z.array(richTextInlineSchema).min(1)).min(1),
    })
    .strict(),
]);

export const richTextDocumentSchema = z.object({ blocks: z.array(richTextBlockSchema) }).strict();
