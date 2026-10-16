"use client";
import Link from "next/link";
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

/** Studio's top bar: where you are, whether the draft is saved, and the commands that act on the whole draft. */
export function StudioTopBar({ location, savedStateLabel, status, canUndo, canRedo, undoDisabled, onUndo, onRedo,
  onRevert, revertDisabled, onSave, saveDisabled, backToAppHref, onPreview, previewDisabled, previewing,
  onPublish, publishDisabled }: Readonly<{
  location: StudioLocation;
  savedStateLabel: string;
  /** What just happened, or what must be applied first. */
  status: string;
  canUndo: boolean; canRedo: boolean; undoDisabled: boolean;
  onUndo: () => void; onRedo: () => void;
  onRevert: () => void; revertDisabled: boolean;
  onSave: () => void; saveDisabled: boolean;
  backToAppHref: string | undefined;
  onPreview: () => void; previewDisabled: boolean; previewing: boolean;
  onPublish: () => void; publishDisabled: boolean;
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
      <span className="text-sm text-muted-foreground" aria-live="polite">{savedStateLabel}</span>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Undo" title="Undo"
          disabled={!canUndo || undoDisabled} onClick={onUndo}><Icon name="undo" /></Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Redo" title="Redo"
          disabled={!canRedo || undoDisabled} onClick={onRedo}><Icon name="redo" /></Button>
        <Button type="button" variant="ghost" size="sm" disabled={revertDisabled} onClick={onRevert}>Revert to saved</Button>
        <Button type="button" variant="outline" size="sm" disabled={saveDisabled} onClick={onSave}>Save</Button>
        {backToAppHref === undefined ? null
          : <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={backToAppHref} />}>
            <Icon name="chevron-left" />Back to app</Button>}
        <Button type="button" variant={previewing ? "secondary" : "outline"} size="sm" aria-pressed={previewing}
          disabled={previewDisabled} onClick={onPreview}><Icon name="eye" />Preview</Button>
        <Button type="button" size="sm" disabled={publishDisabled} onClick={onPublish}>Publish…</Button>
        <AppearanceToggle />
      </div>
    </div>
    <p role="status" aria-live="polite" className="px-3 pb-2 text-sm text-muted-foreground empty:hidden">{status.trim()}</p>
  </header>;
}
