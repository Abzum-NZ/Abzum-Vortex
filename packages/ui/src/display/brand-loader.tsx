import type { ReactElement } from "react";
import { cn } from "../lib/utils";

/**
 * The platform mark, drawn as six line segments in the order the loader traces them (all in a
 * 120 x 120 box): the outer triangle's left, right and base sides, then the inner diagonal, the
 * middle bar and the inner leg.
 *
 * TODO(#2519): source the mark from the application's theme or frame definition once either
 * declares a brand mark; until then this is the default platform mark.
 */
const MARK_SEGMENTS: readonly string[] = [
  "M12 101.569 L60 18.431",
  "M60 18.431 L108 101.569",
  "M108 101.569 L12 101.569",
  "M12 101.569 L84 60",
  "M84 60 L36 60",
  "M36 60 L48 80.784",
];

/** The loader's stylesheet, hoisted once into the document by React wherever a loader renders. */
const BRAND_LOADER_CSS = `/*
 * The platform loader. Outside an application's theme root (the first load of an application) the
 * token fallbacks below are the platform defaults the theme root also declares. Each segment is
 * normalised to a path length of 100: it draws in its 7.5% of the cycle, the mark holds from 45% to
 * 55%, and the pen then retraces backwards, erasing from the latest end, while the mark turns 120
 * degrees, so the next cycle starts where the erase ends.
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
[data-vortex-loader-segment="1"] {
  animation-name: vortex-loader-segment-1;
}
[data-vortex-loader-segment="2"] {
  animation-name: vortex-loader-segment-2;
}
[data-vortex-loader-segment="3"] {
  animation-name: vortex-loader-segment-3;
}
[data-vortex-loader-segment="4"] {
  animation-name: vortex-loader-segment-4;
}
[data-vortex-loader-segment="5"] {
  animation-name: vortex-loader-segment-5;
}
[data-vortex-loader-segment="6"] {
  animation-name: vortex-loader-segment-6;
}
@keyframes vortex-loader-segment-1 {
  0% { stroke-dashoffset: 100; } 7.5% { stroke-dashoffset: 0; } 92.5% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -100; }
}
@keyframes vortex-loader-segment-2 {
  0%, 7.5% { stroke-dashoffset: 100; } 15% { stroke-dashoffset: 0; } 85% { stroke-dashoffset: 0; } 92.5%, 100% { stroke-dashoffset: -100; }
}
@keyframes vortex-loader-segment-3 {
  0%, 15% { stroke-dashoffset: 100; } 22.5% { stroke-dashoffset: 0; } 77.5% { stroke-dashoffset: 0; } 85%, 100% { stroke-dashoffset: -100; }
}
@keyframes vortex-loader-segment-4 {
  0%, 22.5% { stroke-dashoffset: 100; } 30% { stroke-dashoffset: 0; } 70% { stroke-dashoffset: 0; } 77.5%, 100% { stroke-dashoffset: -100; }
}
@keyframes vortex-loader-segment-5 {
  0%, 30% { stroke-dashoffset: 100; } 37.5% { stroke-dashoffset: 0; } 62.5% { stroke-dashoffset: 0; } 70%, 100% { stroke-dashoffset: -100; }
}
@keyframes vortex-loader-segment-6 {
  0%, 37.5% { stroke-dashoffset: 100; } 45% { stroke-dashoffset: 0; } 55% { stroke-dashoffset: 0; } 62.5%, 100% { stroke-dashoffset: -100; }
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

/**
 * The platform loader: the mark drawn segment by segment, held, then erased backwards while it
 * turns a third of a revolution, on a loop. It is pure CSS (keyframes in its own hoisted stylesheet),
 * so it never runs on the script thread. Its ink, size and cycle are theme tokens
 * (`--vortex-loader-ink`, `--vortex-loader-size`, `--vortex-loader-cycle`); with reduced motion it
 * is the still, fully drawn mark. It is for long waits only (the first load of an application and a
 * page change that is still waiting after the loader delay), never for a button or a row.
 *
 * `overlay` centres it over the area it is placed in, without taking layout space.
 */
export function BrandLoader({
  overlay = false,
  label = "Loading",
  className,
}: Readonly<{ overlay?: boolean; label?: string; className?: string }>): ReactElement {
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
      <svg viewBox="0 0 120 120" fill="none" aria-hidden="true" focusable="false">
        {MARK_SEGMENTS.map((d, index) => (
          <path key={d} d={d} pathLength={100} data-vortex-loader-segment={index + 1} />
        ))}
      </svg>
    </div>
  );
}
