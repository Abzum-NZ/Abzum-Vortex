import {
  adoptOrganizationCommandSchema,
  closeClusterIdentityCommandSchema,
  closeClusterIdentityResultSchema,
  configuredTenantAdministrationOperatorContextSchema,
  provisionTenantCommandSchema,
  provisionTenantResultSchema,
  reactivateClusterIdentityCommandSchema,
  suspendClusterIdentityCommandSchema,
} from "../src";
import { describe, expect, it } from "vitest";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const provision = () => ({
  operation: "provision_tenant" as const,
  duplicateKey: id(1),
  tenant: { shortName: "north", displayName: "North" },
  rootOrganization: { shortName: "root", displayName: "Root" },
  tenantSteward: { identityId: id(2) },
  organizationSteward: {
    identityId: id(3),
    accountDisplayName: "Root steward",
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
});

describe("configured tenant provisioning contracts", () => {
  it("keeps trusted operator facts outside strict commands", () => {
    expect(provisionTenantCommandSchema.safeParse(provision()).success).toBe(true);
    expect(
      provisionTenantCommandSchema.safeParse({ ...provision(), systemActorId: id(9) }).success,
    ).toBe(false);
    expect(
      configuredTenantAdministrationOperatorContextSchema.safeParse({
        kind: "configured_system_operator",
        clusterId: id(10),
        systemActorId: id(11),
      }).success,
    ).toBe(true);
  });

  it("requires separate explicit tenant and organisation steward nominations", () => {
    const missingTenant = { ...provision() } as Record<string, unknown>;
    delete missingTenant.tenantSteward;
    expect(provisionTenantCommandSchema.safeParse(missingTenant).success).toBe(false);
    expect(
      provisionTenantCommandSchema.safeParse({
        ...provision(),
        organizationSteward: { ...provision().organizationSteward, identityId: id(2) },
      }).success,
    ).toBe(true);
  });

  it("reuses canonical runtime-setting validators for account preferences", () => {
    expect(
      provisionTenantCommandSchema.safeParse({
        ...provision(),
        organizationSteward: {
          ...provision().organizationSteward,
          accountTimeZone: "+12:00",
        },
      }).success,
    ).toBe(false);
  });

  it("binds accepted results and safe refusals to exact operations", () => {
    expect(
      provisionTenantResultSchema.safeParse({
        outcome: "refused",
        operation: "provision_tenant",
        code: "duplicate_conflict",
      }).success,
    ).toBe(true);
    expect(
      adoptOrganizationCommandSchema.safeParse({
        operation: "adopt_organization",
        duplicateKey: id(20),
        tenantId: id(21),
        organizationId: id(22),
        organizationSteward: { identityId: id(23), organizationAccountId: id(24) },
        correlationId: id(25),
      }).success,
    ).toBe(false);
  });

  it("defines strict configured-system projection lifecycle commands", () => {
    const command = {
      operation: "suspend_cluster_identity" as const,
      duplicateKey: id(30),
      identityId: id(31),
      expectedRevision: 4,
    };
    expect(suspendClusterIdentityCommandSchema.safeParse(command).success).toBe(true);
    expect(
      suspendClusterIdentityCommandSchema.safeParse({ ...command, tenantId: id(32) }).success,
    ).toBe(false);
    expect(
      reactivateClusterIdentityCommandSchema.safeParse({
        ...command,
        operation: "reactivate_cluster_identity",
      }).success,
    ).toBe(true);
    expect(
      closeClusterIdentityCommandSchema.safeParse({
        ...command,
        operation: "close_cluster_identity",
        expectedRevision: 0,
      }).success,
    ).toBe(false);
  });

  it("binds lifecycle results to the target projection revision", () => {
    expect(
      closeClusterIdentityResultSchema.safeParse({
        outcome: "accepted",
        operation: "close_cluster_identity",
        identityId: id(31),
        revision: 5,
        correlationId: id(33),
        acceptedAt: "2026-09-14T10:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      closeClusterIdentityResultSchema.safeParse({
        outcome: "refused",
        operation: "close_cluster_identity",
        code: "stale_revision",
      }).success,
    ).toBe(true);
  });
});
