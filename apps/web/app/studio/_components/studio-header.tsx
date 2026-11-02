"use client";

import { useMemo, type ComponentProps, type ReactNode } from "react";
import {
  ApplicationAccountActionsProvider,
  ApplicationFrameHeader,
  ApplicationSwitcherContext,
  type ApplicationAccount,
  type ApplicationFrameTopBar,
  type ApplicationShellRuntime,
  type ApplicationSwitcherSource,
} from "@vortex/ui";
import { NavigationLink } from "@vortex/ui/routing";
import { Icon } from "@vortex/ui/icons";
import { Spinner } from "@vortex/ui/components/spinner";
import { Button } from "@vortex/ui/components/button";
import { Separator } from "@vortex/ui/components/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@vortex/ui/components/tooltip";
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

function IconAction({
  tip,
  shortcut,
  disabled,
  ...props
}: ComponentProps<typeof Button> & {
  tip: string;
  shortcut?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" tabIndex={disabled ? 0 : undefined} />}>
        <Button disabled={disabled} {...props} />
      </TooltipTrigger>
      <TooltipContent>
        {tip}
        {shortcut !== undefined && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

/** The shared application frame top bar for any Studio surface; `actions` are its own commands. */
function StudioFrameBar({
  frame,
  pageName,
  actions,
}: Readonly<{ frame: StudioFrameDefinition; pageName: string; actions?: ReactNode }>) {
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

/**
 * Studio's editor top bar is the shared application frame bar, the one every Vortex application
 * has. The draft's commands sit in its action area as icon buttons with tooltips.
 */
export function StudioHeader({
  frame,
  applicationName,
  onApplication,
  saveState,
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
}: Readonly<{
  frame: StudioFrameDefinition;
  applicationName: string;
  onApplication: () => void;
  saveState: ReactNode;
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
}>) {
  const actions = (
    <>
      {saveState}
      <IconAction
        tip="Application settings"
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Application settings"
        onClick={onApplication}
      >
        <Icon name="sliders-horizontal" />
      </IconAction>
      <IconAction
        tip={
          undoDisabled
            ? "Resolve the blocked draft before undoing"
            : canUndo
              ? "Undo"
              : "No changes to undo"
        }
        shortcut="Ctrl Z"
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Undo"
        disabled={!canUndo || undoDisabled}
        onClick={onUndo}
      >
        <Icon name="undo" />
      </IconAction>
      <IconAction
        tip={
          undoDisabled
            ? "Resolve the blocked draft before redoing"
            : canRedo
              ? "Redo"
              : "No changes to redo"
        }
        shortcut="Ctrl Shift Z"
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Redo"
        disabled={!canRedo || undoDisabled}
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
            publishDisabled
              ? "Resolve the blocked draft before installing"
              : install === "install"
                ? "Install the published version in this organisation"
                : "Upgrade this organisation to the published version"
          }
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={
            install === "install" ? "Install in this organisation" : "Upgrade this organisation"
          }
          aria-busy={installPending}
          disabled={publishDisabled || installPending}
          onClick={onInstall}
        >
          {installPending ? <Spinner /> : <Icon name="arrow-down" />}
        </IconAction>
      ) : null}
      <IconAction
        tip={
          previewDisabled
            ? "Resolve the blocked draft before previewing"
            : "Run the saved draft in a new tab"
        }
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Preview"
        aria-busy={previewPending}
        disabled={previewDisabled || previewPending}
        onClick={onPreview}
      >
        {previewPending ? <Spinner /> : <Icon name="eye" />}
      </IconAction>
      <IconAction
        tip={
          publishDisabled
            ? "Resolve the blocked draft before publishing"
            : "Publish the saved draft as a new version"
        }
        id="studio-publish"
        type="button"
        size="icon-sm"
        aria-label="Publish"
        aria-busy={publishPending}
        disabled={publishDisabled || publishPending}
        onClick={onPublish}
      >
        {publishPending ? <Spinner /> : <Icon name="upload" />}
      </IconAction>
      <Separator orientation="vertical" className="mx-1 h-6" />
    </>
  );
  return <StudioFrameBar frame={frame} pageName={applicationName} actions={actions} />;
}
