import {
  organizationAccessActionSchema,
  organizationAccessDecisionSchema,
  organizationAccessDeclarationSchema,
  organizationAccessManagementScopeSchema,
  organizationPermissionEligibilitySchema,
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
