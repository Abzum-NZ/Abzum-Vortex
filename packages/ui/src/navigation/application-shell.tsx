"use client";

import {
  createContext,
  Suspense,
  use,
  useContext,
  type CSSProperties,
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
import { SidebarProvider, SidebarTrigger } from "../components/sidebar";
import { FlowSurfaceContext } from "../flow-runtime/flow-surface-context";
import { Icon } from "../icons/icon";
import { AppearanceToggle } from "./appearance-toggle";
import { ApplicationAccountMenu, useApplicationAccountActions } from "./account-actions";

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
  applications: readonly Readonly<{ key: string; name: string; href: string }>[];
}>;

/**
 * The application switcher's applications, resolved or as a server-started read that streams in.
 * It travels in a context, not in Puck metadata: Puck copies metadata, and a copied streamed read
 * is no longer a promise.
 */
export const ApplicationSwitcherContext = createContext<
  ApplicationSwitcherData | Promise<ApplicationSwitcherData> | undefined
>(undefined);

export type ApplicationShellRuntime = Readonly<{
  applicationName: string;
  applicationHref: string;
  organizationName: string;
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
          <DropdownMenuLabel>{organizationName}</DropdownMenuLabel>
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
  return (
    <Suspense
      fallback={
        <Button
          variant="ghost"
          size="sm"
          disabled
          aria-busy="true"
          aria-label={`Loading applications: ${applicationName}`}
          className="max-w-56 max-sm:min-h-11 max-sm:min-w-11 animate-pulse"
        >
          <SwitcherButton icon="grid" label={applicationName} />
        </Button>
      }
    >
      <ResolvedApplicationSwitcher applicationName={applicationName} />
    </Suspense>
  );
}

function ResolvedApplicationSwitcher({
  applicationName,
}: Readonly<{ applicationName: string }>): ReactElement {
  const actions = useApplicationAccountActions();
  const read = useContext(ApplicationSwitcherContext);
  const switcher = read !== undefined && "then" in read ? use(read) : read;
  if (switcher?.state === "temporarily_unavailable")
    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex max-w-56 items-center gap-2 truncate text-sm text-muted-foreground"
      >
        <Icon name="grid" aria-hidden="true" />
        <span className="truncate max-sm:sr-only">Applications temporarily unavailable</span>
      </span>
    );
  if (switcher?.state === "unavailable")
    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex max-w-56 items-center gap-2 truncate text-sm text-muted-foreground"
      >
        <Icon name="grid" aria-hidden="true" />
        <span className="truncate max-sm:sr-only">Applications unavailable</span>
      </span>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={switcher === undefined || switcher.applications.length === 0 || actions === null}
        aria-label={`Application: ${applicationName}`}
        render={
          <Button variant="ghost" size="sm" className="max-w-56 max-sm:min-h-11 max-sm:min-w-11" />
        }
      >
        <SwitcherButton icon="grid" label={applicationName} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Applications</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {(switcher?.applications ?? []).map((application) => (
          <DropdownMenuItem
            key={application.key}
            onClick={() => void actions?.openApplication(application.href)}
            disabled={actions === null}
            data-active={application.name === applicationName ? "true" : undefined}
          >
            {application.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
        className="flex min-h-svh w-full min-w-0 flex-col bg-background text-foreground"
        {...(editing ? { "data-vortex-editing": "" } : {})}
      >
        <style>{shellFrameCss}</style>
        <header className="sticky top-0 z-20 flex min-h-14 w-full shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b py-1 sm:h-14 sm:flex-nowrap sm:py-0 bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
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
            {presentation.topBar.accountMenu ? <ApplicationAccountMenu /> : null}
          </div>
        </header>
        <div
          data-vortex-application-shell-content=""
          className="vortex-puck-slot min-w-0 flex-1"
          style={contentStyle}
        >
          {children}
        </div>
      </div>
    </SidebarProvider>
  );
}
