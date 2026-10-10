"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  studioApplicationArchiveOptionsResultSchema,
  studioApplicationFirstInstallCommandResultSchema,
  studioApplicationFirstInstallLoadResultSchema,
  type StudioApplicationArchiveOptionsResult,
  type StudioApplicationFirstInstallCommandResult,
  type StudioApplicationFirstInstallLoadResult,
  type StudioApplicationFirstInstallSelector,
  type StudioApplicationFirstInstallSnapshot,
} from "../../_lib/studio-application-installation-contracts";
import {
  activateFirstInstall,
  prepareFirstInstall,
  readFirstInstallArchiveOptions,
  reloadFirstInstall,
  saveFirstInstallPolicy,
} from "../[organizationId]/[applicationRootId]/history/[releaseRevision]/first-install/actions";

type Props = Readonly<{
  selector: StudioApplicationFirstInstallSelector;
  initialResult: StudioApplicationFirstInstallLoadResult;
}>;

type PolicyDraft = Readonly<{
  action: "delete" | "archive_workflow";
  maxAgeDays: string;
  maxCount: string;
  allowUnlimitedAge: boolean;
  allowUnlimitedCount: boolean;
  recoveryWindowDays: string;
  archiveWorkflowId: string;
  archiveConnectionInstanceId: string;
}>;

type ArchiveOption = Extract<StudioApplicationArchiveOptionsResult, { kind: "available" }>["options"][number];
type FirstInstallTarget = NonNullable<StudioApplicationFirstInstallSnapshot["setup"]>["targets"][number];
type ArchivePageState = Readonly<{
  options: readonly ArchiveOption[];
  nextAfterConnectionInstanceId: string | null;
  loading: boolean;
  message: string;
}>;

type PendingAction = "reload" | "prepare" | "policy_saved" | "activate" | "options";

const snapshotKey = (snapshot: StudioApplicationFirstInstallSnapshot): string => JSON.stringify(snapshot);
const historyHref = (selector: StudioApplicationFirstInstallSelector): string =>
  `/studio/${encodeURIComponent(selector.organizationId)}/${encodeURIComponent(selector.rootId)}/history`;
const routeHref = (selector: StudioApplicationFirstInstallSelector): string =>
  `/studio/${encodeURIComponent(selector.organizationId)}/${encodeURIComponent(selector.rootId)}/history/${selector.releaseRevision}/first-install`;

