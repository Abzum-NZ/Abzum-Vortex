"use client";
import { useEffect, useRef } from "react";
import type { DefinitionPublicationConfirmation, PublishDefinitionResult } from "@vortex/platform/schema";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@vortex/ui/components/dialog";
import { Label } from "@vortex/ui/components/label";
import { Textarea } from "@vortex/ui/components/textarea";
import { TechnicalDetails, ViewSource } from "@vortex/ui/components/technical-details";
import { PublicationSummary } from "./publication-summary";
import { formatStudioTimestamp } from "./studio-time";

export type StudioPublishDialogProps = Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The latest edits are still being saved: only the saved draft is published, so the dialog waits. */
  saving: boolean;
  /** Why the saved draft is not the draft on screen (a refused or conflicting save), or empty. */
  notSaved: string;
  /** The saved draft can be prepared now (nothing pending, nothing in flight). */
  canPrepare: boolean;
  preparing: boolean;
  publishing: boolean;
  prepared: Readonly<{
    confirmation: DefinitionPublicationConfirmation;
    componentLabels: readonly Readonly<{ componentId: string; label: string }>[];
  }> | null;
  note: string;
  onNoteChange: (note: string) => void;
  /** Why publishing cannot go ahead, in business words; empty when there is nothing to report. */
  problem: string;
  published: PublishDefinitionResult | null;
  onPrepare: () => void;
  onPublish: () => void;
}>;

/** What will be published, as a summary and a table of changed items, with one Publish button. */
export function StudioPublishDialog(props: StudioPublishDialogProps) {
  const { open, saving, notSaved, canPrepare, preparing, publishing, prepared, published, onPrepare } = props;
  const waiting = saving || notSaved !== "";
  const attempted = useRef<string>("");
  // Reading what will be published starts when the dialog opens on a saved draft; one read per opening.
  useEffect(() => {
    if (!open) { attempted.current = ""; return; }
    if (waiting || !canPrepare || prepared !== null || preparing || publishing || published !== null ||
      attempted.current === "tried") return;
    attempted.current = "tried";
    onPrepare();
  }, [open, waiting, canPrepare, prepared, preparing, publishing, published, onPrepare]);
  const noteValid = props.note.trim().length >= 1 && props.note.trim().length <= 2000;
  return <Dialog open={open} onOpenChange={(next) => { if (!publishing) props.onOpenChange(next); }}>
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" aria-label="Publish this application">
      <DialogHeader>
        <DialogTitle>Publish this application</DialogTitle>
        <DialogDescription>
          Publishing makes the saved draft a new version. Organisations install it, or upgrade to it, from the App Store.
        </DialogDescription>
      </DialogHeader>
      {published !== null
        ? <div className="space-y-3" role="status">
          <Alert>
            <AlertTitle>Version {published.releaseVersion} is published</AlertTitle>
            <AlertDescription>
              Published <time dateTime={published.publishedAt}>{formatStudioTimestamp(published.publishedAt)}</time>.
              Nobody has been switched to it yet.
            </AlertDescription>
          </Alert>
          <TechnicalDetails>
            <dl className="space-y-1">
              <div><dt className="font-semibold">Release revision</dt><dd>{published.releaseRevision}</dd></div>
              <div><dt className="font-semibold">Content fingerprint</dt><dd className="break-all"><code>{published.contentFingerprint}</code></dd></div>
              <div><dt className="font-semibold">Resolution fingerprint</dt><dd className="break-all"><code>{published.resolutionFingerprint}</code></dd></div>
            </dl>
            <ViewSource value={published} title="View source" />
          </TechnicalDetails>
        </div>
        : notSaved !== ""
          ? <Alert variant="destructive" role="alert">
            <AlertTitle>Your latest change is not saved</AlertTitle>
            <AlertDescription>Only the saved draft is published. {notSaved}</AlertDescription>
          </Alert>
          : saving
          ? <p role="status" aria-live="polite">Saving your latest changes…</p>
          : <div className="space-y-4">
            {prepared === null
              ? <p role="status" aria-live="polite">
                {preparing ? "Checking what will be published…"
                  : props.problem === "" ? "Preparing the summary…" : null}
              </p>
              : <PublicationSummary confirmation={prepared.confirmation} componentLabels={prepared.componentLabels} />}
            {props.problem === "" ? null
              : <Alert variant="destructive" role="alert">
                <AlertTitle>This cannot be published yet</AlertTitle>
                <AlertDescription>{props.problem}</AlertDescription>
              </Alert>}
            <div className="space-y-1">
              <Label htmlFor="studio-release-note">What changed in this version?</Label>
              <Textarea id="studio-release-note" value={props.note} maxLength={2000} disabled={publishing || prepared === null}
                placeholder="A short note for the people who read the version history"
                onChange={(event) => props.onNoteChange(event.target.value)} />
            </div>
          </div>}
      <DialogFooter>
        {published !== null
          ? <Button type="button" onClick={() => props.onOpenChange(false)}>Done</Button>
          : <>
            <Button type="button" variant="outline" disabled={publishing} onClick={() => props.onOpenChange(false)}>Cancel</Button>
            {!waiting && prepared === null && !preparing && props.problem !== ""
              ? <Button type="button" variant="outline" disabled={!canPrepare} onClick={onPrepare}>Check again</Button> : null}
            <Button type="button" disabled={waiting || prepared === null || !noteValid || publishing}
              onClick={props.onPublish}>{publishing ? "Publishing…" : "Publish"}</Button>
          </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
