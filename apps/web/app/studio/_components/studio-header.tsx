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
  backToAppHref,
  appStoreHref,
  installed,
  onPreview,
  previewDisabled,
  previewPending,
  onPublish,
  publishDisabled,
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
  backToAppHref: string | undefined;
  /** Studio's App Store section, for installing this application when it is not installed yet. */
  appStoreHref: string | undefined;
  /** Whether the organisation has the application installed; undefined when that cannot be read. */
  installed: boolean | undefined;
  onPreview: () => void;
  previewDisabled: boolean;
  previewPending: boolean;
  onPublish: () => void;
  publishDisabled: boolean;
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
    pageName: applicationName,
  };
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
      {installed === true && backToAppHref !== undefined ? (
        <IconAction
          tip="Open the application"
          variant="ghost"
          size="icon-sm"
          nativeButton={false}
          aria-label="Open the application"
          render={<NavigationLink href={backToAppHref} />}
        >
          <Icon name="chevron-left" />
        </IconAction>
      ) : installed === false && appStoreHref !== undefined ? (
        <IconAction
          tip="Install in this organisation"
          variant="ghost"
          size="icon-sm"
          nativeButton={false}
          aria-label="Install in this organisation"
          render={<NavigationLink href={appStoreHref} />}
        >
          <Icon name="plus" />
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
            : "Publish a version of this application"
        }
        id="studio-publish"
        type="button"
        size="sm"
        aria-label="Publish"
        disabled={publishDisabled}
        onClick={onPublish}
      >
        Publish
      </IconAction>
      <Separator orientation="vertical" className="mx-1 h-6" />
    </>
  );
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
