"use client";
import { useEffect, useRef, type ReactNode } from "react";
import type { DefinitionPublicationConfirmation } from "@vortex/platform/schema";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import { Label } from "@vortex/ui/components/label";
import { Textarea } from "@vortex/ui/components/textarea";
import { Spinner } from "@vortex/ui/components/spinner";
import { PublicationSummary, type PublicationComponentLabel } from "./publication-summary";

type StudioPublishDialogProps = Readonly<{
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
    componentLabels: readonly PublicationComponentLabel[];
  }> | null;
  revision: number;
  pageReview: ReactNode;
  note: string;
  onNoteChange: (note: string) => void;
  /** Why publishing cannot go ahead, in business words; empty when there is nothing to report. */
  problem: string;
  onPrepare: () => void;
  onPublish: () => void;
}>;

/** Reviews the saved draft and its changes before publishing one version. */
export function StudioPublishDialog(props: StudioPublishDialogProps) {
  const {
    open,
    saving,
    notSaved,
    canPrepare,
    preparing,
    publishing,
    prepared,
    onPrepare,
    revision,
  } = props;
  const waiting = saving || notSaved !== "";
  const attempted = useRef<number | null>(null);
  // Check each saved revision once per opening, including page edits made from this dialog.
  useEffect(() => {
    if (!open) {
      attempted.current = null;
      return;
    }
    if (
      waiting ||
      !canPrepare ||
      prepared !== null ||
      preparing ||
      publishing ||
      attempted.current === revision
    )
      return;
    attempted.current = revision;
    onPrepare();
  }, [open, waiting, canPrepare, prepared, preparing, publishing, onPrepare, revision]);
  const noteValid = props.note.trim().length >= 1 && props.note.trim().length <= 2000;
  const preparingSummary = !waiting && preparing;
  // Nothing is under way and nothing was found: offered only while open, not while a published dialog closes.
  const idle = open && !waiting && prepared === null && !preparing && !publishing;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!publishing) props.onOpenChange(next);
      }}
    >
      <DialogContent className="min-w-0 max-h-dvh max-w-xl overflow-y-auto break-words">
        <DialogHeader>
          <DialogTitle className="text-xl tracking-tight">
            {prepared === null
              ? "Publish version"
              : `Publish version ${prepared.confirmation.assignedVersion}`}
          </DialogTitle>
          <DialogDescription>
            Publishing makes the saved draft a new version. Organisations install it, or upgrade to
            it, from the App Store.
          </DialogDescription>
        </DialogHeader>
        {notSaved !== "" ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Your latest change is not saved</AlertTitle>
            <AlertDescription>Only the saved draft is published. {notSaved}</AlertDescription>
          </Alert>
        ) : saving ? (
          <p role="status" aria-live="polite">
            Saving your latest changes…
          </p>
        ) : (
          <div className="min-w-0 space-y-4">
            {prepared === null ? (
              <p role="status" aria-live="polite">
                {publishing
                  ? "Publishing the saved draft…"
                  : preparing
                    ? "Checking what will be published…"
                    : idle && props.problem === ""
                      ? "The summary is not ready. Check again before publishing."
                      : null}
              </p>
            ) : (
              <PublicationSummary
                confirmation={prepared.confirmation}
                componentLabels={prepared.componentLabels}
              />
            )}
            {props.pageReview}
            {props.problem === "" ? null : (
              <Alert variant="destructive" role="alert">
                <AlertTitle>This cannot be published yet</AlertTitle>
                <AlertDescription>{props.problem}</AlertDescription>
              </Alert>
            )}
            <div className="min-w-0 space-y-2">
              <Label htmlFor="studio-release-note">What changed in this version?</Label>
              <Textarea
                id="studio-release-note"
                required
                aria-describedby="studio-release-note-help"
                value={props.note}
                maxLength={2000}
                disabled={publishing || prepared === null}
                placeholder="A short note for the people who read the version history"
                onChange={(event) => props.onNoteChange(event.target.value)}
              />
              <p id="studio-release-note-help" className="text-sm text-muted-foreground">
                Add a short note about what changed to enable Publish (up to 2,000 characters).
              </p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={publishing}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          {idle ? (
            <Button type="button" variant="outline" disabled={!canPrepare} onClick={onPrepare}>
              Check again
            </Button>
          ) : null}
          <Button
            type="button"
            disabled={waiting || prepared === null || !noteValid || publishing}
            onClick={props.onPublish}
          >
            {(saving || preparingSummary || publishing) && <Spinner aria-hidden="true" />}
            {publishing
              ? "Publishing…"
              : saving
                ? "Saving…"
                : preparingSummary
                  ? "Preparing…"
                  : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
