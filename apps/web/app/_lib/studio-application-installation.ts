import "server-only";

import {
  canonicalJson,
  describeFailure,
  organizationIdSchema,
  sameId,
  type IdentitySession,
  type SelectedOrganizationScope,
} from "@vortex/platform/schema";
import {
  FirstInstallUnavailable,
  installationProblem,
  type InstallationProblemShape,
  type FirstInstallEnvironment,
  type FirstInstallFlowEnvironment,
  readUpgradeRoleRevisions,
  upgradeWithRoleRevisions,
  classifyInstallationFailure,
  readUpgradeActiveObservation,
  readUpgradeAuthorizedState,
  sameUpgradeSelectedSnapshot,
  sameUpgradeSnapshotState,
  type UpgradeRoleEnvironment,
  type UpgradeReleaseIdentity,
  type UpgradeState,
  activateFirstInstall,
  createFirstInstallCoordinator,
  createOrganizationAccessAdministrationService,
  readCurrentFirstInstallCandidate,
} from "@vortex/platform/server";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue, releaseSetContainsCustomComponents } from "./definition-catalogue";
import { humanOrganizationRequestDependencies, humanOrganizationRequests } from "./server-composition";
import {
  inspectStudioApplicationReleaseHistory,
  loadStudioApplicationHistoryAccess,
} from "./studio-application-history";
import {
  studioApplicationInstallationCommandResultSchema,
  studioApplicationInstallationCommandSchema,
  studioApplicationInstallationLoadResultSchema,
  studioApplicationInstallationReleaseIdentitySchema,
  studioApplicationInstallationSelectorSchema,
  studioApplicationInstallationSnapshotSchema,
  studioApplicationFirstInstallActivateCommandSchema,
  studioApplicationFirstInstallCommandResultSchema,
  studioApplicationFirstInstallLoadResultSchema,
  studioApplicationFirstInstallPrepareCommandSchema,
  studioApplicationFirstInstallSelectorSchema,
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

const firstInstallFlowEnvironment = (): FirstInstallFlowEnvironment => ({
  ...firstInstallEnvironment,
  requests: humanOrganizationRequests(),
  accessAdministration: createOrganizationAccessAdministrationService(humanOrganizationRequestDependencies()),
  history: {
    readAccess: loadStudioApplicationHistoryAccess,
    inspectRelease: inspectStudioApplicationReleaseHistory,
  },
});

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
  if (resolved.kind === "temporarily_unavailable")
    return installationProblem("identity_session_unavailable", "temporarily_unavailable");
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

const upgradeEnvironment = (): UpgradeRoleEnvironment => ({
  requests: humanOrganizationRequests(),
  catalogue: installedReleaseCatalogue,
  permissions: platformPermissionSource,
  containsCustomComponents: releaseSetContainsCustomComponents,
  accessAdministration: createOrganizationAccessAdministrationService(humanOrganizationRequestDependencies()),
});

/** The selected version's release note for the confirmation; a failed read is logged and shows none. */
const readReleaseNote = async (selector: StudioApplicationInstallationSelector): Promise<string | null> => {
  const access = await loadStudioApplicationHistoryAccess(selector.organizationId, selector.rootId);
  if (access.kind !== "available") {
    console.error(`[studio] upgrade release note unavailable: history ${access.kind}`);
    return null;
  }
  const inspected = await inspectStudioApplicationReleaseHistory(selector.organizationId, {
    rootId: selector.rootId,
    expected: access.snapshot,
    releaseRevision: selector.releaseRevision,
  });
  if (inspected.kind !== "available") {
    console.error(`[studio] upgrade release note unavailable: release ${inspected.kind}`);
    return null;
  }
  return inspected.metadata.releaseNote;
};

/**
 * The roles the upgrade would leave waiting for acceptance. An upgrader who may not read roles
 * still upgrades; the roles are then accepted in role administration, so this read failing is logged, not fatal.
 */
const readRoleRevisions = async (
  selector: StudioApplicationInstallationSelector,
  authorized: AuthorizedState,
  session: IdentitySession,
) => {
  if (authorized.snapshot.selected.releaseRevision <= authorized.snapshot.active.releaseRevision)
    return { kind: "listed" as const, roles: [] };
  try {
    const revisions = await readUpgradeRoleRevisions(upgradeEnvironment(), session, selector, authorized.state);
    return {
      kind: "listed" as const,
      roles: revisions.map((revision) => ({
        roleId: revision.roleId,
        label: revision.label,
        changes: revision.changes,
      })),
    };
  } catch (error) {
    console.error(`[studio] upgrade role revisions unavailable: ${describeFailure(error)}`);
    return { kind: "unavailable" as const };
  }
};

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
      roleRevisions: await readRoleRevisions(selector.data, authorized, session),
      releaseNote: await readReleaseNote(selector.data),
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
        acceptedRoleIds: [],
      });
    }
    if (!sameUpgradeSnapshotState(command.data.expected, currentSnapshot))
      return toCommandFailure({ kind: "conflict" }, false);

    invocationStarted = true;
    const { activation, acceptedRoleIds } = await upgradeWithRoleRevisions(
      upgradeEnvironment(),
      command.data.selector,
      current.state,
      session,
      command.data.acceptRoleIds,
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
      acceptedRoleIds,
    });
  } catch (error) {
    return toCommandFailure(classifyInstallationFailure(error), invocationStarted ? "unknown" : false);
  }
};


