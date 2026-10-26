import {
  acceptedApplicationRoleKey,
  createOrganizationAccessAdministrationService,
  releaseRoleTemplates,
} from "@vortex/platform/server";
import {
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  organizationSelectionCandidateSchema,
  prepareOrganizationAdministrationRoleChangeCommandSchema,
  prepareOrganizationAdministrationRoleRevisionAcceptanceCommandSchema,
  type IdentityAuthorityId,
  type OrganizationAdministrationRoleAssignment,
  type OrganizationAdministrationRoleSummary,
  sameId,
} from "@vortex/platform/schema";
import { nominatedOwnerSession, type SystemContextFacts } from "./development-authority";
import { readActiveReleaseRevision, readReleaseSet } from "./install";
import type { PublishedRelease } from "./state";

type AccessAdministration = ReturnType<typeof createOrganizationAccessAdministrationService>;
type OwnerSession = ReturnType<typeof nominatedOwnerSession>;
type OrganizationSelection = ReturnType<typeof organizationSelectionCandidateSchema.parse>;
type RoleTemplate = ReturnType<typeof releaseRoleTemplates>[number] &
  Readonly<{ applicationRootId: string }>;

export type FirstOwnerApplicationRoleFacts = Readonly<{
  identityAuthorityId: IdentityAuthorityId;
  system: SystemContextFacts;
  stewardIdentityId: string;
  stewardOrganizationAccountId: string;
  applicationKeys: readonly string[];
  releases: ReadonlyMap<string, PublishedRelease>;
}>;

const templateIdentity = (template: RoleTemplate): string =>
  `${template.applicationRootId.toLowerCase()}:${template.sourceRoleId.toLowerCase()}`;

const roleIdentity = (role: OrganizationAdministrationRoleSummary): string | undefined =>
  role.source.kind === "application"
    ? `${role.source.applicationRootId.toLowerCase()}:${role.source.sourceRoleId.toLowerCase()}`
    : undefined;

const roleKeyForTemplate = (template: RoleTemplate): string =>
  acceptedApplicationRoleKey(template.applicationRootId, template.sourceRoleId, template.key);

/**
 * The role templates of the release each application runs, derived from that release exactly as an
 * App Store install derives the templates it accepts.
 */
const installedTemplates = async (
  facts: FirstOwnerApplicationRoleFacts,
  applicationKeyByRootId: ReadonlyMap<string, string>,
): Promise<RoleTemplate[]> => {
  const templates: RoleTemplate[] = [];
  for (const [rootId, applicationKey] of applicationKeyByRootId) {
    const revision = await readActiveReleaseRevision(facts, applicationKey, rootId);
    if (revision === null)
      throw new Error(`Installed application ${applicationKey} has no active release`);
    const releaseSet = await readReleaseSet(facts.system, rootId, revision);
    templates.push(
      ...releaseRoleTemplates(releaseSet).map((template) => ({
        ...template,
        applicationRootId: rootId,
      })),
    );
  }
  return templates;
};

const listRoles = async (
  administration: AccessAdministration,
  session: OwnerSession,
  selection: OrganizationSelection,
): Promise<OrganizationAdministrationRoleSummary[]> => {
  const roles: OrganizationAdministrationRoleSummary[] = [];
  let afterRoleId: OrganizationAdministrationRoleSummary["roleId"] | undefined;
  for (;;) {
    const page = await administration.listRoles(session, selection, {
      pageSize: 100,
      ...(afterRoleId === undefined ? {} : { afterRoleId }),
    });
    if (page.kind !== "available")
      throw new Error(`Accepted application roles could not be read (${page.kind})`);
    roles.push(...page.value.roles);
    afterRoleId = page.value.nextAfterRoleId;
    if (afterRoleId === undefined) return roles;
  }
};

const listAssignments = async (
  administration: AccessAdministration,
  session: OwnerSession,
  selection: OrganizationSelection,
): Promise<OrganizationAdministrationRoleAssignment[]> => {
  const assignments: OrganizationAdministrationRoleAssignment[] = [];
  let afterRoleAssignmentId:
    OrganizationAdministrationRoleAssignment["roleAssignmentId"] | undefined;
  for (;;) {
    const page = await administration.listRoleAssignments(session, selection, {
      pageSize: 100,
      ...(afterRoleAssignmentId === undefined ? {} : { afterRoleAssignmentId }),
    });
    if (page.kind !== "available")
      throw new Error(`Current role assignments could not be read (${page.kind})`);
    assignments.push(...page.value.assignments);
    afterRoleAssignmentId = page.value.nextAfterRoleAssignmentId;
    if (afterRoleAssignmentId === undefined) return assignments;
  }
};

/** An upgrade that changes a shipped role template leaves the accepted role to accept again. */
const acceptedRevision = async (
  administration: AccessAdministration,
  session: OwnerSession,
  selection: OrganizationSelection,
  role: OrganizationAdministrationRoleSummary,
): Promise<OrganizationAdministrationRoleSummary> => {
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
    throw new Error(`Role revision of ${role.key} could not be prepared (${prepared.kind})`);
  const result = await administration.acceptApplicationRoleRevision(
    session,
    selection,
    changeOrganizationAdministrationRoleAuthorityCommandSchema.parse({ evidence: prepared.value }),
  );
  if (result.kind !== "available" || result.value.role.lifecycle !== "active")
    throw new Error(`Role revision of ${role.key} could not be accepted (${result.kind})`);
  return result.value.role;
};

