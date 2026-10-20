import type { AuthoredGridView } from "../definition/application-composition/records-table-features/saved-views";
import { z } from "zod";
import {
  RECORDS_TABLE_MAXIMUM_SEARCH_LENGTH,
  RECORDS_TABLE_MAXIMUM_SORT_KEYS,
} from "./records-table-state";
import { decodeRecordsTableFieldFilter } from "./records-table-filters";
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
 * through this layout, and named views (#3023) store both parts in one view document.
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
      .int("A column width is a whole number of pixels")
      .min(
        RECORDS_TABLE_COLUMN_MINIMUM_WIDTH,
        `A column is at least ${RECORDS_TABLE_COLUMN_MINIMUM_WIDTH} pixels wide`,
      )
      .max(
        RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH,
        `A column is at most ${RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH} pixels wide`,
      )
      .optional(),
  })
  .strict();

const gridLayoutShape = {
  /** Every column the layout arranges, in display order. */
  columns: z.array(gridLayoutColumnSchema).min(1).max(GRID_LAYOUT_MAXIMUM_COLUMNS),
  /** The row density the person chose; absent keeps the authored density. */
  density: z.enum(recordsTableDensities).optional(),
};

const refineColumns = (
  layout: Readonly<{ columns: readonly Readonly<{ fieldId: string; visible: boolean }>[] }>,
  context: z.RefinementCtx,
): void => {
  if (new Set(layout.columns.map((column) => column.fieldId)).size !== layout.columns.length)
    context.addIssue({ code: "custom", path: ["columns"], message: "A column is named twice" });
  if (!layout.columns.some((column) => column.visible))
    context.addIssue({
      code: "custom",
      path: ["columns"],
      message: "At least one column stays visible",
    });
};

export const gridLayoutSchema = z.object(gridLayoutShape).strict().superRefine(refineColumns);

export type GridLayout = z.output<typeof gridLayoutSchema>;
export type GridLayoutColumn = GridLayout["columns"][number];

const fieldIdSchema = z
  .string()
  .regex(FIELD_ID_PATTERN)
  .transform((fieldId) => fieldId.toLowerCase());

/** The most filters one view stores. */
export const GRID_VIEW_MAXIMUM_FILTERS = 50;
/** The longest address spelling of one stored filter. */
export const GRID_VIEW_MAXIMUM_FILTER_LENGTH = 4000;
/** The longest view name. */
export const GRID_VIEW_MAXIMUM_NAME_LENGTH = 80;

/**
 * Everything a view stores: the layout (column order, visibility, widths, density) and the query
 * state (ordered sort, one typed filter per field in its address spelling, and the search).
 * It never holds row data, a cursor, a page or a permission.
 */
export const gridViewDocumentSchema = z
  .object({
    ...gridLayoutShape,
    sort: z
      .array(
        z
          .object({ fieldId: fieldIdSchema, direction: z.enum(["ascending", "descending"]) })
          .strict(),
      )
      .min(1)
      .max(RECORDS_TABLE_MAXIMUM_SORT_KEYS)
      .optional(),
    filters: z
      .array(
        z
          .object({
            fieldId: fieldIdSchema,
            filter: z.string().min(1).max(GRID_VIEW_MAXIMUM_FILTER_LENGTH),
          })
          .strict(),
      )
      .min(1)
      .max(GRID_VIEW_MAXIMUM_FILTERS)
      .optional(),
    search: z.string().min(1).max(RECORDS_TABLE_MAXIMUM_SEARCH_LENGTH).optional(),
  })
  .strict()
  .superRefine((document, context) => {
    refineColumns(document, context);
    for (const part of ["sort", "filters"] as const)
      if (
        new Set(document[part]?.map((entry) => entry.fieldId)).size !==
        (document[part]?.length ?? 0)
      )
        context.addIssue({ code: "custom", path: [part], message: "A field is named twice" });
  });

export type GridViewDocument = z.output<typeof gridViewDocumentSchema>;

export const gridViewNameSchema = z
  .string()
  .max(GRID_VIEW_MAXIMUM_NAME_LENGTH)
  .refine((name) => name === name.trim() && name.length > 0, "A view name is trimmed text");

export const gridViewScopes = ["personal", "shared", "default"] as const;
export type GridViewScope = (typeof gridViewScopes)[number];

const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Who a shared view is shared with: the whole organisation, roles of the application, or groups. */
export const gridViewSharingSchema = z
  .object({
    organization: z.boolean(),
    roleIds: z.array(fieldIdSchema).max(50),
    groupIds: z.array(fieldIdSchema).max(50),
  })
  .strict();
