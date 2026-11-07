"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ApplicationPuckRootShell } from "@vortex/platform/schema";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../components/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Button } from "../components/button";
import { Spinner } from "../components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { SidebarProvider, SidebarTrigger } from "../components/sidebar";
import { FlowSurfaceContext } from "../flow-runtime/flow-surface-context";
import { Icon } from "../icons/icon";
import { cn } from "../lib/utils";
import { NavigationLink } from "../routing/navigation-link";
import { SIGNED_IN_LANDING_PATH } from "../routing/destination";
import { useNavigator } from "../routing/navigator";
import { resolveVortexIconName } from "../icons/icon-names";
import { AppearanceToggle } from "./appearance-toggle";
import { ApplicationAccountMenu, useApplicationAccountActions } from "./account-actions";
import {
  ApplicationSearchControl,
  type ApplicationSearchRuntime,
} from "./application-search-control";

export type ApplicationWebMcpRuntime = Readonly<{
  status: "registering" | "active" | "off" | "error";
  turnOff: () => void;
  turnOn: () => void;
  retry: () => void;
  /** The tool of an agent call that is changing something right now; absent while none is. */
  working?: string;
}>;

export type ApplicationSwitcherData = Readonly<{
  state: "available" | "unavailable" | "temporarily_unavailable";
  applications: readonly Readonly<{ key: string; name: string; href: string; icon?: string }>[];
}>;

type LauncherGroup = Readonly<{
  key: string;
  title: string;
  results: readonly Readonly<{ href: string; title: string; subtitle?: string }>[];
  cursor?: string;
}>;
type LauncherSearchResult =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "available"; groups: readonly LauncherGroup[] }>;
export type ApplicationSwitcherSource = (() => Promise<ApplicationSwitcherData>) & {
  search?: (
    expression: string,
    groupKey?: string,
    cursor?: string,
  ) => Promise<LauncherSearchResult>;
};

/** The switcher's on-demand read travels outside Puck's copied metadata. */
export const ApplicationSwitcherContext = createContext<ApplicationSwitcherSource | undefined>(
  undefined,
);

export type ApplicationShellRuntime = Readonly<{
  applicationName: string;
  applicationHref: string;
  organizationName: string;
  /** The organisation's address segment, shown beside its display name in the organisation menu. */
  organizationShortName?: string;
  pageName: string;
  /** Page agent-tool state supplied through Puck metadata to the definition-selected shell. */
  webMcp?: ApplicationWebMcpRuntime;
}>;

// The icon-only collapse is a tablet and desktop form: on a phone the navigation block supplies its own
// disclosure, so the collapse (and its trigger) never narrows the menu region below 641 px.
const shellFrameCss = `
@media (min-width: 641px) {
[data-vortex-sidebar-state="collapsed"] [data-vortex-container-region="menu"]:has([data-vortex-shell-navigation]) {
  width: var(--sidebar-width-icon) !important;
  max-width: var(--sidebar-width-icon) !important;
  flex: 0 0 var(--sidebar-width-icon) !important;
}
[data-vortex-sidebar-state="collapsed"] [data-vortex-shell-navigation] [data-vortex-navigation-label] {
  display: none !important;
}
[data-vortex-sidebar-state="collapsed"] [data-vortex-shell-navigation] [data-slot="sidebar-group-label"] {
  display: none;
}
[data-vortex-sidebar-state="collapsed"] [data-vortex-shell-navigation] [data-sidebar="menu-button"] {
  justify-content: center;
  padding-inline: calc(var(--spacing, 0.25rem) * 3);
}
[data-vortex-sidebar-state="collapsed"] [data-vortex-shell-navigation] [data-sidebar="menu-sub"] {
  display: none;
}
}
@media (min-width: 768px) {
/* The menu fills its region under the header, not the viewport: without a viewport minimum the
   sticky menu region never scrolls, and a long menu scrolls inside its own column. */
[data-vortex-shell-navigation] {
  max-height: calc(100svh - var(--vortex-header-height, 0px) - 2 * var(--vortex-content-padding, 0px));
  overflow-y: auto;
}
}
`;

