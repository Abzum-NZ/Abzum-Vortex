"use client";
import { Alert, AlertAction, AlertDescription } from "@vortex/ui/components/alert";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vortex/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@vortex/ui/components/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@vortex/ui/components/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vortex/ui/components/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { NavigationLink } from "@vortex/ui/routing";
import { StudioInspectorGroup } from "@vortex/ui/studio";
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
      : result.kind === "superseded"
        ? "This version was published in an earlier definition format and can't be restored. Its history stays here; change the current draft instead."
        : result.kind === "refused"
          ? "Restoring was refused for your account or this version, so nothing was restored."
          : "Restoring is temporarily unavailable, so nothing was restored. Try again in a moment.";

/**
 * The Releases tab's published versions: each with when and by whom it was published and what
 * changed, and a way to view it, restore it into the draft or open the application in the App
 * Store. Restoring replaces the saved draft with that version's source as a new draft revision,
 * through the platform's one restore operation; it never publishes or installs anything.
 */
export function ApplicationReleaseHistory({
  initialPage,
  appStoreHref,
  restoreBlocked,
  hold,
  onRestored,
  onPublish,
}: {
  initialPage: StudioApplicationHistoryPage;
  /** The App Store page that shows the application, when the standing names one. */
  appStoreHref: string | undefined;
  /** Why restoring cannot start now (unsaved or pending edits in the workspace), or nothing. */
  restoreBlocked: string | undefined;
  /** Holds the workspace's draft while a restore writes the saved draft, so nothing else edits it. */
  hold: (on: boolean) => void;
  /** Loads the restored saved draft into the workspace and says what happened. */
  onRestored: (message: string) => void;
  /** Starts Publish, offered where nothing is published yet. */
  onPublish: () => void;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const currentRestoreBlocked = useRef(restoreBlocked);
  currentRestoreBlocked.current = restoreBlocked;
  const [page, setPage] = useState<StudioApplicationHistoryPage | null>(initialPage);
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [message, setMessage] = useState("Versions loaded.");
  const [viewing, setViewing] = useState<DefinitionReleaseMetadata | null>(null);
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
      // A superseded version leaves the list usable; only its own restore is refused.
      setFailure(result.kind === "superseded" ? null : result.kind);
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

  const blocked = pending !== null || page === null;
  const author = (entry: DefinitionReleaseMetadata) =>
    page?.publishers[entry.publishedBy.toLowerCase()] ?? "someone you cannot see in the directory";
  return (
    <section aria-label="Release history" className="space-y-4">
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </p>
      {failure !== null && (
        <Alert variant="destructive">
          <AlertDescription>
            {failureMessage(failure)}
            {page !== null && failure === "temporarily_unavailable"
              ? " These details are from the last successful load."
              : ""}
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending !== null}
              onClick={() => void load("reload")}
            >
              Reload
            </Button>
          </AlertAction>
        </Alert>
      )}
      {restoreBlocked !== undefined && page !== null && page.entries.length > 0 && (
        <Alert variant="info">
          <AlertDescription>{restoreBlocked}</AlertDescription>
        </Alert>
      )}
      {page !== null &&
        (page.entries.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="history" />
              </EmptyMedia>
              <EmptyTitle>Not published yet</EmptyTitle>
              <EmptyDescription>
                A release is a numbered copy of your application that your organisation can install.
                Publish to create version 1.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" onClick={onPublish}>
                <Icon name="package-plus" />
                Publish
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div aria-busy={pending !== null}>
            <Table aria-label="Published versions">
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Published</TableHead>
                  <TableHead className="hidden md:table-cell">By</TableHead>
                  <TableHead className="hidden lg:table-cell">What changed</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.entries.map((entry) => (
                  <TableRow key={entry.releaseRevision}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        {entry.releaseVersion}
                        {entry.isCurrent && <Badge variant="secondary">Current</Badge>}
                      </span>
                    </TableCell>
                    <TableCell>
                      <FormattedTime iso={entry.publishedAt} />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{author(entry)}</TableCell>
                    <TableCell className="hidden max-w-80 truncate lg:table-cell">
                      {entry.releaseNote}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    type="button"
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={`Actions for version ${entry.releaseVersion}`}
                                  />
                                }
                              />
                            }
                          >
                            <Icon name="more-horizontal" />
                          </TooltipTrigger>
                          <TooltipContent>
                            Actions for version {entry.releaseVersion}
                          </TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setViewing(entry)}>
                            <Icon name="eye" />
                            View changes
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={blocked || restoreBlocked !== undefined}
                            onClick={() => void restore(entry)}
                          >
                            <Icon name="history" />
                            Restore into draft
                          </DropdownMenuItem>
                          {entry.isCurrent && appStoreHref !== undefined && (
                            <DropdownMenuItem render={<NavigationLink href={appStoreHref} />}>
                              <Icon name="app-window" />
                              Open in App Store
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {page.nextAfterReleaseRevision != null && (
              <div className="flex justify-center pt-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={blocked}
                  onClick={() => void load("next")}
                >
                  Next 20 versions
                </Button>
              </div>
            )}
          </div>
        ))}
      <Sheet open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {viewing !== null && (
            <>
              <SheetHeader>
                <SheetTitle>Version {viewing.releaseVersion}</SheetTitle>
                <SheetDescription>
                  Published <FormattedTime iso={viewing.publishedAt} /> by {author(viewing)}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-4">
                <p className="text-sm whitespace-pre-wrap break-words">{viewing.releaseNote}</p>
                <StudioInspectorGroup title="Details" defaultOpen={false}>
                  <dl className="space-y-3 font-mono text-xs">
                    <div>
                      <dt className="font-semibold">Release revision</dt>
                      <dd>{viewing.releaseRevision}</dd>
                    </div>
                    <div>
                      <dt className="font-semibold">Published by (account id)</dt>
                      <dd className="break-all">{viewing.publishedBy}</dd>
                    </div>
                    <div>
                      <dt className="font-semibold">Source fingerprint</dt>
                      <dd className="break-all">
                        <code>{viewing.sourceFingerprint}</code>
                      </dd>
                    </div>
                  </dl>
                </StudioInspectorGroup>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
      {confirmDialog}
    </section>
  );
}
