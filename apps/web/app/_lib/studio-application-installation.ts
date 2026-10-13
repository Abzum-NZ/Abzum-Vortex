import "server-only";

import {
  canonicalJson,
  describeFailure,
  organizationIdSchema,
  sameId,
  type IdentitySession,
  type OrganizationLifecycleLimits,
  type RecordTypeLifecyclePolicy,
  type StorageContractId,
  type SelectedOrganizationScope,
  type SystemApplicationBoundReleaseSetResult,
} from "@vortex/platform/schema";
import {
  FirstInstallUnavailable,
  ProvisionedSetupError,
  firstInstallHistory,
  firstInstallSelectedIdentity,
  firstInstallState,
  firstInstallUnavailable,
  firstInstallWorkflows,
  installationProblem,
  type InstallationBindings,
  type InstallationProblemShape,
  initialLifecyclePolicyMatches,
  completeFirstInstallConnectionRead,
  firstInstallAppCompletion,
  readFirstInstallAppState,
  readFirstInstallCandidateInTransaction,
  readFirstInstallCurrentRelease,
  readFirstInstallProvisionedSetupInTransaction,
  requireFirstInstallSetupUnchanged,
  visibleLifecyclePolicyBody,
  visibleProvisionedSetup,
  type FirstInstallAppState as FirstInstallProvedState,
  type FirstInstallEnvironment,
  type ProvisionedSetup,
  saveInitialArchiveWorkflowPolicy,
  workflowIsInExactRelease,
  type InitialLifecyclePolicyTarget,
  activateUpgradeRelease,
  classifyInstallationFailure,
  readUpgradeActiveObservation,
  readUpgradeAuthorizedState,
  sameUpgradeSelectedSnapshot,
  sameUpgradeSnapshotState,
  type UpgradeEnvironment,
  type UpgradeReleaseIdentity,
  type UpgradeState,
  createFirstInstallCoordinator,
  verifyFirstInstallActivation,
  type FirstInstallCoordinatorEnvironment,
  readInstallationArchiveConnectionOptions,
  readSelectedInstallationArchiveConnection,
} from "@vortex/platform/server";
import type { RequestDatabaseTransaction } from "@vortex/platform/server";
import { createRecordTypeLifecyclePolicyService } from "@vortex/platform/server";
import type { z } from "zod";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue, releaseSetContainsCustomComponents } from "./definition-catalogue";
import { humanOrganizationRequestDependencies, humanOrganizationRequests } from "./server-composition";
import {
  inspectStudioApplicationReleaseHistory,
  loadStudioApplicationHistoryAccess,
} from "./studio-application-history";
import type {
  studioApplicationFirstInstallPolicyInputSchema,
  studioApplicationFirstInstallTargetSchema} from "./studio-application-installation-contracts";
import {
  studioApplicationInstallationCommandResultSchema,
  studioApplicationInstallationCommandSchema,
  studioApplicationInstallationLoadResultSchema,
  studioApplicationInstallationReleaseIdentitySchema,
  studioApplicationInstallationSelectorSchema,
  studioApplicationInstallationSnapshotSchema,
  studioApplicationArchiveOptionsQuerySchema,
  studioApplicationArchiveOptionsResultSchema,
  studioApplicationFirstInstallActivateCommandSchema,
  studioApplicationFirstInstallCommandResultSchema,
  studioApplicationFirstInstallLoadResultSchema,
  studioApplicationFirstInstallPrepareCommandSchema,
  studioApplicationFirstInstallSaveCommandSchema,
  studioApplicationFirstInstallSelectorSchema,
  studioApplicationFirstInstallSetupSchema,
  studioApplicationFirstInstallSnapshotSchema,
  type StudioApplicationArchiveOptionsResult,
  type StudioApplicationFirstInstallCommandResult,
  type StudioApplicationFirstInstallLoadResult,
  type StudioApplicationFirstInstallSelector,
  type StudioApplicationFirstInstallSnapshot,
  type StudioApplicationInstallationCommandResult,
  type StudioApplicationInstallationReleaseIdentity,
  type StudioApplicationInstallationSelector,
  type StudioApplicationInstallationSnapshot,
} from "./studio-application-installation-contracts";
import { platformPermissionSource } from "./platform-permission-source";

type AuthorizedState = Readonly<{
  snapshot: StudioApplicationInstallationSnapshot;
  state: UpgradeState;
  checkedAt: string;
}>;

type Problem = InstallationProblemShape;

const firstInstallEnvironment: FirstInstallEnvironment = {
  catalogue: installedReleaseCatalogue,
  permissions: platformPermissionSource,
  containsCustomComponents: releaseSetContainsCustomComponents,
};

