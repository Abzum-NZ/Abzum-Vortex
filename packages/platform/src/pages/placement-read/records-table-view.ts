import "server-only";

import type { RecordsTableContract } from "../../definition/application-composition/records-display";
import {
  decodeRecordsTableFieldFilter,
  readRecordsTableView,
  type RecordsTableQueryState,
} from "../records-table-state";
import {
  authoredGridLayout,
  addressedDefaultGridViews,
  gridViewLayout,
  resolveGridLayout,
  resolveSelectedGridView,
  type GridLayoutState,
  type GridViewsState,
} from "../grid-view-state";
import { addressedGridView, gridViewPlacement } from "../grid-views";
import { personalFormattingAllowed } from "../records-table-features";
import type { PlacementModule, PlacementQuery } from "./shared";
import type { PlacementReadInput } from "./types";

/** Resolves the viewer's table layout and query together, for records and pivot reads alike. */
export const resolveRecordsTableView = ({
  contract,
  placementId,
  bound,
  pageDefinition,
  gridLayouts,
  addressEntries,
  state,
}: Readonly<{
  contract: RecordsTableContract;
  placementId: string;
  bound: Readonly<{ module: PlacementModule; query: PlacementQuery }>;
  pageDefinition: PlacementReadInput["pageDefinition"];
  gridLayouts: PlacementReadInput["gridLayouts"];
  addressEntries: readonly (readonly [string, string])[];
  state: RecordsTableQueryState;
}>):
  | Readonly<{
      layout: GridLayoutState;
      state: RecordsTableQueryState;
      readable: ReadonlySet<string> | undefined;
    }>
  | undefined => {
  const queryId = String(bound.query.queryId).toLowerCase();
  const recordType = bound.query.recordType;
  const readable =
    gridLayouts.readable === undefined
      ? undefined
      : (gridLayouts.readable.get(
          recordType.state === "resolved" ? String(recordType.recordTypeId).toLowerCase() : "",
        ) ?? new Set<string>());
  const authored = authoredGridLayout(contract, readable);
  if (authored === undefined) return undefined;
  const stored = gridLayouts.stored.layouts.get(placementId.toLowerCase());
  // Saved views: only the selected or automatic view, re-evaluated under the viewer's
  // access (a column or filter they cannot see is left out and counted).
  let views: GridViewsState | undefined;
  let selectedQuery: RecordsTableQueryState | undefined;
  let selectedLayout: GridLayoutState["layout"] | undefined;
  let resetLayout = authored;
  if (contract.features.savedViews.enabled && gridLayouts.storage === "personal") {
    const listed = (gridLayouts.stored.views.get(placementId.toLowerCase()) ?? []).filter(
      (view) => view.queryId === queryId,
    );
    const installedViews = gridViewPlacement(pageDefinition, placementId)?.contract.features
      .savedViews;
    if (installedViews?.enabled !== true) throw new Error("GRID_DEFAULT_VIEWS_NOT_INSTALLED");
    const defaults = addressedDefaultGridViews(
      installedViews.defaultViews,
      gridLayouts.stored.roleKeys,
      gridLayouts.stored.defaultDocuments,
      {
        viewId: readRecordsTableView(placementId, addressEntries)?.viewId,
        automatic: true,
      },
    );
    const addressedView = readRecordsTableView(placementId, addressEntries);
    const automatic =
      stored === undefined && addressedView === undefined
        ? defaults.find((view) => view.isDefault)
        : undefined;
    const view =
      addressedView ??
      (automatic === undefined ? undefined : { viewId: automatic.viewId, cleared: false });
    const resolvedView =
      view === undefined
        ? { selected: null, notice: null }
        : resolveSelectedGridView(
            authored,
            defaults.find((candidate) => candidate.viewId === view.viewId) ??
              addressedGridView(
                listed,
                queryId,
                view.viewId,
                gridLayouts.stored.shareable.has(placementId.toLowerCase()),
              ),
            readable,
            personalFormattingAllowed(contract),
          );
    // A stored personal arrangement suppresses automatic view application, but resetting it
    // still returns to that viewer's automatic default, already sanitized by the same read.
    const resetView =
      resolvedView.selected ??
      (view === undefined
        ? resolveSelectedGridView(
            authored,
            defaults.find((candidate) => candidate.isDefault),
            readable,
            personalFormattingAllowed(contract),
          ).selected
        : null);
    if (resetView !== null) resetLayout = gridViewLayout(resetView.document);
    views = {
      canShare: gridLayouts.stored.shareable.has(placementId.toLowerCase()),
      basedOnViewId: stored?.basedOnViewId ?? null,
      selected: resolvedView.selected,
      notice: resolvedView.notice,
      ...(installedViews.personalFormatting && contract.features.conditionalFormatting.enabled
        ? {
            formattingFields: (
              bound.module.content.recordTypes.find(
                (candidate) =>
                  recordType.state === "resolved" &&
                  String(candidate.recordTypeId).toLowerCase() ===
                    String(recordType.recordTypeId).toLowerCase(),
              )?.fields ?? []
            ).filter((field) =>
              authored.columns.some(
                (column) => column.fieldId === String(field.fieldId).toLowerCase(),
              ),
            ),
          }
        : {}),
    };
    const selected = resolvedView.selected;
    if (selected !== null) {
      // The address wins: a view's own sort, filters and search apply only when the address names
      // none and the person has not cleared them.
      if (
        view?.cleared === false &&
        state.sort.length === 0 &&
        state.filters.length === 0 &&
        state.search === null
      )
        selectedQuery = {
          ...state,
          sort: selected.document.sort,
          filters: selected.document.filters.flatMap(({ fieldId, filter }) => {
            const typed = decodeRecordsTableFieldFilter(filter);
            return typed === undefined ? [] : [{ fieldId, filter: typed }];
          }),
          search: selected.document.search,
        };
      // A layout the person arranged from this view is theirs; otherwise the view's shows.
      if (stored?.basedOnViewId !== selected.viewId)
        selectedLayout = gridViewLayout(selected.document);
    }
  }
  const resolvedLayout =
    selectedLayout !== undefined
      ? { layout: selectedLayout, reset: false }
      : resolveGridLayout(
          authored,
          stored?.layout === undefined
            ? undefined
            : { queryId: stored.queryId, layout: stored.layout },
          queryId,
        );
  const layout: GridLayoutState = {
    storage: gridLayouts.storage,
    queryId,
    revision: stored?.revision ?? null,
    layout: resolvedLayout.layout,
    // Reset returns to the resolved view's arrangement, which is also the baseline for
    // the next personal gesture. Declared order is only the baseline without a view.
    authored: resetLayout,
    reset: resolvedLayout.reset,
    ...(views === undefined ? {} : { views }),
  };
  return { layout, state: selectedQuery ?? state, readable };
};
