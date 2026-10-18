import "server-only";

import { randomUUID } from "node:crypto";
import {
  databaseRevision,
  databaseCode,
  describeFailure,
  clampTelemetryDurationMs,
  correlationIdSchema,
  countersForOutcome,
  identityAuthorityIdSchema,
  identitySessionSchema,
  organizationSelectionCandidateSchema,
  protectedOperationChannelSchema,
  selectedOrganizationScopeSchema,
  sessionContextSchema,
  type IdentityAuthorityId,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type ProtectedOperationChannel,
  type SelectedOrganizationScope,
  type ServiceTelemetryPort,
  type SessionContext,
  type TelemetryOutcome,
} from "../schema";
import {
  withResolvedRequestTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
  type ResolvedRequestContext,
} from "../db/index";

type ResolvedRequestTransactionRunner = <Scope, Result>(
  resolve: (transaction: RequestDatabaseTransaction) => Promise<ResolvedRequestContext<Scope>>,
  operation: (transaction: RequestDatabaseTransaction, scope: Scope) => Promise<Result>,
) => Promise<Result>;

type ChangePreparation = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
) => Promise<void>;

export type HumanOrganizationRequestResult<Result> =
  | Readonly<{ kind: "available"; value: Result }>
  | Readonly<{
      kind: "unavailable";
      code?: "recent_authentication_required" | "role_settings_change_required";
      cause?: string;
    }>
  | Readonly<{ kind: "temporarily_unavailable"; cause?: string }>;

type OrganizationScopeResolutionResult =
  | HumanOrganizationRequestResult<SelectedOrganizationScope>
  | Readonly<{ kind: "suspended_super_administrator_account" }>;

export type HumanOrganizationRequestDependencies = Readonly<{
  identityAuthorityId: IdentityAuthorityId;
  /**
   * The channel this trusted entry point reached the protected operation through. It defaults to
   * `web`; a caller of the service never supplies it from request input.
   */
  channel?: ProtectedOperationChannel;
  resolvedRequestTransaction?: ResolvedRequestTransactionRunner;
  clock?: () => Date;
  correlationId?: () => string;
  telemetry?: ServiceTelemetryPort;
}>;

type HumanOrganizationRequestMode = "read" | "change";

type ScopeRow = DatabaseRow & {
  tenant_id: unknown;
  organization_id: unknown;
  organization_account_id: unknown;
  application_root_id?: unknown;
  access_version: unknown;
};

const parseScope = (rows: readonly ScopeRow[]): SelectedOrganizationScope => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("INVALID_SCOPE_RESULT");
  const row = rows[0];
  return selectedOrganizationScopeSchema.parse({
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    organizationAccountId: row.organization_account_id,
    ...(row.application_root_id === undefined || row.application_root_id === null
      ? {}
      : { applicationRootId: row.application_root_id }),
    accessVersion: databaseRevision(row.access_version),
  });
};

const representsSameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

