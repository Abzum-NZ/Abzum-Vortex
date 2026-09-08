import type {
  DatabaseRow,
  RequestDatabaseTransaction,
  RuntimeDatabaseTransaction,
} from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationDirectRecordShareService } from "../src/organization-direct-record-share";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const session = {
  identityId: id(1),
  sessionId: id(2),
  authenticationStrength: "multi_factor" as const,
  accessTokenIssuedAt: "2026-09-08T00:00:00.000Z",
  accessTokenExpiresAt: "2026-09-08T02:00:00.000Z",
};
const candidate = { organizationId: id(3), applicationRootId: id(4) };
const result = {
  directShareId: id(8),
  revision: 1,
  state: "active",
  changedAt: "2026-09-08T01:00:00.000Z",
  accessVersion: 8,
};

const serviceFor = () => {
  const calls: string[] = [];
  const adapter = {
    grant: vi.fn(async () => result),
    revoke: vi.fn(async () => ({ ...result, revision: 2, state: "revoked" })),
  };
  const service = createOrganizationDirectRecordShareService({
    identityAuthorityId: id(5),
    clock: () => new Date("2026-09-08T01:00:00.000Z"),
    correlationId: () => id(6),
    directShareId: () => id(8),
    activityId: () => id(9),
    adapter,
    resolvedRequestTransaction: async (resolve, operation) => {
      const resolved = await resolve({
        query: async () => {
          calls.push("governance_lock");
          return [
            {
              tenant_id: id(10),
              organization_id: id(3),
              organization_account_id: id(11),
              application_root_id: id(4),
              access_version: "7",
            },
          ] as readonly DatabaseRow[];
        },
      } satisfies RuntimeDatabaseTransaction);
      calls.push("adapter");
      return operation(
        { query: async () => [] } satisfies RequestDatabaseTransaction,
        resolved.scope,
      );
    },
  });
  return { adapter, calls, service };
};

describe("organization direct-record-share service", () => {
  it("takes the governance change scope before invoking the fixed grant adapter", async () => {
    const { adapter, calls, service } = serviceFor();
    await expect(
      service.grant(session, candidate, {
        recordId: id(12),
        recipient: { kind: "organization_account", organizationAccountId: id(13) },
        readableFieldIds: [id(14)],
        changeableFieldIds: [],
        startsAt: "2026-09-08T01:00:00.000Z",
        reason: "Temporary access",
      }),
    ).resolves.toEqual({ kind: "available", value: result });
    expect(calls).toEqual(["governance_lock", "adapter"]);
    expect(adapter.grant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ applicationRootId: id(4), accessVersion: 7 }),
      expect.objectContaining({ recordId: id(12) }),
      { directShareId: id(8), activityId: id(9) },
    );
  });

  it("rejects malformed input before the transaction or adapter", async () => {
    const { adapter, calls, service } = serviceFor();
    await expect(service.grant(session, candidate, {})).resolves.toEqual({ kind: "unavailable" });
    expect(calls).toEqual([]);
    expect(adapter.grant).not.toHaveBeenCalled();
  });

  it("binds revoke to the supplied record and expected revision", async () => {
    const { adapter, service } = serviceFor();
    await expect(
      service.revoke(session, candidate, {
        directShareId: id(8),
        recordId: id(12),
        expectedRevision: 1,
        reason: "No longer required",
      }),
    ).resolves.toEqual({ kind: "available", value: { ...result, revision: 2, state: "revoked" } });
    expect(adapter.revoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ directShareId: id(8), recordId: id(12), expectedRevision: 1 }),
      { activityId: id(9) },
    );
  });
});