const positiveInteger = (value: string): number | null => {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const defaultDraft = (
  snapshot: StudioApplicationFirstInstallSnapshot,
  target?: FirstInstallTarget,
): PolicyDraft => ({
  action: snapshot.setup?.organizationLimits.allowedActions.includes("delete") ||
    target?.storageScope === "organization_shared"
    ? "delete" : "archive_workflow",
  maxAgeDays: "",
  maxCount: "",
  allowUnlimitedAge: false,
  allowUnlimitedCount: false,
  recoveryWindowDays: "",
  archiveWorkflowId: snapshot.workflows[0] ?? "",
  archiveConnectionInstanceId: "",
});

const targetAllowedActions = (
  snapshot: StudioApplicationFirstInstallSnapshot,
  target: FirstInstallTarget,
): readonly ("delete" | "archive_workflow")[] => {
  const limits = snapshot.setup?.organizationLimits;
  if (limits === undefined) return [];
  return limits.allowedActions.filter((action) => action === "delete" || (
    action === "archive_workflow" && target.storageScope === "application_contained" &&
    target.applicationRootId !== null && snapshot.workflows.length > 0 &&
    limits.allowedArchiveDestinations.length > 0
  ));
};

const loadMessage = (result: StudioApplicationFirstInstallLoadResult): string => {
  if (result.kind === "available") {
    switch (result.snapshot.registrationState) {
      case "unprepared": return "The exact published release and current first-install access were checked.";
      case "registration_aligned_partial": return "Registration is aligned, but preparation is incomplete. Reload before continuing after any uncertain outcome.";
      case "provisioned_inactive": return "The exact release is prepared but inactive. Configure each target, then activate explicitly.";
      case "active_exact": return "The exact selected release is active.";
    }
  }
  if (result.kind === "unavailable") {
    switch (result.reason) {
      case "release_not_published": return "This exact revision is not currently available as a published release.";
      case "already_installed": return "This application already has an installed release. Use its upgrade flow.";
      case "installation_incomplete": return "The installation bindings are mixed or incomplete and cannot be safely continued here.";
      case "setup_unavailable": return "The exact release has no supported complete record-policy setup target.";
      case "unsupported_root": return "The selected application root is not supported for this first-install flow.";
    }
  }
  return result.kind === "conflict"
    ? "The current draft, selected release, or installation changed. Reload before continuing."
    : result.kind === "refused"
      ? "Current HUMAN access or first-install eligibility could not be confirmed."
      : "First-install information is temporarily unavailable.";
};

const commandMessage = (result: StudioApplicationFirstInstallCommandResult): string => {
  if (result.kind !== "completed") {
    if (result.kind === "conflict") return "The current release or setup changed. Reload before taking another action.";
    if (result.kind === "refused" || result.kind === "authentication_required")
      return "Current HUMAN permission or eligibility could not be confirmed. Reload to inspect current access.";
    if (result.stateMayHaveChanged === "unknown")
      return "The outcome could not be confirmed. Reload the protected setup before doing anything else; do not repeat the command automatically.";
    return "The command could not be completed. Reload current protected setup before continuing.";
  }
  if (result.action === "prepared")
    return "Preparation completed. The page is reloading the protected installation and policy setup.";
  if (result.action === "policy_saved")
    return "The initial policy was saved. The page is reloading its current protected state.";
  if (!("postCommit" in result))
    return "The command completed. Reload the protected installation before continuing.";
  if (result.action === "activated")
    return result.postCommit.kind === "observed"
      ? `Activation committed at revision ${result.activeAtCommitRevision}; a fresh read observed revision ${result.postCommit.activeReleaseRevision}.`
      : `Activation committed at revision ${result.activeAtCommitRevision}, but a fresh read was unavailable. Reload before continuing.`;
  return result.postCommit.kind === "observed"
    ? `The selected release was already active at commit. A fresh read observed revision ${result.postCommit.activeReleaseRevision}.`
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
  const [load, setLoad] = useState<StudioApplicationFirstInstallLoadResult>(initialResult);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [message, setMessage] = useState(loadMessage(initialResult));
  const [commandResult, setCommandResult] = useState<StudioApplicationFirstInstallCommandResult | null>(null);
  const [drafts, setDrafts] = useState<Record<string, PolicyDraft>>({});
  const [archivePages, setArchivePages] = useState<Record<string, ArchivePageState>>({});
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
      setDrafts({});
      setArchivePages({});
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
    action: "prepare" | "policy_saved" | "activate",
    request: () => Promise<unknown>,
  ) => {
    if (load.kind !== "available") return;
    const token = begin(action);
    if (token === null) return;
    setCommandResult(null);
    setMessage(action === "prepare"
      ? "Preparing the exact published release. Registration and inactive storage can commit in separate transactions."
      : action === "policy_saved"
        ? "Saving the initial policy under the current provisioned setup."
        : "Activating the exact prepared release after all initial policies are configured.");
    try {
      const response = await request();
      if (!token.current()) return;
      const parsed = studioApplicationFirstInstallCommandResultSchema.safeParse(response);
      if (!parsed.success) {
        setNeedsReload(true);
        setDrafts({});
        setArchivePages({});
        setMessage("The server response could not be verified. Reload protected setup before any further action.");
        return;
      }
      setCommandResult(parsed.data);
      setMessage(commandMessage(parsed.data));
      if (parsed.data.kind !== "completed") {
        setNeedsReload(true);
        setDrafts({});
        setArchivePages({});
        return;
      }
      if (parsed.data.action === "activated" || parsed.data.action === "unchanged")
        setNeedsReload(true);
      if (parsed.data.action === "prepared" || parsed.data.action === "policy_saved") {
        token.finish();
        await applyReload(true);
      }
    } catch {
      if (!token.current()) return;
      setNeedsReload(true);
      setDrafts({});
      setArchivePages({});
      setMessage("The command outcome is uncertain. Reload protected setup before doing anything else; do not repeat it automatically.");
    } finally {
      token.finish();
    }
  };

  const reload = async () => { await applyReload(false); };

  const prepare = async () => {
    if (load.kind !== "available") return;
    if (!window.confirm(
      `Prepare published ${load.snapshot.selected.releaseVersion}, revision ${load.snapshot.selected.releaseRevision} for first installation? This aligns registration and provisions inactive Modules; it does not activate the application.`,
    )) return;
    await settleCommand("prepare", () => prepareFirstInstall(selector.organizationId, {
      kind: "application.first_install.prepare", selector, expected: load.snapshot,
    }));
  };

  const loadOptions = async (targetId: string, after?: string) => {
    if (load.kind !== "available" || load.snapshot.setup === null) return;
    const token = begin("options");
    if (token === null) return;
    setArchivePages((previous) => ({
      ...previous,
      [targetId]: { ...(previous[targetId] ?? { options: [], nextAfterConnectionInstanceId: null, loading: false, message: "" }), loading: true, message: "Loading current eligible Connections." },
    }));
    try {
      const raw = await readFirstInstallArchiveOptions(selector.organizationId, {
        kind: "application.first_install.archive_options",
        selector,
        expected: load.snapshot,
        storageContractId: targetId,
        ...(after === undefined ? {} : { afterConnectionInstanceId: after }),
      });
      if (!token.current()) return;
      const parsed = studioApplicationArchiveOptionsResultSchema.safeParse(raw);
      if (!parsed.success) {
        setArchivePages((previous) => ({
          ...previous,
          [targetId]: {
            ...(previous[targetId] ?? { options: [], nextAfterConnectionInstanceId: null, loading: false, message: "" }),
            loading: false,
            message: "Eligible Connections could not be loaded. Retry this read or reload the page.",
          },
        }));
        return;
      }
      if (parsed.data.kind !== "available") {
        if (parsed.data.kind === "conflict" || parsed.data.kind === "refused") {
          setNeedsReload(true);
          setDrafts({});
          setArchivePages({});
        }
        setArchivePages((previous) => ({
          ...previous,
          [targetId]: {
            ...(previous[targetId] ?? { options: [], nextAfterConnectionInstanceId: null, loading: false, message: "" }),
            loading: false,
            message: !parsed.success || parsed.data.kind === "temporarily_unavailable"
              ? "Eligible Connections could not be loaded. Retry this read or reload the page."
              : "Current permission or setup changed. Reload protected setup.",
          },
        }));
        return;
      }
      const available = parsed.data;
      const existing = after === undefined ? [] : archivePages[targetId]?.options ?? [];
      const options = [...existing, ...available.options];
      if (new Set(options.map((option) => option.connectionInstanceId.toLowerCase())).size !== options.length) {
        setNeedsReload(true);
        setDrafts({});
        setArchivePages({});
        setMessage("The eligible Connection pages were inconsistent. Reload protected setup.");
        return;
      }
      setArchivePages((previous) => ({
        ...previous,
        [targetId]: {
          options,
          nextAfterConnectionInstanceId: available.nextAfterConnectionInstanceId ?? null,
          loading: false,
          message: options.length === 0 ? "No eligible Connection is available on this page." : "Eligible Connections loaded.",
        },
      }));
    } catch {
      if (token.current()) setArchivePages((previous) => ({
        ...previous,
        [targetId]: {
          ...(previous[targetId] ?? { options: [], nextAfterConnectionInstanceId: null, loading: false, message: "" }),
          loading: false,
          message: "Eligible Connections could not be loaded. Reload or retry this read.",
        },
      }));
    } finally {
      token.finish();
    }
  };

  const updateDraft = (targetId: string, update: Partial<PolicyDraft>, snapshot: StudioApplicationFirstInstallSnapshot) => {
    setDrafts((previous) => ({
      ...previous,
      [targetId]: { ...(previous[targetId] ?? defaultDraft(snapshot)), ...update },
    }));
  };

  const savePolicy = async (
    event: FormEvent<HTMLFormElement>,
    targetId: string,
    draft: PolicyDraft,
    snapshot: StudioApplicationFirstInstallSnapshot,
  ) => {
    event.preventDefault();
    if (pending !== null || needsReload || snapshot.setup === null) return;
    const maxAgeDays = draft.allowUnlimitedAge ? null : positiveInteger(draft.maxAgeDays);
    const maxCount = draft.allowUnlimitedCount ? null : positiveInteger(draft.maxCount);
    if ((!draft.allowUnlimitedAge && maxAgeDays === null) || (!draft.allowUnlimitedCount && maxCount === null)) {
      setMessage("Enter a positive whole-number limit or explicitly select the allowed unlimited option.");
      return;
    }
    const target = snapshot.setup.targets.find((entry) =>
      entry.storageContractId.toLowerCase() === targetId.toLowerCase());
    const binding = target === undefined ? undefined : [...target.sourceBindings]
      .sort((left, right) => left.moduleRootId.toLowerCase().localeCompare(right.moduleRootId.toLowerCase()))[0];
    if (target === undefined || binding === undefined) {
      setMessage("This target does not have one unambiguous provisioned binding for the initial policy writer.");
      return;
    }
    let policy: Record<string, unknown>;
    const common = {
      maxAgeDays,
      maxCount,
      allowUnlimitedAge: draft.allowUnlimitedAge,
      allowUnlimitedCount: draft.allowUnlimitedCount,
    };
    if (draft.action === "delete") {
      const recoveryWindowDays = draft.recoveryWindowDays === ""
        ? undefined : positiveInteger(draft.recoveryWindowDays);
      if (draft.recoveryWindowDays !== "" && recoveryWindowDays === null) {
        setMessage("Enter a positive whole-number recovery window.");
        return;
      }
      policy = {
        ...common,
        action: "delete",
        ...(recoveryWindowDays === undefined ? {} : { recoveryWindowDays }),
      };
    } else {
      const archivePage = archivePages[targetId];
      const selected = archivePage?.options.find((option) =>
        option.connectionInstanceId.toLowerCase() === draft.archiveConnectionInstanceId.toLowerCase());
      const archiveWorkflowId = snapshot.workflows.find((workflowId) =>
        workflowId.toLowerCase() === draft.archiveWorkflowId.toLowerCase());
      if (selected === undefined || archiveWorkflowId === undefined) {
        setMessage("Choose an exact workflow from this published release and a currently loaded eligible Connection.");
        return;
      }
      policy = {
        ...common,
        action: "archive_workflow",
        archiveWorkflowId,
        archiveConnectionInstanceId: selected.connectionInstanceId,
        archiveDestination: selected.destinationKey,
        expectedConnectionRevision: selected.expectedRevision,
      };
    }
    await settleCommand("policy_saved", () => saveFirstInstallPolicy(selector.organizationId, {
      kind: "application.first_install.save_initial_policy",
      selector,
      expected: snapshot,
      storageContractId: targetId,
      targetApplicationRootId: target.applicationRootId,
      expectedBindingRevision: binding.bindingRevision,
      expectedSettingsRevision: snapshot.setup!.organizationLimits.settingsRevision,
      policy,
    }));
  };

  const activate = async () => {
    if (load.kind !== "available" || load.snapshot.setup === null) return;
    const allConfigured = load.snapshot.setup.targets.every((target) => target.policy.state === "configured");
    if (!allConfigured || pending !== null || needsReload) return;
    if (!window.confirm(
      `Activate ${load.snapshot.selected.releaseVersion}, revision ${load.snapshot.selected.releaseRevision} now? This will make the exact prepared Application and Module set active.`,
    )) return;
    await settleCommand("activate", () => activateFirstInstall(selector.organizationId, {
      kind: "application.first_install.activate", selector, expected: load.snapshot,
    }));
  };

  const snapshot = load.kind === "available" ? load.snapshot : null;
  const setup = snapshot?.setup ?? null;
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
    {needsReload && <section className="rounded border p-4">
      <h2 className="font-semibold">Protected reload required</h2>
      <p>The previous action or current authority is stale or uncertain. Use a read-only reload before deciding what to do next.</p>
      <button type="button" disabled={isPending} className="rounded border px-3 py-2 disabled:opacity-50" onClick={() => void reload()}>
        Reload protected setup
      </button>
    </section>}
    {snapshot === null ? <section className="space-y-3 rounded border p-4">
      <h2 className="text-lg font-semibold">First installation unavailable</h2>
      <p>{loadMessage(load)}</p>
      {!needsReload && <button type="button" disabled={isPending} className="rounded border px-3 py-2 disabled:opacity-50" onClick={() => void reload()}>
        Reload current access and installation
      </button>}
    </section> : <>
      <section aria-label="Exact published release" className="space-y-3 rounded border p-4">
        <dl className="space-y-2">
          <div><dt className="font-semibold">Application</dt><dd>{snapshot.selected.definitionKey}</dd></div>
          <div><dt className="font-semibold">Organization</dt><dd className="break-all">{snapshot.organizationId}</dd></div>
          <div><dt className="font-semibold">Application root</dt><dd className="break-all">{snapshot.rootId}</dd></div>
          <div><dt className="font-semibold">Published version and revision</dt><dd>{snapshot.selected.releaseVersion} · revision {snapshot.selected.releaseRevision}</dd></div>
          <div><dt className="font-semibold">Validation contract</dt><dd>{snapshot.selected.validationContractVersion}</dd></div>
          <div><dt className="font-semibold">Selected content fingerprint</dt><dd className="break-all"><code>{snapshot.selected.contentFingerprint}</code></dd></div>
          <div><dt className="font-semibold">Selected resolution fingerprint</dt><dd className="break-all"><code>{snapshot.selected.resolutionFingerprint}</code></dd></div>
          <div><dt className="font-semibold">Registration state</dt><dd>{snapshot.registrationState.replaceAll("_", " ")}</dd></div>
        </dl>
        <p>The selection is pinned to this exact published revision. The browser snapshot is a compare-and-swap claim, never installation authority.</p>
      </section>

      {snapshot.registrationState === "unprepared" || snapshot.registrationState === "registration_aligned_partial"
        ? <section aria-label="Prepare exact first installation" className="space-y-3 rounded border p-4">
          <h2 className="text-lg font-semibold">Prepare inactive installation</h2>
          <p>Preparation may commit Access registration before provisioning every exact Module. It does not activate the Application. If the result is uncertain, reload current state instead of repeating preparation.</p>
          <button type="button" name="application.first_install.prepare" disabled={mutationBlocked}
            aria-busy={pending === "prepare"} className="rounded border px-4 py-2 disabled:opacity-50"
            onClick={() => void prepare()}>
            {pending === "prepare" ? "Preparing exact release…" : "Prepare this exact published release"}
          </button>
        </section>
        : null}

      {setup !== null && <section aria-label="Provisioned record policy setup" className="space-y-4">
        <div className="rounded border p-4">
          <h2 className="text-lg font-semibold">Provisioned inactive setup</h2>
          <p>Registration revision {setup.registrationRevision}. Organization settings revision {setup.organizationLimits.settingsRevision}.</p>
          <p>Allowed actions: {setup.organizationLimits.allowedActions.join(", ")}.</p>
          <p>Each initial policy is created once. Existing configured policies are read-only here.</p>
        </div>
        {setup.targets.map((target, index) => {
          const allowedTargetActions = targetAllowedActions(snapshot, target);
          const draft = drafts[target.storageContractId] ?? defaultDraft(snapshot, target);
          const page = archivePages[target.storageContractId];
          const inputPrefix = `first-install-${target.storageContractId}`;
          return <article key={target.storageContractId} aria-label={`Record type setup target ${index + 1}`} className="space-y-4 rounded border p-4">
            <h3 className="font-semibold">Target {index + 1}: {target.storageContractId}</h3>
            <p>Scope: {target.storageScope === "organization_shared" ? "Organization-shared" : "Application-contained"}.</p>
            <p>Bound Module count: {target.sourceBindings.length}.</p>
            {target.policy.state === "configured" ? <div className="space-y-2 rounded bg-slate-50 p-3">
              <p>Initial policy is configured at revision {target.policy.policyRevision}. This setup view does not edit it.</p>
              <p>Action: {target.policy.policyBody.action}.</p>
              <p>Maximum age: {target.policy.policyBody.maxAgeDays ?? "unlimited"} days; maximum count: {target.policy.policyBody.maxCount ?? "unlimited"}.</p>
              {target.policy.policyBody.action === "archive_workflow" && <p>Archive workflow {target.policy.policyBody.archiveWorkflowId} through the configured Connection.</p>}
            </div> : allowedTargetActions.length === 0
              ? <p role="status" className="rounded border p-3">
                No policy action allowed by current organization limits can be applied to this target in the selected published release. Activation remains unavailable.
              </p>
              : <form className="space-y-3" onSubmit={(event) => void savePolicy(event, target.storageContractId, draft, snapshot)}>
              <label className="block space-y-1" htmlFor={`${inputPrefix}-action`}>
                <span className="font-medium">Initial action</span>
                <select id={`${inputPrefix}-action`} value={draft.action} disabled={mutationBlocked}
                  className="block w-full rounded border px-3 py-2 disabled:opacity-50"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value === "delete" || value === "archive_workflow")
                      updateDraft(target.storageContractId, { action: value }, snapshot);
                  }}>
                  {allowedTargetActions.map((action) =>
                    <option key={action} value={action}>{action === "delete" ? "Delete" : "Archive through a workflow"}</option>)}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1" htmlFor={`${inputPrefix}-max-age`}>
                  <span className="font-medium">Maximum record age in days</span>
                  <input id={`${inputPrefix}-max-age`} inputMode="numeric" type="number" min="1" step="1"
                    value={draft.maxAgeDays} disabled={mutationBlocked || draft.allowUnlimitedAge}
                    className="block w-full rounded border px-3 py-2 disabled:opacity-50"
                    onChange={(event) => updateDraft(target.storageContractId, { maxAgeDays: event.currentTarget.value }, snapshot)} />
                </label>
                <label className="block space-y-1" htmlFor={`${inputPrefix}-max-count`}>
                  <span className="font-medium">Maximum record count</span>
                  <input id={`${inputPrefix}-max-count`} inputMode="numeric" type="number" min="1" step="1"
                    value={draft.maxCount} disabled={mutationBlocked || draft.allowUnlimitedCount}
                    className="block w-full rounded border px-3 py-2 disabled:opacity-50"
                    onChange={(event) => updateDraft(target.storageContractId, { maxCount: event.currentTarget.value }, snapshot)} />
                </label>
              </div>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={draft.allowUnlimitedAge}
                  disabled={mutationBlocked || !setup.organizationLimits.allowUnlimitedRetentionDays}
                  onChange={(event) => updateDraft(target.storageContractId, { allowUnlimitedAge: event.currentTarget.checked }, snapshot)} />
                <span>Allow unlimited age retention (only if current organization limits permit it)</span>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={draft.allowUnlimitedCount}
                  disabled={mutationBlocked || !setup.organizationLimits.allowUnlimitedRecordCount}
                  onChange={(event) => updateDraft(target.storageContractId, { allowUnlimitedCount: event.currentTarget.checked }, snapshot)} />
                <span>Allow unlimited record count (only if current organization limits permit it)</span>
              </label>
              {draft.action === "delete" ? <label className="block space-y-1" htmlFor={`${inputPrefix}-recovery-window`}>
                <span className="font-medium">Optional recovery window in days</span>
                <input id={`${inputPrefix}-recovery-window`} inputMode="numeric" type="number" min="1" step="1"
                  value={draft.recoveryWindowDays} disabled={mutationBlocked}
                  className="block w-full rounded border px-3 py-2 disabled:opacity-50"
                  onChange={(event) => updateDraft(target.storageContractId, { recoveryWindowDays: event.currentTarget.value }, snapshot)} />
              </label> : <>
                {target.storageScope === "organization_shared" || target.applicationRootId === null
                  ? <p className="rounded border p-3">Archive policies require this Application's exact contained target. Choose a delete policy for this shared target.</p>
                  : <>
                    <label className="block space-y-1" htmlFor={`${inputPrefix}-workflow`}>
                      <span className="font-medium">Workflow in this exact release</span>
                      <select id={`${inputPrefix}-workflow`} value={draft.archiveWorkflowId} disabled={mutationBlocked}
                        className="block w-full rounded border px-3 py-2 disabled:opacity-50"
                        onChange={(event) => updateDraft(target.storageContractId, { archiveWorkflowId: event.currentTarget.value }, snapshot)}>
                        {snapshot.workflows.map((workflow) => <option key={workflow} value={workflow}>{workflow}</option>)}
                      </select>
                    </label>
                    {setup.organizationLimits.allowedArchiveDestinations.length === 0
                      ? <p>No archive destination is allowed by current organization lifecycle limits.</p>
                      : <div className="space-y-2">
                        <button type="button" disabled={mutationBlocked || page?.loading === true}
                          className="rounded border px-3 py-2 disabled:opacity-50"
                          onClick={() => void loadOptions(target.storageContractId)}>
                          {page?.loading ? "Loading eligible Connections…" : "Load eligible Connections"}
                        </button>
                        {page?.options.map((option) => <label key={option.connectionInstanceId} className="flex items-center gap-2">
                          <input type="radio" name={`${inputPrefix}-connection`}
                            checked={draft.archiveConnectionInstanceId === option.connectionInstanceId}
                            disabled={mutationBlocked}
                            onChange={() => updateDraft(target.storageContractId, {
                              archiveConnectionInstanceId: option.connectionInstanceId,
                            }, snapshot)} />
                          <span>{option.connectionTypeId} {option.connectionTypeVersion} · {option.destinationKey} · revision {option.expectedRevision}</span>
                        </label>)}
                        {page?.nextAfterConnectionInstanceId !== null && page?.nextAfterConnectionInstanceId !== undefined &&
                          <button type="button" disabled={mutationBlocked || page.loading}
                            className="rounded border px-3 py-2 disabled:opacity-50"
                            onClick={() => void loadOptions(target.storageContractId, page.nextAfterConnectionInstanceId ?? undefined)}>
                            Load next eligible Connections page
                          </button>}
                        {page?.message && <p>{page.message}</p>}
                      </div>}
                  </>}
              </>}
              <button type="submit" name="application.first_install.save_initial_policy"
                disabled={mutationBlocked || (draft.action === "archive_workflow" &&
                  (target.storageScope !== "application_contained" || target.applicationRootId === null))}
                aria-busy={pending === "policy_saved"}
                className="rounded border px-4 py-2 disabled:opacity-50">
                {pending === "policy_saved" ? "Saving initial policy…" : draft.action === "delete"
                  ? "Save initial delete policy" : "Save initial archive policy"}
              </button>
            </form>}
          </article>;
        })}
      </section>}

      {snapshot.registrationState === "provisioned_inactive" && setup !== null &&
        setup.targets.every((target) => target.policy.state === "configured") &&
        <section aria-label="Explicit activation" className="space-y-3 rounded border p-4">
          <h2 className="text-lg font-semibold">Activate the prepared release</h2>
          <p>All current record-policy targets are configured. Activation is a separate, explicit operation for this exact Application and Module release set.</p>
          <button type="button" name="application.first_install.activate" disabled={mutationBlocked}
            aria-busy={pending === "activate"} className="rounded border px-4 py-2 disabled:opacity-50"
            onClick={() => void activate()}>
            {pending === "activate" ? "Activating exact release…" : "Confirm activation"}
          </button>
        </section>}

      {snapshot.registrationState === "active_exact" && <section className="rounded border p-4">
        <h2 className="font-semibold">This exact release is already active</h2>
        <p>No first-install action remains for this selected release. Use the protected reload link to inspect current state.</p>
      </section>}
      {commandResult !== null && <section className="rounded border p-4">
        <h2 className="font-semibold">Latest command result</h2>
        <p>{commandMessage(commandResult)}</p>
      </section>}
    </>}
  </main>;
}