const firstInstallCoordinatorEnvironment = (): FirstInstallCoordinatorEnvironment => ({
  ...firstInstallEnvironment,
  requests: humanOrganizationRequests(),
});

function problem(kind: Problem["kind"], unavailableReason?: Problem["unavailableReason"]): never {
  return installationProblem(unavailableReason ?? kind, kind, unavailableReason);
}

const unavailable = (reason: NonNullable<Problem["unavailableReason"]>) =>
  studioApplicationInstallationLoadResultSchema.parse({ kind: "unavailable", reason });

const toLoadFailure = (failure: Problem) => {
  if (failure.unavailableReason !== undefined) return unavailable(failure.unavailableReason);
  if (failure.kind === "refused" || failure.kind === "authentication_required")
    return studioApplicationInstallationLoadResultSchema.parse({ kind: "refused" });
  return studioApplicationInstallationLoadResultSchema.parse({ kind: "temporarily_unavailable" });
};

const toCommandFailure = (
  failure: Problem,
  registrationMayHaveChanged: boolean | "unknown",
): StudioApplicationInstallationCommandResult =>
  studioApplicationInstallationCommandResultSchema.parse({
    kind: failure.kind,
    registrationMayHaveChanged,
  });

const exactSession = async (): Promise<IdentitySession | undefined> => {
  const resolved = await resolveIdentitySession();
  if (resolved.kind === "temporarily_unavailable") problem("temporarily_unavailable");
  return resolved.kind === "active" ? resolved.session : undefined;
};

const sameUuid = (left: string, right: string): boolean => sameId(left, right);

const releaseIdentity = (release: UpgradeReleaseIdentity): StudioApplicationInstallationReleaseIdentity => {
  const parsed = studioApplicationInstallationReleaseIdentitySchema.safeParse(release);
  if (!parsed.success)
    installationProblem("release_identity_invalid", "refused", undefined, { cause: parsed.error });
  return parsed.data;
};

const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

const upgradeEnvironment = (): UpgradeEnvironment => ({
  requests: humanOrganizationRequests(),
  catalogue: installedReleaseCatalogue,
  permissions: platformPermissionSource,
  containsCustomComponents: releaseSetContainsCustomComponents,
});

const withCurrentAuthorizedState = async (
  selector: StudioApplicationInstallationSelector,
  session: IdentitySession,
  allowEqual: boolean,
): Promise<AuthorizedState> => {
  const authorized = await readUpgradeAuthorizedState(upgradeEnvironment(), selector, session, allowEqual);
  const snapshot = studioApplicationInstallationSnapshotSchema.safeParse(authorized.snapshot);
  if (!snapshot.success)
    installationProblem("snapshot_invalid", "temporarily_unavailable", undefined, { cause: snapshot.error });
  return { snapshot: snapshot.data, state: authorized.state, checkedAt: authorized.checkedAt };
};

const readActiveObservation = async (
  organizationId: SelectedOrganizationScope["organizationId"],
  rootId: StudioApplicationInstallationSelector["rootId"],
  session: IdentitySession,
): Promise<StudioApplicationInstallationReleaseIdentity> =>
  releaseIdentity(await readUpgradeActiveObservation(upgradeEnvironment(), organizationId, rootId, session));

export const loadStudioApplicationInstallation = async (
  organizationIdCandidate: string,
  selectorCandidate: unknown,
) => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const selector = studioApplicationInstallationSelectorSchema.safeParse(selectorCandidate);
  if (!organizationId.success || !selector.success ||
    !sameUuid(organizationId.data, selector.data.organizationId))
    return studioApplicationInstallationLoadResultSchema.parse({ kind: "refused" });
  try {
    const session = await exactSession();
    if (session === undefined) return studioApplicationInstallationLoadResultSchema.parse({ kind: "refused" });
    const authorized = await withCurrentAuthorizedState(selector.data, session, true);
    if (authorized.snapshot.selected.releaseRevision < authorized.snapshot.active.releaseRevision)
      return unavailable("not_newer");
    return studioApplicationInstallationLoadResultSchema.parse({
      kind: "available",
      snapshot: authorized.snapshot,
    });
  } catch (error) {
    return toLoadFailure(classifyInstallationFailure(error));
  }
};

