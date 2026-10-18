"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PendingGesture = Readonly<{
  /** The gesture's flow is still running; the control shows busy and cannot be activated. */
  pending: boolean;
  /** True from the gesture's own event turn, before the busy state has rendered. */
  running: () => boolean;
  /** Takes what the control's event handler returned; a promise keeps the control busy. */
  track: (outcome: unknown) => void;
}>;

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as PromiseLike<unknown>).then === "function";

/**
 * The one pending state of a gesture that starts a flow, shared by action buttons and form
 * submission. An event handler returns the promise of the flow it started; the control is busy from
 * the same event turn until that promise settles, so the person sees the press in the next frame
 * and a second press cannot start the same flow again.
 */
export function usePendingGesture(): PendingGesture {
  const [pending, setPending] = useState(false);
  // Guards the gap before the busy state renders, so a second press in the same frame is ignored.
  const runningNow = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const track = useCallback((outcome: unknown) => {
    if (!isPromiseLike(outcome)) return;
    runningNow.current = true;
    setPending(true);
    const settle = (): void => {
      runningNow.current = false;
      if (mounted.current) setPending(false);
    };
    outcome.then(settle, settle);
  }, []);
  const running = useCallback(() => runningNow.current, []);
  return { pending, running, track };
}
