"use client";

import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  GridLayout,
  GridViewsState,
  RecordsTableFeatureKey,
  RecordsTableFeatureProjection,
  RecordsTableSortState,
} from "@vortex/platform/schema";
import type { DisplayEventHandlers, DisplayRow, TableNarrowing } from "../projected-data";
import type { RowExpansionKind } from "../row-expansion";
import type { TableSelectionParts } from "../projected-grid-features";
import type { GridColumn, GridLayoutControls } from "../table-layout";

/**
 * What every extension point of a grid feature receives: the viewer's feature projection for this
 * read, the page the host read and its handlers. A feature only reads it and reports declared
 * events; the host reads a new page on the server.
 */
export type GridFeatureContext = Readonly<{
  accessibleName: string;
  features: RecordsTableFeatureProjection;
  /** The columns the page carries, in display order. */
  columns: readonly GridColumn[];
  rows: readonly DisplayRow[];
  selectedRecordIds: readonly string[];
  /**
   * The selection beyond the shown page: the read's sealed descriptor of every matching record and
   * the scope and bulk run the page holds. `paged` says the query has pages besides this one.
   */
  selection: TableSelectionParts;
  paged: boolean;
  narrowing: TableNarrowing | undefined;
  /** The order the page was read in, when it is the viewer's own or the authored default. */
  sort: RecordsTableSortState | undefined;
  /** The layout as the person has it now, including a change not yet stored. */
  arrangement: GridLayout;
  /** The saved views of this grid; absent when the grid is not stored for the person. */
  views: GridViewsState | undefined;
  events: DisplayEventHandlers | undefined;
  /** The person's pin per lower-cased field identity, and the one way to change it. */
  pins: GridLayoutControls["state"]["pins"];
  setPin: GridLayoutControls["setPin"];
}>;

/** The one grid focus model, shared with optional page interactions. */
export type GridInteractionSurface = Readonly<{
  rootRef: RefObject<HTMLDivElement | null>;
  focusCell: (row: number, columnId: string, focus?: boolean) => void;
}>;
export type GridFeatureInteractionProps = Readonly<{
  context: GridFeatureContext;
  surface: GridInteractionSurface;
}>;

export type GridFeaturePointProps = Readonly<{ context: GridFeatureContext }>;
export type GridFeatureColumnProps = Readonly<{ context: GridFeatureContext; column: GridColumn }>;
export type GridFeatureRowProps = Readonly<{ context: GridFeatureContext; row: DisplayRow }>;
/** A cell a feature may draw instead of the plain value; `children` is the plain value. */
export type GridFeatureCellProps = Readonly<{
  context: GridFeatureContext;
  row: DisplayRow;
  column: GridColumn;
  children: ReactNode;
}>;

/**
 * The closed decoration tokens a feature may give a cell; each maps to semantic theme-token
 * classes, so every app theme preset colours them and no feature names a colour of its own.
 */
export const gridCellDecorationClasses = {
  text_success: "text-success",
  text_warning: "text-warning",
  text_info: "text-info",
  text_destructive: "text-[color:color-mix(in_oklab,var(--destructive)_75%,var(--foreground))]",
  text_muted: "text-[color:color-mix(in_oklab,var(--muted-foreground)_85%,var(--foreground))]",
  bold: "font-semibold",
  strike: "line-through",
} as const;
export type GridCellDecorationToken = keyof typeof gridCellDecorationClasses;

/**
 * The grid features that fill extension points of the table. Board is not one: it replaces the
 * table with the board view as a whole, which the Data grid draws itself.
 */
type GridExtensionKey = Exclude<RecordsTableFeatureKey, "board">;

/** Whole-grid views share the lazy registry but do not fill table extension points. */
const viewLoaders = {
  board: () => import("../board"),
} satisfies Record<Exclude<RecordsTableFeatureKey, GridExtensionKey>, () => Promise<unknown>>;

export const GridBoardView = lazy(async () => ({
  default: (await viewLoaders.board()).BoardView,
}));