export const installSelectedStudioApplicationRelease = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationInstallationCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationInstallationCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !sameUuid(organizationId.data, command.data.selector.organizationId) ||
    !sameUuid(command.data.expected.organizationId, command.data.selector.organizationId) ||
    !sameUuid(command.data.expected.rootId, command.data.selector.rootId) ||
    command.data.expected.selected.releaseRevision !== command.data.selector.releaseRevision)
    return toCommandFailure({ kind: "refused" }, false);

  let invocationStarted = false;
  try {
    const session = await exactSession();
    if (session === undefined) return toCommandFailure({ kind: "refused" }, false);
    const current = await withCurrentAuthorizedState(command.data.selector, session, true);
    const currentSnapshot = current.snapshot;
    const now = Date.parse(current.checkedAt);
    if (!Number.isFinite(now) || Date.parse(command.data.expected.validUntil) <= now ||
      Date.parse(currentSnapshot.validUntil) <= now)
      return toCommandFailure({ kind: "conflict" }, false);

    const selected = current.snapshot.selected;
    const currentActiveRevision = current.state.active.applicationReleaseRevision;
    if (selected.releaseRevision === currentActiveRevision) {
      if (!sameUpgradeSelectedSnapshot(command.data.expected, currentSnapshot) ||
        !same(current.snapshot.active, current.snapshot.selected))
        return toCommandFailure({ kind: "conflict" }, false);
      const postCommit = { kind: "observed" as const, active: current.snapshot.active };
      return studioApplicationInstallationCommandResultSchema.parse({
        kind: "completed",
        outcome: "unchanged",
        selected,
        previousActiveRevision: null,
        activeAtCommitRevision: currentActiveRevision,
        postCommit,
        registrationMayHaveChanged: false,
      });
    }
    if (!sameUpgradeSnapshotState(command.data.expected, currentSnapshot))
      return toCommandFailure({ kind: "conflict" }, false);

    invocationStarted = true;
    const activation = await activateUpgradeRelease(
      upgradeEnvironment(),
      command.data.selector,
      current.state,
      session,
    );
    let postCommit: { kind: "observed"; active: StudioApplicationInstallationReleaseIdentity } |
      { kind: "unavailable" } = { kind: "unavailable" };
    try {
      postCommit = {
        kind: "observed",
        active: await readActiveObservation(organizationId.data, command.data.selector.rootId, session),
      };
    } catch (error) {
      console.error(`[studio] post-commit installation observation unavailable: ${describeFailure(error)}`);
      postCommit = { kind: "unavailable" };
    }
    return studioApplicationInstallationCommandResultSchema.parse({
      kind: "completed",
      outcome: activation.outcome,
      selected,
      previousActiveRevision: activation.previousActiveRevision,
      activeAtCommitRevision: activation.activeAtCommitRevision,
      postCommit,
      registrationMayHaveChanged: invocationStarted,
    });
  } catch (error) {
    return toCommandFailure(classifyInstallationFailure(error), invocationStarted ? "unknown" : false);
  }
};

const firstInstallSnapshot = (
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
  registrationState: StudioApplicationFirstInstallSnapshot["registrationState"],
  setup: unknown | null,
): StudioApplicationFirstInstallSnapshot => studioApplicationFirstInstallSnapshotSchema.parse({
  organizationId: selector.organizationId,
  rootId: selector.rootId,
  selected: firstInstallSelectedIdentity(releaseSet),
  history,
  registrationState,
  registeredReleaseRevision: bindings.registeredReleaseRevision,
  moduleBindings: bindings.moduleBindings,
  workflows: firstInstallWorkflows(releaseSet),
  setup,
});

const firstInstallLoadFailure = (error: unknown): StudioApplicationFirstInstallLoadResult => {
  if (error instanceof FirstInstallUnavailable)
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "unavailable", reason: error.reason });
  if (error instanceof ProvisionedSetupError && error.reason !== "refused") {
    console.error(`[studio] application installation failed: ${describeFailure(error)}`);
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "unavailable", reason: error.reason });
  }
  const failure = classifyInstallationFailure(error);
  if (failure.kind === "conflict")
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "conflict" });
  if (failure.kind === "refused" || failure.kind === "authentication_required")
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "refused" });
  return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "temporarily_unavailable" });
};

const firstInstallCommandFailure = (
  error: unknown,
  stateMayHaveChanged: boolean | "unknown",
): StudioApplicationFirstInstallCommandResult => {
  const failure = error instanceof FirstInstallUnavailable
    ? error.reason === "already_installed"
      ? { kind: "conflict" as const }
      : { kind: "refused" as const }
    : classifyInstallationFailure(error);
  return studioApplicationFirstInstallCommandResultSchema.parse({
    kind: failure.kind,
    stateMayHaveChanged,
  });
};

type FirstInstallCandidate = Readonly<{
  selector: StudioApplicationFirstInstallSelector;
  history: ReturnType<typeof firstInstallHistory>;
  releaseSet: SystemApplicationBoundReleaseSetResult;
  snapshot: StudioApplicationFirstInstallSnapshot;
  session: IdentitySession;
}>;

