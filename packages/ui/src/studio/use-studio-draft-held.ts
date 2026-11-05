"use client";
import { useState } from "react";
import { canonicalJson } from "@vortex/platform/schema";

type HeldState<Value> = Readonly<{
  /** The draft value this state was drawn over. */
  seen: string;
  /** The draft value the control's own last edit produced. */
  ours: string | null;
  /** Counts changes of the draft value from elsewhere, so an uncontrolled control can be drawn afresh. */
  epoch: number;
  held: Readonly<{ value: Value; problem: string }> | null;
}>;

// Schema parsing can reorder object properties without changing the editor's value.
// Compare the JSON shape (omitting undefined settings) while preserving array order.
const keyOf = (value: unknown): string => canonicalJson(JSON.parse(JSON.stringify(value ?? null)));

/**
 * A structured control bound to one draft value (a field's settings, a query's filter, an action's
 * condition), for the controls that are not one text: valid input goes to the draft at once, input
 * that is not valid yet stays here with its problem. When the draft value changes from elsewhere
 * (Undo, Redo, another edit) the held input is dropped and `epoch` moves on; the control's own
 * edits, reported with `applied`, keep the control as it is.
 */
export function useStudioDraftHeld<Value>(value: Value): Readonly<{
  value: Value;
  problem: string;
  epoch: number;
  hold: (next: Value, problem: string) => void;
  /** The control's edit reached the draft, which now holds `next`. */
  applied: (next: Value) => void;
}> {
  const key = keyOf(value);
  const [state, setState] = useState<HeldState<Value>>({
    seen: key,
    ours: null,
    epoch: 0,
    held: null,
  });
  let current = state;
  if (state.seen !== key) {
    const external = state.ours !== key;
    current = {
      seen: key,
      ours: null,
      epoch: external ? state.epoch + 1 : state.epoch,
      held: null,
    };
    setState(current);
  }
  return {
    value: current.held?.value ?? value,
    problem: current.held?.problem ?? "",
    epoch: current.epoch,
    hold: (next, problem) => setState((before) => ({ ...before, held: { value: next, problem } })),
    applied: (next) => setState((before) => ({ ...before, ours: keyOf(next), held: null })),
  };
}
