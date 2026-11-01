"use client";
import { NavigationLink } from "@vortex/ui/routing";
import type { ComponentProps, ReactNode } from "react";
import { AppearanceToggle } from "@vortex/ui/appearance-toggle";
import { Icon } from "@vortex/ui/icons";
import { Spinner } from "@vortex/ui/components/spinner";
import { Button } from "@vortex/ui/components/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@vortex/ui/components/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@vortex/ui/components/dropdown-menu";
import { Separator } from "@vortex/ui/components/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@vortex/ui/components/tooltip";
import { Kbd } from "@vortex/ui/components/kbd";

type StudioLocation = Readonly<{
  organizationName: string;
  organizationHref: string;
  applicationName: string;
  onApplication: () => void;
  applications: readonly Readonly<{ name: string; href: string }>[];
  item?: string | undefined;
}>;

function ToolbarButton({
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

/** One compact workspace bar: location, save state and the commands that act on the draft. */
export function StudioTopBar({
  location,
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
  location: StudioLocation;
  saveState: ReactNode;
  canUndo: boolean;
  canRedo: boolean;
  undoDisabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  backToAppHref: string | undefined;
  /** The App Store page, for installing this application when it is not installed yet. */
  appStoreHref: string | undefined;
  /** Whether the organisation has the application installed; undefined when that cannot be read. */
  installed: boolean | undefined;
  onPreview: () => void;
  previewDisabled: boolean;
  previewPending: boolean;
  onPublish: () => void;
  publishDisabled: boolean;
}>) {
  return (
    <header className="flex h-14 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background px-3 sm:gap-3">
      <ToolbarButton
        tip="All applications"
        variant="ghost"
        size="icon-sm"
        nativeButton={false}
        aria-label="All applications"
        render={<NavigationLink href="/studio" />}
      >
        <Icon name="grid" />
      </ToolbarButton>
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          <BreadcrumbItem className="hidden min-w-0 lg:inline-flex">
            <BreadcrumbLink
              className="truncate"
              render={<NavigationLink href={location.organizationHref} />}
            >
              {location.organizationName}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="hidden lg:block" />
          <BreadcrumbItem className="min-w-0">
            <DropdownMenu>
              <DropdownMenuTrigger
                className="flex min-w-0 items-center gap-1 rounded-md border-0 bg-transparent text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Switch application: ${location.applicationName}`}
              >
                <span className="truncate">{location.applicationName}</span>
                <Icon name="chevron-down" className="size-4 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={location.onApplication}>
                  <Icon name="sliders-horizontal" />
                  Application settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {location.applications.map((app) => (
                  <DropdownMenuItem key={app.href} render={<NavigationLink href={app.href} />}>
                    {app.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </BreadcrumbItem>
          {location.item !== undefined && (
            <>
              <BreadcrumbSeparator className="hidden sm:block" />
              <BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
                <BreadcrumbPage className="truncate font-medium">{location.item}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      {saveState}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <div className="hidden items-center gap-1 lg:flex">
          <ToolbarButton
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
          </ToolbarButton>
          <ToolbarButton
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
          </ToolbarButton>
          <Separator orientation="vertical" className="mx-2 h-6" />
          {installed === true && backToAppHref !== undefined ? (
            <Button
              variant="ghost"
              size="sm"
              nativeButton={false}
              render={<NavigationLink href={backToAppHref} />}
            >
              <Icon name="chevron-left" />
              Back to app
            </Button>
          ) : installed === false && appStoreHref !== undefined ? (
            <Button
              variant="ghost"
              size="sm"
              nativeButton={false}
              render={<NavigationLink href={appStoreHref} />}
            >
              <Icon name="plus" />
              Install in this organisation
            </Button>
          ) : null}
          <ToolbarButton
            tip={
              previewDisabled
                ? "Resolve the blocked draft before previewing"
                : "Run the saved draft in a new tab"
            }
            type="button"
            variant="outline"
            size="sm"
            aria-busy={previewPending}
            disabled={previewDisabled || previewPending}
            onClick={onPreview}
          >
            {previewPending ? <Spinner /> : <Icon name="eye" />}
            {previewPending ? "Starting…" : "Preview"}
          </ToolbarButton>
          <ToolbarButton
            tip={
              publishDisabled
                ? "Resolve the blocked draft before publishing"
                : "Publish a version of this application"
            }
            id="studio-publish"
            type="button"
            size="sm"
            disabled={publishDisabled}
            onClick={onPublish}
          >
            Publish
          </ToolbarButton>
        </div>
        <div className="lg:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Draft actions"
              render={<Button type="button" variant="ghost" size="icon-sm" />}
            >
              <Icon name="more-horizontal" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem disabled={!canUndo || undoDisabled} onClick={onUndo}>
                <Icon name="undo" /> Undo
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canRedo || undoDisabled} onClick={onRedo}>
                <Icon name="redo" /> Redo
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {installed === true && backToAppHref !== undefined ? (
                <DropdownMenuItem render={<NavigationLink href={backToAppHref} />}>
                  <Icon name="chevron-left" /> Back to app
                </DropdownMenuItem>
              ) : installed === false && appStoreHref !== undefined ? (
                <DropdownMenuItem render={<NavigationLink href={appStoreHref} />}>
                  <Icon name="plus" /> Install in this organisation
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                disabled={previewDisabled || previewPending}
                aria-busy={previewPending}
                onClick={onPreview}
              >
                {previewPending ? <Spinner /> : <Icon name="eye" />}
                {previewPending ? "Starting…" : "Preview"}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={publishDisabled} onClick={onPublish}>
                Publish
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<NavigationLink href={location.organizationHref} />}>
                {location.organizationName}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <AppearanceToggle />
      </div>
    </header>
  );
}
