import { z } from "zod";
import {
  RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH,
  RECORDS_TABLE_COLUMN_MINIMUM_WIDTH,
  recordsTableDensities,
  recordsTableColumnPins,
  type RecordsTableContract,
} from "../definition/application-composition/records-display";

/**
 * A person's layout of one data grid placement: the column order, which columns show, the widths
 * they resized and the row density. It is presentation metadata the server stores per person and
 * placement; it never holds row data or a cursor. The query state (sort, filters, search, page)
 * stays in the page address (`RecordsTableQueryState`); a grid view is that query state read
 * through this layout, and named views (#3023) store both parts in the same row shape.
 *
 * Which columns show is decided by the layout alone: the server reads the shown columns only, so a
 * hidden column's values never reach the browser, and the browser shows or hides a column it
 * already holds without a read.
 */

const FIELD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most columns one layout names; a Records table declares at most as many. */
export const GRID_LAYOUT_MAXIMUM_COLUMNS = 200;

export const gridLayoutColumnSchema = z
  .object({
    fieldId: z
      .string()
      .regex(FIELD_ID_PATTERN)
      .transform((fieldId) => fieldId.toLowerCase()),
    visible: z.boolean(),
    pin: z.enum(recordsTableColumnPins),
    /** The width the person resized the column to; absent keeps the authored width. */
    width: z
      .number()
      .int()
      .min(RECORDS_TABLE_COLUMN_MINIMUM_WIDTH)
      .max(RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH)
      .optional(),
  })
  .strict();

export const gridLayoutSchema = z
  .object({
    /** Every column the layout arranges, in display order. */
    columns: z.array(gridLayoutColumnSchema).min(1).max(GRID_LAYOUT_MAXIMUM_COLUMNS),
    /** The row density the person chose; absent keeps the authored density. */
    density: z.enum(recordsTableDensities).optional(),
  })
  .strict()
  .superRefine((layout, context) => {
    if (new Set(layout.columns.map((column) => column.fieldId)).size !== layout.columns.length)
      context.addIssue({ code: "custom", path: ["columns"], message: "A column is named twice" });
    if (!layout.columns.some((column) => column.visible))
      context.addIssue({
        code: "custom",
        path: ["columns"],
        message: "At least one column stays visible",
      });
  });

export type GridLayout = z.output<typeof gridLayoutSchema>;
export type GridLayoutColumn = GridLayout["columns"][number];

/** The layout a grid placement shows, as the server sends it with the grid's page. */
export type GridLayoutState = Readonly<{
  /** False in a preview: the person may arrange the grid, but nothing is stored. */
  persisted: boolean;
  /** The query the placement reads; a stored layout of another query is not this grid's. */
  queryId: string;
  /** The stored layout's revision; null when the person has none and sees the authored layout. */
  revision: number | null;
  /** The layout applied: every column the person may see, in display order. */
  layout: GridLayout;
  /** The authored layout narrowed to the columns the person may see: what Reset layout restores. */
  authored: GridLayout;
  /** The stored layout named a column that is no longer available, so the authored one applies. */
  reset: boolean;
}>;

export const gridLayoutStateSchema = z
  .object({
    persisted: z.boolean(),
    queryId: z.string().regex(FIELD_ID_PATTERN),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
    layout: gridLayoutSchema,
    authored: gridLayoutSchema,
    reset: z.boolean(),
  })
  .strict()
  .superRefine((state, context) => {
    const authored = new Set(state.authored.columns.map((column) => column.fieldId));
    if (
      state.layout.columns.length !== authored.size ||
      state.layout.columns.some((column) => !authored.has(column.fieldId))
    )
      context.addIssue({
        code: "custom",
        path: ["layout"],
        message: "A layout arranges exactly the columns of its authored layout",
      });
  });

/** The declared columns of a Records table, once each, as lower-cased field identities. */
const declaredColumns = (contract: RecordsTableContract) => {
  const seen = new Set<string>();
  return contract.columns.flatMap((column) => {
    const fieldId = column.field.toLowerCase();
    if (seen.has(fieldId)) return [];
    seen.add(fieldId);
    return [{ fieldId, visible: column.visible, pin: column.pin }];
  });
};

/**
 * The authored layout: the declared columns in declared order, with their default visibility.
 * `readable`, when given, is the person's current field policy (the fields they can read on at
 * least one record): a column they can never read is left out, so it is never requested, listed
 * or offered to show, and when that leaves no column shown, the first remaining one shows. A row
 * on which a remaining field is withheld still shows it as Restricted. Undefined when the person
 * can read none of the declared columns.
 */
export const authoredGridLayout = (
  contract: RecordsTableContract,
  readable?: ReadonlySet<string>,
): GridLayout | undefined => {
  const columns = declaredColumns(contract).filter(
    (column) => readable === undefined || readable.has(column.fieldId),
  );
  const [first, ...rest] = columns;
  if (first === undefined) return undefined;
  return {
    columns: columns.some((column) => column.visible)
      ? columns
      : [{ ...first, visible: true }, ...rest],
  };
};

/**
 * The layout a person sees: their stored layout checked against the authored layout of the
 * current release and their current field policy. A permitted column the stored layout does not
 * name (added by a later release, or readable again) joins at the end with its authored
 * visibility. A stored layout that names a column the release no longer declares or the person
 * can no longer read, or another query's layout, is not applied: the authored layout shows and
 * `reset` says so, so the person is told why their layout changed.
 */
export const resolveGridLayout = (
  authored: GridLayout,
  stored: Readonly<{ queryId: string; layout: GridLayout }> | undefined,
  queryId: string,
): Readonly<{ layout: GridLayout; reset: boolean }> => {
  if (stored === undefined) return { layout: authored, reset: false };
  const permitted = new Set(authored.columns.map((column) => column.fieldId));
  if (
    stored.queryId.toLowerCase() !== queryId.toLowerCase() ||
    stored.layout.columns.some((column) => !permitted.has(column.fieldId))
  )
    return { layout: authored, reset: true };
  const named = new Set(stored.layout.columns.map((column) => column.fieldId));
  return {
    layout: {
      columns: [
        ...stored.layout.columns,
        ...authored.columns.filter((column) => !named.has(column.fieldId)),
      ],
      ...(stored.layout.density === undefined ? {} : { density: stored.layout.density }),
    },
    reset: false,
  };
};

/** The columns a layout shows, as field identities in display order. */
export const gridLayoutVisibleFieldIds = (layout: GridLayout): readonly string[] =>
  layout.columns.filter((column) => column.visible).map((column) => column.fieldId);

/** What storing or resetting a layout came to, as the grid's host reports it back to the grid. */
export type GridLayoutCommitResult =
  | Readonly<{ outcome: "saved"; revision: number }>
  | Readonly<{ outcome: "reset" }>
  | Readonly<{
      /** Another tab stored a newer layout first; it is returned (null when none is stored now). */
      outcome: "conflict";
      stored: Readonly<{ revision: number; queryId: string; layout: GridLayout }> | null;
    }>
  | Readonly<{ outcome: "unavailable" }>;
