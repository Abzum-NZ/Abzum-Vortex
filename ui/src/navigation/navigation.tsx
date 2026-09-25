"use client";

import { useId, useState, type MouseEvent, type ReactElement } from "react";
import type { ProjectedNavigation, ProjectedNavigationItem } from "@vortex/contracts";
import type { Breakpoint } from "../definition-error";
import { NAVIGATION_STYLES_CSS } from "./navigation-styles";

export type { ProjectedNavigation, ProjectedNavigationItem };

export type ApplicationNavigationProps = Readonly<{
  /** The viewer's already permission-filtered navigation, in definition order. */
  navigation: ProjectedNavigation;
  /** Accessible name for the navigation landmark, from the application or shell. */
  label: string;
  /**
   * Resolves one internal page identity to the address the shell routes on. Route composition
   * owns the address shape; navigation never invents one.
   */
  resolvePageHref: (pageId: string) => string;
  /** Exact internal page identity currently shown, for the current-page state. */
  currentPageId?: string;
  /**
   * Host breakpoint. A phone breakpoint forces the compact disclosure layout even when the
   * viewport query would not; the same data and DOM are used either way.
   */
  breakpoint?: Breakpoint;
  /**
   * Internal page activation. The shell performs the client-side transition so the shell and
   * this navigation stay mounted. The event is passed through unchanged, so the shell decides
   * how to treat modifier and middle clicks; when this is omitted the browser follows the href.
   */
  onNavigate?: (pageId: string, event: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
}>;

type NavigationListProps = Readonly<{
  items: ProjectedNavigation;
  listId?: string;
  /** The heading that names a nested group, so assistive technology announces the group. */
  labelledBy?: string;
  nested: boolean;
  headingId: (itemId: string) => string;
  resolvePageHref: (pageId: string) => string;
  currentPageId: string | undefined;
  onNavigate: ((pageId: string, event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
}>;

const samePage = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** Renders one level of the tree; headings recurse into their retained children. */
function NavigationList({
  items,
  listId,
  labelledBy,
  nested,
  headingId,
  resolvePageHref,
  currentPageId,
  onNavigate,
}: NavigationListProps): ReactElement {
  return (
    <ul
      {...(listId === undefined ? {} : { id: listId })}
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      className={nested ? "vortex-navigation-children" : "vortex-navigation-list"}
    >
      {items.map((item) => {
        if (item.type === "heading") {
          const id = headingId(item.id);
          return (
            <li key={item.id} className="vortex-navigation-group">
              <span className="vortex-navigation-heading" id={id}>
                {item.label}
              </span>
              <NavigationList
                items={item.children}
                labelledBy={id}
                nested
                headingId={headingId}
                resolvePageHref={resolvePageHref}
                currentPageId={currentPageId}
                onNavigate={onNavigate}
              />
            </li>
          );
        }
        if (item.type === "external") {
          return (
            <li
              key={item.id}
              className="vortex-navigation-item"
              data-vortex-navigation-item-id={item.id}
              data-vortex-navigation-item-type="external"
            >
              <a
                className="vortex-navigation-link vortex-navigation-external"
                href={item.address}
                rel="noopener noreferrer"
              >
                <span className="vortex-navigation-label">{item.label}</span>{" "}
                <span className="vortex-navigation-external-indicator">External</span>
              </a>
            </li>
          );
        }
        const current =
          currentPageId !== undefined && samePage(item.pageId, currentPageId);
        return (
          <li
            key={item.id}
            className="vortex-navigation-item"
            data-vortex-navigation-item-id={item.id}
            data-vortex-navigation-item-type="page"
          >
            <a
              className="vortex-navigation-link"
              href={resolvePageHref(item.pageId)}
              {...(current ? { "aria-current": "page" as const } : {})}
              onClick={(event) => onNavigate?.(item.pageId, event)}
            >
              {item.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Renders the application navigation in the shell. On desktop it is the full ordered tree; on a
 * phone viewport it is the same tree behind one disclosure control, so the compact form is the
 * same information architecture rather than a second definition. The component keeps its own
 * state while the shell stays mounted across internal page changes; choosing a page closes the
 * compact disclosure. Every page link carries `aria-current` when it names the shown page, and
 * external links are marked external and carry no referrer or opener access.
 */
export function ApplicationNavigation({
  navigation,
  label,
  resolvePageHref,
  currentPageId,
  breakpoint,
  onNavigate,
  className,
}: ApplicationNavigationProps): ReactElement {
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const headingId = (itemId: string): string => `${baseId}-heading-${itemId}`;
  const compact = breakpoint === "phone";
  // Choosing a page closes the compact disclosure so the destination is visible; the shell still
  // performs the transition and this component stays mounted.
  const activatePage = (pageId: string, event: MouseEvent<HTMLAnchorElement>): void => {
    setOpen(false);
    onNavigate?.(pageId, event);
  };

  return (
    <nav
      aria-label={label}
      data-vortex-navigation-open={open ? "true" : "false"}
      {...(compact ? { "data-vortex-navigation-compact": "true" as const } : {})}
      className={className === undefined ? "vortex-navigation" : `vortex-navigation ${className}`}
    >
      <style href="vortex-navigation-styles" precedence="default">
        {NAVIGATION_STYLES_CSS}
      </style>
      {navigation.length === 0 ? (
        <p className="vortex-navigation-empty">No navigation is available.</p>
      ) : (
        <>
          <button
            type="button"
            className="vortex-navigation-toggle"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((value) => !value)}
          >
            <span>{label}</span>
            <span aria-hidden="true" className="vortex-navigation-toggle-icon">
              {open ? "\u2212" : "\u2630"}
            </span>
          </button>
          <NavigationList
            items={navigation}
            listId={listId}
            nested={false}
            headingId={headingId}
            resolvePageHref={resolvePageHref}
            currentPageId={currentPageId}
            onNavigate={activatePage}
          />
        </>
      )}
    </nav>
  );
}
