"use client";

import { useEffect, useRef, useState } from "react";
import {
  studioApplicationInstallationCommandResultSchema,
  type StudioApplicationInstallationCommandResult,
  type StudioApplicationInstallationLoadResult,
  type StudioApplicationInstallationSelector,
} from "../../_lib/studio-application-installation-contracts";
import { installSelectedApplicationRelease } from "../[organizationId]/[applicationRootId]/history/[releaseRevision]/install/actions";

type Props = Readonly<{
  selector: StudioApplicationInstallationSelector;
  initialResult: StudioApplicationInstallationLoadResult;
}>;

type State = Readonly<{
  load: StudioApplicationInstallationLoadResult;
  command: StudioApplicationInstallationCommandResult | null;
}>;

const loadMessage = (result: StudioApplicationInstallationLoadResult): string =>
  result.kind === "available"
    ? "Current installation and selected release loaded."
    : "Upgrade information could not be confirmed.";

const snapshotKey = (snapshot: unknown): string => JSON.stringify(snapshot);
const routeHref = (selector: StudioApplicationInstallationSelector): string =>
  `/studio/${encodeURIComponent(selector.organizationId)}/${encodeURIComponent(selector.rootId)}/history/${selector.releaseRevision}/install`;
const historyHref = (selector: StudioApplicationInstallationSelector): string =>
  `/studio/${encodeURIComponent(selector.organizationId)}/${encodeURIComponent(selector.rootId)}/history`;

const unavailableText = (reason: string): string => {
  switch (reason) {
    case "not_installed":
      return "This application does not have a current installation to upgrade.";
    case "not_newer":
      return "This release is not newer than the currently active release.";
    case "module_set_changed":
      return "This release changes the Module release set. This partial supports only upgrades with the same exact Module releases.";
    case "installation_incomplete":
      return "The current installation is incomplete or has bindings that cannot be safely reconciled.";
    case "registration_misaligned":
      return "The current installation registration does not match its active release.";
    default:
      return "This upgrade is unavailable for the selected application.";
  }
};

const commandText = (result: StudioApplicationInstallationCommandResult): string => {
  if (result.kind === "completed") {
    if (result.outcome === "unchanged")
      return result.registrationMayHaveChanged
        ? `Revision ${result.activeAtCommitRevision} is active. The coordinator may have reconciled its Access registration; reload to confirm the current state.`
        : `Revision ${result.activeAtCommitRevision} was already active. No installation change was requested.`;
    const observed = result.postCommit.kind === "observed"
      ? result.postCommit.active.releaseRevision === result.activeAtCommitRevision
        ? ` A fresh read also observed revision ${result.postCommit.active.releaseRevision} active.`
        : ` A later fresh read observed revision ${result.postCommit.active.releaseRevision}; another activation may have followed this completed upgrade.`
      : " The upgrade completed, but a fresh read of the current installation was unavailable.";
    return `Upgrade completed from revision ${result.previousActiveRevision} to revision ${result.activeAtCommitRevision}.${observed}`;
  }
  switch (result.kind) {
    case "conflict":
      return "The installation or selected release changed. Reload this page before continuing.";
    case "authentication_required":
      return "Recent sign-in is required for this upgrade. Sign in again, then reload this page.";
    case "refused":
      return "Upgrade permission or current application eligibility could not be confirmed. Reload release history to continue.";
    case "temporarily_unavailable":
      return result.registrationMayHaveChanged === false
        ? "The upgrade could not be completed. Reload to observe the current installation before trying again."
        : "The upgrade outcome could not be confirmed. Access registration may have changed; reload to observe the current installation. Do not repeat the command automatically.";
    default:
      return "The upgrade did not complete. Access registration may have changed; reload to observe the current installation.";
  }
};