function SwitcherButton({
  icon,
  label,
}: Readonly<{ icon: "building-2" | "grid"; label: string }>): ReactElement {
  return (
    <>
      <Icon name={icon} aria-hidden="true" data-icon="inline-start" />
      <span className="truncate max-lg:sr-only">{label}</span>
      <Icon
        name="chevron-down"
        aria-hidden="true"
        data-icon="inline-end"
        className="text-muted-foreground max-lg:hidden"
      />
    </>
  );
}

/** What the browser agent tools say about themselves, and the one command that changes it. */
const describeWebMcp = (
  runtime: ApplicationWebMcpRuntime,
): Readonly<{ state: string; label: string; action: string; run: () => void }> => {
  const state = runtime.working === undefined ? runtime.status : "working";
  const label =
    runtime.working !== undefined
      ? `An agent is making a change (${runtime.working})...`
      : runtime.status === "active"
        ? "Browser agent tools are active on this page."
        : runtime.status === "off"
          ? "Browser agent tools are off for this session."
          : runtime.status === "registering"
            ? "Enabling browser agent tools..."
            : "Browser agent tools could not be enabled.";
  return runtime.status === "off"
    ? { state, label, action: "Turn on", run: runtime.turnOn }
    : runtime.status === "error"
      ? { state, label, action: "Retry", run: runtime.retry }
      : { state, label, action: "Turn off for this session", run: runtime.turnOff };
};

