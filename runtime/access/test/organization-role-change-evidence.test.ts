import {
  organizationRoleChangePreparationSchema,
  organizationRoleChangeResultSchema,
  type OrganizationRoleChangeCandidate,
  type PreparedApplicationRoleTemplates,
  type RolePermissionEntry,
} from "@vortex/contracts";
import { canonicalJson, fingerprintCanonicalValue } from "@vortex/definition";
import { describe, expect, it } from "vitest";
import {
  OrganizationRoleChangeEvidenceError,
  prepareOrganizationRoleChangeEvidence,
  verifyPreparedOrganizationRoleChangeEvidence,
} from "../src/organization-role-change-evidence";
import { fingerprintPermissionMeaning } from "../src/permission-fingerprints";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const fingerprint = (character: string): string => `sha256:${character.repeat(64)}`;

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const applicationRootId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const sourceRoleId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const roleId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd4";
const caseAssignmentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee50";
const applicationRelease = {
  kind: "application" as const,
  definitionKey: "example.orders",
  rootId: applicationRootId,
  releaseRevision: 3,
  releaseVersion: "1.2.0",
  validationContractVersion: "2.17.0",
  contentFingerprint: fingerprint("1"),
  resolutionFingerprint: fingerprint("2"),
};
const permissionDeclarations = [
  {
    permissionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee20",
    key: "example.orders.read",
    label: "View Orders",
    description: "View orders.",
    actionKind: "read" as const,
    administrative: false,
  },
  {
    permissionId: "ffffffff-ffff-4fff-8fff-ffffffffff21",
    key: "example.orders.manage",
    label: "Manage Orders",
    description: "Manage orders.",
    actionKind: "manage" as const,
    administrative: true,
  },
];

const preparedTemplates = (): PreparedApplicationRoleTemplates => {
  const applicationPermissions = permissionDeclarations.filter(
    (permission) => !permission.administrative,
  );
  const applicationCatalogueFingerprint = fingerprintCanonicalValue(applicationPermissions);
  const entries = permissionDeclarations
    .map((permission) => ({
      applicationRootId,
      ownerKind: "application" as const,
      ownerId: applicationRootId,
      permission,
      sourceRelease: applicationRelease,
      meaningFingerprint: fingerprintPermissionMeaning(
        "application",
        applicationRootId,
        permission,
      ),
    }))
    .sort((left, right) => left.permission.key.localeCompare(right.permission.key));
  const registrationCore = {
    contractVersion: "1.0.0" as const,
    organizationId,
    applicationRootId,
    applicationRelease,
    applicationCatalogueFingerprint,
    applicationPermissionIds: applicationPermissions.map((permission) => permission.permissionId),
    entries,
  };
  const template = {
    roleId: sourceRoleId,
    key: "order_manager",
    name: "Order Manager",
    homePageId: id(30),
    permissionKeys: entries.map((entry) => entry.permission.key),
    permissionSelection: { kind: "exact" as const },
  };
  const core = {
    contractVersion: "1.0.0" as const,
    preparationBasis: {
      kind: "current_active_registration" as const,
      registrationRevision: 4,
    },
    permissionRegistration: {
      ...registrationCore,
      candidateFingerprint: fingerprintCanonicalValue(registrationCore),
    },
    templates: [
      {
        template,
        sourceTemplateFingerprint: fingerprintCanonicalValue(template),
        sourcePermissions: entries,
        livePermissions: entries,
      },
    ],
  };
  return { ...core, candidateFingerprint: fingerprintCanonicalValue(core) };
};

const permissionEntries = (): RolePermissionEntry[] => {
  const prepared = preparedTemplates();
  return prepared.templates[0]!.livePermissions.map((entry) => ({
    kind: "exact",
    applicationRootId: entry.applicationRootId,
    ownerKind: entry.ownerKind,
    ownerId: entry.ownerId,
    permissionId: entry.permission.permissionId,
    acceptedRegistrationRevision: 4,
    catalogueFingerprint: prepared.permissionRegistration.applicationCatalogueFingerprint,
    continuityRevision: 2,
    meaningFingerprint: entry.meaningFingerprint,
  }));
};

const configuration = {
  key: "local_role_key",
  label: "Local Role Label",
  description: "A local role whose display text keeps its exact case.",
  privilegeClassification: "privileged" as const,
  assignmentPolicy: { kind: "standing" as const },
};

const templateFields = () => ({
  preparedTemplates: preparedTemplates(),
  sourceRoleId,
  templateContinuityRevision: 2,
  permissions: permissionEntries(),
});

