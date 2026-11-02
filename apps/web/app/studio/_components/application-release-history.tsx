"use client";
import { Alert, AlertAction, AlertDescription } from "@vortex/ui/components/alert";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
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
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@vortex/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@vortex/ui/components/item";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@vortex/ui/components/sheet";
import { Skeleton } from "@vortex/ui/components/skeleton";
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
import { studioNotice } from "./studio-save-state";
import { StudioPager } from "./studio-pager";

import { useEffect, useRef, useState } from "react";
import { describeSourceChange, type SourceChangeRow } from "@vortex/platform/schema";
import type {
  StudioApplicationHistoryFailure,
  StudioApplicationHistoryPage,
  StudioApplicationHistorySnapshot,
  StudioApplicationReleaseEntry,
  StudioReleaseChanges,
} from "../../_lib/studio-application-history";
import type { StudioApplicationRestoreCommandResult } from "../../_lib/studio-application-restore-contracts";
import {
  listApplicationReleaseHistory,
  readApplicationReleaseChanges,
  restoreApplicationRelease,
} from "../releases-actions";
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
type Pending = "reload" | "older" | "newer" | "restore";
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

/** "3 pages, 2 blocks, 1 flow changed": the design's areas a version touched, as the publish confirmation words it. */
const changeSummary = (changes: StudioReleaseChanges): string => {
  if (changes.kind === "first") return "First version";
  if (changes.kind === "unavailable") return notComparable;
  return describeSourceChange(changes.counts) ?? "No change to the application";
};

const notComparable = "This version was published in an earlier format and cannot be compared.";

/** Added, changed and removed counts of each area, for the summary's tooltip. */
const changeDetail = (changes: StudioReleaseChanges): string | undefined =>
  changes.kind === "changed" && changes.counts.length > 0
    ? changes.counts
        .map((count) => {
          const parts = [
            count.added > 0 ? `${count.added} added` : "",
            count.changed > 0 ? `${count.changed} changed` : "",
            count.removed > 0 ? `${count.removed} removed` : "",
          ].filter((part) => part !== "");
          return `${count.area}: ${parts.join(", ")}`;
        })
        .join(" · ")
    : undefined;

type ChangesLoad =
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "available";
      first: boolean;
      comparable: boolean;
      rows: readonly SourceChangeRow[];
    }>
  | Readonly<{ kind: "unavailable"; conflict: boolean }>;

