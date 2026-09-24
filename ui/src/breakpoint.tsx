"use client";

import {
  createContext,
  Fragment,
  useContext,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Breakpoint } from "./definition-error";
import { LAYOUT_BREAKPOINT_MEDIA } from "./layout-styles";

/**
 * Small browser breakpoint provider for live pages (#1010).
 *
 * Live server HTML always ships the desktop reading order so it is deterministic and matches the
 * CSS defaults. This provider then reports the visitor's current breakpoint in the browser so slots
 * can adopt the declared per-breakpoint child order after load. Geometry (visibility, width,
 * height) never depends on it: that is pure media-query CSS, which applies before hydration.
 *
 * This is the only client boundary of the live layout. The layout renderer itself stays
 * server-compatible, so a server component can pass it the registry and callbacks directly; the
 * provider and the ordered-children component below only receive serialisable order lists and
 * already rendered placements.
 */
const DEFAULT_BREAKPOINT: Breakpoint = "desktop";

const LayoutBreakpointContext = createContext<Breakpoint>(DEFAULT_BREAKPOINT);

const canMatchMedia = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function";

const subscribeToBreakpoint = (onChange: () => void): (() => void) => {
  if (!canMatchMedia()) return () => {};
  const queries = [
    window.matchMedia(LAYOUT_BREAKPOINT_MEDIA.tablet),
    window.matchMedia(LAYOUT_BREAKPOINT_MEDIA.phone),
  ];
  for (const query of queries) query.addEventListener("change", onChange);
  return () => {
    for (const query of queries) query.removeEventListener("change", onChange);
  };
};

const readBrowserBreakpoint = (): Breakpoint => {
  if (!canMatchMedia()) return DEFAULT_BREAKPOINT;
  if (window.matchMedia(LAYOUT_BREAKPOINT_MEDIA.phone).matches) return "phone";
  if (window.matchMedia(LAYOUT_BREAKPOINT_MEDIA.tablet).matches) return "tablet";
  return "desktop";
};

const readServerBreakpoint = (): Breakpoint => DEFAULT_BREAKPOINT;

/**
 * Subscribes once to the shared layout breakpoint media queries and provides the current
 * breakpoint. The server render and hydration both use the desktop default, so hydration never
 * mismatches; React then re-renders with the visitor's breakpoint. A client-only mount reads the
 * browser breakpoint immediately.
 */
export function LayoutBreakpointProvider({ children }: { children: ReactNode }): ReactElement {
  const breakpoint = useSyncExternalStore(
    subscribeToBreakpoint,
    readBrowserBreakpoint,
    readServerBreakpoint,
  );
  return (
    <LayoutBreakpointContext.Provider value={breakpoint}>{children}</LayoutBreakpointContext.Provider>
  );
}

/** Reads the current live layout breakpoint, defaulting to desktop outside a provider. */
export function useLayoutBreakpoint(): Breakpoint {
  return useContext(LayoutBreakpointContext);
}

export type BreakpointOrderedChildrenProps = Readonly<{
  /** The slot's validated per-breakpoint child order; every list names every item exactly once. */
  order: Readonly<Record<Breakpoint, readonly string[]>>;
  /** Already rendered children keyed by stable placement identity. */
  items: Readonly<Record<string, ReactNode>>;
}>;

/**
 * Renders a slot's children in the current breakpoint's declared order. Each child keeps its
 * stable placement key, so a breakpoint change moves the existing DOM nodes instead of remounting
 * them: component and form state survive, React restores focus to a moved focused element, and
 * the DOM order (and so keyboard focus order) always equals the declared reading order.
 */
export function BreakpointOrderedChildren({
  order,
  items,
}: BreakpointOrderedChildrenProps): ReactElement {
  const breakpoint = useLayoutBreakpoint();
  return (
    <>
      {order[breakpoint].map((placementId) =>
        Object.hasOwn(items, placementId) ? (
          <Fragment key={placementId}>{items[placementId]}</Fragment>
        ) : null,
      )}
    </>
  );
}
