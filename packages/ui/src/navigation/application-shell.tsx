"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Button } from "../components/button";
import { Skeleton } from "../components/skeleton";
import { SidebarProvider, SidebarTrigger } from "../components/sidebar";
import { FlowSurfaceContext } from "../flow-runtime/flow-surface-context";
import { Icon } from "../icons/icon";
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
`;

function SwitcherButton({
  icon,
  label,
}: Readonly<{ icon: "building-2" | "grid"; label: string }>): ReactElement {
  return (
    <>
      <Icon name={icon} aria-hidden="true" data-icon="inline-start" />
      <span className="truncate max-sm:sr-only">{label}</span>
      <Icon
        name="chevron-down"
        aria-hidden="true"
        data-icon="inline-end"
        className="text-muted-foreground max-sm:hidden"
      />
    </>
  );
}

/** The visible indicator and per-session switch for browser agent tools, shared by every surface that registers them. */
export function WebMcpStatus({
  runtime,
}: Readonly<{ runtime: ApplicationWebMcpRuntime }>): ReactElement {
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
  return (
    <div
      className="flex max-w-full min-w-0 flex-wrap items-center gap-2 text-xs"
      role="status"
      aria-live="polite"
      data-vortex-webmcp={runtime.working === undefined ? runtime.status : "working"}
    >
      <span>{label}</span>
      {runtime.status === "off" ? (
        <Button type="button" variant="outline" size="sm" onClick={runtime.turnOn}>
          Turn on
        </Button>
      ) : runtime.status === "error" ? (
        <Button type="button" variant="outline" size="sm" onClick={runtime.retry}>
          Retry
        </Button>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={runtime.turnOff}>
          Turn off for this session
        </Button>
      )}
    </div>
  );
}

function Breadcrumbs({
  shellName,
  runtime,
}: Readonly<{ shellName: string; runtime: ApplicationShellRuntime | undefined }>): ReactElement {
  const applicationName = runtime?.applicationName ?? shellName;
  const pageName = runtime?.pageName ?? shellName;
  return (
    <Breadcrumb className="min-w-0 max-sm:flex-1">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="min-w-0 max-sm:hidden">
          {runtime === undefined ? (
            <span className="truncate">{applicationName}</span>
          ) : (
            <BreadcrumbLink href={runtime.applicationHref} className="truncate">
              {applicationName}
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>
        <BreadcrumbSeparator className="max-sm:hidden">
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
  const organizationName = runtime?.organizationName ?? actions?.organizationName ?? "Organisation";
  const organizationShortName = runtime?.organizationShortName ?? actions?.organizationShortName;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={runtime === undefined && actions === null}
        aria-label={`Organisation: ${organizationName}`}
        render={
          <Button variant="ghost" size="sm" className="max-w-56 max-sm:min-h-11 max-sm:min-w-11" />
        }
      >
        <SwitcherButton icon="building-2" label={organizationName} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-1">
            <span>{organizationName}</span>
            {organizationShortName === undefined ? null : (
              <span className="font-normal text-muted-foreground">{organizationShortName}</span>
            )}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={actions === null}
          onClick={() => void actions?.chooseOrganization()}
        >
          Switch organisation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ApplicationSwitcher({
  shellName,
  runtime,
}: Readonly<{ shellName: string; runtime: ApplicationShellRuntime | undefined }>): ReactElement {
  const applicationName = runtime?.applicationName ?? shellName;
  const actions = useApplicationAccountActions();
  const source = useContext(ApplicationSwitcherContext);
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
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          // The first open consumes the intent read, including one still in flight. Later opens
          // read again, so closing the menu never retains its application list for another open.
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
      <DropdownMenuTrigger
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
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56" aria-busy={switcher === undefined}>
        {source?.search === undefined ? null : (
          <div className="w-96 max-w-[90vw] p-2" onKeyDown={(event) => event.stopPropagation()}>
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
        <DropdownMenuGroup>
          <DropdownMenuLabel>Applications</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {switcher === undefined ? (
          <div role="status" aria-label="Loading applications" className="space-y-2 p-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
          </div>
        ) : switcher.state !== "available" ? (
          <>
            <div role="status" className="px-2 py-1.5 text-sm text-muted-foreground">
              {switcher.state === "temporarily_unavailable"
                ? "Applications temporarily unavailable"
                : "Applications unavailable"}
            </div>
            <DropdownMenuItem closeOnClick={false} onClick={() => void read()}>
              Retry
            </DropdownMenuItem>
          </>
        ) : switcher.applications.length === 0 ? (
          <div role="status" className="px-2 py-1.5 text-sm text-muted-foreground">
            No other applications
          </div>
        ) : (
          <DropdownMenuRadioGroup
            value={
              switcher.applications.find((application) => application.name === applicationName)
                ?.key ?? ""
            }
          >
            {switcher.applications.map((application) => (
              <DropdownMenuRadioItem
                key={application.key}
                value={application.key}
                onClick={() => void actions?.openApplication(application.href)}
                disabled={actions === null}
              >
                <Icon
                  name={resolveVortexIconName(application.icon ?? "") ?? "circle"}
                  aria-hidden="true"
                  data-icon="inline-start"
                />
                {application.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const mainContentId = "vortex-main-content";

/**
 * Moves focus to the page's own content: its first heading or control outside the navigation,
 * or the content region itself when it has neither.
 */
const skipToPageContent = (event: MouseEvent<HTMLAnchorElement>): void => {
  const main = document.getElementById(mainContentId);
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
        className="flex min-h-svh w-full min-w-0 flex-col bg-background text-foreground [--vortex-header-height:3.5rem]"
        {...(editing ? { "data-vortex-editing": "" } : {})}
      >
        <style>{shellFrameCss}</style>
        <header className="sticky top-0 z-20 flex min-h-14 w-full shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b py-1 sm:h-14 sm:flex-nowrap sm:py-0 bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          {/* The first stop for keyboard users: past the header and the navigation to the page. */}
          <a
            href={`#${mainContentId}`}
            onClick={skipToPageContent}
            className="sr-only bg-background px-3 py-2 text-sm font-medium text-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:ring-2 focus:ring-ring"
          >
            Skip to main content
          </a>
          {presentation.sidebar.collapsible === "icon" ? (
            <SidebarTrigger className="max-sm:hidden" />
          ) : null}
          {presentation.topBar.breadcrumbs ? (
            <Breadcrumbs shellName={shell.name} runtime={runtime} />
          ) : null}
          <div className="ms-auto flex min-w-0 items-center justify-end gap-1 max-sm:flex-wrap">
            {presentation.topBar.organizationSwitcher ? (
              <OrganizationSwitcher runtime={runtime} />
            ) : null}
            {presentation.topBar.applicationSwitcher ? (
              <ApplicationSwitcher shellName={shell.name} runtime={runtime} />
            ) : null}
            {runtime?.webMcp === undefined ? null : <WebMcpStatus runtime={runtime.webMcp} />}
            {presentation.topBar.appearanceToggle ? <AppearanceToggle /> : null}
            {presentation.topBar.accountMenu ? (
              <ApplicationAccountMenu
                offerOrganizationSwitch={!presentation.topBar.organizationSwitcher}
              />
            ) : null}
          </div>
        </header>
        <main
          id={mainContentId}
          tabIndex={-1}
          data-vortex-application-shell-content=""
          className="vortex-puck-slot min-w-0 flex-1 focus:outline-none"
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
