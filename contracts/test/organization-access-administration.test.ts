import { describe, expect, it } from "vitest";
import {
  changeOrganizationAdministrationGroupResultSchema,
  changeOrganizationAdministrationDelegationAuthorityResultSchema,
  changeOrganizationAdministrationRoleActivationResultSchema,
  createOrganizationAdministrationGroupCommandSchema,
  listOrganizationAdministrationGroupsCommandSchema,
  listOrganizationAdministrationGroupsResultSchema,
  listOrganizationAdministrationMembershipsCommandSchema,
  listOrganizationAdministrationMembershipsResultSchema,
  listOrganizationAdministrationApplicationRoleTemplatesCommandSchema,
  listOrganizationAdministrationApplicationRoleTemplatesResultSchema,
  listOrganizationAdministrationDelegationAuthoritiesCommandSchema,
  listOrganizationAdministrationDelegationAuthoritiesResultSchema,
  listOrganizationAdministrationPermissionsCommandSchema,
  listOrganizationAdministrationPermissionsResultSchema,
  listOrganizationAdministrationRolesCommandSchema,
  listOrganizationAdministrationRolesResultSchema,
  listOrganizationAdministrationRoleActivationsCommandSchema,
  listOrganizationAdministrationRoleActivationsResultSchema,
  listOrganizationAdministrationRoleAssignmentsCommandSchema,
  listOrganizationAdministrationRoleAssignmentsResultSchema,
  organizationAdministrationApplicationRoleTemplateSchema,
  organizationAdministrationDelegationAuthoritySchema,
  organizationAdministrationGroupSchema,
  organizationAdministrationMembershipSchema,
  organizationAdministrationPermissionSchema,
  organizationAdministrationRoleDetailSchema,
  organizationAdministrationRoleActivationDetailSchema,
  organizationAdministrationRoleActivationSummarySchema,
  organizationAdministrationRoleAssignmentSchema,
  organizationAdministrationRoleSummarySchema,
  readOrganizationAdministrationApplicationRoleTemplateResultSchema,
  readOrganizationAdministrationDelegationAuthorityResultSchema,
  readOrganizationAdministrationGroupResultSchema,
  readOrganizationAdministrationMembershipResultSchema,
  readOrganizationAdministrationPermissionResultSchema,
  readOrganizationAdministrationRoleResultSchema,
  readOrganizationAdministrationRoleActivationResultSchema,
  readOrganizationAdministrationRoleAssignmentResultSchema,
  renameOrganizationAdministrationGroupCommandSchema,
  deactivateOrganizationAdministrationRoleActivationCommandSchema,
  revokeOrganizationAdministrationDelegationAuthorityCommandSchema,
} from "../src/organization-access-administration";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const group = {
  groupId: id(1),
  key: "review_group",
  label: "Review group",
  state: "active" as const,
  revision: 2,
};

const membership = {
  membershipId: id(10),
  groupId: id(1),
  organizationAccountId: id(11),
  accountDisplayName: "Neutral member",
  revision: 2,
  startsAt: "2026-09-06T00:00:00.000Z",
  expiresAt: "2026-10-06T00:00:00.000Z",
  state: "live" as const,
  temporalState: "active" as const,
};

const permissionReference = {
  applicationRootId: id(20),
  ownerKind: "module" as const,
  ownerId: id(21),
  permissionId: id(22),
};
const permission = {
  reference: permissionReference,
  key: "review.records.read",
  label: "Read review records",
  description: "Read review records in the selected application.",
  recordTypeId: id(23),
  action: { actionKind: "read" as const },
  administrative: false,
};

const roleSummary = {
  roleId: id(40),
  key: "review_operator",
  label: "Review operator",
  roleKind: "application" as const,
  lifecycle: "acceptance_required" as const,
  liveRevision: 3,
  privilegeClassification: "privileged" as const,
  assignmentPolicy: {
    kind: "activation_required" as const,
    maximumActivationDurationSeconds: 3600,
    reasonRequired: true,
    recentAuthentication: { kind: "multi_factor" as const, maximumAgeSeconds: 900 },
    independentApprovalRequired: true,
  },
  source: {
    kind: "application" as const,
    applicationRootId: id(41),
    sourceRoleId: id(42),
  },
  acceptedPermissionCount: 1,
};

