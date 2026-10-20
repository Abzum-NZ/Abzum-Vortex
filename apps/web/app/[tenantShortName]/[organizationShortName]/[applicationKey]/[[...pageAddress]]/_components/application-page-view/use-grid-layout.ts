import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { toast } from "@vortex/ui/components/sonner";
import type { DisplaySemanticEvent } from "@vortex/ui";
import {
  encodeRecordsTableFieldFilter,
  canonicalJson,
  readRecordsTableView,
  type GridLayout,
  type GridLayoutCommitResult,
  type GridLayoutState,
  type GridViewCommand,
  type GridViewCommandResult,
  type GridViewDocument,
  type GridViewItem,
  type SelectedGridView,
} from "@vortex/platform/schema";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { commitGridLayout, commitGridView } from "../../grid-layout-action";
import { tablePayloadFor } from "./placement-helpers";
import type { RefreshedPlacementData } from "./types";

const UNAVAILABLE: GridLayoutCommitResult = Object.freeze({ outcome: "unavailable" });
const VIEW_UNAVAILABLE: GridViewCommandResult = Object.freeze({ outcome: "unavailable" });

/**
 * Stores each data grid's layout and saved views for the person. A committed layout gesture is one
 * scoped write and never a route refresh; it reads no records. The grid requests its projection
 * once its pending writes have finished if it needs columns that are not loaded. A conflict (a
 * newer layout from another tab) and a failed write are told in a notice. A stored layout the
 * current release can no longer apply is reset through that same writer, with a notice saying why.
 *
 * Saved views are opened by the address (the table rereads once on the server, because the view
 * changes the query or the projection), and created, replaced, renamed, shared and deleted through
 * one scoped write each. None of those reads records: the page's own copy of the views list is
 * updated from what the write answered.
 */
