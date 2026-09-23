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

/* Buttons: action button and display refresh, row-action and pagination controls */
.vortex-button,
.vortex-button-refresh,
.vortex-button-row-action,
.vortex-pagination-prev,
.vortex-pagination-next {
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

.vortex-button:hover:not(:disabled),
.vortex-button-refresh:hover:not(:disabled),
.vortex-button-row-action:hover:not(:disabled),
.vortex-pagination-prev:hover:not(:disabled),
.vortex-pagination-next:hover:not(:disabled) {
  box-shadow: inset 0 0 0 0.125rem currentColor;
}

.vortex-button:active:not(:disabled),
.vortex-button-refresh:active:not(:disabled),
.vortex-button-row-action:active:not(:disabled),
.vortex-pagination-prev:active:not(:disabled),
.vortex-pagination-next:active:not(:disabled) {
  box-shadow: inset 0 0 0 0.25rem currentColor;
}

.vortex-button:disabled,
.vortex-button-refresh:disabled,
.vortex-button-row-action:disabled,
.vortex-pagination-prev:disabled,
.vortex-pagination-next:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.vortex-button[aria-busy="true"] {
  cursor: progress;
  opacity: 0.75;
}

/* Form container and field parts */
.vortex-form,
.vortex-form-fields {
  display: flex;
  flex-direction: column;
  gap: var(--vortex-space-md);
}

.vortex-form-title,
.vortex-display-title,
.vortex-dialog-title,
.vortex-drawer-title,
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

.vortex-field-inline {
  flex-direction: row;
  align-items: center;
  gap: var(--vortex-space-sm);
}

.vortex-field-label {
  font-weight: 600;
  color: var(--vortex-text);
}

.vortex-field-required,
.vortex-field-error {
  color: var(--vortex-danger-text);
  font-weight: 600;
}

.vortex-field-help,
.vortex-field-note {
  color: var(--vortex-text-muted);
}

/* Text, number, date and select inputs */
.vortex-input,
.vortex-textarea,
.vortex-select {
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
.vortex-textarea:hover:not(:disabled):not([readonly]),
.vortex-select:hover:not(:disabled) {
  border-color: var(--vortex-text);
}

.vortex-input[readonly],
.vortex-textarea[readonly] {
  border-style: dashed;
}

.vortex-input:disabled,
.vortex-textarea:disabled,
.vortex-select:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.vortex-input[aria-invalid="true"],
.vortex-textarea[aria-invalid="true"],
.vortex-select[aria-invalid="true"] {
  border-color: var(--vortex-danger-text);
  box-shadow: inset 0 0 0 0.0625rem var(--vortex-danger-text);
}

/* Checkbox, radio group, table selection and switch */
.vortex-radio-group {
  display: flex;
  flex-direction: column;
  gap: var(--vortex-space-xs);
  margin: 0;
  padding: 0;
  border: 0;
}

.vortex-radio-option {
  display: flex;
  align-items: center;
  gap: var(--vortex-space-sm);
  cursor: pointer;
}

.vortex-checkbox,
.vortex-radio,
.vortex-selection-checkbox {
  width: 1.125rem;
  height: 1.125rem;
  margin: 0;
  accent-color: var(--vortex-accent);
  cursor: pointer;
}

.vortex-checkbox:hover:not(:disabled),
.vortex-radio:hover:not(:disabled),
.vortex-selection-checkbox:hover:not(:disabled) {
  box-shadow: 0 0 0 0.125rem var(--vortex-border-color);
}

.vortex-switch {
  box-sizing: border-box;
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 2.75rem;
  height: 1.5rem;
  padding: 0.125rem;
  border: 0.0625rem solid var(--vortex-border-color);
  border-radius: 999px;
  background-color: var(--vortex-surface);
  cursor: pointer;
  transition:
    background-color var(--vortex-motion-feedback) ease-out,
    border-color var(--vortex-motion-feedback) ease-out;
}

.vortex-switch-thumb {
  display: block;
  width: 1.125rem;
  height: 1.125rem;
  border-radius: 999px;
  background-color: var(--vortex-text-muted);
  transition:
    transform var(--vortex-motion-feedback) ease-out,
    background-color var(--vortex-motion-feedback) ease-out;
}

.vortex-switch:hover:not(:disabled) {
  border-color: var(--vortex-text);
}

.vortex-switch[aria-checked="true"] {
  background-color: var(--vortex-accent);
  border-color: var(--vortex-accent);
}

.vortex-switch[aria-checked="true"] .vortex-switch-thumb {
  transform: translateX(1.25rem);
  background-color: var(--vortex-surface);
}

.vortex-checkbox:disabled,
.vortex-radio:disabled,
.vortex-selection-checkbox:disabled,
.vortex-switch:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.vortex-checkbox[aria-invalid="true"],
.vortex-radio[aria-invalid="true"],
.vortex-switch[aria-invalid="true"] {
  box-shadow: 0 0 0 0.125rem var(--vortex-danger-text);
}

/* Tabs */
.vortex-tablist {
  display: flex;
  gap: var(--vortex-space-xs);
  border-bottom: var(--vortex-border-width) var(--vortex-border-style) var(--vortex-border-color);
}

.vortex-tab {
  padding: var(--vortex-control-padding-y) var(--vortex-control-padding-x);
  border: 0;
  border-bottom: 0.1875rem solid transparent;
  background: transparent;
  color: var(--vortex-text-muted);
  font: inherit;
  cursor: pointer;
  transition: border-color var(--vortex-motion-feedback) ease-out;
}

.vortex-tab:hover:not(:disabled) {
  color: var(--vortex-text);
  border-bottom-color: var(--vortex-border-color);
}

.vortex-tab[aria-selected="true"] {
  color: var(--vortex-text);
  border-bottom-color: var(--vortex-accent);
  font-weight: 600;
}

.vortex-tab:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.vortex-tabpanel {
  padding: var(--vortex-space-md) 0;
}

/* Dialog and drawer */
.vortex-dialog,
.vortex-drawer {
  padding: var(--vortex-space-lg);
  border: var(--vortex-border-width) var(--vortex-border-style) var(--vortex-border-color);
  border-radius: var(--vortex-radius-lg);
  background-color: var(--vortex-surface);
  color: var(--vortex-text);
  box-shadow: var(--vortex-elevation-high);
}

.vortex-dialog::backdrop,
.vortex-drawer::backdrop {
  background-color: rgba(0, 0, 0, 0.55);
}

.vortex-dialog-header,
.vortex-drawer-header,
.vortex-display-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--vortex-space-sm);
  margin-bottom: var(--vortex-space-md);
}