const readCurrentFirstInstallCandidate = async (
  selector: StudioApplicationFirstInstallSelector,
): Promise<FirstInstallCandidate> => {
  const session = await exactSession();
  if (session === undefined) problem("refused");
  const access = await loadStudioApplicationHistoryAccess(selector.organizationId, selector.rootId);
  if (access.kind !== "available") {
    if (access.kind === "conflict") problem("conflict");
    if (access.kind === "refused") problem("refused");
    problem("temporarily_unavailable");
  }
  const history = firstInstallHistory(access.snapshot);
  if (history.anchorReleaseRevision === null || selector.releaseRevision > history.anchorReleaseRevision)
    firstInstallUnavailable("release_not_published");
  const inspected = await inspectStudioApplicationReleaseHistory(selector.organizationId, {
    rootId: selector.rootId,
    expected: history,
    releaseRevision: selector.releaseRevision,
  });
  if (inspected.kind !== "available") {
    if (inspected.kind === "conflict") problem("conflict");
    if (inspected.kind === "refused") firstInstallUnavailable("release_not_published");
    problem("temporarily_unavailable");
  }
  const result = await humanOrganizationRequests().runChange(
    session,
    { organizationId: selector.organizationId },
    (transaction, scope, issuedAt) => readFirstInstallCandidateInTransaction(
      transaction, scope, session, issuedAt, firstInstallEnvironment, selector, history,
      { definitionKey: inspected.snapshot.definitionKey, metadata: inspected.metadata },
    ),
  );
  if (result.kind !== "available") problem(result.kind === "unavailable" ? "refused" : "temporarily_unavailable");
  const { releaseSet, bindings } = result.value;
  const registrationState = firstInstallState(selector, releaseSet, bindings);
  let setup: unknown | null = null;
  if (registrationState === "provisioned_inactive") {
    setup = await readCurrentProvisionedSetup(selector, history, releaseSet, session);
    if (setup === null) firstInstallUnavailable("setup_unavailable");
  }
  const snapshot = firstInstallSnapshot(
    selector, history, releaseSet, bindings, registrationState, setup,
  );
  return {
    selector,
    history,
    releaseSet,
    snapshot,
    session,
  };
};

const visibleProvisionedSetupBody = (
  setup: ProvisionedSetup,
): z.infer<typeof studioApplicationFirstInstallSetupSchema> =>
  studioApplicationFirstInstallSetupSchema.parse(visibleProvisionedSetup(setup));

const readCurrentProvisionedSetup = async (
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  expectedReleaseSet: SystemApplicationBoundReleaseSetResult,
  session: IdentitySession,
): Promise<z.infer<typeof studioApplicationFirstInstallSetupSchema> | null> => {
  let callbackFailure: unknown;
  const result = await humanOrganizationRequests().runChange(
    session,
    { organizationId: selector.organizationId, applicationRootId: selector.rootId },
    async (transaction, scope, issuedAt) => {
      try {
        return await readFirstInstallProvisionedSetupInTransaction(
          transaction, scope, session, issuedAt, firstInstallEnvironment, selector, history, expectedReleaseSet,
        );
      } catch (error) {
        callbackFailure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return visibleProvisionedSetupBody(result.value);
  if (callbackFailure !== undefined) throw callbackFailure;
  if (result.kind === "unavailable") problem("refused");
  problem("temporarily_unavailable");
};

export const loadStudioApplicationFirstInstall = async (
  organizationIdCandidate: string,
  selectorCandidate: unknown,
): Promise<StudioApplicationFirstInstallLoadResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const selector = studioApplicationFirstInstallSelectorSchema.safeParse(selectorCandidate);
  if (!organizationId.success || !selector.success ||
    !sameUuid(organizationId.data, selector.data.organizationId))
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "refused" });
  try {
    const current = await readCurrentFirstInstallCandidate(selector.data);
    return studioApplicationFirstInstallLoadResultSchema.parse({
      kind: "available",
      snapshot: current.snapshot,
    });
  } catch (error) {
    return firstInstallLoadFailure(error);
  }
};

const sameFirstInstallExpectation = (
  expected: StudioApplicationFirstInstallSnapshot,
  actual: StudioApplicationFirstInstallSnapshot,
): boolean => same(expected, actual);

