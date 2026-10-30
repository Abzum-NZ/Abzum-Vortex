import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  continueFlowEventCycle,
  type ControlSemanticEvent,
  type FlowRuntimeState,
} from "@vortex/ui";
import type { PlacementFlowBinding } from "../../../../../../_lib/application-page";
import { bindingOfEvent } from "./event-values";
import type { usePlacementActions } from "./use-placement-actions";
import type { Notice } from "./types";

type RunBinding = ReturnType<typeof usePlacementActions>["runBinding"];
/** Settles field changes independently and flushes the latest value when focus leaves. */
export function useFieldFlowEvents(
  navigationKey: string,
  state: FlowRuntimeState,
  runBinding: RunBinding,
  setNotice: Dispatch<SetStateAction<Notice | undefined>>,
) {
  const latest = useRef(
    new Map<string, Extract<ControlSemanticEvent, { event: "field_changed" }>>(),
  );
  useEffect(() => {
    return () => {
      latest.current.clear();
    };
  }, [navigationKey]);

  return useCallback(
    (placementId: string, bindings: readonly PlacementFlowBinding[]) => {
      const changed = bindingOfEvent(bindings, "field_changed");
      const focusLost = bindingOfEvent(bindings, "field_focus_lost");
      const flush = () => {
        if (changed === undefined) return;
        state.flush(changed.bindingId);
      };
      if (changed === undefined && focusLost === undefined) return {};
      return {
        changed: (event: ControlSemanticEvent) => {
          if (event.event !== "field_changed") return;
          latest.current.set(placementId, event);
          if (changed === undefined) return;
          const nextCycle =
            event.origin === "flow" &&
            event.cycle !== undefined &&
            event.depth === event.cycle.depth + 1
              ? continueFlowEventCycle(event.cycle, changed.flowId, changed.controlId)
              : undefined;
          if (event.origin === "flow" && (nextCycle === undefined || "reason" in nextCycle)) {
            setNotice({
              tone: "problem",
              text:
                nextCycle === undefined
                  ? "The field action stopped because its flow cycle was missing."
                  : nextCycle.reason === "flow_reentry"
                    ? "The field action stopped because it would repeat the same flow on this component."
                    : "The field action stopped after three flow-set changes.",
            });
            return;
          }
          void runBinding(
            placementId,
            changed,
            {
              field_key: event.fieldKey,
              value: event.value,
              origin: event.origin,
              depth: event.depth,
            },
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            nextCycle !== undefined && "cycle" in nextCycle ? nextCycle.cycle : undefined,
          );
          if (event.immediate) state.flush(changed.bindingId);
        },
        focusLost: (event: ControlSemanticEvent) => {
          if (event.event !== "field_focus_lost") return;
          const last = latest.current.get(placementId);
          latest.current.delete(placementId);
          flush();
          if (focusLost !== undefined)
            void runBinding(placementId, focusLost, {
              field_key: event.fieldKey,
              value: last === undefined ? event.value : last.value,
            });
        },
      };
    },
    [runBinding, setNotice, state],
  );
}
