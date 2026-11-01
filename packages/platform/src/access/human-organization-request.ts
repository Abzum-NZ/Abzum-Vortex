import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { correlationIdSchema } from "../catalogue/common";
import {
  builderKeySchema,
  namespacedKeySchema,
  identityAuthorityIdSchema,
  type IdentityAuthorityId,
} from "../catalogue/identifiers";
import { databaseRevision, databaseCode, describeFailure } from "../catalogue/runtime-primitives";
import {
  protectedOperationChannelSchema,
  type ProtectedOperationChannel,
} from "../definition/application-flow-bindings";
import {
  clampTelemetryDurationMs,
  countersForOutcome,
  type ServiceTelemetryPort,
  type TelemetryOutcome,
} from "../events/telemetry";
import {
  identitySessionSchema,
  organizationSelectionCandidateSchema,
  selectedOrganizationScopeSchema,
  sessionContextSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
  type SessionContext,
} from "./identity-access";
import {
  requireRequestSavepoint,
  withResolvedRequestTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
  type ResolvedRequestContext,
} from "../db/request-transaction";

import { databaseClockOf } from "./live-context";

type ResolvedRequestTransactionRunner = <Scope, Result>(
  resolve: (transaction: RequestDatabaseTransaction) => Promise<ResolvedRequestContext<Scope>>,
  operation: (transaction: RequestDatabaseTransaction, scope: Scope) => Promise<Result>,
) => Promise<Result>;

type ChangePreparation = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
) => Promise<void>;

/** A protected operation needs its enclosing transaction restarted from the beginning. */
export class HumanOrganizationRequestRestart extends Error {
  constructor() {
    super("HUMAN_ORGANIZATION_REQUEST_RESTART");
  }
}

/** A scope already resolved and locked by the enclosing admitted segment. */
export type BoundHumanOrganizationRequest = Readonly<{
  transaction: RequestDatabaseTransaction;
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  scope: SelectedOrganizationScope;
  issuedAt: string;
  mode: "shared" | "access_change";
  profileAccountId?: string;
}>;

export type HumanOrganizationRequestResult<Result, ExtraRefusal extends string = never> =
  | Readonly<{ kind: "available"; value: Result }>
  | Readonly<{
      kind: "unavailable";
      code?:
        | "recent_authentication_required"
        | "multi_factor_required"
        | "role_settings_change_required"
        | ExtraRefusal;
      cause?: string;
    }>
  | Readonly<{ kind: "temporarily_unavailable"; cause?: string; databaseCode?: string }>;

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
  boundRequest?: BoundHumanOrganizationRequest;
  clock?: () => Date;
  correlationId?: () => string;
  telemetry?: ServiceTelemetryPort;
}>;

/**
 * The lock a request holds on its organisation's Access version until it commits. Every request
 * that relies on the current version, a read or an ordinary change, holds it shared, so requests
 * never wait for each other. Only a change that advances the version holds it exclusively, from
 * its first statement: it waits for the requests that rely on the version it replaces, and two
 * such changes queue instead of deadlocking on a lock upgrade.
 */
type HumanOrganizationRequestMode = "shared" | "access_change";