export const prepareStudioApplicationFirstInstall = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationFirstInstallPrepareCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !sameUuid(organizationId.data, command.data.selector.organizationId) ||
    !sameUuid(command.data.expected.organizationId, command.data.selector.organizationId) ||
    !sameUuid(command.data.expected.rootId, command.data.selector.rootId) ||
    command.data.expected.selected.releaseRevision !== command.data.selector.releaseRevision)
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "refused", stateMayHaveChanged: false,
    });
  let invocationStarted = false;
  try {
    const current = await readCurrentFirstInstallCandidate(command.data.selector);
    if (!sameFirstInstallExpectation(command.data.expected, current.snapshot))
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    if (current.snapshot.registrationState !== "unprepared" &&
      current.snapshot.registrationState !== "registration_aligned_partial")
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    const coordinator = createFirstInstallCoordinator(
      firstInstallCoordinatorEnvironment(), current.selector, current.snapshot, current.releaseSet, "prepare",
    );
    invocationStarted = true;
    const outcome = await coordinator.prepare(current.session, {
      organizationId: current.selector.organizationId,
      applicationRootId: current.selector.rootId,
      applicationReleaseRevision: current.selector.releaseRevision,
    });
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "completed",
      action: "prepared",
      stateMayHaveChanged: outcome.outcome === "prepared",
    });
  } catch (error) {
    return firstInstallCommandFailure(error, invocationStarted ? "unknown" : false);
  }
};

const archiveOptionsFailure = (error: unknown): StudioApplicationArchiveOptionsResult => {
  const failure = classifyInstallationFailure(error);
  if (failure.kind === "conflict")
    return studioApplicationArchiveOptionsResultSchema.parse({ kind: "conflict" });
  if (failure.kind === "refused" || failure.kind === "authentication_required")
    return studioApplicationArchiveOptionsResultSchema.parse({ kind: "refused" });
  return studioApplicationArchiveOptionsResultSchema.parse({ kind: "temporarily_unavailable" });
};

export const loadStudioApplicationArchiveOptions = async (
  organizationIdCandidate: string,
  queryCandidate: unknown,
): Promise<StudioApplicationArchiveOptionsResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const query = studioApplicationArchiveOptionsQuerySchema.safeParse(queryCandidate);
  if (!organizationId.success || !query.success ||
    !sameUuid(organizationId.data, query.data.selector.organizationId) ||
    !sameUuid(query.data.expected.organizationId, query.data.selector.organizationId) ||
    !sameUuid(query.data.expected.rootId, query.data.selector.rootId) ||
    query.data.expected.selected.releaseRevision !== query.data.selector.releaseRevision)
    return studioApplicationArchiveOptionsResultSchema.parse({ kind: "refused" });
  try {
    const current = await readCurrentFirstInstallCandidate(query.data.selector);
    if (!sameFirstInstallExpectation(query.data.expected, current.snapshot))
      return studioApplicationArchiveOptionsResultSchema.parse({ kind: "conflict" });
    const result = await runFirstInstallAppTransaction(
      current,
      query.data.expected,
      async (transaction, _scope, _issuedAt, initial) => {
        const target = currentTarget(initial.visibleSetup, query.data.storageContractId);
        if (target.policy.state !== "absent" || target.storageScope !== "application_contained" ||
          target.applicationRootId === null || !initial.visibleSetup.organizationLimits.allowedActions.includes("archive_workflow") ||
          initial.visibleSetup.organizationLimits.allowedArchiveDestinations.length === 0)
          problem("refused");
        const currentRelease = await readFirstInstallCurrentRelease(
          transaction, firstInstallEnvironment, query.data.selector, initial.releaseSet,
        );
        await requireFirstInstallSetupUnchanged(
          transaction, _scope, current.session, _issuedAt, firstInstallEnvironment, query.data.selector,
          currentRelease, initial,
        );
        const retainedFence = await firstInstallAppCompletion(
          transaction, _scope, current.session, _issuedAt, firstInstallEnvironment, query.data.selector,
          query.data.expected.history, currentRelease, initial.context,
        );
        const page = await readInstallationArchiveConnectionOptions(
          transaction,
          query.data.selector.organizationId,
          query.data.selector.rootId,
          initial.visibleSetup.organizationLimits.allowedArchiveDestinations,
          query.data.afterConnectionInstanceId,
        );
        await completeFirstInstallConnectionRead(
          transaction,
          _scope,
          current.session,
          _issuedAt,
          firstInstallEnvironment,
          query.data.selector,
          query.data.expected.history,
          initial,
          retainedFence,
        );
        return studioApplicationArchiveOptionsResultSchema.parse({
          kind: "available",
          options: page.options.map(({ destinationFingerprint: _privateFingerprint, ...option }) => option),
          ...(page.nextAfterConnectionInstanceId === undefined
            ? {}
            : { nextAfterConnectionInstanceId: page.nextAfterConnectionInstanceId }),
        });
      },
      true,
    );
    return result;
  } catch (error) {
    return archiveOptionsFailure(error);
  }
};

const initialPolicyTarget = (
  candidate: FirstInstallCandidate,
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
): InitialLifecyclePolicyTarget => ({
  organizationId: candidate.selector.organizationId,
  installationRootId: candidate.selector.rootId,
  releaseRevision: candidate.selector.releaseRevision,
  storageContractId: target.storageContractId,
  applicationRootId: target.applicationRootId,
});