export type GridViewSharing = z.output<typeof gridViewSharingSchema>;

/** One view in the switcher: a name and where it comes from, never its document. */
export const gridViewItemSchema = z
  .object({
    viewId: fieldIdSchema,
    name: gridViewNameSchema,
    scope: z.enum(gridViewScopes),
    /** The viewer owns it: only then (or with the share permission) can they change it. */
    mine: z.boolean(),
    revision: revisionSchema,
  })
  .strict();
export type GridViewItem = z.output<typeof gridViewItemSchema>;

/** What a selected view leaves out for this viewer, so the grid can say so. */
export const gridViewHiddenSchema = z
  .object({
    columns: z.number().int().min(0),
    filters: z.number().int().min(0),
    sort: z.number().int().min(0),
  })
  .strict();
export type GridViewHidden = z.output<typeof gridViewHiddenSchema>;

/** The view in effect: its document as applied under this viewer's access, and what was left out. */
export const selectedGridViewSchema = gridViewItemSchema
  .extend({
    document: gridViewDocumentSchema,
    hidden: gridViewHiddenSchema,
    /** Who it is shared with; present only for its owner and for someone who may share. */
    sharing: gridViewSharingSchema.nullable(),
  })
  .strict();
export type SelectedGridView = z.output<typeof selectedGridViewSchema>;

/** Why an addressed view is not in effect. */
export const gridViewNotices = ["unavailable", "needs_fixing"] as const;

export const gridViewsStateSchema = z
  .object({
    /** The viewer holds the permission that lets them share table views. */
    canShare: z.boolean(),
    items: z.array(gridViewItemSchema).max(220),
    /** The view the viewer's own stored layout derives from, when it does. */
    basedOnViewId: fieldIdSchema.nullable(),
    selected: selectedGridViewSchema.nullable(),
    notice: z.enum(gridViewNotices).nullable(),
  })
  .strict();
export type GridViewsState = z.output<typeof gridViewsStateSchema>;

/**
 * Where a grid's arrangement goes: stored for the person, kept on screen in an application preview,
 * or reported to Studio for capture into the authored default view.
 */
export const gridLayoutStorages = ["personal", "preview", "canvas"] as const;
export type GridLayoutStorage = (typeof gridLayoutStorages)[number];

/** The layout a grid placement shows, as the server sends it with the grid's page. */
export type GridLayoutState = Readonly<{
  storage: GridLayoutStorage;
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
  /** The saved views of this grid; absent when the Saved views feature is off or in a preview. */
  views?: GridViewsState | undefined;
}>;

