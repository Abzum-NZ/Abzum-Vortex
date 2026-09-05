import { describe, expect, expectTypeOf, it } from "vitest";
import {
  affectedRoleAssignmentManifestSchema,
  applicationRoleSchema,
  applicationRoleTemplateContinuitySchema,
  delegationAuthoritySchema,
  permissionEntrySchema,
  permissionContinuitySchema,
  preparedApplicationRoleTemplatesSchema,
  projectLiveApplicationRolePermissions,
  roleActivationPolicyRevisionSchema,
  roleAssignmentEffectiveStateSchema,
  roleAssignmentSchema,
  rolePermissionEntrySchema,
  roleSchema,
  groupMembershipEffectiveStateSchema,
  groupMembershipSchema,
  groupSchema,
} from "../src";
import type {
  AffectedRoleAssignmentManifest,
  DelegationAuthority,
  PermissionContinuity,
  PreparedApplicationRoleTemplates,
  Role,
  RoleActivationPolicyRevision,
  RoleAssignmentPolicy,
  RoleAssignment,
  RolePermissionEntry,
  Group,
  GroupMembership,
} from "../src";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const fingerprint = (character: string): string => `sha256:${character.repeat(64)}`;
const changedAt = "2026-09-05T02:00:00+00:00";

const applicationRelease = (applicationRootId = id(2)) => ({
  kind: "application" as const,
  definitionKey: "example.application",
  rootId: applicationRootId,
  releaseRevision: 3,
  releaseVersion: "1.2.0",
  validationContractVersion: "1.0.0",
  contentFingerprint: fingerprint("a"),
  resolutionFingerprint: fingerprint("b"),
});

const applicationPermissionCandidate = (permissionId = id(3)) => ({
  applicationRootId: id(2),
  ownerKind: "application" as const,
  ownerId: id(2),
  permission: {
    permissionId,
    key: "example.application.open",
    label: "Open application",
    description: "Open this application without implying record access.",
    actionKind: "named" as const,
    namedAction: "open",
    administrative: false,
  },
  sourceRelease: applicationRelease(),
  meaningFingerprint: fingerprint("c"),
});

const modulePermissionCandidate = {
  applicationRootId: id(2),
  ownerKind: "module" as const,
  ownerId: id(4),
  permission: {
    permissionId: id(5),
    key: "example.case.read",
    label: "Read cases",
    description: "Read cases exposed through this application.",
    actionKind: "read" as const,
    administrative: false,
  },
  sourceRelease: {
    kind: "module" as const,
    definitionKey: "example.module",
    rootId: id(4),
    releaseRevision: 7,
    releaseVersion: "2.1.0",
    validationContractVersion: "1.0.0",
    contentFingerprint: fingerprint("d"),
    resolutionFingerprint: fingerprint("e"),
  },
  meaningFingerprint: fingerprint("f"),
};

const permissionRegistration = {
  contractVersion: "1.0.0" as const,
  organizationId: id(1),
  applicationRootId: id(2),
  applicationRelease: applicationRelease(),
  applicationCatalogueFingerprint: fingerprint("1"),
  applicationPermissionIds: [id(3)],
  entries: [applicationPermissionCandidate(), modulePermissionCandidate],
  candidateFingerprint: fingerprint("2"),
};

const exactPermission = (overrides: Record<string, unknown> = {}) => ({
  kind: "exact" as const,
  applicationRootId: id(2),
  ownerKind: "application" as const,
  ownerId: id(2),
  permissionId: id(3),
  acceptedRegistrationRevision: 4,
  catalogueFingerprint: fingerprint("1"),
  continuityRevision: 2,
  meaningFingerprint: fingerprint("c"),
  ...overrides,
});

const changeEvidence = {
  createdByActorId: id(80),
  createdAt: "2026-09-05T01:00:00+00:00",
  changedByActorId: id(81),
  changedAt,
  changeCorrelationId: id(82),
};

const standingRoleProtection = {
  privilegeClassification: "standard" as const,
  assignmentPolicy: { kind: "standing" as const },
  policyContinuityRevision: 1,
};

const activationPolicyReference = {
  activationPolicyId: id(90),
  revision: 2,
  fingerprint: fingerprint("9"),
};

