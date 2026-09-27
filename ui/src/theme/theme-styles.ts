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

/* Definition-driven action buttons */
.vortex-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--vortex-space-xs);
  min-height: var(--vortex-control-min-height);
  padding: var(--vortex-control-padding-y) var(--vortex-control-padding-x);
  border: var(--vortex-border-width) var(--vortex-border-style) var(--vortex-border-color);
  border-radius: var(--vortex-radius-md);
  background-color: var(--vortex-secondary);
  color: var(--vortex-on-secondary);
  font: inherit;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
  transition: box-shadow var(--vortex-motion-feedback) ease-out;
}

.vortex-button-primary {
  background-color: var(--vortex-primary);
  color: var(--vortex-on-primary);
  border-color: var(--vortex-primary);
}

.vortex-button-danger {
  background-color: var(--vortex-danger);
  color: var(--vortex-on-danger);
  border-color: var(--vortex-danger);
}

.vortex-button-ghost {
  background-color: transparent;
  color: var(--vortex-text);
  border-color: transparent;
}

.vortex-button:hover:not(:disabled) {
  box-shadow: inset 0 0 0 0.125rem currentColor;
}

.vortex-button:active:not(:disabled) {
  box-shadow: inset 0 0 0 0.25rem currentColor;
}

.vortex-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.vortex-button[aria-busy="true"] {
  cursor: progress;
  opacity: 0.75;
}

/* Group heading */
.vortex-group-heading {
  margin: 0;
  font-family: var(--vortex-heading-font-family);
  font-size: var(--vortex-heading-font-size);
  line-height: var(--vortex-heading-line-height);
  font-weight: var(--vortex-heading-font-weight);
  color: var(--vortex-text);
}

.vortex-field {
  display: flex;
  flex-direction: column;
  gap: var(--vortex-space-xs);
}

.vortex-field-label {
  font-weight: 600;
  color: var(--vortex-text);
}

.vortex-field-help,
.vortex-field-note {
  color: var(--vortex-text-muted);
}

/* Search and rich text inputs */
.vortex-input,
.vortex-textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: var(--vortex-control-min-height);
  padding: var(--vortex-control-padding-y) var(--vortex-control-padding-x);
  border: var(--vortex-border-width) var(--vortex-border-style) var(--vortex-border-color);
  border-radius: var(--vortex-radius-md);
  background-color: var(--vortex-surface);
  color: var(--vortex-text);
  font: inherit;
  transition: border-color var(--vortex-motion-feedback) ease-out;
}

.vortex-textarea {
  min-height: 5.5rem;
  resize: vertical;
}

.vortex-input:hover:not(:disabled):not([readonly]),
.vortex-textarea:hover:not(:disabled):not([readonly]) {
  border-color: var(--vortex-text);
}

.vortex-textarea[readonly] {
  border-style: dashed;
}

.vortex-textarea:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.vortex-textarea[aria-invalid="true"] {
  border-color: var(--vortex-danger-text);
  box-shadow: inset 0 0 0 0.0625rem var(--vortex-danger-text);
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

/* Validation messages: meaning is carried by text; the severity colour is an accent */
.vortex-validation-message {
  padding: var(--vortex-space-sm) var(--vortex-space-md);
  border: var(--vortex-border-width) var(--vortex-border-style) var(--vortex-border-color);
  border-left-width: 0.25rem;
  border-radius: var(--vortex-radius-md);
  background-color: var(--vortex-surface);
  color: var(--vortex-text);
}

.vortex-validation-error {
  border-left-color: var(--vortex-danger-text);
}

.vortex-validation-warning {
  border-left-color: var(--vortex-warning-text);
}

.vortex-validation-info {
  border-left-color: var(--vortex-info-text);
}

.vortex-validation-title {
  margin: 0 0 var(--vortex-space-xs);
  font-weight: 700;
}

.vortex-validation-error .vortex-validation-title {
  color: var(--vortex-danger-text);
}

.vortex-validation-warning .vortex-validation-title {
  color: var(--vortex-warning-text);
}

.vortex-validation-info .vortex-validation-title {
  color: var(--vortex-info-text);
}

.vortex-validation-text,
.vortex-validation-list {
  margin: 0;
}

/* Grouped data */
.vortex-group-items {
  display: flex;
  flex-direction: column;
  gap: var(--vortex-space-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}

.vortex-group-item {
  display: flex;
  align-items: center;
  gap: var(--vortex-space-sm);
  padding: var(--vortex-cell-padding-y) var(--vortex-cell-padding-x);
  border: var(--vortex-border-width) var(--vortex-border-style) var(--vortex-border-color);
  border-radius: var(--vortex-radius-md);
  background-color: var(--vortex-surface);
  transition: border-color var(--vortex-motion-feedback) ease-out;
}

.vortex-group-item:hover {
  border-color: var(--vortex-text);
}

.vortex-group-item-content {
  display: flex;
  flex: 1;
  flex-direction: column;
}

.vortex-group-item-heading {
  font-weight: 600;
}

.vortex-group-item-secondary,
.vortex-group-empty,
.vortex-group-summary-label {
  color: var(--vortex-text-muted);
}

.vortex-data-group + .vortex-data-group {
  margin-top: var(--vortex-space-lg);
}

.vortex-group-heading {
  margin-bottom: var(--vortex-space-sm);
}

.vortex-group-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--vortex-space-md);
  margin: var(--vortex-space-sm) 0 0;
}

.vortex-group-summary-item {
  display: flex;
  flex-direction: column;
  gap: var(--vortex-space-xs);
}

.vortex-group-summary-value {
  margin: 0;
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