const saveDeleteInitialPolicy = async (
  candidate: FirstInstallCandidate,
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
  expectedBindingRevision: number,
  expectedSettingsRevision: number,
  policy: Extract<z.infer<typeof studioApplicationFirstInstallPolicyInputSchema>, { action: "delete" }>,
): Promise<RecordTypeLifecyclePolicy> => {
  if (!target.sourceBindings.some((binding) => binding.bindingRevision === expectedBindingRevision))
    problem("conflict");
  const service = createRecordTypeLifecyclePolicyService(humanOrganizationRequestDependencies());
  const result = await service.saveInitialForProvisionedSetup(candidate.session, initialPolicyCommand(
    candidate, target, expectedBindingRevision, expectedSettingsRevision, policy,
  ));
  if (result.kind !== "available") {
    if (result.kind === "unavailable") problem("refused");
    problem("temporarily_unavailable");
  }
  return initialLifecyclePolicyMatches(result.value, initialPolicyTarget(candidate, target), policy);
};

type FirstInstallAppState = FirstInstallProvedState & Readonly<{
  visibleSetup: z.infer<typeof studioApplicationFirstInstallSetupSchema>;
}>;

const firstInstallCurrentSnapshotMatches = (
  selector: StudioApplicationFirstInstallSelector,
  expected: StudioApplicationFirstInstallSnapshot,
  current: Readonly<{
    releaseSet: SystemApplicationBoundReleaseSetResult;
    bindings: InstallationBindings;
    state: StudioApplicationFirstInstallSnapshot["registrationState"];
    setup: ProvisionedSetup;
  }>,
): boolean => sameFirstInstallExpectation(expected, firstInstallSnapshot(
  selector, expected.history, current.releaseSet, current.bindings, current.state,
  visibleProvisionedSetupBody(current.setup),
));

type FirstInstallTransactionAction<Value> = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  issuedAt: string,
  initial: FirstInstallAppState,
) => Promise<Value>;

