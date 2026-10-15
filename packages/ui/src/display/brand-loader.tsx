import type { ReactElement } from "react";
import { cn } from "../lib/utils";

/** One stroke of a loader mark: `[x1, y1, x2, y2]` in the 120 x 120 box. */
type MarkSegment = readonly [number, number, number, number];

/** The mark a loader draws: its strokes, in the order they are traced. */
export type LoaderMark = Readonly<{ segments: readonly MarkSegment[] }>;

/**
 * The platform mark, drawn as six line segments in the order the loader traces them (all in a
 * 120 x 120 box): the outer triangle's left, right and base sides, then the inner diagonal, the
 * middle bar and the inner leg. A theme that declares a loader mark of its own replaces it.
 *
 * Platform default until the next platform theme release carries it (#2666); also the org-level
 * loader before any application theme exists.
 */
const PLATFORM_MARK: LoaderMark = {
  segments: [
    [12, 101.569, 60, 18.431],
    [60, 18.431, 108, 101.569],
    [108, 101.569, 12, 101.569],
    [12, 101.569, 84, 60],
    [84, 60, 36, 60],
    [36, 60, 48, 80.784],
  ],
};

/** The loader's stylesheet, hoisted once into the document by React wherever a loader renders. */
const BRAND_LOADER_CSS = `/*
 * The platform loader. Outside an application's theme root (the first load of an application) the
 * token fallbacks below are the platform defaults the theme root also declares. Each segment is
 * normalised to a path length of 100: the segments draw one after another in the first 45% of the
 * cycle, the mark holds from 45% to 55%, and the pen then retraces backwards, erasing from the
 * latest end, while the mark turns 120 degrees, so the next cycle starts where the erase ends. The
 * draw and erase keyframes are generated for the number of segments the mark has.
 */
[data-vortex-brand-loader] {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vortex-loader-ink, var(--primary, currentColor));
  animation: vortex-loader-appear var(--vortex-motion-loader-fade, 200ms) ease-out
    var(--vortex-loader-delay, 200ms) both;
}
[data-vortex-brand-loader="overlay"] {
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: min(100%, 100svh);
  z-index: 20;
  pointer-events: none;
  --vortex-loader-delay: var(--vortex-motion-page-loader-delay, 1200ms);
}
/* Over a page the mark sits on a soft disc of the page's own surface, so it reads over any text. */
[data-vortex-brand-loader="overlay"] > svg {
  box-sizing: content-box;
  padding: calc(var(--vortex-loader-size, 100px) * 0.24);
  border-radius: 9999px;
  background-color: color-mix(in oklab, var(--background, Canvas) 88%, transparent);
  box-shadow: 0 0 calc(var(--vortex-loader-size, 100px) * 0.4)
    color-mix(in oklab, var(--background, Canvas) 88%, transparent);
}
[data-vortex-brand-loader] > svg {
  display: block;
  width: var(--vortex-loader-size, 100px);
  height: var(--vortex-loader-size, 100px);
  overflow: visible;
  transform-origin: 50% 50%;
  animation: vortex-loader-whirl var(--vortex-loader-cycle, 5s) cubic-bezier(0.45, 0.05, 0.55, 0.95)
    infinite;
}
[data-vortex-loader-segment] {
  fill: none;
  stroke: currentColor;
  stroke-width: 3.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 100;
  stroke-dashoffset: 100;
  animation-duration: var(--vortex-loader-cycle, 5s);
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}
@keyframes vortex-loader-whirl {
  0%, 55% { transform: rotate(0deg); }
  100% { transform: rotate(120deg); }
}
@keyframes vortex-loader-appear {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  [data-vortex-brand-loader] {
    animation-duration: 0s;
  }
  [data-vortex-brand-loader] > svg,
  [data-vortex-loader-segment] {
    animation: none;
  }
  [data-vortex-loader-segment] {
    stroke-dashoffset: 0;
  }
}`;

const percent = (value: number): string => `${Number(value.toFixed(3))}%`;

/**
 * The draw and erase keyframes of a mark with `count` segments. The draw phase takes the first 45%
 * of the cycle, split evenly; the hold takes 45% to 55%; the erase takes the last 45%, latest
 * segment first. Segment names carry the count, so loaders of different marks never share them.
 * Kept out of reduced motion, where the segments stay fully drawn.
 */
const segmentCss = (count: number): string => {
  const step = 45 / count;
  const rules: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const drawStart = (index - 1) * step;
    const drawEnd = index * step;
    const eraseStart = 55 + (count - index) * step;
    const eraseEnd = eraseStart + step;
    rules.push(
      `[data-vortex-loader-segments="${count}"] [data-vortex-loader-segment="${index}"] { animation-name: vortex-loader-${count}-segment-${index}; }`,
      `@keyframes vortex-loader-${count}-segment-${index} { 0%, ${percent(drawStart)} { stroke-dashoffset: 100; } ${percent(drawEnd)}, ${percent(eraseStart)} { stroke-dashoffset: 0; } ${percent(eraseEnd)}, 100% { stroke-dashoffset: -100; } }`,
    );
  }
  return ["@media (prefers-reduced-motion: no-preference) {", ...rules, "}"].join("\n");
};

/**
 * The platform loader: the mark drawn segment by segment, held, then erased backwards while it
 * turns a third of a revolution, on a loop. It is pure CSS (keyframes in its own hoisted stylesheet),
 * so it never runs on the script thread. Its ink, size and cycle are theme tokens
 * (`--vortex-loader-ink`, `--vortex-loader-size`, `--vortex-loader-cycle`); with reduced motion it
 * is the still, fully drawn mark. It is for long waits only (the first load of an application and a
 * page change that is still waiting after the loader delay), never for a button or a row.
 *
 * `mark` is the theme's loader mark; without one the platform mark is drawn.
 * `overlay` centres it over the area it is placed in, without taking layout space.
 */
export function BrandLoader({
  mark = PLATFORM_MARK,
  overlay = false,
  label = "Loading",
  className,
}: Readonly<{ mark?: LoaderMark; overlay?: boolean; label?: string; className?: string }>): ReactElement {
  const count = mark.segments.length;
  return (
    <div
      role="status"
      aria-label={label}
      data-vortex-brand-loader={overlay ? "overlay" : ""}
      {...(className === undefined ? {} : { className: cn(className) })}
    >
      <style href="vortex-brand-loader" precedence="vortex">
        {BRAND_LOADER_CSS}
      </style>
      <style href={`vortex-brand-loader-${count}`} precedence="vortex">
        {segmentCss(count)}
      </style>
      <svg
        viewBox="0 0 120 120"
        fill="none"
        aria-hidden="true"
        focusable="false"
        data-vortex-loader-segments={count}
      >
        {mark.segments.map(([x1, y1, x2, y2], index) => {
          const d = `M${x1} ${y1} L${x2} ${y2}`;
          return (
            <path key={`${index}:${d}`} d={d} pathLength={100} data-vortex-loader-segment={index + 1} />
          );
        })}
      </svg>
    </div>
  );
}