/**
 * The extension points a grid feature fills. The table renders each point once for every feature
 * the projection turns on, so a later feature adds its module here and never edits the table:
 * `ToolbarItems` beside the search box, `ColumnMenuItems` in a column's menu, `HeaderAdornment`
 * after a column heading, `cellDecoration` as tokens per cell, `CellAdornment` around a value (an
 * icon, a badge or a bar), `CellEditor` in place of a value, `RowExpansion` as a panel below a row
 * and `SelectionBanner` over the selected rows.
 */
export type GridFeatureModule = Readonly<{
  GridInteraction?: ComponentType<GridFeatureInteractionProps>;
  ToolbarItems?: ComponentType<GridFeaturePointProps>;
  ColumnMenuItems?: ComponentType<GridFeatureColumnProps>;
  HeaderAdornment?: ComponentType<GridFeatureColumnProps>;
  cellDecoration?: (
    context: GridFeatureContext,
    row: DisplayRow,
    column: GridColumn,
  ) => readonly GridCellDecorationToken[] | undefined;
  CellAdornment?: ComponentType<GridFeatureCellProps>;
  CellEditor?: ComponentType<GridFeatureCellProps>;
  RowExpansion?: ComponentType<GridFeatureRowProps>;
  SelectionBanner?: ComponentType<GridFeaturePointProps>;
}>;

type ComponentPoint = Exclude<keyof GridFeatureModule, "cellDecoration">;

/**
 * One dynamic import per feature: its code is a chunk of its own, downloaded only when the
 * projection turns the feature on for this viewer. A table with every feature off loads none.
 */
const loaders: Readonly<
  Record<GridExtensionKey, () => Promise<{ gridFeature: GridFeatureModule }>>
> = {
  pinning: () => import("./pinning"),
  spreadsheet: () => import("./range-selection"),
  search: () => import("./search"),
  column_filters: () => import("./column-filters"),
  saved_views: () => import("./saved-views"),
  bulk_actions: () => import("./bulk-actions"),
  inline_edit: () => import("./inline-edit"),
  master_detail: () => import("./master-detail"),
  tree: () => import("./tree"),
  conditional_formatting: () => import("./conditional-format"),
};

const projectionKeys: Readonly<Record<keyof RecordsTableFeatureProjection, GridExtensionKey>> = {
  pinning: "pinning",
  spreadsheet: "spreadsheet",
  search: "search",
  columnFilters: "column_filters",
  savedViews: "saved_views",
  bulkActions: "bulk_actions",
  inlineEdit: "inline_edit",
  masterDetail: "master_detail",
  tree: "tree",
  conditionalFormatting: "conditional_formatting",
};

/** The features a projection turns on, in the registry's order. */
export const projectedGridFeatures = (
  features: RecordsTableFeatureProjection | undefined,
): readonly GridExtensionKey[] =>
  features === undefined
    ? []
    : (Object.keys(loaders) as GridExtensionKey[]).filter((key) =>
        Object.entries(projectionKeys).some(
          ([property, feature]) =>
            feature === key &&
            features[property as keyof RecordsTableFeatureProjection] !== undefined,
        ),
      );

const noDecorators: readonly NonNullable<GridFeatureModule["cellDecoration"]>[] = [];
const Nothing = (): null => null;
const PassThrough = ({ children }: Readonly<{ children?: ReactNode }>): ReactElement => (
  <>{children}</>
);

/** Exported code only: cached points never hold a viewer's data or access decisions. */
const pointComponents = new Map<string, ComponentType<object>>();
const pointComponentOf = (
  module: GridFeatureModule,
  point: ComponentPoint,
): ComponentType<object> =>
  (module[point] ??
    (point === "CellEditor" || point === "CellAdornment"
      ? PassThrough
      : Nothing)) as unknown as ComponentType<object>;

const featurePoint = <Props,>(
  key: GridExtensionKey,
  point: ComponentPoint,
): ComponentType<Props> => {
  const id = `${key}:${point}`;
  const held = pointComponents.get(id);
  const component =
    held ??
    lazy(async () => ({ default: pointComponentOf((await loaders[key]()).gridFeature, point) }));
  if (held === undefined) pointComponents.set(id, component);
  return component as unknown as ComponentType<Props>;
};

