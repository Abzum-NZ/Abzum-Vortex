import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { applyRecordsTableQueryChange, sameId } from "@vortex/platform/schema";
import type { ControlSemanticEvent, FlowIntentHost } from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import type { PageAddress } from "./page-address";
import type { PageSelection } from "./types";

/**
 * Published control values join the page address in place (no history entry), preserving unrelated
 * placement data: each dependent table starts again at page one and is read once, and every other
 * dependent placement is read again.
 */
export function usePageParameters({
  model,
  address,
  currentSearch,
  navigationKey,
  refreshPlacements,
  rereadTables,
  setSelection,
  setPanelRef,
}: Readonly<{
  model: ApplicationPageModel;
  address: PageAddress;
  currentSearch: string;
  navigationKey: string;
  refreshPlacements: (ids: readonly string[]) => Promise<void>;
  rereadTables: (placementIds: readonly string[]) => void;
  setSelection: Dispatch<SetStateAction<PageSelection>>;
  /** The flow host's panel seam, which this hook fills with the page's panel host. */
  setPanelRef: RefObject<FlowIntentHost["setPanel"]>;
}>) {
  /** The row each table's click last reported: the record a panel its flow opens shows. */
  const clickedRecords = useRef(new Map<string, string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const shown = useRef({ navigationKey, search: currentSearch });
  const observedSearch = useRef(currentSearch);
  if (observedSearch.current !== currentSearch) {
    const before = new URLSearchParams(observedSearch.current);
    const after = new URLSearchParams(currentSearch);
    observedSearch.current = currentSearch;
    for (const [name, timer] of timers.current) {
      if (before.get(name) === after.get(name)) continue;
      clearTimeout(timer);
      timers.current.delete(name);
    }
  }
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [navigationKey],
  );
  useEffect(() => {
    const previous = shown.current;
    shown.current = { navigationKey, search: currentSearch };
    if (previous.navigationKey !== navigationKey) return;
    const before = new URLSearchParams(previous.search);
    const after = new URLSearchParams(currentSearch);
    const affected = [
      ...new Set(
        Object.entries(model.pageParameters.dependents).flatMap(([name, ids]) =>
          before.get(name) === after.get(name) ? [] : ids,
        ),
      ),
    ];
    if (affected.length === 0) return;
    setSelection((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => !affected.includes(id))),
    );
    const nonTables = affected.filter((id) => !model.pageParameters.tableIds.includes(id));
    if (nonTables.length > 0) void refreshPlacements(nonTables);
  }, [currentSearch, model.pageParameters, navigationKey, refreshPlacements, setSelection]);
  const publish = useCallback(
    (placementId: string, value: string, debounce: boolean) => {
      const parameter = model.pageParameters.controls[placementId];
      if (parameter === undefined) return;
      clearTimeout(timers.current.get(parameter));
      const commit = () => {
        timers.current.delete(parameter);
        const tables = (model.pageParameters.dependents[parameter] ?? []).filter((id) =>
          model.pageParameters.tableIds.includes(id),
        );
        const changed = address.write((parameters) => {
          if ((parameters.get(parameter) ?? "") === value) return;
          if (value === "") parameters.delete(parameter);
          else parameters.set(parameter, value);
          for (const id of tables)
            applyRecordsTableQueryChange(parameters, id, {
              kind: "page",
              request: { page: 1, pageDirection: "forward" },
            });
        }, "replace");
        if (changed) rereadTables(tables);
      };
      if (debounce) timers.current.set(parameter, setTimeout(commit, 300));
      else commit();
    },
    [address, model.pageParameters, rereadTables],
  );
  const change = useCallback(
    (placementId: string, event: ControlSemanticEvent) => {
      if (event.event !== "field_changed") return;
      const value = event.value;
      const text =
        value === null
          ? ""
          : typeof value === "object"
            ? "recordId" in value
              ? value.recordId
              : ""
            : String(value);
      publish(placementId, text, model.pageParameters.controlKinds[placementId] === "text_input");
    },
    [model.pageParameters.controlKinds, publish],
  );
  // Dismissing a drawer opened by a control clears that control's selection.
  const dismiss = useCallback(
    (placementId: string) => {
      const control = model.pageParameters.drawers[placementId];
      if (control !== undefined) publish(control, "", false);
    },
    [model.pageParameters.drawers, publish],
  );
  const rowClicked = useCallback((placementId: string, recordId: string) => {
    clickedRecords.current.set(placementId, recordId);
  }, []);
  // `interface.set_panel` opens or closes a drawer through the one selection path: the drawer is
  // open exactly while the address holds a record for the control it opens with, so opening
  // publishes the clicked row's record and closing clears it.
  const setPanel = useCallback(
    (panel: string, state: string) => {
      const drawer = Object.keys(model.pageParameters.drawers).find((id) => sameId(id, panel));
      const control = drawer === undefined ? undefined : model.pageParameters.drawers[drawer];
      const recordId = control === undefined ? undefined : clickedRecords.current.get(control);
      if (control === undefined || (state === "open" && recordId === undefined)) {
        console.error(
          `[page] set_panel names no drawer opened by a clicked control: PANEL_NOT_OPENABLE ${panel}`,
        );
        return;
      }
      if (state === "open") publish(control, recordId!, false);
      else if (state === "closed") publish(control, "", false);
      else console.error(`[page] set_panel state is neither open nor closed: ${state}`);
    },
    [model.pageParameters.drawers, publish],
  );
  setPanelRef.current = setPanel;
  return useMemo(
    () => ({ change, publish, dismiss, rowClicked }),
    [change, publish, dismiss, rowClicked],
  );
}
