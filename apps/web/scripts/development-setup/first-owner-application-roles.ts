import {
  acceptedApplicationRoleKey,
  createHumanOrganizationRequestService,
  createOrganizationAccessAdministrationService,
  readInstallationRoles,
  releaseRoleTemplates,
} from "@vortex/platform/server";
import {
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  organizationSelectionCandidateSchema,
  prepareOrganizationAdministrationRoleChangeCommandSchema,
  prepareOrganizationAdministrationRoleRevisionAcceptanceCommandSchema,
  type IdentityAuthorityId,
  type OrganizationAdministrationRoleSummary,
  sameId,
} from "@vortex/platform/schema";
import { releaseSetContainsCustomComponents } from "../../app/_lib/definition-catalogue";
import { platformPermissionSource } from "../../app/_lib/platform-permission-source";
import { nominatedOwnerSession, type SystemContextFacts } from "./development-authority";
import { readActiveReleaseRevision, readReleaseSet } from "./install";
import type { PublishedRelease } from "./state";

type AccessAdministration = ReturnType<typeof createOrganizationAccessAdministrationService>;
type OwnerSession = ReturnType<typeof nominatedOwnerSession>;
type OrganizationSelection = ReturnType<typeof organizationSelectionCandidateSchema.parse>;
type RoleTemplate = ReturnType<typeof releaseRoleTemplates>[number];
type InstalledRole = Awaited<ReturnType<typeof readInstallationRoles>>["roles"][number];

/** The accepted role a grant needs: its identity, live revision, lifecycle and assignment policy. */
type GrantableRole = Pick<
  InstalledRole,
  "roleId" | "label" | "liveRevision" | "lifecycle" | "assignmentPolicy"
>;

export type FirstOwnerApplicationRoleFacts = Readonly<{
  identityAuthorityId: IdentityAuthorityId;
  system: SystemContextFacts;
  stewardIdentityId: string;
  stewardOrganizationAccountId: string;
  applicationKeys: readonly string[];
  releases: ReadonlyMap<string, PublishedRelease>;
}>;

const grantable = (role: OrganizationAdministrationRoleSummary): GrantableRole => ({
  roleId: role.roleId,
  label: role.label,
  liveRevision: role.liveRevision,
  lifecycle: role.lifecycle,
  assignmentPolicy: role.assignmentPolicy.kind,
});

/** An upgrade that changes a shipped role template leaves the accepted role to accept again. */
const acceptedRevision = async (
  administration: AccessAdministration,
  session: OwnerSession,
  selection: OrganizationSelection,
  role: GrantableRole,
): Promise<GrantableRole> => {
  const prepared = await administration.prepareApplicationRoleRevisionAcceptance(
    session,
    selection,
    prepareOrganizationAdministrationRoleRevisionAcceptanceCommandSchema.parse({
      operation: "accept_application_role_revision",
      roleId: role.roleId,
      expectedRoleRevision: role.liveRevision,
      acceptBroadenedAuthority: "accept",
    }),
  );
  if (prepared.kind !== "available")
    throw new Error(`Role revision of ${role.label} could not be prepared (${prepared.kind})`);
  const result = await administration.acceptApplicationRoleRevision(
    session,
    selection,
    changeOrganizationAdministrationRoleAuthorityCommandSchema.parse({ evidence: prepared.value }),
  );
  if (result.kind !== "available" || result.value.role.lifecycle !== "active")
    throw new Error(`Role revision of ${role.label} could not be accepted (${result.kind})`);
  return grantable(result.value.role);
};

const acceptedRole = async (
  administration: AccessAdministration,
  session: OwnerSession,
  selection: OrganizationSelection,
  applicationRootId: string,
  template: RoleTemplate,
): Promise<GrantableRole> => {
  const prepared = await administration.prepareRoleChange(
    session,
    selection,
    prepareOrganizationAdministrationRoleChangeCommandSchema.parse({
      operation: "accept_new_application_role",
      roleKey: acceptedApplicationRoleKey(applicationRootId, template.sourceRoleId, template.key),
      label: template.name,
      description: `Accepted from the ${template.key} role template by local development setup.`,
      privilegeClassification: template.privileged ? "privileged" : "standard",
      templateApplicationRootId: applicationRootId,
      sourceRoleId: template.sourceRoleId,
      acceptBroadenedAuthority: "accept",
    }),
  );
  if (prepared.kind !== "available")
    throw new Error(`Role template ${template.key} could not be prepared (${prepared.kind})`);

  const result = await administration.acceptApplicationRoleTemplate(
    session,
    selection,
    changeOrganizationAdministrationRoleAuthorityCommandSchema.parse({
      evidence: prepared.value,
    }),
  );
  if (result.kind !== "available")
    throw new Error(`Role template ${template.key} could not be accepted (${result.kind})`);
  const role = result.value.role;
  if (
    role.lifecycle !== "active" ||
    role.source.kind !== "application" ||
    !sameId(role.source.applicationRootId, applicationRootId) ||
    !sameId(role.source.sourceRoleId, template.sourceRoleId)
  )
    throw new Error(`Accepted role for ${template.key} did not match its current template`);
  return grantable(role);
};