const firstInstallLoadFailure = (error: unknown): StudioApplicationFirstInstallLoadResult => {
  if (error instanceof FirstInstallUnavailable)
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "unavailable", reason: error.reason });
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

const firstInstallSession = async (): Promise<IdentitySession> => {
  const session = await exactSession();
  if (session === undefined) return installationProblem("identity_session_missing", "refused");
  return session;
};

const firstInstallCommandMatches = (
  organizationId: string,
  selector: StudioApplicationFirstInstallSelector,
  expected: StudioApplicationFirstInstallSnapshot,
): boolean => sameUuid(organizationId, selector.organizationId) &&
  sameUuid(expected.organizationId, selector.organizationId) &&
  sameUuid(expected.rootId, selector.rootId) &&
  expected.selected.releaseRevision === selector.releaseRevision;

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
    const current = await readCurrentFirstInstallCandidate(
      firstInstallFlowEnvironment(), await firstInstallSession(), selector.data,
    );
    return studioApplicationFirstInstallLoadResultSchema.parse({
      kind: "available",
      snapshot: current.snapshot,
    });
  } catch (error) {
    return firstInstallLoadFailure(error);
  }
};

export const prepareStudioApplicationFirstInstall = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationFirstInstallPrepareCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !firstInstallCommandMatches(organizationId.data, command.data.selector, command.data.expected))
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "refused", stateMayHaveChanged: false,
    });
  let invocationStarted = false;
  try {
    const environment = firstInstallFlowEnvironment();
    const current = await readCurrentFirstInstallCandidate(
      environment, await firstInstallSession(), command.data.selector, command.data.expected,
    );
    if (current.snapshot.registrationState !== "unprepared" &&
      current.snapshot.registrationState !== "registration_aligned_partial")
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    const coordinator = createFirstInstallCoordinator(
      environment, current.selector, current.snapshot, current.releaseSet, "prepare",
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
    const environment = firstInstallFlowEnvironment();
    const candidate = await readCurrentFirstInstallCandidate(
      environment, await firstInstallSession(), command.data.selector, command.data.expected,
    );
    if (candidate.snapshot.registrationState !== "provisioned_inactive")
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "refused", stateMayHaveChanged: false,
      });

    invocationStarted = true;
    const result = await activateFirstInstall(environment, candidate, command.data.memberRole);
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
