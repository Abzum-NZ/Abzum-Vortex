import { z } from "zod";
import { projectionFieldKeySchema as fieldKeySchema } from "./field-key";
import { recordsTableFilterKinds, recordsTableColumnFiltersFeature } from "../column-filters";

const textSchema = z.string().min(1);
/**
 * What the viewer's grid knows of one filterable field: its canonical type, the filter kind that
 * type takes and what the control needs (a choice field's options, a fixed money currency, and for
 * a date-and-time field the organisation time zone its days are taken in).
 */
const recordsTableFilterFieldSchema = z
  .object({
    fieldId: fieldKeySchema,
    label: textSchema,
    /** The canonical field type, for example `choice` or `date_time`. */
    type: textSchema,
    kind: z.enum(recordsTableFilterKinds),
    options: z
      .array(z.object({ value: textSchema, label: textSchema }).strict().readonly())
      .readonly()
      .optional(),
    currency: textSchema.optional(),
    timeZone: textSchema.optional(),
  })
  .strict()
  .readonly()
  .refine((field) => (field.kind === "choice") === (field.options !== undefined), {
    message: "A choice filter field carries its options, and no other field does",
  });
export type RecordsTableFilterField = z.output<typeof recordsTableFilterFieldSchema>;

/** The filter fields a table or a board offers: at least one, each named once. */
export const recordsTableFilterFieldsSchema = z
  .array(recordsTableFilterFieldSchema)
  .min(1)
  .refine(
    (fields) => new Set(fields.map((field) => field.fieldId.toLowerCase())).size === fields.length,
    "Each filter field is named once",
  )
  .readonly();

const columnFiltersProjectionSchema = recordsTableFilterFieldsSchema;

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const columnFiltersProjection = {
  property: recordsTableColumnFiltersFeature.property,
  schema: columnFiltersProjectionSchema,
} as const;
