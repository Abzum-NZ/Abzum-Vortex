import { describe, expect, it } from "vitest";
import {
  organizationRoleChangeCandidateSchema,
  organizationRoleChangeCommandSchema,
  organizationRoleChangePreparationSchema,
  organizationRoleChangeResultSchema,
  organizationRoleNewActivationPolicySchema,
  organizationRolePolicyChoiceSchema,
  preparedOrganizationRoleChangeSchema,
  type OrganizationRoleChangeCandidate,
} from "../src/organization-role-changes";

const fingerprint = (character: string): string => `sha256:${character.repeat(64)}`;

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const roleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const applicationRootId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const sourceRoleId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd4";
const permissionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5";
const pageId = "ffffffff-ffff-4fff-8fff-fffffffffff6";
const assignmentId = "abcdefab-cdef-4abc-8def-abcdefabcde7";
const accountId = "fedcbafe-dcba-4fed-8cba-fedcbafedcb8";
const activationPolicyId = "abcdefab-cdef-4abc-8def-abcdefabcde9";
const actorId = "fedcbafe-dcba-4fed-8cba-fedcbafedc10";
const correlationId = "abcdefab-cdef-4abc-8def-abcdefabcdef";

const applicationRelease = {
  kind: "application" as const,
  definitionKey: "test.fixture",
  rootId: applicationRootId,
  releaseRevision: 3,
  releaseVersion: "1.2.0",
  validationContractVersion: "2.18.0",
  contentFingerprint: fingerprint("1"),
  resolutionFingerprint: fingerprint("2"),
};

const permissionDeclaration = {
  permissionId,
  key: "test.fixture.read",
  label: "Read fixture records",
  description: "Read neutral fixture records.",
  actionKind: "read" as const,
  administrative: false,
};

const permissionCandidate = {
  applicationRootId,
  ownerKind: "application" as const,
  ownerId: applicationRootId,
  permission: permissionDeclaration,
  sourceRelease: applicationRelease,
  meaningFingerprint: fingerprint("3"),
};

const catalogueFingerprint = fingerprint("4");
const rolePermission = {
  kind: "exact" as const,
  applicationRootId,
  ownerKind: "application" as const,
  ownerId: applicationRootId,
  permissionId,
  acceptedRegistrationRevision: 4,
  catalogueFingerprint,
  continuityRevision: 2,
  meaningFingerprint: permissionCandidate.meaningFingerprint,
};

const preparedTemplates = {
  contractVersion: "1.0.0" as const,
  preparationBasis: {
    kind: "current_active_registration" as const,
    registrationRevision: 4,
  },
  permissionRegistration: {
    contractVersion: "1.0.0" as const,
    organizationId,
    applicationRootId,
    applicationRelease,
    applicationCatalogueFingerprint: catalogueFingerprint,
    applicationPermissionIds: [permissionId],
    entries: [permissionCandidate],
    candidateFingerprint: fingerprint("5"),
  },
  templates: [
    {
      template: {
        roleId: sourceRoleId,
        key: "fixture_reader",
        name: "Fixture reader",
        homePageId: pageId,
        permissionKeys: [permissionDeclaration.key],
        permissionSelection: { kind: "exact" as const },
      },
      sourceTemplateFingerprint: fingerprint("6"),
      sourcePermissions: [permissionCandidate],
      livePermissions: [permissionCandidate],
    },
  ],
  candidateFingerprint: fingerprint("7"),
};

const standingPolicy = { kind: "standing" as const };
const existingPolicy = {
  kind: "activation_required" as const,
  activationPolicy: {
    selection: "existing" as const,
    reference: {
      activationPolicyId,
      revision: 2,
      fingerprint: fingerprint("8"),
    },
  },
};
const newPolicy = {
  kind: "activation_required" as const,
  activationPolicy: {
    selection: "new" as const,
    policy: {
      activationPolicyId,
      revision: 3,
      maximumActivationDurationSeconds: 900,
      reasonRequired: true,
      recentAuthentication: { kind: "multi_factor" as const, maximumAgeSeconds: 600 },
      independentApprovalRequired: true,
    },
  },
};

