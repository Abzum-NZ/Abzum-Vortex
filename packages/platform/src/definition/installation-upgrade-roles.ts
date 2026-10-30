import "server-only";

import type { createOrganizationAccessAdministrationService } from "../access/organization-access-administration-access";
import type { IdentitySession } from "../access/identity-access";
import type { FirstInstallFlowEnvironment } from "./installation-first-install-app";
import {
  accessForInstallationTarget,
  completeAtInstallationTarget,
} from "./installation-first-install-roles";
import {
  firstInstallLatestReleaseMatches,
  type ApplicationLatestRelease,
} from "./installation-first-install";
import { sameId } from "../catalogue/runtime-primitives";
import { canonicalJson } from "./canonical-json";
import { installationProblem, type ReceiptStep } from "./installation-authority";
import {
  acceptApplicationRoleChanges,
  applicationRoleChanges,
  inInstallerRequest,
  readInstallationRoles,
  readInstallationRolesIn,
  requireRoleAcceptanceAuthority,
  type ApplicationRoleChange,
} from "./installation-role-templates";
import {
  activateUpgradeRelease,
  type UpgradeEnvironment,
  type UpgradeSelector,
  type UpgradeState,
} from "./installation-upgrade";

type AccessAdministration = ReturnType<typeof createOrganizationAccessAdministrationService>;

const roleChangesJson = (changes: readonly ApplicationRoleChange[]): string =>
  canonicalJson(
    changes.map((change) => ({
      ...change,
      roleId: change.roleId ?? null,
      liveRevision: change.liveRevision ?? null,
      registrationRevision: change.registrationRevision ?? null,
    })),
  );

/** What an upgrade that accepts role changes needs beyond the upgrade itself. */
export type UpgradeRoleEnvironment = UpgradeEnvironment &
  Readonly<{
    accessAdministration: AccessAdministration;
    bindAccessAdministration: FirstInstallFlowEnvironment["bindAccessAdministration"];
  }>;

/**
 * The roles the selected version changes for this organisation, read under the upgrader's
 * installation authority (no roles.read grant): roles it adds and accepted roles whose permissions
 * differ from its templates, each with everything accepting would change. When the selected
 * version is the installed one, these are changes an earlier upgrade could not accept.
 */
export const readUpgradeRoleChanges = async (
  environment: UpgradeRoleEnvironment,
  session: IdentitySession,
  selector: UpgradeSelector,
  state: UpgradeState,
): Promise<readonly ApplicationRoleChange[]> => {
  const roles = await readInstallationRoles(
    environment,
    session,
    selector,
    environment.containsCustomComponents(state.selectedReleaseSet),
  );
  return applicationRoleChanges(roles.roles, state.selectedReleaseSet, [state.activeReleaseSet]);
};

/**
 * Completes the receipt when no role write is left: proves, in the completing transaction, that
 * every role the selected version offers already matches its template.
 */
const completeWhenRolesMatch = (
  environment: UpgradeRoleEnvironment,
  selector: UpgradeSelector,
  state: UpgradeState,
  session: IdentitySession,
  latest: ApplicationLatestRelease,
  complete: ReceiptStep,
): Promise<void> =>
  completeAtInstallationTarget(
    environment,
    { selector, releaseSet: state.selectedReleaseSet, state: "active_exact", latest },
    session,
    { organizationId: selector.organizationId },
    async (transaction, scope) => {
      const locked = await readInstallationRolesIn(
        transaction,
        scope,
        environment,
        selector,
        environment.containsCustomComponents(state.selectedReleaseSet),
      );
      if (applicationRoleChanges(locked.roles, state.selectedReleaseSet, []).length > 0)
        installationProblem("upgrade_role_revision_changed", "conflict");
      await complete(transaction);
    },
  );

type UpgradeWithRoleChangesResult = Readonly<{
  /** Source role ids whose role now matches the selected version's template. */
  accepted: readonly string[];
  /** Source role ids that could not be accepted; the App Store offers them again. */
  notAccepted: readonly string[];
}>;

