"use client";

import { useId, useState, type MouseEvent, type ReactElement } from "react";
import { MenuIcon, XIcon } from "lucide-react";
import type { ProjectedNavigation, ProjectedNavigationItem } from "@vortex/contracts";
import { Button } from "../components/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../components/sidebar";
import {
  DefinitionRenderError,
  type Breakpoint,
  type DefinitionRenderErrorLocation,
} from "../definition-error";
import { getAccessibleName } from "../display/display-state-container";
import { cn } from "../lib/utils";
import type { PlatformBlockRenderProps } from "../registry";

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
  /**
   * Heading depth of this list. The top level and the children of a top-level heading are menus,
   * the labelled group the shadcn sidebar draws; deeper headings nest as sub-menus.
   */
  depth: number;
  listId?: string;
  /** The heading that names a nested group, so assistive technology announces the group. */
  labelledBy?: string;
  /** Visibility classes for the top-level list, which the compact disclosure shows and hides. */
  className?: string;
  headingId: (itemId: string) => string;
  resolvePageHref: (pageId: string) => string;
  currentPageId: string | undefined;
  onNavigate: ((pageId: string, event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
}>;

const samePage = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * Renders one level of the tree on the shadcn sidebar menu parts; headings recurse into their
 * retained children. The top level and a top-level heading's children use the menu and its
 * button; deeper levels use the sub-menu and its button, so the tree keeps its depth visibly.
 */
function NavigationList({
  items,
  depth,
  listId,
  labelledBy,
  className,
  headingId,
  resolvePageHref,
  currentPageId,
  onNavigate,
}: NavigationListProps): ReactElement {
  const sub = depth > 1;
  const List = sub ? SidebarMenuSub : SidebarMenu;
  const Item = sub ? SidebarMenuSubItem : SidebarMenuItem;
  const renderLink = (link: ReactElement, content: ReactElement, current: boolean): ReactElement =>
    sub ? (
      <SidebarMenuSubButton render={link} isActive={current}>
        {content}
      </SidebarMenuSubButton>
    ) : (
      <SidebarMenuButton render={link} isActive={current}>
        {content}
      </SidebarMenuButton>
    );

  return (
    <List
      {...(listId === undefined ? {} : { id: listId })}
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      className={cn("list-none", className)}
    >
      {items.map((item) => {
        if (item.type === "heading") {
          const id = headingId(item.id);
          return (
            <Item key={item.id} data-vortex-navigation-item-id={item.id}>
              <SidebarGroupLabel render={<span id={id} />}>{item.label}</SidebarGroupLabel>
              <NavigationList
                items={item.children}
                depth={depth + 1}
                labelledBy={id}
                headingId={headingId}
                resolvePageHref={resolvePageHref}
                currentPageId={currentPageId}
                onNavigate={onNavigate}
              />
            </Item>
          );
        }
        if (item.type === "external") {
          return (
            <Item
              key={item.id}
              data-vortex-navigation-item-id={item.id}
              data-vortex-navigation-item-type="external"
            >
              {renderLink(
                <a href={item.address} rel="noopener noreferrer" />,
                <>
                  <span className="underline underline-offset-4">{item.label}</span>
                  <span className="ms-auto text-xs text-muted-foreground">External</span>
                </>,
                false,
              )}
            </Item>
          );
        }
        const current = currentPageId !== undefined && samePage(item.pageId, currentPageId);
        return (
          <Item
            key={item.id}
            data-vortex-navigation-item-id={item.id}
            data-vortex-navigation-item-type="page"
          >
            {renderLink(
              <a
                href={resolvePageHref(item.pageId)}
                {...(current ? { "aria-current": "page" as const } : {})}
                onClick={(event) => onNavigate?.(item.pageId, event)}
              />,
              <span>{item.label}</span>,
              current,
            )}
          </Item>
        );
      })}
    </List>
  );
}

/**
 * Renders the application navigation in the shell on the shadcn Sidebar. On desktop it is the
 * full ordered tree; on a phone viewport it is the same tree behind one disclosure control, so the
 * compact form is the same information architecture rather than a second definition. The sidebar
 * fills the placement the shell gives it and paints from the resolved theme's sidebar variables;
 * the application root's menu colour and menu accent selections restyle it through the shared
 * stylesheet. The component keeps its own state while the shell stays mounted across internal
 * page changes; choosing a page closes the compact disclosure. Every page link carries
 * `aria-current` when it names the shown page, and external links are marked external and carry
 * no referrer or opener access.
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

  // A forced phone breakpoint always uses the disclosure; otherwise a narrow viewport does through
  // the small-screen variant, so the same server HTML adapts before any script runs.
  const toggleVisibility = compact ? "flex" : "hidden max-sm:flex";
  const listVisibility = open ? "flex" : compact ? "hidden" : "flex max-sm:hidden";

  return (
    <nav
      aria-label={label}
      data-vortex-navigation-open={open ? "true" : "false"}
      {...(compact ? { "data-vortex-navigation-compact": "true" as const } : {})}
      className={cn("w-full min-w-0", className)}
    >
      <Sidebar className="h-auto w-full">
        <SidebarContent>
          <SidebarGroup>
            {navigation.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">No navigation is available.</p>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn("w-full justify-between", toggleVisibility)}
                  aria-expanded={open}
                  aria-controls={listId}
                  onClick={() => setOpen((value) => !value)}
                >
                  <span>{label}</span>
                  {open ? <XIcon aria-hidden="true" /> : <MenuIcon aria-hidden="true" />}
                </Button>
                <SidebarGroupContent>
                  <NavigationList
                    items={navigation}
                    depth={0}
                    listId={listId}
                    className={listVisibility}
                    headingId={headingId}
                    resolvePageHref={resolvePageHref}
                    currentPageId={currentPageId}
                    onNavigate={activatePage}
                  />
                </SidebarGroupContent>
              </>
            )}
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </nav>
  );
}

/**
 * Registered renderer for the application navigation block. It draws the one `ProjectedNavigation`
 * the server already filtered for this viewer, in definition order, and never filters, fetches or
 * invents an item; an absent projection is an empty menu. The shell supplies the page-address
 * resolver, so route composition owns the address shape; a non-empty menu without one is refused
 * rather than linking to an invented address. Its registration refuses every supplied runtime
 * input, because a menu is navigation rather than a data surface.
 */
export function ApplicationNavigationBlock(props: PlatformBlockRenderProps): ReactElement {
  const location: DefinitionRenderErrorLocation = {
    placementId: props.placementId,
    blockId: props.metadata.blockId,
    releaseVersion: props.metadata.releaseVersion,
  };
  const label = getAccessibleName(props.settings, props.metadata);
  if (label === undefined)
    throw new DefinitionRenderError(
      "MISSING_ACCESSIBLE_NAME",
      "The application navigation block requires a non-blank accessible name",
      location,
    );

  const navigation = props.projectedNavigation ?? [];
  const resolvePageHref = props.resolvePageHref;
  if (resolvePageHref === undefined && navigation.length > 0)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "The application navigation block requires the shell's page-address resolver",
      location,
    );

  return (
    <ApplicationNavigation
      navigation={navigation}
      label={label}
      // Only reachable with an empty menu, which renders no page link.
      resolvePageHref={resolvePageHref ?? (() => "")}
      {...(props.currentPageId === undefined ? {} : { currentPageId: props.currentPageId })}
      breakpoint={props.breakpoint}
    />
  );
}