const configuration = {
  key: "fixture_reader",
  label: "Fixture reader",
  description: "A neutral fixture role.",
  privilegeClassification: "standard" as const,
  assignmentPolicy: standingPolicy,
};

const templateFields = {
  preparedTemplates,
  sourceRoleId,
  templateContinuityRevision: 2,
  permissions: [rolePermission],
};

const candidate = (operation: OrganizationRoleChangeCandidate["operation"]) => {
  const identity = { organizationId, roleId };
  switch (operation) {
    case "create_custom":
      return { operation, ...identity, ...configuration, permissions: [rolePermission] };
    case "create_custom_from_template":
    case "accept_new_application_role":
      return { operation, ...identity, ...configuration, ...templateFields };
    case "revise_metadata_policy":
      return { operation, ...identity, expectedRoleRevision: 2, ...configuration };
    case "revise_custom_permissions":
      return {
        operation,
        ...identity,
        expectedRoleRevision: 2,
        ...configuration,
        permissions: [rolePermission],
      };
    case "accept_application_role_revision":
      return {
        operation,
        ...identity,
        expectedRoleRevision: 2,
        ...configuration,
        ...templateFields,
      };
    case "retire_role":
      return { operation, ...identity, expectedRoleRevision: 2 };
  }
};

const manifest = (candidateFingerprint = fingerprint("9")) => ({
  organizationId,
  roleId,
  roleCandidateFingerprint: candidateFingerprint,
  assignments: [
    {
      roleAssignmentId: assignmentId,
      expectedRevision: 2,
      assignee: { kind: "organization_account" as const, organizationAccountId: accountId },
    },
  ],
  manifestFingerprint: fingerprint("a"),
});

const prepared = (
  operation: OrganizationRoleChangeCandidate["operation"],
  options: { assignmentManifest?: boolean; policy?: typeof newPolicy } = {},
) => {
  const roleCandidateFingerprint = fingerprint("9");
  const baseCandidate = candidate(operation);
  const preparedCandidate =
    options.policy === undefined || !("assignmentPolicy" in baseCandidate)
      ? baseCandidate
      : { ...baseCandidate, assignmentPolicy: options.policy };
  return {
    contractVersion: "1.0.0" as const,
    candidate: preparedCandidate,
    ...(options.policy === undefined ? {} : { newActivationPolicyFingerprint: fingerprint("b") }),
    ...(operation === "accept_new_application_role" ||
    operation === "accept_application_role_revision"
      ? { acceptedGrantFingerprint: fingerprint("c") }
      : {}),
    roleCandidateFingerprint,
    ...(options.assignmentManifest
      ? { affectedAssignmentManifest: manifest(roleCandidateFingerprint) }
      : {}),
  };
};

const changedAt = "2026-09-05T14:00:00.000Z";
const customRole = (liveRevision: number, lifecycle: "active" | "retired" = "active") => ({
  roleId,
  organizationId,
  key: configuration.key,
  label: configuration.label,
  description: configuration.description,
  kind: "custom" as const,
  liveRevision,
  privilegeClassification: "standard" as const,
  assignmentPolicy: standingPolicy,
  policyContinuityRevision: 1,
  authorityContinuityRevision: 1,
  lifecycle,
  permissions: [rolePermission],
  createdByActorId: actorId,
  createdAt: changedAt,
  changedByActorId: actorId,
  changedAt,
  changeCorrelationId: correlationId,
});

const applicationRole = (
  liveRevision: number,
  lifecycle: "active" | "acceptance_required" | "unavailable" | "retired" = "active",
) => ({
  roleId,
  organizationId,
  key: configuration.key,
  label: configuration.label,
  description: configuration.description,
  kind: "application" as const,
  liveRevision,
  privilegeClassification: "standard" as const,
  assignmentPolicy: standingPolicy,
  policyContinuityRevision: 1,
  authorityContinuityRevision: 1,
  lifecycle,
  applicationRootId,
  source: {
    applicationRootId,
    sourceRoleId,
    sourceRelease: applicationRelease,
    sourceTemplateFingerprint: preparedTemplates.templates[0]!.sourceTemplateFingerprint,
    sourceCatalogueFingerprint: catalogueFingerprint,
    acceptedRegistrationRevision: 4,
    templateContinuityRevision: 2,
    acceptedGrantFingerprint: fingerprint("c"),
  },
  permissions: [rolePermission],
  createdByActorId: actorId,
  createdAt: changedAt,
  changedByActorId: actorId,
  changedAt,
  changeCorrelationId: correlationId,
});

