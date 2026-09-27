import { createHash } from "node:crypto";
import { createOrganizationAccessAdministrationService } from "@vortex/access";
import {
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  organizationSelectionCandidateSchema,
  prepareOrganizationAdministrationRoleChangeCommandSchema,
  type IdentityAuthorityId,
  type OrganizationAdministrationApplicationRoleTemplate,
  type OrganizationAdministrationPermission,
  type OrganizationAdministrationRoleAssignment,
  type OrganizationAdministrationRoleSummary,
} from "@vortex/contracts";
import { nominatedOwnerSession } from "./development-authority";
import type { PublishedRelease } from "./state";

type AccessAdministration = ReturnType<typeof createOrganizationAccessAdministrationService>;
type OwnerSession = ReturnType<typeof nominatedOwnerSession>;
type OrganizationSelection = ReturnType<typeof organizationSelectionCandidateSchema.parse>;

export type FirstOwnerApplicationRoleFacts = Readonly<{
  identityAuthorityId: IdentityAuthorityId;
  organizationId: string;
  stewardIdentityId: string;
  stewardOrganizationAccountId: string;
  applicationKeys: readonly string[];
  releases: ReadonlyMap<string, PublishedRelease>;
}>;

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const templateIdentity = (template: OrganizationAdministrationApplicationRoleTemplate): string =>
  `${template.reference.applicationRootId.toLowerCase()}:${template.reference.sourceRoleId.toLowerCase()}`;

const roleIdentity = (role: OrganizationAdministrationRoleSummary): string | undefined =>
  role.source.kind === "application"
    ? `${role.source.applicationRootId.toLowerCase()}:${role.source.sourceRoleId.toLowerCase()}`
    : undefined;

const roleKeyForTemplate = (template: OrganizationAdministrationApplicationRoleTemplate): string => {
  const digest = createHash("sha256")
    .update(templateIdentity(template))
    .digest("hex")
    .slice(0, 12);
  const readableKey = template.key.slice(0, 20).replace(/_+$/, "") || "role";
  return `local_${readableKey}_${digest}`;
};

const listTemplates = async (
  administration: AccessAdministration,
  session: OwnerSession,
  selection: OrganizationSelection,
): Promise<OrganizationAdministrationApplicationRoleTemplate[]> => {
  const templates: OrganizationAdministrationApplicationRoleTemplate[] = [];
  let after: OrganizationAdministrationApplicationRoleTemplate["reference"] | undefined;
  for (;;) {
    const page = await administration.listApplicationRoleTemplates(session, selection, {
      pageSize: 100,
      ...(after === undefined ? {} : { after }),
    });
    if (page.kind !== "available")
      throw new Error(`Application role templates could not be read (${page.kind})`);
    templates.push(...page.value.templates);
    after = page.value.nextAfter;
    if (after === undefined) return templates;
  }
};

const listPermissions = async (
  administration: AccessAdministration,
  session: OwnerSession,
  selection: OrganizationSelection,
): Promise<OrganizationAdministrationPermission[]> => {
  const permissions: OrganizationAdministrationPermission[] = [];
  let after: OrganizationAdministrationPermission["reference"] | undefined;
  for (;;) {
    const page = await administration.listPermissions(session, selection, {
      pageSize: 100,
      ...(after === undefined ? {} : { after }),
    });
    if (page.kind !== "available")
      throw new Error(`Registered application permissions could not be read (${page.kind})`);
    permissions.push(...page.value.permissions);
    after = page.value.nextAfter;
    if (after === undefined) return permissions;
  }
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
    | OrganizationAdministrationRoleAssignment["roleAssignmentId"]
    | undefined;
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

const hasAdministrativePermission = (
  template: OrganizationAdministrationApplicationRoleTemplate,
  permissions: readonly OrganizationAdministrationPermission[],
): boolean =>
  template.permissionSelectionKind === "exact" &&
  permissions.some(
    (permission) =>
      permission.administrative &&
      permission.reference.applicationRootId !== undefined &&
      sameId(permission.reference.applicationRootId, template.reference.applicationRootId) &&
      template.publishedPermissionKeys.includes(permission.key),
  );

const acceptedRole = async (
  administration: AccessAdministration,
  session: OwnerSession,
  selection: OrganizationSelection,
  template: OrganizationAdministrationApplicationRoleTemplate,
  permissions: readonly OrganizationAdministrationPermission[],
): Promise<OrganizationAdministrationRoleSummary> => {
  const prepared = await administration.prepareRoleChange(
    session,
    selection,
    prepareOrganizationAdministrationRoleChangeCommandSchema.parse({
      operation: "accept_new_application_role",
      roleKey: roleKeyForTemplate(template),
      label: template.label,
      description: `Accepted from the ${template.key} role template by local development setup.`,
      privilegeClassification: hasAdministrativePermission(template, permissions)
        ? "privileged"
        : "standard",
      templateApplicationRootId: template.reference.applicationRootId,
      sourceRoleId: template.reference.sourceRoleId,
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
    !sameId(role.source.applicationRootId, template.reference.applicationRootId) ||
    !sameId(role.source.sourceRoleId, template.reference.sourceRoleId)
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
    organizationId: facts.organizationId,
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

  const [templates, permissions, currentRoles, assignments] = await Promise.all([
    listTemplates(administration, session, selection),
    listPermissions(administration, session, selection),
    listRoles(administration, session, selection),
    listAssignments(administration, session, selection),
  ]);
  if (templates.length === 0)
    throw new Error("No installed application role templates were available to the first owner");

  const templateCountsByApplication = new Map<string, number>();
  const seenTemplates = new Set<string>();
  const installedTemplates = templates.filter((template) =>
    applicationKeyByRootId.has(template.reference.applicationRootId.toLowerCase()),
  );
  for (const template of installedTemplates) {
    const identity = templateIdentity(template);
    if (seenTemplates.has(identity))
      throw new Error(`Application role template ${template.key} was returned more than once`);
    seenTemplates.add(identity);
    const rootId = template.reference.applicationRootId.toLowerCase();
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
  for (const template of installedTemplates) {
    const identity = templateIdentity(template);
    let role = rolesByTemplate.get(identity);
    if (role === undefined) {
      role = await acceptedRole(administration, session, selection, template, permissions);
      rolesByTemplate.set(identity, role);
      const applicationName =
        applicationKeyByRootId.get(template.reference.applicationRootId.toLowerCase()) ??
        template.reference.applicationRootId;
      log(`accepted ${applicationName} role template ${template.key}`);
    }
    if (role.lifecycle !== "active")
      throw new Error(`Accepted role ${role.key} from template ${template.key} is ${role.lifecycle}`);
    if (role.assignmentPolicy.kind !== "standing")
      throw new Error(
        `Role ${role.key} from template ${template.key} requires activation and cannot open an application immediately`,
      );

    const applicationName =
      applicationKeyByRootId.get(template.reference.applicationRootId.toLowerCase()) ??
      template.reference.applicationRootId;
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
    if (assigned.kind !== "available")
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
