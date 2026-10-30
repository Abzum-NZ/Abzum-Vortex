import { useEffect, useRef } from "react";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import type { usePlacementActions } from "./use-placement-actions";

type RunBinding = ReturnType<typeof usePlacementActions>["runBinding"];

/**
 * The page's own events: the flows bound with the page as their control run when the page opens
 * (`load`), and then, for a page that shows one record, when that record is shown
 * (`record_loaded`). Each runs once per opened address.
 */
export function usePageEvents(
  model: ApplicationPageModel,
  navigationKey: string,
  runBinding: RunBinding,
) {
  const latest = useRef({ model, runBinding });
  latest.current = { model, runBinding };
  useEffect(() => {
    const { model: current, runBinding: run } = latest.current;
    const bindings = (current.bindings[current.pageId] ?? []).filter(
      (binding) => binding.messageAction === undefined,
    );
    for (const event of ["load", "record_loaded"] as const) {
      const binding = bindings.find((candidate) => candidate.event === event);
      if (binding !== undefined) void run(current.pageId, binding, {}, current.subject?.recordId);
    }
  }, [navigationKey]);
}