const runFirstInstallAppTransaction = async <Value>(
  candidate: FirstInstallCandidate,
  expected: StudioApplicationFirstInstallSnapshot,
  action: FirstInstallTransactionAction<Value>,
  actionIsFinalDatabaseOperation = false,
): Promise<Value> => {
  let callbackFailure: unknown;
  const result = await humanOrganizationRequests().runChange(
    candidate.session,
    { organizationId: candidate.selector.organizationId, applicationRootId: candidate.selector.rootId },
    async (transaction, scope, issuedAt) => {
      try {
        const proved = await readFirstInstallAppState(
          transaction, scope, candidate.session, issuedAt, firstInstallEnvironment, candidate.selector, expected,
          (current) => firstInstallCurrentSnapshotMatches(candidate.selector, expected, current),
        );
        const initial: FirstInstallAppState = { ...proved, visibleSetup: visibleProvisionedSetupBody(proved.setup) };
        const value = await action(transaction, scope, issuedAt, initial);
        if (!actionIsFinalDatabaseOperation) {
          const currentRelease = await readFirstInstallCurrentRelease(
            transaction, firstInstallEnvironment, candidate.selector, initial.releaseSet,
          );
          await firstInstallAppCompletion(
            transaction, scope, candidate.session, issuedAt, firstInstallEnvironment, candidate.selector,
            expected.history, currentRelease, initial.context,
          );
        }
        return value;
      } catch (error) {
        callbackFailure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (callbackFailure !== undefined) throw callbackFailure;
  if (result.kind === "unavailable") problem("refused");
  problem("temporarily_unavailable");
};

const currentTarget = (
  setup: z.infer<typeof studioApplicationFirstInstallSetupSchema>,
  storageContractId: StorageContractId,
) => {
  const matching = setup.targets.filter((target) => sameUuid(target.storageContractId, storageContractId));
  if (matching.length !== 1) problem("conflict");
  const target = matching[0];
  if (target === undefined) problem("conflict");
  return target;
};

const assertPolicyCommonFields = (
  policy: z.infer<typeof studioApplicationFirstInstallPolicyInputSchema>,
  limits: OrganizationLifecycleLimits,
): void => {
  if (!limits.allowedActions.includes(policy.action) ||
    (policy.allowUnlimitedAge && policy.maxAgeDays !== null) ||
    (!policy.allowUnlimitedAge && policy.maxAgeDays === null) ||
    (policy.allowUnlimitedCount && policy.maxCount !== null) ||
    (!policy.allowUnlimitedCount && policy.maxCount === null) ||
    (policy.maxAgeDays !== null && limits.maxRetentionDays !== null &&
      limits.maxRetentionDays !== undefined && policy.maxAgeDays > limits.maxRetentionDays) ||
    (policy.maxCount !== null && limits.maxRecordCount !== null &&
      limits.maxRecordCount !== undefined && policy.maxCount > limits.maxRecordCount) ||
    (policy.allowUnlimitedAge && !limits.allowUnlimitedRetentionDays) ||
    (policy.allowUnlimitedCount && !limits.allowUnlimitedRecordCount))
    problem("refused");
};

const initialPolicyCommand = (
  candidate: FirstInstallCandidate,
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
  expectedBindingRevision: number,
  expectedSettingsRevision: number,
  policy: z.infer<typeof studioApplicationFirstInstallPolicyInputSchema>,
) => ({
  organizationId: candidate.selector.organizationId,
  bindingApplicationRootId: candidate.selector.rootId,
  expectedBindingRevision,
  storageContractId: target.storageContractId,
  applicationRootId: target.applicationRootId,
  expectedSettingsRevision,
  policy,
});

const firstInstallCommandMatches = (
  organizationId: string,
  selector: StudioApplicationFirstInstallSelector,
  expected: StudioApplicationFirstInstallSnapshot,
): boolean => sameUuid(organizationId, selector.organizationId) &&
  sameUuid(expected.organizationId, selector.organizationId) &&
  sameUuid(expected.rootId, selector.rootId) &&
  expected.selected.releaseRevision === selector.releaseRevision;

const assertInitialPolicyTarget = (
  setup: z.infer<typeof studioApplicationFirstInstallSetupSchema>,
  command: z.infer<typeof studioApplicationFirstInstallSaveCommandSchema>,
): z.infer<typeof studioApplicationFirstInstallTargetSchema> => {
  const target = currentTarget(setup, command.storageContractId);
  if ((target.applicationRootId === null) !== (command.targetApplicationRootId === null) ||
    (target.applicationRootId !== null && command.targetApplicationRootId !== null &&
      !sameUuid(target.applicationRootId, command.targetApplicationRootId)) ||
    target.policy.state !== "absent" ||
    setup.organizationLimits.settingsRevision !== command.expectedSettingsRevision ||
    !target.sourceBindings.some((binding) =>
      binding.bindingRevision === command.expectedBindingRevision))
    problem("conflict");
  assertPolicyCommonFields(command.policy, setup.organizationLimits);
  if (command.policy.action === "archive_workflow" &&
    (target.storageScope !== "application_contained" ||
      target.applicationRootId === null ||
      !sameUuid(target.applicationRootId, command.selector.rootId)))
    problem("refused");
  return target;
};

const freshSavedPolicyIsObserved = async (
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  selected: StudioApplicationFirstInstallSnapshot["selected"],
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
  saved: RecordTypeLifecyclePolicy,
): Promise<void> => {
  const current = await readCurrentFirstInstallCandidate(selector);
  if (!same(current.snapshot.history, history) || !same(current.snapshot.selected, selected))
    problem("conflict");
  if (current.snapshot.registrationState === "active_exact") return;
  if (current.snapshot.registrationState !== "provisioned_inactive" || current.snapshot.setup === null)
    problem("temporarily_unavailable");
  const observedTarget = currentTarget(current.snapshot.setup, target.storageContractId);
  if (observedTarget.policy.state !== "configured" ||
    !sameUuid(observedTarget.policy.policyId, saved.policyId) ||
    observedTarget.policy.policyRevision !== saved.policyRevision ||
    !same(observedTarget.policy.policyBody, visibleLifecyclePolicyBody(saved)))
    problem("temporarily_unavailable");
};

export const saveStudioApplicationFirstInstallPolicy = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationFirstInstallSaveCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !firstInstallCommandMatches(organizationId.data, command.data.selector, command.data.expected))
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "refused", stateMayHaveChanged: false,
    });

  let invocationStarted = false;
  try {
    const candidate = await readCurrentFirstInstallCandidate(command.data.selector);
    if (!sameFirstInstallExpectation(command.data.expected, candidate.snapshot))
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    if (candidate.snapshot.registrationState !== "provisioned_inactive" ||
      candidate.snapshot.setup === null)
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    const target = assertInitialPolicyTarget(candidate.snapshot.setup, command.data);
    const selectedPolicy = command.data.policy;
    let saved: RecordTypeLifecyclePolicy;
    if (selectedPolicy.action === "delete") {
      await runFirstInstallAppTransaction(candidate, command.data.expected,
        async (_transaction, _scope, _issuedAt, initial) => {
          const currentTargetValue = assertInitialPolicyTarget(initial.visibleSetup, command.data);
          if (!same(currentTargetValue, target)) problem("conflict");
        });
      invocationStarted = true;
      saved = await saveDeleteInitialPolicy(
        candidate,
        target,
        command.data.expectedBindingRevision,
        command.data.expectedSettingsRevision,
        selectedPolicy,
      );
    } else {
      const archivePolicy = selectedPolicy;
      saved = await runFirstInstallAppTransaction(candidate, command.data.expected,
        async (transaction, scope, issuedAt, initial) => {
          const currentTargetValue = assertInitialPolicyTarget(initial.visibleSetup, command.data);
          if (!same(currentTargetValue, target) || !same(initial.visibleSetup, candidate.snapshot.setup))
            problem("conflict");
          if (!workflowIsInExactRelease(
            initial.releaseSet, command.data.selector.rootId, archivePolicy.archiveWorkflowId,
          )) problem("refused");
          const currentRelease = await readFirstInstallCurrentRelease(
            transaction, firstInstallEnvironment, command.data.selector, initial.releaseSet,
          );
          await requireFirstInstallSetupUnchanged(
            transaction, scope, candidate.session, issuedAt, firstInstallEnvironment, command.data.selector,
            currentRelease, initial,
          );
          const retainedFence = await firstInstallAppCompletion(
            transaction, scope, candidate.session, issuedAt, firstInstallEnvironment, command.data.selector,
            command.data.expected.history, currentRelease, initial.context,
          );
          const option = await readSelectedInstallationArchiveConnection(
            transaction,
            command.data.selector.organizationId,
            command.data.selector.rootId,
            initial.visibleSetup.organizationLimits.allowedArchiveDestinations,
            {
              connectionInstanceId: archivePolicy.archiveConnectionInstanceId,
              destinationKey: archivePolicy.archiveDestination,
              expectedRevision: archivePolicy.expectedConnectionRevision,
            },
          );
          await completeFirstInstallConnectionRead(
            transaction,
            scope,
            candidate.session,
            issuedAt,
            firstInstallEnvironment,
            command.data.selector,
            command.data.expected.history,
            initial,
            retainedFence,
          );
          invocationStarted = true;
          return saveInitialArchiveWorkflowPolicy(
            transaction,
            initialPolicyTarget(candidate, currentTargetValue),
            candidate.releaseSet,
            currentTargetValue.sourceBindings.map((binding) => binding.bindingRevision),
            command.data.expectedBindingRevision,
            command.data.expectedSettingsRevision,
            archivePolicy,
            option,
          );
        }, true);
    }
    await freshSavedPolicyIsObserved(
      candidate.selector, candidate.history, candidate.snapshot.selected, target, saved,
    );
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "completed", action: "policy_saved", stateMayHaveChanged: true,
    });
  } catch (error) {
    return firstInstallCommandFailure(error, invocationStarted ? "unknown" : false);
  }
};

