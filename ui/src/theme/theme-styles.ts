import { LAYOUT_ONLY_STYLES_CSS } from "../layout-styles";

/**
 * Platform stylesheet for every shared #580-#582 component state. It reads only the fixed
 * variables from `generateThemeCssVariables`; text is always painted on the surface or fill
 * #594 validated it against, and hover/pressed feedback uses the element's own validated
 * foreground rather than new colours. Transitions use the platform `feedback` motion token and
 * stop under reduced motion. Application definitions contribute token values only.
 */
const SHARED_COMPONENT_STYLES_CSS = `
/* Theme roots: the runtime page or preview canvas, and each placement with declared overrides */
[data-vortex-theme] {
  --vortex-motion-feedback: 100ms;
  color: var(--vortex-text);
  background-color: var(--vortex-surface);
  font-family: var(--vortex-font-family);
  font-size: var(--vortex-font-size);
  line-height: var(--vortex-line-height);
  font-weight: var(--vortex-font-weight);
}

.vortex-field-note {
  color: var(--vortex-text-muted);
}

/* Single-select table control */
.vortex-selection-radio {
  width: 1.125rem;
  height: 1.125rem;
  margin: 0;
  accent-color: var(--vortex-accent);
  cursor: pointer;
}

.vortex-selection-radio:hover:not(:disabled) {
  box-shadow: 0 0 0 0.125rem var(--vortex-border-color);
}

/* Display cells and rich text */
.vortex-cell-number {
  font-variant-numeric: tabular-nums;
}

.vortex-cell-choice {
  display: inline-block;
  padding: 0 var(--vortex-space-sm);
  border: 0.0625rem solid var(--vortex-border-color);
  border-radius: 999px;
}

.vortex-cell-empty {
  color: var(--vortex-text-muted);
}

.vortex-cell-link,
.vortex-cell-rich-text a {
  color: var(--vortex-text);
  text-decoration: underline;
  text-underline-offset: 0.125rem;
}

.vortex-cell-link:hover,
.vortex-cell-rich-text a:hover {
  text-decoration-thickness: 0.125rem;
}

.vortex-cell-rich-text blockquote {
  margin: var(--vortex-space-sm) 0;
  padding-left: var(--vortex-space-sm);
  border-left: 0.1875rem solid var(--vortex-border-color);
  color: var(--vortex-text-muted);
}

.vortex-cell-rich-text code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.vortex-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  [data-vortex-theme] {
    --vortex-motion-feedback: 0ms;
  }
}

/* Visible focus is a platform safeguard: no component or theme state may remove it. */
[data-vortex-theme] :focus-visible {
  outline: var(--vortex-focus-width) solid var(--vortex-focus-color) !important;
  outline-offset: 0.125rem !important;
}
`.trim();

/**
 * The complete shared UI stylesheet: deterministic layout rules and themed component states.
 * `PageLayoutRenderer` mounts it once for runtime pages and preview canvases.
 */
export const ALL_UI_STYLES_CSS = `${LAYOUT_ONLY_STYLES_CSS.trim()}\n\n${SHARED_COMPONENT_STYLES_CSS}`;
