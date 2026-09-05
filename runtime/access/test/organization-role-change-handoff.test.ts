import type {
  OrganizationRoleChangeCandidate,
  OrganizationRoleChangeCommand,
  PreparedApplicationRoleTemplates,
  PreparedOrganizationRoleChange,
  RolePermissionEntry,
} from "@vortex/contracts";
import { organizationRoleChangePreparationSchema } from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { fingerprintCanonicalValue } from "@vortex/definition";
import * as shippingAccess from "../src/index";
import { describe, expect, it } from "vitest";
import { prepareOrganizationRoleChangeEvidence } from "../src/organization-role-change-evidence";
import { fingerprintPermissionMeaning } from "../src/permission-fingerprints";
import {
  OrganizationRoleChangeHandoffError,
  createOrganizationRoleChangeOwnerHandoff,
} from "../test-support/organization-role-change-handoff";

const fingerprint = (character: string): string => `sha256:${character.repeat(64)}`;

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const roleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const applicationRootId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const sourceRoleId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd4";
const permissionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5";
const pageId = "ffffffff-ffff-4fff-8fff-fffffffffff6";
const activationPolicyId = "abcdefab-cdef-4abc-8def-abcdefabcde7";
const actorId = "fedcbafe-dcba-4fed-8cba-fedcbafedcb8";
const correlationId = "abcdefab-cdef-4abc-8def-abcdefabcde9";
const changedAt = "2026-09-05T14:00:00.000Z";

const permission = {
  permissionId,
  key: "test.fixture.read",
  label: "Read fixture records",
  description: "Read neutral fixture records.",
  actionKind: "read" as const,
  administrative: false,
};
const release = {
  kind: "application" as const,
  definitionKey: "test.fixture",
  rootId: applicationRootId,
  releaseRevision: 3,
  releaseVersion: "1.2.0",
  validationContractVersion: "2.18.0",
  contentFingerprint: fingerprint("1"),
  resolutionFingerprint: fingerprint("2"),
};

const preparedTemplates = (uppercaseIdentities = false): PreparedApplicationRoleTemplates => {
  const preparedApplicationRootId = uppercaseIdentities
    ? applicationRootId.toUpperCase()
    : applicationRootId;
  const preparedSourceRoleId = uppercaseIdentities ? sourceRoleId.toUpperCase() : sourceRoleId;
  const preparedPermissionId = uppercaseIdentities ? permissionId.toUpperCase() : permissionId;
  const preparedPermission = { ...permission, permissionId: preparedPermissionId };
  const preparedRelease = { ...release, rootId: preparedApplicationRootId };
  const applicationCatalogueFingerprint = fingerprintCanonicalValue([preparedPermission]);
  const entry = {
    applicationRootId: preparedApplicationRootId,
    ownerKind: "application" as const,
    ownerId: preparedApplicationRootId,
    permission: preparedPermission,
    sourceRelease: preparedRelease,
    meaningFingerprint: fingerprintPermissionMeaning(
      "application",
      preparedApplicationRootId,
      preparedPermission,
    ),
  };
  const registrationCore = {
    contractVersion: "1.0.0" as const,
    organizationId,
    applicationRootId: preparedApplicationRootId,
    applicationRelease: preparedRelease,
    applicationCatalogueFingerprint,
    applicationPermissionIds: [preparedPermissionId],
    entries: [entry],
  };
  const template = {
    roleId: preparedSourceRoleId,
    key: "fixture_reader",
    name: "Fixture reader",
    homePageId: pageId,
    permissionKeys: [permission.key],
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
        sourcePermissions: [entry],
        livePermissions: [entry],
      },
    ],
  };
  return { ...core, candidateFingerprint: fingerprintCanonicalValue(core) };
};

const permissionEntries = (
  prepared: PreparedApplicationRoleTemplates = preparedTemplates(),
): RolePermissionEntry[] => {
  const entry = prepared.templates[0]!.livePermissions[0]!;
  return [
    {
      kind: "exact",
      applicationRootId: entry.applicationRootId,
      ownerKind: entry.ownerKind,
      ownerId: entry.ownerId,
      permissionId: entry.permission.permissionId,
      acceptedRegistrationRevision: 4,
      catalogueFingerprint: prepared.permissionRegistration.applicationCatalogueFingerprint,
      continuityRevision: 2,
      meaningFingerprint: entry.meaningFingerprint,
    },
  ];
};

