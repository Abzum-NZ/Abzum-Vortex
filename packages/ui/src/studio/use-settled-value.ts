"use client";
import { useEffect, useState } from "react";

/** How long typing must pause before the reads of the whole draft are drawn for the new draft. */
const SETTLE_MS = 150;

/**
 * The value as it stood when it stopped changing for a moment. Reads of the whole draft (the
 * Outline, the reasons a block cannot be removed, the places that use a part) are drawn once a run
 * of keystrokes pauses, not between the keystrokes: while a person types, each key draws the field
 * and the canvas only.
 */
export function useSettledValue<Value>(value: Value): Value {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}