export const activateStudioApplicationFirstInstall = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationFirstInstallActivateCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !firstInstallCommandMatches(organizationId.data, command.data.selector, command.data.expected))
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "refused", stateMayHaveChanged: false,
    });

  let invocationStarted = false;
  try {
    const candidate = await readCurrentFirstInstallCandidate(command.data.selector);
    if (!sameFirstInstallExpectation(command.data.expected, candidate.snapshot))
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    if (candidate.snapshot.registrationState !== "provisioned_inactive" ||
      candidate.snapshot.setup === null ||
      candidate.snapshot.setup.targets.some((target) => target.policy.state !== "configured"))
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "refused", stateMayHaveChanged: false,
      });

    const coordinator = createFirstInstallCoordinator(
      firstInstallCoordinatorEnvironment(), candidate.selector, candidate.snapshot, candidate.releaseSet, "activate",
    );
    invocationStarted = true;
    const result = await coordinator.activate(candidate.session, {
      organizationId: candidate.selector.organizationId,
      applicationRootId: candidate.selector.rootId,
      applicationReleaseRevision: candidate.selector.releaseRevision,
      expectedActiveReleaseRevision: null,
    });
    verifyFirstInstallActivation(result, candidate.selector, candidate.releaseSet);
    let postCommit: { kind: "observed"; activeReleaseRevision: number } | { kind: "unavailable" } = {
      kind: "unavailable",
    };
    try {
      const observed = await readActiveObservation(
        candidate.selector.organizationId, candidate.selector.rootId, candidate.session,
      );
      postCommit = { kind: "observed", activeReleaseRevision: observed.releaseRevision };
    } catch (error) {
      console.error(`[studio] post-commit installation observation unavailable: ${describeFailure(error)}`);
      postCommit = { kind: "unavailable" };
    }
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "completed",
      action: result.outcome === "activated" ? "activated" : "unchanged",
      activeAtCommitRevision: result.installation.applicationReleaseRevision,
      postCommit,
      stateMayHaveChanged: true,
    });
  } catch (error) {
    return firstInstallCommandFailure(error, invocationStarted ? "unknown" : false);
  }
};
