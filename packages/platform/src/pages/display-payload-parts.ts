import { z } from "zod";
import { isSafeLinkAddress } from "../catalogue/common";
import { builderKeySchema, fieldIdSchema, timestampSchema } from "../catalogue/identifiers";
import { moduleFieldValueSchemas } from "../records/module-field-values";
import { richTextDocumentSchema } from "../records/rich-text";

/*
 * The parts every display block payload shares: the state one placement is in and the closed
 * display values its cells, fields and summaries carry. The server types what it builds with these
 * schemas and the browser parses the payload with the same ones, so the two cannot drift apart.
 */

/** Adds one issue for every item whose key an earlier item already used. */
export const refineUniqueKeys = <Item>(
  items: readonly Item[],
  keyOf: (item: Item) => string,
  context: z.RefinementCtx,
  message: string,
  path: readonly PropertyKey[] = [],
): void => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const key = keyOf(item);
    if (seen.has(key)) context.addIssue({ code: "custom", path: [...path, index], message });
    seen.add(key);
  });
};

/** Text that holds more than white space. */
export const displayTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Text must not be blank");

/** A row cell, column, detail field or sort key: a builder key or a declared field identity. */
export const displayFieldKeySchema = z.union([builderKeySchema, fieldIdSchema]);

/** An address inside this application: an absolute path, never another origin or a script. */
export const isInternalAddress = (value: unknown): value is string =>
  typeof value === "string" && /^\/(?![/\\])\S*$/.test(value);

const isoCalendarDatePattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** An ISO calendar date or an offset timestamp, as a date display value carries it. */
const isDisplayDate = (value: string): boolean =>
  (isoCalendarDatePattern.test(value) && !Number.isNaN(Date.parse(value))) ||
  timestampSchema.safeParse(value).success;

const kindOnly = <Kind extends string>(kind: Kind) =>
  z
    .object({ kind: z.literal(kind) })
    .strict()
    .readonly();

/**
 * One closed display value that is not itself a table. Every variant carries only a permitted
 * presentation value; none can execute or fetch.
 */
export const displayScalarCellSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("text"), text: z.string() })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("number"),
      value: z.number(),
      formatted: z.string().exactOptional(),
    })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("boolean"), value: z.boolean() })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("date"),
      iso: z.string().refine(isDisplayDate, "A date value is an ISO date or offset timestamp"),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("choice"),
      key: moduleFieldValueSchemas.choice,
      label: displayTextSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("link"),
      address: z
        .string()
        .refine(isSafeLinkAddress, "A link is a safe web, mail or telephone address"),
      label: displayTextSchema,
    })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("rich_text"), document: richTextDocumentSchema })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("record_link"),
      label: displayTextSchema,
      /** The detail page of the linked record, an address inside this application. */
      href: z
        .string()
        .refine(isInternalAddress, "A record link opens an address inside this application")
        .exactOptional(),
    })
    .strict()
    .readonly(),
  /** A linked record the viewer may not read. */
  kindOnly("restricted"),
  /** A linked record whose label could not be read. */
  kindOnly("unavailable"),
  kindOnly("empty"),
]);
export type DisplayScalarCell = z.output<typeof displayScalarCellSchema>;

/** One declared column: its stable key and readable heading. */
export const displayColumnSchema = z
  .object({ key: displayFieldKeySchema, label: displayTextSchema })
  .strict()
  .readonly();

/** Declared columns, each key once. */
export const displayColumnsSchema = z
  .array(displayColumnSchema)
  .readonly()
  .superRefine((columns, context) =>
    refineUniqueKeys(columns, (column) => column.key, context, "Each column key appears once"),
  );

/**
 * A table field's rows on a record detail: its declared columns with readable headings, the first
 * page of rows with each row's scalar cells keyed by exactly those columns, and the field's total
 * row count, never fewer than the rows shown.
 */