const temporalGrant = {
  startsAt: "2026-09-06T01:00:00+00:00",
  state: "live" as const,
  grantedByActorId: id(80),
  grantedAt: "2026-09-05T01:00:00+00:00",
  grantCorrelationId: id(82),
  changedByActorId: id(81),
  changeCorrelationId: id(83),
  changedAt,
};

describe("organisation access catalogue contracts", () => {
  it("exports the corrected live contract types from the package entry point", () => {
    expectTypeOf<Role>().toBeObject();
    expectTypeOf<RoleActivationPolicyRevision>().toBeObject();
    expectTypeOf<RoleAssignmentPolicy>().toBeObject();
    expectTypeOf<RolePermissionEntry>().toBeObject();
    expectTypeOf<Group>().toBeObject();
    expectTypeOf<GroupMembership>().toBeObject();
    expectTypeOf<RoleAssignment>().toBeObject();
    expectTypeOf<DelegationAuthority>().toBeObject();
    expectTypeOf<PermissionContinuity>().toBeObject();
    expectTypeOf<AffectedRoleAssignmentManifest>().toBeObject();
    expectTypeOf<PreparedApplicationRoleTemplates>().toBeObject();
  });

  it("models complete immutable role-scoped activation policy revisions", () => {
    const policy = {
      organizationId: id(1),
      roleId: id(10),
      activationPolicyId: id(90),
      revision: 2,
      fingerprint: fingerprint("9"),
      maximumActivationDurationSeconds: 3_600,
      reasonRequired: true,
      recentAuthentication: { kind: "multi_factor" as const, maximumAgeSeconds: 900 },
      independentApprovalRequired: true,
      changedByActorId: id(80),
      changedAt,
      changeCorrelationId: id(82),
    };

    expect(roleActivationPolicyRevisionSchema.safeParse(policy).success).toBe(true);
    expect(
      roleActivationPolicyRevisionSchema.safeParse({
        ...policy,
        recentAuthentication: { kind: "none" },
      }).success,
    ).toBe(true);
    expect(
      roleActivationPolicyRevisionSchema.safeParse({
        ...policy,
        recentAuthentication: { kind: "primary", maximumAgeSeconds: 300 },
      }).success,
    ).toBe(true);

    for (const invalidDuration of [
      0,
      -1,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(
        roleActivationPolicyRevisionSchema.safeParse({
          ...policy,
          maximumActivationDurationSeconds: invalidDuration,
        }).success,
      ).toBe(false);

    for (const invalidMaximumAge of [
      0,
      -1,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(
        roleActivationPolicyRevisionSchema.safeParse({
          ...policy,
          recentAuthentication: {
            kind: "primary",
            maximumAgeSeconds: invalidMaximumAge,
          },
        }).success,
      ).toBe(false);

    expect(
      roleActivationPolicyRevisionSchema.safeParse({
        ...policy,
        recentAuthentication: { kind: "none", maximumAgeSeconds: 300 },
      }).success,
    ).toBe(false);
    expect(
      roleActivationPolicyRevisionSchema.safeParse({
        ...policy,
        recentAuthentication: { kind: "primary" },
      }).success,
    ).toBe(false);
    expect(
      roleActivationPolicyRevisionSchema.safeParse({
        ...policy,
        recentAuthentication: { kind: "recent_multi_factor", maximumAgeSeconds: 300 },
      }).success,
    ).toBe(false);
    expect(
      roleActivationPolicyRevisionSchema.safeParse({
        ...policy,
        activationPolicyId: "00000000-0000-0000-0000-000000000000",
      }).success,
    ).toBe(false);
    expect(roleActivationPolicyRevisionSchema.safeParse({ ...policy, reviewers: [] }).success).toBe(
      false,
    );
  });

  it("keeps privilege classification independent from the closed assignment policy", () => {
    const role = {
      roleId: id(10),
      organizationId: id(1),
      key: "protected_reader",
      label: "Protected reader",
      description: "Exercises protected classification and assignment policy combinations.",
      kind: "custom" as const,
      liveRevision: 1,
      lifecycle: "active" as const,
      permissions: [exactPermission()],
      ...changeEvidence,
    };
    const standing = { kind: "standing" as const };
    const activationRequired = {
      kind: "activation_required" as const,
      activationPolicy: activationPolicyReference,
    };

    for (const privilegeClassification of ["standard", "privileged"] as const)
      for (const assignmentPolicy of [standing, activationRequired])
        expect(
          roleSchema.safeParse({
            ...role,
            privilegeClassification,
            assignmentPolicy,
            policyContinuityRevision: 1,
          }).success,
        ).toBe(true);

    expect(
      roleSchema.safeParse({
        ...role,
        privilegeClassification: "standard",
        policyContinuityRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      roleSchema.safeParse({
        ...role,
        privilegeClassification: "standard",
        assignmentPolicy: { ...standing, activationPolicy: activationPolicyReference },
        policyContinuityRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      roleSchema.safeParse({
        ...role,
        privilegeClassification: "standard",
        assignmentPolicy: { kind: "activation_required" },
        policyContinuityRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      roleSchema.safeParse({
        ...role,
        privilegeClassification: "standard",
        assignmentPolicy: {
          kind: "activation_required",
          activationPolicy: { ...activationPolicyReference, organizationId: id(1) },
        },
        policyContinuityRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      roleSchema.safeParse({
        ...role,
        privilegeClassification: "standard",
        assignmentPolicy: activationRequired,
        policyContinuityRevision: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });

  it("requires exact owner-qualified permission identity and application context", () => {
    expect(rolePermissionEntrySchema.safeParse(exactPermission()).success).toBe(true);
    expect(permissionEntrySchema.safeParse(exactPermission()).success).toBe(true);
    expect(
      rolePermissionEntrySchema.safeParse({
        ...exactPermission(),
        kind: "trailing_wildcard",
        prefix: "example.application",
      }).success,
    ).toBe(false);
    expect(
      rolePermissionEntrySchema.safeParse({ ...exactPermission(), applicationRootId: undefined })
        .success,
    ).toBe(false);
    expect(
      rolePermissionEntrySchema.safeParse({ ...exactPermission(), ownerId: id(99) }).success,
    ).toBe(false);
    expect(
      rolePermissionEntrySchema.safeParse({
        ...exactPermission(),
        ownerKind: "platform",
        applicationRootId: undefined,
        ownerId: id(99),
      }).success,
    ).toBe(true);
  });

  it("keeps identical permission identities separate across application contexts", () => {
    const role = {
      roleId: id(10),
      organizationId: id(1),
      key: "cross_application_reader",
      label: "Cross-application reader",
      description: "Reads the selected areas in two independently registered applications.",
      kind: "custom" as const,
      liveRevision: 1,
      ...standingRoleProtection,
      lifecycle: "active" as const,
      permissions: [
        exactPermission(),
        exactPermission({
          applicationRootId: id(20),
          ownerId: id(20),
          acceptedRegistrationRevision: 1,
        }),
      ],
      ...changeEvidence,
    };
    expect(roleSchema.safeParse(role).success).toBe(true);
    expect(
      roleSchema.safeParse({ ...role, permissions: [exactPermission(), exactPermission()] })
        .success,
    ).toBe(false);
    expect(roleSchema.safeParse({ ...role, lifecycle: "retired", permissions: [] }).success).toBe(
      false,
    );
    expect(roleSchema.safeParse({ ...role, organizationId: undefined }).success).toBe(false);
    expect(roleSchema.safeParse({ ...role, lifecycle: "acceptance_required" }).success).toBe(false);
    expect(roleSchema.safeParse({ ...role, roleId: id(15), organizationId: id(14) }).success).toBe(
      true,
    );
  });

  it("stores an application role by exact source reference rather than copying its template", () => {
    const role = {
      roleId: id(10),
      organizationId: id(1),
      applicationRootId: id(2),
      key: "application_user",
      label: "Application user",
      description: "Uses the accepted application functions.",
      kind: "application" as const,
      liveRevision: 1,
      ...standingRoleProtection,
      lifecycle: "active" as const,
      permissions: [exactPermission()],
      source: {
        applicationRootId: id(2),
        sourceRoleId: id(11),
        sourceRelease: applicationRelease(),
        sourceTemplateFingerprint: fingerprint("3"),
        sourceCatalogueFingerprint: fingerprint("1"),
        acceptedRegistrationRevision: 4,
        templateContinuityRevision: 1,
        acceptedGrantFingerprint: fingerprint("4"),
      },
      ...changeEvidence,
    };
    expect(roleSchema.safeParse(role).success).toBe(true);
    expect(
      roleSchema.safeParse({
        ...role,
        source: { ...role.source, applicationRootId: id(12) },
      }).success,
    ).toBe(false);
    expect(roleSchema.safeParse({ ...role, sourceTemplate: {} }).success).toBe(false);
    expect(roleSchema.safeParse({ ...role, description: "" }).success).toBe(false);
    expect(roleSchema.safeParse({ ...role, permissions: [] }).success).toBe(false);
    expect(
      roleSchema.safeParse({ ...role, lifecycle: "acceptance_required", permissions: [] }).success,
    ).toBe(true);
    expect(
      roleSchema.safeParse({ ...role, lifecycle: "unavailable", permissions: [] }).success,
    ).toBe(true);
    expect(roleSchema.safeParse({ ...role, lifecycle: "retired", permissions: [] }).success).toBe(
      true,
    );
    expect(
      roleSchema.safeParse({
        ...role,
        permissions: [exactPermission({ catalogueFingerprint: fingerprint("9") })],
      }).success,
    ).toBe(false);
    expect(
      roleSchema.safeParse({
        ...role,
        permissions: [exactPermission({ acceptedRegistrationRevision: 5 })],
      }).success,
    ).toBe(false);
    expect(
      roleSchema.safeParse({
        ...role,
        permissions: [exactPermission({ applicationRootId: id(20), ownerId: id(20) })],
      }).success,
    ).toBe(false);
    expect(
      roleSchema.safeParse({
        ...role,
        permissions: [
          exactPermission({ applicationRootId: undefined, ownerKind: "platform", ownerId: id(99) }),
        ],
      }).success,
    ).toBe(false);
  });

  it("prepares exact immutable templates against one #32 registration candidate", () => {
    const template = {
      roleId: id(11),
      key: "application_user",
      name: "Application user",
      homePageId: id(12),
      permissionKeys: ["example.application.open", "example.case.read"],
      permissionSelection: { kind: "exact" as const },
    };
    const prepared = {
      contractVersion: "1.0.0" as const,
      preparationBasis: { kind: "registration_candidate" as const },
      permissionRegistration,
      templates: [
        {
          template,
          sourceTemplateFingerprint: fingerprint("3"),
          sourcePermissions: [applicationPermissionCandidate(), modulePermissionCandidate],
          livePermissions: [applicationPermissionCandidate(), modulePermissionCandidate],
        },
      ],
      candidateFingerprint: fingerprint("4"),
    };
    expect(preparedApplicationRoleTemplatesSchema.safeParse(prepared).success).toBe(true);
    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({ ...prepared, allowed: true }).success,
    ).toBe(false);
    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...prepared,
        preparationBasis: {
          kind: "current_active_registration",
          registrationRevision: Number.MAX_SAFE_INTEGER + 1,
        },
      }).success,
    ).toBe(false);
    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...prepared,
        templates: [
          {
            ...prepared.templates[0],
            sourcePermissions: [modulePermissionCandidate, applicationPermissionCandidate()],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...prepared,
        templates: [
          {
            ...prepared.templates[0],
            sourcePermissions: [
              {
                ...applicationPermissionCandidate(),
                applicationRootId: id(20),
                ownerId: id(20),
                sourceRelease: applicationRelease(id(20)),
              },
              modulePermissionCandidate,
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...prepared,
        templates: [
          {
            ...prepared.templates[0],
            sourcePermissions: [
              {
                ...applicationPermissionCandidate(),
                sourceRelease: {
                  ...applicationRelease(),
                  contentFingerprint: fingerprint("9"),
                },
              },
              modulePermissionCandidate,
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...prepared,
        templates: [
          {
            ...prepared.templates[0],
            sourcePermissions: [
              {
                ...applicationPermissionCandidate(),
                meaningFingerprint: fingerprint("9"),
              },
              modulePermissionCandidate,
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...prepared,
        permissionRegistration: {
          ...permissionRegistration,
          entries: [
            ...permissionRegistration.entries,
            {
              ...modulePermissionCandidate,
              permission: {
                ...modulePermissionCandidate.permission,
                key: "example.application.open",
              },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("keeps full Definition wildcard intent but projects only eligible live permissions", () => {
    const administrative = {
      ...applicationPermissionCandidate(id(30)),
      permission: {
        ...applicationPermissionCandidate(id(30)).permission,
        permissionId: id(30),
        key: "example.application.settings_manage",
        administrative: true,
      },
    };
    const exportPermission = {
      ...applicationPermissionCandidate(id(31)),
      permission: {
        ...applicationPermissionCandidate(id(31)).permission,
        permissionId: id(31),
        key: "example.application.data_export",
        actionKind: "export" as const,
        namedAction: undefined,
      },
    };
    const registration = {
      ...permissionRegistration,
      applicationPermissionIds: [id(31), id(3)],
      entries: [
        applicationPermissionCandidate(),
        administrative,
        exportPermission,
        modulePermissionCandidate,
      ],
    };
    const wildcardTemplate = {
      roleId: id(11),
      key: "application_user",
      name: "Application user",
      homePageId: id(12),
      permissionKeys: ["example.application.data_export", "example.application.open"],
      permissionSelection: {
        kind: "application_wildcard" as const,
        catalogueFingerprint: fingerprint("1"),
      },
    };
    expect(applicationRoleSchema.safeParse(wildcardTemplate).success).toBe(true);
    const candidate = {
      contractVersion: "1.0.0" as const,
      preparationBasis: {
        kind: "current_active_registration" as const,
        registrationRevision: 4,
      },
      permissionRegistration: registration,
      templates: [
        {
          template: wildcardTemplate,
          sourceTemplateFingerprint: fingerprint("3"),
          sourcePermissions: [exportPermission, applicationPermissionCandidate()],
          livePermissions: [applicationPermissionCandidate()],
        },
      ],
      candidateFingerprint: fingerprint("4"),
    };
    const parsed = preparedApplicationRoleTemplatesSchema.parse(candidate);
    expect(
      projectLiveApplicationRolePermissions(
        parsed.templates[0]!.template.permissionSelection,
        parsed.permissionRegistration.applicationRootId,
        parsed.templates[0]!.sourcePermissions,
      ),
    ).toEqual([applicationPermissionCandidate()]);
    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...candidate,
        templates: [
          {
            ...candidate.templates[0],
            livePermissions: [exportPermission, applicationPermissionCandidate()],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...candidate,
        templates: [
          {
            ...candidate.templates[0],
            livePermissions: [applicationPermissionCandidate(), administrative],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...candidate,
        templates: [
          {
            ...candidate.templates[0],
            livePermissions: [applicationPermissionCandidate(), modulePermissionCandidate],
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...candidate,
        templates: [
          {
            ...candidate.templates[0],
            template: {
              ...wildcardTemplate,
              permissionKeys: ["example.application.data_export"],
            },
            sourcePermissions: [exportPermission],
            livePermissions: [],
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...candidate,
        templates: [
          {
            ...candidate.templates[0],
            template: {
              ...wildcardTemplate,
              permissionKeys: ["example.application.data_export"],
              permissionSelection: { kind: "exact" as const },
            },
            sourcePermissions: [exportPermission],
            livePermissions: [exportPermission],
          },
        ],
      }).success,
    ).toBe(true);

    const collidingModulePermission = {
      ...modulePermissionCandidate,
      permission: {
        ...modulePermissionCandidate.permission,
        key: "example.application.open",
      },
    };
    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...candidate,
        permissionRegistration: {
          ...registration,
          entries: [
            applicationPermissionCandidate(),
            administrative,
            exportPermission,
            collidingModulePermission,
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      preparedApplicationRoleTemplatesSchema.safeParse({
        ...candidate,
        permissionRegistration: {
          ...registration,
          entries: [
            applicationPermissionCandidate(),
            administrative,
            exportPermission,
            collidingModulePermission,
          ],
        },
        templates: [
          {
            ...candidate.templates[0],
            template: {
              ...wildcardTemplate,
              permissionKeys: ["example.application.open"],
              permissionSelection: { kind: "exact" as const },
            },
            sourcePermissions: [applicationPermissionCandidate()],
            livePermissions: [applicationPermissionCandidate()],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("stores Group membership and role assignment without caller-supplied app scope or Activity", () => {
    const group = {
      groupId: id(40),
      organizationId: id(1),
      key: "case_workers",
      label: "Case workers",
      state: "active" as const,
      revision: 1,
      ...changeEvidence,
    };
    const membership = {
      membershipId: id(41),
      organizationId: id(1),
      groupId: id(40),
      organizationAccountId: id(42),
      revision: 1,
      ...temporalGrant,
    };
    const assignment = {
      roleAssignmentId: id(43),
      organizationId: id(1),
      roleId: id(10),
      assignee: { kind: "group" as const, groupId: id(40) },
      revision: 1,
      ...temporalGrant,
    };
    expect(groupSchema.safeParse(group).success).toBe(true);
    expect(groupMembershipSchema.safeParse(membership).success).toBe(true);
    expect(roleAssignmentSchema.safeParse(assignment).success).toBe(true);
    expect(
      groupSchema.safeParse({ ...group, teamId: group.groupId, groupId: undefined }).success,
    ).toBe(false);
    expect(
      groupMembershipSchema.safeParse({
        ...membership,
        identityId: membership.organizationAccountId,
        organizationAccountId: undefined,
      }).success,
    ).toBe(false);
    expect(
      roleAssignmentSchema.safeParse({
        ...assignment,
        assignee: { kind: "team", teamId: id(40) },
      }).success,
    ).toBe(false);
    expect(
      roleAssignmentSchema.safeParse({
        ...assignment,
        assignee: { kind: "group", groupId: id(40), teamId: id(40) },
      }).success,
    ).toBe(false);
    expect(
      roleAssignmentSchema.safeParse({
        ...assignment,
        applicationRootId: id(2),
        activityId: id(90),
      }).success,
    ).toBe(false);
    expect(
      groupMembershipEffectiveStateSchema.safeParse({
        membership,
        effectiveState: "scheduled",
      }).success,
    ).toBe(true);
    expect(
      roleAssignmentEffectiveStateSchema.safeParse({ assignment, effectiveState: "expired" })
        .success,
    ).toBe(true);
    expect(
      roleAssignmentEffectiveStateSchema.safeParse({ assignment, effectiveState: "revoked" })
        .success,
    ).toBe(false);
  });

  it("requires complete revocation evidence and JavaScript-safe revisions", () => {
    const membership = {
      membershipId: id(41),
      organizationId: id(1),
      groupId: id(40),
      organizationAccountId: id(42),
      revision: 1,
      ...temporalGrant,
    };
    expect(groupMembershipSchema.safeParse({ ...membership, state: "revoked" }).success).toBe(
      false,
    );
    expect(groupMembershipSchema.safeParse({ ...membership, revokedAt: changedAt }).success).toBe(
      false,
    );
    expect(
      groupMembershipSchema.safeParse({ ...membership, revokedByActorId: id(80) }).success,
    ).toBe(false);
    expect(
      groupMembershipSchema.safeParse({ ...membership, revocationCorrelationId: id(83) }).success,
    ).toBe(false);
    expect(
      groupMembershipSchema.safeParse({
        ...membership,
        state: "revoked",
        revokedByActorId: id(80),
        revokedAt: "2026-09-05T03:00:00+00:00",
        revocationCorrelationId: id(83),
        changedAt: "2026-09-05T02:00:00+00:00",
      }).success,
    ).toBe(false);
    expect(
      groupMembershipSchema.safeParse({ ...membership, changedByActorId: undefined }).success,
    ).toBe(false);
    expect(
      groupMembershipSchema.safeParse({ ...membership, changeCorrelationId: undefined }).success,
    ).toBe(false);
    expect(
      groupMembershipSchema.safeParse({ ...membership, expiresAt: membership.startsAt }).success,
    ).toBe(false);
    expect(
      groupMembershipSchema.safeParse({ ...membership, revision: Number.MAX_SAFE_INTEGER + 1 })
        .success,
    ).toBe(false);
  });

  it("keeps delegation separate from personal use and pins bounded authority exactly", () => {
    const organizationWide = {
      delegationAuthorityId: id(50),
      organizationId: id(1),
      holder: { kind: "organization_account" as const, organizationAccountId: id(42) },
      scope: { kind: "organization_catalogue" as const },
      revision: 1,
      ...temporalGrant,
    };
    const bounded = {
      ...organizationWide,
      delegationAuthorityId: id(51),
      scope: {
        kind: "bounded" as const,
        permissions: [exactPermission()],
        scopeFingerprint: fingerprint("5"),
      },
    };
    expect(delegationAuthoritySchema.safeParse(organizationWide).success).toBe(true);
    expect(
      delegationAuthoritySchema.safeParse({
        ...organizationWide,
        holder: { kind: "group", groupId: id(40) },
      }).success,
    ).toBe(true);
    expect(
      delegationAuthoritySchema.safeParse({
        ...organizationWide,
        holder: { kind: "team", teamId: id(40) },
      }).success,
    ).toBe(false);
    expect(delegationAuthoritySchema.safeParse(bounded).success).toBe(true);
    expect(
      delegationAuthoritySchema.safeParse({
        ...bounded,
        allowed: true,
        approverOrganizationAccountId: id(60),
        usePermissionIds: [id(3)],
      }).success,
    ).toBe(false);
  });

  it("represents retained permission and template tombstones without reviving old continuity", () => {
    const permissionContinuity = {
      organizationId: id(1),
      applicationRootId: id(2),
      ownerKind: "module" as const,
      ownerId: id(4),
      permissionId: id(5),
      state: "unavailable" as const,
      continuityRevision: 3,
      meaningFingerprint: fingerprint("f"),
      lastProcessedRegistrationRevision: 9,
      changedAt,
    };
    expect(permissionContinuitySchema.safeParse(permissionContinuity).success).toBe(true);
    expect(
      permissionContinuitySchema.safeParse({
        ...permissionContinuity,
        ownerKind: "platform",
      }).success,
    ).toBe(false);
    expect(
      applicationRoleTemplateContinuitySchema.safeParse({
        organizationId: id(1),
        applicationRootId: id(2),
        sourceRoleId: id(11),
        state: "unavailable",
        continuityRevision: 4,
        sourceTemplateFingerprint: fingerprint("3"),
        lastProcessedRegistrationRevision: 9,
        changedAt,
      }).success,
    ).toBe(true);
  });

  it("binds deterministic affected assignment revisions without permission copies", () => {
    const assignment = (suffix: number) => ({
      roleAssignmentId: id(suffix),
      expectedRevision: suffix,
      assignee: { kind: "organization_account" as const, organizationAccountId: id(suffix + 20) },
    });
    const manifest = {
      organizationId: id(1),
      roleId: id(10),
      roleCandidateFingerprint: fingerprint("6"),
      assignments: [assignment(60), assignment(61)],
      manifestFingerprint: fingerprint("7"),
    };
    expect(affectedRoleAssignmentManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      affectedRoleAssignmentManifestSchema.safeParse({
        ...manifest,
        assignments: [assignment(61), assignment(60)],
      }).success,
    ).toBe(false);
    expect(
      affectedRoleAssignmentManifestSchema.safeParse({
        ...manifest,
        assignments: [assignment(60), assignment(60)],
      }).success,
    ).toBe(false);
    expect(
      affectedRoleAssignmentManifestSchema.safeParse({
        ...manifest,
        permissions: [exactPermission()],
      }).success,
    ).toBe(false);
  });

  it("does not impose an arbitrary catalogue-size ceiling on exact live roles", () => {
    const role = {
      roleId: id(10),
      organizationId: id(1),
      key: "large_catalogue_role",
      label: "Large catalogue role",
      description: "Exercises valid catalogue growth without an artificial contract cap.",
      kind: "custom" as const,
      liveRevision: 1,
      ...standingRoleProtection,
      lifecycle: "active" as const,
      permissions: Array.from({ length: 1_001 }, (_, index) =>
        exactPermission({ permissionId: id(1_000 + index) }),
      ),
      ...changeEvidence,
    };
    expect(roleSchema.safeParse(role).success).toBe(true);
  });
});
