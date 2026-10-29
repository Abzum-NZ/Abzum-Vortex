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
type Pending = { timer: ReturnType<typeof setTimeout>; fire: () => void };

/** Settles field changes independently and flushes the latest value when focus leaves. */
export function useFieldFlowEvents(
  navigationKey: string,
  state: FlowRuntimeState,
  runBinding: RunBinding,
  setNotice: Dispatch<SetStateAction<Notice | undefined>>,
) {
  const pending = useRef(new Map<string, Pending>());
  const latest = useRef(
    new Map<string, Extract<ControlSemanticEvent, { event: "field_changed" }>>(),
  );
  useEffect(() => {
    const held = pending.current;
    return () => {
      for (const item of held.values()) clearTimeout(item.timer);
      held.clear();
      latest.current.clear();
    };
  }, [navigationKey]);

  return useCallback(
    (placementId: string, bindings: readonly PlacementFlowBinding[]) => {
      const changed = bindingOfEvent(bindings, "field_changed");
      const focusLost = bindingOfEvent(bindings, "field_focus_lost");
      const flush = () => {
        if (changed === undefined) return;
        const item = pending.current.get(changed.bindingId);
        if (item === undefined) return;
        clearTimeout(item.timer);
        pending.current.delete(changed.bindingId);
        item.fire();
      };
      return {
        ...(changed === undefined && focusLost === undefined
          ? {}
          : {
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
                  const previous = pending.current.get(changed.bindingId);
                  if (previous !== undefined) clearTimeout(previous.timer);
                  pending.current.delete(changed.bindingId);
                  if (changed.settings.concurrency === "latest_wins")
                    state.cancel(changed.bindingId);
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
                const previous = pending.current.get(changed.bindingId);
                if (previous !== undefined) clearTimeout(previous.timer);
                pending.current.delete(changed.bindingId);
                if (changed.settings.concurrency === "latest_wins") state.cancel(changed.bindingId);
                const fire = () => {
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
                    nextCycle !== undefined && "cycle" in nextCycle ? nextCycle.cycle : undefined,
                  );
                };
                const delay = event.immediate ? 0 : changed.settings.debounceMs;
                if (delay === 0) fire();
                else {
                  const timer = setTimeout(() => {
                    pending.current.delete(changed.bindingId);
                    fire();
                  }, delay);
                  pending.current.set(changed.bindingId, { timer, fire });
                }
              },
            }),
        ...(changed === undefined && focusLost === undefined
          ? {}
          : {
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
            }),
      };
    },
    [runBinding, setNotice, state],
  );
}
