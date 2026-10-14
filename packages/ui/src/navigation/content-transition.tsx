"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { motion, useReducedMotion, type Easing } from "motion/react";

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

const PagePresenceContext = createContext(true);

/**
 * Whether the page content this is called from is the outlet's current page. It is false only for
 * the one page that is leaving (still mounted while it fades out), which stops following the router
 * and stops registering with the frame.
 */
export const usePagePresence = (): boolean => useContext(PagePresenceContext);

/** One mounted page of the outlet: its identity for this mount and what it last rendered. */
type LeavingPage = Readonly<{ id: string; node: ReactNode }>;
type OutletState = Readonly<{
  transitionKey: string;
  generation: number;
  /** The page that is fading out, or none. There is never more than one. */
  leaving: LeavingPage | undefined;
}>;

const pageMountId = (transitionKey: string, generation: number): string =>
  `${generation}:${transitionKey}`;

/**
 * The application frame's page outlet. Exactly one page is current. When the page changes, the
 * previous page stays mounted only while it fades out over the new one (out of the layout, so the
 * new page never waits for it), and it is removed once the platform refresh motion token's duration
 * has passed. A further change while a page is still leaving removes that page at once and lets the
 * page just replaced leave instead, so rapid changes never stack pages. With reduced motion the
 * change is immediate and nothing leaves. The outlet's state follows the committed render only, so
 * a page change React abandons (an interrupted navigation) leaves nothing behind. While the next
 * page is being fetched (`busy`) the current page stays in place and a thin progress line runs
 * along the top of the outlet; it appears only once the wait is noticeable. The outlet keeps
 * the layout of the slot it stands in, so the page's placements lay out exactly as they would
 * directly in that slot.
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

  // What the current page last rendered, as committed: the leaving copy keeps showing it.
  const committed = useRef<ReactNode>(children);
  useLayoutEffect(() => {
    committed.current = children;
  });
  const [state, setState] = useState<OutletState>(() => ({
    transitionKey,
    generation: 0,
    leaving: undefined,
  }));
  let current = state;
  if (state.transitionKey !== transitionKey) {
    // A page change: the page that was current leaves (replacing any page still leaving) and a new
    // mount of the next page enters. It is derived while rendering, so it commits with the change
    // or is discarded with it.
    current = {
      transitionKey,
      generation: state.generation + 1,
      leaving: animated
        ? { id: pageMountId(state.transitionKey, state.generation), node: committed.current }
        : undefined,
    };
    setState(current);
  }
  const leavingId = current.leaving?.id;
  useEffect(() => {
    if (leavingId === undefined) return;
    // The leaving page is removed when its fade has run, whatever the animation itself reports.
    const timer = window.setTimeout(
      () =>
        setState((latest) =>
          latest.leaving?.id === leavingId ? { ...latest, leaving: undefined } : latest,
        ),
      (timing?.duration ?? 0) * 1000 + 50,
    );
    return () => window.clearTimeout(timer);
  }, [leavingId, timing]);

  return (
    <div
      ref={outletRef}
      data-vortex-shell-outlet=""
      className="vortex-puck-slot relative min-w-0"
      style={{ gap: "inherit" }}
      {...(busy ? { "aria-busy": true, "data-vortex-page-transition": "" } : {})}
    >
      {busy ? <div data-vortex-page-progress="" aria-hidden /> : null}
      {current.leaving === undefined ? null : (
        // The same key the page had while current, so the leaving page keeps its mounted tree.
        <motion.div
          key={current.leaving.id}
          data-vortex-page-content=""
          data-vortex-page-leaving=""
          aria-hidden
          inert
          className="vortex-puck-slot pointer-events-none absolute inset-x-0 top-0 min-w-0"
          style={{ gap: "inherit" }}
          animate={{ opacity: 0, y: -4 }}
          transition={animated ? timing : { duration: 0 }}
        >
          <PagePresenceContext.Provider value={false}>
            {current.leaving.node}
          </PagePresenceContext.Provider>
        </motion.div>
      )}
      <motion.div
        key={pageMountId(current.transitionKey, current.generation)}
        data-vortex-page-content=""
        className="vortex-puck-slot min-w-0"
        style={{ gap: "inherit" }}
        initial={animated && current.generation > 0 ? { opacity: 0, y: 8 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={animated ? timing : { duration: 0 }}
      >
        <PagePresenceContext.Provider value>{children}</PagePresenceContext.Provider>
      </motion.div>
    </div>
  );
}