export function useGridLayout({
  model,
  currentData,
  navigationKey,
  setRefreshedPlacementData,
  openTableView,
  selectTableViewInPlace,
  refreshPlacements,
}: Readonly<{
  model: ApplicationPageModel;
  currentData: ApplicationPageModel["data"];
  navigationKey: string;
  setRefreshedPlacementData: Dispatch<SetStateAction<RefreshedPlacementData | undefined>>;
  openTableView: (placementId: string, viewId: string | null) => void;
  selectTableViewInPlace: (
    placementId: string,
    viewId: string | null,
    document?: GridViewDocument,
  ) => void;
  refreshPlacements: (placementIds: readonly string[]) => Promise<void>;
}>) {
  const { tenantShortName, organizationShortName, applicationKey, pageKey } = model.invocation;
  const address = useRef({ tenantShortName, organizationShortName, applicationKey, pageKey });
  address.current = { tenantShortName, organizationShortName, applicationKey, pageKey };
  const latestData = useRef(currentData);
  latestData.current = currentData;

  /** The grid's current layout state as the page last read it. */
  const layoutOf = useCallback((placementId: string) => {
    const held = Object.keys(latestData.current).find(
      (candidate) => candidate.toLowerCase() === placementId.toLowerCase(),
    );
    return held === undefined ? undefined : tablePayloadFor(latestData.current[held])?.layout;
  }, []);

  /**
   * Changes the grid's layout state in the page's own copy of its data, so the views list, the
   * selected view and the stored layout's revision follow a write without reading any record.
   */
  const patchLayoutState = useCallback(
    (placementId: string, update: (layout: GridLayoutState) => GridLayoutState): void => {
      const held = Object.keys(latestData.current).find(
        (candidate) => candidate.toLowerCase() === placementId.toLowerCase(),
      );
      if (held === undefined) return;
      setRefreshedPlacementData((current) => {
        // Successive patches build on one another, so the latest patched copy wins over the read.
        const prior = current?.navigationKey === navigationKey ? current : undefined;
        const data = prior?.data[held] ?? latestData.current[held];
        if (
          data === undefined ||
          data.status !== "ready" ||
          typeof data.values !== "object" ||
          data.values === null ||
          !("layout" in data.values)
        )
          return current;
        const values = data.values as Readonly<{ layout: GridLayoutState }>;
        return {
          navigationKey,
          data: {
            ...(prior?.data ?? {}),
            [held]: { ...data, values: { ...values, layout: update(values.layout) } },
          },
          editFormBaselines: { ...(prior?.editFormBaselines ?? {}) },
          ...(prior?.subject === undefined ? {} : { subject: prior.subject }),
          ...(prior?.content === undefined ? {} : { content: prior.content }),
        };
      });
    },
    [navigationKey, setRefreshedPlacementData],
  );

  /**
   * A write's change to the views list, applied now and kept for a few seconds: a grid read that
   * was already under way when the write answered lands with the views it read before the write,
   * and would otherwise undo the change on screen. Whenever the page's data changes and no longer
   * shows the change, it is applied again.
   */
  const trackedPatches = useRef(
    new Map<
      string,
      Readonly<{
        placementId: string;
        expires: number;
        apply: (layout: GridLayoutState) => GridLayoutState;
        done: (layout: GridLayoutState) => boolean;
      }>
    >(),
  );
  const patchViews = useCallback(
    (
      placementId: string,
      viewId: string,
      apply: (layout: GridLayoutState) => GridLayoutState,
      done: (layout: GridLayoutState) => boolean,
    ): void => {
      trackedPatches.current.set(`${placementId.toLowerCase()}:${viewId}`, {
        placementId,
        expires: Date.now() + 15_000,
        apply,
        done,
      });
      patchLayoutState(placementId, apply);
    },
    [patchLayoutState],
  );
  useEffect(() => {
    for (const [key, patch] of trackedPatches.current) {
      if (patch.expires < Date.now()) {
        trackedPatches.current.delete(key);
        continue;
      }
      const layout = layoutOf(patch.placementId);
      if (layout?.views !== undefined && !patch.done(layout))
        patchLayoutState(patch.placementId, patch.apply);
    }
  }, [currentData, layoutOf, patchLayoutState]);

  const commitLayout = useCallback(
    async (placementId: string, event: DisplaySemanticEvent): Promise<GridLayoutCommitResult> => {
      if (event.event !== "columns_changed") return UNAVAILABLE;
      // Nothing stored and nothing to store: the authored layout is already the stored state.
      const result: GridLayoutCommitResult =
        event.layout === null && event.expectedRevision === null
          ? { outcome: "reset" }
          : await commitGridLayout(
              address.current,
              event.layout === null
                ? { kind: "reset", placementId, expectedRevision: event.expectedRevision }
                : {
                    kind: "write",
                    placementId,
                    queryId: event.queryId,
                    expectedRevision: event.expectedRevision,
                    // A layout arranged while a view is open derives from that view.
                    basedOnViewId:
                      layoutOf(placementId)?.views?.selected?.scope === "default"
                        ? null
                        : (layoutOf(placementId)?.views?.selected?.viewId ?? null),
                    layout: event.layout,
                  },
            ).catch((error: unknown) => {
              console.error("[page] grid layout not stored", error);
              return UNAVAILABLE;
            });
      if (result.outcome === "conflict")
        toast.info("This layout was changed in another tab. The latest layout is shown.");
      if (result.outcome === "unavailable")
        toast.error("Your layout could not be saved. It stays as it is on this screen.");
      return result;
    },
    [layoutOf],
  );

  // A stored layout the release no longer allows (a column was removed, or the grid reads another
  // query) was not applied: say so once. The grid resets it through its serial writer.
  const noticed = useRef(new Set<string>());
  useEffect(() => {
    for (const [placementId, data] of Object.entries(currentData)) {
      const layout = tablePayloadFor(data)?.layout;
      if (
        layout === undefined ||
        !layout.reset ||
        layout.storage !== "personal" ||
        layout.revision === null
      )
        continue;
      const key = `${placementId.toLowerCase()}:${layout.revision}`;
      if (noticed.current.has(key)) continue;
      noticed.current.add(key);
      toast.info("The saved layout was reset because a column is no longer available.");
    }
  }, [currentData]);

  // An addressed view that cannot be applied is told once: it was removed or is not shared with the
  // person, or its stored filter is malformed and applying it would widen the rows.
  useEffect(() => {
    for (const [placementId, data] of Object.entries(currentData)) {
      const views = tablePayloadFor(data)?.layout.views;
      if (views === undefined || views.notice === null) continue;
      const key = `${placementId.toLowerCase()}:${views.notice}`;
      if (noticed.current.has(key)) continue;
      noticed.current.add(key);
      if (views.notice === "needs_fixing") toast.error("This view needs fixing.");
      else toast.info("This view is not available. The table is shown without it.");
    }
  }, [currentData]);

  /**
   * The grid as it is now, as a view document: the given layout, the address's query state and the
   * given formatting rules (formatting is a part of the view, never of the address).
   */
  const documentOf = useCallback(
    (
      placementId: string,
      layout: GridLayout,
      formatting?: readonly NonNullable<GridViewDocument["formatting"]>[number][],
    ): GridViewDocument | undefined => {
      const key = Object.keys(latestData.current).find(
        (key) => key.toLowerCase() === placementId.toLowerCase(),
      );
      const payload = key === undefined ? undefined : tablePayloadFor(latestData.current[key]);
      if (payload === undefined) return undefined;
      const query = {
        sort: payload.sort?.explicit === true ? payload.sort.keys : [],
        filters: (payload.narrowing?.filters ?? []).map((filter) => ({
          fieldId: filter.fieldId,
          filter: encodeRecordsTableFieldFilter(filter.filter),
        })),
        search: payload.narrowing?.search ?? null,
      };
      return {
        columns: layout.columns,
        ...(layout.density === undefined ? {} : { density: layout.density }),
        ...(query.sort.length === 0 ? {} : { sort: [...query.sort] }),
        ...(query.filters.length === 0 ? {} : { filters: [...query.filters] }),
        ...(query.search === null ? {} : { search: query.search }),
        ...(formatting === undefined || formatting.length === 0 ? {} : { formatting: [...formatting] }),
      };
    },
    [],
  );

  const tellOutcome = useCallback((result: GridViewCommandResult, done: string): void => {
    if (result.outcome === "done") toast.success(done);
    else if (result.outcome === "conflict")
      toast.info("This view was changed elsewhere. The latest version is shown.");
    else if (result.outcome === "forbidden") toast.error("You may not change this view.");
    else if (result.outcome === "limit")
      toast.error("You have reached the limit of 50 saved views for this table.");
    else if (result.outcome === "formatting_refused") toast.error(result.reason);
    else toast.error("The view could not be saved.");
  }, []);

  /**
   * Stores the person's own layout (or removes it), made from the revision the page was read with.
   * The grid's own writer may have stored a newer one since; the person's current arrangement is
   * what they see and want, so one retry is made from the revision the store reports.
   */
  const writeOwnLayout = useCallback(
    async (
      placementId: string,
      change: (expectedRevision: number | null) => Record<string, unknown> | undefined,
    ): Promise<GridLayoutCommitResult> => {
      let expected = layoutOf(placementId)?.revision ?? null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const body = change(expected);
        if (body === undefined) return { outcome: "reset" };
        const result = await commitGridLayout(address.current, { placementId, ...body }).catch(
          (error: unknown) => {
            console.error("[page] grid layout not stored", error);
            return UNAVAILABLE;
          },
        );
        if (result.outcome !== "conflict") return result;
        expected = result.stored?.revision ?? null;
      }
      return UNAVAILABLE;
    },
    [layoutOf],
  );

  /** Removes the person's own arrangement, so the view (or the authored layout) shows as it is. */
  const dropOwnLayout = useCallback(
    async (placementId: string): Promise<void> => {
      await writeOwnLayout(placementId, (expectedRevision) =>
        expectedRevision === null ? undefined : { kind: "reset", expectedRevision },
      );
    },
    [writeOwnLayout],
  );

  /**
   * Records that the person's arrangement now is the view they just saved, and keeps the page's
   * copy of the layout's revision current so the grid's next layout write is made from it.
   */
  const adoptOwnLayout = useCallback(
    async (
      placementId: string,
      viewId: string | null,
      document: GridViewDocument,
    ): Promise<void> => {
      const state = layoutOf(placementId);
      if (state === undefined) return;
      const arranged: GridLayout = {
        columns: document.columns,
        ...(document.density === undefined ? {} : { density: document.density }),
      };
      const stored = await writeOwnLayout(placementId, (expectedRevision) => ({
        kind: "write",
        queryId: state.queryId,
        expectedRevision,
        basedOnViewId: viewId,
        layout: arranged,
      }));
      if (stored.outcome === "saved")
        patchLayoutState(placementId, (layout) => ({
          ...layout,
          revision: stored.revision,
          layout: arranged,
          ...(layout.views === undefined
            ? {}
            : { views: { ...layout.views, basedOnViewId: viewId } }),
        }));
    },
    [layoutOf, patchLayoutState, writeOwnLayout],
  );

  /** Applies a view's new revision (and changes) to its list entry and, if open, to the selected view. */
  const patchViewState = useCallback(
    (
      placementId: string,
      viewId: string,
      revision: number,
      selectedChange: (selected: SelectedGridView) => SelectedGridView,
      itemChange: Partial<GridViewItem> = {},
    ): void =>
      patchViews(
        placementId,
        viewId,
        (layout) => {
          if (layout.views === undefined) return layout;
          const { selected } = layout.views;
          return {
            ...layout,
            views: {
              ...layout.views,
              items: layout.views.items.map((item) =>
                item.viewId === viewId && item.revision < revision
                  ? { ...item, ...itemChange, revision }
                  : item,
              ),
              selected:
                selected !== null && selected.viewId === viewId && selected.revision < revision
                  ? { ...selectedChange(selected), revision }
                  : selected,
            },
          };
        },
        (layout) =>
          (layout.views?.items.find((item) => item.viewId === viewId)?.revision ?? 0) >= revision,
      ),
    [patchViews],
  );

  /** Another tab changed the view first: the grid reads it again once, so the latest shows. */
  const reopenAfterConflict = useCallback(
    (placementId: string): void => {
      void refreshPlacements([placementId]);
    },
    [refreshPlacements],
  );

  const runViewCommand = useCallback(
    async (placementId: string, command: GridViewCommand): Promise<GridViewCommandResult> => {
      const state = layoutOf(placementId);
      if (state?.views === undefined) return VIEW_UNAVAILABLE;
      const send = (change: Record<string, unknown>): Promise<GridViewCommandResult> =>
        commitGridView(address.current, { placementId, ...change }).catch((error: unknown) => {
          console.error("[page] grid view not stored", error);
          return VIEW_UNAVAILABLE;
        });
      switch (command.kind) {
        case "select": {
          if (command.viewId === null) {
            await dropOwnLayout(placementId);
            openTableView(placementId, null);
            return { outcome: "done" };
          }
          const opened = await send({ kind: "open", viewId: command.viewId });
          if (opened.outcome !== "selected") {
            tellOutcome(opened, "");
            return opened;
          }
          const current = documentOf(
            placementId,
            state.layout,
            state.views.selected?.document.formatting,
          );
          const selected = opened.selected;
          // Rows carry the formatting the server evaluated, so a view with other rules is read.
          const queryKey = (document: GridViewDocument) =>
            canonicalJson({
              sort: document.sort ?? [],
              filters: [...(document.filters ?? [])].sort((a, b) =>
                a.fieldId.localeCompare(b.fieldId),
              ),
              search: document.search ?? null,
              formatting: document.formatting ?? [],
            });
          const visible = new Set(
            current?.columns.filter((column) => column.visible).map((column) => column.fieldId),
          );
          const layoutOnly =
            current !== undefined &&
            queryKey(current) === queryKey(selected.document) &&
            selected.document.columns.every(
              (column) => !column.visible || visible.has(column.fieldId),
            );
          if (layoutOnly) {
            await adoptOwnLayout(
              placementId,
              selected.scope === "default" ? null : selected.viewId,
              selected.document,
            );
            selectTableViewInPlace(placementId, selected.viewId);
            patchLayoutState(placementId, (layout) =>
              layout.views === undefined
                ? layout
                : {
                    ...layout,
                    views: { ...layout.views, selected, canShare: opened.canShare, notice: null },
                  },
            );
          } else {
            if (state.views.basedOnViewId === command.viewId) await dropOwnLayout(placementId);
            openTableView(placementId, command.viewId);
          }
          return { outcome: "done" };
        }
        case "reset":
          await dropOwnLayout(placementId);
          openTableView(placementId, null);
          return { outcome: "done" };
        case "create": {
          const document = documentOf(placementId, command.layout, command.formatting);
          if (document === undefined) return VIEW_UNAVAILABLE;
          const result = await send({ kind: "create", name: command.name, document });
          tellOutcome(result, "View saved.");
          if (
            result.outcome === "done" &&
            result.viewId !== undefined &&
            result.revision !== undefined
          ) {
            const item: GridViewItem = {
              viewId: result.viewId,
              name: command.name,
              scope: "personal",
              mine: true,
              revision: result.revision,
            };
            await adoptOwnLayout(placementId, result.viewId, document);
            // The grid already shows exactly this view, so it is selected without a read.
            selectTableViewInPlace(placementId, result.viewId);
            patchViews(
              placementId,
              result.viewId,
              (layout) =>
                layout.views === undefined
                  ? layout
                  : {
                      ...layout,
                      views: {
                        ...layout.views,
                        items: layout.views.items.some((held) => held.viewId === item.viewId)
                          ? layout.views.items
                          : [...layout.views.items, item],
                        // Only while the address still names the new view: the person may move on.
                        selected:
                          readRecordsTableView(placementId, [
                            ...new URLSearchParams(window.location.search),
                          ])?.viewId === item.viewId
                            ? {
                                ...item,
                                document,
                                hidden: { columns: 0, filters: 0, sort: 0, formatting: 0 },
                                sharing: { organization: false, roleIds: [], groupIds: [] },
                              }
                            : layout.views.selected,
                        notice: null,
                      },
                    },
              (layout) => layout.views?.items.some((held) => held.viewId === item.viewId) === true,
            );
          }
          return result;
        }
        case "save": {
          const document = documentOf(placementId, command.layout, command.formatting);
          if (document === undefined) return VIEW_UNAVAILABLE;
          const result = await send({
            kind: "save",
            viewId: command.viewId,
            expectedRevision: command.expectedRevision,
            document,
          });
          tellOutcome(result, "View saved.");
          if (result.outcome === "done" && result.revision !== undefined) {
            patchViewState(placementId, command.viewId, result.revision, (selected) => ({
              ...selected,
              document,
              hidden: { columns: 0, filters: 0, sort: 0, formatting: 0 },
            }));
            await adoptOwnLayout(placementId, command.viewId, document);
            // The server evaluates the rules, so the rows are read once when they changed.
            if (
              canonicalJson(document.formatting ?? []) !==
              canonicalJson(state.views.selected?.document.formatting ?? [])
            )
              await refreshPlacements([placementId]);
          } else if (result.outcome === "conflict") reopenAfterConflict(placementId);
          return result;
        }
        case "rename": {
          const result = await send({
            kind: "rename",
            viewId: command.viewId,
            expectedRevision: command.expectedRevision,
            name: command.name,
          });
          tellOutcome(result, "View renamed.");
          if (result.outcome === "done" && result.revision !== undefined)
            patchViewState(
              placementId,
              command.viewId,
              result.revision,
              (selected) => ({ ...selected, name: command.name }),
              { name: command.name },
            );
          else if (result.outcome === "conflict") reopenAfterConflict(placementId);
          return result;
        }
        case "share": {
          const result = await send({
            kind: "share",
            viewId: command.viewId,
            expectedRevision: command.expectedRevision,
            sharing: command.sharing,
          });
          tellOutcome(result, "Sharing updated.");
          if (result.outcome === "done" && result.revision !== undefined) {
            const scope =
              command.sharing.organization ||
              command.sharing.roleIds.length > 0 ||
              command.sharing.groupIds.length > 0
                ? ("shared" as const)
                : ("personal" as const);
            patchViewState(
              placementId,
              command.viewId,
              result.revision,
              (selected) => ({ ...selected, scope, sharing: command.sharing }),
              { scope },
            );
          } else if (result.outcome === "conflict") reopenAfterConflict(placementId);
          return result;
        }
        case "delete": {
          const result = await send({
            kind: "delete",
            viewId: command.viewId,
            expectedRevision: command.expectedRevision,
          });
          tellOutcome(result, "View deleted.");
          if (result.outcome === "done") {
            if (state.views.selected?.viewId === command.viewId) {
              selectTableViewInPlace(placementId, null, documentOf(placementId, state.layout));
              if (state.views.selected.document.formatting !== undefined)
                void refreshPlacements([placementId]);
            }
            patchViews(
              placementId,
              command.viewId,
              (layout) =>
                layout.views === undefined
                  ? layout
                  : {
                      ...layout,
                      views: {
                        ...layout.views,
                        items: layout.views.items.filter((item) => item.viewId !== command.viewId),
                        selected:
                          layout.views.selected?.viewId === command.viewId
                            ? null
                            : layout.views.selected,
                        basedOnViewId:
                          layout.views.basedOnViewId === command.viewId
                            ? null
                            : layout.views.basedOnViewId,
                      },
                    },
              (layout) => !layout.views?.items.some((item) => item.viewId === command.viewId),
            );
          } else if (result.outcome === "conflict") reopenAfterConflict(placementId);
          return result;
        }
        case "share_targets":
          return send({ kind: "share_targets" });
      }
    },
    [
      adoptOwnLayout,
      documentOf,
      dropOwnLayout,
      layoutOf,
      openTableView,
      patchViews,
      patchViewState,
      refreshPlacements,
      reopenAfterConflict,
      selectTableViewInPlace,
      tellOutcome,
    ],
  );

  return { commitLayout, runViewCommand };
}