/**
 * Accepts every role template of each installed application and gives the first owner a standing
 * assignment of each. The templates come from the release the application runs, exactly as an App
 * Store install derives them, and the accepted roles with the owner's own live standing assignment
 * come from the App Store's installer role read.
 */
export const grantFirstOwnerApplicationRoles = async (
  facts: FirstOwnerApplicationRoleFacts,
  log: (message: string) => void,
): Promise<void> => {
  const administration = createOrganizationAccessAdministrationService({
    identityAuthorityId: facts.identityAuthorityId,
  });
  const installerEnvironment = {
    requests: createHumanOrganizationRequestService({
      identityAuthorityId: facts.identityAuthorityId,
    }),
    permissions: platformPermissionSource,
  };
  const session = nominatedOwnerSession(facts.stewardIdentityId);
  const selection = organizationSelectionCandidateSchema.parse({
    organizationId: facts.system.organizationId,
  });
  const applicationKeyByRootId = new Map<string, string>();
  for (const applicationKey of facts.applicationKeys) {
    const release = facts.releases.get(applicationKey);
    if (release === undefined)
      throw new Error(`No published release recorded for installed application ${applicationKey}`);
    const rootId = release.rootId.toLowerCase();
    if (applicationKeyByRootId.has(rootId))
      throw new Error(`More than one installed application uses release root ${release.rootId}`);
    applicationKeyByRootId.set(rootId, applicationKey);
  }

  let ensuredGrants = 0;
  for (const [rootId, applicationName] of applicationKeyByRootId) {
    const revision = await readActiveReleaseRevision(facts, applicationName, rootId);
    if (revision === null)
      throw new Error(`Installed application ${applicationName} has no active release`);
    const releaseSet = await readReleaseSet(facts.system, rootId, revision);
    const templates = releaseRoleTemplates(releaseSet);
    if (templates.length === 0)
      throw new Error(
        `No registered role templates were available for installed application ${applicationName}`,
      );
    const installed = await readInstallationRoles(
      installerEnvironment,
      session,
      { organizationId: facts.system.organizationId, rootId },
      releaseSetContainsCustomComponents(releaseSet),
    );

    for (const template of templates) {
      const current = installed.roles.find((role) =>
        sameId(role.sourceRoleId, template.sourceRoleId),
      );
      let role: GrantableRole;
      if (current === undefined) {
        role = await acceptedRole(administration, session, selection, rootId, template);
        log(`accepted ${applicationName} role template ${template.key}`);
      } else role = current;
      if (role.lifecycle === "acceptance_required") {
        role = await acceptedRevision(administration, session, selection, role);
        log(`accepted the revised role template ${template.key}`);
      }
      if (role.lifecycle !== "active")
        throw new Error(
          `Accepted role ${role.label} from template ${template.key} is ${role.lifecycle}`,
        );
      if (role.assignmentPolicy !== "standing")
        throw new Error(
          `Role ${role.label} from template ${template.key} requires activation and cannot open an application immediately`,
        );

      if (current?.installerAssignment != null && sameId(current.roleId, role.roleId)) {
        log(`first owner already holds ${applicationName} role ${role.label}`);
        ensuredGrants += 1;
        continue;
      }

      const assigned = await administration.assignRoleAssignment(
        session,
        selection,
        assignOrganizationAdministrationRoleAssignmentCommandSchema.parse({
          roleId: role.roleId,
          expectedRoleRevision: role.liveRevision,
          assigneeKind: "organization_account",
          organizationAccountId: facts.stewardOrganizationAccountId,
          assignmentKind: "standing",
          startsAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      );
      if (assigned.kind !== "available" || !("assignment" in assigned.value))
        throw new Error(
          `Role ${role.label} for ${applicationName} could not be assigned to the first owner (${assigned.kind})`,
        );
      if (
        assigned.value.assignment.state !== "live" ||
        assigned.value.assignment.temporalState !== "active" ||
        assigned.value.assignment.assignmentKind !== "standing" ||
        !sameId(assigned.value.assignment.role.roleId, role.roleId) ||
        assigned.value.assignment.assignee.kind !== "organization_account" ||
        !sameId(
          assigned.value.assignment.assignee.organizationAccountId,
          facts.stewardOrganizationAccountId,
        )
      )
        throw new Error(`The protected assignment for ${role.label} did not match the first owner`);
      log(`granted ${applicationName} role ${role.label} to the first owner`);
      ensuredGrants += 1;
    }
  }

  log(
    `ensured ${ensuredGrants} application role grants for the first owner across ${applicationKeyByRootId.size} installed applications`,
  );
};
