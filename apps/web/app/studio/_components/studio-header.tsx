"use client";

import { memo, useMemo, type ComponentProps, type ReactNode } from "react";
import {
  ApplicationAccountActionsProvider,
  ApplicationFrameHeader,
  ApplicationSwitcherContext,
  type ApplicationAccount,
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

/**
 * One icon command. Unavailable, it stays the focusable, named button (`Reasoned`: aria-disabled,
 * described by the reason, activation swallowed), so focus never leaves it and it says why.
 */
function IconAction({
  tip,
  shortcut,
  disabledReason,
  ...props
}: ComponentProps<typeof Button> & {
  tip: string;
  shortcut?: string;
  /** Why the command cannot be used right now; absent when it can. */
  disabledReason?: string | undefined;
}) {
  return (
    <Reasoned
      reason={disabledReason}
      tip={
        <>
          {tip}
          {shortcut !== undefined && <Kbd>{shortcut}</Kbd>}
        </>
      }
    >
      <Button {...props} />
    </Reasoned>
  );
}

/** The shared application frame top bar for any Studio surface; `actions` are its own commands. */
export function StudioFrameBar({
  frame,
  pageName,
  actions,
  agentTools,
}: Readonly<{
  frame: StudioFrameDefinition;
  pageName: string;
  actions?: ReactNode;
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
          actions={actions}
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

/**
 * The draft's commands as icon buttons. They take values and callbacks that keep their identity
 * between keystrokes, so typing in the draft does not draw them again.
 */
const StudioHeaderCommands = memo(function StudioHeaderCommands({
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
}: StudioHeaderCommandProps) {
  return (
    <>
      <IconAction
        tip="Application settings"
        id="studio-application-settings"
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Application settings"
        onClick={onApplication}
      >
        <Icon name="sliders-horizontal" />
      </IconAction>
      <IconAction
        tip="Undo"
        id="studio-undo"
        shortcut="Ctrl Z"
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Undo"
        disabledReason={
          undoDisabled
            ? "Resolve the blocked draft before undoing"
            : canUndo
              ? undefined
              : "No changes to undo"
        }
        onClick={onUndo}
      >
        <Icon name="undo" />
      </IconAction>
      <IconAction
        tip="Redo"
        id="studio-redo"
        shortcut="Ctrl Shift Z"
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Redo"
        disabledReason={
          undoDisabled
            ? "Resolve the blocked draft before redoing"
            : canRedo
              ? undefined
              : "No changes to redo"
        }
        onClick={onRedo}
      >
        <Icon name="redo" />
      </IconAction>
      {install === "open" && applicationHref !== undefined ? (
        <IconAction
          tip="Open the application"
          variant="ghost"
          size="icon-sm"
          nativeButton={false}
          aria-label="Open the application"
          render={<NavigationLink href={applicationHref} />}
        >
          <Icon name="app-window" />
        </IconAction>
      ) : install === "install" || install === "upgrade" ? (
        <IconAction
          tip={
            install === "install"
              ? "Install the published version in this organisation"
              : "Upgrade this organisation to the published version"
          }
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={
            install === "install" ? "Install in this organisation" : "Upgrade this organisation"
          }
          id="studio-install"
          aria-busy={installPending}
          disabledReason={installPending ? "Preparing the install" : undefined}
          onClick={onInstall}
        >
          {installPending ? <Spinner /> : <Icon name="package-plus" />}
        </IconAction>
      ) : null}
      <IconAction
        tip="Run the saved draft in a new tab"
        id="studio-preview"
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Preview"
        aria-busy={previewPending}
        disabledReason={
          previewDisabled
            ? "Resolve the blocked draft before previewing"
            : previewPending
              ? "Preparing the preview"
              : undefined
        }
        onClick={onPreview}
      >
        {previewPending ? <Spinner /> : <Icon name="eye" />}
      </IconAction>
      <IconAction
        tip="Publish the saved draft as a new version"
        id="studio-publish"
        type="button"
        size="icon-sm"
        aria-label="Publish"
        aria-busy={publishPending}
        disabledReason={
          publishDisabled
            ? "Resolve the blocked draft before publishing"
            : publishPending
              ? "Preparing the publish"
              : undefined
        }
        onClick={onPublish}
      >
        {publishPending ? <Spinner /> : <Icon name="upload" />}
      </IconAction>
      <Separator orientation="vertical" className="mx-1 h-6" />
    </>
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
  const actions = (
    <>
      {saveState}
      <StudioHeaderCommands {...commands} />
    </>
  );
  return (
    <StudioFrameBar
      frame={frame}
      pageName={applicationName}
      actions={actions}
      agentTools={agentTools}
    />
  );
}
