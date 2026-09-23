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

/** Maximum inline nesting depth allowed in rich text documents. */
export const richTextInlineMaximumDepth = 8;
export const richTextInlineMaximumNestingDepth = richTextInlineMaximumDepth;

export type RichTextInlineV2 =
  | { kind: "text"; text: string }
  | { kind: "emphasis"; style: "strong" | "emphasis" | "code"; children: RichTextInlineV2[] }
  | { kind: "link"; address: string; children: RichTextInlineV2[] };

const inspectInline = (
  inline: RichTextInlineV2,
  depth: number,
  insideLink: boolean,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void => {
  if (depth > richTextInlineMaximumDepth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Rich-text inline nesting depth cannot exceed ${richTextInlineMaximumDepth} levels`,
      path,
    });
    return;
  }
  if (inline.kind === "link") {
    if (insideLink) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A link cannot be placed inside another link",
        path,
      });
      return;
    }
  }
  if (inline.kind === "emphasis" || inline.kind === "link") {
    const nextInsideLink = insideLink || inline.kind === "link";
    for (const [index, child] of inline.children.entries()) {
      inspectInline(child, depth + 1, nextInsideLink, ctx, [...path, "children", index]);
    }
  }
};

const baseRichTextInlineV2Schema: z.ZodType<RichTextInlineV2> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string() }).strict(),
    z
      .object({
        kind: z.literal("emphasis"),
        style: z.enum(["strong", "emphasis", "code"]),
        children: z.array(baseRichTextInlineV2Schema).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("link"),
        address: safeHttpsUrlSchema,
        children: z.array(baseRichTextInlineV2Schema).min(1),
      })
      .strict(),
  ]),
);

export const richTextInlineV2Schema: z.ZodType<RichTextInlineV2> = baseRichTextInlineV2Schema.superRefine(
  (inline, ctx) => {
    inspectInline(inline, 1, false, ctx, []);
  },
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
