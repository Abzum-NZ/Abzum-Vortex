"use client";
import { Button } from "@vortex/ui/components/button";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Badge } from "@vortex/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vortex/ui/components/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vortex/ui/components/dropdown-menu";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@vortex/ui/components/empty";
import { studioNotice } from "./studio-save-state";

import { useEffect, useRef, useState } from "react";
import type { DefinitionReleaseMetadata } from "@vortex/platform/schema";
import type {
  StudioApplicationHistoryFailure,
  StudioApplicationHistoryPage,
  StudioApplicationHistorySnapshot,
} from "../../_lib/studio-application-history";
import type { StudioApplicationRestoreCommandResult } from "../../_lib/studio-application-restore-contracts";
import { listApplicationReleaseHistory, restoreApplicationRelease } from "../releases-actions";
import { FormattedTime, Icon } from "@vortex/ui";

const snapshotIdentity = (snapshot: StudioApplicationHistorySnapshot) =>
  JSON.stringify([
    snapshot.organizationId,
    snapshot.rootId,
    snapshot.definitionKey,
    snapshot.draftRevision,
    snapshot.sourceFingerprint,
    snapshot.anchorReleaseRevision,
  ]);
const expectedSnapshot = (snapshot: StudioApplicationHistorySnapshot) => ({
  draftRevision: snapshot.draftRevision,
  sourceFingerprint: snapshot.sourceFingerprint,
  anchorReleaseRevision: snapshot.anchorReleaseRevision,
});
type Pending = "reload" | "next" | "restore";
type Failure = StudioApplicationHistoryFailure["kind"];

const failureMessage = (failure: Failure) =>
  failure === "conflict"
    ? "The saved application or its current version changed, so this list is out of date. Reload before continuing."
    : failure === "refused"
      ? "The version history is unavailable. Sign in with an account that can manage this application, then reload."
      : "The version history is temporarily unavailable. Try again or reload.";

const restoreFailureMessage = (
  result: Exclude<StudioApplicationRestoreCommandResult, { kind: "completed" }>,
): string =>
  result.stateMayHaveChanged === "unknown"
    ? "Whether the version was restored could not be confirmed. Reload Studio to load the saved draft, then check it."
    : result.kind === "conflict"
      ? "The draft changed since this list was loaded, so nothing was restored. Reload the versions and try again."
      : result.kind === "refused"
        ? "Restoring was refused for your account or this version, so nothing was restored."
        : "Restoring is temporarily unavailable, so nothing was restored. Try again in a moment.";

/**
 * The Releases tab's published versions, oldest first: each with when and by whom it was published
 * and what changed, and a way to restore it into the draft. Restoring replaces the saved draft with
 * that version's source as a new draft revision, through the platform's one restore operation; it
 * never publishes or installs anything. Organisations install and upgrade from the App Store.
 */
