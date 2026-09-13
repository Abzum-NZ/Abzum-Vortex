import type { DatabaseRow, DatabaseValue, RuntimeDatabaseTransaction } from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import { createConfiguredTenantAdministrationService } from "../src/configured-tenant-administration";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const environment = {
  VORTEX_CLUSTER_ID: id(90),
  VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID: id(91),
};
const command = () => ({
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
const statement = (strings: TemplateStringsArray): string => strings.join("$value");
const runner =
  (
    response: readonly DatabaseRow[],
    calls: Array<{ text: string; values: readonly DatabaseValue[] }>,
  ) =>
  async <Result>(
    operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
  ): Promise<Result> =>
    operation({
      query: async <Row extends DatabaseRow>(
        strings: TemplateStringsArray,
        ...values: readonly DatabaseValue[]
      ) => {
        calls.push({ text: statement(strings), values });
        return response as readonly Row[];
      },
    });

describe("configured tenant administration service", () => {
  it("opens one outer transaction and supplies trusted configuration separately", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const runtimeTransaction = vi.fn(
      runner(
        [
          {
            outcome: "accepted",
            operation: "provision_tenant",
            tenant_id: id(10),
            root_organization_id: id(11),
            tenant_administrator_assignment_id: id(12),
            tenant_administrator_assignment_revision: 1n,
            organization_account_id: id(13),
            organization_account_revision: "1",
            access_version: 3n,
            correlation_id: id(14),
            accepted_at: new Date("2026-09-13T10:00:00.000Z"),
          },
        ],
        calls,
      ),
    );
    const service = createConfiguredTenantAdministrationService({
      environment,
      runtimeTransaction,
    });

    await expect(service.provisionTenant(command())).resolves.toMatchObject({
      outcome: "accepted",
      tenantId: id(10),
      accessVersion: 3,
    });
    expect(runtimeTransaction).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_identity.provision_tenant");
    expect(calls[0]?.values[0]).toBe(environment.VORTEX_CLUSTER_ID);
    expect(calls[0]?.values[1]).toBe(environment.VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID);
    expect(calls[0]?.values[2]).toBe(command().duplicateKey);
    expect(calls[0]?.values[3]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses missing configuration and malformed commands without a transaction", async () => {
    const runtimeTransaction = vi.fn();
    const unconfigured = createConfiguredTenantAdministrationService({
      environment: {},
      runtimeTransaction,
    });
    await expect(unconfigured.provisionTenant(command())).resolves.toEqual({
      outcome: "refused",
      operation: "provision_tenant",
      code: "operator_not_configured",
    });
    const configured = createConfiguredTenantAdministrationService({
      environment,
      runtimeTransaction,
    });
    await expect(
      configured.provisionTenant({ ...command(), systemActorId: id(99) } as never),
    ).resolves.toMatchObject({ outcome: "refused", code: "invalid_command" });
    expect(runtimeTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["V3001", "duplicate_conflict"],
    ["V3002", "steward_unavailable"],
    ["V3003", "scope_unavailable"],
    ["42501", "scope_unavailable"],
    ["XX000", "operation_unavailable"],
  ])("maps SQLSTATE %s to the safe refusal %s", async (databaseCode, expected) => {
    const service = createConfiguredTenantAdministrationService({
      environment,
      runtimeTransaction: async () => {
        throw { code: databaseCode, message: "sensitive storage detail" };
      },
    });
    await expect(service.provisionTenant(command())).resolves.toEqual({
      outcome: "refused",
      operation: "provision_tenant",
      code: expected,
    });
  });

  it("rejects a malformed storage result inside the outer transaction", async () => {
    let committed = false;
    let rolledBack = false;
    const service = createConfiguredTenantAdministrationService({
      environment,
      runtimeTransaction: async (operation) => {
        try {
          const result = await operation({
            query: async () => [{ outcome: "accepted" }],
          });
          committed = true;
          return result;
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
    });

    await expect(service.provisionTenant(command())).resolves.toEqual({
      outcome: "refused",
      operation: "provision_tenant",
      code: "operation_unavailable",
    });
    expect(committed).toBe(false);
    expect(rolledBack).toBe(true);
  });

  it("binds adoption results to their fixed operation-specific SQL surfaces", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const service = createConfiguredTenantAdministrationService({
      environment,
      runtimeTransaction: runner(
        [
          {
            outcome: "replayed",
            operation: "adopt_organization",
            tenant_id: id(20),
            organization_id: id(21),
            organization_account_id: id(22),
            access_version: 9n,
            correlation_id: id(23),
            accepted_at: "2026-09-13T10:01:00.000Z",
          },
        ],
        calls,
      ),
    });
    await expect(
      service.adoptOrganization({
        operation: "adopt_organization",
        duplicateKey: id(24),
        tenantId: id(20),
        organizationId: id(21),
        organizationSteward: { identityId: id(25), organizationAccountId: id(22) },
      }),
    ).resolves.toMatchObject({ outcome: "replayed", accessVersion: 9 });
    expect(calls[0]?.text).toContain("vortex_identity.adopt_organization");
    expect(calls[0]?.values[0]).toBe(environment.VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID);
    expect(calls[0]?.values).not.toContain(environment.VORTEX_CLUSTER_ID);
  });

  it("uses the configured cluster and actor for projection lifecycle commands", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const service = createConfiguredTenantAdministrationService({
      environment,
      runtimeTransaction: runner(
        [
          {
            outcome: "accepted",
            operation: "suspend_cluster_identity",
            identity_id: id(40),
            revision: 2n,
            correlation_id: id(41),
            accepted_at: new Date("2026-09-14T10:00:00.000Z"),
          },
        ],
        calls,
      ),
    });

    await expect(
      service.suspendClusterIdentity({
        operation: "suspend_cluster_identity",
        duplicateKey: id(42),
        identityId: id(40),
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({
      outcome: "accepted",
      operation: "suspend_cluster_identity",
      identityId: id(40),
      revision: 2,
    });
    expect(calls[0]?.text).toContain("vortex_identity.suspend_cluster_identity");
    expect(calls[0]?.values.slice(0, 3)).toEqual([
      environment.VORTEX_CLUSTER_ID,
      environment.VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID,
      id(42),
    ]);
  });

  it("refuses injected authority and maps stale lifecycle revisions", async () => {
    const runtimeTransaction = vi.fn();
    const service = createConfiguredTenantAdministrationService({
      environment,
      runtimeTransaction,
    });
    await expect(
      service.closeClusterIdentity({
        operation: "close_cluster_identity",
        duplicateKey: id(50),
        identityId: id(51),
        expectedRevision: 1,
        systemActorId: id(52),
      } as never),
    ).resolves.toEqual({
      outcome: "refused",
      operation: "close_cluster_identity",
      code: "invalid_command",
    });
    expect(runtimeTransaction).not.toHaveBeenCalled();

    const stale = createConfiguredTenantAdministrationService({
      environment,
      runtimeTransaction: async () => {
        throw { code: "V3102" };
      },
    });
    await expect(
      stale.reactivateClusterIdentity({
        operation: "reactivate_cluster_identity",
        duplicateKey: id(53),
        identityId: id(51),
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ outcome: "refused", code: "stale_revision" });
  });
});
