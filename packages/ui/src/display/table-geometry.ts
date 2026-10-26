"use client";

import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";
import {
  RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH,
  RECORDS_TABLE_COLUMN_MINIMUM_WIDTH,
  RECORDS_TABLE_UNVIRTUALIZED_ROW_LIMIT,
  type RecordsTableContract,
  type RecordsTableDensity,
} from "@vortex/platform/schema";
import { LAYOUT_BREAKPOINT_MEDIA } from "../layout-styles";

/** Row height per authored density, in pixels; every row of a page has exactly this height. */
export const GRID_ROW_HEIGHT: Readonly<Record<RecordsTableDensity, number>> = Object.freeze({
  comfortable: 44,
  compact: 32,
});

/** Card spacing follows the same authored or personal density as the table. */
export const CARD_SPACING: Readonly<Record<RecordsTableDensity, string>> = Object.freeze({
  comfortable: "gap-2 p-3",
  compact: "gap-1 p-2",
});

export { recordsTableColumnWidth as columnWidth } from "@vortex/platform/schema";

/** A person resizes a column within the contract's bounds; a stored layout holds the same bounds. */
export const GRID_COLUMN_MIN_WIDTH = RECORDS_TABLE_COLUMN_MINIMUM_WIDTH;
export const GRID_COLUMN_MAX_WIDTH = RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH;
/** The fixed width of the selection and row-actions columns. */
export const GRID_CONTROL_COLUMN_WIDTH = 48;

/** The trailing cell fits every authored button, its menu and the optional row editor. */
export const gridActionsWidth = (contract: RecordsTableContract): number =>
  Math.max(
    contract.features.rowEdit.enabled ? 192 : GRID_CONTROL_COLUMN_WIDTH,
    contract.features.rowActions.enabled && contract.rowBehaviours.rowActions.length > 0
      ? 16 +
          36 *
            (Math.min(
              3,
              contract.rowBehaviours.rowActions.filter((action) => action.placement === "inline")
                .length,
            ) +
              1 +
              Number(contract.features.rowEdit.enabled))
      : GRID_CONTROL_COLUMN_WIDTH,
  );

/** Whether a page of this many rows mounts only the rows in view. */
export const virtualizesRows = (rowCount: number): boolean =>
  rowCount > RECORDS_TABLE_UNVIRTUALIZED_ROW_LIMIT;

/**
 * The bounded viewport's height: the rows scroll inside it, under the sticky header. Bounded by
 * the screen height so a page of two hundred rows never makes the page itself that tall.
 */
export const BOUNDED_VIEWPORT_CLASS = "max-h-[var(--grid-available-height,100svh)]";

/** Fit the rows above their following controls; scrolling changes only the overflow cue. */
export const useBoundedGridViewport = <Element extends HTMLElement>(
  scroll: RefObject<Element | null>,
  bounded: boolean,
): void => {
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!bounded || element === null) return;
    let frame = 0;
    let overflow = 0;
    let fading = false;
    const updateFade = (): void => {
      const next = element.scrollTop < overflow - 1;
      if (next === fading) return;
      fading = next;
      element.style.maskImage = next
        ? "linear-gradient(to bottom, black calc(100% - 16px), transparent)"
        : "none";
    };
    const measure = (): void => {
      frame = 0;
      const viewport = window.visualViewport;
      const bottom = viewport === null ? window.innerHeight : viewport.offsetTop + viewport.height;
      let followingHeight = 0;
      for (
        let sibling = element.nextElementSibling;
        sibling !== null;
        sibling = sibling.nextElementSibling
      ) {
        const style = getComputedStyle(sibling);
        if (style.position === "absolute" || style.position === "fixed" || style.display === "none")
          continue;
        followingHeight +=
          sibling.getBoundingClientRect().height +
          parseFloat(style.marginTop) +
          parseFloat(style.marginBottom);
      }
      const available = Math.max(0, bottom - element.getBoundingClientRect().top - followingHeight);
      element.style.setProperty("--grid-available-height", `${available}px`);
      overflow = element.scrollHeight - element.clientHeight;
      updateFade();
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    if (element.parentElement !== null) observer.observe(element.parentElement);
    const content =
      element.querySelector("[role='grid'],[role='treegrid']") ?? element.firstElementChild;
    if (content !== null) observer.observe(content);
    const children = new MutationObserver(schedule);
    children.observe(element, { childList: true });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    element.addEventListener("scroll", updateFade, { passive: true });
    element.addEventListener("vortex-row-settled", schedule);
    measure();
    return () => {
      observer.disconnect();
      children.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      element.removeEventListener("scroll", updateFade);
      element.removeEventListener("vortex-row-settled", schedule);
      element.style.removeProperty("--grid-available-height");
      element.style.removeProperty("mask-image");
    };
  }, [scroll, bounded]);
};

/**
 * Rows a skeleton of a virtualized page draws: those that fill the bounded viewport on a tall
 * screen. The rest of the page is one spacer of their height, so the scroll range is the real one.
 */
export const skeletonWindowRows = (density: RecordsTableDensity): number =>
  Math.ceil(900 / GRID_ROW_HEIGHT[density]);

const subscribeToMedia =
  (query: string) =>
  (notify: () => void): (() => void) => {
    const media = window.matchMedia(query);
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
  };
const PHONE_QUERY = LAYOUT_BREAKPOINT_MEDIA.phone;
const subscribeToPhone = subscribeToMedia(PHONE_QUERY);
const subscribeToNothing = (): (() => void) => () => undefined;
const isPhone = (): boolean => window.matchMedia(PHONE_QUERY).matches;
const never = (): boolean => false;
const unknownOnServer = (): undefined => undefined;

/** Whether the viewport is a phone's now; false while the server renders. */
export const usePhoneViewport = (): boolean =>
  useSyncExternalStore(subscribeToPhone, isPhone, never);

/**
 * The presentation the table shows now: the grid, or the phone cards when the definition asks for
 * cards and the viewport is a phone's. While the server renders and the page hydrates the
 * viewport is unknown (`undefined`): the table draws its grid, which a phone hides behind the
 * declared skeleton until the cards replace it; nothing is read twice, because both presentations
 * show the same requested columns.
 */
export const useTablePresentation = (
  contract: RecordsTableContract | undefined,
): "grid" | "cards" | undefined => {
  const cards = contract?.presentation === "grid" && contract.phonePresentation === "cards";
  const phone = useSyncExternalStore<boolean | undefined>(
    cards ? subscribeToPhone : subscribeToNothing,
    cards ? isPhone : never,
    cards ? unknownOnServer : never,
  );
  if (contract?.presentation === "cards") return "cards";
  if (phone === undefined) return undefined;
  return phone ? "cards" : "grid";
};
