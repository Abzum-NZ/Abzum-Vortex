"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppearanceToggle, Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@vortex/ui/components/breadcrumb";

/** Where the workspace is: organisation, application and the layout or page open on the canvas. */
export type StudioLocation = Readonly<{
  organizationName: string;
  organizationHref: string;
  applicationName: string;
  onApplication: () => void;
  /** The layout or page the canvas shows, when one is open. */
  item?: string | undefined;
}>;

/**
 * Studio's top bar: where you are, the one status chip (whether the draft is saved and the canvas
 * caught up), Undo and Redo, and the commands that act on the whole draft. Edits save themselves.
 */
export function StudioTopBar({ location, chip, chipAlert, status, problem, canUndo, canRedo, undoDisabled, onUndo, onRedo,
  backToAppHref, onPreview, previewDisabled, previewPending, onPublish, publishDisabled, statusLink }: Readonly<{
  location: StudioLocation;
  /** "Saved", "Saving…" or "Not saved", with "Updating canvas…" while the canvas catches up. */
  chip: string;
  /** The chip reports a save that did not go through. */
  chipAlert: boolean;
  /** What just happened (a preview starting, a restore). */
  status: string;
  /** Why the latest change is not saved and what to do, when it is not. */
  problem: ReactNode;
  canUndo: boolean; canRedo: boolean; undoDisabled: boolean;
  onUndo: () => void; onRedo: () => void;
  backToAppHref: string | undefined;
  onPreview: () => void; previewDisabled: boolean; previewPending: boolean;
  onPublish: () => void; publishDisabled: boolean;
  /** A place the status points at, such as the App Store after a version is published. */
  statusLink?: Readonly<{ label: string; href: string }> | undefined;
}>) {
  return <header className="shrink-0 border-b border-border bg-background">
    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
      <Breadcrumb className="min-w-0">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href={location.organizationHref} />}>{location.organizationName}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            {location.item === undefined
              ? <BreadcrumbPage className="font-medium">{location.applicationName}</BreadcrumbPage>
              : <BreadcrumbLink render={<button type="button" onClick={location.onApplication} />}>{location.applicationName}</BreadcrumbLink>}
          </BreadcrumbItem>
          {location.item === undefined ? null : <>
            <BreadcrumbSeparator />
            <BreadcrumbItem><BreadcrumbPage className="font-medium">{location.item}</BreadcrumbPage></BreadcrumbItem>
          </>}
        </BreadcrumbList>
      </Breadcrumb>
      <span role="status" aria-live="polite" className={chipAlert
        ? "rounded-full bg-destructive/10 px-2 py-0.5 text-sm text-destructive"
        : "rounded-full bg-muted px-2 py-0.5 text-sm text-muted-foreground"}>{chip}</span>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Undo" title="Undo"
          disabled={!canUndo || undoDisabled} onClick={onUndo}><Icon name="undo" /></Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Redo" title="Redo"
          disabled={!canRedo || undoDisabled} onClick={onRedo}><Icon name="redo" /></Button>
        {backToAppHref === undefined ? null
          : <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={backToAppHref} />}>
            <Icon name="chevron-left" />Back to app</Button>}
        <Button type="button" variant="outline" size="sm" aria-busy={previewPending}
          title="Run the saved draft in a new tab" disabled={previewDisabled || previewPending}
          onClick={onPreview}><Icon name="eye" />Preview</Button>
        <Button type="button" size="sm" disabled={publishDisabled} onClick={onPublish}>Publish…</Button>
        <AppearanceToggle />
      </div>
    </div>
    {problem}
    <p role="status" aria-live="polite" className="px-3 pb-2 text-sm text-muted-foreground empty:hidden">{status.trim()}</p>
    {statusLink === undefined ? null : <div className="px-3 pb-2">
      <Button variant="link" size="sm" className="h-auto p-0" nativeButton={false} render={<Link href={statusLink.href} />}>
        {statusLink.label}</Button></div>}
  </header>;
}
