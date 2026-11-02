import { useEffect, useRef } from "react";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { pageRunParameter } from "../../../../../../_lib/page-run-parameter";
import type { usePlacementActions } from "./use-placement-actions";

type RunBinding = ReturnType<typeof usePlacementActions>["runBinding"];

/**
 * A page opened with `run=<token>` starts the one action binding that declares that token in its
 * `startFromAddress` setting, once, the way pressing its control does (the server still requires
 * the control on the page for this person). Only a binding that opted in can be started this way,
 * and the definition refuses the opt-in unless its flow asks (a confirmation or a form) before it
 * first changes anything, so a followed link can never change anything by itself. The flow starts
 * once the page runner is loaded, as a press would find it. The parameter leaves the address when
 * the flow has finished, or at once when nothing matched, so a reload never starts it again.
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
    const token = new URLSearchParams(window.location.search).get(pageRunParameter);
    if (token === null) return;
    const dropParameter = () => {
      const rest = new URLSearchParams(window.location.search);
      rest.delete(pageRunParameter);
      const query = rest.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${query === "" ? "" : `?${query}`}`,
      );
    };
    for (const [placementId, bindings] of Object.entries(current.bindings)) {
      const binding = bindings.find(
        (candidate) =>
          candidate.event === "action" &&
          candidate.messageAction === undefined &&
          candidate.settings.startFromAddress?.token === token,
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
        .finally(dropParameter);
      return;
    }
    console.error(`[page] no action on this page can be started from the address as "${token}"`);
    dropParameter();
  }, [navigationKey]);
}
