import { useCallback, useEffect, useRef } from "react";
import { toast } from "@vortex/ui/components/sonner";
import type { DisplaySemanticEvent } from "@vortex/ui";
import {
  readRecordsTableAddressedQuery,
  type GridLayoutCommitResult,
  type GridViewCommand,
  type GridViewCommandResult,
  type GridLayout,
  type GridViewDocument,
  type RecordsTableQueryChange,
} from "@vortex/platform/schema";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { commitGridLayout, commitGridView } from "../../grid-layout-action";
import { tablePayloadFor } from "./placement-helpers";

const UNAVAILABLE: GridLayoutCommitResult = Object.freeze({ outcome: "unavailable" });
const VIEW_UNAVAILABLE: GridViewCommandResult = Object.freeze({ outcome: "unavailable" });

/**
 * Stores each data grid's layout and saved views for the person. A committed layout gesture is one
 * scoped write and never a route refresh; it reads no records. The grid requests its projection
 * once its pending writes have finished if it needs columns that are not loaded. A conflict (a
 * newer layout from another tab) and a failed write are told in a notice. A stored layout the
 * current release can no longer apply is reset through that same writer, with a notice saying why.
 *
 * Saved views are opened by the address (the table rereads on the server), and created, replaced,
 * renamed, shared and deleted through one scoped write each; none of them reads records except the
 * grid's own placement reread that follows.
 */
export function useGridLayout({
  model,
  currentData,
  openTableView,
  changeTableQuery,
  refreshPlacements,
}: Readonly<{
  model: ApplicationPageModel;
  currentData: ApplicationPageModel["data"];
  openTableView: (placementId: string, viewId: string | null) => void;
  changeTableQuery: (
    placementId: string,
    change: Exclude<RecordsTableQueryChange, { kind: "page" }>,
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
                    basedOnViewId: layoutOf(placementId)?.views?.selected?.viewId ?? null,
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
      if (layout === undefined || !layout.reset || !layout.persisted || layout.revision === null)
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

  /** The grid as it is now, as a view document: the given layout and the address's query state. */
  const documentOf = useCallback(
    (placementId: string, layout: GridLayout): GridViewDocument | undefined => {
      const query = readRecordsTableAddressedQuery(placementId, [
        ...new URLSearchParams(window.location.search),
      ]);
      if (query === undefined) return undefined;
      return {
        columns: layout.columns,
        ...(layout.density === undefined ? {} : { density: layout.density }),
        ...(query.sort.length === 0 ? {} : { sort: [...query.sort] }),
        ...(query.filters.length === 0 ? {} : { filters: [...query.filters] }),
        ...(query.search === null ? {} : { search: query.search }),
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
    else toast.error("The view could not be saved.");
  }, []);

  /** Removes the person's own arrangement, so the view (or the authored layout) shows as it is. */
  const dropOwnLayout = useCallback(
    async (placementId: string): Promise<void> => {
      const revision = layoutOf(placementId)?.revision ?? null;
      if (revision === null) return;
      await commitGridLayout(address.current, {
        kind: "reset",
        placementId,
        expectedRevision: revision,
      }).catch((error: unknown) => {
        console.error("[page] grid layout not reset", error);
      });
    },
    [layoutOf],
  );

  /** Records that the person's arrangement now is the view they just saved. */
  const adoptOwnLayout = useCallback(
    async (placementId: string, viewId: string, document: GridViewDocument): Promise<void> => {
      const state = layoutOf(placementId);
      if (state === undefined) return;
      await commitGridLayout(address.current, {
        kind: "write",
        placementId,
        queryId: state.queryId,
        expectedRevision: state.revision,
        basedOnViewId: viewId,
        layout: {
          columns: document.columns,
          ...(document.density === undefined ? {} : { density: document.density }),
        },
      }).catch((error: unknown) => {
        console.error("[page] grid layout not stored", error);
      });
    },
    [layoutOf],
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
        case "select":
          // An arrangement made from this view would hide the view's own: it goes first.
          if (command.viewId !== null && state.views.basedOnViewId === command.viewId)
            await dropOwnLayout(placementId);
          openTableView(placementId, command.viewId);
          return { outcome: "done" };
        case "reset":
          await dropOwnLayout(placementId);
          openTableView(placementId, null);
          return { outcome: "done" };
        case "create": {
          const document = documentOf(placementId, command.layout);
          if (document === undefined) return VIEW_UNAVAILABLE;
          const result = await send({ kind: "create", name: command.name, document });
          tellOutcome(result, "View saved.");
          if (result.outcome === "done" && result.viewId !== undefined) {
            await adoptOwnLayout(placementId, result.viewId, document);
            changeTableQuery(placementId, { kind: "view", viewId: result.viewId });
          }
          return result;
        }
        case "save": {
          const document = documentOf(placementId, command.layout);
          if (document === undefined) return VIEW_UNAVAILABLE;
          const result = await send({
            kind: "save",
            viewId: command.viewId,
            expectedRevision: command.expectedRevision,
            document,
          });
          tellOutcome(result, "View saved.");
          if (result.outcome === "done") await adoptOwnLayout(placementId, command.viewId, document);
          if (result.outcome !== "unavailable") await refreshPlacements([placementId]);
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
          if (result.outcome !== "unavailable") await refreshPlacements([placementId]);
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
          if (result.outcome !== "unavailable") await refreshPlacements([placementId]);
          return result;
        }
        case "delete": {
          const result = await send({
            kind: "delete",
            viewId: command.viewId,
            expectedRevision: command.expectedRevision,
          });
          tellOutcome(result, "View deleted.");
          if (result.outcome === "done" && state.views.selected?.viewId === command.viewId)
            openTableView(placementId, null);
          else if (result.outcome !== "unavailable") await refreshPlacements([placementId]);
          return result;
        }
        case "share_targets":
          return send({ kind: "share_targets" });
      }
    },
    [
      adoptOwnLayout,
      changeTableQuery,
      documentOf,
      dropOwnLayout,
      layoutOf,
      openTableView,
      refreshPlacements,
      tellOutcome,
    ],
  );

  return { commitLayout, runViewCommand };
}
