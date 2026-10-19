import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { applyRecordsTableQueryChange } from "@vortex/platform/schema";
import type { ControlSemanticEvent } from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";

/** Published control values use shallow history, preserving unrelated placement data. */
export function usePageParameters({
  model,
  currentSearch,
  navigationKey,
  refreshPlacements,
  setSelection,
}: Readonly<{
  model: ApplicationPageModel;
  currentSearch: string;
  navigationKey: string;
  refreshPlacements: (ids: readonly string[]) => Promise<void>;
  setSelection: Dispatch<SetStateAction<Readonly<Record<string, readonly string[]>>>>;
}>) {
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
        const address = new URLSearchParams(window.location.search);
        if ((address.get(parameter) ?? "") === value) return;
        if (value === "") address.delete(parameter);
        else address.set(parameter, value);
        for (const id of (model.pageParameters.dependents[parameter] ?? []).filter((id) =>
          model.pageParameters.tableIds.includes(id),
        ))
          applyRecordsTableQueryChange(address, id, {
            kind: "page",
            request: { page: 1, pageDirection: "forward" },
          });
        const query = address.toString();
        window.history.replaceState(
          null,
          "",
          query === "" ? window.location.pathname : `?${query}`,
        );
      };
      if (debounce) timers.current.set(parameter, setTimeout(commit, 300));
      else commit();
    },
    [model.pageParameters],
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
  return { change, publish };
}
