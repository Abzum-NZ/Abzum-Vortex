/**
 * Shared component styles applying theme CSS variables to every state of
 * #580-#582 components (default, hover, focus, disabled, warning, error, etc.).
 *
 * Follows WCAG 2.2 AA contrast standards, preserves visible focus across all
 * interactive controls, and respects prefers-reduced-motion.
 */
export const SHARED_COMPONENTS_CSS = `
/* --- Global Reset & Root Scoping --- */
[data-vortex-theme],
.vortex-root {
  box-sizing: border-box;
  color: var(--vortex-foreground);
  background-color: var(--vortex-surface);
  font-family: var(--vortex-font-family);
  font-size: var(--vortex-font-size);
  line-height: var(--vortex-line-height);
}

[data-vortex-theme] *,
.vortex-root * {
  box-sizing: border-box;
}

/* --- Focus Preservation --- */
/* Interactive elements MUST preserve visible focus. Focus is never hidden. */
:focus-visible {
  outline: var(--vortex-focus-outline);
  outline-offset: var(--vortex-focus-offset, 2px);
}

/* --- Buttons (.vortex-button) --- */
.vortex-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--vortex-spacing-xs, 0.25rem);
  font-family: var(--vortex-font-family);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1;
  padding: var(--vortex-density-control-padding-y, 0.5rem) var(--vortex-density-control-padding-x, 1rem);
  min-height: var(--vortex-density-control-min-height, 2.5rem);
  border-radius: var(--vortex-radius, 0.25rem);
  border: var(--vortex-border-width, 1px) solid transparent;
  cursor: pointer;
  text-decoration: none;
  user-select: none;
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    color 140ms ease,
    box-shadow 140ms ease,
    opacity 140ms ease,
    transform 140ms ease;
}

.vortex-button:focus-visible {
  outline: var(--vortex-focus-outline);
  outline-offset: var(--vortex-focus-offset, 2px);
}

.vortex-button:active:not(:disabled) {
  transform: translateY(1px);
}

.vortex-button:disabled,
.vortex-button[aria-disabled="true"] {
  opacity: 0.6;
  cursor: not-allowed;
  pointer-events: none;
}

.vortex-button[aria-busy="true"] {
  cursor: wait;
  opacity: 0.75;
}

/* Button Variants */
.vortex-button-primary {
  background-color: var(--vortex-color-primary);
  color: var(--vortex-color-primary-foreground, #ffffff);
  border-color: var(--vortex-color-primary);
}

.vortex-button-primary:hover:not(:disabled) {
  background-color: var(--vortex-color-primary-hover, var(--vortex-color-primary));
  filter: brightness(1.1);
}

.vortex-button-secondary {
  background-color: var(--vortex-color-secondary, var(--vortex-surface-secondary));
  color: var(--vortex-color-secondary-foreground, var(--vortex-foreground));
  border-color: var(--vortex-color-border);
}

.vortex-button-secondary:hover:not(:disabled) {
  filter: brightness(0.95);
  border-color: var(--vortex-color-border-hover, var(--vortex-color-border));
}

.vortex-button-danger {
  background-color: var(--vortex-color-danger, #dc2626);
  color: var(--vortex-color-danger-foreground, #ffffff);
  border-color: var(--vortex-color-danger, #dc2626);
}

.vortex-button-danger:hover:not(:disabled) {
  filter: brightness(1.1);
}

.vortex-button-ghost {
  background-color: transparent;
  color: var(--vortex-foreground);
  border-color: transparent;
}

.vortex-button-ghost:hover:not(:disabled) {
  background-color: var(--vortex-color-primary-subtle, var(--vortex-surface-secondary));
}

/* --- Form Container & Fields --- */
.vortex-form {
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: var(--vortex-spacing-md, 1rem);
}

.vortex-form-title {
  margin: 0;
  font-family: var(--vortex-font-family-heading, var(--vortex-font-family));
  font-size: var(--vortex-font-size-heading, 1.5rem);
  font-weight: var(--vortex-font-weight-heading, 700);
  line-height: var(--vortex-line-height-heading, 1.25);
  color: var(--vortex-foreground);
}

.vortex-form-fields {
  display: flex;
  flex-direction: column;
  gap: var(--vortex-spacing-sm, 0.5rem);
}

.vortex-field {
  display: flex;
  flex-direction: column;
  gap: var(--vortex-spacing-xs, 0.25rem);
  margin-bottom: var(--vortex-spacing-sm, 0.5rem);
  width: 100%;
}

.vortex-field-inline {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--vortex-spacing-sm, 0.5rem);
}

.vortex-field-label {
  font-family: var(--vortex-font-family);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--vortex-foreground);
  user-select: none;
}

.vortex-field-required {
  color: var(--vortex-color-danger, #dc2626);
  font-weight: 700;
  margin-left: 0.125rem;
}

.vortex-field-help {
  font-family: var(--vortex-font-family);
  font-size: 0.8125rem;
  color: var(--vortex-foreground-muted);
  margin-top: 0.125rem;
}

.vortex-field-error {
  font-family: var(--vortex-font-family);
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--vortex-color-danger, #dc2626);
  margin-top: 0.125rem;
}

.vortex-field-note {
  font-family: var(--vortex-font-family);
  font-size: 0.8125rem;
  color: var(--vortex-foreground-muted);
  margin-top: 0.125rem;
}

/* --- Text Input, Textarea, Select --- */
.vortex-input,
.vortex-textarea,
.vortex-select {
  width: 100%;
  font-family: var(--vortex-font-family);
  font-size: var(--vortex-font-size, 0.875rem);
  color: var(--vortex-foreground);
  background-color: var(--vortex-surface);
  border: var(--vortex-border-width, 1px) var(--vortex-border-style, solid) var(--vortex-color-border);
  border-radius: var(--vortex-radius, 0.25rem);
  padding: var(--vortex-density-control-padding-y, 0.5rem) var(--vortex-density-control-padding-x, 0.75rem);
  min-height: var(--vortex-density-control-min-height, 2.5rem);
  box-sizing: border-box;
  transition:
    border-color 140ms ease,
    box-shadow 140ms ease,
    background-color 140ms ease;
}

.vortex-input:hover:not(:disabled):not([readonly]),
.vortex-textarea:hover:not(:disabled):not([readonly]),
.vortex-select:hover:not(:disabled):not([readonly]) {
  border-color: var(--vortex-color-border-hover, var(--vortex-foreground-muted));
}

.vortex-input:focus-visible,
.vortex-textarea:focus-visible,
.vortex-select:focus-visible {
  outline: none;
  border-color: var(--vortex-color-focus);
  box-shadow: var(--vortex-focus-ring);
}

.vortex-input:disabled,
.vortex-textarea:disabled,
.vortex-select:disabled {
  background-color: var(--vortex-color-disabled-surface);
  color: var(--vortex-color-disabled-foreground);
  border-color: var(--vortex-color-disabled-border);
  cursor: not-allowed;
  opacity: 0.85;
}

.vortex-input[readonly],
.vortex-textarea[readonly] {
  background-color: var(--vortex-surface-secondary);
  cursor: default;
}

.vortex-input[aria-invalid="true"],
.vortex-textarea[aria-invalid="true"],
.vortex-select[aria-invalid="true"] {
  border-color: var(--vortex-color-danger, #dc2626);
}

.vortex-input[aria-invalid="true"]:focus-visible,
.vortex-textarea[aria-invalid="true"]:focus-visible,
.vortex-select[aria-invalid="true"]:focus-visible {
  border-color: var(--vortex-color-danger, #dc2626);
  box-shadow: 0 0 0 var(--vortex-focus-width, 2px) var(--vortex-color-danger-border, #fca5a5);
}

.vortex-textarea {
  min-height: 5.5rem;
  resize: vertical;
  line-height: var(--vortex-line-height, 1.5);
}

/* --- Radio & Checkbox Controls --- */
.vortex-radio-group {
  border: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--vortex-spacing-xs, 0.25rem);
}

.vortex-radio-option {
  display: flex;
  align-items: center;
  gap: var(--vortex-spacing-sm, 0.5rem);
  margin: 0.125rem 0;
  cursor: pointer;
}

.vortex-checkbox,
.vortex-radio {
  accent-color: var(--vortex-color-primary);
  width: 1.125rem;
  height: 1.125rem;
  cursor: pointer;
}

.vortex-checkbox:focus-visible,
.vortex-radio:focus-visible {
  outline: var(--vortex-focus-outline);
  outline-offset: var(--vortex-focus-offset, 2px);
}

.vortex-checkbox:disabled,
.vortex-radio:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.vortex-checkbox[aria-invalid="true"],
.vortex-radio[aria-invalid="true"] {
  outline: 2px solid var(--vortex-color-danger, #dc2626);
  outline-offset: 2px;
}

/* Switch */
.vortex-switch {
  position: relative;
  width: 2.75rem;
  height: 1.5rem;
  border-radius: var(--vortex-radius-full, 9999px);
  border: var(--vortex-border-width, 1px) solid var(--vortex-color-border);
  background-color: var(--vortex-surface-secondary);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  align-items: center;
  transition:
    background-color 150ms ease,
    border-color 150ms ease,
    box-shadow 150ms ease;
}

.vortex-switch:focus-visible {
  outline: var(--vortex-focus-outline);
  outline-offset: var(--vortex-focus-offset, 2px);
}

.vortex-switch[aria-checked="true"] {
  background-color: var(--vortex-color-primary);
  border-color: var(--vortex-color-primary);
}

.vortex-switch:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.vortex-switch[aria-invalid="true"] {
  border-color: var(--vortex-color-danger, #dc2626);
}

.vortex-switch-thumb {
  display: block;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: var(--vortex-radius-full, 9999px);
  background-color: var(--vortex-surface, #ffffff);
  box-shadow: var(--vortex-elevation-low);
  transition: transform 150ms ease, background-color 150ms ease;
}

.vortex-switch[aria-checked="true"] .vortex-switch-thumb {
  transform: translateX(1.25rem);
}

/* --- Tabs (.vortex-tabs) --- */
.vortex-tabs {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.vortex-tablist {
  display: flex;
  flex-direction: row;
  border-bottom: var(--vortex-border-width, 1px) solid var(--vortex-color-border);
  gap: var(--vortex-spacing-xs, 0.25rem);
  margin-bottom: var(--vortex-spacing-sm, 0.5rem);
}

.vortex-tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  padding: var(--vortex-spacing-sm, 0.5rem) var(--vortex-spacing-md, 1rem);
  color: var(--vortex-foreground-muted);
  font-family: var(--vortex-font-family);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease;
}

.vortex-tab:hover:not(:disabled) {
  color: var(--vortex-foreground);
}

.vortex-tab:focus-visible {
  outline: var(--vortex-focus-outline);
  outline-offset: -2px;
}

.vortex-tab[aria-selected="true"] {
  color: var(--vortex-color-primary, var(--vortex-foreground));
  border-bottom-color: var(--vortex-color-primary, var(--vortex-foreground));
  font-weight: 600;
}

.vortex-tab:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.vortex-tabpanel {
  outline: none;
  padding: var(--vortex-spacing-xs, 0.25rem) 0;
}

.vortex-tabpanel:focus-visible {
  outline: var(--vortex-focus-outline);
  outline-offset: 2px;
}

/* --- Modal Surface: Dialog & Drawer --- */
dialog.vortex-dialog,
dialog.vortex-drawer {
  background-color: var(--vortex-surface);
  color: var(--vortex-foreground);
  border: var(--vortex-border-width, 1px) solid var(--vortex-color-border);
  border-radius: var(--vortex-radius-lg, 0.5rem);
  box-shadow: var(--vortex-elevation-high);
  padding: var(--vortex-spacing-lg, 1.5rem);
  box-sizing: border-box;
}

dialog.vortex-dialog::backdrop,
dialog.vortex-drawer::backdrop {
  background-color: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
}

.vortex-dialog-header,
.vortex-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--vortex-spacing-md, 1rem);
}

.vortex-dialog-title,
.vortex-drawer-title {
  margin: 0;
  font-family: var(--vortex-font-family-heading, var(--vortex-font-family));
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--vortex-foreground);
}

.vortex-dialog-close,
.vortex-drawer-close {
  background: transparent;
  border: none;
  font-size: 1.5rem;
  line-height: 1;
  color: var(--vortex-foreground-muted);
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  border-radius: var(--vortex-radius-sm);
  transition: color 140ms ease, background-color 140ms ease;
}

.vortex-dialog-close:hover,
.vortex-drawer-close:hover {
  color: var(--vortex-foreground);
  background-color: var(--vortex-surface-secondary);
}

.vortex-dialog-close:focus-visible,
.vortex-drawer-close:focus-visible {
  outline: var(--vortex-focus-outline);
  outline-offset: 2px;
}

.vortex-dialog-body,
.vortex-drawer-body {
  overflow-y: auto;
  max-height: 70vh;
}

.vortex-dialog-actions,
.vortex-drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--vortex-spacing-sm, 0.5rem);
  margin-top: var(--vortex-spacing-lg, 1.5rem);
}

/* --- Validation Message --- */
.vortex-validation-message {
  border-radius: var(--vortex-radius, 0.25rem);
  padding: var(--vortex-spacing-sm, 0.5rem) var(--vortex-spacing-md, 1rem);
  margin-bottom: var(--vortex-spacing-sm, 0.5rem);
  font-family: var(--vortex-font-family);
}

.vortex-validation-error {
  background-color: var(--vortex-color-danger-surface);
  border: 1px solid var(--vortex-color-danger-border);
  color: var(--vortex-color-danger);
}

.vortex-validation-warning {
  background-color: var(--vortex-color-warning-surface);
  border: 1px solid var(--vortex-color-warning-border);
  color: var(--vortex-color-warning);
}

.vortex-validation-info {
  background-color: var(--vortex-color-info-surface);
  border: 1px solid var(--vortex-color-info-border);
  color: var(--vortex-color-info);
}

.vortex-validation-title {
  font-weight: 700;
  margin: 0 0 0.25rem 0;
  font-size: 0.875rem;
}

.vortex-validation-text {
  margin: 0;
  font-size: 0.875rem;
}

.vortex-validation-list {
  margin: 0;
  padding-left: 1.25rem;
  font-size: 0.875rem;
}

/* --- Display State Container --- */
.vortex-display-state {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--vortex-spacing-lg, 1.5rem);
  border-radius: var(--vortex-radius, 0.25rem);
  font-family: var(--vortex-font-family);
  font-size: 0.875rem;
}

.vortex-display-loading {
  background-color: var(--vortex-surface-secondary);
  color: var(--vortex-foreground-muted);
}

.vortex-display-empty {
  background-color: var(--vortex-surface-secondary);
  color: var(--vortex-foreground-muted);
  border: 1px dashed var(--vortex-color-border);
}

.vortex-display-refused {
  background-color: var(--vortex-color-danger-surface);
  border-left: 4px solid var(--vortex-color-danger);
  color: var(--vortex-color-danger);
}

.vortex-display-unavailable {
  background-color: var(--vortex-color-warning-surface);
  border-left: 4px solid var(--vortex-color-warning);
  color: var(--vortex-color-warning);
  margin-bottom: var(--vortex-spacing-sm, 0.5rem);
}

/* --- Table Display (.vortex-table) --- */
.vortex-display-table {
  width: 100%;
  overflow-x: auto;
}

.vortex-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--vortex-font-family);
  font-size: 0.875rem;
  color: var(--vortex-foreground);
}

.vortex-table-header-cell {
  background-color: var(--vortex-surface-secondary);
  color: var(--vortex-foreground-muted);
  font-weight: 600;
  text-align: left;
  padding: var(--vortex-density-cell-padding-y) var(--vortex-density-cell-padding-x);
  border-bottom: var(--vortex-border-width, 1px) solid var(--vortex-color-border);
}

.vortex-table-row {
  border-bottom: var(--vortex-border-width, 1px) solid var(--vortex-color-border);
  transition: background-color 100ms ease;
}

.vortex-table-row:hover {
  background-color: var(--vortex-surface-secondary);
}

.vortex-table-cell {
  padding: var(--vortex-density-cell-padding-y) var(--vortex-density-cell-padding-x);
  vertical-align: middle;
}

.vortex-sort-button {
  background: transparent;
  border: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-weight: 600;
  border-radius: var(--vortex-radius-sm);
  padding: 0.125rem 0.25rem;
}

.vortex-sort-button:focus-visible {
  outline: var(--vortex-focus-outline);
  outline-offset: 2px;
}

/* --- List & Grouped Data Displays --- */
.vortex-display-list,
.vortex-display-grouped-data {
  width: 100%;
  font-family: var(--vortex-font-family);
}

.vortex-list-items,
.vortex-group-items {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--vortex-spacing-xs, 0.25rem);
}

.vortex-list-item,
.vortex-group-item {
  padding: var(--vortex-spacing-sm, 0.5rem) var(--vortex-spacing-md, 1rem);
  border-radius: var(--vortex-radius, 0.25rem);
  border: var(--vortex-border-width, 1px) solid var(--vortex-color-border);
  background-color: var(--vortex-surface);
  transition: background-color 100ms ease;
}

.vortex-list-item:hover,
.vortex-group-item:hover {
  background-color: var(--vortex-surface-secondary);
}

.vortex-group-heading {
  font-family: var(--vortex-font-family-heading, var(--vortex-font-family));
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--vortex-foreground);
  margin: var(--vortex-spacing-md, 1rem) 0 var(--vortex-spacing-xs, 0.25rem);
}

.vortex-list-heading,
.vortex-group-item-heading {
  font-weight: 600;
  color: var(--vortex-foreground);
}

.vortex-list-secondary,
.vortex-group-item-secondary {
  color: var(--vortex-foreground-muted);
  font-size: 0.8125rem;
}

/* --- Record Detail Display --- */
.vortex-display-record-detail {
  width: 100%;
  font-family: var(--vortex-font-family);
}

.vortex-record-detail-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--vortex-spacing-md, 1rem);
  margin: 0;
}

.vortex-record-detail-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.vortex-field-value {
  margin: 0;
  color: var(--vortex-foreground);
  font-size: 0.875rem;
}

/* --- Summary Values Display --- */
.vortex-display-summary-values {
  width: 100%;
  font-family: var(--vortex-font-family);
}

.vortex-summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--vortex-spacing-md, 1rem);
  margin: 0;
}

.vortex-summary-card {
  display: flex;
  flex-direction: column;
  padding: var(--vortex-spacing-md, 1rem);
  background-color: var(--vortex-surface);
  border: var(--vortex-border-width, 1px) solid var(--vortex-color-border);
  border-radius: var(--vortex-radius, 0.25rem);
  box-shadow: var(--vortex-elevation-low);
}

.vortex-summary-label {
  color: var(--vortex-foreground-muted);
  font-size: 0.8125rem;
  font-weight: 500;
}

.vortex-summary-value {
  margin: 0.25rem 0 0 0;
  color: var(--vortex-foreground);
  font-size: 1.5rem;
  font-weight: 700;
}

/* --- Display Cells --- */
.vortex-cell-text {
  color: var(--vortex-foreground);
}

.vortex-cell-number {
  color: var(--vortex-foreground);
  font-variant-numeric: tabular-nums;
}

.vortex-cell-boolean {
  color: var(--vortex-foreground);
}

.vortex-cell-date {
  color: var(--vortex-foreground);
}

.vortex-cell-choice {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: var(--vortex-radius-full, 9999px);
  background-color: var(--vortex-surface-secondary);
  color: var(--vortex-foreground);
  font-size: 0.8125rem;
  font-weight: 500;
}

.vortex-cell-link {
  color: var(--vortex-color-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.vortex-cell-link:hover {
  filter: brightness(1.15);
}

.vortex-cell-empty {
  color: var(--vortex-foreground-muted);
  opacity: 0.7;
}

/* --- Rich Text Display --- */
.vortex-display-rich-text,
.vortex-cell-rich-text {
  font-family: var(--vortex-font-family);
  color: var(--vortex-foreground);
  line-height: var(--vortex-line-height, 1.5);
}

.vortex-display-rich-text a,
.vortex-cell-rich-text a {
  color: var(--vortex-color-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.vortex-display-rich-text blockquote,
.vortex-cell-rich-text blockquote {
  border-left: 3px solid var(--vortex-color-border);
  margin: var(--vortex-spacing-sm, 0.5rem) 0;
  padding-left: var(--vortex-spacing-sm, 0.5rem);
  color: var(--vortex-foreground-muted);
}

.vortex-display-rich-text code,
.vortex-cell-rich-text code {
  font-family: var(--vortex-font-family-mono, monospace);
  background-color: var(--vortex-surface-secondary);
  padding: 0.125rem 0.25rem;
  border-radius: var(--vortex-radius-sm, 0.125rem);
}

/* --- Screen Reader Only Utility --- */
.vortex-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}

/* --- Motion Preservation Standard --- */
@media (prefers-reduced-motion: reduce) {
  .vortex-button,
  .vortex-input,
  .vortex-textarea,
  .vortex-select,
  .vortex-checkbox,
  .vortex-radio,
  .vortex-switch,
  .vortex-switch-thumb,
  .vortex-tab,
  .vortex-table-row,
  .vortex-list-item,
  .vortex-group-item {
    transition-duration: 1ms !important;
    animation-duration: 1ms !important;
  }
}
`.trim();

/**
 * Complete CSS string containing both the fallback CSS variables and the shared components styles.
 */
export const ALL_THEME_AND_COMPONENT_STYLES_CSS = `
${SHARED_COMPONENTS_CSS}
`.trim();
