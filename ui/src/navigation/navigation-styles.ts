/**
 * Navigation stylesheet. It reads only the fixed `--vortex-*` variables the shared theme root
 * publishes, so application themes dress navigation through their validated tokens and never
 * through new class names, selectors or executable values. The same single list is laid out as
 * a compact disclosure on a narrow (phone) viewport; the phone layout is not a second definition.
 */
export const NAVIGATION_STYLES_CSS = `
.vortex-navigation {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--vortex-space-sm);
}

.vortex-navigation-toggle {
  display: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--vortex-space-sm);
  min-height: var(--vortex-control-min-height);
  padding: var(--vortex-control-padding-y) var(--vortex-control-padding-x);
  border: var(--vortex-border-width) var(--vortex-border-style) var(--vortex-border-color);
  border-radius: var(--vortex-radius-md);
  background-color: var(--vortex-surface);
  color: var(--vortex-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: box-shadow var(--vortex-motion-feedback) ease-out;
}

.vortex-navigation-toggle:hover {
  box-shadow: inset 0 0 0 0.125rem currentColor;
}

.vortex-navigation-toggle-icon {
  font-weight: 400;
}

.vortex-navigation-list,
.vortex-navigation-children {
  display: flex;
  flex-direction: column;
  gap: var(--vortex-space-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}

.vortex-navigation-children {
  margin-inline-start: var(--vortex-space-md);
}

.vortex-navigation-group,
.vortex-navigation-item {
  display: flex;
  flex-direction: column;
  gap: var(--vortex-space-xs);
}

.vortex-navigation-heading {
  padding: var(--vortex-space-xs) var(--vortex-control-padding-x);
  color: var(--vortex-text-muted);
  font-weight: 700;
}

.vortex-navigation-link {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: var(--vortex-space-xs);
  min-height: var(--vortex-control-min-height);
  padding: var(--vortex-control-padding-y) var(--vortex-control-padding-x);
  border-radius: var(--vortex-radius-md);
  color: var(--vortex-text);
  text-decoration: none;
  transition: box-shadow var(--vortex-motion-feedback) ease-out;
}

.vortex-navigation-link:hover {
  box-shadow: inset 0 0 0 0.125rem var(--vortex-border-color);
}

.vortex-navigation-link[aria-current="page"] {
  font-weight: 700;
  box-shadow: inset 0.1875rem 0 0 var(--vortex-accent);
}

.vortex-navigation-external {
  text-decoration: underline;
  text-underline-offset: 0.125rem;
}

.vortex-navigation-external-indicator {
  color: var(--vortex-text-muted);
  font-size: 0.8125rem;
  text-decoration: none;
}

.vortex-navigation-empty {
  padding: var(--vortex-space-sm) var(--vortex-control-padding-x);
  color: var(--vortex-text-muted);
}

.vortex-navigation[data-vortex-navigation-compact="true"] .vortex-navigation-toggle {
  display: flex;
}

.vortex-navigation[data-vortex-navigation-compact="true"] .vortex-navigation-list {
  display: none;
}

.vortex-navigation[data-vortex-navigation-compact="true"][data-vortex-navigation-open="true"]
  .vortex-navigation-list {
  display: flex;
}

@media (max-width: 40rem) {
  .vortex-navigation-toggle {
    display: flex;
  }

  .vortex-navigation-list {
    display: none;
  }

  .vortex-navigation[data-vortex-navigation-open="true"] .vortex-navigation-list {
    display: flex;
  }
}

@media (prefers-reduced-motion: reduce) {
  .vortex-navigation-toggle,
  .vortex-navigation-link {
    transition: none;
  }
}
`.trim();
