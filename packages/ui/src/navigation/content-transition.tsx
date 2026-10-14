"use client";

import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, type Easing } from "motion/react";

type MotionTiming = Readonly<{ duration: number; ease: Easing }>;

const cssEasings: Readonly<Record<string, Easing>> = {
  linear: "linear",
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": "easeIn",
  "ease-out": "easeOut",
  "ease-in-out": "easeInOut",
};

/** A CSS time (`220ms` or `0.22s`) in seconds. */
const seconds = (value: string): number | undefined => {
  const match = /^(-?[\d.]+)(ms|s)$/.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? (match[2] === "ms" ? amount / 1000 : amount) : undefined;
};

/** A CSS easing (`cubic-bezier(...)` or a keyword) as a Motion easing. */
const easing = (value: string): Easing | undefined => {
  const trimmed = value.trim();
  const bezier = /^cubic-bezier\(([^)]+)\)$/.exec(trimmed);
  if (bezier === null) return cssEasings[trimmed];
  const points = bezier[1]!.split(",").map(Number);
  return points.length === 4 && points.every(Number.isFinite)
    ? (points as [number, number, number, number])
    : undefined;
};

/**
 * The platform's refresh motion token, read from the theme root this element sits in. The platform
 * stylesheet sets it to 0ms under reduced motion, so a missing or zero duration means no motion.
 */
const readRefreshTiming = (element: HTMLElement): MotionTiming | undefined => {
  const style = getComputedStyle(element);
  const duration = seconds(style.getPropertyValue("--vortex-motion-refresh"));
  const ease = easing(style.getPropertyValue("--vortex-motion-refresh-easing"));
  return duration === undefined || ease === undefined || duration <= 0
    ? undefined
    : { duration, ease };
};

/**
 * The application frame's page outlet. A new page fades in with a small rise while the previous one
 * fades out over it (it leaves the layout at once, so the new page never waits for it), both timed
 * by the platform refresh motion token; with reduced motion the change is
 * immediate. The outlet keeps the layout of the slot it stands in, so the page's placements lay out
 * exactly as they would directly in that slot.
 */
export function ContentTransition({
  transitionKey,
  busy = false,
  children,
}: Readonly<{ transitionKey: string; busy?: boolean; children: ReactNode }>): ReactElement {
  const reducedMotion = useReducedMotion();
  const outletRef = useRef<HTMLDivElement>(null);
  const [timing, setTiming] = useState<MotionTiming>();
  useLayoutEffect(() => {
    if (outletRef.current !== null) setTiming(readRefreshTiming(outletRef.current));
  }, []);
  const animated = reducedMotion !== true && timing !== undefined;
  return (
    <div
      ref={outletRef}
      data-vortex-shell-outlet=""
      className="vortex-puck-slot relative min-w-0"
      style={{ gap: "inherit" }}
      {...(busy ? { "aria-busy": true, "data-vortex-page-transition": "" } : {})}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={transitionKey}
          data-vortex-page-content=""
          className="vortex-puck-slot min-w-0"
          style={{ gap: "inherit" }}
          initial={animated ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          {...(animated ? { exit: { opacity: 0, y: -4 } } : {})}
          transition={animated ? timing : { duration: 0 }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
