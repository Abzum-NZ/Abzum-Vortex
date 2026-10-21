import { z } from "zod";
import { builderKeySchema, fieldIdSchema } from "../catalogue/identifiers";
import {
  RECORDS_TABLE_EXPORT_MAXIMUM_ROWS,
  RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS,
  conditionalFormatIcons,
  conditionalFormatTokens,
  recordsTableActionCapabilities,
  recordsTableBulkActionRecordLimit,
  recordsTableExportFormats,
  recordsTableFilterKinds,
  recordsTableRowActionIcons,
  recordsTableStatusBarOperations,
} from "../definition/application-composition/records-table-features";
import { namedActionAvailabilitySchema } from "./named-action-availability-schema";

/**
 * The one description of what the server projects to a Records table for one viewer: each feature
 * the viewer may use, narrowed to what they may do now. The server builds a value of this shape and
 * the browser parses the payload with this schema, so what is sent and what is accepted cannot
 * drift apart. A feature that is off for the viewer is absent.
 */

/** A field key as the table's columns spell it: an authored key or a field identity. */
const fieldKeySchema = z
  .string()
  .refine(
    (value) => builderKeySchema.safeParse(value).success || fieldIdSchema.safeParse(value).success,
    "A field is named by its key or identity",
  );

const textSchema = z.string().min(1);
const wholeSchema = z.number().int();
const positiveSchema = z.number().int().min(1);

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

const inlineEditFieldsSchema = z
  .array(inlineEditFieldSchema)
  .min(1)
  .refine(
    (fields) => new Set(fields.map((field) => field.field.toLowerCase())).size === fields.length,
    "Each editable field is named once",
  )
  .readonly();

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

const onlyTrue = z.literal(true);

const spreadsheetSchema = z
  .object({
    rangeSelect: z.boolean(),
    find: z.boolean(),
    /** Paste, fill down and undo of batches; each is present only when usable now. */
    paste: onlyTrue.optional(),
    fill: onlyTrue.optional(),
    undo: onlyTrue.optional(),
    /**
     * The status bar of a selected range: the configured fields (every one is shown, a field the
     * viewer cannot read as "Not available") and the totals. Absent while the status bar is off.
     */
    statusBar: z
      .object({
        fields: z
          .array(fieldKeySchema)
          .min(1)
          .max(RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS)
          .readonly(),
        operations: z.array(z.enum(recordsTableStatusBarOperations)).min(1).readonly(),
      })
      .strict()
      .readonly()
      .refine(
        (bar) =>
          new Set(bar.fields).size === bar.fields.length &&
          new Set(bar.operations).size === bar.operations.length,
        "The status bar names each field and total once",
      )
      .optional(),
  })
  .strict()
  .readonly()
  .refine((controls) => controls.rangeSelect || controls.find, {
    message: "Spreadsheet controls need an enabled control",
  })
  .refine(
    (controls) =>
      !(controls.undo === true && controls.paste !== true && controls.fill !== true) &&
      !((controls.paste === true || controls.fill === true) && !controls.rangeSelect),
    { message: "Paste, fill and undo need a range and an edit" },
  )
  .refine((controls) => controls.statusBar === undefined || controls.rangeSelect, {
    message: "The status bar needs a range",
  });

const bulkActionSchema = z
  .object({
    action: textSchema,
    label: textSchema,
    confirm: z.boolean(),
    maxRecords: z.number().int().min(1).max(recordsTableBulkActionRecordLimit),
  })
  .strict()
  .readonly();

const rowActionSchema = z
  .object({
    eventId: textSchema,
    label: textSchema,
    icon: z.enum(recordsTableRowActionIcons),
    placement: z.enum(["inline", "menu"]),
    capability: z.enum(recordsTableActionCapabilities).optional(),
  })
  .strict()
  .readonly();

/**
 * The grid features one viewer may use on one Records table read: each feature the release turns
 * on (publication already refused any that does not fit the bound query), narrowed to what the
 * viewer may do now. It is computed once per read, from the field bound and the per-row
 * capabilities the Query engine decided in that same read under the viewer's current access and
 * field policy, and travels in the table payload; there is no separate request and nothing is
 * cached. The same projection both draws the controls and decides whether the read's own search
 * and filters were allowed. A feature that is off for the viewer is absent, and a table with every
 * feature off carries no projection at all.
 */
