"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { Icon } from "../icons/icon";
import { readMotionTiming, type MotionTiming } from "./motion-tokens";
import type { ProjectedNavigation, ProjectedNavigationItem } from "@vortex/platform/schema";
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
  /**
   * Intent to open a page: the pointer rests on its link or focus reaches it. The shell may start
   * loading that page so the click lands sooner; nothing is loaded for links never approached.
   */
  onPrefetch?: (pageId: string) => void;
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
  /**
   * The page the shell is transitioning to, shown as the selected item until the transition ends
   * so a choice is acknowledged at once. `aria-current` stays on the page actually shown.
   */
  pendingPageId: string | undefined;
  onNavigate: ((pageId: string, event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
  onPrefetch: ((pageId: string) => void) | undefined;
  /** The one selected-item indicator's layout identity and its slide timing. */
  indicator: Readonly<{ layoutId: string; timing: MotionTiming | undefined }>;
}>;

/**
 * Whether the host is carrying out a page change it started from this navigation. When a change
 * ends without the shown page changing (it failed or was refused), the chosen item gives the
 * selection back to the shown page at once.
 */
export const PageNavigationBusyContext = createContext(false);

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
  pendingPageId,
  onNavigate,
  onPrefetch,
  indicator,
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
              <SidebarGroupLabel render={<span id={id} />}>
                <span data-vortex-navigation-label="">{item.label}</span>
              </SidebarGroupLabel>
              <NavigationList
                items={item.children}
                depth={depth + 1}
                labelledBy={id}
                headingId={headingId}
                resolvePageHref={resolvePageHref}
                currentPageId={currentPageId}
                pendingPageId={pendingPageId}
                onNavigate={onNavigate}
                onPrefetch={onPrefetch}
                indicator={indicator}
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
                <a
                  href={item.address}
                  rel="noopener noreferrer"
                  aria-label={`${item.label} (external)`}
                />,
                <>
                  <Icon name={item.icon} aria-hidden="true" />
                  <span
                    data-vortex-navigation-label=""
                    className="min-w-0 truncate underline underline-offset-4"
                  >
                    {item.label}
                  </span>
                  <span className="ms-auto shrink-0 text-xs text-muted-foreground">External</span>
                </>,
                false,
              )}
            </Item>
          );
        }
        const current = currentPageId !== undefined && samePage(item.pageId, currentPageId);
        const pending = pendingPageId !== undefined && samePage(item.pageId, pendingPageId);
        const selected = pendingPageId === undefined ? current : pending;
        return (
          <Item
            key={item.id}
            data-vortex-navigation-item-id={item.id}
            data-vortex-navigation-item-type="page"
          >
            {!selected ? null : (
              // The selected fill slides from the item it leaves to this one.
              <motion.span
                layoutId={indicator.layoutId}
                data-vortex-navigation-indicator=""
                aria-hidden
                transition={indicator.timing ?? { duration: 0 }}
              />
            )}
            {renderLink(
              <a
                href={resolvePageHref(item.pageId)}
                aria-label={item.label}
                {...(current ? { "aria-current": "page" as const } : {})}
                {...(pending ? { "data-vortex-navigation-pending": "" } : {})}
                {...(onPrefetch === undefined || current
                  ? {}
                  : {
                      onPointerEnter: () => onPrefetch(item.pageId),
                      onFocus: () => onPrefetch(item.pageId),
                    })}
                onClick={(event) => onNavigate?.(item.pageId, event)}
              />,
              <>
                <Icon name={item.icon} aria-hidden="true" />
                <span data-vortex-navigation-label="">{item.label}</span>
              </>,
              selected,
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
  onPrefetch,
  className,
}: ApplicationNavigationProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<
    Readonly<{ pageId: string; from: string | undefined }> | undefined
  >(undefined);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const headingId = (itemId: string): string => `${baseId}-heading-${itemId}`;
  const compact = breakpoint === "phone";
  // Choosing a page closes the compact disclosure so the destination is visible; the shell still
  // performs the transition and this component stays mounted.
  const activatePage = (pageId: string, event: MouseEvent<HTMLAnchorElement>): void => {
    setOpen(false);
    onNavigate?.(pageId, event);
    // When the shell took over the transition, the chosen item is selected at once; it is
    // dropped as soon as the shown page changes, so it never outlives that transition.
    if (event.defaultPrevented && !(currentPageId !== undefined && samePage(pageId, currentPageId)))
      setPending({ pageId, from: currentPageId });
  };
  // A transition ends when the shown page changes (including Back/Forward), so the pending choice
  // is cleared then rather than only hidden; a transition that never lands is dropped after 10 s.
  const [shownPageId, setShownPageId] = useState(currentPageId);
  if (shownPageId !== currentPageId) {
    setShownPageId(currentPageId);
    setPending(undefined);
  }
  // A change the host started and then finished without changing the shown page (it failed or was
  // refused) gives the selection back to the shown page.
  const navigationBusy = useContext(PageNavigationBusyContext);
  const [hostBusy, setHostBusy] = useState(navigationBusy);
  if (hostBusy !== navigationBusy) {
    setHostBusy(navigationBusy);
    if (!navigationBusy) setPending(undefined);
  }
  useEffect(() => {
    if (pending === undefined) return;
    const timer = setTimeout(() => setPending(undefined), 10_000);
    return () => clearTimeout(timer);
  }, [pending]);
  // The selected item's indicator slides with the enter-exit motion token; with reduced motion it
  // moves at once.
  const navRef = useRef<HTMLElement>(null);
  const reducedMotion = useReducedMotion();
  const [indicatorTiming, setIndicatorTiming] = useState<MotionTiming>();
  useLayoutEffect(() => {
    if (navRef.current !== null) setIndicatorTiming(readMotionTiming(navRef.current, "enter-exit"));
  }, []);
  const indicator = {
    layoutId: `${baseId}-selected`,
    timing: reducedMotion === true ? undefined : indicatorTiming,
  };
  const pendingPageId =
    pending !== undefined && pending.from === currentPageId ? pending.pageId : undefined;

  // A forced phone breakpoint always uses the disclosure; otherwise a narrow viewport does through
  // the small-screen variant, so the same server HTML adapts before any script runs.
  const toggleVisibility = compact ? "flex" : "hidden max-sm:flex";
  const listVisibility = open ? "flex" : compact ? "hidden" : "flex max-sm:hidden";

  return (
    <nav
      ref={navRef}
      aria-label={label}
      data-vortex-shell-navigation=""
      data-vortex-navigation-open={open ? "true" : "false"}
      {...(compact ? { "data-vortex-navigation-compact": "true" as const } : {})}
      className={cn("w-full min-w-0", className)}
    >
      <Sidebar className="md:min-h-svh">
        <SidebarContent>
          <SidebarGroup>
            <Button
              type="button"
              variant="ghost"
              className={cn("w-full justify-between", toggleVisibility)}
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen((value) => !value)}
            >
              <span>{label}</span>
              {open ? (
                <Icon name="close" aria-hidden="true" />
              ) : (
                <Icon name="menu" aria-hidden="true" />
              )}
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
                pendingPageId={pendingPageId}
                onNavigate={activatePage}
                onPrefetch={onPrefetch}
                indicator={indicator}
              />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </nav>
  );
}

/**
 * Registered renderer for the application navigation block. It draws the one `ProjectedNavigation`
 * the server already filtered for this viewer, in definition order, and never filters, fetches or
 * invents an item; an absent or empty projection draws nothing. The shell supplies the page-address
 * resolver, so route composition owns the address shape; a menu without one is refused
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
  // An empty menu draws nothing.
  if (navigation.length === 0) return <></>;
  const resolvePageHref = props.resolvePageHref;
  if (resolvePageHref === undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "The application navigation block requires the shell's page-address resolver",
      location,
    );

  return (
    <ApplicationNavigation
      navigation={navigation}
      label={label}
      resolvePageHref={resolvePageHref}
      {...(props.currentPageId === undefined ? {} : { currentPageId: props.currentPageId })}
      {...(props.onNavigatePage === undefined ? {} : { onNavigate: props.onNavigatePage })}
      {...(props.onPrefetchPage === undefined ? {} : { onPrefetch: props.onPrefetchPage })}
      breakpoint={props.breakpoint}
    />
  );
}