describe("organization role-change contract boundaries", () => {
  it("accepts all seven exact intent shapes", () => {
    const operations: OrganizationRoleChangeCandidate["operation"][] = [
      "create_custom",
      "create_custom_from_template",
      "accept_new_application_role",
      "revise_metadata_policy",
      "revise_custom_permissions",
      "accept_application_role_revision",
      "retire_role",
    ];

    for (const operation of operations)
      expect(organizationRoleChangeCandidateSchema.safeParse(candidate(operation)).success).toBe(
        true,
      );
  });

  it.each([
    ["unknown intent", { ...candidate("create_custom"), operation: "restore_role" }],
    ["candidate authority", { ...candidate("create_custom"), callerAuthorized: true }],
    ["create predecessor", { ...candidate("create_custom"), expectedRoleRevision: 1 }],
    [
      "template-copy predecessor",
      { ...candidate("create_custom_from_template"), expectedRoleRevision: 1 },
    ],
    [
      "new application-role predecessor",
      { ...candidate("accept_new_application_role"), expectedRoleRevision: 1 },
    ],
    ["retire configuration", { ...candidate("retire_role"), label: "Replacement" }],
    [
      "unsafe predecessor",
      { ...candidate("revise_metadata_policy"), expectedRoleRevision: Number.MAX_SAFE_INTEGER + 1 },
    ],
    [
      "missing predecessor",
      { ...candidate("revise_metadata_policy"), expectedRoleRevision: undefined },
    ],
    [
      "missing custom-permission predecessor",
      { ...candidate("revise_custom_permissions"), expectedRoleRevision: undefined },
    ],
    [
      "missing application-acceptance predecessor",
      { ...candidate("accept_application_role_revision"), expectedRoleRevision: undefined },
    ],
    [
      "missing retirement predecessor",
      { ...candidate("retire_role"), expectedRoleRevision: undefined },
    ],
    ["empty permission set", { ...candidate("revise_custom_permissions"), permissions: [] }],
    [
      "unsafe template continuity",
      {
        ...candidate("accept_application_role_revision"),
        templateContinuityRevision: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
    ["template source on metadata", { ...candidate("revise_metadata_policy"), ...templateFields }],
  ])("refuses %s", (_name, value) => {
    expect(organizationRoleChangeCandidateSchema.safeParse(value).success).toBe(false);
  });

  it("keeps policy choices closed and safely revisioned", () => {
    expect(organizationRolePolicyChoiceSchema.safeParse(standingPolicy).success).toBe(true);
    expect(organizationRolePolicyChoiceSchema.safeParse(existingPolicy).success).toBe(true);
    expect(organizationRolePolicyChoiceSchema.safeParse(newPolicy).success).toBe(true);
    expect(
      organizationRolePolicyChoiceSchema.safeParse({
        ...standingPolicy,
        activationPolicy: existingPolicy.activationPolicy,
      }).success,
    ).toBe(false);
    expect(
      organizationRolePolicyChoiceSchema.safeParse({
        ...newPolicy,
        activationPolicy: {
          ...newPolicy.activationPolicy,
          reference: existingPolicy.activationPolicy.reference,
        },
      }).success,
    ).toBe(false);
    expect(
      organizationRoleNewActivationPolicySchema.safeParse({
        ...newPolicy.activationPolicy.policy,
        revision: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      organizationRoleNewActivationPolicySchema.safeParse({
        ...newPolicy.activationPolicy.policy,
        maximumActivationDurationSeconds: 0,
      }).success,
    ).toBe(false);
  });

  it("binds policy fingerprints and application acceptance provenance", () => {
    expect(preparedOrganizationRoleChangeSchema.safeParse(prepared("create_custom")).success).toBe(
      true,
    );
    expect(
      preparedOrganizationRoleChangeSchema.safeParse(
        prepared("revise_metadata_policy", { policy: newPolicy }),
      ).success,
    ).toBe(true);
    expect(
      preparedOrganizationRoleChangeSchema.safeParse({
        ...prepared("revise_metadata_policy", { policy: newPolicy }),
        newActivationPolicyFingerprint: undefined,
      }).success,
    ).toBe(false);
    expect(
      preparedOrganizationRoleChangeSchema.safeParse({
        ...prepared("create_custom"),
        newActivationPolicyFingerprint: fingerprint("b"),
      }).success,
    ).toBe(false);
    expect(
      preparedOrganizationRoleChangeSchema.safeParse({
        ...prepared("accept_new_application_role"),
        acceptedGrantFingerprint: undefined,
      }).success,
    ).toBe(false);
    expect(
      preparedOrganizationRoleChangeSchema.safeParse({
        ...prepared("create_custom_from_template"),
        acceptedGrantFingerprint: fingerprint("c"),
      }).success,
    ).toBe(false);
  });

  it("prohibits manifests for create and retire while permitting structurally bound review", () => {
    for (const operation of [
      "create_custom",
      "create_custom_from_template",
      "accept_new_application_role",
      "retire_role",
    ] as const)
      expect(
        preparedOrganizationRoleChangeSchema.safeParse(
          prepared(operation, { assignmentManifest: true }),
        ).success,
      ).toBe(false);

    for (const operation of [
      "revise_metadata_policy",
      "revise_custom_permissions",
      "accept_application_role_revision",
    ] as const)
      expect(
        preparedOrganizationRoleChangeSchema.safeParse(
          prepared(operation, { assignmentManifest: true }),
        ).success,
      ).toBe(true);

    expect(
      preparedOrganizationRoleChangeSchema.safeParse({
        ...prepared("revise_metadata_policy", { assignmentManifest: true }),
        affectedAssignmentManifest: {
          ...manifest(),
          organizationId: organizationId.toUpperCase(),
          roleId: roleId.toUpperCase(),
          assignments: [
            {
              ...manifest().assignments[0],
              roleAssignmentId: assignmentId.toUpperCase(),
              assignee: {
                kind: "organization_account",
                organizationAccountId: accountId.toUpperCase(),
              },
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      preparedOrganizationRoleChangeSchema.safeParse({
        ...prepared("revise_metadata_policy", { assignmentManifest: true }),
        affectedAssignmentManifest: {
          ...manifest(),
          roleCandidateFingerprint: fingerprint("d"),
        },
      }).success,
    ).toBe(false);
  });

  it("keeps preparation and commands strict without claiming current authority", () => {
    const preparation = {
      candidate: candidate("revise_metadata_policy"),
      affectedAssignments: manifest().assignments,
    };
    expect(organizationRoleChangePreparationSchema.safeParse(preparation).success).toBe(true);
    expect(
      organizationRoleChangePreparationSchema.safeParse({
        ...preparation,
        accessVersion: 4,
      }).success,
    ).toBe(false);

    const command = {
      evidence: prepared("revise_metadata_policy"),
      changedBy: actorId,
      correlationId,
    };
    expect(organizationRoleChangeCommandSchema.safeParse(command).success).toBe(true);
    expect(
      organizationRoleChangeCommandSchema.safeParse({ ...command, callerAuthorized: true }).success,
    ).toBe(false);
  });

  it.each([
    ["create_custom", customRole(1)],
    ["create_custom_from_template", customRole(1)],
    ["accept_new_application_role", applicationRole(1)],
    ["revise_metadata_policy", applicationRole(2, "unavailable")],
    ["revise_custom_permissions", customRole(2)],
    ["accept_application_role_revision", applicationRole(2)],
    ["retire_role", customRole(2, "retired")],
  ] as const)("accepts a stored role matching %s", (operation, role) => {
    expect(
      organizationRoleChangeResultSchema.safeParse({
        outcome: "changed",
        operation,
        role,
        accessVersion: 5,
        correlationId,
      }).success,
    ).toBe(true);
  });

  it("refuses mismatched result kind, lifecycle, revision and correlation", () => {
    const base = {
      outcome: "changed",
      operation: "create_custom",
      role: customRole(1),
      accessVersion: 5,
      correlationId,
    } as const;
    expect(
      organizationRoleChangeResultSchema.safeParse({
        ...base,
        role: applicationRole(1),
      }).success,
    ).toBe(false);
    expect(
      organizationRoleChangeResultSchema.safeParse({
        ...base,
        role: customRole(2),
      }).success,
    ).toBe(false);
    expect(
      organizationRoleChangeResultSchema.safeParse({
        ...base,
        operation: "retire_role",
      }).success,
    ).toBe(false);
    expect(
      organizationRoleChangeResultSchema.safeParse({
        ...base,
        correlationId: "fedcbafe-dcba-4fed-8cba-fedcbafedcba",
      }).success,
    ).toBe(false);
    expect(
      organizationRoleChangeResultSchema.safeParse({ ...base, outcome: "unchanged" }).success,
    ).toBe(false);
    expect(
      organizationRoleChangeResultSchema.safeParse({ ...base, databaseTimestamp: changedAt })
        .success,
    ).toBe(false);
  });

  it.each([
    ["create_custom", applicationRole(1)],
    ["create_custom_from_template", applicationRole(1)],
    ["accept_new_application_role", customRole(1)],
    ["revise_custom_permissions", applicationRole(2)],
    ["accept_application_role_revision", customRole(2)],
    ["retire_role", customRole(2)],
  ] as const)("refuses a role kind or lifecycle incompatible with %s", (operation, role) => {
    expect(
      organizationRoleChangeResultSchema.safeParse({
        outcome: "changed",
        operation,
        role,
        accessVersion: 5,
        correlationId,
      }).success,
    ).toBe(false);
  });

  it("binds a created policy to the exact role, actor, instant and correlation", () => {
    const policyFingerprint = fingerprint("e");
    const role = {
      ...customRole(1),
      assignmentPolicy: {
        kind: "activation_required" as const,
        activationPolicy: {
          activationPolicyId,
          revision: 3,
          fingerprint: policyFingerprint,
        },
      },
    };
    const createdActivationPolicy = {
      organizationId: organizationId.toUpperCase(),
      roleId: roleId.toUpperCase(),
      activationPolicyId: activationPolicyId.toUpperCase(),
      revision: 3,
      fingerprint: policyFingerprint,
      maximumActivationDurationSeconds: 900,
      reasonRequired: true,
      recentAuthentication: { kind: "multi_factor" as const, maximumAgeSeconds: 600 },
      independentApprovalRequired: true,
      changedByActorId: actorId,
      changedAt: "2026-09-06T02:00:00+12:00",
      changeCorrelationId: correlationId,
    };
    const result = {
      outcome: "changed" as const,
      operation: "create_custom" as const,
      role,
      createdActivationPolicy,
      accessVersion: 5,
      correlationId,
    };
    expect(organizationId.toUpperCase()).not.toBe(organizationId);
    expect(organizationRoleChangeResultSchema.safeParse(result).success).toBe(true);

    for (const changedPolicy of [
      { ...createdActivationPolicy, roleId: applicationRootId },
      { ...createdActivationPolicy, revision: 2 },
      { ...createdActivationPolicy, fingerprint: fingerprint("f") },
      { ...createdActivationPolicy, changedByActorId: accountId },
      { ...createdActivationPolicy, changedAt: "2026-09-05T14:00:00.001Z" },
      { ...createdActivationPolicy, changeCorrelationId: accountId },
    ])
      expect(
        organizationRoleChangeResultSchema.safeParse({
          ...result,
          createdActivationPolicy: changedPolicy,
        }).success,
      ).toBe(false);

    expect(
      organizationRoleChangeResultSchema.safeParse({
        ...result,
        role: customRole(1),
      }).success,
    ).toBe(false);
  });
});
