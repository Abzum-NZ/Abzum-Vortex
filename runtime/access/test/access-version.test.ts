import { verifiedIdentitySchema, type VerifiedIdentity } from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RuntimeDatabaseTransaction } from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import { createAccessVersionStore, type AccessVersionError } from "../src/access-version";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const verifiedIdentity = (): VerifiedIdentity =>
  verifiedIdentitySchema.parse({
    identityId: id(1),
    verifiedPrimaryEmail: "Person@Example.Test",
    issuer: "https://identity.example.test/auth/v1",
    audience: "authenticated",
    sessionId: id(2),
    issuedAt: "2026-09-04T00:00:00.000Z",
    expiresAt: "2026-09-04T01:00:00.000Z",
    authenticationStrength: "single_factor",
    keyId: "test-key",
  });

const accountRow = {
  organization_account_id: id(10),
  organization_id: id(4),
  identity_id: id(1),
  display_name: "Person",
  state: "active",
  language: null,
  time_zone: null,
  invitation_id: id(11),
  activated_at: "2026-09-04T00:02:00.000Z",
  suspended_at: null,
  closed_at: null,
  changed_at: "2026-09-04T00:02:00.000Z",
  state_changed_at: "2026-09-04T00:02:00.000Z",
  state_changed_by: id(1),
  state_change_correlation_id: id(12),
  revision: "1",
};

const statement = (strings: TemplateStringsArray): string => strings.join("$value");

const runtimeRunner =
  (
    rows: readonly DatabaseRow[],
    calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [],
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
        return rows as readonly Row[];
      },
    });

describe("Access-version service", () => {
  it("reads only the current version for one validated tenant and organisation", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const store = createAccessVersionStore({
      runtimeTransaction: runtimeRunner([{ organization_id: id(4), current_version: "7" }], calls),
    });

    await expect(
      store.readCurrentOrganizationAccessVersion({ tenantId: id(3), organizationId: id(4) }),
    ).resolves.toEqual({ organizationId: id(4), currentVersion: 7 });
    expect(calls[0]?.text).toContain("vortex_access.current_organization_access_version");
    expect(calls[0]?.values).toEqual([id(3), id(4)]);
  });

  it("refuses malformed scope before opening a transaction", async () => {
    const runtimeTransaction = vi.fn();
    const store = createAccessVersionStore({ runtimeTransaction });

    await expect(
      store.readCurrentOrganizationAccessVersion({
        tenantId: "browser-value",
        organizationId: id(4),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ACCESS_VERSION_COMMAND",
    } satisfies Partial<AccessVersionError>);
    expect(runtimeTransaction).not.toHaveBeenCalled();
  });

  it("hashes an invitation secret before the atomic Access database call", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const secret = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    const store = createAccessVersionStore({
      runtimeTransaction: runtimeRunner(
        [{ outcome: "accepted", ...accountRow, access_version: "2" }],
        calls,
      ),
    });

    await expect(
      store.acceptOrganizationInvitation(verifiedIdentity(), {
        invitationSecret: secret,
        displayName: "Person",
        correlationId: id(12),
      }),
    ).resolves.toEqual({
      outcome: "accepted",
      account: expect.objectContaining({ organizationAccountId: id(10) }),
      accessVersion: 2,
    });
    expect(calls[0]?.text).toContain("vortex_access.accept_organization_invitation");
    expect(calls[0]?.values[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(calls[0]?.values[1]).toBe(id(1));
    expect(calls[0]?.values[2]).toBe("person@example.test");
    expect(calls[0]?.values).not.toContain(secret);
  });

  it("returns closed refusal and replay results", async () => {
    const refusal = createAccessVersionStore({
      runtimeTransaction: runtimeRunner([{ outcome: "unavailable" }]),
    });
    await expect(
      refusal.acceptOrganizationInvitation(verifiedIdentity(), {
        invitationSecret: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
        correlationId: id(12),
      }),
    ).resolves.toEqual({ outcome: "unavailable" });

    const replay = createAccessVersionStore({
      runtimeTransaction: runtimeRunner([
        { outcome: "already_accepted", ...accountRow, access_version: 4 },
      ]),
    });
    await expect(
      replay.acceptOrganizationInvitation(verifiedIdentity(), {
        invitationSecret: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
        correlationId: id(12),
      }),
    ).resolves.toMatchObject({ outcome: "already_accepted", accessVersion: 4 });
  });

  it("refuses malformed storage and maps database details to closed errors", async () => {
    const malformed = createAccessVersionStore({
      runtimeTransaction: runtimeRunner([{ organization_id: id(4), current_version: "0" }]),
    });
    await expect(
      malformed.readCurrentOrganizationAccessVersion({ tenantId: id(3), organizationId: id(4) }),
    ).rejects.toMatchObject({ code: "INVALID_ACCESS_VERSION_STORAGE_RESULT" });

    const failed = createAccessVersionStore({
      runtimeTransaction: async () => {
        throw { code: "XX000", message: "sensitive database detail" };
      },
    });
    await expect(
      failed.readCurrentOrganizationAccessVersion({ tenantId: id(3), organizationId: id(4) }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "AccessVersionError",
        code: "ACCESS_VERSION_OPERATION_FAILED",
        message: "ACCESS_VERSION_OPERATION_FAILED",
      }),
    );
  });
});
