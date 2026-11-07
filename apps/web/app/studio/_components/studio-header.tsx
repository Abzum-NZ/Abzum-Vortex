"use client";

import { memo, useMemo, type ReactNode } from "react";
import {
  ApplicationAccountActionsProvider,
  ApplicationFrameHeader,
  ApplicationSwitcherContext,
  type ApplicationAccount,
  type ApplicationFrameCommands,
  type ApplicationFrameTopBar,
  type ApplicationShellRuntime,
  type ApplicationSwitcherSource,
  type ApplicationWebMcpRuntime,
} from "@vortex/ui";
import { NavigationLink } from "@vortex/ui/routing";
import { Icon } from "@vortex/ui/icons";
import { Spinner } from "@vortex/ui/components/spinner";
import { Button } from "@vortex/ui/components/button";
import { Separator } from "@vortex/ui/components/separator";
import { Reasoned } from "@vortex/ui/components/reasoned";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuShortcut,
} from "@vortex/ui/components/dropdown-menu";
import type { VortexIconName } from "@vortex/ui/icons";
import { Kbd } from "@vortex/ui/components/kbd";
import type { StudioInstallControl } from "./use-studio-releases-tab";
import { signOut } from "../../auth/actions";
import {
  readApplicationSwitcherAction,
  searchLauncherAction,
} from "../../[tenantShortName]/[organizationShortName]/[applicationKey]/frame-actions";

/** The shared application frame as Studio's definition shapes it, and where the person is in it. */
export type StudioFrameDefinition = Readonly<{
  shellName: string;
  topBar: ApplicationFrameTopBar;
  account: ApplicationAccount;
  tenantShortName: string;
  organizationShortName: string;
  organizationName: string;
  /** Studio's own start page: the App Store section. */
  studioHref: string;
}>;

/** The shared application frame top bar for any Studio surface; `commands` are its own. */
export function StudioFrameBar({
  frame,
  pageName,
  status,
  commands,
  agentTools,
}: Readonly<{
  frame: StudioFrameDefinition;
  pageName: string;
  /** Stays on the bar at every width. */
  status?: ReactNode;
  /** The surface's commands as icon buttons, and the same commands as menu items for the narrow bar. */
  commands?: ApplicationFrameCommands;
  /** The browser agent tools' state, shown where every application's header shows it. */
  agentTools?: ApplicationWebMcpRuntime | undefined;
}>) {
  const switcherSource = useMemo<ApplicationSwitcherSource>(
    () =>
      Object.assign(
        () => readApplicationSwitcherAction(frame.tenantShortName, frame.organizationShortName),
        {
          search: (expression: string, groupKey?: string, cursor?: string) =>
            searchLauncherAction(
              frame.tenantShortName,
              frame.organizationShortName,
              expression,
              groupKey,
              cursor,
            ),
        },
      ),
    [frame.tenantShortName, frame.organizationShortName],
  );
  const runtime: ApplicationShellRuntime = {
    applicationName: frame.shellName,
    applicationHref: frame.studioHref,
    organizationName: frame.organizationName,
    organizationShortName: frame.organizationShortName,
    pageName,
    ...(agentTools === undefined ? {} : { webMcp: agentTools }),
  };
  return (
    <ApplicationAccountActionsProvider
      actions={{
        account: frame.account,
        organizationName: frame.organizationName,
        organizationShortName: frame.organizationShortName,
        studioHref: frame.studioHref,
        signOut,
      }}
    >
      <ApplicationSwitcherContext.Provider value={switcherSource}>
        <ApplicationFrameHeader
          shellName={frame.shellName}
          topBar={frame.topBar}
          runtime={runtime}
          status={status}
          commands={commands}
        />
      </ApplicationSwitcherContext.Provider>
    </ApplicationAccountActionsProvider>
  );
}

type StudioHeaderCommandProps = Readonly<{
  onApplication: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoDisabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** The running application, opened from here when it is live in the organisation; absent when the builder may not open it. */
  applicationHref: string | undefined;
  /** What the organisation can do with the published version: install it, upgrade to it, open it, or nothing. */
  install: StudioInstallControl;
  /** Starts the App Store's Install or upgrade flow over the editor. */
  onInstall: () => void;
  /** The flow's page is being read before its first dialog opens. */
  installPending: boolean;
  onPreview: () => void;
  previewDisabled: boolean;
  previewPending: boolean;
  onPublish: () => void;
  publishDisabled: boolean;
  /** The flow's page is being read before its first dialog opens. */
  publishPending: boolean;
}>;

/** One draft command, drawn as an icon button on the bar and as an item of the More menu. */
type StudioCommand = Readonly<{
  key: string;
  /** Names the button and is the menu item's text. */
  label: string;
  tip: string;
  icon: VortexIconName;
  shortcut?: string;
  /** Why it cannot be used right now; absent when it can. */
  reason?: string | undefined;
  busy?: boolean;
  primary?: boolean;
  /** A running application is opened by its link; every other command runs. */
  href?: string;
  onSelect?: () => void;
}>;

