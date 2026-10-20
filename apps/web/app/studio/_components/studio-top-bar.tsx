"use client";
import Link from "next/link";
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

export type StudioLocation = Readonly<{
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
  onPreview: () => void;
  previewDisabled: boolean;
  previewPending: boolean;
  onPublish: () => void;
  publishDisabled: boolean;
}>) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-3">
      <ToolbarButton
        tip="All applications"
        variant="ghost"
        size="icon-sm"
        nativeButton={false}
        aria-label="All applications"
        render={<Link href="/studio" prefetch={false} />}
      >
        <Icon name="grid" />
      </ToolbarButton>
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap">
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbLink
              className="truncate"
              render={<Link href={location.organizationHref} prefetch={false} />}
            >
              {location.organizationName}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
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
                  <DropdownMenuItem
                    key={app.href}
                    render={<Link href={app.href} prefetch={false} />}
                  >
                    {app.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </BreadcrumbItem>
          {location.item !== undefined && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate font-medium">{location.item}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      {saveState}
      <div className="ml-auto flex shrink-0 items-center gap-1">
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
        {backToAppHref !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link href={backToAppHref} prefetch={false} />}
          >
            <Icon name="chevron-left" />
            Back to app
          </Button>
        )}
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
          type="button"
          size="sm"
          disabled={publishDisabled}
          onClick={onPublish}
        >
          Publish
        </ToolbarButton>
        <AppearanceToggle />
      </div>
    </header>
  );
}
