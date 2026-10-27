import { z } from "zod";
import { projectionFieldKeySchema as fieldKeySchema } from "./field-key";

const textSchema = z.string().min(1);
const wholeSchema = z.number().int();
const editorBase = { required: z.boolean() };

/**
 * How one cell edits one field, from the installed field definition alone: the control to draw and
 * the limits that stop obviously wrong input. It grants nothing; the protected writer validates
 * every value again. `required` says the field cannot be emptied.
 */
const recordsTableInlineEditorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      ...editorBase,
      /** Which text control: a line, several lines, or an email, phone or web address. */
      input: z.enum(["text", "long_text", "email", "phone", "web"]),
      maxLength: wholeSchema.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("whole_number"),
      ...editorBase,
      minimum: wholeSchema.optional(),
      maximum: wholeSchema.optional(),
      step: wholeSchema.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("decimal"),
      ...editorBase,
      digitsBeforeDecimal: wholeSchema,
      decimalPlaces: wholeSchema,
      minimum: textSchema.optional(),
      maximum: textSchema.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("yes_no"), ...editorBase })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("choice"),
      ...editorBase,
      options: z
        .array(
          z
            .object({
              value: textSchema,
              label: textSchema,
              parentValues: z.array(textSchema).readonly().optional(),
            })
            .strict()
            .readonly(),
        )
        .min(1)
        .readonly(),
      /**
       * The choice field of the same record type whose chosen option narrows this field's
       * options, as the table's field identity (lower case): only options listing that parent
       * option are offered, and changing the parent must clear or flag this field.
       */
      dependsOnField: fieldKeySchema.optional(),
    })
    .strict()
    .readonly()
    // A dependent choice carries which parent options each option belongs to, and only it does.
    .refine(
      (editor) =>
        (editor.dependsOnField === undefined) ===
        editor.options.every((option) => option.parentValues === undefined),
      { message: "A dependent choice names its parent options, and no other choice does" },
    ),
  z
    .object({
      kind: z.literal("date"),
      ...editorBase,
      earliest: textSchema.optional(),
      latest: textSchema.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("date_time"), ...editorBase })
    .strict()
    .readonly(),
  z
    .object({
      /** A single-target link: the person picks one record of the installed target type. */
      kind: z.literal("link"),
      ...editorBase,
      recordTypeId: fieldKeySchema,
      targetLabel: textSchema,
      /**
       * The link field of the same record type whose chosen record narrows this field's choices,
       * as the table's field identity (lower case). The picker offers this field's records only
       * for that parent, and changing the parent must clear or flag this field.
       */
      dependsOnField: fieldKeySchema.optional(),
    })
    .strict()
    .readonly(),
]);
export type RecordsTableInlineEditor = z.output<typeof recordsTableInlineEditorSchema>;

/** One field a viewer may edit in a cell, as the field identity the table's columns use. */
const inlineEditFieldSchema = z
  .object({ field: fieldKeySchema, editor: recordsTableInlineEditorSchema })
  .strict()
  .readonly();
export type RecordsTableInlineEditField = z.output<typeof inlineEditFieldSchema>;

export const inlineEditFieldsSchema = z
  .array(inlineEditFieldSchema)
  .min(1)
  .refine(
    (fields) => new Set(fields.map((field) => field.field.toLowerCase())).size === fields.length,
    "Each editable field is named once",
  )
  .readonly();

export const inlineEditProjectionSchema = z
  .object({ eventId: textSchema, fields: inlineEditFieldsSchema })
  .strict()
  .readonly();