const studioCommands = ({
  onApplication,
  canUndo,
  canRedo,
  undoDisabled,
  onUndo,
  onRedo,
  applicationHref,
  install,
  onInstall,
  installPending,
  onPreview,
  previewDisabled,
  previewPending,
  onPublish,
  publishDisabled,
  publishPending,
}: StudioHeaderCommandProps): readonly StudioCommand[] => [
  {
    key: "studio-application-settings",
    label: "Application settings",
    tip: "Application settings",
    icon: "sliders-horizontal",
    onSelect: onApplication,
  },
  {
    key: "studio-undo",
    label: "Undo",
    tip: "Undo",
    shortcut: "Ctrl Z",
    icon: "undo",
    reason: undoDisabled
      ? "Resolve the blocked draft before undoing"
      : canUndo
        ? undefined
        : "No changes to undo",
    onSelect: onUndo,
  },
  {
    key: "studio-redo",
    label: "Redo",
    tip: "Redo",
    shortcut: "Ctrl Shift Z",
    icon: "redo",
    reason: undoDisabled
      ? "Resolve the blocked draft before redoing"
      : canRedo
        ? undefined
        : "No changes to redo",
    onSelect: onRedo,
  },
  ...(install === "open" && applicationHref !== undefined
    ? [
        {
          key: "studio-open",
          label: "Open the application",
          tip: "Open the application",
          icon: "app-window" as const,
          href: applicationHref,
        },
      ]
    : install === "install" || install === "upgrade"
      ? [
          {
            key: "studio-install",
            label:
              install === "install" ? "Install in this organisation" : "Upgrade this organisation",
            tip:
              install === "install"
                ? "Install the published version in this organisation"
                : "Upgrade this organisation to the published version",
            icon: "package-plus" as const,
            busy: installPending,
            reason: installPending ? "Preparing the install" : undefined,
            onSelect: onInstall,
          },
        ]
      : []),
  {
    key: "studio-preview",
    label: "Preview",
    tip: "Run the saved draft in a new tab",
    icon: "eye",
    busy: previewPending,
    reason: previewDisabled
      ? "Resolve the blocked draft before previewing"
      : previewPending
        ? "Preparing the preview"
        : undefined,
    onSelect: onPreview,
  },
  {
    key: "studio-publish",
    label: "Publish",
    tip: "Publish the saved draft as a new version",
    icon: "upload",
    primary: true,
    busy: publishPending,
    reason: publishDisabled
      ? "Resolve the blocked draft before publishing"
      : publishPending
        ? "Preparing the publish"
        : undefined,
    onSelect: onPublish,
  },
];

/**
 * The draft's commands as icon buttons. Unavailable, one stays the focusable, named button
 * (`Reasoned`: aria-disabled, described by the reason, activation swallowed), so focus never leaves
 * it and it says why. They take values and callbacks that keep their identity between keystrokes,
 * so typing in the draft does not draw them again.
 */
const StudioHeaderButtons = memo(function StudioHeaderButtons(commands: StudioHeaderCommandProps) {
  return (
    <>
      {studioCommands(commands).map((command) => (
        <Reasoned
          key={command.key}
          reason={command.reason}
          tip={
            <>
              {command.tip}
              {command.shortcut !== undefined && <Kbd>{command.shortcut}</Kbd>}
            </>
          }
        >
          <Button
            id={command.href === undefined ? command.key : undefined}
            variant={command.primary === true ? "default" : "ghost"}
            size="icon-sm"
            aria-label={command.label}
            aria-busy={command.busy}
            {...(command.href === undefined
              ? { type: "button" as const, onClick: command.onSelect }
              : { nativeButton: false, render: <NavigationLink href={command.href} /> })}
          >
            {command.busy === true ? <Spinner /> : <Icon name={command.icon} />}
          </Button>
        </Reasoned>
      ))}
      <Separator orientation="vertical" className="mx-1 h-6" />
    </>
  );
});

/** The same commands inside the narrow bar's More menu; an unavailable one is disabled and says why. */
const StudioHeaderMenuItems = memo(function StudioHeaderMenuItems(
  commands: StudioHeaderCommandProps,
) {
  return (
    <DropdownMenuGroup>
      {studioCommands(commands).map((command) => (
        <DropdownMenuItem
          key={command.key}
          disabled={command.reason !== undefined}
          {...(command.href === undefined
            ? { onClick: command.onSelect }
            : { render: <NavigationLink href={command.href} /> })}
        >
          <Icon name={command.icon} />
          <span className="flex flex-col">
            {command.label}
            {command.reason === undefined ? null : (
              <span className="text-xs font-normal text-muted-foreground">{command.reason}</span>
            )}
          </span>
          {command.shortcut === undefined ? null : (
            <DropdownMenuShortcut>{command.shortcut}</DropdownMenuShortcut>
          )}
        </DropdownMenuItem>
      ))}
    </DropdownMenuGroup>
  );
});

/**
 * Studio's editor top bar is the shared application frame bar, the one every Vortex application
 * has. The draft's commands sit in its action area as icon buttons with tooltips.
 */
export function StudioHeader({
  frame,
  applicationName,
  agentTools,
  saveState,
  ...commands
}: Readonly<{
  frame: StudioFrameDefinition;
  applicationName: string;
  /** The browser agent tools' state; undefined where the browser offers none. */
  agentTools: ApplicationWebMcpRuntime | undefined;
  saveState: ReactNode;
}> &
  StudioHeaderCommandProps) {
  return (
    <StudioFrameBar
      frame={frame}
      pageName={applicationName}
      status={saveState}
      commands={{
        bar: <StudioHeaderButtons {...commands} />,
        menu: <StudioHeaderMenuItems {...commands} />,
      }}
      agentTools={agentTools}
    />
  );
}