const configuration = {
  key: "fixture_reader",
  label: "Fixture reader",
  description: "A neutral fixture role.",
  privilegeClassification: "standard" as const,
  assignmentPolicy: { kind: "standing" as const },
};

const candidate = (operation: OrganizationRoleChangeCandidate["operation"]): unknown => {
  const identity = { organizationId, roleId };
  const template = {
    preparedTemplates: preparedTemplates(),
    sourceRoleId,
    templateContinuityRevision: 2,
    permissions: permissionEntries(),
  };
  switch (operation) {
    case "create_custom":
      return { operation, ...identity, ...configuration, permissions: permissionEntries() };
    case "create_custom_from_template":
    case "accept_new_application_role":
      return { operation, ...identity, ...configuration, ...template };
    case "revise_metadata_policy":
      return { operation, ...identity, expectedRoleRevision: 2, ...configuration };
    case "revise_custom_permissions":
      return {
        operation,
        ...identity,
        expectedRoleRevision: 2,
        ...configuration,
        permissions: permissionEntries(),
      };
    case "accept_application_role_revision":
      return {
        operation,
        ...identity,
        expectedRoleRevision: 2,
        ...configuration,
        ...template,
      };
    case "retire_role":
      return { operation, ...identity, expectedRoleRevision: 2 };
  }
};

const prepare = (
  operation: OrganizationRoleChangeCandidate["operation"],
  override: Readonly<Record<string, unknown>> = {},
): PreparedOrganizationRoleChange =>
  prepareOrganizationRoleChangeEvidence(
    organizationRoleChangePreparationSchema.parse({
      candidate: { ...(candidate(operation) as object), ...override },
    }),
  );

const tamperedSelectedLiveProjection = (): PreparedOrganizationRoleChange => {
  const evidence = prepare("accept_new_application_role");
  const roleCandidate = evidence.candidate;
  if (roleCandidate.operation !== "accept_new_application_role")
    throw new Error("application acceptance evidence required");
  const prepared = roleCandidate.preparedTemplates;
  const selected = prepared.templates[0]!;
  const tamperedTemplate = {
    ...selected,
    livePermissions: [
      {
        ...selected.livePermissions[0]!,
        permission: {
          ...selected.livePermissions[0]!.permission,
          label: "Tampered live projection",
        },
      },
    ],
  };
  const preparedCore = {
    contractVersion: prepared.contractVersion,
    preparationBasis: prepared.preparationBasis,
    permissionRegistration: prepared.permissionRegistration,
    templates: [tamperedTemplate],
  };
  const tamperedPrepared = {
    ...preparedCore,
    candidateFingerprint: fingerprintCanonicalValue(preparedCore),
  };
  const tamperedCandidate = { ...roleCandidate, preparedTemplates: tamperedPrepared };
  const configuredCandidate = {
    operation: tamperedCandidate.operation,
    organizationId: tamperedCandidate.organizationId,
    roleId: tamperedCandidate.roleId,
    key: tamperedCandidate.key,
    label: tamperedCandidate.label,
    description: tamperedCandidate.description,
    privilegeClassification: tamperedCandidate.privilegeClassification,
    assignmentPolicy: tamperedCandidate.assignmentPolicy,
    sourceRoleId: tamperedCandidate.sourceRoleId,
    templateContinuityRevision: tamperedCandidate.templateContinuityRevision,
    permissions: tamperedCandidate.permissions,
  };
  const basis = tamperedPrepared.preparationBasis;
  if (basis.kind !== "current_active_registration") throw new Error("current basis required");
  const templateSource = {
    preparedTemplateCandidateFingerprint: tamperedPrepared.candidateFingerprint,
    applicationRootId: tamperedPrepared.permissionRegistration.applicationRootId,
    sourceRoleId: tamperedCandidate.sourceRoleId,
    sourceRelease: tamperedPrepared.permissionRegistration.applicationRelease,
    sourceTemplateFingerprint: tamperedTemplate.sourceTemplateFingerprint,
    sourceCatalogueFingerprint:
      tamperedPrepared.permissionRegistration.applicationCatalogueFingerprint,
    acceptedRegistrationRevision: basis.registrationRevision,
    templateContinuityRevision: tamperedCandidate.templateContinuityRevision,
  };
  const acceptedGrantFingerprint = fingerprintCanonicalValue({
    contractVersion: "1.0.0",
    organizationId: tamperedCandidate.organizationId,
    roleId: tamperedCandidate.roleId,
    source: templateSource,
    permissions: tamperedCandidate.permissions,
  });
  const candidateCore = {
    contractVersion: "1.0.0" as const,
    candidate: { ...configuredCandidate, templateSource },
    acceptedGrantFingerprint,
  };
  return {
    contractVersion: "1.0.0",
    candidate: tamperedCandidate,
    acceptedGrantFingerprint,
    roleCandidateFingerprint: fingerprintCanonicalValue(candidateCore),
  } as PreparedOrganizationRoleChange;
};

