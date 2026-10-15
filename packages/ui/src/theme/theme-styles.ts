import { LAYOUT_ONLY_STYLES_CSS } from "../layout-styles";

/**
 * Platform stylesheet for every shared #580-#582 component state. It reads only the fixed
 * variables from `generateThemeCssVariables`; text is always painted on the surface or fill
 * #594 validated it against, and hover/pressed feedback uses the element's own validated
 * foreground rather than new colours. The platform motion tokens below are the only timing
 * values platform motion reads, and they stop under reduced motion. Application definitions
 * contribute token values only.
 */
const SHARED_COMPONENT_STYLES_CSS = `
/* Theme roots: the runtime page or preview canvas, and each placement with declared overrides */
[data-vortex-theme] {
  /*
   * The six semantic motion tokens of the specification's animation implementation standard:
   * one duration inside each calibration band, the easing that carries it, and the layout
   * spring. They are platform constants: a platform component reads one token, and no feature
   * code writes a one-off timing value.
   */
  --vortex-motion-feedback: 100ms; /* pressed feedback and tiny state confirmation */
  --vortex-motion-feedback-easing: cubic-bezier(0.4, 0, 0.2, 1);
  --vortex-motion-enter-exit: 160ms; /* tooltip, menu, popover and small component entry or exit */
  --vortex-motion-enter-exit-easing: cubic-bezier(0.16, 1, 0.3, 1);
  --vortex-motion-refresh: 220ms; /* loading-to-content, local data refresh and a row value change */
  --vortex-motion-refresh-easing: cubic-bezier(0.4, 0, 0.2, 1);
  --vortex-motion-panel: 300ms; /* dialog, drawer, expanding section and larger local panel */
  --vortex-motion-panel-easing: cubic-bezier(0.22, 1, 0.36, 1);
  --vortex-motion-page: 360ms; /* the changing page region while the application shell stays stable */
  --vortex-motion-page-easing: cubic-bezier(0.4, 0, 0.2, 1);
  /* The layout spring for reordering, resizing and dragging, approximated for CSS as one mild
   * ease-out-back overshoot that settles to rest; Motion drives the same movement with spring
   * physics. */
  --vortex-motion-layout-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  color: var(--vortex-text);
  background-color: var(--vortex-surface);
  font-family: var(--vortex-font-family);
  font-size: var(--vortex-font-size);
  line-height: var(--vortex-line-height);
  font-weight: var(--vortex-font-weight);
}

/* Only installed application hosts cover the viewport; previews and dialogs remain bounded. */
[data-vortex-application-surface] {
  min-height: 100svh;
  width: 100%;
  min-width: 0;
}

[data-vortex-page-feedback] {
  display: flex;
  flex-direction: column;
  gap: var(--vortex-space-md);
  padding: var(--vortex-space-md);
}

/* The form owns field spacing across its one rendered content slot, including declared grids. */
.vortex-form-content > [data-vortex-slot-key="content"] {
  gap: var(--vortex-space-md);
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

.vortex-cell-text,
.vortex-cell-link,
.vortex-cell-rich-text {
  /* A long unbroken value (a code, an address) wraps inside its block; a table cell still scrolls. */
  overflow-wrap: break-word;
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

/*
 * Loading visuals. A placement's loading skeleton keeps its space from the start but stays
 * invisible for the first 200ms, so data that arrives quickly replaces it without a flash; a slow
 * read then shows it with the refresh motion. Content that replaces a shown skeleton enters with
 * the same motion, in the skeleton's place. The delay is a platform constant, not a motion token:
 * under reduced motion the skeleton still waits, then appears and is replaced without animation.
 */
[data-vortex-display-state="loading"] {
  animation: vortex-loading-reveal var(--vortex-motion-refresh) var(--vortex-motion-refresh-easing)
    200ms both;
}

[data-vortex-display-revealed] {
  animation: vortex-loading-reveal var(--vortex-motion-refresh) var(--vortex-motion-refresh-easing)
    both;
}

@keyframes vortex-loading-reveal {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/*
 * The page progress line: a thin bar along the top of the page outlet while the next page is
 * fetched, so the current page can stay in place without the click looking ignored. It appears
 * only after 200ms, so a quick change shows nothing, and it is static under reduced motion.
 */
[data-vortex-page-progress] {
  position: absolute;
  inset-inline: 0;
  top: 0;
  z-index: 20;
  height: 0.125rem;
  overflow: hidden;
  pointer-events: none;
  animation: vortex-loading-reveal var(--vortex-motion-enter-exit)
    var(--vortex-motion-enter-exit-easing) 200ms both;
}

[data-vortex-page-progress]::before {
  content: "";
  position: absolute;
  inset-block: 0;
  left: 0;
  width: 40%;
  background-color: var(--primary, var(--vortex-accent));
  animation: vortex-page-progress calc(var(--vortex-motion-page) * 4)
    var(--vortex-motion-page-easing) infinite;
}

@keyframes vortex-page-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(250%);
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-vortex-page-progress]::before {
    width: 100%;
    opacity: 0.6;
    animation: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-vortex-theme] {
    --vortex-motion-feedback: 0ms;
    --vortex-motion-enter-exit: 0ms;
    --vortex-motion-refresh: 0ms;
    --vortex-motion-panel: 0ms;
    --vortex-motion-page: 0ms;
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
 * The Puck page renderer mounts it once for runtime pages and preview canvases.
 */
export const ALL_UI_STYLES_CSS = `${LAYOUT_ONLY_STYLES_CSS.trim()}\n\n${SHARED_COMPONENT_STYLES_CSS}`;
