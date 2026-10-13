"use client";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Button } from "@vortex/ui/components/button";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  reloadApplicationDraftRestore,
  restoreApplicationDraftFromRelease,
} from "../[organizationId]/[applicationRootId]/history/[releaseRevision]/restore/actions";
import type {
  StudioApplicationRestoreAvailable,
  StudioApplicationRestoreCommandResult,
  StudioApplicationRestoreFailure,
  StudioApplicationRestoreLoadResult,
  StudioApplicationRestoreReceipt,
  StudioApplicationRestoreSelector,
} from "../../_lib/studio-application-restore-contracts";

type FailureKind = StudioApplicationRestoreFailure["kind"];
type Pending = "reload" | "restore";

const routeIdentity = (selector: StudioApplicationRestoreSelector): string => JSON.stringify([
  selector.organizationId,
  selector.rootId,
  selector.releaseRevision,
]);

const loadIdentity = (load: StudioApplicationRestoreAvailable | null): string | null => load === null
  ? null
  : JSON.stringify([
    load.selector.organizationId,
    load.selector.rootId,
    load.selector.releaseRevision,
    load.snapshot.definitionKey,
    load.snapshot.draftRevision,
    load.snapshot.sourceFingerprint,
    load.snapshot.anchorReleaseRevision,
    load.metadata.releaseVersion,
    load.metadata.sourceFingerprint,
    load.metadata.publishedAt,
    load.metadata.publishedBy,
    load.metadata.releaseNote,
  ]);

const failureMessage = (failure: FailureKind): string => failure === "conflict"
  ? "The saved draft or current release changed. Reload the current saved draft before confirming again."
  : failure === "refused"
    ? "Restore is unavailable for the current account or release. Reload the saved draft before continuing."
    : "The restore outcome could not be confirmed. Reload the saved draft before trying again.";

const commandFailureMessage = (result: Exclude<StudioApplicationRestoreCommandResult, { kind: "completed" }>): string => {
  if (result.stateMayHaveChanged === "unknown")
    return result.kind === "conflict"
      ? "The saved draft or current release changed, or the restore outcome could not be confirmed. Reload the saved draft before continuing."
      : "The restore outcome could not be confirmed. Reload the saved draft before continuing.";
  return result.kind === "conflict"
    ? "The saved draft or current release changed. Reload the saved draft before confirming again."
    : result.kind === "refused"
      ? "Restore was refused. Reload the saved draft before continuing."
      : "Restore is temporarily unavailable. Reload the saved draft before trying again.";
};

const initialAvailable = (result: StudioApplicationRestoreLoadResult): StudioApplicationRestoreAvailable | null =>
  result.kind === "available" ? result : null;

