"use client";

import { useStudioFieldProblems } from "@vortex/ui/studio";
import { useState } from "react";
import { FormattedTime, Icon } from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { Spinner } from "@vortex/ui/components/spinner";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverDescription,
  PopoverTrigger,
} from "@vortex/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@vortex/ui/components/alert-dialog";
import { toast } from "@vortex/ui/components/sonner";
import { cn } from "@vortex/ui/lib/utils";
import type { StudioDraft } from "./use-studio-draft";
import { isStudioSessionRefusal } from "./use-studio-session";

/** Non-blocking workspace feedback has one destination: the Studio toast region. */
export function studioNotice(
  message: string,
  kind: "success" | "error" | "info" = "info",
  link?: Readonly<{ label: string; href: string }>,
) {
  const options = {
    ...(kind === "error" ? { duration: Infinity } : {}),
    ...(link === undefined
      ? {}
      : {
          action: {
            label: link.label,
            onClick: () => {
              window.location.assign(link.href);
            },
          },
        }),
  };
  if (kind === "success") return toast.success(message, options);
  if (kind === "error")
    return toast.error("Studio could not finish that", { ...options, description: message });
  return toast(message, options);
}

/** The one save chip and the two states that interrupt editing. Conflict never overwrites a newer revision. */
export function StudioSaveState({ draft }: Readonly<{ draft: StudioDraft }>) {
  const { status } = draft;
  const fields = useStudioFieldProblems();
  const hasFieldProblems = (fields?.problems.length ?? 0) > 0;
  const [loadFailed, setLoadFailed] = useState(false);
  const sessionEnded = draft.session.needsSignIn || isStudioSessionRefusal(status);
  const notSaved =
    hasFieldProblems ||
    sessionEnded ||
    status.kind === "refused" ||
    status.kind === "conflict" ||
    status.kind === "failed";
  const busy =
    !sessionEnded &&
    !hasFieldProblems &&
    (status.kind === "saving" || (status.kind === "saved" && draft.updatingCanvas));
  const label = hasFieldProblems
    ? "Not saved"
    : status.kind === "failed"
      ? "Retrying…"
      : notSaved
        ? "Not saved"
        : status.kind === "saving"
          ? "Saving…"
          : draft.updatingCanvas
            ? "Updating canvas…"
            : "Saved";
  const loading = draft.isHeld("reopening");

  const badge = (
    <Badge
      variant="ghost"
      className={cn(
        "h-6 gap-1.5 px-2 text-xs font-medium",
        status.kind === "failed" && !hasFieldProblems
          ? "bg-warning/10 text-warning"
          : notSaved
            ? "bg-destructive/10 text-destructive"
            : "text-muted-foreground",
      )}
    >
      {busy ? (
        <Spinner className="size-3" aria-hidden="true" />
      ) : (
        <Icon
          name={
            status.kind === "failed" && !hasFieldProblems
              ? "history"
              : notSaved
                ? "circle"
                : "check"
          }
          className="size-3"
        />
      )}
      {label}
    </Badge>
  );

  return (
    <>
      <span role="status" aria-live="polite" className="inline-flex shrink-0">
        {notSaved ? (
          <Popover>
            <PopoverTrigger
              aria-label={`${label}: show save details`}
              render={
                <button
                  type="button"
                  className="rounded-full border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              {badge}
            </PopoverTrigger>
            <PopoverContent className="space-y-3">
              <PopoverTitle>Your latest change is not saved</PopoverTitle>
              <PopoverDescription>
                {sessionEnded
                  ? "Your session ended, so your last change was not saved."
                  : hasFieldProblems
                    ? fields?.problems[0]
                    : "message" in status
                      ? status.message
                      : ""}
              </PopoverDescription>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    (hasFieldProblems ? !fields?.canUndo : !draft.state.canUndo) || draft.locked
                  }
                  onClick={hasFieldProblems ? fields?.undo : draft.undo}
                >
                  Undo my change
                </Button>
                {status.kind === "refused" && !sessionEnded && !hasFieldProblems && (
                  <Button
                    size="sm"
                    onClick={() => {
                      void draft.retry();
                    }}
                  >
                    Try again
                  </Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="rounded-full border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              {badge}
            </TooltipTrigger>
            <TooltipContent>
              {busy ? (
                label
              ) : (
                <>
                  All changes saved <FormattedTime iso={draft.saved.updatedAt} />
                </>
              )}
            </TooltipContent>
          </Tooltip>
        )}
      </span>
      <AlertDialog
        open={status.kind === "conflict"}
        onOpenChange={(_open, event) => {
          event.cancel();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This draft was changed elsewhere</AlertDialogTitle>
            <AlertDialogDescription>
              {status.kind === "conflict" && (
                <>
                  {status.message}
                  {status.changedAt !== null && (
                    <>
                      {" "}
                      Saved <FormattedTime iso={status.changedAt} />.
                    </>
                  )}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {status.kind === "conflict" && status.changes.length > 0 && (
            <ul className="m-0 list-none divide-y rounded-lg border border-border p-0 text-sm">
              {status.changes.slice(0, 6).map((row, index) => (
                <li key={index} className="px-3 py-2">
                  {row.area}: {row.change.toLowerCase()} {row.item}
                </li>
              ))}
              {status.changes.length > 6 && (
                <li className="px-3 py-2">+ {status.changes.length - 6} more</li>
              )}
            </ul>
          )}
          <p className="text-sm text-muted-foreground">Your unsaved change will be discarded.</p>
          {loadFailed && (
            <p role="alert" className="text-sm text-destructive">
              The latest draft could not be loaded. Try again.
            </p>
          )}
          <AlertDialogFooter>
            <Button
              disabled={loading}
              onClick={() => {
                setLoadFailed(false);
                void draft.reload().then((loaded) => setLoadFailed(!loaded));
              }}
            >
              {loading && <Spinner />}Load the latest draft
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={sessionEnded}
        onOpenChange={(_open, event) => {
          event.cancel();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign in to keep working</AlertDialogTitle>
            <AlertDialogDescription>
              Your session ended, so your last change wasn’t saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {draft.session.message && (
            <p role="alert" className="text-sm text-destructive">
              {draft.session.message}
            </p>
          )}
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={!draft.state.canUndo || draft.locked}
              onClick={() => {
                draft.session.cancel();
                void draft.flush().then(() => draft.undo());
              }}
            >
              Undo my change
            </Button>
            <Button
              onClick={() => {
                if (!draft.session.needsSignIn) void draft.retry();
                draft.session.openSignIn();
              }}
            >
              Sign in again
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
