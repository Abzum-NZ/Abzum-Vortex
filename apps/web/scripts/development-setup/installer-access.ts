import {
  createOrganizationAccessAdministrationService,
  prepareOrganizationRoleChangeEvidence,
} from "@vortex/platform/server";
import { fingerprintCanonicalValue } from "@vortex/platform/server";
import { platformPermissionDeclarations, platformPermissionOwnerId } from "@vortex/definitions";
import {
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  organizationRoleChangePreparationSchema,
  organizationSelectionCandidateSchema,
  type IdentityAuthorityId,
} from "@vortex/platform/schema";
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
 * stay visible in the organisation's access administration afterwards. After application
 * installation, local setup accepts and assigns the installed application roles through those same
 * protected Access administration operations.
 */

const installPermissionKey = "platform.organization.applications.manage";
/** The current shipped platform permission declaration set retains registration revision 6. */
const currentPlatformRegistrationRevision = 6;
const sourceMetadataKeys = new Set(["stewardMinimum"]);
const currentPlatformPermissionCatalogueFingerprint = fingerprintCanonicalValue({
  catalogueVersion: "1.4.0",
  ownerKind: "platform",
  ownerId: platformPermissionOwnerId,
  permissions: platformPermissionDeclarations.map((permission) =>
    Object.fromEntries(Object.entries(permission).filter(([key]) => !sourceMetadataKeys.has(key))),
  ),
});

export type InstallerAccessFacts = Readonly<{
  identityAuthorityId: IdentityAuthorityId;
  organizationId: string;
  stewardIdentityId: string;
  stewardOrganizationAccountId: string;
  manifest: DevelopmentSetupManifest;
  state: SetupState;
}>;

type SetupRole = Readonly<{ roleKey: string; roleId: string; roleAssignmentId: string }>;

const createAndAssignPlatformRole = async (
  facts: InstallerAccessFacts,
  role: SetupRole,
  label: string,
  description: string,
  permissionKeys: readonly string[],
): Promise<void> => {
  const permissions = permissionKeys.map((key) => {
    const declaration = platformPermissionDeclarations.find((permission) => permission.key === key);
    if (declaration === undefined) throw new Error(`Platform permission ${key} is not shipped`);
    return {
      kind: "exact" as const,
      ownerKind: "platform" as const,
      ownerId: platformPermissionOwnerId,
      permissionId: declaration.permissionId,
      acceptedRegistrationRevision: currentPlatformRegistrationRevision,
      catalogueFingerprint: currentPlatformPermissionCatalogueFingerprint,
      continuityRevision: 1,
    };
  });
  const administration = createOrganizationAccessAdministrationService({
    identityAuthorityId: facts.identityAuthorityId,
    roleAssignmentId: () => role.roleAssignmentId,
  });
  const selection = organizationSelectionCandidateSchema.parse({
    organizationId: facts.organizationId,
  });
  const preparedAuthorization = prepareOrganizationRoleChangeEvidence(
    organizationRoleChangePreparationSchema.parse({
      candidate: {
        operation: "create_custom",
        organizationId: facts.organizationId,
        roleId: role.roleId,
        key: role.roleKey,
        label,
        description,
        privilegeClassification: "privileged",
        assignmentPolicy: { kind: "standing" },
        permissions,
      },
    }),
  );
  const created = await administration.createCustomRole(
    nominatedOwnerSession(facts.stewardIdentityId),
    selection,
    changeOrganizationAdministrationRoleAuthorityCommandSchema.parse({
      evidence: preparedAuthorization,
    }),
  );
  if (created.kind !== "available")
    throw new Error(`The ${role.roleKey} role could not be created (${created.kind})`);
  const assigned = await administration.assignRoleAssignment(
    nominatedOwnerSession(facts.stewardIdentityId),
    selection,
    assignOrganizationAdministrationRoleAssignmentCommandSchema.parse({
      roleId: role.roleId,
      expectedRoleRevision: created.value.role.liveRevision,
      assigneeKind: "organization_account",
      organizationAccountId: facts.stewardOrganizationAccountId,
      assignmentKind: "standing",
      startsAt: new Date(Date.now() - 1_000).toISOString(),
    }),
  );
  if (assigned.kind !== "available" || !("assignment" in assigned.value))
    throw new Error(`The ${role.roleKey} role could not be assigned (${assigned.kind})`);
};

/** Creates and assigns the installer role once; a re-run finds it recorded and does nothing. */
export const grantStewardInstallerRole = async (
  facts: InstallerAccessFacts,
  log: (message: string) => void,
): Promise<void> => {
  if (facts.state.installerRoleGranted) return;
  const role = facts.manifest.installerRole;
  await createAndAssignPlatformRole(
    facts,
    role,
    "Application installer",
    "Installs and upgrades applications. Granted to the first owner by the local development setup.",
    [installPermissionKey],
  );
  facts.state.installerRoleGranted = true;
  facts.state.save();
  log(`granted the ${role.roleKey} role to the first owner`);
};

/** Lets the nominated steward edit drafts and publish releases through the protected Studio APIs. */
export const grantStewardDefinitionRole = async (
  facts: InstallerAccessFacts,
  log: (message: string) => void,
): Promise<void> => {
  if (facts.state.definitionRoleGranted) return;
  const role = facts.manifest.definitionRole;
  await createAndAssignPlatformRole(
    facts,
    role,
    "Definition author and publisher",
    "Creates and changes application and module drafts and publishes immutable definition releases.",
    [
      "platform.organization.definition_drafts.manage",
      "platform.organization.definition_releases.manage",
      "platform.records.views.share",
    ],
  );
  facts.state.definitionRoleGranted = true;
  facts.state.save();
  log(`granted the ${role.roleKey} role to the first owner`);
};
