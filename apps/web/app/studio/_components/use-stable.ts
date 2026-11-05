"use client";
import { useCallback, useInsertionEffect, useRef } from "react";

/**
 * A function that keeps its identity while always calling the latest committed one. The latest is
 * held after the commit (a render React discards never replaces it), before any layout effect or
 * event can call it.
 */
export const useStable = <Args extends unknown[], Result>(
  latest: (...args: Args) => Result,
): ((...args: Args) => Result) => {
  const held = useRef(latest);
  useInsertionEffect(() => {
    held.current = latest;
  });
  return useCallback((...args: Args) => held.current(...args), []);
};