export const gridLayoutStateSchema = z
  .object({
    storage: z.enum(gridLayoutStorages),
    queryId: z.string().regex(FIELD_ID_PATTERN),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
    layout: gridLayoutSchema,
    authored: gridLayoutSchema,
    reset: z.boolean(),
    views: gridViewsStateSchema.optional(),
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
  /** A Studio gesture stays on the canvas until captured into the definition. */
  | Readonly<{ outcome: "previewed" }>
  | Readonly<{ outcome: "saved"; revision: number }>
  | Readonly<{ outcome: "reset" }>
  | Readonly<{
      /** Another tab stored a newer layout first; it is returned (null when none is stored now). */
      outcome: "conflict";
      stored: Readonly<{ revision: number; queryId: string; layout: GridLayout }> | null;
    }>
  | Readonly<{ outcome: "unavailable" }>;

/** The stored view the address selected, as the store listed it for the viewer. */
export type AddressedGridView = Readonly<{
  hiddenFilters: number;
  item: GridViewItem;
  document: GridViewDocument;
  sharing: GridViewSharing | null;
}>;

/**
 * The selected view as it applies to this viewer. A view stores configuration only, so it is
 * re-evaluated under the viewer's current access: a column the viewer cannot see, and a filter or
 * sort key on a field they cannot read, are left out and counted, never shown and never failing
 * the view. A filter whose stored value is malformed cannot be applied without widening the rows,
 * so the view is not applied and the viewer is told it needs fixing. `readable` is the viewer's
 * field policy (undefined in a preview, whose builder sees every field).
 */
export const resolveSelectedGridView = (
  authored: GridLayout,
  addressed: AddressedGridView | undefined,
  readable: ReadonlySet<string> | undefined,
): Readonly<{
  selected: SelectedGridView | null;
  notice: (typeof gridViewNotices)[number] | null;
}> => {
  if (addressed === undefined) return { selected: null, notice: "unavailable" };
  const { item, document, sharing } = addressed;
  const permitted = new Set(authored.columns.map((column) => column.fieldId));
  const kept = document.columns.filter((column) => permitted.has(column.fieldId));
  const named = new Set(kept.map((column) => column.fieldId));
  const arranged = [...kept, ...authored.columns.filter((column) => !named.has(column.fieldId))];
  const readableField = (fieldId: string): boolean =>
    readable === undefined || readable.has(fieldId);
  const filters = (document.filters ?? []).filter((entry) => readableField(entry.fieldId));
  if (filters.some((entry) => decodeRecordsTableFieldFilter(entry.filter) === undefined))
    return { selected: null, notice: "needs_fixing" };
  const sort = (document.sort ?? []).filter((entry) => readableField(entry.fieldId));
  const applied: GridViewDocument = {
    // A view that would show no column of this viewer's falls back to the authored arrangement.
    columns: arranged.some((column) => column.visible) ? arranged : authored.columns,
    ...(document.density === undefined ? {} : { density: document.density }),
    ...(sort.length === 0 ? {} : { sort }),
    ...(filters.length === 0 ? {} : { filters }),
    ...(document.search === undefined ? {} : { search: document.search }),
  };
  return {
    selected: {
      ...item,
      document: applied,
      hidden: {
        columns: document.columns.length - kept.length,
        filters: addressed.hiddenFilters + (document.filters ?? []).length - filters.length,
        sort: (document.sort ?? []).length - sort.length,
      },
      sharing,
    },
    notice: null,
  };
};

/** The layout part of a view document: what the grid arranges, without the query state. */
export const gridViewLayout = (document: GridViewDocument): GridLayout => ({
  columns: document.columns,
  ...(document.density === undefined ? {} : { density: document.density }),
});

/** One change a person asks of the saved views of a grid, as the grid reports it to its host. */
export type GridViewCommand =
  /** Opens a view (null leaves it); the host changes the address, nothing is stored. */
  | Readonly<{ kind: "select"; viewId: string | null }>
  /** Saves the grid as it is now (layout and query state) as a new personal view. */
  | Readonly<{ kind: "create"; name: string; layout: GridLayout }>
  /** Replaces the document of a view with the grid as it is now. */
  | Readonly<{ kind: "save"; viewId: string; expectedRevision: number; layout: GridLayout }>
  | Readonly<{ kind: "rename"; viewId: string; expectedRevision: number; name: string }>
  | Readonly<{
      kind: "share";
      viewId: string;
      expectedRevision: number;
      sharing: GridViewSharing;
    }>
  | Readonly<{ kind: "delete"; viewId: string; expectedRevision: number }>
  /** Returns the grid to the authored defaults: no view, no stored layout, no query state. */
  | Readonly<{ kind: "reset" }>
  /** Lists the roles and groups a view can be shared with. */
  | Readonly<{ kind: "share_targets" }>;

export type GridViewShareTargets = Readonly<{
  roles: readonly Readonly<{ id: string; label: string }>[];
  groups: readonly Readonly<{ id: string; label: string }>[];
}>;

/** What the host did with a view command, so the grid can close its dialog or say why not. */
export type GridViewCommandResult =
  | Readonly<{ outcome: "done"; viewId?: string; revision?: number }>
  | Readonly<{ outcome: "targets"; targets: GridViewShareTargets }>
  | Readonly<{ outcome: "selected"; selected: SelectedGridView; canShare: boolean }>
  /** Another tab changed or removed the view first; the host has told the person. */
  | Readonly<{ outcome: "conflict" }>
  | Readonly<{ outcome: "forbidden" }>
  | Readonly<{ outcome: "limit" }>
  | Readonly<{ outcome: "unavailable" }>;

/** Default views use the same document and projection as stored views. */
export const addressedDefaultGridViews = (
  views: readonly AuthoredGridView[],
  roleKeys: ReadonlySet<string>,
  defaultDocuments: ReadonlyMap<
    string,
    Readonly<{ document: GridViewDocument; hiddenFilters: number }>
  >,
) =>
  views
    .filter((view) => view.role === "*" || roleKeys.has(view.role))
    // A role-specific default takes precedence over the application's default.
    .sort((left, right) => Number(left.role === "*") - Number(right.role === "*"))
    .map((view) => {
      const sanitized = defaultDocuments.get(view.viewId.toLowerCase());
      if (sanitized === undefined) throw new Error("GRID_DEFAULT_VIEW_DOCUMENT_MISSING");
      return {
        ...view,
        item: {
          viewId: view.viewId,
          name: view.name,
          scope: "default" as const,
          mine: false,
          revision: 1,
        },
        document: sanitized.document,
        hiddenFilters: sanitized.hiddenFilters,
        sharing: null,
      };
    });
