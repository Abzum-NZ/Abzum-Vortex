import { identitySessionSchema, type IdentitySession } from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RuntimeDatabaseTransaction } from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import { createTenantGovernanceService } from "../src/tenant-governance";

vi.mock("server-only", () => ({}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session = (): IdentitySession =>
  identitySessionSchema.parse({
    identityId: id(1),
    sessionId: id(2),
    authenticationStrength: "single_factor",
    accessTokenIssuedAt: "2026-09-13T00:00:00.000Z",
    accessTokenExpiresAt: "2026-09-13T01:00:00.000Z",
  });
const runner =
  (
    response: readonly DatabaseRow[],
    calls: Array<{ text: string; values: readonly DatabaseValue[] }>,
  ) =>
  async <Result>(operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>) =>
    operation({
      query: async <Row extends DatabaseRow>(
        strings: TemplateStringsArray,
        ...values: readonly DatabaseValue[]
      ) => {
        calls.push({ text: strings.join("$value"), values });
        return response as readonly Row[];
      },
    });

describe("tenant governance service", () => {
  it("returns only bounded safe hierarchy fields through one operation", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const runtimeTransaction = vi.fn(
      runner(
        [
          {
            organization_id: id(11),
            parent_organization_id: null,
            short_name: "north",
            display_name: "North",
            state: "active",
            revision: "2",
            secret: "hidden",
          },
          {
            organization_id: id(12),
            parent_organization_id: id(11),
            short_name: "south",
            display_name: "South",
            state: "active",
            revision: 1,
          },
        ],
        calls,
      ),
    );
    const service = createTenantGovernanceService({ runtimeTransaction });
    await expect(
      service.listHierarchy(session(), { tenantId: id(9), page: { limit: 1 } }),
    ).resolves.toEqual({
      outcome: "available",
      page: {
        entries: [
          {
            organizationId: id(11),
            shortName: "north",
            displayName: "North",
            state: "active",
            revision: 2,
          },
        ],
        next: id(11),
      },
    });
    expect(runtimeTransaction).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_identity.list_tenant_hierarchy");
    expect(calls[0]?.values).toEqual([id(1), id(9), 2, null]);
  });

  it("passes no caller authority and exposes no Access version on grants", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const service = createTenantGovernanceService({
      runtimeTransaction: runner(
        [
          {
            outcome: "accepted",
            operation: "grant_tenant_administrator",
            assignment_id: id(8),
            revision: 1n,
            correlation_id: id(7),
            accepted_at: new Date("2026-09-13T00:01:00Z"),
            access_version: 99,
          },
        ],
        calls,
      ),
    });
    const result = await service.grant(session(), {
      operation: "grant_tenant_administrator",
      duplicateKey: id(3),
      tenantId: id(4),
      identityId: id(5),
      capabilities: ["platform.tenant.hierarchy.read"],
      startsAt: "2026-09-13T00:00:00.000Z",
    });
    expect(result).toEqual({
      outcome: "accepted",
      operation: "grant_tenant_administrator",
      assignmentId: id(8),
      revision: 1,
      correlationId: id(7),
      acceptedAt: "2026-09-13T00:01:00.000Z",
    });
    expect(calls[0]?.values[0]).toBe(id(1));
    expect(calls[0]?.values).not.toContain(99);
  });

  it("refuses malformed sessions before opening a transaction", async () => {
    const runtimeTransaction = vi.fn();
    const service = createTenantGovernanceService({ runtimeTransaction });
    await expect(
      service.listTenants({ ...session(), identityId: "caller" } as IdentitySession, { limit: 10 }),
    ).resolves.toEqual({ outcome: "refused", code: "invalid_request" });
    expect(runtimeTransaction).not.toHaveBeenCalled();
  });
});
