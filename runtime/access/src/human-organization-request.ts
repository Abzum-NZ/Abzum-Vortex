import "server-only";

import { randomUUID } from "node:crypto";
import {
  correlationIdSchema,
  identityAuthorityIdSchema,
  identitySessionSchema,
  organizationSelectionCandidateSchema,
  selectedOrganizationScopeSchema,
  sessionContextSchema,
  type IdentityAuthorityId,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
  type SessionContext,
} from "@vortex/contracts";
import {
  withResolvedRequestTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
  type ResolvedRequestContext,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";

type ResolvedRequestTransactionRunner = <Scope, Result>(
  resolve: (transaction: RuntimeDatabaseTransaction) => Promise<ResolvedRequestContext<Scope>>,
  operation: (transaction: RequestDatabaseTransaction, scope: Scope) => Promise<Result>,
) => Promise<Result>;

export type HumanOrganizationRequestResult<Result> =
  | Readonly<{ kind: "available"; value: Result }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type HumanOrganizationRequestDependencies = Readonly<{
  identityAuthorityId: IdentityAuthorityId;
  resolvedRequestTransaction?: ResolvedRequestTransactionRunner;
  clock?: () => Date;
  correlationId?: () => string;
}>;

type ScopeRow = DatabaseRow & {
  tenant_id: unknown;
  organization_id: unknown;
  organization_account_id: unknown;
  access_version: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const parseScope = (rows: readonly ScopeRow[]): SelectedOrganizationScope => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("INVALID_SCOPE_RESULT");
  const row = rows[0];
  return selectedOrganizationScopeSchema.parse({
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    organizationAccountId: row.organization_account_id,
    accessVersion: revision(row.access_version),
  });
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

export const createHumanOrganizationRequestService = (
  dependencies: HumanOrganizationRequestDependencies,
) => {
  const configuredAuthority = identityAuthorityIdSchema.parse(dependencies.identityAuthorityId);
  const runTransaction = dependencies.resolvedRequestTransaction ?? withResolvedRequestTransaction;
  const clock = dependencies.clock ?? (() => new Date());
  const newCorrelationId = dependencies.correlationId ?? randomUUID;

  const run = async <Result>(
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate,
    operation: (
      transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope,
    ) => Promise<Result>,
  ): Promise<HumanOrganizationRequestResult<Result>> => {
    const verifiedSession = identitySessionSchema.safeParse(session);
    const verifiedCandidate = organizationSelectionCandidateSchema.safeParse(candidate);
    if (!verifiedSession.success || !verifiedCandidate.success) return { kind: "unavailable" };

    let issuedAt: string;
    let correlationId: string;
    try {
      const now = clock();
      if (!Number.isFinite(now.valueOf())) throw new Error("INVALID_CLOCK");
      issuedAt = now.toISOString();
      correlationId = correlationIdSchema.parse(newCorrelationId());
    } catch {
      return { kind: "temporarily_unavailable" };
    }
    if (Date.parse(verifiedSession.data.accessTokenExpiresAt) <= Date.parse(issuedAt))
      return { kind: "unavailable" };

    try {
      const value = await runTransaction(async (transaction) => {
        const rows = await transaction.query<ScopeRow>`
              select *
              from vortex_access.resolve_human_organization_scope(
                ${verifiedSession.data.identityId}::uuid,
                ${verifiedCandidate.data.organizationId}::uuid
              )
            `;
        const scope = parseScope(rows);
        const context: SessionContext = sessionContextSchema.parse({
          callerKind: "human",
          identityAuthorityId: configuredAuthority,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          organizationAccountId: scope.organizationAccountId,
          identityId: verifiedSession.data.identityId,
          sessionId: verifiedSession.data.sessionId,
          authenticationStrength: verifiedSession.data.authenticationStrength,
          issuedAt,
          expiresAt: verifiedSession.data.accessTokenExpiresAt,
          accessVersion: scope.accessVersion,
          correlationId,
        });
        return { context, scope };
      }, operation);
      return { kind: "available", value };
    } catch (error) {
      return databaseCode(error) === "42501"
        ? { kind: "unavailable" }
        : { kind: "temporarily_unavailable" };
    }
  };

  return Object.freeze({
    run,
    resolve: (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
    ): Promise<HumanOrganizationRequestResult<SelectedOrganizationScope>> =>
      run(session, candidate, async (transaction, scope) => {
        const rows = await transaction.query<ScopeRow>`
          select
            checked ->> 'tenantId' as tenant_id,
            checked ->> 'organizationId' as organization_id,
            checked ->> 'organizationAccountId' as organization_account_id,
            checked ->> 'accessVersion' as access_version
          from vortex_access.validated_human_request_context() as checked
        `;
        const checked = parseScope(rows);
        if (
          checked.tenantId !== scope.tenantId ||
          checked.organizationId !== scope.organizationId ||
          checked.organizationAccountId !== scope.organizationAccountId ||
          checked.accessVersion !== scope.accessVersion
        )
          throw new Error("INVALID_PROTECTED_CONTEXT_RESULT");
        return checked;
      }),
  });
};
