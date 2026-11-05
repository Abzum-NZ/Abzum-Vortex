"use client";
import { useCallback, useRef } from "react";

/** A function that keeps its identity while always calling the latest one. */
export const useStable = <Args extends unknown[], Result>(
  latest: (...args: Args) => Result,
): ((...args: Args) => Result) => {
  const held = useRef(latest);
  held.current = latest;
  return useCallback((...args: Args) => held.current(...args), []);
};
