"use client";
import { Button } from "@vortex/ui/components/button";
import { TechnicalDetails } from "@vortex/ui/components/technical-details";

import { useEffect, useRef, useState } from "react";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import {
  studioApplicationFirstInstallCommandResultSchema,
  studioApplicationFirstInstallLoadResultSchema,
  type StudioApplicationFirstInstallCommandResult,
  type StudioApplicationFirstInstallLoadResult,
  type StudioApplicationFirstInstallSelector,
  type StudioApplicationFirstInstallSnapshot,
} from "../../_lib/studio-application-installation-contracts";
import {
  activateFirstInstall,
  prepareFirstInstall,
  reloadFirstInstall,
} from "../[organizationId]/[applicationRootId]/history/[releaseRevision]/first-install/actions";

type Props = Readonly<{
  selector: StudioApplicationFirstInstallSelector;
  initialResult: StudioApplicationFirstInstallLoadResult;
}>;

type PendingAction = "reload" | "prepare" | "activate";

const snapshotKey = (snapshot: StudioApplicationFirstInstallSnapshot): string => JSON.stringify(snapshot);
const historyHref = (selector: StudioApplicationFirstInstallSelector): string =>
  `/studio/${encodeURIComponent(selector.organizationId)}/${encodeURIComponent(selector.rootId)}/history`;
const routeHref = (selector: StudioApplicationFirstInstallSelector): string =>
  `/studio/${encodeURIComponent(selector.organizationId)}/${encodeURIComponent(selector.rootId)}/history/${selector.releaseRevision}/first-install`;

const loadMessage = (result: StudioApplicationFirstInstallLoadResult): string => {
  if (result.kind === "available") {
    switch (result.snapshot.registrationState) {
      case "unprepared": return "The exact published release and current first-install access were checked.";
      case "registration_aligned_partial": return "Registration is aligned, but preparation is incomplete. Reload before continuing after any uncertain outcome.";
      case "provisioned_inactive": return "The exact release is prepared but inactive. Activate it explicitly.";
      case "active_exact": return "The exact selected release is active.";
    }
  }
  if (result.kind === "unavailable") {
    switch (result.reason) {
      case "release_not_published": return "This version is not currently published.";
      case "already_installed": return "This application already has an installed release. Use its upgrade flow.";
      case "installation_incomplete": return "The installation bindings are mixed or incomplete and cannot be safely continued here.";
      case "setup_unavailable": return "The exact release cannot be installed by this first-install flow.";
      case "unsupported_root": return "The selected application root is not supported for this first-install flow.";
    }
  }
  return result.kind === "conflict"
    ? "The current draft, selected release, or installation changed. Reload before continuing."
    : result.kind === "refused"
      ? "Current HUMAN access or first-install eligibility could not be confirmed."
      : "First-install information is temporarily unavailable.";
};

type MemberRoleRefusal = NonNullable<
  Extract<StudioApplicationFirstInstallCommandResult, { memberRoleRefusal?: unknown }>["memberRoleRefusal"]
>;

/** Each refusal of the member role says what is missing or what happened, in plain words. */
const memberRoleRefusalMessage: Readonly<Record<MemberRoleRefusal, string>> = {
  installation_authority: "Installing needs the Manage applications permission and delegated management of the organisation's permissions; ask your organisation steward.",
  member_role_delegation: "Installing with the member role needs delegated management of every permission the role gives; ask your organisation steward.",
  roles_manage: "Installing with the member role needs the Manage roles permission; ask your organisation steward, or install without accepting the role.",
  assignments_manage: "Installing with the member role needs the Manage access assignments permission; ask your organisation steward, or install without accepting the role.",
  role_unavailable: "This application's member role was retired or is waiting for acceptance in access administration; ask your organisation steward, or install without accepting the role.",
  access_changed: "Someone else changed access at the same time; try again.",
};

