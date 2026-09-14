import {
  archiveTenantOrganizationCommandSchema,
  changeTenantAdministratorCommandSchema,
  createTenantOrganizationCommandSchema,
  grantTenantAdministratorCommandSchema,
  reactivateTenantOrganizationCommandSchema,
  renameTenantOrganizationCommandSchema,
  reparentTenantOrganizationCommandSchema,
  suspendTenantOrganizationCommandSchema,
  tenantAssignmentQuerySchema,
  tenantHierarchyQuerySchema,
  tenantLauncherQuerySchema,
} from "../src";
import { describe, expect, it } from "vitest";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const grant = () => ({
  operation: "grant_tenant_administrator" as const,
  duplicateKey: id(1),
  tenantId: id(2),
  identityId: id(3),
  capabilities: [
    "platform.tenant.administrators.manage",
    "platform.tenant.hierarchy.read",
  ] as const,
  startsAt: "2026-09-13T00:00:00.000Z",
});

describe("tenant governance contracts", () => {
  it("requires an explicit parent choice, steward nominee and complete runtime settings for creation", () => {
    const command = {
      operation: "create_tenant_organization" as const,
      duplicateKey: id(1),
      tenantId: id(2),
      parentOrganizationId: null,
      shortName: "new_organization",
      displayName: "New organisation",
      organizationSteward: {
        identityId: id(3),
        accountDisplayName: "Initial steward",
        accountLanguage: "en-NZ",
        accountTimeZone: "Pacific/Auckland",
      },
      runtimeSettings: {
        language: "en-NZ",
        timeZone: "Pacific/Auckland",
        currency: "NZD",
        dateFormat: "medium" as const,
        numberFormat: "auto" as const,
      },
    };
    expect(createTenantOrganizationCommandSchema.safeParse(command).success).toBe(true);
    expect(
      createTenantOrganizationCommandSchema.safeParse({
        ...command,
        parentOrganizationId: undefined,
      }).success,
    ).toBe(false);
    expect(
      createTenantOrganizationCommandSchema.safeParse({
        ...command,
        creatorReceivesMembership: true,
      }).success,
    ).toBe(false);
    expect(
      createTenantOrganizationCommandSchema.safeParse({
        ...command,
        runtimeSettings: { ...command.runtimeSettings, currency: "nzd" },
      }).success,
    ).toBe(false);
  });

  it("requires explicit bounded keyset pagination", () => {
    expect(tenantLauncherQuerySchema.safeParse({ limit: 100 }).success).toBe(true);
    expect(tenantLauncherQuerySchema.safeParse({}).success).toBe(false);
    expect(
      tenantHierarchyQuerySchema.safeParse({ tenantId: id(1), page: { limit: 101 } }).success,
    ).toBe(false);
    expect(
      tenantAssignmentQuerySchema.safeParse({ tenantId: id(1), page: { limit: 10, offset: 2 } })
        .success,
    ).toBe(false);
  });

  it("accepts only a canonical nonempty structural subset and no claimed authority", () => {
    expect(grantTenantAdministratorCommandSchema.safeParse(grant()).success).toBe(true);
    expect(
      grantTenantAdministratorCommandSchema.safeParse({ ...grant(), capabilities: [] }).success,
    ).toBe(false);
    expect(
      grantTenantAdministratorCommandSchema.safeParse({
        ...grant(),
        capabilities: [...grant().capabilities].reverse(),
      }).success,
    ).toBe(false);
    expect(
      grantTenantAdministratorCommandSchema.safeParse({
        ...grant(),
        callerCapabilities: grant().capabilities,
      }).success,
    ).toBe(false);
  });

  it("requires exact revisions for changes and valid windows", () => {
    expect(
      changeTenantAdministratorCommandSchema.safeParse({
        operation: "change_tenant_administrator",
        duplicateKey: id(5),
        tenantId: id(2),
        assignmentId: id(4),
        expectedRevision: 1,
        capabilities: ["platform.tenant.hierarchy.read"],
        startsAt: "2026-09-14T00:00:00.000Z",
        expiresAt: "2026-09-13T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("accepts the narrow organization hierarchy and lifecycle mutations", () => {
    expect(
      renameTenantOrganizationCommandSchema.safeParse({
        operation: "rename_tenant_organization",
        duplicateKey: id(5),
        tenantId: id(2),
        organizationId: id(4),
        expectedRevision: 3,
        displayName: "Renamed organisation",
      }).success,
    ).toBe(true);
    expect(
      reparentTenantOrganizationCommandSchema.safeParse({
        operation: "reparent_tenant_organization",
        duplicateKey: id(6),
        tenantId: id(2),
        organizationId: id(4),
        expectedRevision: 3,
        parentOrganizationId: null,
      }).success,
    ).toBe(true);
    for (const [schema, operation] of [
      [suspendTenantOrganizationCommandSchema, "suspend_tenant_organization"],
      [reactivateTenantOrganizationCommandSchema, "reactivate_tenant_organization"],
      [archiveTenantOrganizationCommandSchema, "archive_tenant_organization"],
    ] as const) {
      expect(
        schema.safeParse({
          operation,
          duplicateKey: id(7),
          tenantId: id(2),
          organizationId: id(4),
          expectedRevision: 3,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects implicit or expanded organization changes", () => {
    expect(
      renameTenantOrganizationCommandSchema.safeParse({
        operation: "rename_tenant_organization",
        duplicateKey: id(5),
        tenantId: id(2),
        organizationId: id(4),
        expectedRevision: 3,
        displayName: "",
      }).success,
    ).toBe(false);
    expect(
      reparentTenantOrganizationCommandSchema.safeParse({
        operation: "reparent_tenant_organization",
        duplicateKey: id(6),
        tenantId: id(2),
        organizationId: id(4),
        expectedRevision: 3,
      }).success,
    ).toBe(false);
    expect(
      reparentTenantOrganizationCommandSchema.safeParse({
        operation: "reparent_tenant_organization",
        duplicateKey: id(6),
        tenantId: id(2),
        organizationId: id(4),
        expectedRevision: 3,
        parentOrganizationId: id(7),
        state: "suspended",
      }).success,
    ).toBe(false);
    expect(
      suspendTenantOrganizationCommandSchema.safeParse({
        operation: "suspend_tenant_organization",
        duplicateKey: id(7),
        tenantId: id(2),
        organizationId: id(4),
        expectedRevision: 3,
        cascade: true,
      }).success,
    ).toBe(false);
    expect(
      reactivateTenantOrganizationCommandSchema.safeParse({
        operation: "reactivate_tenant_organization",
        duplicateKey: id(8),
        tenantId: id(2),
        organizationId: id(4),
        expectedRevision: 3,
        stewardIdentityId: id(9),
      }).success,
    ).toBe(false);
    expect(
      archiveTenantOrganizationCommandSchema.safeParse({
        operation: "archive_tenant_organization",
        duplicateKey: id(9),
        tenantId: id(2),
        organizationId: id(4),
        expectedRevision: 3,
        archiveChildren: true,
      }).success,
    ).toBe(false);
  });
});