export function ApplicationReleaseHistory({
  initialPage,
  restoreBlocked,
  hold,
  onRestored,
}: {
  initialPage: StudioApplicationHistoryPage;
  /** Why restoring cannot start now (unsaved or pending edits in the workspace), or nothing. */
  restoreBlocked: string | undefined;
  /** Holds the workspace's draft while a restore writes the saved draft, so nothing else edits it. */
  hold: (on: boolean) => void;
  /** Loads the restored saved draft into the workspace and says what happened. */
  onRestored: (message: string) => void;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const currentRestoreBlocked = useRef(restoreBlocked);
  currentRestoreBlocked.current = restoreBlocked;
  const [page, setPage] = useState<StudioApplicationHistoryPage | null>(initialPage);
  const [pending, setPending] = useState<Pending | null>(null);
  const [expandedRelease, setExpandedRelease] = useState<number | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [message, setMessage] = useState("Versions loaded.");
  const mounted = useRef(false);
  const generation = useRef(0);
  const pendingRef = useRef<Pending | null>(null);
  const pageRef = useRef<StudioApplicationHistoryPage | null>(initialPage);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    pendingRef.current = null;
    pageRef.current = initialPage;
    setPage(initialPage);
    setPending(null);
    setFailure(null);
    setMessage("Versions loaded.");
    return () => {
      mounted.current = false;
      generation.current += 1;
      pendingRef.current = null;
    };
  }, [initialPage]);

  const begin = (command: Pending) => {
    pendingRef.current = command;
    setPending(command);
    setFailure(null);
    return ++generation.current;
  };
  const finish = (token: number) => {
    if (mounted.current && generation.current === token) {
      pendingRef.current = null;
      setPending(null);
    }
  };

  const load = async (command: "reload" | "next") => {
    if (!mounted.current || pendingRef.current !== null) return;
    const sourcePage = pageRef.current;
    const snapshot = sourcePage?.snapshot ?? initialPage.snapshot;
    const nextCursor = sourcePage?.nextAfterReleaseRevision;
    if (command === "next" && (sourcePage === null || nextCursor == null)) return;
    const token = begin(command);
    setMessage(command === "next" ? "Loading the next versions." : "Reloading the versions.");
    const current = () => mounted.current && generation.current === token;
    const fail = (kind: Failure) => {
      setFailure(kind);
      setMessage(failureMessage(kind));
      studioNotice(failureMessage(kind), "error");
      if (kind === "refused" || kind === "conflict") {
        pageRef.current = null;
        setPage(null);
      }
    };
    try {
      const result = await listApplicationReleaseHistory(
        snapshot.organizationId,
        command === "reload"
          ? { kind: "reload", rootId: snapshot.rootId }
          : {
              kind: "next",
              rootId: snapshot.rootId,
              expected: expectedSnapshot(snapshot),
              afterReleaseRevision: nextCursor,
            },
      );
      if (!current()) return;
      if (result.kind !== "available") {
        fail(result.kind);
        return;
      }
      if (
        command === "next" &&
        snapshotIdentity(result.page.snapshot) !== snapshotIdentity(snapshot)
      ) {
        fail("conflict");
        return;
      }
      // Replace one bounded page. Never append across anchors or retain an unbounded history.
      pageRef.current = result.page;
      setPage(result.page);
      setMessage(
        result.page.entries.length === 0 ? "Nothing is published yet." : "Versions loaded.",
      );
    } catch (error) {
      console.error("[studio] release history failed to load", error);
      if (current()) fail("temporarily_unavailable");
    } finally {
      finish(token);
    }
  };

  const restore = async (entry: DefinitionReleaseMetadata) => {
    const sourcePage = pageRef.current;
    if (
      !mounted.current ||
      pendingRef.current !== null ||
      restoreBlocked !== undefined ||
      sourcePage === null
    )
      return;
    const snapshot = sourcePage.snapshot;
    if (snapshot.anchorReleaseRevision === null) return;
    if (
      !(await confirm({
        title: `Restore version ${entry.releaseVersion} into the draft?`,
        description: `The saved draft is replaced by what version ${entry.releaseVersion} held, and saved. Nothing is published or installed; publish when the draft is as you want it.`,
        confirmLabel: "Restore into draft",
      }))
    )
      return;
    if (
      !mounted.current ||
      pageRef.current !== sourcePage ||
      pendingRef.current !== null ||
      currentRestoreBlocked.current !== undefined
    )
      return;
    const token = begin("restore");
    setMessage(`Restoring version ${entry.releaseVersion} into the draft…`);
    hold(true);
    try {
      const result = await restoreApplicationRelease(snapshot.organizationId, {
        selector: {
          organizationId: snapshot.organizationId,
          rootId: snapshot.rootId,
          releaseRevision: entry.releaseRevision,
        },
        expected: {
          ...expectedSnapshot(snapshot),
          anchorReleaseRevision: snapshot.anchorReleaseRevision,
        },
        confirmed: true,
      });
      if (!mounted.current || generation.current !== token) return;
      if (result.kind === "completed") {
        onRestored(`Restored version ${entry.releaseVersion} into the draft`);
        return;
      }
      setFailure(result.kind);
      setMessage(restoreFailureMessage(result));
      studioNotice(restoreFailureMessage(result), "error");
    } catch (error) {
      console.error("[studio] restoring a release failed", error);
      if (mounted.current && generation.current === token) {
        const problem = restoreFailureMessage({
          kind: "temporarily_unavailable",
          stateMayHaveChanged: "unknown",
        });
        setMessage(problem);
        studioNotice(problem, "error");
      }
    } finally {
      hold(false);
      finish(token);
    }
  };

  const snapshot = page?.snapshot ?? initialPage.snapshot;
  const blocked = pending !== null || page === null;
  const author = (entry: DefinitionReleaseMetadata) =>
    page?.publishers[entry.publishedBy.toLowerCase()] ?? "someone you cannot see in the directory";
  return (
    <section aria-label="Release history" className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">Published versions</h2>
        <p className="text-sm text-muted-foreground">
          Oldest first, 20 at a time. Organisations install and upgrade a version from the App
          Store.
        </p>
      </header>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending !== null}
          onClick={() => void load("reload")}
        >
          Reload versions
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={blocked || page?.nextAfterReleaseRevision == null}
          onClick={() => void load("next")}
        >
          Next 20 versions
        </Button>
      </div>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </p>
      {restoreBlocked !== undefined && page !== null && page.entries.length > 0 && (
        <p className="text-sm text-muted-foreground">{restoreBlocked}</p>
      )}
      {page !== null && failure === "temporarily_unavailable" && (
        <p>These details are from the last successful load.</p>
      )}
      {page !== null &&
        (page.entries.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="history" />
              </EmptyMedia>
              <EmptyTitle>No versions yet</EmptyTitle>
              <EmptyDescription>Publish to create version 1.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ol className="m-0 list-none space-y-2 p-0" aria-busy={pending !== null}>
            {page.entries.map((entry) => (
              <li
                key={entry.releaseRevision}
                className="min-w-0 space-y-2 rounded-md py-3 hover:bg-muted/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">Version {entry.releaseVersion}</Badge>
                      {entry.isCurrent && <Badge variant="secondary">Current</Badge>}
                    </div>
                    <p className="m-0 text-sm text-muted-foreground">
                      Published <FormattedTime iso={entry.publishedAt} /> by {author(entry)}
                    </p>
                  </div>
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`More for version ${entry.releaseVersion}`}
                              />
                            }
                          />
                        }
                      >
                        <Icon name="more-horizontal" />
                      </TooltipTrigger>
                      <TooltipContent>More for version {entry.releaseVersion}</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuItem
                        disabled={blocked || restoreBlocked !== undefined}
                        onClick={() => void restore(entry)}
                      >
                        Restore into draft
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <p className="m-0 whitespace-pre-wrap break-words text-sm">{entry.releaseNote}</p>
                <Collapsible
                  open={expandedRelease === entry.releaseRevision}
                  onOpenChange={(open) => setExpandedRelease(open ? entry.releaseRevision : null)}
                >
                  <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
                    <Icon name="chevron-down" />
                    Details
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <dl className="space-y-2 break-all font-mono text-xs">
                      <div>
                        <dt>Release revision</dt>
                        <dd>{entry.releaseRevision}</dd>
                      </div>
                      <div>
                        <dt>Published by (account id)</dt>
                        <dd>{entry.publishedBy}</dd>
                      </div>
                      <div>
                        <dt>Source fingerprint</dt>
                        <dd>{entry.sourceFingerprint}</dd>
                      </div>
                    </dl>
                  </CollapsibleContent>
                </Collapsible>
              </li>
            ))}
          </ol>
        ))}
      {page !== null && page.entries.length > 0 && page.nextAfterReleaseRevision === null && (
        <p className="text-sm text-muted-foreground">End of release history.</p>
      )}
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
          <Icon name="chevron-down" />
          Details
        </CollapsibleTrigger>
        <CollapsibleContent>
          <dl className="space-y-2 break-all font-mono text-xs">
            <div>
              <dt>Technical name</dt>
              <dd>{snapshot.definitionKey}</dd>
            </div>
            <div>
              <dt>Saved draft revision</dt>
              <dd>{snapshot.draftRevision}</dd>
            </div>
            <div>
              <dt>Current release revision</dt>
              <dd>{snapshot.anchorReleaseRevision ?? "No published release"}</dd>
            </div>
          </dl>
        </CollapsibleContent>
      </Collapsible>
      {confirmDialog}
    </section>
  );
}
