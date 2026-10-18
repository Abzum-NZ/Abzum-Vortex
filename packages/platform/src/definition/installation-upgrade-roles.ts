import "server-only";

import type { createOrganizationAccessAdministrationService } from "../access/index";
import type { IdentitySession } from "../schema";
import { installationProblem } from "./installation-authority";
import {
  acceptApplicationRoleChanges,
  applicationRoleChanges,
  readInstallationRoles,
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
 * action and nothing changes. A reviewed list that no longer matches is a conflict. Each
 * acceptance then commits in its own transaction after the switch, for exactly the template of
 * the selected version.
 */
export const upgradeWithRoleChanges = async (
  environment: UpgradeRoleEnvironment,
  selector: UpgradeSelector,
  state: UpgradeState,
  session: IdentitySession,
  reviewedSourceRoleIds: readonly string[],
): Promise<UpgradeWithRoleChangesResult> => {
  const listed = await readUpgradeRoleChanges(environment, session, selector, state);
  const reviewed = new Set(reviewedSourceRoleIds.map((id) => id.toLowerCase()));
  if (
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
  if (switching) await activateUpgradeRelease(environment, selector, state, session);
  return acceptApplicationRoleChanges(
    environment,
    session,
    selector,
    state.selectedReleaseSet,
    listed,
  );
};