type ScopeRow = DatabaseRow & {
  tenant_id: unknown;
  organization_id: unknown;
  organization_account_id: unknown;
  application_root_id?: unknown;
  access_version: unknown;
  completed_at?: unknown;
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
    } catch (error) {
      console.error(
        `[access] request telemetry not recorded ACCESS_TELEMETRY_FAILED: ${describeFailure(error)}`,
      );
      // Telemetry must not change the protected request's safe outcome.
    }
  };

  const runWithMode = async <Result, Special = never>(
    mode: HumanOrganizationRequestMode,
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate | undefined,
    operation: (
      transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope,
      issuedAt: string,
      selection: OrganizationSelectionCandidate,
      accountDisplayName: string | undefined,
    ) => Promise<Result>,
    prepare?: ChangePreparation,
    suspendedAccountResult?: () => Special,
    mapDatabaseRefusal?: (code: string, error: unknown) => Result | undefined,
    changedAccountId?: string,
    address?: Readonly<{
      tenantShortName: string;
      organizationShortName: string;
      applicationKey: string;
    }>,
  ): Promise<HumanOrganizationRequestResult<Result> | Special> => {
    const verifiedSession = identitySessionSchema.safeParse(session);
    const verifiedCandidate =
      candidate === undefined
        ? undefined
        : organizationSelectionCandidateSchema.safeParse(candidate);
    if (
      !verifiedSession.success ||
      (address === undefined && !verifiedCandidate?.success) ||
      (address !== undefined &&
        (!builderKeySchema.safeParse(address.tenantShortName).success ||
          !builderKeySchema.safeParse(address.organizationShortName).success ||
          !namespacedKeySchema.safeParse(address.applicationKey).success))
    )
      return { kind: "unavailable" };
    let selected = verifiedCandidate?.success ? verifiedCandidate.data : undefined;
    let accountDisplayName: string | undefined;

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
      const bound = dependencies.boundRequest;
      if (bound !== undefined) {
        if (selected === undefined) throw new Error("BOUND_REQUEST_SCOPE_MISMATCH");
        const boundScope = selectedOrganizationScopeSchema.parse(bound.scope);
        if (
          JSON.stringify(verifiedSession.data) !==
            JSON.stringify(identitySessionSchema.parse(bound.session)) ||
          JSON.stringify(selected) !==
            JSON.stringify(organizationSelectionCandidateSchema.parse(bound.selection)) ||
          !representsSameUuid(boundScope.organizationId, selected.organizationId) ||
          (boundScope.applicationRootId === undefined) !==
            (selected.applicationRootId === undefined) ||
          (boundScope.applicationRootId !== undefined &&
            selected.applicationRootId !== undefined &&
            !representsSameUuid(boundScope.applicationRootId, selected.applicationRootId)) ||
          boundScope.previewInstallationId !== selected.previewInstallationId ||
          !Number.isFinite(Date.parse(bound.issuedAt)) ||
          Date.parse(bound.issuedAt) >= Date.parse(verifiedSession.data.accessTokenExpiresAt) ||
          (mode === "access_change" && bound.mode !== "access_change") ||
          (changedAccountId !== undefined &&
            (bound.profileAccountId === undefined ||
              !representsSameUuid(changedAccountId, bound.profileAccountId)))
        )
          throw new Error("BOUND_REQUEST_SCOPE_MISMATCH");
        issuedAt = bound.issuedAt;
        const value = await requireRequestSavepoint(bound.transaction).withSavepoint(
          async (child) => {
            if (prepare !== undefined) await prepare(child, boundScope);
            return operation(child, boundScope, issuedAt, selected!, accountDisplayName);
          },
        );
        appendTelemetry(correlationId, "success", startedAtMs);
        return { kind: "available", value };
      }
      const value = await runTransaction(
        async (transaction) => {
          let addressedRows: readonly ScopeRow[] | undefined;
          if (address !== undefined) {
            addressedRows = await transaction.query<ScopeRow>`
              select * from vortex_access.resolve_human_application_address_scope(
                ${verifiedSession.data.identityId}::uuid, ${address.tenantShortName}::text,
                ${address.organizationShortName}::text, ${address.applicationKey}::text
              )
            `;
            const addressedScope = parseScope(addressedRows);
            if (addressedScope.applicationRootId === undefined)
              throw new Error("INVALID_SCOPE_RESULT");
            selected = organizationSelectionCandidateSchema.parse({
              organizationId: addressedScope.organizationId,
              applicationRootId: addressedScope.applicationRootId,
            });
            const display = addressedRows[0]?.account_display_name;
            if (display !== null && display !== undefined && typeof display !== "string")
              throw new Error("INVALID_ADDRESS_RESULT");
            accountDisplayName = display ?? undefined;
          }
          if (selected === undefined) throw new Error("INVALID_SCOPE_RESULT");
          // A preview request runs the preview's installation and registration in every read and
          // change of this transaction, the scope check included; the database refuses an address
          // its builder may not run.
          if (selected.previewInstallationId !== undefined)
            await transaction.query`
              select pg_catalog.set_config(
                'vortex_record.preview_installation_id',
                ${selected.previewInstallationId}, true
              )
            `;
          // A profile change locks the accounts it writes before the scope holds the actor's
          // account shared, so two saves of one account queue instead of deadlocking.
          if (changedAccountId !== undefined)
            await transaction.query`
              select vortex_access.lock_organization_accounts_for_profile_change(
                ${verifiedSession.data.identityId}::uuid,
                ${selected.organizationId}::uuid,
                ${changedAccountId}::uuid
              )
            `;
          const rows =
            addressedRows ??
            (selected.applicationRootId === undefined
              ? mode === "access_change"
                ? await transaction.query<ScopeRow>`
                  select scope.*, pg_catalog.clock_timestamp() as completed_at
                  from vortex_access.resolve_human_organization_access_change_scope(
                    ${verifiedSession.data.identityId}::uuid,
                    ${selected.organizationId}::uuid
                  ) as scope
                `
                : await transaction.query<ScopeRow>`
                  select scope.*, pg_catalog.clock_timestamp() as completed_at
                  from vortex_access.resolve_human_organization_scope(
                    ${verifiedSession.data.identityId}::uuid,
                    ${selected.organizationId}::uuid
                  ) as scope
                `
              : mode === "access_change"
                ? await transaction.query<ScopeRow>`
                  select scope.*, pg_catalog.clock_timestamp() as completed_at
                  from vortex_access.resolve_human_application_access_change_scope(
                    ${verifiedSession.data.identityId}::uuid,
                    ${selected.organizationId}::uuid,
                    ${selected.applicationRootId}::uuid
                  ) as scope
                `
                : await transaction.query<ScopeRow>`
                  select scope.*, pg_catalog.clock_timestamp() as completed_at
                  from vortex_access.resolve_human_application_scope(
                    ${verifiedSession.data.identityId}::uuid,
                    ${selected.organizationId}::uuid,
                    ${selected.applicationRootId}::uuid
                  ) as scope
                `);
          const parsedScope = parseScope(rows);
          const scope: SelectedOrganizationScope =
            selected.previewInstallationId === undefined
              ? parsedScope
              : {
                  ...parsedScope,
                  previewInstallationId: selected.previewInstallationId,
                };
          if (
            (selected.applicationRootId === undefined) !==
              (scope.applicationRootId === undefined) ||
            (selected.applicationRootId !== undefined &&
              scope.applicationRootId !== undefined &&
              !representsSameUuid(selected.applicationRootId, scope.applicationRootId))
          )
            throw new Error("INVALID_SCOPE_RESULT");
          // Live context and permission deadlines are checked on the database clock. Issue the
          // context on that same clock, read by the scope statement once the scope is resolved: a
          // web host ahead by even a few milliseconds must not produce a future-issued context
          // that a fast request then refuses.
          issuedAt = new Date(databaseClockOf(rows)).toISOString();
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
        (transaction, scope) =>
          operation(transaction, scope, issuedAt, selected!, accountDisplayName),
      );
      appendTelemetry(correlationId, "success", startedAtMs);
      return { kind: "available", value };
    } catch (error) {
      if (error instanceof HumanOrganizationRequestRestart) throw error;
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
      const multiFactorRequired = code === "V3152";
      const roleSettingsChangeRequired = code === "V3151";
      // Postgres reports a missing privilege (a lost GRANT, a role misconfiguration) with the same
      // code as the access model's refusals, but always as "permission denied for ...".
      const missingPrivilege =
        code === "42501" &&
        error instanceof Error &&
        error.message.startsWith("permission denied for ");
      const refused =
        (address !== undefined && code === "P0002") ||
        (code === "42501" && !missingPrivilege) ||
        recentAuthenticationRequired ||
        multiFactorRequired ||
        roleSettingsChangeRequired ||
        (error instanceof Error && error.name === "FirstInstallUnavailable");
      const cause = describeFailure(error);
      // A request its caller abandoned (the browser left the page) is stopped on purpose, and a
      // refusal the access model raises is it answering: neither is a failure of the platform, so
      // neither is logged as an error. Every other cause, a missing privilege too, is logged in full.
      const abandoned =
        error instanceof Error &&
        error.name === "VortexDatabaseError" &&
        error.message === "DATABASE_REQUEST_STOPPED";
      if (abandoned) console.info(`[access] human organisation request stopped: ${cause}`);
      else if (refused || code === "DEFINITION_DRAFT_STALE_OR_MISSING")
        console.info(`[access] human organisation request refused: ${cause}`);
      else console.error(`[access] human organisation request failed: ${cause}`);
      appendTelemetry(correlationId, refused ? "refused" : "temporarily_unavailable", startedAtMs);
      return multiFactorRequired
        ? { kind: "unavailable", code: "multi_factor_required", cause }
        : recentAuthenticationRequired
          ? { kind: "unavailable", code: "recent_authentication_required", cause }
          : roleSettingsChangeRequired
            ? { kind: "unavailable", code: "role_settings_change_required", cause }
            : refused
              ? { kind: "unavailable" }
              : {
                  kind: "temporarily_unavailable",
                  cause,
                  ...(code === undefined ? {} : { databaseCode: code }),
                };
    }
  };

  return Object.freeze({
    /** Resolves an address and opens exactly one application scope for a flow invocation. */
    runAddressed: <Result>(
      session: IdentitySession,
      address: Readonly<{
        tenantShortName: string;
        organizationShortName: string;
        applicationKey: string;
      }>,
      operation: (
        bound: BoundHumanOrganizationRequest,
        accountDisplayName: string | undefined,
        addressIdentity: unknown,
      ) => Promise<Result>,
    ): Promise<HumanOrganizationRequestResult<Result>> =>
      runWithMode(
        "shared",
        session,
        undefined,
        async (transaction, scope, issuedAt, selection, accountDisplayName) => {
          // This must be the first operation in the scoped request: the hint conveys no authority.
          const rows =
            await transaction.query`select vortex_definition.resolve_addressed_active_application_identity(${address.applicationKey}::text) as identity`;
          const identity = z
            .object({
              organizationId: z.uuid(),
              applicationRootId: z.uuid(),
              definitionKey: z.string(),
              applicationReleaseRevision: z.number().int().nonnegative(),
            })
            .strict()
            .parse(rows[0]?.identity);
          if (
            scope.applicationRootId === undefined ||
            !representsSameUuid(identity.organizationId, scope.organizationId) ||
            !representsSameUuid(identity.applicationRootId, scope.applicationRootId) ||
            identity.definitionKey !== address.applicationKey
          )
            throw new Error("ADDRESSED_SCOPE_IDENTITY_MISMATCH");
          return operation(
            { transaction, scope, issuedAt, selection, session, mode: "shared" },
            accountDisplayName,
            identity,
          );
        },
        undefined,
        undefined,
        undefined,
        undefined,
        address,
      ),
    run: <Result>(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      operation: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        issuedAt: string,
      ) => Promise<Result>,
    ): Promise<HumanOrganizationRequestResult<Result>> =>
      runWithMode("shared", session, candidate, operation),
    runChange: <Result>(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      operation: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        issuedAt: string,
      ) => Promise<Result>,
    ): Promise<HumanOrganizationRequestResult<Result>> =>
      runWithMode("shared", session, candidate, operation),
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
        "shared",
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
      runWithMode("shared", session, candidate, operation, prepare),
    /**
     * An ordinary change that writes one organisation account's profile. It holds the Access
     * version shared like any ordinary change, but locks the account it writes first.
     */
    runProfileChange: <Result>(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      organizationAccountId: string,
      operation: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        issuedAt: string,
      ) => Promise<Result>,
      mapDatabaseRefusal: (code: string, error: unknown) => Result | undefined,
    ): Promise<HumanOrganizationRequestResult<Result>> =>
      runWithMode(
        "shared",
        session,
        candidate,
        operation,
        undefined,
        undefined,
        mapDatabaseRefusal,
        organizationAccountId,
      ),
    /**
     * A change that advances the organisation's Access version (role, group, assignment,
     * delegation, account, stewardship, installation access or direct-share changes). It holds
     * the version exclusively from its first statement; see `HumanOrganizationRequestMode`.
     */
    runAccessChange: <Result>(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      operation: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        issuedAt: string,
      ) => Promise<Result>,
    ): Promise<HumanOrganizationRequestResult<Result>> =>
      runWithMode("access_change", session, candidate, operation),
    runAccessChangeWithRefusal: <Result>(
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
        "access_change",
        session,
        candidate,
        operation,
        undefined,
        undefined,
        mapDatabaseRefusal,
      ),
    resolve: (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
    ): Promise<OrganizationScopeResolutionResult> =>
      runWithMode(
        "shared",
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