const roleDetail = {
  ...roleSummary,
  description: "Operate reviewed records.",
  acceptedPermissions: [permission],
};

const roleActivationSummary = {
  roleActivationId: id(90),
  beneficiary: {
    organizationAccountId: id(51),
    displayName: "Neutral beneficiary",
  },
  role: {
    roleId: id(40),
    key: "review_operator",
    label: "Review operator",
    lifecycle: "acceptance_required" as const,
  },
  revision: 2,
  historicalRoleRevision: 1,
  eligibilitySourceKind: "group" as const,
  activatedAt: "2026-09-06T00:00:00.000Z",
  expiresAt: "2026-09-06T01:00:00.000Z",
  state: "live" as const,
  temporalState: "expired" as const,
};

const roleActivationDetail = {
  roleActivationId: roleActivationSummary.roleActivationId,
  beneficiary: roleActivationSummary.beneficiary,
  role: roleActivationSummary.role,
  revision: roleActivationSummary.revision,
  historicalRoleRevision: roleActivationSummary.historicalRoleRevision,
  activatedAt: roleActivationSummary.activatedAt,
  expiresAt: roleActivationSummary.expiresAt,
  state: roleActivationSummary.state,
  temporalState: roleActivationSummary.temporalState,
  eligibilitySource: {
    kind: "group" as const,
    eligibilityAssignment: { roleAssignmentId: id(50), revision: 3 },
    originatingMembership: { membershipId: id(10), revision: 2 },
  },
  policyAtActivation: {
    maximumActivationDurationSeconds: 3600,
    reasonRequired: true,
    recentAuthentication: { kind: "multi_factor" as const, maximumAgeSeconds: 900 },
    independentApprovalRequired: true,
  },
};

const templateReference = { applicationRootId: id(41), sourceRoleId: id(42) };
const roleTemplate = {
  reference: templateReference,
  key: "review_operator",
  label: "Review operator",
  permissionSelectionKind: "application_wildcard" as const,
  publishedPermissionKeys: ["review.records.read", "review.records.update"],
};

const assignment = {
  roleAssignmentId: id(50),
  role: {
    roleId: id(40),
    key: "review_operator",
    label: "Review operator",
    lifecycle: "unavailable" as const,
  },
  assignee: {
    kind: "organization_account" as const,
    organizationAccountId: id(51),
    displayName: "Neutral assignee",
  },
  assignmentKind: "eligible" as const,
  revision: 2,
  startsAt: "2026-09-06T00:00:00.000Z",
  expiresAt: "2026-10-06T00:00:00.000Z",
  state: "live" as const,
  temporalState: "expired" as const,
};

const boundedPermissionReference = {
  applicationRootId: id(60),
  ownerKind: "module" as const,
  ownerId: id(61),
  permissionId: id(62),
};
const delegation = {
  delegationAuthorityId: id(63),
  holder: {
    kind: "group" as const,
    groupId: id(64),
    key: "retired_reviewers",
    label: "Retired reviewers",
    state: "retired" as const,
  },
  scope: { kind: "bounded" as const, permissions: [boundedPermissionReference] },
  revision: 3,
  startsAt: "2026-09-06T00:00:00.000Z",
  state: "revoked" as const,
  temporalState: "revoked" as const,
};