export const recordsTableFeatureProjectionSchema = z
  .object({
    pinning: onlyTrue.optional(),
    spreadsheet: spreadsheetSchema.optional(),
    /** Present when the viewer can read some field the record type marks searchable. */
    search: onlyTrue.optional(),
    /**
     * The filterable fields the viewer may filter by, each with its canonical type, filter kind and
     * what its control needs (choice options, a fixed currency, the organisation time zone).
     */
    columnFilters: recordsTableFilterFieldsSchema.optional(),
    /** Present when the viewer can filter by some field or sort by some field it can read. */
    savedViews: onlyTrue.optional(),
    /**
     * The declared bulk actions. A bounded on-intent availability read decides each action's own
     * permission and precondition for the visible selection; execution rechecks current authority.
     */
    bulkActions: z.array(bulkActionSchema).min(1).readonly().optional(),
    rowActions: z
      .object({
        actions: z
          .array(rowActionSchema)
          .min(1)
          .max(20)
          .refine(
            (actions) => new Set(actions.map((action) => action.eventId)).size === actions.length,
            "Each row action is named once",
          )
          .readonly(),
        availability: namedActionAvailabilitySchema,
      })
      .strict()
      .readonly()
      .optional(),
    /**
     * The fields the viewer may change on at least one row, each with how a cell edits it, and the
     * flow binding that commits a change.
     */
    inlineEdit: z
      .object({ eventId: textSchema, fields: inlineEditFieldsSchema })
      .strict()
      .readonly()
      .optional(),
    rowEdit: z
      .object({ eventId: textSchema, trigger: z.literal("button"), fields: inlineEditFieldsSchema })
      .strict()
      .readonly()
      .optional(),
    /** Rows expand to their related records, read this many at a time. */
    masterDetail: z.object({ pageSize: positiveSchema }).strict().readonly().optional(),
    /** Rows expand to the records that name them as their parent, read this many at a time. */
    tree: z.object({ pageSize: positiveSchema }).strict().readonly().optional(),
    /**
     * The viewer may group the table by the authored choice field: it is readable on every record
     * the viewer may read, so the grouped read never needs a withheld value.
     */
    grouping: z
      .object({
        fieldId: textSchema,
        label: textSchema,
        unassignedLabel: textSchema,
        /** The authored opening state: the address overrides it (grouped or flat) for this viewer. */
        opensGrouped: z.boolean(),
        /** The table reads a grouped query, so it is always grouped and offers no way to ungroup. */
        required: onlyTrue.optional(),
      })
      .strict()
      .readonly()
      .optional(),
    /** The styles the page's rows name and the numeric columns drawn as bars or scales. */
    conditionalFormatting: conditionalFormattingProjectionSchema.optional(),
    /**
     * The viewer can read the pivot's rows, columns and measure: it shows this many rows a page.
     * `view` is present when the address opens the table as a pivot, with its row position.
     */
    pivot: z
      .object({
        rowPageSize: positiveSchema,
        totals: z.boolean(),
        view: z.object({ cursor: textSchema.optional() }).strict().readonly().optional(),
      })
      .strict()
      .readonly()
      .optional(),
    /**
     * The viewer may export the records they see: the most records one export holds. Present only
     * when the feature is on and the viewer's export permission allowed it in this read; the export
     * route decides both again on every request.
     */
    export: z
      .object({
        maxRows: z.number().int().min(1).max(RECORDS_TABLE_EXPORT_MAXIMUM_ROWS),
        formats: z
          .array(z.enum(recordsTableExportFormats))
          .min(1)
          .refine((formats) => new Set(formats).size === formats.length, "Name each format once")
          .readonly(),
      })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly()
  .refine((features) => Object.keys(features).length > 0, {
    message: "Projected table features name no feature",
  });
export type RecordsTableFeatureProjection = z.output<typeof recordsTableFeatureProjectionSchema>;