/** The agent tools' state as one icon button: its tooltip says the state, and pressing it switches the tools for the session. */
export function WebMcpStatus({
  runtime,
}: Readonly<{ runtime: ApplicationWebMcpRuntime }>): ReactElement {
  const { state, label, action, run } = describeWebMcp(runtime);
  const busy = runtime.status === "registering" || runtime.working !== undefined;
  return (
    <div className="flex shrink-0 items-center" data-vortex-webmcp={state}>
      <span role="status" aria-live="polite" className="sr-only">
        {label}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant={runtime.status === "active" ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={action}
              className={cn("max-sm:size-11", runtime.status === "error" && "text-destructive")}
              onClick={run}
            />
          }
        >
          {busy ? <Spinner /> : <Icon name="activity" />}
        </TooltipTrigger>
        <TooltipContent>
          {label} {action}.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** The agent tools in the header's More menu: the state as its label, the one command as its item. */
function WebMcpMenuItems({
  runtime,
}: Readonly<{ runtime: ApplicationWebMcpRuntime }>): ReactElement {
  const { label, action, run } = describeWebMcp(runtime);
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="max-w-64 font-normal text-muted-foreground">
        {label}
      </DropdownMenuLabel>
      <DropdownMenuItem onClick={run}>
        <Icon name="activity" />
        {action}
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

function Breadcrumbs({
  shellName,
  runtime,
}: Readonly<{ shellName: string; runtime: ApplicationShellRuntime | undefined }>): ReactElement {
  const applicationName = runtime?.applicationName ?? shellName;
  const pageName = runtime?.pageName ?? shellName;
  return (
    <Breadcrumb className="min-w-0 max-md:flex-1">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="min-w-0 max-md:hidden">
          {runtime === undefined ? (
            <span className="truncate">{applicationName}</span>
          ) : (
            <BreadcrumbLink
              render={<NavigationLink href={runtime.applicationHref} />}
              className="truncate"
            >
              {applicationName}
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>
        <BreadcrumbSeparator className="max-md:hidden">
          <Icon name="chevron-right" aria-hidden="true" />
        </BreadcrumbSeparator>
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="truncate">{pageName}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function OrganizationSwitcher({
  runtime,
}: Readonly<{ runtime: ApplicationShellRuntime | undefined }>): ReactElement {
  const actions = useApplicationAccountActions();
  const navigator = useNavigator();
  const organizationName = runtime?.organizationName ?? actions?.organizationName ?? "Organisation";
  const organizationShortName = runtime?.organizationShortName ?? actions?.organizationShortName;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={runtime === undefined && actions === null}
        aria-label={`Organisation: ${organizationName}`}
        render={
          <Button variant="ghost" size="sm" className="max-w-72 max-sm:min-h-11 max-sm:min-w-11" />
        }
      >
        <SwitcherButton icon="building-2" label={organizationName} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-[var(--vortex-space-xs)]">
            <span>{organizationName}</span>
            {organizationShortName === undefined ? null : (
              <span className="font-normal text-muted-foreground">{organizationShortName}</span>
            )}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={actions === null}
          onClick={() => navigator.navigate(SIGNED_IN_LANDING_PATH)}
        >
          Switch organisation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const SWITCHER_NOTICE =
  "px-[var(--vortex-space-md)] py-[var(--vortex-space-sm)] text-sm text-muted-foreground";

/**
 * Down, Up, Home and End move between the switcher's applications (the disclosure pattern keeps
 * them; Tab still visits each one).
 */
const moveBetweenApplications = (event: KeyboardEvent<HTMLUListElement>) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled")];
  const at = buttons.indexOf(event.target as HTMLButtonElement);
  const next =
    event.key === "ArrowDown"
      ? buttons[Math.min(at + 1, buttons.length - 1)]
      : event.key === "ArrowUp"
        ? buttons[Math.max(at - 1, 0)]
        : event.key === "Home"
          ? buttons[0]
          : event.key === "End"
            ? buttons.at(-1)
            : undefined;
  if (next === undefined || at === -1) return;
  event.preventDefault();
  next.focus();
};

/**
 * The application switcher: a popover with a search above the list of applications. It is not a
 * menu because a menu may hold only items, so its search field and results have no place in one.
 */
function ApplicationSwitcher({
  shellName,
  runtime,
}: Readonly<{ shellName: string; runtime: ApplicationShellRuntime | undefined }>): ReactElement {
  const applicationName = runtime?.applicationName ?? shellName;
  const actions = useApplicationAccountActions();
  const navigator = useNavigator();
  const source = useContext(ApplicationSwitcherContext);
  const [open, setOpen] = useState(false);
  const [switcher, setSwitcher] = useState<ApplicationSwitcherData>();
  const [searchExpression, setSearchExpression] = useState("");
  const [search, setSearch] = useState<LauncherSearchResult>({ kind: "available", groups: [] });
  const searchToken = useRef(0);
  const requestToken = useRef(0);
  const intentStarted = useRef(false);
  const intentRead = useRef<Promise<void> | undefined>(undefined);
  useEffect(
    () => () => {
      requestToken.current += 1;
    },
    [],
  );
  const read = async () => {
    if (source === undefined || actions === null) return;
    const token = ++requestToken.current;
    setSwitcher(undefined);
    try {
      const result = await source();
      if (token === requestToken.current) setSwitcher(result);
    } catch (error) {
      console.error("[application-shell] switcher read failed", error);
      if (token === requestToken.current)
        setSwitcher({ state: "temporarily_unavailable", applications: [] });
    }
  };
  const readOnIntent = (event: { currentTarget: HTMLElement }) => {
    // Serve the visible page first. An early hover never competes with its streamed data or a
    // pending page change; a later pointer entry or keyboard focus can still express intent.
    const root = event.currentTarget.closest("[data-vortex-puck-root]");
    if (
      intentStarted.current ||
      document.readyState !== "complete" ||
      root === null ||
      root.querySelector('[data-vortex-display-state="loading"], [data-vortex-page-transition]') !==
        null
    )
      return;
    intentStarted.current = true;
    intentRead.current = read();
  };
  // Intent that ends without an open discards its list, so a later open reads current authority.
  const dropIntent = () => {
    if (intentRead.current === undefined) return;
    intentRead.current = undefined;
    requestToken.current += 1;
    setSwitcher(undefined);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          // The first open consumes the intent read, including one still in flight. Later opens
          // read again, so closing the switcher never keeps its application list for another open.
          if (intentRead.current === undefined) void read();
          intentRead.current = undefined;
        } else {
          requestToken.current += 1;
          intentRead.current = undefined;
          setSwitcher(undefined);
          searchToken.current += 1;
          setSearchExpression("");
          setSearch({ kind: "available", groups: [] });
        }
      }}
    >
      <PopoverTrigger
        disabled={source === undefined || actions === null}
        aria-label={`Application: ${applicationName}`}
        onPointerEnter={readOnIntent}
        onFocus={readOnIntent}
        onPointerLeave={dropIntent}
        onBlur={dropIntent}
        render={
          <Button variant="ghost" size="sm" className="max-w-56 max-sm:min-h-11 max-sm:min-w-11" />
        }
      >
        <SwitcherButton icon="grid" label={applicationName} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-[min(28rem,calc(100vw-2rem))] min-w-56 flex-col gap-[var(--vortex-space-xs)]"
        aria-busy={switcher === undefined}
        aria-label="Application switcher"
      >
        {source?.search === undefined ? null : (
          <div className="w-full">
            <ApplicationSearchControl
              placementId="application-switcher-search"
              settings={{
                placeholder: { kind: "text", value: "Search applications and records" },
                submit_label: { kind: "text", value: "Search" },
              }}
              applicationSearch={
                (search.kind === "available"
                  ? {
                      kind: "available",
                      expression: searchExpression,
                      results: [],
                      more: false,
                      groups: search.groups.map((group) => ({
                        ...group,
                        ...(group.cursor === undefined
                          ? {}
                          : {
                              showMore: () => {
                                const token = searchToken.current;
                                void source.search!(searchExpression, group.key, group.cursor)
                                  .then((next) => {
                                    if (
                                      token !== searchToken.current ||
                                      next.kind !== "available" ||
                                      next.groups[0] === undefined
                                    )
                                      return;
                                    const addition = next.groups[0];
                                    setSearch((previous) =>
                                      previous.kind !== "available"
                                        ? previous
                                        : {
                                            kind: "available",
                                            groups: previous.groups.map((old) =>
                                              old.key === group.key && old.cursor === group.cursor
                                                ? {
                                                    ...addition,
                                                    results: [...old.results, ...addition.results],
                                                  }
                                                : old,
                                            ),
                                          },
                                    );
                                  })
                                  .catch((error: unknown) =>
                                    console.error(
                                      "[application-shell] search continuation failed",
                                      error,
                                    ),
                                  );
                              },
                            }),
                      })),
                    }
                  : search.kind === "loading"
                    ? { kind: "loading", expression: searchExpression }
                    : search.kind === "refused"
                      ? { kind: "refused", expression: searchExpression, reason: search.reason }
                      : { kind: "unavailable" }) as ApplicationSearchRuntime
              }
              onSearch={(expression) => {
                const token = ++searchToken.current;
                setSearchExpression(expression);
                if (expression.trim() === "") {
                  setSearch({ kind: "available", groups: [] });
                  return;
                }
                setSearch({ kind: "loading" });
                void source.search!(expression)
                  .then((result) => {
                    if (token === searchToken.current) setSearch(result);
                  })
                  .catch((error: unknown) => {
                    console.error("[application-shell] search failed", error);
                    if (token === searchToken.current) setSearch({ kind: "unavailable" });
                  });
              }}
            />
          </div>
        )}
        {switcher === undefined ? (
          <p role="status" className={SWITCHER_NOTICE}>
            Loading applications…
          </p>
        ) : switcher.state !== "available" ? (
          <>
            <p role="status" className={SWITCHER_NOTICE}>
              {switcher.state === "temporarily_unavailable"
                ? "Applications temporarily unavailable"
                : "Applications unavailable"}
            </p>
            <Button variant="ghost" size="sm" onClick={() => void read()}>
              Retry
            </Button>
          </>
        ) : switcher.applications.length === 0 ? (
          <p role="status" className={SWITCHER_NOTICE}>
            No other applications
          </p>
        ) : (
          <ul
            aria-label="Applications"
            className="m-0 flex list-none flex-col gap-[var(--vortex-space-xs)] p-0"
            onKeyDown={moveBetweenApplications}
          >
            {switcher.applications.map((application) => {
              const current = application.name === applicationName;
              return (
                <li key={application.key}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    aria-current={current ? "true" : undefined}
                    disabled={actions === null}
                    onClick={() => {
                      setOpen(false);
                      navigator.navigate(application.href);
                    }}
                  >
                    <Icon
                      name={resolveVortexIconName(application.icon ?? "") ?? "circle"}
                      aria-hidden="true"
                      data-icon="inline-start"
                    />
                    <span className="min-w-0 flex-1 truncate text-left">{application.name}</span>
                    {current ? <Icon name="check" aria-hidden="true" /> : null}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The id of the page's one `<main>`: the skip link targets it, in a running application and in Studio's editor. */
export const APPLICATION_MAIN_CONTENT_ID = "vortex-main-content";

/**
 * Moves focus to the page's own content: its first heading or control outside the navigation,
 * or the content region itself when it has neither.
 */
const skipToPageContent = (event: MouseEvent<HTMLAnchorElement>): void => {
  const main = document.getElementById(APPLICATION_MAIN_CONTENT_ID);
  if (main === null) return;
  event.preventDefault();
  const target = [
    ...main.querySelectorAll<HTMLElement>(
      "h2, h3, input, select, textarea, button, a[href], [role=grid], [tabindex='0']",
    ),
  ].find((element) => element.closest("nav") === null && element.offsetParent !== null);
  if (target === undefined) {
    main.focus();
    return;
  }
  if (!target.matches("input, select, textarea, button, a[href], [tabindex='0']"))
    target.setAttribute("tabindex", "-1");
  target.focus();
};

/** The top bar a definition's shell chooses: the same bar for every application, Studio's editor included. */
export type ApplicationFrameTopBar = Exclude<
  ApplicationPuckRootShell,
  { kind: "default" }
>["presentation"]["topBar"];

/** A surface's own header commands, from one list: as the bar's icon buttons and as the narrow bar's menu items. */
export type ApplicationFrameCommands = Readonly<{ bar: ReactNode; menu: ReactNode }>;

const compactHeaderQuery = "(max-width: 767px)";
const subscribeCompactHeader = (notify: () => void) => {
  const list = window.matchMedia(compactHeaderQuery);
  list.addEventListener("change", notify);
  return () => list.removeEventListener("change", notify);
};
/** Below a tablet the header's commands and the agent tools move into one More menu; the server and first render draw the wide header. */
const useCompactHeader = (): boolean =>
  useSyncExternalStore(
    subscribeCompactHeader,
    () => window.matchMedia(compactHeaderQuery).matches,
    () => false,
  );

/**
 * The shared application frame top bar: breadcrumb, organisation and application switchers,
 * appearance control and account menu, in the one height and styling, on one row at every width.
 * A surface that has its own commands (Studio's editor) gives `status`, which stays on the bar,
 * and `commands` drawn two ways from one list: `bar` (icon buttons) and `menu` (the same commands
 * as menu items), which the narrow bar draws inside the More menu beside the agent tools.
 */
export function ApplicationFrameHeader({
  shellName,
  topBar,
  collapsibleSidebar = false,
  runtime,
  status,
  commands,
}: Readonly<{
  shellName: string;
  topBar: ApplicationFrameTopBar;
  collapsibleSidebar?: boolean;
  runtime: ApplicationShellRuntime | undefined;
  status?: ReactNode;
  commands?: ApplicationFrameCommands | undefined;
}>): ReactElement {
  const compact = useCompactHeader();
  const webMcp = runtime?.webMcp;
  const webMcpWords = webMcp === undefined ? undefined : describeWebMcp(webMcp);
  const more = compact && (commands !== undefined || webMcp !== undefined);
  return (
    <header className="sticky top-0 z-20 flex h-16 w-full shrink-0 flex-nowrap items-center gap-x-[var(--vortex-space-sm)] bg-background/95 px-[var(--vortex-space-md)] backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {/* The first stop for keyboard users: past the header and the navigation to the page. */}
      <a
        href={`#${APPLICATION_MAIN_CONTENT_ID}`}
        onClick={skipToPageContent}
        className="sr-only bg-background px-[var(--vortex-space-md)] py-[var(--vortex-space-sm)] text-sm font-medium text-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to main content
      </a>
      {collapsibleSidebar ? <SidebarTrigger className="max-sm:hidden" /> : null}
      {topBar.breadcrumbs ? <Breadcrumbs shellName={shellName} runtime={runtime} /> : null}
      <div className="ms-auto flex min-w-0 items-center justify-end gap-[var(--vortex-space-xs)]">
        {status}
        {compact ? null : commands?.bar}
        {webMcpWords !== undefined && compact ? (
          <span
            role="status"
            aria-live="polite"
            data-vortex-webmcp={webMcpWords.state}
            className="sr-only"
          >
            {webMcpWords.label}
          </span>
        ) : null}
        {more ? (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    id="vortex-header-more"
                    aria-label="More actions"
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="max-sm:size-11"
                      />
                    }
                  />
                }
              >
                <Icon name="more-horizontal" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>More actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-56">
              {commands?.menu}
              {commands !== undefined && webMcp !== undefined ? <DropdownMenuSeparator /> : null}
              {webMcp === undefined ? null : <WebMcpMenuItems runtime={webMcp} />}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {topBar.organizationSwitcher ? <OrganizationSwitcher runtime={runtime} /> : null}
        {topBar.applicationSwitcher ? (
          <ApplicationSwitcher shellName={shellName} runtime={runtime} />
        ) : null}
        {webMcp === undefined || compact ? null : <WebMcpStatus runtime={webMcp} />}
        {topBar.appearanceToggle ? <AppearanceToggle /> : null}
        {topBar.accountMenu ? (
          <ApplicationAccountMenu offerOrganizationSwitch={!topBar.organizationSwitcher} />
        ) : null}
      </div>
    </header>
  );
}

/** Puck root renderer for a definition-selected application frame. */
export function ApplicationShellRoot({
  shell,
  runtime,
  contentStyle,
  editing = false,
  children,
}: Readonly<{
  shell: ApplicationPuckRootShell;
  runtime: ApplicationShellRuntime | undefined;
  contentStyle: CSSProperties;
  editing?: boolean;
  children: ReactNode;
}>): ReactElement {
  // A flow dialog already insets what it shows, so its page keeps the gap but not the padding.
  const inFlowSurface = useContext(FlowSurfaceContext);
  if (shell.kind === "default")
    return (
      <div
        data-vortex-puck-root=""
        className="vortex-puck-slot"
        style={inFlowSurface ? { ...contentStyle, padding: 0 } : contentStyle}
        {...(editing ? { "data-vortex-editing": "" } : {})}
      >
        {runtime?.webMcp === undefined ? null : <WebMcpStatus runtime={runtime.webMcp} />}
        {children}
      </div>
    );

  const { presentation } = shell;
  return (
    <SidebarProvider
      collapsible={presentation.sidebar.collapsible}
      defaultCollapsed={presentation.sidebar.defaultCollapsed}
    >
      <div
        data-vortex-puck-root=""
        data-vortex-application-shell={shell.key}
        className="flex min-h-svh w-full min-w-0 flex-col bg-background text-foreground [--vortex-header-height:4rem]"
        {...(editing ? { "data-vortex-editing": "" } : {})}
      >
        <style>{shellFrameCss}</style>
        <ApplicationFrameHeader
          shellName={shell.name}
          topBar={presentation.topBar}
          collapsibleSidebar={presentation.sidebar.collapsible === "icon"}
          runtime={runtime}
        />
        <main
          id={APPLICATION_MAIN_CONTENT_ID}
          tabIndex={-1}
          data-vortex-application-shell-content=""
          className="vortex-puck-slot min-w-0 flex-1"
          style={
            { ...contentStyle, "--vortex-content-padding": contentStyle.padding } as CSSProperties
          }
        >
          {/* Every page has one level-1 heading: the page's name. Its blocks' headings follow it. */}
          {runtime === undefined ? null : <h1 className="sr-only">{runtime.pageName}</h1>}
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}