describe("organization Access administration contracts", () => {
  it("keeps Group creation and rename commands narrow and distinct", () => {
    expect(
      createOrganizationAdministrationGroupCommandSchema.parse({
        key: "review_group",
        label: "Review group",
      }),
    ).toEqual({ key: "review_group", label: "Review group" });
    expect(
      renameOrganizationAdministrationGroupCommandSchema.parse({
        groupId: id(1),
        expectedGroupRevision: 2,
        label: "Review group renamed",
      }),
    ).toMatchObject({ expectedGroupRevision: 2 });
    for (const candidate of [
      { key: "review_group", label: "Review group", groupId: id(1) },
      { groupId: id(1), expectedGroupRevision: 2, label: "Renamed", operation: "retire" },
      { groupId: id(1), expectedGroupRevision: 0, label: "Renamed" },
    ])
      expect(
        ("key" in candidate
          ? createOrganizationAdministrationGroupCommandSchema
          : renameOrganizationAdministrationGroupCommandSchema
        ).safeParse(candidate).success,
      ).toBe(false);
  });

  it("returns only the safe changed Group and resulting Access version", () => {
    const result = {
      group: {
        groupId: id(1),
        key: "review_group",
        label: "Review group",
        state: "active",
        revision: 1,
      },
      accessVersion: 2,
    };
    expect(changeOrganizationAdministrationGroupResultSchema.parse(result)).toEqual(result);
    expect(
      changeOrganizationAdministrationGroupResultSchema.safeParse({
        ...result,
        correlationId: id(2),
      }).success,
    ).toBe(false);
  });

  it("accepts a bounded Group page and exact detail outcomes", () => {
    expect(
      listOrganizationAdministrationGroupsCommandSchema.parse({
        pageSize: 25,
        afterGroupId: id(2).toUpperCase(),
      }),
    ).toMatchObject({ pageSize: 25 });
    expect(
      listOrganizationAdministrationGroupsResultSchema.parse({
        groups: [group],
        nextAfterGroupId: id(3),
        accessVersion: 7,
      }),
    ).toMatchObject({ groups: [group], accessVersion: 7 });
    expect(
      readOrganizationAdministrationGroupResultSchema.parse({
        outcome: "available",
        group,
        accessVersion: 7,
      }),
    ).toMatchObject({ outcome: "available", group });
    expect(
      readOrganizationAdministrationGroupResultSchema.parse({
        outcome: "unavailable",
        accessVersion: 7,
      }),
    ).toEqual({ outcome: "unavailable", accessVersion: 7 });
  });

  it("refuses unbounded pages, unsafe revisions and leaked stored evidence", () => {
    for (const candidate of [
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 10, extra: true },
      { pageSize: 10, afterGroupId: "not-a-uuid" },
    ])
      expect(listOrganizationAdministrationGroupsCommandSchema.safeParse(candidate).success).toBe(
        false,
      );

    expect(
      organizationAdministrationGroupSchema.safeParse({
        ...group,
        revision: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      organizationAdministrationGroupSchema.safeParse({
        ...group,
        changedByActorId: id(4),
        changeCorrelationId: id(5),
      }).success,
    ).toBe(false);
  });

  it("keeps available and unavailable detail shapes closed", () => {
    expect(
      readOrganizationAdministrationGroupResultSchema.safeParse({
        outcome: "available",
        accessVersion: 7,
      }).success,
    ).toBe(false);
    expect(
      readOrganizationAdministrationGroupResultSchema.safeParse({
        outcome: "unavailable",
        group,
        accessVersion: 7,
      }).success,
    ).toBe(false);
  });

  it("accepts bounded Group membership pages and exact detail outcomes", () => {
    expect(
      listOrganizationAdministrationMembershipsCommandSchema.parse({
        groupId: id(1),
        pageSize: 25,
        afterMembershipId: id(9).toUpperCase(),
      }),
    ).toMatchObject({ groupId: id(1), pageSize: 25 });
    expect(
      listOrganizationAdministrationMembershipsResultSchema.parse({
        groupId: id(1),
        memberships: [membership],
        nextAfterMembershipId: id(10),
        accessVersion: 8,
      }),
    ).toMatchObject({ memberships: [membership], accessVersion: 8 });
    expect(
      readOrganizationAdministrationMembershipResultSchema.parse({
        outcome: "available",
        membership,
        accessVersion: 8,
      }),
    ).toMatchObject({ outcome: "available", membership });
    expect(
      readOrganizationAdministrationMembershipResultSchema.parse({
        outcome: "unavailable",
        accessVersion: 8,
      }),
    ).toEqual({ outcome: "unavailable", accessVersion: 8 });
  });

  it("keeps membership input, temporal state and safe projection closed", () => {
    for (const candidate of [
      { groupId: id(1), pageSize: 0 },
      { groupId: id(1), pageSize: 101 },
      { groupId: id(1), pageSize: 10, afterMembershipId: "not-a-uuid" },
      { groupId: id(1), pageSize: 10, extra: true },
    ])
      expect(
        listOrganizationAdministrationMembershipsCommandSchema.safeParse(candidate).success,
      ).toBe(false);

    for (const candidate of [
      { ...membership, temporalState: "revoked" },
      { ...membership, state: "revoked" },
      { ...membership, expiresAt: membership.startsAt },
      { ...membership, grantedByActorId: id(12) },
      { ...membership, revision: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(organizationAdministrationMembershipSchema.safeParse(candidate).success).toBe(false);

    expect(
      readOrganizationAdministrationMembershipResultSchema.safeParse({
        outcome: "available",
        accessVersion: 8,
      }).success,
    ).toBe(false);
    expect(
      readOrganizationAdministrationMembershipResultSchema.safeParse({
        outcome: "unavailable",
        membership,
        accessVersion: 8,
      }).success,
    ).toBe(false);
  });

  it("accepts bounded permission catalogue pages and exact detail outcomes", () => {
    expect(
      listOrganizationAdministrationPermissionsCommandSchema.parse({
        pageSize: 25,
        after: permissionReference,
      }),
    ).toMatchObject({ pageSize: 25, after: permissionReference });
    expect(
      listOrganizationAdministrationPermissionsResultSchema.parse({
        permissions: [permission],
        nextAfter: permissionReference,
        accessVersion: 8,
      }),
    ).toMatchObject({ permissions: [permission], accessVersion: 8 });
    expect(
      readOrganizationAdministrationPermissionResultSchema.parse({
        outcome: "available",
        permission,
        accessVersion: 8,
      }),
    ).toMatchObject({ outcome: "available", permission });
    expect(
      readOrganizationAdministrationPermissionResultSchema.parse({
        outcome: "unavailable",
        accessVersion: 8,
      }),
    ).toEqual({ outcome: "unavailable", accessVersion: 8 });
  });

  it("reuses exact contextual references and refuses unsafe permission evidence", () => {
    const platform = {
      reference: { ownerKind: "platform", ownerId: id(30), permissionId: id(31) },
      key: "platform.records.read",
      label: "Read records",
      description: "Read records.",
      action: { actionKind: "read" },
      administrative: true,
    };
    expect(organizationAdministrationPermissionSchema.safeParse(platform).success).toBe(true);

    for (const candidate of [
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 10, after: { ...permissionReference, applicationRootId: undefined } },
      {
        pageSize: 10,
        after: { ...permissionReference, ownerKind: "application", ownerId: id(99) },
      },
      { pageSize: 10, callerOrganizationId: id(1) },
    ])
      expect(
        listOrganizationAdministrationPermissionsCommandSchema.safeParse(candidate).success,
      ).toBe(false);

    for (const candidate of [
      { ...permission, meaningFingerprint: `sha256:${"a".repeat(64)}` },
      { ...permission, sourceRelease: { kind: "module" } },
      { ...permission, recordScope: { routes: [{ kind: "all_records" }] } },
      { ...permission, changedByActorId: id(32) },
    ])
      expect(organizationAdministrationPermissionSchema.safeParse(candidate).success).toBe(false);

    expect(
      readOrganizationAdministrationPermissionResultSchema.safeParse({
        outcome: "available",
        accessVersion: 8,
      }).success,
    ).toBe(false);
    expect(
      readOrganizationAdministrationPermissionResultSchema.safeParse({
        outcome: "unavailable",
        permission,
        accessVersion: 8,
      }).success,
    ).toBe(false);
  });

  it("accepts bounded current-role pages and exact detail outcomes", () => {
    expect(
      listOrganizationAdministrationRolesCommandSchema.parse({
        pageSize: 25,
        afterRoleId: id(39).toUpperCase(),
      }),
    ).toMatchObject({ pageSize: 25 });
    expect(
      listOrganizationAdministrationRolesResultSchema.parse({
        roles: [roleSummary],
        nextAfterRoleId: id(40),
        accessVersion: 9,
      }),
    ).toMatchObject({ roles: [roleSummary], accessVersion: 9 });
    expect(
      readOrganizationAdministrationRoleResultSchema.parse({
        outcome: "available",
        role: roleDetail,
        accessVersion: 9,
      }),
    ).toMatchObject({ outcome: "available", role: roleDetail });
    expect(
      readOrganizationAdministrationRoleResultSchema.parse({
        outcome: "unavailable",
        accessVersion: 9,
      }),
    ).toEqual({ outcome: "unavailable", accessVersion: 9 });
  });

  it("keeps role configuration distinct from effective access and stored evidence", () => {
    expect(organizationAdministrationRoleSummarySchema.safeParse(roleSummary).success).toBe(true);
    expect(organizationAdministrationRoleDetailSchema.safeParse(roleDetail).success).toBe(true);
    expect(
      organizationAdministrationRoleSummarySchema.safeParse({
        ...roleSummary,
        roleKind: "custom",
      }).success,
    ).toBe(false);
    expect(
      organizationAdministrationRoleSummarySchema.safeParse({
        ...roleSummary,
        roleKind: "custom",
        source: { kind: "custom" },
        lifecycle: "acceptance_required",
      }).success,
    ).toBe(false);
    for (const candidate of [
      { ...roleDetail, acceptedPermissionCount: 2 },
      { ...roleDetail, authorityContinuityRevision: 2 },
      { ...roleDetail, activationPolicyId: id(43) },
      { ...roleDetail, roleAssignments: [] },
      { ...roleDetail, effective: true },
    ])
      expect(organizationAdministrationRoleDetailSchema.safeParse(candidate).success).toBe(false);
    for (const candidate of [
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 10, afterRoleId: "not-a-uuid" },
      { pageSize: 10, filter: "active" },
    ])
      expect(listOrganizationAdministrationRolesCommandSchema.safeParse(candidate).success).toBe(
        false,
      );
  });

  it("accepts separately keyed current application-role templates", () => {
    expect(
      listOrganizationAdministrationApplicationRoleTemplatesCommandSchema.parse({
        pageSize: 25,
        after: templateReference,
      }),
    ).toMatchObject({ after: templateReference });
    expect(
      listOrganizationAdministrationApplicationRoleTemplatesResultSchema.parse({
        templates: [roleTemplate],
        nextAfter: templateReference,
        accessVersion: 9,
      }),
    ).toMatchObject({ templates: [roleTemplate], accessVersion: 9 });
    expect(
      readOrganizationAdministrationApplicationRoleTemplateResultSchema.parse({
        outcome: "available",
        template: roleTemplate,
        accessVersion: 9,
      }),
    ).toMatchObject({ outcome: "available", template: roleTemplate });
    expect(
      readOrganizationAdministrationApplicationRoleTemplateResultSchema.parse({
        outcome: "unavailable",
        accessVersion: 9,
      }),
    ).toEqual({ outcome: "unavailable", accessVersion: 9 });
  });

  it("refuses unsafe template evidence and incomplete contextual cursors", () => {
    for (const candidate of [
      { ...roleTemplate, sourceTemplateFingerprint: `sha256:${"a".repeat(64)}` },
      { ...roleTemplate, homePageId: id(44) },
      { ...roleTemplate, organizationRoleId: id(45) },
      { ...roleTemplate, publishedPermissionKeys: ["review.records.read", "review.records.read"] },
    ])
      expect(
        organizationAdministrationApplicationRoleTemplateSchema.safeParse(candidate).success,
      ).toBe(false);
    for (const candidate of [
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 10, after: { applicationRootId: id(41) } },
      { pageSize: 10, after: { sourceRoleId: id(42) } },
      { pageSize: 10, after: { ...templateReference, extra: true } },
    ])
      expect(
        listOrganizationAdministrationApplicationRoleTemplatesCommandSchema.safeParse(candidate)
          .success,
      ).toBe(false);
  });

  it("accepts bounded role-assignment pages and descriptive temporal facts", () => {
    expect(organizationAdministrationRoleAssignmentSchema.parse(assignment)).toEqual(assignment);
    expect(
      listOrganizationAdministrationRoleAssignmentsCommandSchema.parse({
        pageSize: 25,
        afterRoleAssignmentId: id(49),
      }),
    ).toMatchObject({ afterRoleAssignmentId: id(49) });
    expect(
      listOrganizationAdministrationRoleAssignmentsResultSchema.parse({
        assignments: [assignment],
        nextAfterRoleAssignmentId: id(50),
        accessVersion: 10,
      }),
    ).toMatchObject({ assignments: [assignment], accessVersion: 10 });
    expect(
      readOrganizationAdministrationRoleAssignmentResultSchema.parse({
        outcome: "available",
        assignment,
        accessVersion: 10,
      }),
    ).toMatchObject({ outcome: "available", assignment });
  });

  it("does not turn assignment window status into effective-access evidence", () => {
    for (const candidate of [
      { ...assignment, temporalState: "revoked" },
      { ...assignment, effective: true },
      { ...assignment, grantCorrelationId: id(52) },
      { ...assignment, role: { ...assignment.role, authorityContinuityRevision: 2 } },
    ])
      expect(organizationAdministrationRoleAssignmentSchema.safeParse(candidate).success).toBe(
        false,
      );
    for (const candidate of [
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 10, afterRoleAssignmentId: "invalid" },
      { pageSize: 10, assigneeKind: "group" },
    ])
      expect(
        listOrganizationAdministrationRoleAssignmentsCommandSchema.safeParse(candidate).success,
      ).toBe(false);
  });

  it("accepts catalogue and stripped bounded delegation ledger facts", () => {
    expect(organizationAdministrationDelegationAuthoritySchema.parse(delegation)).toEqual(
      delegation,
    );
    expect(
      organizationAdministrationDelegationAuthoritySchema.parse({
        ...delegation,
        delegationAuthorityId: id(65),
        holder: {
          kind: "organization_account",
          organizationAccountId: id(51),
          displayName: "Neutral holder",
        },
        scope: { kind: "organization_catalogue" },
        state: "live",
        temporalState: "scheduled",
      }),
    ).toMatchObject({ scope: { kind: "organization_catalogue" } });
    expect(
      listOrganizationAdministrationDelegationAuthoritiesResultSchema.parse({
        delegations: [delegation],
        nextAfterDelegationAuthorityId: id(63),
        accessVersion: 10,
      }),
    ).toMatchObject({ delegations: [delegation], accessVersion: 10 });
    expect(
      readOrganizationAdministrationDelegationAuthorityResultSchema.parse({
        outcome: "unavailable",
        accessVersion: 10,
      }),
    ).toEqual({ outcome: "unavailable", accessVersion: 10 });
  });

  it("binds activation and delegation reductions to one reviewed revision", () => {
    expect(
      deactivateOrganizationAdministrationRoleActivationCommandSchema.parse({
        roleActivationId: id(60),
        expectedActivationRevision: 2,
      }),
    ).toEqual({ roleActivationId: id(60), expectedActivationRevision: 2 });
    expect(
      revokeOrganizationAdministrationDelegationAuthorityCommandSchema.parse({
        delegationAuthorityId: id(61),
        expectedDelegationRevision: 3,
      }),
    ).toEqual({ delegationAuthorityId: id(61), expectedDelegationRevision: 3 });
    expect(
      deactivateOrganizationAdministrationRoleActivationCommandSchema.safeParse({
        roleActivationId: id(60),
        expectedActivationRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      revokeOrganizationAdministrationDelegationAuthorityCommandSchema.safeParse({
        delegationAuthorityId: id(61),
        expectedDelegationRevision: 3,
        scope: { kind: "organization_catalogue" },
      }).success,
    ).toBe(false);
    expect(
      changeOrganizationAdministrationRoleActivationResultSchema.safeParse({
        activation: { roleActivationId: id(60) },
        accessVersion: 4,
      }).success,
    ).toBe(false);
    expect(
      changeOrganizationAdministrationDelegationAuthorityResultSchema.parse({
        delegation: { ...delegation, revision: 3, state: "revoked", temporalState: "revoked" },
        accessVersion: 4,
      }).accessVersion,
    ).toBe(4);
  });

  it("refuses raw delegation evidence, duplicate scope and unbounded inputs", () => {
    for (const candidate of [
      {
        ...delegation,
        scope: {
          kind: "bounded",
          permissions: [
            boundedPermissionReference,
            {
              ...boundedPermissionReference,
              permissionId: boundedPermissionReference.permissionId,
            },
          ],
        },
      },
      {
        ...delegation,
        scope: {
          kind: "bounded",
          permissions: [
            boundedPermissionReference,
            {
              ...boundedPermissionReference,
              applicationRootId: boundedPermissionReference.applicationRootId.toUpperCase(),
              ownerId: boundedPermissionReference.ownerId.toUpperCase(),
              permissionId: boundedPermissionReference.permissionId.toUpperCase(),
            },
          ],
        },
      },
      { ...delegation, scopeFingerprint: `sha256:${"a".repeat(64)}` },
      {
        ...delegation,
        scope: {
          kind: "bounded",
          permissions: [
            {
              ...boundedPermissionReference,
              acceptedRegistrationRevision: 1,
              meaningFingerprint: `sha256:${"b".repeat(64)}`,
            },
          ],
        },
      },
      { ...delegation, effective: true },
    ])
      expect(organizationAdministrationDelegationAuthoritySchema.safeParse(candidate).success).toBe(
        false,
      );
    for (const candidate of [
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 10, afterDelegationAuthorityId: "invalid" },
      { pageSize: 10, scopeKind: "bounded" },
    ])
      expect(
        listOrganizationAdministrationDelegationAuthoritiesCommandSchema.safeParse(candidate)
          .success,
      ).toBe(false);
  });

  it("accepts bounded activation pages and exact direct or Group detail evidence", () => {
    expect(
      organizationAdministrationRoleActivationSummarySchema.parse(roleActivationSummary),
    ).toEqual(roleActivationSummary);
    expect(
      organizationAdministrationRoleActivationDetailSchema.parse(roleActivationDetail),
    ).toEqual(roleActivationDetail);
    expect(
      organizationAdministrationRoleActivationDetailSchema.parse({
        ...roleActivationDetail,
        eligibilitySource: {
          kind: "direct",
          eligibilityAssignment: { roleAssignmentId: id(55), revision: 1 },
        },
      }),
    ).toMatchObject({ eligibilitySource: { kind: "direct" } });
    expect(
      listOrganizationAdministrationRoleActivationsCommandSchema.parse({
        pageSize: 25,
        afterRoleActivationId: id(89),
      }),
    ).toMatchObject({ afterRoleActivationId: id(89) });
    expect(
      listOrganizationAdministrationRoleActivationsResultSchema.parse({
        activations: [roleActivationSummary],
        nextAfterRoleActivationId: id(90),
        accessVersion: 10,
      }),
    ).toMatchObject({ activations: [roleActivationSummary], accessVersion: 10 });
    expect(
      readOrganizationAdministrationRoleActivationResultSchema.parse({
        outcome: "unavailable",
        accessVersion: 10,
      }),
    ).toEqual({ outcome: "unavailable", accessVersion: 10 });
  });

  it("keeps activation timing and provenance distinct from effective access", () => {
    for (const candidate of [
      { ...roleActivationSummary, temporalState: "revoked" },
      { ...roleActivationSummary, expiresAt: roleActivationSummary.activatedAt },
      { ...roleActivationSummary, effective: true },
      { ...roleActivationSummary, authorityContinuityRevision: 2 },
      { ...roleActivationSummary, policyFingerprint: `sha256:${"a".repeat(64)}` },
      { ...roleActivationDetail, activatedByActorId: id(92) },
      {
        ...roleActivationDetail,
        eligibilitySource: {
          kind: "direct",
          eligibilityAssignment: { roleAssignmentId: id(50), revision: 3 },
          originatingMembership: { membershipId: id(10), revision: 2 },
        },
      },
      { ...roleActivationDetail, policyAtActivation: { kind: "activation_required" } },
    ])
      expect(
        ("eligibilitySource" in candidate
          ? organizationAdministrationRoleActivationDetailSchema
          : organizationAdministrationRoleActivationSummarySchema
        ).safeParse(candidate).success,
      ).toBe(false);

    for (const candidate of [
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 10, afterRoleActivationId: "invalid" },
      { pageSize: 10, organizationAccountId: id(51) },
    ])
      expect(
        listOrganizationAdministrationRoleActivationsCommandSchema.safeParse(candidate).success,
      ).toBe(false);
  });
});
