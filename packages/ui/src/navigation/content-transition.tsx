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
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BrandLoader, type LoaderMark } from "../display/brand-loader";
import { readMotionTiming, type MotionTiming } from "./motion-tokens";
import { markDocumentHydrated } from "./page-hold";

type OutletTimings = Readonly<{
  dim: MotionTiming | undefined;
  dimOpacity: number;
  swapOut: MotionTiming | undefined;
  swapIn: MotionTiming | undefined;
}>;

/** The page change's motion tokens, read from the theme root the outlet sits in. */
const readOutletTimings = (element: HTMLElement): OutletTimings => {
  const opacity = Number(
    getComputedStyle(element).getPropertyValue("--vortex-motion-page-dim-opacity").trim(),
  );
  return {
    dim: readMotionTiming(element, "page-dim"),
    dimOpacity: Number.isFinite(opacity) && opacity > 0 && opacity <= 1 ? opacity : 1,
    swapOut: readMotionTiming(element, "page-swap-out"),
    swapIn: readMotionTiming(element, "page-swap-in"),
  };
};

const NO_MOTION = { duration: 0 } as const;

/**
 * Moves focus to the heading of the page that just came in (its first heading, else the page
 * itself), so assistive technology lands on the new page rather than on the link that left the old
 * one. Focus the new page already placed inside itself (a field it focused) is left alone.
 */
const focusPageHeading = (page: HTMLElement): void => {
  if (page.contains(document.activeElement)) return;
  const heading = page.querySelector<HTMLElement>("h1, h2, h3, h4, [role='heading']") ?? page;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
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
 * The application frame's page outlet. Exactly one page is current. While the next page is fetched
 * (`busy`) the current page stays in place, dimmed, with a thin progress line along the top of the
 * outlet once the wait is noticeable; a wait that reaches the loader delay shows the platform loader
 * over it instead of the line. The next page is held until it is ready (see `pageHoldFor`); then the
 * current page fades out quickly over the next one (out of the layout, so the next page never waits
 * for it) while the next page rises into place, and focus moves to the new page's heading. A further
 * change while a page is still leaving removes that page at once and lets the page just replaced
 * leave instead, so rapid changes never stack pages. With reduced motion the change is immediate and
 * nothing leaves. The outlet's state follows the committed render only, so a page change React
 * abandons (an interrupted navigation) leaves nothing behind. The outlet keeps the layout of the slot
 * it stands in, so the page's placements lay out exactly as they would directly in that slot.
 */
export function ContentTransition({
  transitionKey,
  busy = false,
  loaderMark,
  children,
}: Readonly<{
  transitionKey: string;
  busy?: boolean;
  /** The theme release's resolved loader mark. */
  loaderMark: LoaderMark;
  children: ReactNode;
}>): ReactElement {
  const reducedMotion = useReducedMotion();
  const outletRef = useRef<HTMLDivElement>(null);
  const [timings, setTimings] = useState<OutletTimings>();
  useLayoutEffect(() => {
    if (outletRef.current !== null) setTimings(readOutletTimings(outletRef.current));
  }, []);
  useEffect(() => markDocumentHydrated(), []);
  const motionAllowed = reducedMotion !== true;
  const swapIn = motionAllowed ? timings?.swapIn : undefined;
  const swapOut = motionAllowed ? timings?.swapOut : undefined;
  const dim = motionAllowed ? timings?.dim : undefined;
  const animated = swapIn !== undefined;

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
      (swapOut?.duration ?? 0) * 1000 + 50,
    );
    return () => window.clearTimeout(timer);
  }, [leavingId, swapOut]);

  const currentPageRef = useRef<HTMLDivElement>(null);
  const generation = current.generation;
  useEffect(() => {
    if (generation === 0 || currentPageRef.current === null) return;
    focusPageHeading(currentPageRef.current);
  }, [generation]);

  return (
    <div
      ref={outletRef}
      data-vortex-shell-outlet=""
      className="vortex-puck-slot relative min-w-0"
      style={{ gap: "inherit" }}
      {...(busy ? { "aria-busy": true, "data-vortex-page-transition": "" } : {})}
    >
      {busy ? <div data-vortex-page-progress="" aria-hidden /> : null}
      <AnimatePresence>
        {busy ? (
          // Only a long wait shows the loader (its delay is in its stylesheet); it fades out with
          // the leaving page when the next page swaps in.
          <motion.div
            key="loader"
            className="pointer-events-none absolute inset-0 z-20"
            initial={false}
            exit={{ opacity: 0 }}
            transition={swapOut ?? NO_MOTION}
          >
            <BrandLoader overlay mark={loaderMark} />
          </motion.div>
        ) : null}
      </AnimatePresence>
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
          animate={{ opacity: 0, y: 0 }}
          transition={swapOut ?? NO_MOTION}
        >
          <PagePresenceContext.Provider value={false}>
            {current.leaving.node}
          </PagePresenceContext.Provider>
        </motion.div>
      )}
      <motion.div
        ref={currentPageRef}
        key={pageMountId(current.transitionKey, current.generation)}
        data-vortex-page-content=""
        className="vortex-puck-slot min-w-0"
        style={{ gap: "inherit" }}
        initial={animated && current.generation > 0 ? { opacity: 0, y: 4 } : false}
        animate={{ opacity: busy ? (timings?.dimOpacity ?? 1) : 1, y: 0 }}
        // Dimming follows the dim token; entering, and coming back from a wait that ended without
        // a page change, follow the swap-in token.
        transition={(busy ? dim : swapIn) ?? NO_MOTION}
      >
        <PagePresenceContext.Provider value>{children}</PagePresenceContext.Provider>
      </motion.div>
    </div>
  );
}
