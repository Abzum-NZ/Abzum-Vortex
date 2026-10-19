import "server-only";

import type { createOrganizationAccessAdministrationService } from "../access/index";
import { canonicalJson, type IdentitySession } from "../schema";
import { backfillActivatedApplication } from "../records/derived-field-backfill";
import { installationProblem } from "./installation-authority";
import {
  acceptApplicationRoleChanges,
  applicationRoleChanges,
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
  Readonly<{ accessAdministration: AccessAdministration }>;

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

export type UpgradeWithRoleChangesResult = Readonly<{
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
): Promise<UpgradeWithRoleChangesResult> => {
  const listed = await readUpgradeRoleChanges(environment, session, selector, state);
  const reviewed = new Set(reviewedSourceRoleIds.map((id) => id.toLowerCase()));
  if (
    canonicalJson(
      listed.map(({ sourceRoleId, roleId, liveRevision }) => ({
        sourceRoleId,
        roleId: roleId ?? null,
        liveRevision: liveRevision ?? null,
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
    );
  try {
    return await acceptApplicationRoleChanges(
      environment,
      session,
      selector,
      state.selectedReleaseSet,
      listed.map((change) =>
        switching ? { ...change, liveRevision: change.registrationRevision } : change,
      ),
    );
  } finally {
    // Working out the derived values the new release brought comes after every commit of the
    // upgrade, the role acceptances included; it never undoes them and logs its own failure.
    if (switching)
      await backfillActivatedApplication(environment.requests, session, {
        organizationId: selector.organizationId,
        applicationRootId: selector.rootId,
      });
  }
};
