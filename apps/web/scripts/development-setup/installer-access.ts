import {
  createOrganizationAccessAdministrationService,
  fingerprintPermissionMeaning,
  platformPermissionCatalogue,
  platformPermissionCatalogueOwnerId,
  prepareOrganizationRoleChangeEvidence,
} from "@vortex/access";
import {
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  organizationRoleChangePreparationSchema,
  organizationSelectionCandidateSchema,
  type IdentityAuthorityId,
} from "@vortex/contracts";
import { nominatedOwnerSession } from "./development-authority";
import type { DevelopmentSetupManifest } from "./manifest";
import type { SetupState } from "./state";

/**
 * A freshly provisioned steward administers roles and assignments but holds no application
 * installation permission: `platform.organization.applications.manage` is a separate platform
 * permission that only a role grants. Before anything can be installed, the nominated steward
 * therefore uses their own role and assignment authority, through the ordinary protected Access
 * administration operations (the ones the IAM application drives), to create one explicit custom
 * role that holds exactly that permission and assign it to themselves. The role and its assignment
 * stay visible in the organisation's access administration afterwards.
 */

const installPermissionKey = "platform.organization.applications.manage";
/** The registration revision of the current shipped platform catalogue (1.4.0). */
const currentPlatformRegistrationRevision = 6;

export type InstallerAccessFacts = Readonly<{
  identityAuthorityId: IdentityAuthorityId;
  organizationId: string;
  stewardIdentityId: string;
  stewardOrganizationAccountId: string;
  manifest: DevelopmentSetupManifest;
  state: SetupState;
}>;

/** Creates and assigns the installer role once; a re-run finds it recorded and does nothing. */
export const grantStewardInstallerRole = async (
  facts: InstallerAccessFacts,
  log: (message: string) => void,
): Promise<void> => {
  if (facts.state.installerRoleGranted) return;
  const { installerRole } = facts.manifest;
  const declaration = platformPermissionCatalogue.permissions.find(
    (permission) => permission.key === installPermissionKey,
  );
  if (declaration === undefined)
    throw new Error(`Platform permission ${installPermissionKey} is not shipped`);

  const administration = createOrganizationAccessAdministrationService({
    identityAuthorityId: facts.identityAuthorityId,
    roleAssignmentId: () => installerRole.roleAssignmentId,
  });
  const selection = organizationSelectionCandidateSchema.parse({
    organizationId: facts.organizationId,
  });

  const evidence = prepareOrganizationRoleChangeEvidence(
    organizationRoleChangePreparationSchema.parse({
      candidate: {
        operation: "create_custom",
        organizationId: facts.organizationId,
        roleId: installerRole.roleId,
        key: installerRole.roleKey,
        label: "Application installer",
        description:
          "Installs and upgrades applications. Granted to the first owner by the local development setup.",
        privilegeClassification: "privileged",
        assignmentPolicy: { kind: "standing" },
        permissions: [
          {
            kind: "exact",
            ownerKind: "platform",
            ownerId: platformPermissionCatalogueOwnerId,
            permissionId: declaration.permissionId,
            acceptedRegistrationRevision: currentPlatformRegistrationRevision,
            catalogueFingerprint: platformPermissionCatalogue.catalogueFingerprint,
            continuityRevision: 1,
            meaningFingerprint: fingerprintPermissionMeaning(
              "platform",
              platformPermissionCatalogueOwnerId,
              declaration,
            ),
          },
        ],
      },
    }),
  );
  const created = await administration.createCustomRole(
    nominatedOwnerSession(facts.stewardIdentityId),
    selection,
    changeOrganizationAdministrationRoleAuthorityCommandSchema.parse({ evidence }),
  );
  if (created.kind !== "available")
    throw new Error(`The installer role could not be created (${created.kind})`);

  const assigned = await administration.assignRoleAssignment(
    nominatedOwnerSession(facts.stewardIdentityId),
    selection,
    assignOrganizationAdministrationRoleAssignmentCommandSchema.parse({
      roleId: installerRole.roleId,
      expectedRoleRevision: created.value.role.liveRevision,
      assigneeKind: "organization_account",
      organizationAccountId: facts.stewardOrganizationAccountId,
      assignmentKind: "standing",
      startsAt: new Date(Date.now() - 1_000).toISOString(),
    }),
  );
  if (assigned.kind !== "available")
    throw new Error(`The installer role could not be assigned (${assigned.kind})`);

  facts.state.installerRoleGranted = true;
  facts.state.save();
  log(`granted the ${installerRole.roleKey} role to the first owner`);
};