.vortex-dialog-close,
.vortex-drawer-close {
  min-width: var(--vortex-control-min-height);
  min-height: var(--vortex-control-min-height);
  border: 0;
  border-radius: var(--vortex-radius-sm);
  background: transparent;
  color: var(--vortex-text-muted);
  font: inherit;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
}

.vortex-dialog-close:hover,
.vortex-drawer-close:hover {
  color: var(--vortex-text);
  box-shadow: inset 0 0 0 0.125rem currentColor;
}

.vortex-dialog-body,
.vortex-drawer-body {
  overflow-y: auto;
}

.vortex-dialog-actions,
.vortex-drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--vortex-space-sm);
  margin-top: var(--vortex-space-lg);
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

/* Display states */
.vortex-display-state {
  padding: var(--vortex-space-lg);
  border: var(--vortex-border-width) solid var(--vortex-border-color);
  border-radius: var(--vortex-radius-md);
  background-color: var(--vortex-surface);
  color: var(--vortex-text-muted);
}

.vortex-display-empty {
  border-style: dashed;
}

.vortex-display-refused,
.vortex-display-unavailable {
  border-left-width: 0.25rem;
  color: var(--vortex-text);
}

.vortex-display-refused {
  border-left-color: var(--vortex-danger-text);
}

.vortex-display-unavailable {
  border-left-color: var(--vortex-warning-text);
  margin-bottom: var(--vortex-space-sm);
}

