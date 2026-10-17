"use client";
import { Button } from "@vortex/ui/components/button";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { TechnicalDetails } from "@vortex/ui/components/technical-details";

import { useEffect, useRef, useState } from "react";
import {
  studioApplicationInstallationCommandResultSchema,
  studioApplicationInstallationLoadResultSchema,
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
      return "This version is not newer than the one in use.";
    case "module_set_changed":
      return "This version adds or removes modules. Only upgrades that keep the same modules can be done here.";
    case "installation_incomplete":
      return "The current installation is incomplete or cannot be safely brought up to date.";
    case "registration_misaligned":
      return "The current installation does not match the version it says it uses.";
    default:
      return "This upgrade is unavailable for the selected application.";
  }
};

const commandText = (result: StudioApplicationInstallationCommandResult): string => {
  if (result.kind === "completed") {
    if (result.outcome === "unchanged")
      return result.registrationMayHaveChanged
        ? "This version is in use. Its access settings may have been brought up to date; reload to confirm."
        : "This version was already in use. Nothing was changed.";
    const observed = result.postCommit.kind === "observed"
      ? result.postCommit.active.releaseRevision === result.activeAtCommitRevision
        ? ""
        : " Another upgrade may have followed this one."
      : " The upgrade completed, but the current state could not be read back. Reload to confirm.";
    return `The upgrade is done.${observed}`;
  }
  switch (result.kind) {
    case "conflict":
      return "The installation or the selected version changed. The page now shows the current state; review it before continuing.";
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
  const [confirm, confirmDialog] = useConfirm();
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
  const roleRevisions = state.load.kind === "available" ? state.load.roleRevisions : null;
  const listedRoles = roleRevisions?.kind === "listed" ? roleRevisions.roles : [];
  const releaseNote = state.load.kind === "available" ? state.load.releaseNote : null;
  const snapshotId = snapshot === null ? null : snapshotKey(snapshot);
  const snapshotExpiry = snapshot?.validUntil ?? null;
  const expired = snapshot !== null && now >= Date.parse(snapshot.validUntil);
  useEffect(() => {
    if (snapshotExpiry === null || snapshotId === null) return;
    const deadline = Date.parse(snapshotExpiry);
    const delay = Math.max(0, deadline - Date.now());
    const timer = window.setTimeout(() => {
      if (mounted.current) {
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
    // The same shared confirmation as a first install: the version change, what is new, and the
    // roles it changes, with one explicit choice to accept them in the same step.
    let acceptRoles = false;
    const confirmed = await confirm({
      title: `Upgrade to version ${snapshot.selected.releaseVersion}?`,
      description: `The application moves from version ${snapshot.active.releaseVersion} to ${snapshot.selected.releaseVersion}.`,
      details: <>
        {releaseNote !== null && <p><span className="font-medium">What&apos;s new:</span> {releaseNote}</p>}
        {listedRoles.length > 0 && <>
          <p>These roles change. Until a change is accepted, people in the role keep exactly the access they have now.</p>
          <ul className="list-disc space-y-1 pl-5">
            {listedRoles.map((role) => <li key={role.roleId}><span className="font-medium">{role.label}</span>: {role.changes.join("; ")}</li>)}
          </ul>
        </>}
        {roleRevisions?.kind === "unavailable" && <p>The roles this version changes could not be read with your access. People keep the access they have; accept role changes in role administration.</p>}
      </>,
      ...(listedRoles.length > 0
        ? { choice: { label: "Accept for these roles", onChange: (checked: boolean) => { acceptRoles = checked; } } }
        : {}),
      confirmLabel: "Upgrade",
    });
    if (!confirmed || !mounted.current || pendingRef.current) return;
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
        acceptRoleIds: acceptRoles ? listedRoles.map((role) => role.roleId) : [],
      });
      if (!current()) return;
      const parsed = studioApplicationInstallationCommandResultSchema.safeParse(returned.command);
      const reloaded = studioApplicationInstallationLoadResultSchema.safeParse(returned.load);
      if (!parsed.success || !reloaded.success) {
        const failure = studioApplicationInstallationCommandResultSchema.parse({
          kind: "temporarily_unavailable",
          registrationMayHaveChanged: "unknown",
        });
        setState((previous) => ({ ...previous, command: failure }));
        setMessage(commandText(failure));
        return;
      }
      setState({ load: reloaded.data, command: parsed.data });
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
      <p>This page checks the selected published version against your access and the modules installed in this organization. Nothing is installed until you confirm.</p>
      <nav aria-label="Installation navigation" className="flex flex-wrap gap-4">
        <a className="underline" href={historyHref(selector)}>Back to published versions</a>
        <a className="underline" href={routeHref(selector)}>Reload</a>
      </nav>
    </header>
    <p role="status" aria-live="polite" aria-atomic="true">{message}</p>
    {snapshot === null ? <section className="space-y-3 rounded-xl border bg-card text-card-foreground p-4">
      <h2 className="text-lg font-semibold">Upgrade unavailable</h2>
      <p>{state.load.kind === "unavailable" ? unavailableText(state.load.reason)
        : state.load.kind === "refused" ? "Current application access is unavailable. Sign in with an account permitted to manage the application and reload."
          : "Current installation information is temporarily unavailable. Reload this page to try a fresh read."}</p>
    </section> : <>
      <section aria-label="Selected release and active installation" className="space-y-3 rounded-xl border bg-card text-card-foreground p-4">
        <dl className="space-y-2">
          <div><dt className="font-semibold">Selected version</dt><dd>{snapshot.selected.releaseVersion}</dd></div>
          <div><dt className="font-semibold">Version in use now</dt><dd>{snapshot.active.releaseVersion}</dd></div>
        </dl>
        <TechnicalDetails><dl className="space-y-2">
          <div><dt className="font-semibold">Application technical name</dt><dd>{snapshot.definitionKey}</dd></div>
          <div><dt className="font-semibold">Selected release revision</dt><dd>{snapshot.selected.releaseRevision}</dd></div>
          <div><dt className="font-semibold">Active release revision</dt><dd>{snapshot.active.releaseRevision}</dd></div>
          <div><dt className="font-semibold">Organization</dt><dd className="break-all">{snapshot.organizationId}</dd></div>
          <div><dt className="font-semibold">Application root</dt><dd className="break-all">{snapshot.rootId}</dd></div>
          <div><dt className="font-semibold">Selected content fingerprint</dt><dd className="break-all"><code>{snapshot.selected.contentFingerprint}</code></dd></div>
          <div><dt className="font-semibold">Selected resolution fingerprint</dt><dd className="break-all"><code>{snapshot.selected.resolutionFingerprint}</code></dd></div>
        </dl></TechnicalDetails>
        <p>This page upgrades an application that is already installed, to a version that keeps the same modules. First installs, older versions and adding or removing modules are not available here.</p>
      </section>
      {expired && <p className="rounded-xl border bg-card text-card-foreground p-3">Your access was checked a while ago. Reload before continuing.</p>}
      {snapshot.selected.releaseRevision > snapshot.active.releaseRevision && roleRevisions !== null &&
        <section aria-label="Role changes in this version" className="space-y-3 rounded-xl border bg-card text-card-foreground p-4">
          <h2 className="text-lg font-semibold">Role changes</h2>
          {roleRevisions.kind === "unavailable"
            ? <p>The roles this version changes could not be read with your access. People keep the access they have; accept role changes in role administration.</p>
            : listedRoles.length === 0
              ? <p>This version changes no role. People keep the access they have.</p>
              : <>
                <p>These roles change in this version. Until a change is accepted, people in the role keep exactly the access they have now. You can accept the changes when you confirm the upgrade, or later in role administration.</p>
                <ul className="list-disc space-y-1 pl-5">
                  {listedRoles.map((role) => <li key={role.roleId}><span className="font-medium">{role.label}</span>: {role.changes.join("; ")}</li>)}
                </ul>
              </>}
        </section>}
      {state.command !== null && <section className="space-y-3 rounded-xl border bg-card text-card-foreground p-4">
        <h2 ref={outcomeHeading} tabIndex={-1} className="text-lg font-semibold">Result</h2>
        <p>{commandText(state.command)}</p>
        {state.command.kind === "completed" && state.command.acceptedRoleIds.length > 0 &&
          <p>Role changes accepted with the upgrade: {state.command.acceptedRoleIds.length}.</p>}
        {state.command.kind === "completed" && <TechnicalDetails><dl className="space-y-2">
          <div><dt className="font-semibold">Selected release revision</dt><dd>{state.command.selected.releaseRevision}</dd></div>
          <div><dt className="font-semibold">Active at commit</dt><dd>{state.command.activeAtCommitRevision}</dd></div>
          {state.command.outcome === "activated" && <div><dt className="font-semibold">Previously active</dt><dd>{state.command.previousActiveRevision}</dd></div>}
          {state.command.postCommit.kind === "observed" && <div><dt className="font-semibold">Freshly observed active</dt><dd>{state.command.postCommit.active.releaseRevision}</dd></div>}
        </dl></TechnicalDetails>}
      </section>}
      <section aria-label="Confirm selected release upgrade" className="space-y-3 rounded-xl border bg-card text-card-foreground p-4">
        <h2 className="text-lg font-semibold">Confirm upgrade</h2>
        {snapshot.selected.releaseRevision === snapshot.active.releaseRevision
          ? <p>This version is already in use. Reload to confirm.</p>
          : <p>Continue only if you want this installed application to start using version {snapshot.selected.releaseVersion}.</p>}
        <Button type="button" variant="outline" size="sm" name="application.release.install_selected"
          disabled={pending || expired || snapshot.selected.releaseRevision <= snapshot.active.releaseRevision}
          aria-busy={pending}
         
          onClick={() => void install()}>
          {pending ? "Upgrading…" : "Upgrade to this version"}
        </Button>
      </section>
    </>}
    {confirmDialog}
  </main>;
}