const candidate = (operation: OrganizationRoleChangeCandidate["operation"]): unknown => {
  const identity = { organizationId, roleId };
  switch (operation) {
    case "create_custom":
      return { operation, ...identity, ...configuration, permissions: permissionEntries() };
    case "create_custom_from_template":
    case "accept_new_application_role":
      return { operation, ...identity, ...configuration, ...templateFields() };
    case "revise_metadata_policy":
      return { operation, ...identity, expectedRoleRevision: 3, ...configuration };
    case "revise_custom_permissions":
      return {
        operation,
        ...identity,
        expectedRoleRevision: 3,
        ...configuration,
        permissions: permissionEntries(),
      };
    case "accept_application_role_revision":
      return {
        operation,
        ...identity,
        expectedRoleRevision: 3,
        ...configuration,
        ...templateFields(),
      };
    case "retire_role":
      return { operation, ...identity, expectedRoleRevision: 3 };
  }
};

const prepare = (
  operation: OrganizationRoleChangeCandidate["operation"],
  affectedAssignments?: unknown[],
) =>
  prepareOrganizationRoleChangeEvidence(
    organizationRoleChangePreparationSchema.parse({
      candidate: candidate(operation),
      ...(affectedAssignments === undefined ? {} : { affectedAssignments }),
    }),
  );