export const displayTableFieldSchema = z
  .object({
    kind: z.literal("field_table"),
    columns: displayColumnsSchema.refine(
      (columns) => columns.length > 0,
      "A table field value requires its declared columns",
    ),
    rows: z.array(z.record(displayFieldKeySchema, displayScalarCellSchema).readonly()).readonly(),
    rowCount: z.number().int().min(0),
  })
  .strict()
  .readonly()
  .superRefine((table, context) => {
    const keys = table.columns.map((column) => column.key);
    table.rows.forEach((row, index) => {
      for (const key of keys)
        if (!Object.hasOwn(row, key))
          context.addIssue({
            code: "custom",
            path: ["rows", index, key],
            message: `A table field row requires a cell for column '${key}'`,
          });
      for (const key of Object.keys(row))
        if (!keys.includes(key))
          context.addIssue({
            code: "custom",
            path: ["rows", index, key],
            message: `A table field row has no column '${key}'`,
          });
    });
    if (table.rowCount < table.rows.length)
      context.addIssue({
        code: "custom",
        path: ["rowCount"],
        message: "A table field counts at least the rows it shows",
      });
  });
export type DisplayTableField = z.output<typeof displayTableFieldSchema>;

/** A record-detail field value: a scalar value, or a table field's rows. */
export const displayDetailCellSchema = z.discriminatedUnion("kind", [
  displayScalarCellSchema,
  displayTableFieldSchema,
]);
export type DisplayDetailCell = z.output<typeof displayDetailCellSchema>;

const refineFieldKeys = (
  fields: readonly Readonly<{ key: string }>[],
  context: z.RefinementCtx,
): void => refineUniqueKeys(fields, (field) => field.key, context, "Each field key appears once");

/** Labelled fields with scalar values, each key once, as a card or detail panel shows them. */
export const displayFieldsSchema = z
  .array(
    z
      .object({
        key: displayFieldKeySchema,
        label: displayTextSchema,
        value: displayScalarCellSchema,
      })
      .strict()
      .readonly(),
  )
  .readonly()
  .superRefine(refineFieldKeys);

/** A record detail's labelled fields, each key once; a field may hold a table field's rows. */
export const displayDetailFieldsSchema = z
  .array(
    z
      .object({
        key: displayFieldKeySchema,
        label: displayTextSchema,
        value: displayDetailCellSchema,
      })
      .strict()
      .readonly(),
  )
  .readonly()
  .superRefine(refineFieldKeys);
export type DisplayDetailField = z.output<typeof displayDetailFieldsSchema>[number];

/** Fixed, data-free refusal reasons; a refused state never carries a value. */
export const displayRefusalReasons = [
  "not_permitted",
  "access_ended",
  "not_found",
  "value_out_of_range",
  "dataset_limit_exceeded",
  "grouping_unavailable",
  "filter_field_not_filterable",
  "filter_unavailable",
  "filter_field_repeated",
  "filter_value_invalid",
  "filter_date_out_of_range",
  "filter_value_mismatch",
  "sort_field_not_sortable",
  "search_unavailable",
  "table_address_invalid",
] as const;
export type DisplayRefusalReason = (typeof displayRefusalReasons)[number];

/**
 * The explicit, data-safe state of one placement. Only `ready` carries values, which each block
 * parses with its own payload schema; loading, empty, refused and error cannot leak data.
 */
export const displayDataStateSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("loading") })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("empty") })
    .strict()
    .readonly(),
  /** A required query input has no value yet: the authored or fixed message, no query was run. */
  z
    .object({ status: z.literal("awaiting_input"), message: displayTextSchema.max(300) })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("refused"), reason: z.enum(displayRefusalReasons) })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("error") })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("ready"), values: z.unknown() })
    .strict()
    .readonly(),
]);

/** One placement's state with its block's own ready values. */
export type DisplayDataState<Values> =
  | Exclude<z.output<typeof displayDataStateSchema>, Readonly<{ status: "ready" }>>
  | Readonly<{ status: "ready"; values: Values }>;
