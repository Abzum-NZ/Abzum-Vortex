"use client";
import { Button } from "@vortex/ui/components/button";
import { TechnicalDetails } from "@vortex/ui/components/technical-details";

import { useEffect, useRef, useState } from "react";
import type { DefinitionReleaseMetadata } from "@vortex/platform/schema";
import type { StudioApplicationHistoryFailure, StudioApplicationHistoryPage,
  StudioApplicationHistorySnapshot } from "../../_lib/studio-application-history";
import { inspectApplicationReleaseHistory, listApplicationReleaseHistory,
} from "../[organizationId]/[applicationRootId]/history/actions";
import { FormattedTime } from "@vortex/ui";

const snapshotIdentity = (snapshot: StudioApplicationHistorySnapshot) => JSON.stringify([
  snapshot.organizationId, snapshot.rootId, snapshot.definitionKey, snapshot.draftRevision,
  snapshot.sourceFingerprint, snapshot.anchorReleaseRevision,
]);
const routeIdentity = (snapshot: StudioApplicationHistorySnapshot) =>
  `${snapshot.organizationId}:${snapshot.rootId}`;
const expectedSnapshot = (snapshot: StudioApplicationHistorySnapshot) => ({
  draftRevision: snapshot.draftRevision, sourceFingerprint: snapshot.sourceFingerprint,
  anchorReleaseRevision: snapshot.anchorReleaseRevision,
});
type Pending = "reload" | "next" | "inspect";
type Failure = StudioApplicationHistoryFailure["kind"];

const failureMessage = (failure: Failure) => failure === "conflict"
  ? "The saved application or its current version changed, so this list is out of date. Reload before continuing."
  : failure === "refused"
    ? "The version history is unavailable. Sign in with an account that can manage this application, then reload."
    : "The version history is temporarily unavailable. Try again or reload.";