/** Which points each feature fills, so the table never draws a boundary for an empty point. */
const featurePoints: Readonly<Record<GridExtensionKey, readonly ComponentPoint[]>> = {
  pinning: ["ColumnMenuItems"],
  spreadsheet: ["GridInteraction"],
  search: ["ToolbarItems"],
  column_filters: ["ToolbarItems", "HeaderAdornment"],
  saved_views: ["ToolbarItems"],
  bulk_actions: ["SelectionBanner"],
  inline_edit: ["CellEditor"],
  master_detail: ["RowExpansion"],
  tree: ["RowExpansion"],
  conditional_formatting: ["CellAdornment", "HeaderAdornment"],
};

/**
 * What a row opens to for each feature that fills the row panel. A row's related records open at
 * most three at a time; a tree's rows are bounded by the tree's shared row budget, so any number
 * of them may be open, and only a row the server says has children offers the toggle.
 */
const expansionKinds: Readonly<Partial<Record<RecordsTableFeatureKey, RowExpansionKind>>> = {
  master_detail: {
    noun: "related records",
    maximum: 3,
    tree: false,
    expandable: () => true,
  },
  tree: {
    noun: "child records",
    maximum: Number.MAX_SAFE_INTEGER,
    tree: true,
    expandable: (row) => row.hasChildren === true,
  },
};

const activeKeys = (signature: string): readonly GridExtensionKey[] =>
  signature === "" ? [] : (signature.split(",") as GridExtensionKey[]);

/** One Suspense boundary per active feature that fills the point. */
const drawPoint = (
  active: readonly GridExtensionKey[],
  point: ComponentPoint,
  context: GridFeatureContext,
  props: Record<string, unknown>,
): ReactNode =>
  active
    .filter((key) => featurePoints[key].includes(point))
    .map((key) => {
      const Point = featurePoint<Record<string, unknown>>(key, point);
      return (
        <Suspense key={key} fallback={null}>
          <Point context={context} {...props} />
        </Suspense>
      );
    });

/**
 * The one hook the Records table calls. It returns the renderers of every extension point for the
 * features the projection turns on; with no projection every renderer draws nothing and no feature
 * code is loaded.
 */
