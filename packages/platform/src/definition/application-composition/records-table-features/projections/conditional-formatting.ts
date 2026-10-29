import { z } from "zod";
import { projectionFieldKeySchema as fieldKeySchema } from "./field-key";
import {
  conditionalFormatIcons,
  conditionalFormatTokens,
  recordsTableConditionalFormattingFeature,
} from "../conditional-formatting";

const textSchema = z.string().min(1);
/** The styles a rule names: a closed style of semantic tokens, never a colour or markup. */
const conditionalFormatStyleSchema = z
  .object({
    token: z.enum(conditionalFormatTokens),
    tint: z.boolean(),
    text: z.boolean(),
    bold: z.boolean(),
    strike: z.boolean(),
    icon: z.enum(conditionalFormatIcons).optional(),
    badgeLabel: textSchema.optional(),
  })
  .strict()
  .readonly();

/**
 * How one numeric column is drawn for this read: a data bar of one token, or a three-point colour
 * scale. Its measures (`RecordsTableRowFormat.measures`) are fractions of the page's own range.
 */
const columnFormatSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("data_bar"), token: z.enum(conditionalFormatTokens) })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("colour_scale"),
      tokens: z
        .tuple([
          z.enum(conditionalFormatTokens),
          z.enum(conditionalFormatTokens),
          z.enum(conditionalFormatTokens),
        ])
        .readonly(),
    })
    .strict()
    .readonly(),
]);

/** The styles of a board's cards, or of a table's rows, keyed by rule identity. */
export const conditionalFormatStylesSchema = z
  .record(z.string(), conditionalFormatStyleSchema)
  .readonly();

/**
 * The formatting one viewer sees on one read: the styles of the rules that matched a row of the
 * page (keyed by rule identity, the style key the rows carry) and the numeric columns drawn as bars
 * or scales. Nothing else of a rule travels: never its condition, never a value it read.
 */
const conditionalFormattingProjectionSchema = z
  .object({
    styles: conditionalFormatStylesSchema,
    columns: z.record(fieldKeySchema, columnFormatSchema).readonly(),
  })
  .strict()
  .readonly();
export type ConditionalFormattingProjection = z.output<
  typeof conditionalFormattingProjectionSchema
>;
export type ConditionalColumnFormatProjection = z.output<typeof columnFormatSchema>;

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const conditionalFormattingProjection = {
  property: recordsTableConditionalFormattingFeature.property,
  schema: conditionalFormattingProjectionSchema,
} as const;