describe("organization role-change canonical evidence", () => {
  it("prepares and verifies all seven closed role-change intents", () => {
    const operations: OrganizationRoleChangeCandidate["operation"][] = [
      "create_custom",
      "create_custom_from_template",
      "accept_new_application_role",
      "revise_metadata_policy",
      "revise_custom_permissions",
      "accept_application_role_revision",
      "retire_role",
    ];

    for (const operation of operations) {
      const prepared = prepare(operation);
      expect(prepared.candidate.operation).toBe(operation);
      expect(verifyPreparedOrganizationRoleChangeEvidence(prepared)).toEqual(prepared);
    }
  });

  it("normalizes only identity UUIDs, sorts permissions, and keeps arbitrary text exact", () => {
    const raw = candidate("create_custom") as Record<string, unknown>;
    const permissions = [...(raw.permissions as RolePermissionEntry[])].reverse().map((entry) => ({
      ...entry,
      applicationRootId: entry.applicationRootId!.toUpperCase(),
      ownerId: entry.ownerId.toUpperCase(),
      permissionId: entry.permissionId.toUpperCase(),
    }));
    const prepared = prepareOrganizationRoleChangeEvidence(
      organizationRoleChangePreparationSchema.parse({
        candidate: {
          ...raw,
          organizationId: organizationId.toUpperCase(),
          roleId: roleId.toUpperCase(),
          permissions,
        },
      }),
    );

    expect(organizationId.toUpperCase()).not.toBe(organizationId);
    expect(roleId.toUpperCase()).not.toBe(roleId);
    expect(prepared.candidate.organizationId).toBe(organizationId);
    expect(prepared.candidate.roleId).toBe(roleId);
    expect("label" in prepared.candidate && prepared.candidate.label).toBe("Local Role Label");
    expect("permissions" in prepared.candidate && prepared.candidate.permissions).toEqual(
      [...permissionEntries()].sort((left, right) =>
        left.permissionId.localeCompare(right.permissionId),
      ),
    );
  });

  it("rejects case-equivalent duplicate permission and assignment identities", () => {
    const custom = candidate("create_custom") as Record<string, unknown>;
    const permissions = custom.permissions as RolePermissionEntry[];
    const duplicatePermission = {
      ...permissions[0]!,
      applicationRootId: permissions[0]!.applicationRootId!.toUpperCase(),
      ownerId: permissions[0]!.ownerId.toUpperCase(),
      permissionId: permissions[0]!.permissionId.toUpperCase(),
    };
    expect(duplicatePermission.permissionId).not.toBe(permissions[0]!.permissionId);
    expect(() =>
      prepareOrganizationRoleChangeEvidence({
        candidate: { ...custom, permissions: [permissions[0], duplicatePermission] },
      } as never),
    ).toThrow(OrganizationRoleChangeEvidenceError);

    const assignment = {
      roleAssignmentId: caseAssignmentId,
      expectedRevision: 2,
      assignee: { kind: "organization_account", organizationAccountId: id(51) },
    };
    expect(() =>
      prepareOrganizationRoleChangeEvidence({
        candidate: candidate("revise_metadata_policy"),
        affectedAssignments: [
          assignment,
          { ...assignment, roleAssignmentId: caseAssignmentId.toUpperCase() },
        ],
      } as never),
    ).toThrow(OrganizationRoleChangeEvidenceError);
  });

  it("allows a nonempty custom subset but requires exact full application acceptance", () => {
    const custom = candidate("create_custom_from_template") as Record<string, unknown>;
    const app = candidate("accept_new_application_role") as Record<string, unknown>;
    expect(
      prepareOrganizationRoleChangeEvidence(
        organizationRoleChangePreparationSchema.parse({
          candidate: { ...custom, permissions: permissionEntries().slice(0, 1) },
        }),
      ).candidate.operation,
    ).toBe("create_custom_from_template");
    expect(() =>
      prepareOrganizationRoleChangeEvidence(
        organizationRoleChangePreparationSchema.parse({
          candidate: { ...app, permissions: permissionEntries().slice(0, 1) },
        }),
      ),
    ).toThrow(OrganizationRoleChangeEvidenceError);
    expect(() =>
      organizationRoleChangePreparationSchema.parse({
        candidate: { ...custom, permissions: [] },
      }),
    ).toThrow();
  });

  it("separates policy, accepted-grant, role-candidate, and assignment-manifest evidence", () => {
    const app = candidate("accept_application_role_revision") as Record<string, unknown>;
    const withNewPolicy = {
      ...app,
      assignmentPolicy: {
        kind: "activation_required",
        activationPolicy: {
          selection: "new",
          policy: {
            activationPolicyId: id(60),
            revision: 1,
            maximumActivationDurationSeconds: 900,
            reasonRequired: true,
            recentAuthentication: { kind: "multi_factor", maximumAgeSeconds: 600 },
            independentApprovalRequired: true,
          },
        },
      },
    };
    const assignments = [
      {
        roleAssignmentId: id(72),
        expectedRevision: 4,
        assignee: { kind: "group", groupId: id(82) },
      },
      {
        roleAssignmentId: id(71),
        expectedRevision: 3,
        assignee: { kind: "organization_account", organizationAccountId: id(81) },
      },
    ];
    const prepared = prepareOrganizationRoleChangeEvidence(
      organizationRoleChangePreparationSchema.parse({
        candidate: withNewPolicy,
        affectedAssignments: assignments,
      }),
    );
    const relabelled = prepareOrganizationRoleChangeEvidence(
      organizationRoleChangePreparationSchema.parse({
        candidate: { ...withNewPolicy, label: "Different display label" },
        affectedAssignments: assignments,
      }),
    );

    expect(prepared.newActivationPolicyFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(prepared.acceptedGrantFingerprint).toBe(relabelled.acceptedGrantFingerprint);
    expect(prepared.roleCandidateFingerprint).not.toBe(relabelled.roleCandidateFingerprint);
    expect(
      prepared.affectedAssignmentManifest?.assignments.map((entry) => entry.roleAssignmentId),
    ).toEqual([id(71), id(72)]);
    expect(prepared.affectedAssignmentManifest?.manifestFingerprint).not.toBe(
      relabelled.affectedAssignmentManifest?.manifestFingerprint,
    );
    expect(() =>
      verifyPreparedOrganizationRoleChangeEvidence({
        ...prepared,
        newActivationPolicyFingerprint: fingerprint("9"),
      }),
    ).toThrow(OrganizationRoleChangeEvidenceError);
    expect(() =>
      verifyPreparedOrganizationRoleChangeEvidence({
        ...prepared,
        affectedAssignmentManifest: {
          ...prepared.affectedAssignmentManifest!,
          manifestFingerprint: fingerprint("9"),
        },
      }),
    ).toThrow(OrganizationRoleChangeEvidenceError);
  });

  it("rejects tampered nested template and each derived fingerprint", () => {
    const prepared = prepare("accept_new_application_role");
    const changes: unknown[] = [
      { ...prepared, roleCandidateFingerprint: fingerprint("a") },
      { ...prepared, acceptedGrantFingerprint: fingerprint("b") },
      {
        ...prepared,
        candidate: {
          ...prepared.candidate,
          preparedTemplates: {
            ...(
              prepared.candidate as Extract<
                OrganizationRoleChangeCandidate,
                { preparedTemplates: unknown }
              >
            ).preparedTemplates,
            candidateFingerprint: fingerprint("c"),
          },
        },
      },
    ];
    for (const changed of changes)
      expect(() => verifyPreparedOrganizationRoleChangeEvidence(changed)).toThrow(
        OrganizationRoleChangeEvidenceError,
      );
  });

  it("maps absent and case-equivalent duplicate selected templates to stable evidence errors", () => {
    const missing = candidate("accept_new_application_role") as Record<string, unknown>;
    expect(() =>
      prepareOrganizationRoleChangeEvidence(
        organizationRoleChangePreparationSchema.parse({
          candidate: { ...missing, sourceRoleId: id(99) },
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "ORGANIZATION_ROLE_CHANGE_EVIDENCE_INVALID",
      }),
    );

    const duplicated = structuredClone(preparedTemplates());
    const duplicateTemplate = {
      ...duplicated.templates[0]!,
      template: {
        ...duplicated.templates[0]!.template,
        roleId: sourceRoleId.toUpperCase(),
        key: "order_manager_copy",
      },
    };
    duplicateTemplate.sourceTemplateFingerprint = fingerprintCanonicalValue(
      duplicateTemplate.template,
    );
    duplicated.templates.push(duplicateTemplate);
    const duplicateCore = Object.fromEntries(
      Object.entries(duplicated).filter(([key]) => key !== "candidateFingerprint"),
    );
    duplicated.candidateFingerprint = fingerprintCanonicalValue(duplicateCore);
    const application = candidate("accept_new_application_role") as Record<string, unknown>;
    expect(() =>
      prepareOrganizationRoleChangeEvidence(
        organizationRoleChangePreparationSchema.parse({
          candidate: { ...application, preparedTemplates: duplicated },
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "ORGANIZATION_ROLE_CHANGE_EVIDENCE_INVALID",
      }),
    );
  });

  it("forbids manifests for creates and retirement and does not invent one when absent", () => {
    expect(prepare("revise_metadata_policy").affectedAssignmentManifest).toBeUndefined();
    const assignment = {
      roleAssignmentId: caseAssignmentId,
      expectedRevision: 2,
      assignee: { kind: "organization_account", organizationAccountId: id(51) },
    };
    for (const operation of ["create_custom", "retire_role"] as const)
      expect(() => prepare(operation, [assignment])).toThrow(OrganizationRoleChangeEvidenceError);
  });

  it("keeps preparation deterministic and free of authority decisions", () => {
    const first = prepare("accept_new_application_role");
    const second = prepare("accept_new_application_role");
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(
      organizationRoleChangePreparationSchema.safeParse({
        candidate: candidate("create_custom"),
        callerAuthorized: true,
        accessVersion: 8,
      }).success,
    ).toBe(false);
  });

  it("binds created policy results to the exact stored role change", () => {
    const changedAt = "2026-09-05T14:00:00.000Z";
    const correlationId = id(90);
    const activationPolicyId = id(60);
    const policyFingerprint = fingerprint("e");
    const role = {
      roleId,
      organizationId,
      key: "local_role",
      label: "Local role",
      description: "A local role.",
      kind: "custom" as const,
      liveRevision: 1,
      privilegeClassification: "privileged" as const,
      assignmentPolicy: {
        kind: "activation_required" as const,
        activationPolicy: { activationPolicyId, revision: 1, fingerprint: policyFingerprint },
      },
      policyContinuityRevision: 1,
      authorityContinuityRevision: 1,
      lifecycle: "active" as const,
      permissions: permissionEntries(),
      createdByActorId: id(91),
      createdAt: changedAt,
      changedByActorId: id(91),
      changedAt,
      changeCorrelationId: correlationId,
    };
    const createdActivationPolicy = {
      organizationId,
      roleId,
      activationPolicyId,
      revision: 1,
      fingerprint: policyFingerprint,
      maximumActivationDurationSeconds: 900,
      reasonRequired: true,
      recentAuthentication: { kind: "primary" as const, maximumAgeSeconds: 600 },
      independentApprovalRequired: false,
      changedByActorId: id(91),
      changedAt,
      changeCorrelationId: correlationId,
    };
    const result = {
      outcome: "changed" as const,
      operation: "create_custom" as const,
      role,
      createdActivationPolicy,
      accessVersion: 2,
      correlationId,
    };
    expect(organizationRoleChangeResultSchema.safeParse(result).success).toBe(true);
    expect(
      organizationRoleChangeResultSchema.safeParse({
        ...result,
        createdActivationPolicy: {
          ...createdActivationPolicy,
          changedAt: "2026-09-05T14:00:00.001Z",
        },
      }).success,
    ).toBe(false);
    expect(
      organizationRoleChangeResultSchema.safeParse({
        ...result,
        createdActivationPolicy: {
          ...createdActivationPolicy,
          changeCorrelationId: id(92),
        },
      }).success,
    ).toBe(false);
    expect(
      organizationRoleChangeResultSchema.safeParse({
        ...result,
        createdActivationPolicy: {
          ...createdActivationPolicy,
          changedByActorId: id(92),
        },
      }).success,
    ).toBe(false);
    expect(
      organizationRoleChangeResultSchema.safeParse({
        ...result,
        operation: "retire_role",
        role: { ...role, liveRevision: 2, lifecycle: "retired" },
      }).success,
    ).toBe(false);
  });
});
