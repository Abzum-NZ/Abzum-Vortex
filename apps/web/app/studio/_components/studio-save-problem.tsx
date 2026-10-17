"use client";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import type { StudioSaveStatus } from "./use-studio-draft";
import { formatStudioTimestamp } from "./studio-time";

/** How many changed areas the conflict names before it says how many more there are. */
const shownChanges = 6;

/**
 * Why the latest change is not saved, under the top bar. A conflict names who saved a newer version,
 * when, and what they changed, and offers to load it: this workspace never overwrites it. A refused
 * save says why; a save the platform did not confirm is retried by itself.
 */
export function StudioSaveProblem({ status, loading, loadFailed, onLoadLatest }: Readonly<{
  status: StudioSaveStatus;
  loading: boolean;
  /** The last Load the latest draft did not load it. */
  loadFailed: boolean;
  onLoadLatest: () => void;
}>) {
  if (status.kind === "saved" || status.kind === "saving") return null;
  if (status.kind === "failed")
    return <p role="status" className="px-3 pb-2 text-sm text-muted-foreground">{status.message}</p>;
  if (status.kind === "refused")
    return <Alert variant="destructive" role="alert" className="mx-3 mb-2 w-auto">
      <AlertTitle>Your latest change is not saved</AlertTitle>
      <AlertDescription>{status.message}</AlertDescription>
    </Alert>;
  const extra = status.changes.length - shownChanges;
  return <Alert variant="destructive" role="alert" className="mx-3 mb-2 w-auto">
    <AlertTitle>Not saved: this draft was changed elsewhere</AlertTitle>
    <AlertDescription className="space-y-2">
      <p>{status.message}{status.changedAt === null ? "" : <> They saved it <time dateTime={status.changedAt}>{formatStudioTimestamp(status.changedAt)}</time>.</>}</p>
      {status.changes.length > 0 && <>
        <p>What they changed:</p>
        <ul className="list-disc pl-5">
          {status.changes.slice(0, shownChanges).map((row, index) =>
            <li key={index}>{row.area}: {row.change.toLowerCase()} {row.item}</li>)}
          {extra > 0 && <li>{extra} more {extra === 1 ? "change" : "changes"}</li>}
        </ul>
      </>}
      <p>Load their version to keep working. Your change that was not saved is not kept.</p>
      {loadFailed && <p>The latest draft could not be loaded. Try again, or reload Studio.</p>}
      <Button type="button" size="sm" disabled={loading} onClick={onLoadLatest}>{loading ? "Loading…" : "Load the latest draft"}</Button>
    </AlertDescription>
  </Alert>;
}