export function ApplicationReleaseRestore({
  selector,
  initialResult,
}: {
  selector: StudioApplicationRestoreSelector;
  initialResult: StudioApplicationRestoreLoadResult;
}) {
  const route = routeIdentity(selector);
  const [load, setLoad] = useState<StudioApplicationRestoreAvailable | null>(() => initialAvailable(initialResult));
  const [failure, setFailure] = useState<FailureKind | null>(() =>
    initialResult.kind === "available" ? null : initialResult.kind);
  const [requiresReload, setRequiresReload] = useState(initialResult.kind !== "available");
  const [confirmation, setConfirmation] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [receipt, setReceipt] = useState<StudioApplicationRestoreReceipt | null>(null);
  const [message, setMessage] = useState(initialResult.kind === "available"
    ? "The selected release and saved draft are ready for review."
    : failureMessage(initialResult.kind));

  const mounted = useRef(false);
  const lifetime = useRef(0);
  const generation = useRef(0);
  const pendingRef = useRef<Pending | null>(null);
  const loadRef = useRef<StudioApplicationRestoreAvailable | null>(initialAvailable(initialResult));
  const currentRoute = useRef(route);
  currentRoute.current = route;
  const currentInitial = useRef(initialResult);
  currentInitial.current = initialResult;

  useEffect(() => {
    mounted.current = true;
    lifetime.current += 1;
    generation.current += 1;
    pendingRef.current = null;
    loadRef.current = initialAvailable(initialResult);
    setLoad(initialAvailable(initialResult));
    setFailure(initialResult.kind === "available" ? null : initialResult.kind);
    setRequiresReload(initialResult.kind !== "available");
    setConfirmation(false);
    setPending(null);
    setReceipt(null);
    setMessage(initialResult.kind === "available"
      ? "The selected release and saved draft are ready for review."
      : failureMessage(initialResult.kind));
    return () => {
      mounted.current = false;
      lifetime.current += 1;
      generation.current += 1;
      pendingRef.current = null;
    };
  }, [route, initialResult]);

  const matchingLoad = load !== null &&
    load.selector.organizationId.toLowerCase() === selector.organizationId.toLowerCase() &&
    load.selector.rootId.toLowerCase() === selector.rootId.toLowerCase() &&
    load.selector.releaseRevision === selector.releaseRevision;
  const ready = matchingLoad && !requiresReload && failure === null;

  const runReload = async () => {
    if (!mounted.current || pendingRef.current !== null) return;
    const currentLoad = loadRef.current;
    const token = {
      lifetime: lifetime.current,
      generation: ++generation.current,
      route,
      initial: initialResult,
      load: loadIdentity(currentLoad),
    };
    const current = () => mounted.current && lifetime.current === token.lifetime &&
      generation.current === token.generation && currentRoute.current === token.route &&
      currentInitial.current === token.initial && loadIdentity(loadRef.current) === token.load;
    const active = () => mounted.current && lifetime.current === token.lifetime &&
      generation.current === token.generation && currentRoute.current === token.route &&
      currentInitial.current === token.initial;
    pendingRef.current = "reload";
    setPending("reload");
    setConfirmation(false);
    setReceipt(null);
    setMessage("Reloading the current saved draft and selected release.");
    try {
      const result = await reloadApplicationDraftRestore(selector.organizationId, selector);
      if (!current()) return;
      if (result.kind === "available") {
        loadRef.current = result;
        setLoad(result);
        setFailure(null);
        setRequiresReload(false);
        setReceipt(null);
        setMessage("The current saved draft and selected release were reloaded. Review and confirm again before restoring.");
      } else {
        setFailure(result.kind);
        setRequiresReload(true);
        setMessage(failureMessage(result.kind));
      }
    } catch {
      if (current()) {
        setFailure("temporarily_unavailable");
        setRequiresReload(true);
        setMessage(failureMessage("temporarily_unavailable"));
      }
    } finally {
      if (active()) {
        pendingRef.current = null;
        setPending(null);
      }
    }
  };

  const runRestore = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const currentLoad = loadRef.current;
    if (!mounted.current || pendingRef.current !== null || !confirmation || currentLoad === null || !ready)
      return;
    const token = {
      lifetime: lifetime.current,
      generation: ++generation.current,
      route,
      initial: initialResult,
      load: loadIdentity(currentLoad),
    };
    const current = () => mounted.current && lifetime.current === token.lifetime &&
      generation.current === token.generation && currentRoute.current === token.route &&
      currentInitial.current === token.initial && loadIdentity(loadRef.current) === token.load;
    const active = () => mounted.current && lifetime.current === token.lifetime &&
      generation.current === token.generation && currentRoute.current === token.route &&
      currentInitial.current === token.initial;
    const command = {
      selector,
      expected: {
        draftRevision: currentLoad.snapshot.draftRevision,
        sourceFingerprint: currentLoad.snapshot.sourceFingerprint,
        anchorReleaseRevision: currentLoad.snapshot.anchorReleaseRevision,
      },
      confirmed: true as const,
    };
    pendingRef.current = "restore";
    setPending("restore");
    setConfirmation(false);
    setReceipt(null);
    setMessage("Restoring the selected immutable release into the saved draft.");
    try {
      const result = await restoreApplicationDraftFromRelease(selector.organizationId, command);
      if (!current()) return;
      if (result.kind === "completed") {
        setReceipt(result.receipt);
        setFailure(null);
        setRequiresReload(true);
        setMessage(`Restore completed at saved draft revision ${result.receipt.draftRevision}. Reload before another restore.`);
      } else {
        setFailure(result.kind);
        setRequiresReload(true);
        setMessage(commandFailureMessage(result));
      }
    } catch {
      if (current()) {
        setFailure("temporarily_unavailable");
        setRequiresReload(true);
        setMessage(failureMessage("temporarily_unavailable"));
      }
    } finally {
      if (active()) {
        pendingRef.current = null;
        setPending(null);
        setConfirmation(false);
      }
    }
  };

  const displayedLoad = matchingLoad ? load : null;
  const historyUrl = `/studio/${encodeURIComponent(selector.organizationId)}/${encodeURIComponent(selector.rootId)}/history`;
  const workspaceUrl = `/studio/${encodeURIComponent(selector.organizationId)}/${encodeURIComponent(selector.rootId)}`;
  const staleLabel = requiresReload || failure !== null;

  return <main className="mx-auto max-w-4xl space-y-6 p-6">
    <header className="space-y-3">
      <h1 className="text-2xl font-semibold">Restore an application release to the saved draft</h1>
      <p>This action replaces only the saved draft with the selected immutable release and creates one new draft revision. It does not publish, install, or adopt the release.</p>
      <p>Your original Studio workspace and unsaved edits stay in their own tab. Those buffers may now refer to an older saved revision; this page never reads or discards them. Open a new workspace deliberately before continuing to edit.</p>
      <nav aria-label="Restore navigation" className="flex flex-wrap gap-3">
        <a className="underline" href={historyUrl}>Return to release history</a>
        <a className="underline" href={workspaceUrl} target="_blank" rel="noopener noreferrer">Open a new workspace tab</a>
      </nav>
    </header>

    <section aria-label="Selected release and saved draft" aria-busy={pending !== null} className="space-y-4 rounded-xl border bg-card text-card-foreground p-4">
      <h2 className="text-xl font-semibold">{staleLabel ? "Last confirmed restore preview" : "Review before restoring"}</h2>
      {displayedLoad !== null ? <>
        <dl className="space-y-3">
          <div><dt className="font-semibold">Application</dt><dd>{displayedLoad.snapshot.definitionKey}</dd></div>
          <div><dt className="font-semibold">Selected version and revision</dt><dd>{displayedLoad.metadata.releaseVersion} · revision {displayedLoad.metadata.releaseRevision}</dd></div>
          <div><dt className="font-semibold">Selected release source fingerprint</dt><dd className="break-all"><code>{displayedLoad.metadata.sourceFingerprint}</code></dd></div>
          <div><dt className="font-semibold">Release status</dt><dd>{displayedLoad.metadata.isCurrent ? "Current published release" : "Earlier published release"}</dd></div>
          <div><dt className="font-semibold">Published</dt><dd><time dateTime={displayedLoad.metadata.publishedAt}>{displayedLoad.metadata.publishedAt}</time></dd></div>
          <div><dt className="font-semibold">Published by</dt><dd className="break-all">{displayedLoad.metadata.publishedBy}</dd></div>
          <div><dt className="font-semibold">Release note</dt><dd className="whitespace-pre-wrap break-words">{displayedLoad.metadata.releaseNote}</dd></div>
          <div><dt className="font-semibold">Current saved draft revision</dt><dd>{displayedLoad.snapshot.draftRevision}</dd></div>
          <div><dt className="font-semibold">Current saved draft source fingerprint</dt><dd className="break-all"><code>{displayedLoad.snapshot.sourceFingerprint}</code></dd></div>
          <div><dt className="font-semibold">Current publication anchor</dt><dd>{displayedLoad.snapshot.anchorReleaseRevision}</dd></div>
        </dl>
        {staleLabel && <p>This preview is the last confirmed snapshot. Reload to confirm the current saved draft before continuing.</p>}
      </> : <p>The selected release and saved draft could not be loaded. Reload to check them again.</p>}
    </section>

    <div className="flex flex-wrap gap-3">
      <Button type="button" variant="outline" size="sm" name="application.release_history.restore.reload" disabled={pending !== null}
        onClick={() => void runReload()}>
        {pending === "reload" ? "Reloading…" : "Reload saved draft and release"}
      </Button>
    </div>

    <form onSubmit={(event) => void runRestore(event)} className="space-y-4 rounded-xl border bg-card text-card-foreground p-4">
      <h2 className="text-xl font-semibold">Confirm saved-draft restore</h2>
      <p id="restore-confirmation-help">The selected release will replace the saved draft at the revision shown above. Your workspace buffers remain separate and can become stale.</p>
      <label htmlFor="restore-confirmation" className="flex items-start gap-3">
        <Checkbox id="restore-confirmation" checked={confirmation}
          disabled={!ready || pending !== null} aria-describedby="restore-confirmation-help"
          onCheckedChange={(checked) => setConfirmation(checked)} />
        <span>I understand that this replaces the saved draft with the selected release.</span>
      </label>
      <Button type="submit" name="application.draft.restore"
        disabled={!ready || pending !== null || !confirmation}
       >
        {pending === "restore" ? "Restoring…" : "Restore selected release to saved draft"}
      </Button>
    </form>

    {receipt !== null && <section aria-label="Committed restore receipt" className="space-y-3 rounded-xl border bg-card text-card-foreground p-4">
      <h2 className="text-xl font-semibold">Restore committed</h2>
      <dl className="space-y-2">
        <div><dt className="font-semibold">New saved draft revision</dt><dd>{receipt.draftRevision}</dd></div>
        <div><dt className="font-semibold">Restored from release revision</dt><dd>{receipt.targetReleaseRevision}</dd></div>
        <div><dt className="font-semibold">Restored source fingerprint</dt><dd className="break-all"><code>{receipt.sourceFingerprint}</code></dd></div>
        <div><dt className="font-semibold">Publication anchor</dt><dd>{receipt.publicationAnchor}</dd></div>
        <div><dt className="font-semibold">Restored by organization account</dt><dd className="break-all">{receipt.restoredBy}</dd></div>
        <div><dt className="font-semibold">Database operation time</dt><dd><time dateTime={receipt.restoredAt}>{receipt.restoredAt}</time></dd></div>
        <div><dt className="font-semibold">Request correlation</dt><dd className="break-all">{receipt.correlationId}</dd></div>
      </dl>
      <p>Reload the saved draft before another restore. No release was published or installed.</p>
    </section>}

    <p role="status" aria-live="polite" aria-atomic="true">{message}</p>
  </main>;
}