const commandMessage = (result: StudioApplicationFirstInstallCommandResult): string => {
  if (result.kind !== "completed") {
    if (result.kind === "conflict") return "The current release or setup changed. Reload before taking another action.";
    if (result.kind === "authentication_required")
      return "Sign in again to install. Accepting the member role needs a sign-in within the last 15 minutes.";
    if (result.memberRoleRefusal !== undefined) return memberRoleRefusalMessage[result.memberRoleRefusal];
    if (result.kind === "refused")
      return "Current HUMAN permission or eligibility could not be confirmed. Reload to inspect current access.";
    if (result.stateMayHaveChanged === "unknown")
      return "The outcome could not be confirmed. Reload the protected setup before doing anything else; do not repeat the command automatically.";
    return "The command could not be completed. Reload current protected setup before continuing.";
  }
  if (result.action === "prepared")
    return "Preparation completed. The page is reloading the protected installation.";
  if (!("postCommit" in result))
    return "The command completed. Reload the protected installation before continuing.";
  if (result.action === "activated")
    return result.postCommit.kind === "observed"
      ? "The application is switched on. Open it from the launcher."
      : "The application was switched on, but its state could not be read back. Reload to confirm.";
  return result.postCommit.kind === "observed"
    ? "This version was already switched on."
    : "Activation returned unchanged, but its fresh observation was unavailable. Reload before continuing.";
};

const observedLoad = async (
  selector: StudioApplicationFirstInstallSelector,
): Promise<StudioApplicationFirstInstallLoadResult> => {
  const result = await reloadFirstInstall(selector.organizationId, selector);
  const parsed = studioApplicationFirstInstallLoadResultSchema.safeParse(result);
  if (!parsed.success) return { kind: "temporarily_unavailable" };
  return parsed.data;
};

