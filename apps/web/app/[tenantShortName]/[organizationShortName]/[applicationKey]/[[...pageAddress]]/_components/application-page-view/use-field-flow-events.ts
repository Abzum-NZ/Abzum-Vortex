import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { ControlSemanticEvent, FlowRuntimeState } from "@vortex/ui";
import type { PlacementFlowBinding } from "../../../../../../_lib/application-page";
import { bindingOfEvent } from "./event-values";
import type { FieldFlowEventDriver } from "./field-flow-event-driver";
import type { Notice } from "./types";
import type { usePlacementActions } from "./use-placement-actions";

type RunBinding = ReturnType<typeof usePlacementActions>["runBinding"];

/** Loads the field event driver only when a bound field first raises an event. */
export function useFieldFlowEvents(
  navigationKey: string,
  state: FlowRuntimeState,
  runBinding: RunBinding,
  setNotice: Dispatch<SetStateAction<Notice | undefined>>,
) {
  const driver = useRef<Promise<FieldFlowEventDriver> | undefined>(undefined);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
      const held = driver.current;
      driver.current = undefined;
      if (held !== undefined)
        void held.then(
          (value) => value.dispose(),
          () => {},
        );
    },
    [navigationKey],
  );

  return useCallback(
    (placementId: string, bindings: readonly PlacementFlowBinding[]) => {
      const changed = bindingOfEvent(bindings, "field_changed");
      const focusLost = bindingOfEvent(bindings, "field_focus_lost");
      if (changed === undefined && focusLost === undefined) return {};
      const invoke = (run: (driver: FieldFlowEventDriver) => void) => {
        const currentGeneration = generation.current;
        const held = (driver.current ??= import("./field-flow-event-driver").then((module) =>
          module.createFieldFlowEventDriver(runBinding),
        ));
        void held.then(
          (value) => {
            if (currentGeneration !== generation.current) return;
            value.setRunBinding(runBinding);
            run(value);
          },
          (error: unknown) => {
            if (currentGeneration !== generation.current) return;
            if (driver.current === held) driver.current = undefined;
            console.error(
              `[flow] field event driver failed: ${error instanceof Error ? error.name : "unknown"}`,
            );
            setNotice({ tone: "problem", text: "The field action could not start. Try again." });
          },
        );
      };
      return {
        changed: (event: ControlSemanticEvent) => {
          if (event.event !== "field_changed") return;
          if (changed?.settings.concurrency === "latest_wins") state.cancel(changed.bindingId);
          invoke((value) => value.changed(placementId, changed, event));
        },
        focusLost: (event: ControlSemanticEvent) => {
          if (event.event !== "field_focus_lost") return;
          invoke((value) => value.focusLost(placementId, changed, focusLost, event));
        },
      };
    },
    [runBinding, setNotice, state],
  );
}