export function ApplicationReleaseInstallation({ selector, initialResult }: Props) {
  const [state, setState] = useState<State>({ load: initialResult, command: null });
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [message, setMessage] = useState(loadMessage(initialResult));
  const outcomeHeading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pendingRef = useRef(false);
  const routeRef = useRef(routeHref(selector));
  const snapshotRef = useRef<string | null>(null);
  routeRef.current = routeHref(selector);
  snapshotRef.current = initialResult.kind === "available" ? snapshotKey(initialResult.snapshot) : null;

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    return () => {
      mounted.current = false;
      generation.current += 1;
      pendingRef.current = false;
    };
  }, []);

  const snapshot = state.load.kind === "available" ? state.load.snapshot : null;
  const snapshotId = snapshot === null ? null : snapshotKey(snapshot);
  const snapshotExpiry = snapshot?.validUntil ?? null;
  const expired = snapshot !== null && now >= Date.parse(snapshot.validUntil);
  useEffect(() => {
    if (snapshotExpiry === null || snapshotId === null) return;
    const deadline = Date.parse(snapshotExpiry);
    const delay = Math.max(0, deadline - Date.now());
    const timer = window.setTimeout(() => {
      if (mounted.current && snapshotRef.current === snapshotId) {
        setNow(Date.now());
        if (!pendingRef.current) setMessage("This snapshot expired. Reload to verify current access and installation before continuing.");
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [snapshotExpiry, snapshotId]);

  useEffect(() => {
    if (state.command !== null) outcomeHeading.current?.focus();
  }, [state.command]);

  const install = async () => {
    if (!mounted.current || pendingRef.current || snapshot === null || expired ||
      snapshot.selected.releaseRevision <= snapshot.active.releaseRevision) return;
    pendingRef.current = true;
    setPending(true);
    setMessage("Checking current authority and installing the selected release.");
    const token = {
      generation: ++generation.current,
      route: routeRef.current,
      snapshot: snapshotRef.current,
    };
    const current = () => mounted.current && generation.current === token.generation &&
      routeRef.current === token.route && snapshotRef.current === token.snapshot;
    try {
      const returned = await installSelectedApplicationRelease(selector.organizationId, {
        kind: "application.release.install_selected",
        selector,
        expected: snapshot,
      });
      if (!current()) return;
      const parsed = studioApplicationInstallationCommandResultSchema.safeParse(returned);
      if (!parsed.success) {
        const failure = studioApplicationInstallationCommandResultSchema.parse({
          kind: "temporarily_unavailable",
          registrationMayHaveChanged: "unknown",
        });
        setState((previous) => ({ ...previous, command: failure }));
        setMessage(commandText(failure));
        return;
      }
      setState((previous) => ({ ...previous, command: parsed.data }));
      setMessage(commandText(parsed.data));
    } catch {
      if (!current()) return;
      const failure = studioApplicationInstallationCommandResultSchema.parse({
        kind: "temporarily_unavailable",
        registrationMayHaveChanged: "unknown",
      });
      setState((previous) => ({ ...previous, command: failure }));
      setMessage(commandText(failure));
    } finally {
      if (current()) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  };

  return <main className="mx-auto max-w-3xl space-y-6 p-6">
    <header className="space-y-3">
      <h1 className="text-2xl font-semibold">Review selected application upgrade</h1>
      <p>This page checks a published revision against your signed-in access and installed Module releases. It does not install on page load.</p>
      <nav aria-label="Installation navigation" className="flex flex-wrap gap-4">
        <a className="underline" href={historyHref(selector)}>Back to release history</a>
        <a className="underline" href={routeHref(selector)}>Reload current access and installation state</a>
      </nav>
    </header>
    <p role="status" aria-live="polite" aria-atomic="true">{message}</p>
    {snapshot === null ? <section className="space-y-3 rounded border p-4">
      <h2 className="text-lg font-semibold">Upgrade unavailable</h2>
      <p>{state.load.kind === "unavailable" ? unavailableText(state.load.reason)
        : state.load.kind === "refused" ? "Current application access is unavailable. Sign in with an account permitted to manage the application and reload."
          : "Current installation information is temporarily unavailable. Reload this page to try a fresh read."}</p>
    </section> : <>
      <section aria-label="Selected release and active installation" className="space-y-3 rounded border p-4">
        <dl className="space-y-2">
          <div><dt className="font-semibold">Application</dt><dd>{snapshot.definitionKey}</dd></div>
          <div><dt className="font-semibold">Organization</dt><dd className="break-all">{snapshot.organizationId}</dd></div>
          <div><dt className="font-semibold">Application root</dt><dd className="break-all">{snapshot.rootId}</dd></div>
          <div><dt className="font-semibold">Selected published release</dt><dd>Version {snapshot.selected.releaseVersion} · revision {snapshot.selected.releaseRevision}</dd></div>
          <div><dt className="font-semibold">Currently active release</dt><dd>Version {snapshot.active.releaseVersion} · revision {snapshot.active.releaseRevision}</dd></div>
          <div><dt className="font-semibold">Selected content fingerprint</dt><dd className="break-all"><code>{snapshot.selected.contentFingerprint}</code></dd></div>
          <div><dt className="font-semibold">Selected resolution fingerprint</dt><dd className="break-all"><code>{snapshot.selected.resolutionFingerprint}</code></dd></div>
        </dl>
        <p>This partial supports an explicit upgrade of an existing Application only when every Module release is unchanged. First installation, older releases and Module changes are unavailable here.</p>
      </section>
      {expired && <p className="rounded border p-3">This access snapshot expired. Reload before continuing.</p>}
      {state.command !== null && <section className="space-y-3 rounded border p-4">
        <h2 ref={outcomeHeading} tabIndex={-1} className="text-lg font-semibold">Upgrade outcome</h2>
        <p>{commandText(state.command)}</p>
        {state.command.kind === "completed" && <dl className="space-y-2">
          <div><dt className="font-semibold">Selected release</dt><dd>Revision {state.command.selected.releaseRevision}</dd></div>
          <div><dt className="font-semibold">Active at commit</dt><dd>Revision {state.command.activeAtCommitRevision}</dd></div>
          {state.command.outcome === "activated" && <div><dt className="font-semibold">Previously active</dt><dd>Revision {state.command.previousActiveRevision}</dd></div>}
          {state.command.postCommit.kind === "observed" && <div><dt className="font-semibold">Freshly observed active</dt><dd>Revision {state.command.postCommit.active.releaseRevision}</dd></div>}
        </dl>}
      </section>}
      <section aria-label="Confirm selected release upgrade" className="space-y-3 rounded border p-4">
        <h2 className="text-lg font-semibold">Confirm upgrade</h2>
        {snapshot.selected.releaseRevision === snapshot.active.releaseRevision
          ? <p>This selected release is already active. Reload to confirm its current state.</p>
          : <p>Continue only if you want to activate version {snapshot.selected.releaseVersion}, revision {snapshot.selected.releaseRevision} for this installed Application.</p>}
        <button type="button" name="application.release.install_selected"
          disabled={pending || expired || snapshot.selected.releaseRevision <= snapshot.active.releaseRevision || state.command !== null}
          aria-busy={pending}
          className="rounded border px-4 py-2 disabled:opacity-50"
          onClick={() => void install()}>
          {pending ? "Installing selected release…" : "Confirm upgrade to selected release"}
        </button>
      </section>
    </>}
  </main>;
}