const command = (
  evidence: PreparedOrganizationRoleChange = prepare("create_custom"),
): OrganizationRoleChangeCommand => ({ evidence, changedBy: actorId, correlationId });

const storedPolicy = (evidence: PreparedOrganizationRoleChange) => {
  const roleCandidate = evidence.candidate;
  if (!("assignmentPolicy" in roleCandidate)) return { kind: "standing" as const };
  if (roleCandidate.assignmentPolicy.kind === "standing") return roleCandidate.assignmentPolicy;
  const selection = roleCandidate.assignmentPolicy.activationPolicy;
  return {
    kind: "activation_required" as const,
    activationPolicy:
      selection.selection === "existing"
        ? selection.reference
        : {
            activationPolicyId: selection.policy.activationPolicyId,
            revision: selection.policy.revision,
            fingerprint: evidence.newActivationPolicyFingerprint!,
          },
  };
};

const applicationSource = (evidence: PreparedOrganizationRoleChange) => {
  const roleCandidate = evidence.candidate;
  if (!("preparedTemplates" in roleCandidate)) throw new Error("template evidence required");
  const registration = roleCandidate.preparedTemplates.permissionRegistration;
  const basis = roleCandidate.preparedTemplates.preparationBasis;
  if (basis.kind !== "current_active_registration") throw new Error("current basis required");
  const template = roleCandidate.preparedTemplates.templates.find(
    (entry) => entry.template.roleId.toLowerCase() === roleCandidate.sourceRoleId.toLowerCase(),
  )!;
  return {
    applicationRootId: registration.applicationRootId.toLowerCase(),
    sourceRoleId: roleCandidate.sourceRoleId.toLowerCase(),
    sourceRelease: {
      ...registration.applicationRelease,
      rootId: registration.applicationRelease.rootId.toLowerCase(),
    },
    sourceTemplateFingerprint: template.sourceTemplateFingerprint,
    sourceCatalogueFingerprint: registration.applicationCatalogueFingerprint,
    acceptedRegistrationRevision: basis.registrationRevision,
    templateContinuityRevision: roleCandidate.templateContinuityRevision,
    acceptedGrantFingerprint: evidence.acceptedGrantFingerprint!,
  };
};

