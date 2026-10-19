"use client";

import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactElement,
  type ReactNode,
} from "react";
import type {
  RecordsTableFeatureKey,
  RecordsTableFeatureProjection,
} from "@vortex/platform/schema";
import type { DisplayEventHandlers, DisplayRow, TableNarrowing } from "../projected-data";
import type { GridColumn } from "../table-layout";

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
  narrowing: TableNarrowing | undefined;
  events: DisplayEventHandlers | undefined;
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

/** The closed decoration tokens a feature may give a cell; each maps to theme-token classes. */
export const gridCellDecorationClasses = {
  positive: "bg-primary/10 text-foreground",
  negative: "bg-destructive/10 text-destructive",
  muted: "text-muted-foreground",
  emphasis: "font-semibold",
} as const;
export type GridCellDecorationToken = keyof typeof gridCellDecorationClasses;

/**
 * The extension points a grid feature fills. The table renders each point once for every feature
 * the projection turns on, so a later feature adds its module here and never edits the table:
 * `ToolbarItems` beside the search box, `ColumnMenuItems` in a column's menu, `HeaderAdornment`
 * after a column heading, `cellDecoration` as a token per cell, `CellEditor` in place of a value,
 * `RowExpansion` as a panel below a row and `SelectionBanner` over the selected rows.
 */
export type GridFeatureModule = Readonly<{
  ToolbarItems?: ComponentType<GridFeaturePointProps>;
  ColumnMenuItems?: ComponentType<GridFeatureColumnProps>;
  HeaderAdornment?: ComponentType<GridFeatureColumnProps>;
  cellDecoration?: (
    context: GridFeatureContext,
    row: DisplayRow,
    column: GridColumn,
  ) => GridCellDecorationToken | undefined;
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
  Record<RecordsTableFeatureKey, () => Promise<{ gridFeature: GridFeatureModule }>>
> = {
  search: () => import("./search"),
  column_filters: () => import("./column-filters"),
  saved_views: () => import("./saved-views"),
  bulk_actions: () => import("./bulk-actions"),
  inline_edit: () => import("./inline-edit"),
};

const projectionKeys: Readonly<
  Record<keyof RecordsTableFeatureProjection, RecordsTableFeatureKey>
> = {
  search: "search",
  columnFilters: "column_filters",
  savedViews: "saved_views",
  bulkActions: "bulk_actions",
  inlineEdit: "inline_edit",
};

/** The features a projection turns on, in the registry's order. */
export const projectedGridFeatures = (
  features: RecordsTableFeatureProjection | undefined,
): readonly RecordsTableFeatureKey[] =>
  features === undefined
    ? []
    : (Object.keys(loaders) as RecordsTableFeatureKey[]).filter((key) =>
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

// One lazy component per feature and point, made once: the server renders it (the boundary
// suspends and streams) and the browser downloads the feature's chunk only when it is drawn.
const lazyPoints = new Map<string, LazyExoticComponent<ComponentType<object>>>();
const lazyPoint = <Props,>(
  key: RecordsTableFeatureKey,
  point: ComponentPoint,
): LazyExoticComponent<ComponentType<Props>> => {
  const id = `${key}:${point}`;
  const held = lazyPoints.get(id);
  const component =
    held ??
    lazy(async () => {
      const loaded = (await loaders[key]()).gridFeature[point];
      return {
        default: (loaded ??
          (point === "CellEditor" ? PassThrough : Nothing)) as unknown as ComponentType<object>,
      };
    });
  if (held === undefined) lazyPoints.set(id, component);
  return component as unknown as LazyExoticComponent<ComponentType<Props>>;
};

/** Which points each feature fills, so the table never draws a boundary for an empty point. */
const featurePoints: Readonly<Record<RecordsTableFeatureKey, readonly ComponentPoint[]>> = {
  search: ["ToolbarItems"],
  column_filters: ["ToolbarItems", "HeaderAdornment"],
  // Saved views add their toolbar menu with the views store (#3020); the switch already gates them.
  saved_views: [],
  bulk_actions: ["SelectionBanner"],
  inline_edit: ["CellEditor"],
};

const activeKeys = (signature: string): readonly RecordsTableFeatureKey[] =>
  signature === "" ? [] : (signature.split(",") as RecordsTableFeatureKey[]);

/** One Suspense boundary per active feature that fills the point. */
const drawPoint = (
  active: readonly RecordsTableFeatureKey[],
  point: ComponentPoint,
  context: GridFeatureContext,
  props: Record<string, unknown>,
): ReactNode =>
  active
    .filter((key) => featurePoints[key].includes(point))
    .map((key) => {
      const Point = lazyPoint<Record<string, unknown>>(key, point);
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
  keys: readonly RecordsTableFeatureKey[];
  toolbarItems: () => ReactNode;
  selectionBanner: () => ReactNode;
  headerAdornment: (column: GridColumn) => ReactNode;
  columnMenuItems: (column: GridColumn) => ReactNode;
  rowExpansion: (row: DisplayRow) => ReactNode;
  cell: (row: DisplayRow, column: GridColumn, plain: ReactNode) => ReactNode;
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
    void Promise.all(
      signature.split(",").map((key) => loaders[key as RecordsTableFeatureKey]()),
    ).then(
      (modules) => {
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
    const drawAt = (point: ComponentPoint, props: Record<string, unknown>): ReactNode => {
      const current = latest.current;
      return current === undefined ? null : drawPoint(active, point, current, props);
    };
    return {
      headerAdornment: (column: GridColumn) => drawAt("HeaderAdornment", { column }),
      columnMenuItems: (column: GridColumn) => drawAt("ColumnMenuItems", { column }),
      rowExpansion: (row: DisplayRow) => drawAt("RowExpansion", { row }),
      cell: (row: DisplayRow, column: GridColumn, plain: ReactNode): ReactNode => {
        const current = latest.current;
        if (current === undefined) return plain;
        return editors.reduce<ReactNode>((inner, key) => {
          const Editor = lazyPoint<GridFeatureCellProps>(key, "CellEditor");
          return (
            <Suspense key={key} fallback={inner}>
              <Editor context={current} row={row} column={column}>
                {inner}
              </Editor>
            </Suspense>
          );
        }, plain);
      },
      cellClassName: (row: DisplayRow, column: GridColumn): string | undefined => {
        const current = latest.current;
        if (current === undefined || decorators.length === 0) return undefined;
        const classes = decorators.flatMap((decorate) => {
          const token = decorate(current, row, column);
          return token === undefined ? [] : [gridCellDecorationClasses[token]];
        });
        return classes.length === 0 ? undefined : classes.join(" ");
      },
    };
    // The cell points change with the projection, bindings and columns, not with rows or selection.
  }, [signature, decorators, features, events, columns, accessibleName]);
  const active = activeKeys(signature);
  return {
    keys: active,
    toolbarItems: () =>
      context === undefined ? null : drawPoint(active, "ToolbarItems", context, {}),
    selectionBanner: () =>
      context === undefined ? null : drawPoint(active, "SelectionBanner", context, {}),
    ...cellPoints,
  };
}
