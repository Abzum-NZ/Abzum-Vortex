"use client";

import type { CSSProperties, ReactElement, ReactNode } from "react";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Button } from "../components/button";
import { SidebarProvider, SidebarTrigger } from "../components/sidebar";
import { Icon } from "../icons/icon";
import { ApplicationAccountMenu, useApplicationAccountActions } from "./account-actions";

export type ApplicationWebMcpRuntime = Readonly<{
  status: "registering" | "active" | "off" | "error";
  turnOff: () => void;
  turnOn: () => void;
  retry: () => void;
  /** The tool of an agent call that is changing something right now; absent while none is. */
  working?: string;
}>;

export type ApplicationShellRuntime = Readonly<{
  applicationName: string;
  applicationHref: string;
  organizationName: string;
  pageName: string;
  applicationSwitcherState: "available" | "unavailable" | "temporarily_unavailable";
  applications: readonly Readonly<{ key: string; name: string; href: string }>[];
  /** Page agent-tool state supplied through Puck metadata to the definition-selected shell. */
  webMcp?: ApplicationWebMcpRuntime;
}>;

const shellFrameCss = `
[data-vortex-sidebar-state="collapsed"] [data-vortex-container-region="menu"]:has([data-vortex-shell-navigation]) {
  width: var(--sidebar-width-icon) !important;
  max-width: var(--sidebar-width-icon) !important;
  flex: 0 0 var(--sidebar-width-icon) !important;
}
[data-vortex-sidebar-state="collapsed"] [data-vortex-shell-navigation] [data-vortex-navigation-label] {
  display: none !important;
}
[data-vortex-sidebar-state="collapsed"] [data-vortex-shell-navigation] [data-slot="sidebar-group-label"] {
  justify-content: center;
}
[data-vortex-sidebar-state="collapsed"] [data-vortex-shell-navigation] [data-sidebar="menu-button"] {
  justify-content: center;
  padding-inline: 0.75rem;
}
[data-vortex-sidebar-state="collapsed"] [data-vortex-shell-navigation] [data-sidebar="menu-sub"] {
  display: none;
}
`;

function SwitcherButton({
  icon,
  label,
}: Readonly<{ icon: "building-2" | "grid"; label: string }>): ReactElement {
  return (
    <span className="inline-flex max-w-56 items-center gap-2 truncate rounded-md px-2 py-1.5 text-sm font-medium text-foreground">
      <Icon name={icon} aria-hidden="true" />
      <span className="truncate">{label}</span>
      <Icon name="chevron-down" aria-hidden="true" className="size-3.5 text-muted-foreground" />
    </span>
  );
}

/** The visible indicator and per-session switch for browser agent tools, shared by every surface that registers them. */
export function WebMcpStatus({ runtime }: Readonly<{ runtime: ApplicationWebMcpRuntime }>): ReactElement {
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
      className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-xs"
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
    <Breadcrumb className="min-w-0">
      <BreadcrumbList>
        <BreadcrumbItem>
          {runtime === undefined ? (
            <span>{applicationName}</span>
          ) : (
            <BreadcrumbLink href={runtime.applicationHref}>{applicationName}</BreadcrumbLink>
          )}
        </BreadcrumbItem>
        <BreadcrumbSeparator>
          <Icon name="chevron-right" aria-hidden="true" />
        </BreadcrumbSeparator>
        <BreadcrumbItem>
          <BreadcrumbPage>{pageName}</BreadcrumbPage>
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
        className="rounded-md outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
      >
        <SwitcherButton icon="building-2" label={organizationName} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>{organizationName}</DropdownMenuLabel>
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
  const actions = useApplicationAccountActions();
  if (runtime?.applicationSwitcherState === "temporarily_unavailable")
    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex max-w-56 items-center gap-2 truncate rounded-md px-2 py-1.5 text-sm text-muted-foreground"
      >
        <Icon name="grid" aria-hidden="true" />
        <span className="truncate">Applications temporarily unavailable</span>
      </span>
    );
  if (runtime?.applicationSwitcherState === "unavailable")
    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex max-w-56 items-center gap-2 truncate rounded-md px-2 py-1.5 text-sm text-muted-foreground"
      >
        <Icon name="grid" aria-hidden="true" />
        <span className="truncate">Applications unavailable</span>
      </span>
    );
  const applicationName = runtime?.applicationName ?? shellName;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={runtime === undefined || runtime.applications.length === 0 || actions === null}
        aria-label={`Application: ${applicationName}`}
        className="rounded-md outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
      >
        <SwitcherButton icon="grid" label={applicationName} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>Applications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(runtime?.applications ?? []).map((application) => (
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
  if (shell.kind === "default")
    return (
      <div
        data-vortex-puck-root=""
        className="vortex-puck-slot"
        style={contentStyle}
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
        <header className="sticky top-0 z-20 flex h-14 w-full shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          {presentation.sidebar.collapsible === "icon" ? <SidebarTrigger /> : null}
          {presentation.topBar.breadcrumbs ? (
            <Breadcrumbs shellName={shell.name} runtime={runtime} />
          ) : null}
          <div className="ms-auto flex min-w-0 items-center gap-1">
            {presentation.topBar.organizationSwitcher ? (
              <OrganizationSwitcher runtime={runtime} />
            ) : null}
            {presentation.topBar.applicationSwitcher ? (
              <ApplicationSwitcher shellName={shell.name} runtime={runtime} />
            ) : null}
            {runtime?.webMcp === undefined ? null : <WebMcpStatus runtime={runtime.webMcp} />}
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