/**
 * The Releases tab's published versions, newest first, 40 to a page: each with when and by whom it
 * was published and what it changed, and a way to view the changes, restore it into the draft or
 * open the application in the App Store. Restoring replaces the saved draft with that version's
 * source as a new draft revision, through the platform's one restore operation; it never
 * publishes or installs anything.
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
  const [viewing, setViewing] = useState<StudioApplicationReleaseEntry | null>(null);
  const [changesLoad, setChangesLoad] = useState<ChangesLoad>({ kind: "loading" });
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

  // The sheet reads what the version changed when it opens; the sources stay on the server.
  useEffect(() => {
    const snapshot = pageRef.current?.snapshot;
    if (viewing === null || snapshot === undefined) return;
    let current = true;
    setChangesLoad({ kind: "loading" });
    readApplicationReleaseChanges(snapshot.organizationId, {
      rootId: snapshot.rootId,
      expected: expectedSnapshot(snapshot),
      releaseRevision: viewing.releaseRevision,
    }).then(
      (result) => {
        if (!current) return;
        if (result.kind === "available")
          setChangesLoad({
            kind: "available",
            first: result.first,
            comparable: result.comparable,
            rows: result.rows,
          });
        else {
          console.error(`[studio] release changes ${result.kind}: ${result.reason}`);
          setChangesLoad({ kind: "unavailable", conflict: result.kind === "conflict" });
        }
      },
      (error: unknown) => {
        console.error("[studio] release changes failed to load", error);
        if (current) setChangesLoad({ kind: "unavailable", conflict: false });
      },
    );
    return () => {
      current = false;
    };
  }, [viewing]);

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

  const load = async (command: "reload" | "older" | "newer") => {
    if (!mounted.current || pendingRef.current !== null) return;
    const sourcePage = pageRef.current;
    const snapshot = sourcePage?.snapshot ?? initialPage.snapshot;
    const edge =
      command === "older"
        ? sourcePage?.entries.at(-1)
        : command === "newer"
          ? sourcePage?.entries[0]
          : undefined;
    if (command !== "reload" && (sourcePage === null || edge === undefined)) return;
    const token = begin(command);
    setMessage(command === "reload" ? "Reloading the versions." : `Loading ${command} versions.`);
    const current = () => mounted.current && generation.current === token;
    const fail = (kind: Failure) => {
      setFailure(kind);
      setMessage(failureMessage(kind));
      if (kind === "refused" || kind === "conflict") {
        pageRef.current = null;
        setPage(null);
      }
    };
    try {
      const result = await listApplicationReleaseHistory(
        snapshot.organizationId,
        command === "reload" || edge === undefined
          ? { kind: "newest", rootId: snapshot.rootId }
          : {
              kind: command,
              rootId: snapshot.rootId,
              expected: expectedSnapshot(snapshot),
              cursorReleaseRevision: edge.releaseRevision,
            },
      );
      if (!current()) return;
      if (result.kind !== "available") {
        fail(result.kind);
        return;
      }
      if (
        command !== "reload" &&
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

  const restore = async (entry: StudioApplicationReleaseEntry) => {
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
  const author = (entry: StudioApplicationReleaseEntry) =>
    page?.publishers[entry.publishedBy.toLowerCase()] ?? "someone you cannot see in the directory";
  const rowMenu = (entry: StudioApplicationReleaseEntry) => (
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
        <TooltipContent>Actions for version {entry.releaseVersion}</TooltipContent>
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
          <span className="flex flex-col">
            Restore into draft
            {restoreBlocked === undefined ? null : (
              <span className="text-xs text-muted-foreground">{restoreBlocked}</span>
            )}
          </span>
        </DropdownMenuItem>
        {entry.isCurrent && appStoreHref !== undefined && (
          <DropdownMenuItem render={<NavigationLink href={appStoreHref} />}>
            <Icon name="app-window" />
            Open in App Store
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
          <div aria-busy={pending !== null} className="space-y-3">
            <div className="hidden md:block">
              <Table aria-label="Published versions">
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Published</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>What changed</TableHead>
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
                        <FormattedTime iso={entry.publishedAt} relative />
                      </TableCell>
                      <TableCell>{author(entry)}</TableCell>
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger
                            render={<span className="block max-w-80 truncate" tabIndex={0} />}
                          >
                            {changeSummary(entry.changes)}
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm whitespace-pre-wrap">
                            {[entry.releaseNote, changeDetail(entry.changes)]
                              .filter((part) => part !== undefined)
                              .join("\n\n")}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell>{rowMenu(entry)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ItemGroup className="gap-2 md:hidden" aria-label="Published versions">
              {page.entries.map((entry) => (
                <Item key={entry.releaseRevision} variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>
                      {entry.releaseVersion}
                      {entry.isCurrent && <Badge variant="secondary">Current</Badge>}
                    </ItemTitle>
                    <ItemDescription>
                      <FormattedTime iso={entry.publishedAt} relative /> by {author(entry)}.{" "}
                      {changeSummary(entry.changes)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>{rowMenu(entry)}</ItemActions>
                </Item>
              ))}
            </ItemGroup>
            <StudioPager
              noun="versions"
              hasNewer={page.hasNewer}
              hasOlder={page.hasOlder}
              disabled={blocked}
              onNewer={() => void load("newer")}
              onOlder={() => void load("older")}
            />
          </div>
        ))}
      <Sheet open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {viewing !== null && (
            <>
              <SheetHeader>
                <SheetTitle>Version {viewing.releaseVersion}</SheetTitle>
                <SheetDescription>
                  Published <FormattedTime iso={viewing.publishedAt} /> by {author(viewing)}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-8 pb-6">
                <p className="text-sm whitespace-pre-wrap break-words">{viewing.releaseNote}</p>
                {changesLoad.kind === "loading" && (
                  <div className="space-y-2" role="status" aria-label="Reading what changed">
                    <Skeleton className="h-6 w-full" />
                    <Skeleton className="h-6 w-full" />
                  </div>
                )}
                {changesLoad.kind === "unavailable" && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {changesLoad.conflict
                        ? "This list is out of date. Reload the versions."
                        : "What this version changed could not be read. Close this panel and try again."}
                    </AlertDescription>
                  </Alert>
                )}
                {changesLoad.kind === "available" &&
                  (changesLoad.first ? (
                    <p className="text-sm text-muted-foreground">
                      The first version: there is nothing before it to compare with.
                    </p>
                  ) : !changesLoad.comparable ? (
                    <p className="text-sm text-muted-foreground">{notComparable}</p>
                  ) : changesLoad.rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      This version changed nothing in the application.
                    </p>
                  ) : (
                    <Table aria-label="What this version changed">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Area</TableHead>
                          <TableHead>Item</TableHead>
                          <TableHead>Change</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {changesLoad.rows.map((row, index) => (
                          <TableRow key={`${row.area}:${row.item}:${index}`}>
                            <TableCell>{row.area}</TableCell>
                            <TableCell className="whitespace-normal wrap-anywhere">
                              {row.item}
                            </TableCell>
                            <TableCell>{row.change}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ))}
                <Collapsible>
                  <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
                    <Icon
                      name="chevron-right"
                      className="transition-transform group-data-[panel-open]/button:rotate-90"
                    />
                    Details
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-2">
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
                  </CollapsibleContent>
                </Collapsible>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
      {confirmDialog}
    </section>
  );
}
