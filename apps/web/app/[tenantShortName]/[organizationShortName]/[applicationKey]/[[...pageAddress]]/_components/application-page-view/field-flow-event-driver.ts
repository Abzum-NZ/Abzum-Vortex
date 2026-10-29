import type { ControlSemanticEvent } from "@vortex/ui";
import type { PlacementFlowBinding } from "../../../../../../_lib/application-page";
import type { usePlacementActions } from "./use-placement-actions";

type RunBinding = ReturnType<typeof usePlacementActions>["runBinding"];
type Change = Extract<ControlSemanticEvent, { event: "field_changed" }>;
type FocusLost = Extract<ControlSemanticEvent, { event: "field_focus_lost" }>;
type Pending = { timer: ReturnType<typeof setTimeout>; fire: () => void };

/** Settles each field binding independently and flushes its latest value on blur. */
export function createFieldFlowEventDriver(initialRunBinding: RunBinding) {
  let runBinding = initialRunBinding;
  const pending = new Map<string, Pending>();
  const latest = new Map<string, Change>();
  return {
    setRunBinding(next: RunBinding) {
      runBinding = next;
    },
    changed(placementId: string, binding: PlacementFlowBinding | undefined, event: Change) {
      latest.set(placementId, event);
      if (binding === undefined) return;
      const previous = pending.get(binding.bindingId);
      if (previous !== undefined) clearTimeout(previous.timer);
      pending.delete(binding.bindingId);
      const fire = () => {
        void runBinding(placementId, binding, {
          field_key: event.fieldKey,
          value: event.value,
          origin: event.origin,
          depth: event.depth,
        });
      };
      const delay = event.immediate ? 0 : binding.settings.debounceMs;
      if (delay === 0) fire();
      else {
        const timer = setTimeout(() => {
          pending.delete(binding.bindingId);
          fire();
        }, delay);
        pending.set(binding.bindingId, { timer, fire });
      }
    },
    focusLost(
      placementId: string,
      changed: PlacementFlowBinding | undefined,
      binding: PlacementFlowBinding | undefined,
      event: FocusLost,
    ) {
      const last = latest.get(placementId);
      latest.delete(placementId);
      if (changed !== undefined) {
        const item = pending.get(changed.bindingId);
        if (item !== undefined) {
          clearTimeout(item.timer);
          pending.delete(changed.bindingId);
          item.fire();
        }
      }
      if (binding !== undefined)
        void runBinding(placementId, binding, {
          field_key: event.fieldKey,
          value: last === undefined ? event.value : last.value,
        });
    },
    dispose() {
      for (const item of pending.values()) clearTimeout(item.timer);
      pending.clear();
      latest.clear();
    },
  };
}

export type FieldFlowEventDriver = ReturnType<typeof createFieldFlowEventDriver>;
