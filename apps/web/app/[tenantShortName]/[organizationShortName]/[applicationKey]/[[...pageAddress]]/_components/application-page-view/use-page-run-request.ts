import { useEffect, useRef } from "react";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { pageRunParameter } from "../../../../../../_lib/page-run-parameter";
import type { usePlacementActions } from "./use-placement-actions";

type RunBinding = ReturnType<typeof usePlacementActions>["runBinding"];

/**
 * A page opened with `run=<flow name>` starts the action flow of that name bound to a control of
 * the page once, the way pressing the control does (the server still requires the control on the
 * page for this person). The flow starts once the page runner is loaded, as a press would find it,
 * and the parameter leaves the address when the flow has finished, so a reload does not start it
 * again and the page the flow reports on does not change under it.
 */
export function usePageRunRequest(
  model: ApplicationPageModel,
  navigationKey: string,
  runBinding: RunBinding,
  prepare: () => Promise<void>,
) {
  const latest = useRef({ model, runBinding, prepare });
  latest.current = { model, runBinding, prepare };
  useEffect(() => {
    const { model: current, runBinding: run, prepare: ready } = latest.current;
    const parameters = new URLSearchParams(window.location.search);
    const control = parameters.get(pageRunParameter);
    if (control === null) return;
    // Placement identities are derived, so the action is named by its flow's authored name.
    for (const [placementId, bindings] of Object.entries(current.bindings)) {
      const binding = bindings.find(
        (candidate) =>
          candidate.event === "action" &&
          candidate.messageAction === undefined &&
          candidate.flowName === control,
      );
      if (binding === undefined) continue;
      const recordId = current.subject?.recordId;
      void ready()
        .then(() =>
          run(
            placementId,
            binding,
            () => (recordId === undefined ? {} : { record_id: recordId }),
            recordId,
          ),
        )
        .finally(() => {
          const rest = new URLSearchParams(window.location.search);
          rest.delete(pageRunParameter);
          const query = rest.toString();
          window.history.replaceState(
            window.history.state,
            "",
            `${window.location.pathname}${query === "" ? "" : `?${query}`}`,
          );
        });
      return;
    }
  }, [navigationKey]);
}