/* Table */
.vortex-display-table {
  overflow-x: auto;
}

.vortex-table {
  width: 100%;
  border-collapse: collapse;
}

.vortex-table-header-cell,
.vortex-table-cell {
  padding: var(--vortex-cell-padding-y) var(--vortex-cell-padding-x);
  text-align: start;
  vertical-align: middle;
}

.vortex-table-header-cell {
  font-weight: 600;
  border-bottom: 0.125rem solid var(--vortex-border-color);
}

.vortex-table-row {
  border-bottom: var(--vortex-border-width) var(--vortex-border-style) var(--vortex-border-color);
}

.vortex-table-row:hover > :first-child {
  box-shadow: inset 0.1875rem 0 0 var(--vortex-border-color);
}

.vortex-table-row:has(.vortex-selection-checkbox:checked) > :first-child {
  box-shadow: inset 0.25rem 0 0 var(--vortex-accent);
}

.vortex-table-col-select,
.vortex-table-col-actions,
.vortex-table-cell-select,
.vortex-table-cell-action {
  width: 1%;
  white-space: nowrap;
}

.vortex-sort-button {
  padding: 0.125rem 0.25rem;
  border: 0;
  border-radius: var(--vortex-radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.vortex-sort-button:hover {
  text-decoration: underline;
}

.vortex-pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--vortex-space-sm);
  margin-top: var(--vortex-space-sm);
}

.vortex-pagination-info {
  color: var(--vortex-text-muted);
}

/* Lists, grouped data, record detail and summary values */
.vortex-list-items,
.vortex-group-items {
  display: flex;
  flex-direction: column;
  gap: var(--vortex-space-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}

.vortex-list-item,
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

.vortex-list-item:hover,
.vortex-group-item:hover {
  border-color: var(--vortex-text);
}

.vortex-list-content,
.vortex-group-item-content {
  display: flex;
  flex: 1;
  flex-direction: column;
}

.vortex-list-heading,
.vortex-group-item-heading {
  font-weight: 600;
}

.vortex-list-secondary,
.vortex-group-item-secondary,
.vortex-group-empty,
.vortex-summary-label,
.vortex-group-summary-label {
  color: var(--vortex-text-muted);
}

.vortex-data-group + .vortex-data-group {
  margin-top: var(--vortex-space-lg);
}

.vortex-group-heading {
  margin-bottom: var(--vortex-space-sm);
}

.vortex-group-summary,
.vortex-record-detail-fields,
.vortex-summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--vortex-space-md);
  margin: var(--vortex-space-sm) 0 0;
}

.vortex-record-detail-field,
.vortex-group-summary-item {
  display: flex;
  flex-direction: column;
  gap: var(--vortex-space-xs);
}

.vortex-field-value,
.vortex-group-summary-value {
  margin: 0;
}

.vortex-summary-card {
  display: flex;
  flex-direction: column;
  padding: var(--vortex-space-md);
  border: var(--vortex-border-width) var(--vortex-border-style) var(--vortex-border-color);
  border-radius: var(--vortex-radius-md);
  background-color: var(--vortex-surface);
  box-shadow: var(--vortex-elevation-low);
}

.vortex-summary-value {
  margin: var(--vortex-space-xs) 0 0;
  font-family: var(--vortex-heading-font-family);
  font-size: var(--vortex-heading-font-size);
  font-weight: var(--vortex-heading-font-weight);
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
.vortex-display-rich-text a,
.vortex-cell-rich-text a {
  color: var(--vortex-text);
  text-decoration: underline;
  text-underline-offset: 0.125rem;
}

.vortex-cell-link:hover,
.vortex-display-rich-text a:hover,
.vortex-cell-rich-text a:hover {
  text-decoration-thickness: 0.125rem;
}

.vortex-display-rich-text blockquote,
.vortex-cell-rich-text blockquote {
  margin: var(--vortex-space-sm) 0;
  padding-left: var(--vortex-space-sm);
  border-left: 0.1875rem solid var(--vortex-border-color);
  color: var(--vortex-text-muted);
}

.vortex-display-rich-text code,
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