const storedRole = (evidence: PreparedOrganizationRoleChange): DatabaseRow => {
  const roleCandidate = evidence.candidate;
  const create = [
    "create_custom",
    "create_custom_from_template",
    "accept_new_application_role",
  ].includes(roleCandidate.operation);
  const suppliedPermissions =
    "permissions" in roleCandidate ? roleCandidate.permissions : undefined;
  const base = {
    roleId: roleCandidate.roleId,
    organizationId: roleCandidate.organizationId,
    key: "key" in roleCandidate ? roleCandidate.key : configuration.key,
    label: "label" in roleCandidate ? roleCandidate.label : configuration.label,
    description:
      "description" in roleCandidate ? roleCandidate.description : configuration.description,
    liveRevision: create ? 1 : roleCandidate.expectedRoleRevision + 1,
    privilegeClassification:
      "privilegeClassification" in roleCandidate
        ? roleCandidate.privilegeClassification
        : configuration.privilegeClassification,
    assignmentPolicy: storedPolicy(evidence),
    policyContinuityRevision: 1,
    authorityContinuityRevision: 1,
    lifecycle: roleCandidate.operation === "retire_role" ? "retired" : "active",
    permissions: suppliedPermissions ?? permissionEntries(),
    createdByActorId: actorId,
    createdAt: changedAt,
    changedByActorId: actorId,
    changedAt,
    changeCorrelationId: correlationId,
  };
  if (
    roleCandidate.operation === "accept_new_application_role" ||
    roleCandidate.operation === "accept_application_role_revision"
  )
    return {
      ...base,
      kind: "application",
      applicationRootId:
        roleCandidate.preparedTemplates.permissionRegistration.applicationRootId.toLowerCase(),
      source: applicationSource(evidence),
    };
  if (roleCandidate.operation === "create_custom_from_template") {
    const source = applicationSource({
      ...evidence,
      acceptedGrantFingerprint: evidence.acceptedGrantFingerprint ?? fingerprint("9"),
    });
    return {
      ...base,
      kind: "custom",
      derivedFromTemplate: {
        applicationRootId: source.applicationRootId,
        sourceRoleId: source.sourceRoleId,
        sourceRelease: source.sourceRelease,
        sourceTemplateFingerprint: source.sourceTemplateFingerprint,
      },
    };
  }
  return { ...base, kind: "custom" };
};

const createdPolicy = (evidence: PreparedOrganizationRoleChange): DatabaseRow => {
  const roleCandidate = evidence.candidate;
  if (
    !("assignmentPolicy" in roleCandidate) ||
    roleCandidate.assignmentPolicy.kind !== "activation_required" ||
    roleCandidate.assignmentPolicy.activationPolicy.selection !== "new"
  )
    throw new Error("new policy evidence required");
  const policy = roleCandidate.assignmentPolicy.activationPolicy.policy;
  return {
    organizationId: roleCandidate.organizationId,
    roleId: roleCandidate.roleId,
    activationPolicyId: policy.activationPolicyId,
    revision: policy.revision,
    fingerprint: evidence.newActivationPolicyFingerprint,
    maximumActivationDurationSeconds: policy.maximumActivationDurationSeconds,
    reasonRequired: policy.reasonRequired,
    recentAuthentication: policy.recentAuthentication,
    independentApprovalRequired: policy.independentApprovalRequired,
    changedByActorId: actorId,
    changedAt,
    changeCorrelationId: correlationId,
  };
};

const resultRow = (
  evidence: PreparedOrganizationRoleChange,
  override: Readonly<Record<string, unknown>> = {},
): DatabaseRow => ({
  outcome: "changed",
  operation: evidence.candidate.operation,
  role: storedRole(evidence),
  created_activation_policy: null,
  access_version: "5",
  correlation_id: correlationId,
  ...override,
});

type QueryCall = Readonly<{ text: string; values: readonly DatabaseValue[] }>;
const transactionFor = (
  responder: (call: QueryCall) => readonly DatabaseRow[],
  calls: QueryCall[] = [],
): RequestDatabaseTransaction => ({
  query: async <Row extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => {
    const call = { text: strings.join("$value"), values };
    calls.push(call);
    return responder(call) as readonly Row[];
  },
});