export function ApplicationFirstInstallation({ selector, initialResult }: Props) {
  const [confirm, confirmDialog] = useConfirm();
  const [load, setLoad] = useState<StudioApplicationFirstInstallLoadResult>(initialResult);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [message, setMessage] = useState(loadMessage(initialResult));
  const [commandResult, setCommandResult] = useState<StudioApplicationFirstInstallCommandResult | null>(null);
  const [acceptMemberRole, setAcceptMemberRole] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pendingRef = useRef<PendingAction | null>(null);
  const currentRoute = useRef(routeHref(selector));
  const currentSnapshot = useRef<string | null>(initialResult.kind === "available"
    ? snapshotKey(initialResult.snapshot) : null);
  currentRoute.current = routeHref(selector);
  currentSnapshot.current = load.kind === "available" ? snapshotKey(load.snapshot) : null;

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    return () => {
      mounted.current = false;
      generation.current += 1;
      pendingRef.current = null;
    };
  }, []);

  const begin = (action: PendingAction) => {
    if (!mounted.current || pendingRef.current !== null || needsReload) return null;
    const token = {
      generation: ++generation.current,
      route: currentRoute.current,
      snapshot: currentSnapshot.current,
    };
    pendingRef.current = action;
    setPending(action);
    return {
      current: () => mounted.current && generation.current === token.generation &&
        currentRoute.current === token.route && currentSnapshot.current === token.snapshot,
      finish: () => {
        if (mounted.current && generation.current === token.generation &&
          currentRoute.current === token.route) {
          pendingRef.current = null;
          setPending(null);
        }
      },
    };
  };

  const applyReload = async (keepCommand = false): Promise<boolean> => {
    if (!mounted.current || pendingRef.current !== null) return false;
    const token = {
      generation: ++generation.current,
      route: currentRoute.current,
      snapshot: currentSnapshot.current,
    };
    pendingRef.current = "reload";
    setPending("reload");
    setMessage("Reloading exact release, HUMAN access, installation bindings, and current setup.");
    try {
      const next = await observedLoad(selector);
      if (!mounted.current || generation.current !== token.generation ||
        currentRoute.current !== token.route || currentSnapshot.current !== token.snapshot) return false;
      setLoad(next);
      currentSnapshot.current = next.kind === "available" ? snapshotKey(next.snapshot) : null;
      setNeedsReload(next.kind !== "available");
      if (!keepCommand) setCommandResult(null);
      setMessage(loadMessage(next));
      return next.kind === "available";
    } catch {
      if (mounted.current && generation.current === token.generation && currentRoute.current === token.route) {
        setNeedsReload(true);
        setMessage("Reload was unavailable. Do not repeat a command with an uncertain outcome.");
      }
      return false;
    } finally {
      if (mounted.current && generation.current === token.generation && currentRoute.current === token.route) {
        pendingRef.current = null;
        setPending(null);
      }
    }
  };

  const settleCommand = async (
    action: "prepare" | "activate",
    request: () => Promise<unknown>,
  ) => {
    if (load.kind !== "available") return;
    const token = begin(action);
    if (token === null) return;
    setCommandResult(null);
    setMessage(action === "prepare"
      ? "Preparing the exact published release. Registration and inactive storage can commit in separate transactions."
      : "Activating the exact prepared release.");
    try {
      const response = await request();
      if (!token.current()) return;
      const parsed = studioApplicationFirstInstallCommandResultSchema.safeParse(response);
      if (!parsed.success) {
        setNeedsReload(true);
        setMessage("The server response could not be verified. Reload protected setup before any further action.");
        return;
      }
      setCommandResult(parsed.data);
      setMessage(commandMessage(parsed.data));
      if (parsed.data.kind !== "completed") {
        setNeedsReload(true);
        return;
      }
      if (parsed.data.action === "activated" || parsed.data.action === "unchanged")
        setNeedsReload(true);
      if (parsed.data.action === "prepared") {
        token.finish();
        await applyReload(true);
      }
    } catch {
      if (!token.current()) return;
      setNeedsReload(true);
      setMessage("The command outcome is uncertain. Reload protected setup before doing anything else; do not repeat it automatically.");
    } finally {
      token.finish();
    }
  };

  const reload = async () => { await applyReload(false); };

  const prepare = async () => {
    if (load.kind !== "available") return;
    if (!await confirm({
      title: `Prepare revision ${load.snapshot.selected.releaseRevision} for first installation?`,
      description: `Prepare published ${load.snapshot.selected.releaseVersion}, revision ${load.snapshot.selected.releaseRevision} for first installation? This aligns registration and provisions inactive Modules; it does not activate the application.`,
      confirmLabel: "Prepare",
    })) return;
    await settleCommand("prepare", () => prepareFirstInstall(selector.organizationId, {
      kind: "application.first_install.prepare", selector, expected: load.snapshot,
    }));
  };

  const activate = async () => {
    if (load.kind !== "available" || pending !== null || needsReload) return;
    const memberRole = load.snapshot.memberRole;
    if (!await confirm({
      title: `Activate revision ${load.snapshot.selected.releaseRevision} now?`,
      description: `Activate ${load.snapshot.selected.releaseVersion}, revision ${load.snapshot.selected.releaseRevision} now? This will make the exact prepared Application and Module set active.${acceptMemberRole
        ? ` You will hold the ${memberRole.name} role and its ${memberRole.permissions.length} permissions.`
        : " You will not hold any of its roles until an administrator assigns one."}`,
      confirmLabel: "Activate",
      destructive: true,
    })) return;
    await settleCommand("activate", () => activateFirstInstall(selector.organizationId, {
      kind: "application.first_install.activate",
      selector,
      expected: load.snapshot,
      memberRole: acceptMemberRole
        ? { kind: "accept", sourceRoleId: memberRole.sourceRoleId }
        : { kind: "decline" },
    }));
  };

  const snapshot = load.kind === "available" ? load.snapshot : null;
  const isPending = pending !== null;
  const available = snapshot !== null && !needsReload;
  const mutationBlocked = !available || isPending || needsReload;
  return <main className="mx-auto max-w-5xl space-y-6 p-6">
    <header className="space-y-3">
      <h1 className="text-2xl font-semibold">Review first installation of a published release</h1>
      <p>This page checks the exact saved draft and published release with your signed-in access. Nothing is prepared or activated automatically.</p>
      <nav aria-label="First-install navigation" className="flex flex-wrap gap-4">
        <a className="underline" href={historyHref(selector)}>Back to release history</a>
        <a className="underline" href={routeHref(selector)}>Reload this exact first-install page</a>
      </nav>
    </header>
    <p role="status" aria-live="polite" aria-atomic="true">{message}</p>
    {needsReload && <section className="rounded-xl border bg-card text-card-foreground p-4">
      <h2 className="font-semibold">Protected reload required</h2>
      <p>The previous action or current authority is stale or uncertain. Use a read-only reload before deciding what to do next.</p>
      <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => void reload()}>
        Reload
      </Button>
    </section>}
    {snapshot === null ? <section className="space-y-3 rounded-xl border bg-card text-card-foreground p-4">
      <h2 className="text-lg font-semibold">First install unavailable</h2>
      <p>{loadMessage(load)}</p>
      {!needsReload && <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => void reload()}>
        Reload
      </Button>}
    </section> : <>
      <section aria-label="Exact published release" className="space-y-3 rounded-xl border bg-card text-card-foreground p-4">
        <dl className="space-y-2">
          <div><dt className="font-semibold">Published version</dt><dd>{snapshot.selected.releaseVersion}</dd></div>
        </dl>
        <TechnicalDetails><dl className="space-y-2">
          <div><dt className="font-semibold">Application technical name</dt><dd>{snapshot.selected.definitionKey}</dd></div>
          <div><dt className="font-semibold">Release revision</dt><dd>{snapshot.selected.releaseRevision}</dd></div>
          <div><dt className="font-semibold">Validation contract</dt><dd>{snapshot.selected.validationContractVersion}</dd></div>
          <div><dt className="font-semibold">Registration state</dt><dd>{snapshot.registrationState.replaceAll("_", " ")}</dd></div>
          <div><dt className="font-semibold">Organization</dt><dd className="break-all">{snapshot.organizationId}</dd></div>
          <div><dt className="font-semibold">Application root</dt><dd className="break-all">{snapshot.rootId}</dd></div>
          <div><dt className="font-semibold">Selected content fingerprint</dt><dd className="break-all"><code>{snapshot.selected.contentFingerprint}</code></dd></div>
          <div><dt className="font-semibold">Selected resolution fingerprint</dt><dd className="break-all"><code>{snapshot.selected.resolutionFingerprint}</code></dd></div>
        </dl></TechnicalDetails>
        <p>This installs exactly the version shown above.</p>
      </section>

      {snapshot.registrationState === "unprepared" || snapshot.registrationState === "registration_aligned_partial"
        ? <section aria-label="Prepare exact first installation" className="space-y-3 rounded-xl border bg-card text-card-foreground p-4">
          <h2 className="text-lg font-semibold">Prepare the installation</h2>
          <p>Preparing registers the application and sets up its modules. It does not switch the application on. If the result is unclear, reload instead of preparing again.</p>
          <Button type="button" variant="outline" size="sm" name="application.first_install.prepare" disabled={mutationBlocked}
            aria-busy={pending === "prepare"}
            onClick={() => void prepare()}>
            {pending === "prepare" ? "Preparing…" : "Prepare this version"}
          </Button>
        </section>
        : null}

      {snapshot.registrationState === "provisioned_inactive" &&
        <section aria-label="Explicit activation" className="space-y-3 rounded-xl border bg-card text-card-foreground p-4">
          <h2 className="text-lg font-semibold">Activate the prepared release</h2>
          <p>Activation is a separate, explicit operation for this exact Application and Module release set. Each record type starts with the default lifecycle policy: deleted records can be recovered for 30 days, with no automatic age or count limit.</p>
          <fieldset aria-label="Member role" className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 font-semibold">Member role: {snapshot.memberRole.name}</legend>
            <p>Accept this role to use the application straight away. It gives you these permissions{snapshot.memberRole.privileged ? ", including administrative ones" : ""}:</p>
            <ul className="list-disc space-y-1 pl-6">
              {snapshot.memberRole.permissions.map((permission) => <li key={permission.key}>{permission.label}</li>)}
            </ul>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="application.first_install.accept_member_role"
                checked={acceptMemberRole} disabled={mutationBlocked}
                onChange={(event) => setAcceptMemberRole(event.target.checked)} />
              <span>Accept the {snapshot.memberRole.name} role for myself</span>
            </label>
            <p className="text-muted-foreground text-sm">Accepting needs permission to manage roles and assignments, and a sign-in within the last 15 minutes.</p>
          </fieldset>
          <Button type="button" variant="outline" size="sm" name="application.first_install.activate" disabled={mutationBlocked}
            aria-busy={pending === "activate"}
            onClick={() => void activate()}>
            {pending === "activate" ? "Activating exact release…" : "Confirm activation"}
          </Button>
        </section>}

      {snapshot.registrationState === "active_exact" && <section className="rounded-xl border bg-card text-card-foreground p-4">
        <h2 className="font-semibold">This exact release is already active</h2>
        <p>No first-install action remains for this selected release. Use the protected reload link to inspect current state.</p>
      </section>}
      {commandResult !== null && <section className="rounded-xl border bg-card text-card-foreground p-4">
        <h2 className="font-semibold">Latest command result</h2>
        <p>{commandMessage(commandResult)}</p>
      </section>}
    </>}
    {confirmDialog}
  </main>;
}