/**
 * The one upgrade. It switches to the selected version (unless that is already the installed one)
 * and accepts exactly the role changes the upgrader reviewed, through the existing Access
 * operations under the upgrader's installation authority: Manage applications, the delegated
 * scope over every permission the roles confer and a primary sign-in within the last 15 minutes.
 * That authority is proved before anything is written, so a stale sign-in refuses the whole
 * action. A reviewed list or role revision that no longer matches is a conflict. All role
 * acceptances commit together after the switch, for exactly the selected version's templates.
 */
export const upgradeWithRoleChanges = async (
  environment: UpgradeRoleEnvironment,
  selector: UpgradeSelector,
  state: UpgradeState,
  session: IdentitySession,
  reviewedSourceRoleIds: readonly string[],
  reviewedChanges: readonly unknown[],
  latest: ApplicationLatestRelease,
  complete?: ReceiptStep,
): Promise<UpgradeWithRoleChangesResult> => {
  const listed = await readUpgradeRoleChanges(environment, session, selector, state);
  const reviewed = new Set(reviewedSourceRoleIds.map((id) => id.toLowerCase()));
  if (
    canonicalJson(
      listed.map(({ sourceRoleId, roleId, liveRevision, registrationRevision }) => ({
        sourceRoleId,
        roleId: roleId ?? null,
        liveRevision: liveRevision ?? null,
        registrationRevision: registrationRevision ?? null,
      })),
    ) !== canonicalJson(reviewedChanges) ||
    reviewed.size !== reviewedSourceRoleIds.length ||
    listed.length !== reviewed.size ||
    listed.some((change) => !reviewed.has(change.sourceRoleId.toLowerCase()))
  )
    installationProblem("upgrade_role_changes_not_reviewed", "conflict");
  const switching =
    state.selectedReleaseSet.application.releaseRevision !==
    state.active.applicationReleaseRevision;
  if (!switching && listed.length === 0)
    installationProblem("upgrade_nothing_to_change", "conflict");
  await requireRoleAcceptanceAuthority(
    environment,
    session,
    selector,
    environment.containsCustomComponents(state.selectedReleaseSet),
    state.selectedReleaseSet,
    listed.map((change) => change.sourceRoleId),
  );
  if (switching)
    await activateUpgradeRelease(
      environment,
      selector,
      state,
      session,
      async (transaction, scope) => {
        await firstInstallLatestReleaseMatches(transaction, selector, latest);
        const locked = await readInstallationRolesIn(
          transaction,
          scope,
          environment,
          selector,
          environment.containsCustomComponents(state.selectedReleaseSet),
        );
        const lockedChanges = applicationRoleChanges(locked.roles, state.selectedReleaseSet, [
          state.activeReleaseSet,
        ]);
        if (roleChangesJson(lockedChanges) !== roleChangesJson(listed))
          installationProblem("upgrade_role_revision_changed", "conflict");
      },
      // With no role to accept, activating is the upgrade's last step.
      listed.length === 0 ? complete : undefined,
    );
  const accessAdministration = accessForInstallationTarget(
    environment,
    { selector, releaseSet: state.selectedReleaseSet, state: "active_exact", latest },
    complete === undefined
      ? undefined
      : { write: "accept_roles", step: (transaction) => complete(transaction) },
  );
  const result = await acceptApplicationRoleChanges(
    { ...environment, accessAdministration },
    session,
    selector,
    state.selectedReleaseSet,
    listed.map((change) =>
      switching ? { ...change, liveRevision: change.registrationRevision } : change,
    ),
  );
  if (complete !== undefined && listed.length > 0 && !result.wrote)
    await completeWhenRolesMatch(environment, selector, state, session, latest, complete);
  return result;
};