const acceptedRole = async (
  administration: AccessAdministration,
  session: OwnerSession,
  selection: OrganizationSelection,
  template: RoleTemplate,
): Promise<OrganizationAdministrationRoleSummary> => {
  const prepared = await administration.prepareRoleChange(
    session,
    selection,
    prepareOrganizationAdministrationRoleChangeCommandSchema.parse({
      operation: "accept_new_application_role",
      roleKey: roleKeyForTemplate(template),
      label: template.name,
      description: `Accepted from the ${template.key} role template by local development setup.`,
      privilegeClassification: template.privileged ? "privileged" : "standard",
      templateApplicationRootId: template.applicationRootId,
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
    !sameId(role.source.applicationRootId, template.applicationRootId) ||
    !sameId(role.source.sourceRoleId, template.sourceRoleId)
  )
    throw new Error(`Accepted role for ${template.key} did not match its current template`);
  return role;
};

const hasActiveOwnerAssignment = (
  assignments: readonly OrganizationAdministrationRoleAssignment[],
  role: OrganizationAdministrationRoleSummary,
  organizationAccountId: string,
): boolean =>
  assignments.some(
    (assignment) =>
      sameId(assignment.role.roleId, role.roleId) &&
      assignment.assignee.kind === "organization_account" &&
      sameId(assignment.assignee.organizationAccountId, organizationAccountId) &&
      assignment.state === "live" &&
      assignment.temporalState === "active" &&
      assignment.assignmentKind === "standing",
  );

export const grantFirstOwnerApplicationRoles = async (
  facts: FirstOwnerApplicationRoleFacts,
  log: (message: string) => void,
): Promise<void> => {
  const administration = createOrganizationAccessAdministrationService({
    identityAuthorityId: facts.identityAuthorityId,
  });
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

  const [templates, currentRoles, assignments] = await Promise.all([
    installedTemplates(facts, applicationKeyByRootId),
    listRoles(administration, session, selection),
    listAssignments(administration, session, selection),
  ]);

  const templateCountsByApplication = new Map<string, number>();
  const seenTemplates = new Set<string>();
  for (const template of templates) {
    const identity = templateIdentity(template);
    if (seenTemplates.has(identity))
      throw new Error(`Application role template ${template.key} was returned more than once`);
    seenTemplates.add(identity);
    const rootId = template.applicationRootId.toLowerCase();
    templateCountsByApplication.set(rootId, (templateCountsByApplication.get(rootId) ?? 0) + 1);
  }
  for (const [rootId, applicationKey] of applicationKeyByRootId) {
    if (templateCountsByApplication.get(rootId) === undefined)
      throw new Error(
        `No registered role templates were available for installed application ${applicationKey}`,
      );
  }

  const rolesByTemplate = new Map<string, OrganizationAdministrationRoleSummary>();
  for (const role of currentRoles) {
    const identity = roleIdentity(role);
    if (
      identity === undefined ||
      role.source.kind !== "application" ||
      !applicationKeyByRootId.has(role.source.applicationRootId.toLowerCase())
    )
      continue;
    if (rolesByTemplate.has(identity))
      throw new Error(`More than one accepted role was found for application template ${identity}`);
    rolesByTemplate.set(identity, role);
  }

  let ensuredGrants = 0;
  for (const template of templates) {
    const identity = templateIdentity(template);
    let role = rolesByTemplate.get(identity);
    if (role === undefined) {
      role = await acceptedRole(administration, session, selection, template);
      rolesByTemplate.set(identity, role);
      const applicationName =
        applicationKeyByRootId.get(template.applicationRootId.toLowerCase()) ??
        template.applicationRootId;
      log(`accepted ${applicationName} role template ${template.key}`);
    }
    if (role.lifecycle === "acceptance_required") {
      role = await acceptedRevision(administration, session, selection, role);
      rolesByTemplate.set(identity, role);
      log(`accepted the revised role template ${template.key}`);
    }
    if (role.lifecycle !== "active")
      throw new Error(
        `Accepted role ${role.key} from template ${template.key} is ${role.lifecycle}`,
      );
    if (role.assignmentPolicy.kind !== "standing")
      throw new Error(
        `Role ${role.key} from template ${template.key} requires activation and cannot open an application immediately`,
      );

    const applicationName =
      applicationKeyByRootId.get(template.applicationRootId.toLowerCase()) ??
      template.applicationRootId;
    if (hasActiveOwnerAssignment(assignments, role, facts.stewardOrganizationAccountId)) {
      log(`first owner already holds ${applicationName} role ${role.key}`);
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
        `Role ${role.key} for ${applicationName} could not be assigned to the first owner (${assigned.kind})`,
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
      throw new Error(`The protected assignment for ${role.key} did not match the first owner`);
    assignments.push(assigned.value.assignment);
    log(`granted ${applicationName} role ${role.key} to the first owner`);
    ensuredGrants += 1;
  }

  log(
    `ensured ${ensuredGrants} application role grants for the first owner across ${templateCountsByApplication.size} installed applications`,
  );
};
