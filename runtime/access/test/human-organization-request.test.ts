import {
  identitySessionSchema,
  sessionContextSchema,
  type IdentityAuthorityId,
  type IdentitySession,
  type SessionContext,
} from "@vortex/contracts";
import type {
  DatabaseRow,
  DatabaseValue,
  RequestDatabaseTransaction,
  ResolvedRequestContext,
  RuntimeDatabaseTransaction,
} from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import { createHumanOrganizationRequestService } from "../src/human-organization-request";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const session = (overrides: Partial<IdentitySession> = {}): IdentitySession =>
  identitySessionSchema.parse({
    identityId: id(1),
    sessionId: id(2),
    authenticationStrength: "multi_factor",
    accessTokenIssuedAt: "2026-09-05T00:00:00.000Z",
    accessTokenExpiresAt: "2026-09-05T02:00:00.000Z",
    ...overrides,
  });

const authorityId = id(3) as IdentityAuthorityId;

describe("human organisation request", () => {
  it("derives the closed context inside the protected transaction", async () => {
    let captured: SessionContext | undefined;
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const service = createHumanOrganizationRequestService({
      identityAuthorityId: authorityId,
      clock: () => new Date("2026-09-05T01:00:00.000Z"),
      correlationId: () => id(9),
      resolvedRequestTransaction: async <Scope, Result>(
        resolve: (
          transaction: RuntimeDatabaseTransaction,
        ) => Promise<ResolvedRequestContext<Scope>>,
        operation: (transaction: RequestDatabaseTransaction, scope: Scope) => Promise<Result>,
      ): Promise<Result> => {
        const resolved = await resolve({
          query: async <Row extends DatabaseRow>(
            strings: TemplateStringsArray,
            ...values: readonly DatabaseValue[]
          ) => {
            calls.push({ text: strings.join("$value"), values });
            return [
              {
                tenant_id: id(4),
                organization_id: id(5),
                organization_account_id: id(6),
                access_version: "7",
              },
            ] as readonly Row[];
          },
        });
        captured = sessionContextSchema.parse(resolved.context);
        return operation({ query: async () => [] }, resolved.scope);
      },
    });

    await expect(
      service.run(session(), { organizationId: id(5) }, async (_transaction, scope) => scope),
    ).resolves.toEqual({
      kind: "available",
      value: {
        tenantId: id(4),
        organizationId: id(5),
        organizationAccountId: id(6),
        accessVersion: 7,
      },
    });
    expect(calls[0]?.text).toContain("vortex_access.resolve_human_organization_scope");
    expect(calls[0]?.values).toEqual([id(1), id(5)]);
    expect(captured).toEqual({
      callerKind: "human",
      identityAuthorityId: authorityId,
      tenantId: id(4),
      organizationId: id(5),
      organizationAccountId: id(6),
      identityId: id(1),
      sessionId: id(2),
      authenticationStrength: "multi_factor",
      issuedAt: "2026-09-05T01:00:00.000Z",
      expiresAt: "2026-09-05T02:00:00.000Z",
      accessVersion: 7,
      correlationId: id(9),
    });
    expect(captured).not.toHaveProperty("applicationRootId");
    expect(captured).not.toHaveProperty("delegatedContext");
    expect(captured).not.toHaveProperty("supportContext");
  });

  it("copies exact evidence with its token upper bound and preserves the +60-second token boundary", async () => {
    let captured: SessionContext | undefined;
    const service = createHumanOrganizationRequestService({
      identityAuthorityId: authorityId,
      clock: () => new Date("2026-09-05T01:00:00.000Z"),
      correlationId: () => id(9),
      resolvedRequestTransaction: async <Scope, Result>(
        resolve: (
          transaction: RuntimeDatabaseTransaction,
        ) => Promise<ResolvedRequestContext<Scope>>,
        operation: (transaction: RequestDatabaseTransaction, scope: Scope) => Promise<Result>,
      ): Promise<Result> => {
        const resolved = await resolve({
          query: async () =>
            [
              {
                tenant_id: id(4),
                organization_id: id(5),
                organization_account_id: id(6),
                access_version: "7",
              },
            ] as never,
        });
        captured = sessionContextSchema.parse(resolved.context);
        return operation({ query: async () => [] }, resolved.scope);
      },
    });
    const verifiedSession = session({
      accessTokenIssuedAt: "2026-09-05T01:01:00.000Z",
      primaryAuthenticatedAt: "2026-09-05T01:00:00.000Z",
      multiFactorAuthenticatedAt: "2026-09-05T00:59:00.000Z",
    });

    await expect(
      service.run(verifiedSession, { organizationId: id(5) }, async () => undefined),
    ).resolves.toEqual({ kind: "available", value: undefined });
    expect(captured).toMatchObject({
      accessTokenIssuedAt: verifiedSession.accessTokenIssuedAt,
      primaryAuthenticatedAt: verifiedSession.primaryAuthenticatedAt,
      multiFactorAuthenticatedAt: verifiedSession.multiFactorAuthenticatedAt,
    });
  });

  it("rejects future evidence with zero skew while leaving evidence-free sessions ordinary", async () => {
    let captured: SessionContext | undefined;
    const run = vi.fn(
      async <Scope, Result>(
        resolve: (
          transaction: RuntimeDatabaseTransaction,
        ) => Promise<ResolvedRequestContext<Scope>>,
        operation: (transaction: RequestDatabaseTransaction, scope: Scope) => Promise<Result>,
      ): Promise<Result> => {
        const resolved = await resolve({
          query: async () =>
            [
              {
                tenant_id: id(4),
                organization_id: id(5),
                organization_account_id: id(6),
                access_version: "7",
              },
            ] as never,
        });
        captured = sessionContextSchema.parse(resolved.context);
        return operation({ query: async () => [] }, resolved.scope);
      },
    );
    const service = createHumanOrganizationRequestService({
      identityAuthorityId: authorityId,
      clock: () => new Date("2026-09-05T01:00:00.000Z"),
      correlationId: () => id(9),
      resolvedRequestTransaction: run,
    });

    await expect(
      service.run(
        session({
          accessTokenIssuedAt: "2026-09-05T01:01:00.000Z",
          primaryAuthenticatedAt: "2026-09-05T01:00:00.001Z",
        }),
        { organizationId: id(5) },
        async () => undefined,
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(run).not.toHaveBeenCalled();

    await expect(
      service.run(
        session({ accessTokenIssuedAt: "2026-09-05T01:01:00.000Z" }),
        { organizationId: id(5) },
        async () => undefined,
      ),
    ).resolves.toEqual({ kind: "available", value: undefined });
    expect(captured).not.toHaveProperty("accessTokenIssuedAt");
    expect(captured).not.toHaveProperty("primaryAuthenticatedAt");
    expect(captured).not.toHaveProperty("multiFactorAuthenticatedAt");
  });

  it("does not accept authentication evidence through the organization candidate", async () => {
    const run = vi.fn();
    const service = createHumanOrganizationRequestService({
      identityAuthorityId: authorityId,
      resolvedRequestTransaction: run,
    });
    await expect(
      service.run(
        session(),
        {
          organizationId: id(5),
          primaryAuthenticatedAt: "2026-09-05T01:00:00.000Z",
        } as never,
        async () => undefined,
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(run).not.toHaveBeenCalled();
  });

  it("makes malformed and unavailable selections indistinguishable", async () => {
    const run = vi.fn(async () => {
      const error = Object.assign(new Error("private detail"), { code: "42501" });
      throw error;
    });
    const service = createHumanOrganizationRequestService({
      identityAuthorityId: authorityId,
      clock: () => new Date("2026-09-05T01:00:00.000Z"),
      correlationId: () => id(9),
      resolvedRequestTransaction: run,
    });

    await expect(
      service.run(session(), { organizationId: "bad" }, async () => undefined),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(run).not.toHaveBeenCalled();

    await expect(
      service.run(session(), { organizationId: id(99) }, async () => undefined),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("keeps unexpected storage failure retryable and rejects expired sessions", async () => {
    const failed = createHumanOrganizationRequestService({
      identityAuthorityId: authorityId,
      clock: () => new Date("2026-09-05T01:00:00.000Z"),
      correlationId: () => id(9),
      resolvedRequestTransaction: async () => {
        throw new Error("private detail");
      },
    });
    await expect(
      failed.run(session(), { organizationId: id(5) }, async () => undefined),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });

    const expired = {
      ...session(),
      accessTokenExpiresAt: "2026-09-05T01:00:00.000Z",
    };
    await expect(
      failed.run(expired, { organizationId: id(5) }, async () => undefined),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("owns the protected live-context validation used by web composition", async () => {
    let operationSql = "";
    const service = createHumanOrganizationRequestService({
      identityAuthorityId: authorityId,
      clock: () => new Date("2026-09-05T01:00:00.000Z"),
      correlationId: () => id(9),
      resolvedRequestTransaction: async (resolve, operation) => {
        const resolved = await resolve({
          query: async () =>
            [
              {
                tenant_id: id(4),
                organization_id: id(5),
                organization_account_id: id(6),
                access_version: "7",
              },
            ] as never,
        });
        return operation(
          {
            query: async (strings) => {
              operationSql = strings.join("$value");
              return [
                {
                  tenant_id: id(4),
                  organization_id: id(5),
                  organization_account_id: id(6),
                  access_version: "7",
                },
              ] as never;
            },
          },
          resolved.scope,
        );
      },
    });

    await expect(service.resolve(session(), { organizationId: id(5) })).resolves.toEqual({
      kind: "available",
      value: {
        tenantId: id(4),
        organizationId: id(5),
        organizationAccountId: id(6),
        accessVersion: 7,
      },
    });
    expect(operationSql).toContain("vortex_access.validated_human_request_context");
  });
});