export function useGridFeatures(context: GridFeatureContext | undefined): Readonly<{
  keys: readonly GridExtensionKey[];
  /** A projected feature draws a panel below an expanded row, so rows offer an expand toggle. */
  expands: boolean;
  /** What that panel holds and how many may be open; undefined when no feature draws one. */
  expansionKind: RowExpansionKind | undefined;
  toolbarItems: () => ReactNode;
  interaction: (surface: GridInteractionSurface) => ReactNode;
  selectionBanner: () => ReactNode;
  headerAdornment: (column: GridColumn) => ReactNode;
  columnMenuItems: (column: GridColumn) => ReactNode;
  rowExpansion: (row: DisplayRow) => ReactNode;
  cell: (row: DisplayRow, column: GridColumn, plain: ReactNode) => ReactNode;
  /** A value with its decorations and adornments only, for surfaces that never edit (cards). */
  decorate: (row: DisplayRow, column: GridColumn, plain: ReactNode) => ReactNode;
  cellClassName: (row: DisplayRow, column: GridColumn) => string | undefined;
}> {
  const keys = projectedGridFeatures(context?.features);
  const signature = keys.join(",");
  // Cell decorations are plain functions, not components: their modules are read once loaded.
  // They are held with the feature set they were loaded for, so another projection never uses them.
  const [loadedDecorators, setLoadedDecorators] = useState<
    Readonly<{
      signature: string;
      decorators: readonly NonNullable<GridFeatureModule["cellDecoration"]>[];
    }>
  >({ signature: "", decorators: [] });
  const decorators =
    loadedDecorators.signature === signature ? loadedDecorators.decorators : noDecorators;
  useEffect(() => {
    if (signature === "") return;
    let current = true;
    void Promise.all(signature.split(",").map((key) => loaders[key as GridExtensionKey]())).then(
      (modules) => {
        // An enabled feature is already downloaded here. Keep its concrete points so opening a
        // panel later does not introduce another asynchronous boundary and Suspense delay.
        modules.forEach((module, index) => {
          const key = activeKeys(signature)[index]!;
          for (const point of featurePoints[key]) {
            const id = `${key}:${point}`;
            // Keep an already mounted editor's component identity and local edit state.
            if (!pointComponents.has(id))
              pointComponents.set(id, pointComponentOf(module.gridFeature, point));
          }
        });
        if (current)
          setLoadedDecorators({
            signature,
            decorators: modules.flatMap((module) => module.gridFeature.cellDecoration ?? []),
          });
      },
      (error: unknown) => {
        console.error("[display] a grid feature could not be loaded", error);
      },
    );
    return () => {
      current = false;
    };
  }, [signature]);
  // The points drawn inside the grid's memoized rows and headers keep their identity while only
  // the page's rows or the selection change, so a new selection never redraws every row; they read
  // the latest context when they draw.
  const latest = useRef(context);
  latest.current = context;
  const features = context?.features;
  const events = context?.events;
  const columns = context?.columns;
  const accessibleName = context?.accessibleName;
  const cellPoints = useMemo(() => {
    const active = activeKeys(signature);
    const editors = active.filter((key) => featurePoints[key].includes("CellEditor"));
    const adornments = active.filter((key) => featurePoints[key].includes("CellAdornment"));
    // Adornments wrap the plain value inside any editor, so an edited cell keeps its icon or bar.
    const adorn = (row: DisplayRow, column: GridColumn, plain: ReactNode): ReactNode => {
      const current = latest.current;
      if (current === undefined) return plain;
      return adornments.reduce<ReactNode>((inner, key) => {
        const Adornment = featurePoint<GridFeatureCellProps>(key, "CellAdornment");
        return (
          <Suspense key={key} fallback={inner}>
            <Adornment context={current} row={row} column={column}>
              {inner}
            </Adornment>
          </Suspense>
        );
      }, plain);
    };
    const classNameOf = (row: DisplayRow, column: GridColumn): string | undefined => {
      const current = latest.current;
      if (current === undefined || decorators.length === 0) return undefined;
      const classes = decorators.flatMap((decorate) =>
        (decorate(current, row, column) ?? []).map((token) => gridCellDecorationClasses[token]),
      );
      return classes.length === 0 ? undefined : classes.join(" ");
    };
    const drawAt = (point: ComponentPoint, props: Record<string, unknown>): ReactNode => {
      const current = latest.current;
      return current === undefined ? null : drawPoint(active, point, current, props);
    };
    return {
      interaction: (surface: GridInteractionSurface) => drawAt("GridInteraction", { surface }),
      headerAdornment: (column: GridColumn) => drawAt("HeaderAdornment", { column }),
      columnMenuItems: (column: GridColumn) => drawAt("ColumnMenuItems", { column }),
      rowExpansion: (row: DisplayRow) => drawAt("RowExpansion", { row }),
      decorate: (row: DisplayRow, column: GridColumn, plain: ReactNode): ReactNode => {
        const decoration = classNameOf(row, column);
        return adorn(
          row,
          column,
          decoration === undefined ? plain : <span className={decoration}>{plain}</span>,
        );
      },
      cell: (row: DisplayRow, column: GridColumn, plain: ReactNode): ReactNode => {
        const current = latest.current;
        if (current === undefined) return plain;
        return editors.reduce<ReactNode>(
          (inner, key) => {
            const Editor = featurePoint<GridFeatureCellProps>(key, "CellEditor");
            return (
              <Suspense key={key} fallback={inner}>
                <Editor context={current} row={row} column={column}>
                  {inner}
                </Editor>
              </Suspense>
            );
          },
          adorn(row, column, plain),
        );
      },
      cellClassName: classNameOf,
    };
    // The cell points change with the projection, bindings and columns, not with rows or selection.
  }, [signature, decorators, features, events, columns, accessibleName]);
  const active = activeKeys(signature);
  return {
    keys: active,
    expands: active.some((key) => featurePoints[key].includes("RowExpansion")),
    expansionKind: active.map((key) => expansionKinds[key]).find((kind) => kind !== undefined),
    toolbarItems: () =>
      context === undefined ? null : drawPoint(active, "ToolbarItems", context, {}),
    selectionBanner: () =>
      context === undefined ? null : drawPoint(active, "SelectionBanner", context, {}),
    ...cellPoints,
  };
}