export const createHumanOrganizationRequestService = (
  dependencies: HumanOrganizationRequestDependencies,
) => {
  const configuredAuthority = identityAuthorityIdSchema.parse(dependencies.identityAuthorityId);
  const configuredChannel: ProtectedOperationChannel = protectedOperationChannelSchema.parse(
    dependencies.channel ?? "web",
  );
  const runTransaction = dependencies.resolvedRequestTransaction ?? withResolvedRequestTransaction;
  const clock = dependencies.clock ?? (() => new Date());
  const newCorrelationId = dependencies.correlationId ?? randomUUID;
  const appendTelemetry = (
    correlationId: string,
    outcome: TelemetryOutcome,
    startedAtMs: number,
  ): void => {
    if (dependencies.telemetry === undefined) return;
    try {
      dependencies.telemetry.appendTelemetry({
        correlationId: correlationIdSchema.parse(correlationId),
        service: "access",
        operation: "human_organization_request",
        outcome,
        durationMs: clampTelemetryDurationMs(startedAtMs, clock().valueOf()),
        counters: countersForOutcome(outcome),
      });
    } catch {
      // Telemetry must not change the protected request's safe outcome.
    }
  };

  const runWithMode = async <Result, Special = never>(
    mode: HumanOrganizationRequestMode,
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate,
    operation: (
      transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope,
      issuedAt: string,
    ) => Promise<Result>,
    prepare?: ChangePreparation,
    suspendedAccountResult?: () => Special,
    mapDatabaseRefusal?: (code: string, error: unknown) => Result | undefined,
  ): Promise<HumanOrganizationRequestResult<Result> | Special> => {
    const verifiedSession = identitySessionSchema.safeParse(session);
    const verifiedCandidate = organizationSelectionCandidateSchema.safeParse(candidate);
    if (!verifiedSession.success || !verifiedCandidate.success) return { kind: "unavailable" };

    let issuedAt: string;
    let correlationId: string;
    let startedAtMs: number;
    try {
      const now = clock();
      if (!Number.isFinite(now.valueOf())) throw new Error("INVALID_CLOCK");
      startedAtMs = now.valueOf();
      issuedAt = now.toISOString();
      correlationId = correlationIdSchema.parse(newCorrelationId());
    } catch (error) {
      return { kind: "temporarily_unavailable", cause: describeFailure(error) };
    }
    if (Date.parse(verifiedSession.data.accessTokenExpiresAt) <= Date.parse(issuedAt)) {
      appendTelemetry(correlationId, "refused", startedAtMs);
      return { kind: "unavailable" };
    }
    const hasAuthenticationEvidence =
      verifiedSession.data.primaryAuthenticatedAt !== undefined ||
      verifiedSession.data.multiFactorAuthenticatedAt !== undefined;
    if (
      (verifiedSession.data.primaryAuthenticatedAt !== undefined &&
        Date.parse(verifiedSession.data.primaryAuthenticatedAt) > Date.parse(issuedAt)) ||
      (verifiedSession.data.multiFactorAuthenticatedAt !== undefined &&
        Date.parse(verifiedSession.data.multiFactorAuthenticatedAt) > Date.parse(issuedAt))
    ) {
      appendTelemetry(correlationId, "refused", startedAtMs);
      return { kind: "unavailable" };
    }

    try {
      const value = await runTransaction(
        async (transaction) => {
          // A preview request runs the preview's installation and registration in every read and
          // change of this transaction, the scope check included; the database refuses an address
          // its builder may not run.
          if (verifiedCandidate.data.previewInstallationId !== undefined)
            await transaction.query`
              select pg_catalog.set_config(
                'vortex_record.preview_installation_id',
                ${verifiedCandidate.data.previewInstallationId}, true
              )
            `;
          const rows =
            verifiedCandidate.data.applicationRootId === undefined
              ? mode === "change"
                ? await transaction.query<ScopeRow>`
                  select *
                  from vortex_access.resolve_human_organization_change_scope(
                    ${verifiedSession.data.identityId}::uuid,
                    ${verifiedCandidate.data.organizationId}::uuid
                  )
                `
                : await transaction.query<ScopeRow>`
                  select *
                  from vortex_access.resolve_human_organization_scope(
                    ${verifiedSession.data.identityId}::uuid,
                    ${verifiedCandidate.data.organizationId}::uuid
                  )
                `
              : mode === "change"
                ? await transaction.query<ScopeRow>`
                  select *
                  from vortex_access.resolve_human_application_change_scope(
                    ${verifiedSession.data.identityId}::uuid,
                    ${verifiedCandidate.data.organizationId}::uuid,
                    ${verifiedCandidate.data.applicationRootId}::uuid
                  )
                `
                : await transaction.query<ScopeRow>`
                  select *
                  from vortex_access.resolve_human_application_scope(
                    ${verifiedSession.data.identityId}::uuid,
                    ${verifiedCandidate.data.organizationId}::uuid,
                    ${verifiedCandidate.data.applicationRootId}::uuid
                  )
                `;
          const parsedScope = parseScope(rows);
          const scope: SelectedOrganizationScope =
            verifiedCandidate.data.previewInstallationId === undefined
              ? parsedScope
              : {
                  ...parsedScope,
                  previewInstallationId: verifiedCandidate.data.previewInstallationId,
                };
          if (
            (verifiedCandidate.data.applicationRootId === undefined) !==
              (scope.applicationRootId === undefined) ||
            (verifiedCandidate.data.applicationRootId !== undefined &&
              scope.applicationRootId !== undefined &&
              !representsSameUuid(
                verifiedCandidate.data.applicationRootId,
                scope.applicationRootId,
              ))
          )
            throw new Error("INVALID_SCOPE_RESULT");
          const context: SessionContext = sessionContextSchema.parse({
            callerKind: "human",
            identityAuthorityId: configuredAuthority,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            organizationAccountId: scope.organizationAccountId,
            ...(scope.applicationRootId === undefined
              ? {}
              : { applicationRootId: scope.applicationRootId }),
            identityId: verifiedSession.data.identityId,
            sessionId: verifiedSession.data.sessionId,
            authenticationStrength: verifiedSession.data.authenticationStrength,
            ...(hasAuthenticationEvidence
              ? {
                  accessTokenIssuedAt: verifiedSession.data.accessTokenIssuedAt,
                  ...(verifiedSession.data.primaryAuthenticatedAt === undefined
                    ? {}
                    : { primaryAuthenticatedAt: verifiedSession.data.primaryAuthenticatedAt }),
                  ...(verifiedSession.data.multiFactorAuthenticatedAt === undefined
                    ? {}
                    : {
                        multiFactorAuthenticatedAt: verifiedSession.data.multiFactorAuthenticatedAt,
                      }),
                }
              : {}),
            issuedAt,
            expiresAt: verifiedSession.data.accessTokenExpiresAt,
            accessVersion: scope.accessVersion,
            correlationId,
          });
          if (prepare !== undefined) await prepare(transaction, scope);
          return { context, scope, channel: configuredChannel };
        },
        (transaction, scope) => operation(transaction, scope, issuedAt),
      );
      appendTelemetry(correlationId, "success", startedAtMs);
      return { kind: "available", value };
    } catch (error) {
      const code = databaseCode(error);
      if (code !== undefined && mapDatabaseRefusal !== undefined) {
        const refusal = mapDatabaseRefusal(code, error);
        if (refusal !== undefined) {
          appendTelemetry(correlationId, "refused", startedAtMs);
          return { kind: "available", value: refusal };
        }
      }
      if (code === "V3140" && suspendedAccountResult !== undefined) {
        appendTelemetry(correlationId, "refused", startedAtMs);
        return suspendedAccountResult();
      }
      const recentAuthenticationRequired = code === "V3150";
      const roleSettingsChangeRequired = code === "V3151";
      const refused =
        code === "42501" || recentAuthenticationRequired || roleSettingsChangeRequired;
      const cause = describeFailure(error);
      // A request its caller abandoned (the browser left the page) is stopped on purpose; that is
      // not a failure of the platform. Every other cause is logged in full.
      const abandoned =
        error instanceof Error &&
        error.name === "VortexDatabaseError" &&
        error.message === "DATABASE_REQUEST_STOPPED";
      if (abandoned) console.info(`[access] human organisation request stopped: ${cause}`);
      else if (refused) console.error(`[access] human organisation request refused: ${cause}`);
      else console.error(`[access] human organisation request failed: ${cause}`);
      appendTelemetry(correlationId, refused ? "refused" : "temporarily_unavailable", startedAtMs);
      return recentAuthenticationRequired
        ? { kind: "unavailable", code: "recent_authentication_required", cause }
        : roleSettingsChangeRequired
          ? { kind: "unavailable", code: "role_settings_change_required", cause }
          : refused
            ? { kind: "unavailable" }
            : { kind: "temporarily_unavailable", cause };
    }
  };

  return Object.freeze({
    run: <Result>(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      operation: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        issuedAt: string,
      ) => Promise<Result>,
    ): Promise<HumanOrganizationRequestResult<Result>> =>
      runWithMode("read", session, candidate, operation),
    runChange: <Result>(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      operation: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        issuedAt: string,
      ) => Promise<Result>,
    ): Promise<HumanOrganizationRequestResult<Result>> =>
      runWithMode("change", session, candidate, operation),
    runChangeWithRefusal: <Result>(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      operation: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        issuedAt: string,
      ) => Promise<Result>,
      mapDatabaseRefusal: (code: string, error: unknown) => Result | undefined,
    ): Promise<HumanOrganizationRequestResult<Result>> =>
      runWithMode(
        "change",
        session,
        candidate,
        operation,
        undefined,
        undefined,
        mapDatabaseRefusal,
      ),
    runChangePrepared: <Result>(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      prepare: ChangePreparation,
      operation: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        issuedAt: string,
      ) => Promise<Result>,
    ): Promise<HumanOrganizationRequestResult<Result>> =>
      runWithMode("change", session, candidate, operation, prepare),
    resolve: (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
    ): Promise<OrganizationScopeResolutionResult> =>
      runWithMode(
        "read",
        session,
        candidate,
        async (transaction, scope) => {
          const rows = await transaction.query<ScopeRow>`
          select
            checked ->> 'tenantId' as tenant_id,
            checked ->> 'organizationId' as organization_id,
            checked ->> 'organizationAccountId' as organization_account_id,
            checked ->> 'applicationRootId' as application_root_id,
            checked ->> 'accessVersion' as access_version
          from vortex_access.validated_human_request_context() as checked
        `;
          const checked = parseScope(rows);
          if (
            checked.tenantId !== scope.tenantId ||
            checked.organizationId !== scope.organizationId ||
            checked.organizationAccountId !== scope.organizationAccountId ||
            (checked.applicationRootId === undefined) !== (scope.applicationRootId === undefined) ||
            (checked.applicationRootId !== undefined &&
              scope.applicationRootId !== undefined &&
              !representsSameUuid(checked.applicationRootId, scope.applicationRootId)) ||
            checked.accessVersion !== scope.accessVersion
          )
            throw new Error("INVALID_PROTECTED_CONTEXT_RESULT");
          return checked;
        },
        undefined,
        () => ({ kind: "suspended_super_administrator_account" as const }),
      ),
  });
};
