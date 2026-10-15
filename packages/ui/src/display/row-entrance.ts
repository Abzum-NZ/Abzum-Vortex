"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { animate } from "motion/react";
import { readMotionSeconds, readMotionTiming } from "../navigation/motion-tokens";
import { isClientPageChange } from "../navigation/page-hold";

/** The rows that settle one after another; every later row settles with the last of them. */
const STAGGERED_ROW_LIMIT = 20;

/**
 * Rows settle into place when a set of them first appears: the first rows of a placement, or a
 * new page of it (none of the rows shown before is still shown). Each row fades in and rises 3px,
 * one stagger step after the row above it, up to twenty rows. A refresh or a realtime update of
 * the same rows never animates: a row that was already shown keeps its place without moving. The
 * first document's rows (server-rendered and hydrated) are already in place and never animate, and
 * with reduced motion rows simply appear.
 *
 * `rowSelector` finds the row elements inside the container, in the order the keys list them.
 */
export const useRowEntrance = <T extends HTMLElement>(
  rowKeys: readonly string[],
  rowSelector: string,
): RefObject<T | null> => {
  const containerRef = useRef<T>(null);
  const shown = useRef<ReadonlySet<string>>(new Set());
  const signature = rowKeys.join("\u0000");
  useLayoutEffect(() => {
    const previous = shown.current;
    const keys = signature === "" ? [] : signature.split("\u0000");
    shown.current = new Set(keys);
    const container = containerRef.current;
    if (container === null || keys.length === 0 || !isClientPageChange()) return;
    if (keys.some((key) => previous.has(key))) return;
    const timing = readMotionTiming(container, "row-settle");
    const step = readMotionSeconds(container, "row-stagger") ?? 0;
    if (timing === undefined) return;
    const rows = [...container.querySelectorAll<HTMLElement>(rowSelector)];
    const controls = rows.map((row, index) => {
      // Hidden before the first paint, so a settling row never flashes at its final place.
      row.style.opacity = "0";
      return animate(
        row,
        { opacity: [0, 1], y: [3, 0] },
        { ...timing, delay: Math.min(index, STAGGERED_ROW_LIMIT - 1) * step },
      );
    });
    return () => {
      for (const control of controls) control.complete();
    };
  }, [rowSelector, signature]);
  return containerRef;
};
