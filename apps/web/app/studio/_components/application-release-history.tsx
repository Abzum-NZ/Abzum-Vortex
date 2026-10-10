"use client";

import { useEffect, useRef, useState } from "react";
import type { DefinitionReleaseMetadata } from "@vortex/contracts";
import type { StudioApplicationHistoryFailure, StudioApplicationHistoryPage,
  StudioApplicationHistorySnapshot } from "../../_lib/studio-application-history";
import { inspectApplicationReleaseHistory, listApplicationReleaseHistory,
} from "../[organizationId]/[applicationRootId]/history/actions";

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
  ? "The saved application or current release changed. This snapshot is no longer current. Reload history before continuing."
  : failure === "refused"
    ? "Release history is unavailable. Sign in with an account permitted to manage this draft and reload."
    : "Release history is temporarily unavailable. Retry the command or reload history.";

/** A separate browsing context keeps the original workspace and its pending editors alive. */
export function ApplicationReleaseHistory({ initialPage }: {
  initialPage: StudioApplicationHistoryPage;
}) {
  const [page, setPage] = useState<StudioApplicationHistoryPage | null>(initialPage);
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [metadata, setMetadata] = useState<DefinitionReleaseMetadata | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [message, setMessage] = useState("Release history loaded.");
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
    setMessage("Release history loaded.");
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
    setMessage(command === "inspect" ? `Loading release revision ${releaseRevision}.`
      : command === "next" ? "Loading the next release-history page." : "Reloading release history.");
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
        setMessage(`Release revision ${result.metadata.releaseRevision} loaded.`);
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
        setMessage(result.page.entries.length === 0 ? "No published releases." : "Release history loaded.");
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
  const workspaceUrl = `/studio/${encodeURIComponent(initialPage.snapshot.organizationId)}/${encodeURIComponent(initialPage.snapshot.rootId)}`;
  const blocked = pending !== null || page === null || failure === "refused" || failure === "conflict";
  return <main className="mx-auto max-w-5xl space-y-6 p-6">
    <header className="space-y-3">
      <h1 className="text-2xl font-semibold">Application release history</h1>
      <p>Persisted releases are listed oldest first, in pages of up to 20 releases.</p>
      <p>Your original Studio workspace stays open with its pending edits.</p>
      <a className="underline" href={workspaceUrl} target="_blank" rel="noopener noreferrer">
        Open workspace in a new tab
      </a>
    </header>
    {page !== null && <section aria-label="Saved application context" className="space-y-2 rounded border p-4">
      <dl className="space-y-2">
        <div><dt className="font-semibold">Application</dt><dd>{displayedSnapshot.definitionKey}</dd></div>
        <div><dt className="font-semibold">Organization</dt><dd className="break-all">{displayedSnapshot.organizationId}</dd></div>
        <div><dt className="font-semibold">Application root</dt><dd className="break-all">{displayedSnapshot.rootId}</dd></div>
        <div><dt className="font-semibold">Saved draft revision</dt><dd>{displayedSnapshot.draftRevision}</dd></div>
        <div><dt className="font-semibold">Saved source fingerprint</dt><dd className="break-all"><code>{displayedSnapshot.sourceFingerprint}</code></dd></div>
        <div><dt className="font-semibold">Current release revision</dt><dd>{displayedSnapshot.anchorReleaseRevision ?? "No published release"}</dd></div>
      </dl>
    </section>}
    <div className="flex flex-wrap gap-3">
      <button type="button" name="application.release_history.reload" disabled={pending !== null}
        className="rounded border px-3 py-2 disabled:opacity-50" onClick={() => void run("reload")}>
        Reload history
      </button>
      <button type="button" name="application.release_history.next" disabled={blocked || page?.nextAfterReleaseRevision == null}
        className="rounded border px-3 py-2 disabled:opacity-50" onClick={() => void run("next")}>
        Next 20 releases
      </button>
    </div>
    <p role="status" aria-live="polite" aria-atomic="true">{message}</p>
    {page !== null && (pending !== null || failure === "temporarily_unavailable") &&
      <p>Displayed metadata is the last confirmed snapshot.</p>}
    <section aria-labelledby="release-list-heading" aria-busy={pending === "next" || pending === "reload"} className="space-y-3">
      <h2 id="release-list-heading" className="text-xl font-semibold">Published releases (oldest first)</h2>
      {page !== null && failure !== "conflict" && (page.entries.length === 0
        ? <p>No published releases. Saving a draft does not publish a release.</p>
        : <>
          <ol className="space-y-3">
            {page.entries.map((entry) => <li key={entry.releaseRevision} className="space-y-2 rounded border p-4">
              <p className="font-semibold">Version {entry.releaseVersion} · revision {entry.releaseRevision}
                {entry.isCurrent && <span> · Current release</span>}</p>
              <p>Published <time dateTime={entry.publishedAt}>{entry.publishedAt}</time></p>
              <p className="break-all">Published by {entry.publishedBy}</p>
              <p className="whitespace-pre-wrap break-words">{entry.releaseNote}</p>
              <button type="button" name="application.release_history.inspect" aria-pressed={selectedRevision === entry.releaseRevision}
                disabled={blocked} className="rounded border px-3 py-2 disabled:opacity-50"
                onClick={() => void run("inspect", entry.releaseRevision)}>
                Inspect version {entry.releaseVersion}, revision {entry.releaseRevision}
              </button>
            </li>)}
          </ol>
          {page.nextAfterReleaseRevision === null && <p>End of release history.</p>}
        </>)}
    </section>
    <section aria-labelledby="release-inspect-heading" aria-busy={pending === "inspect"} className="space-y-3">
      <h2 id="release-inspect-heading" className="text-xl font-semibold">Exact selected release</h2>
      {metadata !== null && failure !== "conflict" ? <dl className="space-y-2 rounded border p-4">
        <div><dt className="font-semibold">Version and revision</dt><dd>{metadata.releaseVersion} · revision {metadata.releaseRevision}</dd></div>
        <div><dt className="font-semibold">Current release</dt><dd>{metadata.isCurrent ? "Yes" : "No"}</dd></div>
        <div><dt className="font-semibold">Source fingerprint</dt><dd className="break-all"><code>{metadata.sourceFingerprint}</code></dd></div>
        <div><dt className="font-semibold">Content fingerprint</dt><dd className="break-all"><code>{metadata.contentFingerprint}</code></dd></div>
        <div><dt className="font-semibold">Published</dt><dd><time dateTime={metadata.publishedAt}>{metadata.publishedAt}</time></dd></div>
        <div><dt className="font-semibold">Published by</dt><dd className="break-all">{metadata.publishedBy}</dd></div>
        <div><dt className="font-semibold">Release note</dt><dd className="whitespace-pre-wrap break-words">{metadata.releaseNote}</dd></div>
        {selectedRevision === metadata.releaseRevision && <div className="pt-2">
          <nav aria-label="Selected release actions" className="flex flex-wrap gap-3">
            <a className="inline-flex rounded border px-3 py-2 underline"
              href={`/studio/${encodeURIComponent(displayedSnapshot.organizationId)}/${encodeURIComponent(displayedSnapshot.rootId)}/history/${metadata.releaseRevision}/install`}
              target="_blank" rel="noopener noreferrer">
              Review upgrade to version {metadata.releaseVersion}, revision {metadata.releaseRevision}
            </a>
            <a className="inline-flex rounded border px-3 py-2 underline"
              href={`/studio/${encodeURIComponent(displayedSnapshot.organizationId)}/${encodeURIComponent(displayedSnapshot.rootId)}/history/${metadata.releaseRevision}/first-install`}
              target="_blank" rel="noopener noreferrer">
              Review first install of version {metadata.releaseVersion}, revision {metadata.releaseRevision}
            </a>
          </nav>
          <p className="mt-2">These links open separate pages. First installation and upgrades are explicit; neither runs from the history list.</p>
        </div>}
      </dl> : <p>Select Inspect on a release to read its exact persisted metadata.</p>}
    </section>
    <section aria-label="Unavailable release commands" className="space-y-3 rounded border p-4">
      <p id="history-unavailable-commands">Restore and publish are unavailable in this history view. Installation never runs from the history list.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled aria-describedby="history-unavailable-commands" className="rounded border px-3 py-2 opacity-50">Restore unavailable</button>
        <button type="button" disabled aria-describedby="history-unavailable-commands" className="rounded border px-3 py-2 opacity-50">Publish unavailable</button>
      </div>
    </section>
  </main>;
}