/** Resume the role acceptance after the reviewed release has already been activated. */
export const resumeUpgradeRoleChanges = async (
  environment: UpgradeRoleEnvironment,
  selector: UpgradeSelector,
  state: UpgradeState,
  session: IdentitySession,
  reviewedSourceRoleIds: readonly string[],
  reviewedChanges: readonly Readonly<{
    sourceRoleId: string;
    roleId: string | null;
    liveRevision: number | null;
    registrationRevision: number | null;
  }>[],
  registeredByUpgrade: boolean,
  latest: ApplicationLatestRelease,
  complete?: ReceiptStep,
): Promise<UpgradeWithRoleChangesResult> => {
  const reviewed = new Set(reviewedSourceRoleIds.map((id) => id.toLowerCase()));
  if (
    reviewed.size !== reviewedSourceRoleIds.length ||
    reviewedChanges.length !== reviewed.size ||
    new Set(reviewedChanges.map((change) => change.sourceRoleId.toLowerCase())).size !==
      reviewed.size ||
    reviewedChanges.some((change) => !reviewed.has(change.sourceRoleId.toLowerCase()))
  )
    installationProblem("upgrade_role_changes_not_reviewed", "conflict");
  const roles = await inInstallerRequest(environment, session, selector, (transaction, scope) =>
    readInstallationRolesIn(
      transaction,
      scope,
      environment,
      selector,
      environment.containsCustomComponents(state.selectedReleaseSet),
    ),
  );
  const listed = applicationRoleChanges(roles.roles, state.selectedReleaseSet, []);
  if (listed.some((change) => !reviewed.has(change.sourceRoleId.toLowerCase())))
    installationProblem("upgrade_role_changes_not_reviewed", "conflict");
  const alreadyAccepted: string[] = [];
  for (const expected of reviewedChanges) {
    const role = roles.roles.find((candidate) =>
      sameId(candidate.sourceRoleId, expected.sourceRoleId),
    );
    const pending = listed.find((change) => sameId(change.sourceRoleId, expected.sourceRoleId));
    if (expected.roleId === null) {
      if (expected.liveRevision !== null || expected.registrationRevision !== null)
        installationProblem("upgrade_role_revision_changed", "conflict");
      if (role === undefined && pending !== undefined) continue;
      if (role?.lifecycle === "active" && role.liveRevision === 1 && pending === undefined) {
        alreadyAccepted.push(expected.sourceRoleId);
        continue;
      }
    } else if (
      role !== undefined &&
      sameId(role.roleId, expected.roleId) &&
      expected.liveRevision !== null &&
      expected.registrationRevision !== null
    ) {
      const startingRevision = registeredByUpgrade
        ? expected.registrationRevision
        : expected.liveRevision;
      if (pending !== undefined && role.liveRevision === startingRevision) continue;
      if (
        pending === undefined &&
        role.lifecycle === "active" &&
        (role.liveRevision === startingRevision || role.liveRevision === startingRevision + 1)
      ) {
        alreadyAccepted.push(expected.sourceRoleId);
        continue;
      }
    }
    installationProblem("upgrade_role_revision_changed", "conflict");
  }
  await requireRoleAcceptanceAuthority(
    environment,
    session,
    selector,
    environment.containsCustomComponents(state.selectedReleaseSet),
    state.selectedReleaseSet,
    reviewedSourceRoleIds,
  );
  const accessAdministration = accessForInstallationTarget(
    environment,
    { selector, releaseSet: state.selectedReleaseSet, state: "active_exact", latest },
    complete === undefined
      ? undefined
      : { write: "accept_roles", step: (transaction) => complete(transaction) },
  );
  const result = await acceptApplicationRoleChanges(
    { ...environment, accessAdministration },
    session,
    selector,
    state.selectedReleaseSet,
    listed,
  );
  if (complete !== undefined && !result.wrote)
    await completeWhenRolesMatch(environment, selector, state, session, latest, complete);
  return { accepted: [...alreadyAccepted, ...result.accepted], notAccepted: result.notAccepted };
};
