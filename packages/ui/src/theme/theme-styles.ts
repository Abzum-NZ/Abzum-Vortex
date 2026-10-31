import { LAYOUT_ONLY_STYLES_CSS } from "../layout-styles";

/**
 * Platform stylesheet for every shared component state. It reads only the fixed
 * variables from `generateThemeCssVariables`; text is always painted on the surface or fill
 * theme validation checked it against, and hover/pressed feedback uses the element's own validated
 * foreground rather than new colours. The platform motion tokens below are the only timing
 * values platform motion reads, and they stop under reduced motion. Application definitions
 * contribute token values only.
 */
const SHARED_COMPONENT_STYLES_CSS = `
/* Theme roots: the runtime page or preview canvas. */
[data-vortex-theme] {
  /*
   * The semantic motion tokens the platform's components read: one duration inside each
   * calibration band and the easing that carries it. They are platform constants: a platform
   * component reads one token, and no feature code writes a one-off timing value.
   */
  --vortex-motion-enter-exit: 160ms; /* tooltip, menu, popover and small component entry or exit */
  --vortex-motion-enter-exit-easing: cubic-bezier(0.16, 1, 0.3, 1);
  --vortex-motion-refresh: 220ms; /* loading-to-content, local data refresh and a row value change */
  --vortex-motion-refresh-easing: cubic-bezier(0.4, 0, 0.2, 1);
  --vortex-motion-page: 360ms; /* the changing page region while the application shell stays stable */
  --vortex-motion-page-easing: cubic-bezier(0.4, 0, 0.2, 1);
  /*
   * Page change (hold then swap). While the next page is fetched the current page dims; the next
   * page is held until its primary data has arrived or the hold has passed, then the current page
   * fades out quickly while the next one rises into place. Rows that first appear settle in with a
   * short stagger. The hold and the loader delay are waits, not motion, so reduced motion keeps
   * them and only the movement stops.
   */
  --vortex-motion-page-dim: 120ms; /* the current page dimming while the next one is fetched */
  --vortex-motion-page-dim-easing: cubic-bezier(0.4, 0, 0.2, 1);
  --vortex-motion-page-dim-opacity: 0.7;
  --vortex-motion-page-swap-out: 80ms; /* the leaving page's fade */
  --vortex-motion-page-swap-out-easing: cubic-bezier(0.4, 0, 1, 1);
  --vortex-motion-page-swap-in: 180ms; /* the entering page's fade and 4px rise */
  --vortex-motion-page-swap-in-easing: cubic-bezier(0.16, 1, 0.3, 1);
  --vortex-motion-row-settle: 180ms; /* each first-appearing row's fade and 3px rise */
  --vortex-motion-row-settle-easing: cubic-bezier(0.16, 1, 0.3, 1);
  --vortex-motion-row-stagger: 13ms; /* the step between rows; the twentieth row and later share one */
  color: var(--foreground);
  background-color: var(--background);
  font-family: var(--vortex-font-family);
  font-size: var(--vortex-font-size);
  line-height: var(--vortex-line-height);
  font-weight: var(--vortex-font-weight);
}

/* A flow dialog is the surface of the page it shows, so that page paints no background of its own. */
[data-vortex-flow-surface] [data-vortex-theme] {
  background-color: transparent;
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

/* Single-select table control */
.vortex-selection-radio {
  width: 1.125rem;
  height: 1.125rem;
  margin: 0;
  accent-color: var(--primary);
  cursor: pointer;
}

.vortex-selection-radio:hover:not(:disabled) {
  box-shadow: 0 0 0 0.125rem var(--border);
}

/* Display cells and rich text */
.vortex-cell-number {
  font-variant-numeric: tabular-nums;
}

.vortex-cell-text,
.vortex-cell-link,
.vortex-cell-rich-text {
  /* A long unbroken value (a code, an address) wraps inside its block; a table cell still scrolls. */
  overflow-wrap: break-word;
}

.vortex-cell-empty {
  color: var(--muted-foreground);
}

.vortex-cell-link,
.vortex-cell-rich-text a {
  /* Keep screen-reader notices inside the link's clipping ancestors when its text is truncated. */
  position: relative;
  color: var(--foreground);
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
  border-left: 0.1875rem solid var(--border);
  color: var(--muted-foreground);
}

.vortex-cell-rich-text code {
  font-family: var(--font-mono-family, ui-monospace, monospace);
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
 * A link whose page change takes a moment shows it on the link itself (the page stays as it is):
 * after 200ms the link dims and the pointer shows progress, so a quick change shows nothing.
 */
[data-vortex-link-pending] {
  cursor: progress;
  animation: vortex-link-pending var(--vortex-motion-enter-exit)
    var(--vortex-motion-enter-exit-easing) 200ms both;
}

@keyframes vortex-link-pending {
  to {
    opacity: 0.55;
  }
}

/*
 * The navigation's selected item: one indicator slides between items (Motion, layoutId), so the
 * button's own selected fill is left to it. The selected text weight and colour stay on the button.
 */
[data-vortex-shell-navigation] [data-vortex-navigation-indicator] {
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: calc(var(--radius) * 0.8);
  background-color: var(--sidebar-accent);
  pointer-events: none;
}

[data-vortex-shell-navigation] [data-vortex-navigation-item-type] > [data-active]:not([data-active="false"]),
[data-vortex-shell-navigation] [data-vortex-navigation-item-type] > [data-active]:not([data-active="false"]):hover {
  position: relative;
  z-index: 1;
  background-color: transparent;
}

@media (prefers-reduced-motion: reduce) {
  [data-vortex-theme] {
    --vortex-motion-enter-exit: 0ms;
    --vortex-motion-refresh: 0ms;
    --vortex-motion-page: 0ms;
    --vortex-motion-page-dim: 0ms;
    --vortex-motion-page-swap-out: 0ms;
    --vortex-motion-page-swap-in: 0ms;
    --vortex-motion-row-settle: 0ms;
    --vortex-motion-row-stagger: 0ms;
    --vortex-motion-loader-fade: 0ms;
  }
}

/* Visible focus is a platform safeguard. Composite rows place the outline around all controls. */
[data-vortex-theme] :focus-visible:not([data-vortex-focus-group] [data-vortex-focus-primary]),
[data-vortex-theme] [data-vortex-focus-group]:has(:focus-visible) {
  outline: var(--vortex-focus-width) solid var(--ring) !important;
  outline-offset: 0.125rem !important;
}
/* Keep row outlines inside collapsible and scroll boundaries. */
[data-vortex-theme] [data-vortex-focus-group]:has(:focus-visible) {
  outline-offset: calc(-1 * var(--vortex-focus-width)) !important;
}
`.trim();

/**
 * The complete shared UI stylesheet: deterministic layout rules and themed component states.
 * The Puck page renderer mounts it once for runtime pages and preview canvases.
 */
export const ALL_UI_STYLES_CSS = `${LAYOUT_ONLY_STYLES_CSS.trim()}\n\n${SHARED_COMPONENT_STYLES_CSS}`;