/** The Releases tab's published versions, oldest first, and the review pages for each. */
export function ApplicationReleaseHistory({ initialPage }: {
  initialPage: StudioApplicationHistoryPage;
}) {
  const [page, setPage] = useState<StudioApplicationHistoryPage | null>(initialPage);
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [metadata, setMetadata] = useState<DefinitionReleaseMetadata | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [message, setMessage] = useState("Versions loaded.");
  const lifetime = useRef(0);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pendingRef = useRef<Pending | null>(null);
  const pageRef = useRef<StudioApplicationHistoryPage | null>(initialPage);
  const selectionRef = useRef<number | null>(null);
  // Render-time route binding rejects a response even before the next effect has run.
  const currentRoute = useRef(routeIdentity(initialPage.snapshot));
  currentRoute.current = routeIdentity(initialPage.snapshot);
  const currentInitial = useRef(initialPage);
  currentInitial.current = initialPage;

  useEffect(() => {
    mounted.current = true;
    lifetime.current += 1;
    generation.current += 1;
    pendingRef.current = null;
    pageRef.current = initialPage;
    selectionRef.current = null;
    setPage(initialPage);
    setSelectedRevision(null);
    setMetadata(null);
    setPending(null);
    setFailure(null);
    setMessage("Versions loaded.");
    return () => {
      mounted.current = false;
      lifetime.current += 1;
      generation.current += 1;
      pendingRef.current = null;
    };
  }, [initialPage]);

  const run = async (command: Pending, releaseRevision?: number) => {
    if (!mounted.current || pendingRef.current !== null) return;
    const sourcePage = pageRef.current;
    if (command !== "reload" && (sourcePage === null || failure === "refused" || failure === "conflict")) return;
    const snapshot = sourcePage?.snapshot ?? initialPage.snapshot;
    const nextCursor = sourcePage?.nextAfterReleaseRevision;
    if (command === "next" && nextCursor == null) return;
    if (command === "inspect") {
      if (releaseRevision === undefined || sourcePage === null ||
        !sourcePage.entries.some((entry) => entry.releaseRevision === releaseRevision)) return;
      selectionRef.current = releaseRevision;
      setSelectedRevision(releaseRevision);
      setMetadata(null);
    }
    pendingRef.current = command;
    setPending(command);
    setFailure(null);
    setMessage(command === "inspect" ? "Loading the selected version."
      : command === "next" ? "Loading the next versions." : "Reloading the versions.");
    const token = { lifetime: lifetime.current, generation: ++generation.current,
      snapshot: sourcePage === null ? null : snapshotIdentity(snapshot),
      route: currentRoute.current, initial: initialPage, selected: selectionRef.current };
    const current = () => mounted.current && lifetime.current === token.lifetime &&
      generation.current === token.generation && currentRoute.current === token.route &&
      currentInitial.current === token.initial && selectionRef.current === token.selected &&
      (pageRef.current === null ? null : snapshotIdentity(pageRef.current.snapshot)) === token.snapshot;
    const fail = (kind: Failure) => {
      setFailure(kind);
      setMessage(failureMessage(kind));
      if (kind === "refused" || kind === "conflict") {
        pageRef.current = null;
        selectionRef.current = null;
        setPage(null);
        setSelectedRevision(null);
        setMetadata(null);
      }
    };
    try {
      if (command === "inspect") {
        const result = await inspectApplicationReleaseHistory(snapshot.organizationId, {
          rootId: snapshot.rootId, expected: expectedSnapshot(snapshot), releaseRevision,
        });
        if (!current()) return;
        if (result.kind !== "available") { fail(result.kind); return; }
        if (snapshotIdentity(result.snapshot) !== token.snapshot ||
          result.metadata.releaseRevision !== token.selected) { fail("refused"); return; }
        setMetadata(result.metadata);
        setMessage("Selected version loaded.");
      } else {
        const result = await listApplicationReleaseHistory(snapshot.organizationId, command === "reload"
          ? { kind: "reload", rootId: snapshot.rootId }
          : { kind: "next", rootId: snapshot.rootId, expected: expectedSnapshot(snapshot),
            afterReleaseRevision: nextCursor });
        if (!current()) return;
        if (result.kind !== "available") { fail(result.kind); return; }
        if (routeIdentity(result.page.snapshot) !== token.route ||
          (command === "next" && snapshotIdentity(result.page.snapshot) !== token.snapshot)) {
          fail("refused"); return;
        }
        // Replace one bounded page. Never append across anchors or retain an unbounded history.
        pageRef.current = result.page;
        selectionRef.current = null;
        setPage(result.page);
        setSelectedRevision(null);
        setMetadata(null);
        setMessage(result.page.entries.length === 0 ? "Nothing is published yet." : "Versions loaded.");
      }
    } catch {
      if (current()) fail("temporarily_unavailable");
    } finally {
      // Successful settlement updates the snapshot or selection, so use the lifetime/generation fence here.
      if (mounted.current && lifetime.current === token.lifetime && generation.current === token.generation &&
        currentRoute.current === token.route && currentInitial.current === token.initial) {
        pendingRef.current = null;
        setPending(null);
      }
    }
  };

  const displayedSnapshot = page?.snapshot ?? initialPage.snapshot;
  const blocked = pending !== null || page === null || failure === "refused" || failure === "conflict";
  return <section aria-label="Release history" className="space-y-6">
    <header className="space-y-3">
      <h2 className="text-xl font-semibold">Published versions</h2>
      <p>Versions are listed oldest first, 20 at a time.</p>
    </header>
    {page !== null && <section aria-label="Saved application context" className="space-y-2 rounded-xl border bg-card text-card-foreground p-4">
      <dl className="space-y-2">
        <div><dt className="font-semibold">Current version</dt><dd>{displayedSnapshot.anchorReleaseRevision === null ? "Not published yet" : "Published"}</dd></div>
      </dl>
      <TechnicalDetails><dl className="space-y-2">
        <div><dt className="font-semibold">Technical name</dt><dd className="break-all">{displayedSnapshot.definitionKey}</dd></div>
        <div><dt className="font-semibold">Saved draft revision</dt><dd>{displayedSnapshot.draftRevision}</dd></div>
        <div><dt className="font-semibold">Current release revision</dt><dd>{displayedSnapshot.anchorReleaseRevision ?? "No published release"}</dd></div>
        <div><dt className="font-semibold">Organization</dt><dd className="break-all">{displayedSnapshot.organizationId}</dd></div>
        <div><dt className="font-semibold">Application root</dt><dd className="break-all">{displayedSnapshot.rootId}</dd></div>
        <div><dt className="font-semibold">Saved source fingerprint</dt><dd className="break-all"><code>{displayedSnapshot.sourceFingerprint}</code></dd></div>
      </dl></TechnicalDetails>
    </section>}
    <div className="flex flex-wrap gap-3">
      <Button type="button" variant="outline" size="sm" name="application.release_history.reload" disabled={pending !== null}
        onClick={() => void run("reload")}>
        Reload versions
      </Button>
      <Button type="button" variant="outline" size="sm" name="application.release_history.next" disabled={blocked || page?.nextAfterReleaseRevision == null}
        onClick={() => void run("next")}>
        Next 20 versions
      </Button>
    </div>
    <p role="status" aria-live="polite" aria-atomic="true">{message}</p>
    {page !== null && (pending !== null || failure === "temporarily_unavailable") &&
      <p>These details are from the last successful load.</p>}
    <section aria-labelledby="release-list-heading" aria-busy={pending === "next" || pending === "reload"} className="space-y-3">
      <h3 id="release-list-heading" className="text-lg font-semibold">Published versions (oldest first)</h3>
      {page !== null && failure !== "conflict" && (page.entries.length === 0
        ? <p>Nothing is published yet. Saving a draft does not publish it.</p>
        : <>
          <ol className="space-y-3">
            {page.entries.map((entry) => <li key={entry.releaseRevision} className="space-y-2 rounded-xl border bg-card text-card-foreground p-4">
              <p className="font-semibold">Version {entry.releaseVersion}
                {entry.isCurrent && <span> · Current version</span>}</p>
              <p>Published <FormattedTime iso={entry.publishedAt} /></p>
              <p className="whitespace-pre-wrap break-words">{entry.releaseNote}</p>
              <Button type="button" variant="outline" size="sm" name="application.release_history.inspect" aria-pressed={selectedRevision === entry.releaseRevision}
                disabled={blocked}
                onClick={() => void run("inspect", entry.releaseRevision)}>
                Show details of version {entry.releaseVersion}
              </Button>
            </li>)}
          </ol>
          {page.nextAfterReleaseRevision === null && <p>End of release history.</p>}
        </>)}
    </section>
    <section aria-labelledby="release-inspect-heading" aria-busy={pending === "inspect"} className="space-y-3">
      <h3 id="release-inspect-heading" className="text-lg font-semibold">Selected version</h3>
      {metadata !== null && failure !== "conflict" ? <><dl className="space-y-2 rounded-xl border bg-card text-card-foreground p-4">
        <div><dt className="font-semibold">Version</dt><dd>{metadata.releaseVersion}</dd></div>
        <div><dt className="font-semibold">Current version</dt><dd>{metadata.isCurrent ? "Yes" : "No"}</dd></div>
        <div><dt className="font-semibold">Published</dt><dd><FormattedTime iso={metadata.publishedAt} /></dd></div>
        <div><dt className="font-semibold">Release note</dt><dd className="whitespace-pre-wrap break-words">{metadata.releaseNote}</dd></div>
        {selectedRevision === metadata.releaseRevision && <div className="pt-2">
          <nav aria-label="Selected release actions" className="flex flex-wrap gap-3">
            <a className="inline-flex rounded-lg border px-3 py-2 underline"
              href={`/studio/${encodeURIComponent(displayedSnapshot.organizationId)}/${encodeURIComponent(displayedSnapshot.rootId)}/history/${metadata.releaseRevision}/install`}
              >
              Review upgrade to version {metadata.releaseVersion}
            </a>
            <a className="inline-flex rounded-lg border px-3 py-2 underline"
              href={`/studio/${encodeURIComponent(displayedSnapshot.organizationId)}/${encodeURIComponent(displayedSnapshot.rootId)}/history/${metadata.releaseRevision}/first-install`}
              >
              Review first install of version {metadata.releaseVersion}
            </a>
            {pending === null && page !== null && failure !== "refused" &&
              page.entries.some((entry) => entry.releaseRevision === metadata.releaseRevision) &&
              metadata.isCurrent === (metadata.releaseRevision === page.snapshot.anchorReleaseRevision) &&
              <a className="inline-flex rounded-lg border px-3 py-2 underline"
                data-command="application.release_history.restore.open"
                href={`/studio/${encodeURIComponent(displayedSnapshot.organizationId)}/${encodeURIComponent(displayedSnapshot.rootId)}/history/${metadata.releaseRevision}/restore`}
                >
                Review restore of version {metadata.releaseVersion}
              </a>}
          </nav>
          <p className="mt-2">Each link opens a review page. Restoring, installing and upgrading always ask you to confirm there; none runs from this list. Save your edits first.</p>
        </div>}
      </dl>
      <TechnicalDetails><dl className="space-y-2">
        <div><dt className="font-semibold">Release revision</dt><dd>{metadata.releaseRevision}</dd></div>
        <div><dt className="font-semibold">Published by (account id)</dt><dd className="break-all">{metadata.publishedBy}</dd></div>
        <div><dt className="font-semibold">Source fingerprint</dt><dd className="break-all"><code>{metadata.sourceFingerprint}</code></dd></div>
      </dl></TechnicalDetails></> : <p>Choose "Show details" on a version to read its details.</p>}
    </section>
    <section aria-label="Unavailable release commands" className="space-y-3 rounded-xl border bg-card text-card-foreground p-4">
      <p id="history-unavailable-commands">To restore a version, show its details and open its restore review. Publishing is done from the Publish button at the top of the workspace.</p>
    </section>
  </section>;
}
