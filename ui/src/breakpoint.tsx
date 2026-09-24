"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Breakpoint } from "./definition-error";
import { LAYOUT_BREAKPOINT_MEDIA } from "./layout-styles";

/**
 * Small browser breakpoint provider for live pages (#1010).
 *
 * Live server HTML always ships the desktop reading order so it is deterministic and matches the
 * CSS defaults. This provider then reports the visitor's current breakpoint on the client so slots
 * can adopt the declared per-breakpoint child order after load. Reordering keyed React children
 * keeps focus and form state on the elements that move, and the DOM order keeps focus order equal
 * to the meaningful reading order. Geometry (visibility, width, height) never depends on this
 * provider: it is expressed as pure CSS media rules so it applies even before hydration.
 */
const DEFAULT_BREAKPOINT: Breakpoint = "desktop";

const LayoutBreakpointContext = createContext<Breakpoint>(DEFAULT_BREAKPOINT);

/**
 * Subscribes to the shared layout breakpoint media queries and provides the current breakpoint.
 * Server and first client render both use the desktop default, so hydration never mismatches.
 */
export function LayoutBreakpointProvider({ children }: { children: ReactNode }): ReactElement {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(DEFAULT_BREAKPOINT);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const tabletQuery = window.matchMedia(LAYOUT_BREAKPOINT_MEDIA.tablet);
    const phoneQuery = window.matchMedia(LAYOUT_BREAKPOINT_MEDIA.phone);
    const update = (): void => {
      setBreakpoint(phoneQuery.matches ? "phone" : tabletQuery.matches ? "tablet" : "desktop");
    };
    update();
    tabletQuery.addEventListener("change", update);
    phoneQuery.addEventListener("change", update);
    return () => {
      tabletQuery.removeEventListener("change", update);
      phoneQuery.removeEventListener("change", update);
    };
  }, []);

  return (
    <LayoutBreakpointContext.Provider value={breakpoint}>{children}</LayoutBreakpointContext.Provider>
  );
}

/** Reads the current live layout breakpoint, defaulting to desktop outside a provider. */
export function useLayoutBreakpoint(): Breakpoint {
  return useContext(LayoutBreakpointContext);
}
