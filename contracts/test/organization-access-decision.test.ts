import {
  organizationAccessActionSchema,
  organizationAccessDecisionSchema,
  organizationAccessDeclarationSchema,
  organizationAccessManagementScopeSchema,
  organizationPermissionEligibilitySchema,
  organizationRecordAccessDecisionSchema,
  organizationRecordAccessDeclarationSchema,
  organizationRecordPermissionEligibilitySchema,
  safeOrganizationAccessRefusalSchema,
} from "../src/organization-access-decision";
import { describe, expect, it } from "vitest";

const id = (prefix: string, suffix: number): string =>
  `${prefix}4000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const platformPermission = () => ({
  ownerKind: "platform" as const,
  ownerId: id("a", 1),
  permissionId: id("b", 2),
});

const applicationPermission = () => ({
  applicationRootId: id("c", 3),
  ownerKind: "application" as const,
  ownerId: id("c", 3),
  permissionId: id("d", 4),
});

const modulePermission = () => ({
  applicationRootId: id("c", 3),
  ownerKind: "module" as const,
  ownerId: id("e", 5),
  permissionId: id("f", 6),
});

const organizationDeclaration = () => ({
  operationKey: "platform.organization.read",
  action: { actionKind: "read" as const },
  target: { kind: "organization" as const },
  requiredPermission: platformPermission(),
  recentAuthentication: { kind: "none" as const },
  authority: { kind: "permission" as const },
});

const applicationDeclaration = () => ({
  operationKey: "application.configuration.update",
  action: { actionKind: "update" as const },
  target: { kind: "application" as const, applicationRootId: id("c", 3) },
  requiredPermission: applicationPermission(),
  recentAuthentication: { kind: "primary" as const, maximumAgeSeconds: 300 },
  authority: { kind: "permission" as const },
});

const evidence = () => ({
  operationKey: "application.configuration.update",
  target: { kind: "application" as const, applicationRootId: id("c", 3) },
  organizationId: id("a", 10),
  organizationAccountId: id("b", 11),
  accessVersion: 12,
  checkedAt: "2026-09-06T06:00:00.000Z",
  validUntil: "2026-09-06T06:05:00.000Z",
  correlationId: id("c", 12),
});

const recordBinding = () => ({
  moduleRootId: id("e", 5),
  recordTypeId: id("a", 13),
  storageContractId: id("b", 14),
  storageScope: "application_contained" as const,
});

const recordDeclaration = () => ({
  operationKey: "module.records.read",
  action: { actionKind: "read" as const },
  target: { kind: "application" as const, applicationRootId: id("c", 3) },
  requiredPermissions: [applicationPermission(), modulePermission()].sort((left, right) => {
    const identity = (permission: {
      applicationRootId: string;
      ownerKind: string;
      ownerId: string;
      permissionId: string;
    }) =>
      [
        permission.applicationRootId.toLowerCase(),
        permission.ownerKind,
        permission.ownerId.toLowerCase(),
        permission.permissionId.toLowerCase(),
      ].join(":");
    return identity(left).localeCompare(identity(right));
  }),
  recordBinding: recordBinding(),
  recentAuthentication: { kind: "none" as const },
  authority: { kind: "permission" as const },
});

const recordPermissionEligibility = () => ({
  outcome: "eligible" as const,
  operationKey: "module.records.read",
  target: { kind: "application" as const, applicationRootId: id("c", 3) },
  organizationId: id("a", 10),
  organizationAccountId: id("b", 11),
  accessVersion: 12,
  checkedAt: "2026-09-06T06:00:00.000Z",
  validUntil: "2026-09-06T06:04:00.000Z",
  correlationId: id("c", 12),
  recordBinding: recordBinding(),
  eligiblePermissions: [
    {
      permission: modulePermission(),
      recordScope: { routes: [{ kind: "ownership" as const }] },
      source: {
        kind: "module" as const,
        definitionKey: "module.records",
        rootId: id("e", 5),
        releaseVersion: "1.2.3",
        releaseRevision: 7,
        validationContractVersion: "1.0.0",
        contentFingerprint: `sha256:${"a".repeat(64)}`,
        resolutionFingerprint: `sha256:${"b".repeat(64)}`,
      },
      validUntil: "2026-09-06T06:04:00.000Z",
    },
    {
      permission: applicationPermission(),
      recordScope: { routes: [{ kind: "all_records" as const }] },
      source: {
        kind: "application" as const,
        definitionKey: "application.records",
        rootId: id("c", 3),
        releaseVersion: "2.0.0",
        releaseRevision: 9,
        validationContractVersion: "1.0.0",
        contentFingerprint: `sha256:${"c".repeat(64)}`,
        resolutionFingerprint: `sha256:${"d".repeat(64)}`,
      },
      validUntil: "2026-09-06T06:05:00.000Z",
    },
  ],
});

const recordAccessDecision = () => {
  const eligibility = recordPermissionEligibility();
  return {
    ...eligibility,
    outcome: "allowed" as const,
    recordId: id("d", 84),
    action: { actionKind: "read" as const },
    matchedContributions: [
      {
        ...eligibility.eligiblePermissions[0]!,
        route: { kind: "ownership" as const },
      },
    ],
    validUntil: eligibility.eligiblePermissions[0]!.validUntil,
    eligiblePermissions: undefined,
  };
};

describe("organization access decision contracts", () => {
  it("accepts exact organization, application and module operation bindings", () => {
    expect(organizationAccessDeclarationSchema.safeParse(organizationDeclaration()).success).toBe(
      true,
    );
    expect(organizationAccessDeclarationSchema.safeParse(applicationDeclaration()).success).toBe(
      true,
    );
    expect(
      organizationAccessDeclarationSchema.safeParse({
        ...applicationDeclaration(),
        target: {
          kind: "application",
          applicationRootId: id("c", 3).toUpperCase(),
        },
        requiredPermission: modulePermission(),
      }).success,
    ).toBe(true);
  });

  it("requires exact target, owner and application context", () => {
    for (const declaration of [
      { ...organizationDeclaration(), requiredPermission: applicationPermission() },
      { ...applicationDeclaration(), requiredPermission: platformPermission() },
      {
        ...applicationDeclaration(),
        target: { kind: "application", applicationRootId: id("d", 20) },
      },
      {
        ...applicationDeclaration(),
        requiredPermission: { ...applicationPermission(), ownerId: id("e", 21) },
      },
      {
        ...applicationDeclaration(),
        target: { kind: "record", recordTypeId: id("f", 22), recordId: id("a", 23) },
      },
    ])
      expect(organizationAccessDeclarationSchema.safeParse(declaration).success).toBe(false);
  });

  it("binds named actions exactly and refuses record-policy bypass fields", () => {
    expect(
      organizationAccessActionSchema.safeParse({ actionKind: "named", namedAction: "approve" })
        .success,
    ).toBe(true);
    for (const action of [
      { actionKind: "named" },
      { actionKind: "read", namedAction: "approve" },
      { actionKind: "read", recordTypeId: id("a", 30) },
    ])
      expect(organizationAccessActionSchema.safeParse(action).success).toBe(false);
  });

  it("accepts minimal none, catalogue and exact bounded management scopes", () => {
    for (const scope of [
      { kind: "none" },
      { kind: "organization_catalogue" },
      { kind: "bounded", permissions: [platformPermission(), applicationPermission()] },
    ])
      expect(organizationAccessManagementScopeSchema.safeParse(scope).success).toBe(true);
    expect(
      organizationAccessDeclarationSchema.safeParse({
        ...applicationDeclaration(),
        authority: {
          kind: "delegated_management",
          before: { kind: "bounded", permissions: [applicationPermission()] },
          after: { kind: "bounded", permissions: [modulePermission()] },
        },
      }).success,
    ).toBe(true);
    for (const missing of ["before", "after"] as const) {
      const authority = {
        kind: "delegated_management",
        before: { kind: "bounded", permissions: [applicationPermission()] },
        after: { kind: "bounded", permissions: [modulePermission()] },
      } as Record<string, unknown>;
      delete authority[missing];
      expect(
        organizationAccessDeclarationSchema.safeParse({
          ...applicationDeclaration(),
          authority,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects empty, duplicate and historical management scope evidence", () => {
    const permission = applicationPermission();
    const uppercasePermission = {
      ...permission,
      applicationRootId: permission.applicationRootId.toUpperCase(),
      ownerId: permission.ownerId.toUpperCase(),
      permissionId: permission.permissionId.toUpperCase(),
    };
    expect(permission.permissionId).not.toBe(permission.permissionId.toUpperCase());
    for (const scope of [
      { kind: "bounded", permissions: [] },
      { kind: "bounded", permissions: [permission, uppercasePermission] },
      {
        kind: "bounded",
        permissions: [{ ...permission, acceptedRegistrationRevision: 1 }],
      },
      { kind: "bounded", permissions: [permission], scopeFingerprint: `sha256:${"a".repeat(64)}` },
    ])
      expect(organizationAccessManagementScopeSchema.safeParse(scope).success).toBe(false);
  });

  it("rejects delegated management with no before or after authority", () => {
    expect(
      organizationAccessDeclarationSchema.safeParse({
        ...applicationDeclaration(),
        authority: {
          kind: "delegated_management",
          before: { kind: "none" },
          after: { kind: "none" },
        },
      }).success,
    ).toBe(false);
    expect(
      organizationAccessDeclarationSchema.safeParse({
        ...applicationDeclaration(),
        authority: {
          kind: "delegated_management",
          before: { kind: "none" },
          after: { kind: "bounded", permissions: [applicationPermission()] },
        },
      }).success,
    ).toBe(true);
  });

  it("keeps caller context and authority candidates out of declarations", () => {
    for (const unexpected of [
      { organizationId: id("a", 40) },
      { organizationAccountId: id("b", 41) },
      { identityId: id("b", 45) },
      { systemActorId: id("b", 46) },
      { accessVersion: 1 },
      { correlationId: id("c", 42) },
      { candidateGrantIds: [id("d", 43)] },
      { decisionId: id("e", 44) },
      { callerKind: "system" },
      { targetPolicy: { outcome: "allowed" } },
      { contractVersion: 1 },
    ])
      expect(
        organizationAccessDeclarationSchema.safeParse({
          ...organizationDeclaration(),
          ...unexpected,
        }).success,
      ).toBe(false);
  });

  it("keeps permission eligibility distinct from final allowance", () => {
    const eligible = { outcome: "eligible", ...evidence() };
    const allowed = { outcome: "allowed", ...evidence() };
    expect(organizationPermissionEligibilitySchema.safeParse(eligible).success).toBe(true);
    expect(organizationAccessDecisionSchema.safeParse(allowed).success).toBe(true);
    expect(organizationAccessDecisionSchema.safeParse(eligible).success).toBe(false);
    expect(organizationPermissionEligibilitySchema.safeParse(allowed).success).toBe(false);
  });

  it("accepts a closed canonical record eligibility declaration", () => {
    expect(organizationRecordAccessDeclarationSchema.safeParse(recordDeclaration()).success).toBe(
      true,
    );
    const declaration = recordDeclaration();
    for (const candidate of [
      { ...declaration, requiredPermissions: [] },
      {
        ...declaration,
        requiredPermissions: [applicationPermission(), applicationPermission()],
      },
      { ...declaration, requiredPermissions: [...declaration.requiredPermissions].reverse() },
      { ...declaration, requiredPermissions: [platformPermission()] },
      {
        ...declaration,
        requiredPermissions: [
          { ...applicationPermission(), applicationRootId: id("d", 80), ownerId: id("d", 80) },
        ],
      },
      {
        ...declaration,
        requiredPermissions: [{ ...modulePermission(), ownerId: id("f", 83) }],
      },
      { ...declaration, authority: { kind: "delegated_management" } },
      { ...declaration, recordId: id("a", 81) },
      { ...declaration, recordBinding: { ...recordBinding(), predicate: "caller_choice" } },
    ])
      expect(organizationRecordAccessDeclarationSchema.safeParse(candidate).success).toBe(false);

    expect(
      organizationRecordAccessDeclarationSchema.safeParse({
        ...declaration,
        action: { actionKind: "named", namedAction: "approve" },
        requiredPermissions: [modulePermission()],
      }).success,
    ).toBe(true);
    expect(
      organizationRecordAccessDeclarationSchema.safeParse({
        ...declaration,
        action: { actionKind: "named", namedAction: "approve" },
        requiredPermissions: recordDeclaration().requiredPermissions,
      }).success,
    ).toBe(false);
  });

  it("keeps each eligible record permission bound to its own scope, source and deadline", () => {
    const eligible = recordPermissionEligibility();
    expect(organizationRecordPermissionEligibilitySchema.safeParse(eligible).success).toBe(true);
    for (const candidate of [
      { ...eligible, outcome: "allowed" },
      { ...eligible, eligiblePermissions: [] },
      { ...eligible, validUntil: "2026-09-06T06:05:00.000Z" },
      {
        ...eligible,
        eligiblePermissions: [
          {
            ...eligible.eligiblePermissions[0],
            recordScope: undefined,
          },
        ],
      },
      {
        ...eligible,
        eligiblePermissions: [
          {
            ...eligible.eligiblePermissions[0],
            source: { ...eligible.eligiblePermissions[0]!.source, rootId: id("f", 82) },
          },
        ],
      },
      {
        ...eligible,
        eligiblePermissions: [
          {
            ...eligible.eligiblePermissions[0],
            validUntil: eligible.checkedAt,
          },
        ],
        validUntil: eligible.checkedAt,
      },
      { ...eligible, rowAllowed: true },
      { ...eligible, matchedContributions: [] },
    ])
      expect(organizationRecordPermissionEligibilitySchema.safeParse(candidate).success).toBe(
        false,
      );

    const refusalEvidence: Omit<typeof eligible, "validUntil" | "eligiblePermissions"> &
      Partial<Pick<typeof eligible, "validUntil" | "eligiblePermissions">> = { ...eligible };
    delete refusalEvidence.validUntil;
    delete refusalEvidence.eligiblePermissions;
    expect(eligible.eligiblePermissions).toHaveLength(2);
    expect(
      organizationRecordPermissionEligibilitySchema.safeParse({
        ...refusalEvidence,
        outcome: "refused",
        reasonCode: "permission_not_effective",
      }).success,
    ).toBe(true);
  });

  it("accepts only complete permission-and-row contributions", () => {
    const allowed: Omit<ReturnType<typeof recordAccessDecision>, "eligiblePermissions"> &
      Partial<Pick<ReturnType<typeof recordAccessDecision>, "eligiblePermissions">> = {
      ...recordAccessDecision(),
    };
    delete allowed.eligiblePermissions;
    expect(organizationRecordAccessDecisionSchema.safeParse(allowed).success).toBe(true);

    for (const candidate of [
      { ...allowed, outcome: "eligible" },
      { ...allowed, matchedContributions: [] },
      { ...allowed, validUntil: "2026-09-06T06:05:00.000Z" },
      {
        ...allowed,
        matchedContributions: [
          {
            ...allowed.matchedContributions[0]!,
            route: { kind: "all_records" },
          },
        ],
      },
      {
        ...allowed,
        action: { actionKind: "delete" },
        matchedContributions: [
          {
            ...allowed.matchedContributions[0]!,
            recordScope: { routes: [{ kind: "direct_share" }] },
            route: {
              kind: "direct_share",
              directShareId: id("d", 90),
              directShareRevision: 1,
              readableFieldIds: [id("e", 91)],
              changeableFieldIds: [],
            },
          },
        ],
      },
      {
        ...allowed,
        matchedContributions: [
          {
            ...allowed.matchedContributions[0]!,
            recordScope: { routes: [{ kind: "direct_share" }] },
            route: {
              kind: "direct_share",
              directShareId: id("d", 90),
              directShareRevision: 1,
              readableFieldIds: [id("f", 92), id("e", 91)],
              changeableFieldIds: [id("a", 93)],
            },
          },
        ],
      },
      { ...allowed, eligiblePermissions: [] },
      { ...allowed, rowAllowed: true },
    ])
      expect(organizationRecordAccessDecisionSchema.safeParse(candidate).success).toBe(false);

    const evidenceOnly: Omit<typeof allowed, "validUntil" | "matchedContributions"> &
      Partial<Pick<typeof allowed, "validUntil" | "matchedContributions">> = { ...allowed };
    delete evidenceOnly.validUntil;
    delete evidenceOnly.matchedContributions;
    expect(allowed.matchedContributions).toHaveLength(1);
    expect(
      organizationRecordAccessDecisionSchema.safeParse({
        ...evidenceOnly,
        outcome: "refused",
        reasonCode: "record_scope_refused",
      }).success,
    ).toBe(true);
  });

  it("requires safe finite transaction-bound decision evidence", () => {
    for (const candidate of [
      { outcome: "eligible", ...evidence(), validUntil: evidence().checkedAt },
      { outcome: "eligible", ...evidence(), accessVersion: Number.MAX_SAFE_INTEGER + 1 },
      { outcome: "eligible", ...evidence(), witnessIds: [id("f", 50)] },
      { outcome: "eligible", ...evidence(), reliedOnGrantIds: [id("a", 51)] },
    ])
      expect(organizationPermissionEligibilitySchema.safeParse(candidate).success).toBe(false);
  });

  it("supports private refusals while exposing only a minimal public refusal", () => {
    const { validUntil, ...baseEvidence } = evidence();
    expect(validUntil).toBeDefined();
    expect(
      organizationAccessDecisionSchema.safeParse({
        outcome: "refused",
        ...baseEvidence,
        reasonCode: "target_policy_unavailable",
      }).success,
    ).toBe(true);

    const safeRefusal = {
      outcome: "refused",
      reasonCode: "caller_unsupported",
      correlationId: id("c", 12),
    };
    expect(safeOrganizationAccessRefusalSchema.safeParse(safeRefusal).success).toBe(true);
    for (const detail of [
      { organizationId: id("a", 10) },
      { organizationAccountId: id("b", 11) },
      { permissionId: id("c", 52) },
      { target: { kind: "organization" } },
      { witnessIds: [id("d", 53)] },
    ])
      expect(
        safeOrganizationAccessRefusalSchema.safeParse({ ...safeRefusal, ...detail }).success,
      ).toBe(false);
  });
});
