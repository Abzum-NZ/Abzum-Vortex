"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type PendingGesture = Readonly<{
  /** At least one gesture is still running; the control shows busy. */
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
 * the same event turn until every tracked promise settles, so the person sees pending work in the
 * next frame. The form or shared flow scheduler decides whether another gesture may start.
 */
export function usePendingGesture(): PendingGesture {
  const [pending, setPending] = useState(false);
  // Counts from the event turn, before the busy state has rendered.
  const runningNow = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const track = useCallback((outcome: unknown) => {
    if (!isPromiseLike(outcome)) return;
    runningNow.current += 1;
    setPending(true);
    const settle = (): void => {
      runningNow.current -= 1;
      if (mounted.current && runningNow.current === 0) setPending(false);
    };
    outcome.then(settle, settle);
  }, []);
  const running = useCallback(() => runningNow.current > 0, []);
  return { pending, running, track };
}
