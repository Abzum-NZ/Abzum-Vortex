import {
  sessionContextSchema,
  verifiedIdentitySchema,
  type SessionContext,
  type VerifiedIdentity,
} from "@vortex/contracts";
import type {
  DatabaseRow,
  DatabaseValue,
  RequestDatabaseTransaction,
  RuntimeDatabaseTransaction,
} from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationAccountStore } from "../src/organization-accounts";
import type { OrganizationAccountError } from "../src/organization-accounts";

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

const context = (): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "human",
    identityAuthorityId: id(13),
    tenantId: id(3),
    organizationId: id(4),
    identityId: id(5),
    organizationAccountId: id(6),
    sessionId: id(7),
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    accessVersion: 1,
    correlationId: id(8),
    authenticationStrength: "single_factor",
  });

const projectionRow = {
  identity_id: id(1),
  state: "active",
  created_at: "2026-09-04T00:00:00.000Z",
  state_changed_at: "2026-09-04T00:00:00.000Z",
  state_changed_by: id(1),
  state_change_correlation_id: id(9),
  revision: "1",
};

const invitationRow = {
  invitation_id: id(11),
  organization_id: id(4),
  invited_email: "person@example.test",
  invited_by: id(6),
  created_at: "2026-09-04T00:01:00.000Z",
  invited_at: "2026-09-04T00:01:00.000Z",
  expires_at: "2026-09-05T00:01:00.000Z",
  revoked_at: null,
  revoked_by: null,
  accepted_at: null,
  accepted_organization_account_id: null,
  changed_at: "2026-09-04T00:01:00.000Z",
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

const requestRunner =
  (
    rows: readonly DatabaseRow[],
    calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [],
  ) =>
  async <Result>(
    _context: SessionContext,
    operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
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

describe("organisation-account service", () => {
  it("ensures a minimal projection from a closed verified identity", async () => {
    const store = createOrganizationAccountStore({
      runtimeTransaction: runtimeRunner([projectionRow]),
    });

    await expect(
      store.ensureIdentityProjection(verifiedIdentity(), { correlationId: id(9) }),
    ).resolves.toEqual({
      identityId: id(1),
      state: "active",
      createdAt: "2026-09-04T00:00:00.000Z",
      stateChangedAt: "2026-09-04T00:00:00.000Z",
      stateChangedBy: id(1),
      stateChangeCorrelationId: id(9),
      revision: 1,
    });
  });

  it("refuses malformed verified identity before opening a transaction", async () => {
    const runtimeTransaction = vi.fn();
    const store = createOrganizationAccountStore({ runtimeTransaction });

    await expect(
      store.ensureIdentityProjection(
        { ...verifiedIdentity(), identityId: "browser-value" } as VerifiedIdentity,
        { correlationId: id(9) },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ACCOUNT_COMMAND",
    } satisfies Partial<OrganizationAccountError>);
    expect(runtimeTransaction).not.toHaveBeenCalled();
  });

  it("reads an existing projection without using the ensuring operation", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const store = createOrganizationAccountStore({
      runtimeTransaction: runtimeRunner([projectionRow], calls),
    });

    await expect(store.readIdentityProjection(verifiedIdentity())).resolves.toEqual({
      identityId: id(1),
      state: "active",
      createdAt: "2026-09-04T00:00:00.000Z",
      stateChangedAt: "2026-09-04T00:00:00.000Z",
      stateChangedBy: id(1),
      stateChangeCorrelationId: id(9),
      revision: 1,
    });
    expect(calls[0]?.text).toContain("read_identity_projection");
    expect(calls[0]?.text).not.toContain("ensure_identity_projection");
    expect(calls[0]?.values).toEqual([id(1)]);
  });

  it("returns no projection when the runtime read has no row", async () => {
    const store = createOrganizationAccountStore({ runtimeTransaction: runtimeRunner([]) });

    await expect(store.readIdentityProjection(verifiedIdentity())).resolves.toBeUndefined();
  });

  it("refuses duplicate projection rows from storage", async () => {
    const store = createOrganizationAccountStore({
      runtimeTransaction: runtimeRunner([projectionRow, projectionRow]),
    });

    await expect(store.readIdentityProjection(verifiedIdentity())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ACCOUNT_STORAGE_RESULT",
    });
  });

  it("returns one secure invitation secret and sends only its fingerprint to storage", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const secret = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    const store = createOrganizationAccountStore({
      requestTransaction: requestRunner([invitationRow], calls),
      generateInvitationSecret: () => secret,
    });

    const result = await store.createInvitationAfterAuthorization(context(), {
      invitedEmail: "Person@Example.Test",
      expiresAt: "2026-09-05T00:01:00.000Z",
    });

    expect(result.invitationSecret).toBe(secret);
    expect(result.invitation.invitedEmail).toBe("person@example.test");
    expect(calls[0]?.text).toContain("create_organization_invitation");
    expect(calls[0]?.values[0]).toBe("person@example.test");
    expect(calls[0]?.values[1]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(calls[0]?.values).not.toContain(secret);
  });

  it("maps database details to a closed safe error", async () => {
    const store = createOrganizationAccountStore({
      runtimeTransaction: async () => {
        throw { code: "XX000", message: "sensitive database detail" };
      },
    });

    await expect(store.readIdentityProjection(verifiedIdentity())).rejects.toEqual(
      expect.objectContaining({
        name: "OrganizationAccountError",
        code: "ORGANIZATION_ACCOUNT_OPERATION_FAILED",
        message: "ORGANIZATION_ACCOUNT_OPERATION_FAILED",
      }),
    );
  });

  it("refuses invalid storage shapes", async () => {
    const store = createOrganizationAccountStore({
      runtimeTransaction: runtimeRunner([{ ...projectionRow, state: "invited" }]),
    });

    await expect(store.readIdentityProjection(verifiedIdentity())).rejects.toMatchObject({
      code: "ORGANIZATION_ACCOUNT_OPERATION_FAILED",
    });
  });
});