describe("owner-only organization role-change handoff contract proof", () => {
  it("keeps the test handoff out of the shipping Access surface", () => {
    const exports = Object.keys(shippingAccess);
    expect(exports).not.toContain("createOrganizationRoleChangeOwnerHandoff");
    expect(exports).not.toContain("OrganizationRoleChangeHandoffError");
    expect(exports).not.toContain("organizationRoleChangeHandoffErrorCodes");
  });

  it("verifies canonical evidence and makes one exact coordinator call", async () => {
    const calls: QueryCall[] = [];
    const evidence = prepare("create_custom");
    const handoff = createOrganizationRoleChangeOwnerHandoff(
      transactionFor(() => [resultRow(evidence)], calls),
    );

    await expect(handoff.change(command(evidence))).resolves.toMatchObject({
      outcome: "changed",
      operation: "create_custom",
      role: { roleId, organizationId, liveRevision: 1, kind: "custom", lifecycle: "active" },
      accessVersion: 5,
      correlationId,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_access.coordinate_organization_role_change");
    expect(calls[0]?.text).not.toContain("organization_role_revisions");
    expect(calls[0]?.values).toEqual([JSON.stringify(evidence), actorId, correlationId]);
  });

  it("refuses noncanonical prepared evidence before storage", async () => {
    const calls: QueryCall[] = [];
    const evidence = {
      ...prepare("create_custom"),
      roleCandidateFingerprint: fingerprint("0"),
    } as PreparedOrganizationRoleChange;
    const handoff = createOrganizationRoleChangeOwnerHandoff(transactionFor(() => [], calls));

    await expect(handoff.change(command(evidence))).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_CHANGE_COMMAND",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a recomputed-looking selected-template live projection before storage", async () => {
    const calls: QueryCall[] = [];
    const evidence = tamperedSelectedLiveProjection();
    const original = prepare("accept_new_application_role");
    const handoff = createOrganizationRoleChangeOwnerHandoff(transactionFor(() => [], calls));

    await expect(handoff.change(command(evidence))).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_CHANGE_COMMAND",
    });
    expect(evidence.candidate.preparedTemplates.candidateFingerprint).not.toBe(
      original.candidate.preparedTemplates.candidateFingerprint,
    );
    expect(evidence.roleCandidateFingerprint).not.toBe(original.roleCandidateFingerprint);
    expect(calls).toHaveLength(0);
  });

  it("accepts case-equivalent UUID identities and still refuses a true source mismatch", async () => {
    const prepared = preparedTemplates(true);
    const evidence = prepareOrganizationRoleChangeEvidence(
      organizationRoleChangePreparationSchema.parse({
        candidate: {
          ...(candidate("accept_new_application_role") as object),
          preparedTemplates: prepared,
          sourceRoleId: sourceRoleId.toUpperCase(),
          permissions: permissionEntries(prepared),
        },
      }),
    );
    const upperCommand = {
      ...command(evidence),
      changedBy: actorId.toUpperCase(),
      correlationId: correlationId.toUpperCase(),
    };
    const accepted = createOrganizationRoleChangeOwnerHandoff(
      transactionFor(() => [resultRow(evidence)]),
    );

    await expect(accepted.change(upperCommand)).resolves.toMatchObject({
      role: {
        applicationRootId,
        source: {
          applicationRootId,
          sourceRoleId,
          sourceRelease: { rootId: applicationRootId },
        },
      },
      correlationId,
    });

    const mismatched = createOrganizationRoleChangeOwnerHandoff(
      transactionFor(() => [
        resultRow(evidence, {
          role: {
            ...storedRole(evidence),
            source: { ...applicationSource(evidence), sourceRoleId: roleId },
          },
        }),
      ]),
    );
    await expect(mismatched.change(upperCommand)).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_CHANGE_STORAGE_RESULT",
    });
  });

  it("binds application acceptance to the exact permission and source evidence", async () => {
    const evidence = prepare("accept_new_application_role");
    const accepted = createOrganizationRoleChangeOwnerHandoff(
      transactionFor(() => [resultRow(evidence)]),
    );
    await expect(accepted.change(command(evidence))).resolves.toMatchObject({
      operation: "accept_new_application_role",
      role: { kind: "application", source: applicationSource(evidence) },
    });

    for (const roleOverride of [
      { permissions: [] },
      { applicationRootId: roleId },
      { source: { ...applicationSource(evidence), sourceRoleId: roleId } },
    ]) {
      const refused = createOrganizationRoleChangeOwnerHandoff(
        transactionFor(() => [
          resultRow(evidence, { role: { ...storedRole(evidence), ...roleOverride } }),
        ]),
      );
      await expect(refused.change(command(evidence))).rejects.toMatchObject({
        code: "INVALID_ORGANIZATION_ROLE_CHANGE_STORAGE_RESULT",
      });
    }
  });

  it("binds custom-template provenance and submitted configuration", async () => {
    const evidence = prepare("create_custom_from_template");
    const accepted = createOrganizationRoleChangeOwnerHandoff(
      transactionFor(() => [resultRow(evidence)]),
    );
    await expect(accepted.change(command(evidence))).resolves.toMatchObject({
      operation: "create_custom_from_template",
      role: { kind: "custom", derivedFromTemplate: expect.any(Object) },
    });

    for (const roleOverride of [
      { label: "Different label" },
      { privilegeClassification: "privileged" },
      { derivedFromTemplate: undefined },
    ]) {
      const refused = createOrganizationRoleChangeOwnerHandoff(
        transactionFor(() => [
          resultRow(evidence, { role: { ...storedRole(evidence), ...roleOverride } }),
        ]),
      );
      await expect(refused.change(command(evidence))).rejects.toMatchObject({
        code: "INVALID_ORGANIZATION_ROLE_CHANGE_STORAGE_RESULT",
      });
    }
  });

  it("requires and completely binds a newly created activation policy", async () => {
    const evidence = prepare("revise_metadata_policy", {
      assignmentPolicy: {
        kind: "activation_required",
        activationPolicy: {
          selection: "new",
          policy: {
            activationPolicyId,
            revision: 1,
            maximumActivationDurationSeconds: 900,
            reasonRequired: true,
            recentAuthentication: { kind: "multi_factor", maximumAgeSeconds: 600 },
            independentApprovalRequired: true,
          },
        },
      },
    });
    const policy = createdPolicy(evidence);
    const accepted = createOrganizationRoleChangeOwnerHandoff(
      transactionFor(() => [resultRow(evidence, { created_activation_policy: policy })]),
    );
    await expect(accepted.change(command(evidence))).resolves.toMatchObject({
      createdActivationPolicy: policy,
    });

    for (const policyOverride of [
      null,
      { ...policy, activationPolicyId: roleId },
      { ...policy, revision: 2 },
      { ...policy, fingerprint: fingerprint("0") },
      { ...policy, maximumActivationDurationSeconds: 901 },
      { ...policy, reasonRequired: false },
      { ...policy, recentAuthentication: { kind: "none" } },
      { ...policy, independentApprovalRequired: false },
      { ...policy, changedByActorId: roleId },
      { ...policy, changeCorrelationId: roleId },
    ]) {
      const refused = createOrganizationRoleChangeOwnerHandoff(
        transactionFor(() => [resultRow(evidence, { created_activation_policy: policyOverride })]),
      );
      await expect(refused.change(command(evidence))).rejects.toMatchObject({
        code: "INVALID_ORGANIZATION_ROLE_CHANGE_STORAGE_RESULT",
      });
    }
  });

  it.each(["revise_custom_permissions", "accept_application_role_revision"] as const)(
    "binds the exact permission-bearing %s result",
    async (operation) => {
      const evidence = prepare(operation);
      const accepted = createOrganizationRoleChangeOwnerHandoff(
        transactionFor(() => [resultRow(evidence)]),
      );
      await expect(accepted.change(command(evidence))).resolves.toMatchObject({
        operation,
        role: { liveRevision: 3, permissions: permissionEntries() },
      });

      const refused = createOrganizationRoleChangeOwnerHandoff(
        transactionFor(() => [
          resultRow(evidence, { role: { ...storedRole(evidence), permissions: [] } }),
        ]),
      );
      await expect(refused.change(command(evidence))).rejects.toMatchObject({
        code: "INVALID_ORGANIZATION_ROLE_CHANGE_STORAGE_RESULT",
      });
    },
  );

  it("forbids a created-policy result for standing, existing-policy and retirement changes", async () => {
    const existing = prepare("revise_metadata_policy", {
      assignmentPolicy: {
        kind: "activation_required",
        activationPolicy: {
          selection: "existing",
          reference: { activationPolicyId, revision: 2, fingerprint: fingerprint("e") },
        },
      },
    });
    const retired = prepare("retire_role");
    for (const evidence of [prepare("create_custom"), existing, retired]) {
      const falsePolicy = {
        organizationId,
        roleId,
        activationPolicyId,
        revision: 1,
        fingerprint: fingerprint("f"),
        maximumActivationDurationSeconds: 900,
        reasonRequired: true,
        recentAuthentication: { kind: "none" },
        independentApprovalRequired: false,
        changedByActorId: actorId,
        changedAt,
        changeCorrelationId: correlationId,
      };
      const handoff = createOrganizationRoleChangeOwnerHandoff(
        transactionFor(() => [resultRow(evidence, { created_activation_policy: falsePolicy })]),
      );
      await expect(handoff.change(command(evidence))).rejects.toMatchObject({
        code: "INVALID_ORGANIZATION_ROLE_CHANGE_STORAGE_RESULT",
      });
    }
  });

  it.each([
    ["operation", { operation: "create_custom_from_template" }],
    ["organization", { role: { ...storedRole(prepare("create_custom")), organizationId: roleId } }],
    ["role", { role: { ...storedRole(prepare("create_custom")), roleId: organizationId } }],
    ["revision", { role: { ...storedRole(prepare("create_custom")), liveRevision: 2 } }],
    ["creator", { role: { ...storedRole(prepare("create_custom")), createdByActorId: roleId } }],
    ["actor", { role: { ...storedRole(prepare("create_custom")), changedByActorId: roleId } }],
    [
      "role correlation",
      { role: { ...storedRole(prepare("create_custom")), changeCorrelationId: roleId } },
    ],
    ["outer correlation", { correlation_id: roleId }],
    ["configuration", { role: { ...storedRole(prepare("create_custom")), key: "other_key" } }],
  ])("refuses a valid-shaped storage result with wrong %s binding", async (_name, override) => {
    const evidence = prepare("create_custom");
    const handoff = createOrganizationRoleChangeOwnerHandoff(
      transactionFor(() => [resultRow(evidence, override)]),
    );
    await expect(handoff.change(command(evidence))).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_CHANGE_STORAGE_RESULT",
    });
  });

  it("binds update revision but does not fabricate prior metadata for retirement", async () => {
    const retirement = prepare("retire_role");
    const role = {
      ...storedRole(retirement),
      key: "preserved_prior_key",
      label: "Preserved prior label",
      description: "Preserved by storage, not submitted by retirement.",
    };
    const handoff = createOrganizationRoleChangeOwnerHandoff(
      transactionFor(() => [resultRow(retirement, { role })]),
    );
    await expect(handoff.change(command(retirement))).resolves.toMatchObject({
      operation: "retire_role",
      role: { liveRevision: 3, lifecycle: "retired", key: "preserved_prior_key" },
    });
  });

  it("refuses malformed commands and row cardinality", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationRoleChangeOwnerHandoff(transactionFor(() => [], calls));
    await expect(
      handoff.change({
        ...command(),
        correlationId: "not-a-uuid",
      } as OrganizationRoleChangeCommand),
    ).rejects.toMatchObject({ code: "INVALID_ORGANIZATION_ROLE_CHANGE_COMMAND" });
    expect(calls).toHaveLength(0);

    await expect(handoff.change(command())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_CHANGE_STORAGE_RESULT",
    });
    const multiple = createOrganizationRoleChangeOwnerHandoff(
      transactionFor(() => [
        resultRow(prepare("create_custom")),
        resultRow(prepare("create_custom")),
      ]),
    );
    await expect(multiple.change(command())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_CHANGE_STORAGE_RESULT",
    });
  });

  it.each([
    ["22023", "INVALID_ORGANIZATION_ROLE_CHANGE_COMMAND"],
    ["42501", "ORGANIZATION_ROLE_CHANGE_SCOPE_UNAVAILABLE"],
    ["22003", "ORGANIZATION_ROLE_CHANGE_VERSION_EXHAUSTED"],
    ["23503", "ORGANIZATION_ROLE_CHANGE_STALE_OR_UNAVAILABLE"],
    ["23505", "ORGANIZATION_ROLE_CHANGE_STALE_OR_UNAVAILABLE"],
    ["23514", "ORGANIZATION_ROLE_CHANGE_STALE_OR_UNAVAILABLE"],
    ["40001", "ORGANIZATION_ROLE_CHANGE_STALE_OR_UNAVAILABLE"],
    ["55000", "ORGANIZATION_ROLE_CHANGE_STALE_OR_UNAVAILABLE"],
    ["XX000", "ORGANIZATION_ROLE_CHANGE_FAILED"],
  ])("maps SQLSTATE %s without exposing storage detail", async (databaseCode, expectedCode) => {
    const handoff = createOrganizationRoleChangeOwnerHandoff({
      query: async () => {
        throw { code: databaseCode, message: "sensitive database detail" };
      },
    });
    await expect(handoff.change(command())).rejects.toEqual(
      new OrganizationRoleChangeHandoffError(
        expectedCode as ConstructorParameters<typeof OrganizationRoleChangeHandoffError>[0],
      ),
    );
  });
});
