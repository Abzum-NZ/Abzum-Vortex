import {
  changeTenantAdministratorCommandSchema,
  grantTenantAdministratorCommandSchema,
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
});
