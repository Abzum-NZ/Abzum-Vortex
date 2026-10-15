import type { Easing } from "motion/react";

/** One platform motion token resolved for Motion: a duration in seconds and its easing. */
export type MotionTiming = Readonly<{ duration: number; ease: Easing }>;

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
 * A platform time token (`--vortex-motion-<name>`) in seconds, read from the theme root the element
 * sits in, or undefined when the element is outside a theme root.
 */
export const readMotionSeconds = (element: Element, name: string): number | undefined =>
  seconds(getComputedStyle(element).getPropertyValue(`--vortex-motion-${name}`));

/**
 * A platform motion token and the easing token that carries it, read from the theme root this
 * element sits in. The platform stylesheet sets every duration to 0ms under reduced motion, so a
 * missing or zero duration means no motion.
 */
export const readMotionTiming = (
  element: Element,
  name: string,
  easingName: string = name,
): MotionTiming | undefined => {
  const style = getComputedStyle(element);
  const duration = seconds(style.getPropertyValue(`--vortex-motion-${name}`));
  const ease = easing(style.getPropertyValue(`--vortex-motion-${easingName}-easing`));
  return duration === undefined || ease === undefined || duration <= 0
    ? undefined
    : { duration, ease };
};
