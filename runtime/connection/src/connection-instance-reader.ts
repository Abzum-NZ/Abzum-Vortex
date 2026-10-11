import "server-only";

import {
  activeConnectionEvidenceSchema,
  applicationRootIdSchema,
  archiveDestinationReferenceSchema,
  connectionInstanceIdSchema,
  connectionInstanceStatusSchema,
  connectionTypeIdSchema,
  databaseRevision,
  databaseTimestamp,
  isRecord,
  organizationAccessDeclarationSchema,
  organizationIdSchema,
  organizationPermissionEligibilitySchema,
  permissionIdSchema,
  platformIdSchema,
  protectedOperationChannelSchema,
  sameId,
  semanticVersionSchema,
  sessionContextSchema,
  timestampSchema,
  type ActiveConnectionEvidence,
  type ApplicationRootId,
  type ArchiveDestinationReference,
  type ConnectionInstanceId,
  type ConnectionInstanceStatus,
  type ConnectionTypeId,
  type OrganizationId,
  type SessionContext,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { readActiveConnectionEvidence } from "./connection-readiness";

/**
 * The protected read side of connection administration.
 *
 * A connection administration page must show the organisation's instances and their safe status
 * without ever receiving a secret. This module reads through the request-callable
 * `vortex_connection.*_for_administration` readers, which are SECURITY DEFINER functions that
 * require the validated connection-administration context: the caller must hold
 * `platform.organization.connections.manage` in the request-context organisation, and every row is
 * filtered to that organisation, so another organisation's instance is never returned. The reader
 * returns only the page read model - state, health, expiry, authority revision and both scope lists -
 * and never a secret value, a secret reference, an organisation identity or an administrator
 * activity identity.
 *
 * Nothing here is authority. The SQL readers decide the organisation and the permission on every
 * call; this module validates shape, applies the caller's expected organisation as a cross-check and
 * returns a fixed safe outcome.
 */

/** The largest page of connection instances one read may return, matching the SQL reader's own bound. */
export const MAXIMUM_CONNECTION_INSTANCE_PAGE_SIZE = 100;

/** The closed set of reasons a connection instance read may be refused. */
export const connectionInstanceReaderRefusalCodes = [
  "invalid_parameters",
  "not_authorized",
  "connection_unavailable",
  "administration_unavailable",
] as const;

export type ConnectionInstanceReaderRefusalCode =
  (typeof connectionInstanceReaderRefusalCodes)[number];

export type ConnectionInstanceReadResult =
  | Readonly<{ outcome: "available"; instance: ConnectionInstanceStatus }>
  | Readonly<{ outcome: "unavailable"; reasonCode: ConnectionInstanceReaderRefusalCode }>;

/** One bounded page of safe instance statuses, with the cursor for the next page when there is one. */
export type ConnectionInstancePageReadResult =
  | Readonly<{
      outcome: "available";
      instances: readonly ConnectionInstanceStatus[];
      nextAfterConnectionInstanceId?: ConnectionInstanceId;
    }>
  | Readonly<{ outcome: "unavailable"; reasonCode: ConnectionInstanceReaderRefusalCode }>;

/** One reader page request: an optional exclusive cursor and a bounded page size. */
export type ConnectionInstancePageQuery = Readonly<{
  afterConnectionInstanceId?: ConnectionInstanceId;
  pageSize: number;
}>;

/** A server-only option for choosing an active Connection for an exact Application. */
export type EligibleArchiveConnectionOption = Readonly<{
  connectionInstanceId: ConnectionInstanceId;
  connectionTypeId: ConnectionTypeId;
  connectionTypeVersion: ConnectionInstanceStatus["connectionTypeVersion"];
  destinationKey: ArchiveDestinationReference;
  expectedRevision: number;
  /** Keep this in the server-side result only; browser projections must remove it. */
  destinationFingerprint: string;
}>;

export const eligibleArchiveConnectionUnavailableCodes = [
  "invalid_parameters",
  "not_authorized",
  "stale_page",
  "connection_options_unavailable",
] as const;

export type EligibleArchiveConnectionUnavailableCode =
  (typeof eligibleArchiveConnectionUnavailableCodes)[number];

/** One safe, bounded page of active Connections usable by the current archive policy. */
export type EligibleArchiveConnectionOptionsResult =
  | Readonly<{
      outcome: "available";
      options: readonly EligibleArchiveConnectionOption[];
      nextAfterConnectionInstanceId?: ConnectionInstanceId;
    }>
  | Readonly<{
      outcome: "unavailable";
      reasonCode: EligibleArchiveConnectionUnavailableCode;
    }>;

type HumanRequestContext = Extract<SessionContext, Readonly<{ callerKind: "human" }>>;

type PermissionCompletionRow = DatabaseRow & {
  readonly request_context: unknown;
  readonly outcome: unknown;
  readonly operation_key: unknown;
  readonly target_kind: unknown;
  readonly target_application_root_id: unknown;
  readonly organization_id: unknown;
  readonly organization_account_id: unknown;
  readonly access_version: unknown;
  readonly checked_at: unknown;
  readonly valid_until: unknown;
  readonly correlation_id: unknown;
  readonly reason_code: unknown;
};

type DatabaseClockRow = DatabaseRow & { readonly completed_at: unknown };

type VerifiedConnectionManagement = Readonly<{
  context: HumanRequestContext;
  deadline: number;
  completedAt: number;
}>;

type PermissionCheck =
  | Readonly<{ ok: true; value: VerifiedConnectionManagement }>
  | Readonly<{ ok: false; reasonCode: "not_authorized" | "connection_options_unavailable" }>;

/*
 * These are the permanent IDs of the pinned platform declaration in
 * modules/src/system-core/platform-permissions.ts and its platform owner in
 * modules/src/platform-permissions.ts. Keep the declaration exact here so this
 * low-level package does not acquire a new @vortex/modules dependency.
 */
const connectionManagementDeclaration = organizationAccessDeclarationSchema.parse({
  operationKey: "platform.organization.connections.manage",
  action: { actionKind: "manage" },
  target: { kind: "organization" },
  requiredPermission: {
    ownerKind: "platform",
    ownerId: platformIdSchema.parse("cabe121e-0baf-4084-9471-cce915d460a8"),
    permissionId: permissionIdSchema.parse("ec2908a1-f3cd-4c4a-8bf7-91bffbf4cb3d"),
  },
  recentAuthentication: { kind: "none" },
  authority: { kind: "permission" },
});

const unavailableArchiveOptions = (
  reasonCode: EligibleArchiveConnectionUnavailableCode,
): EligibleArchiveConnectionOptionsResult => Object.freeze({ outcome: "unavailable", reasonCode });

const sameHumanContext = (left: HumanRequestContext, right: HumanRequestContext): boolean =>
  sameId(left.identityAuthorityId, right.identityAuthorityId) &&
  sameId(left.identityId, right.identityId) &&
  sameId(left.tenantId, right.tenantId) &&
  sameId(left.organizationId, right.organizationId) &&
  sameId(left.organizationAccountId, right.organizationAccountId) &&
  sameId(left.applicationRootId, right.applicationRootId) &&
  sameId(left.sessionId, right.sessionId) &&
  left.accessVersion === right.accessVersion &&
  sameId(left.correlationId, right.correlationId) &&
  left.issuedAt === right.issuedAt &&
  left.expiresAt === right.expiresAt &&
  left.authenticationStrength === right.authenticationStrength &&
  left.accessTokenIssuedAt === right.accessTokenIssuedAt &&
  left.primaryAuthenticatedAt === right.primaryAuthenticatedAt &&
  left.multiFactorAuthenticatedAt === right.multiFactorAuthenticatedAt;

const sameSelectedApplicationContext = (
  context: HumanRequestContext,
  applicationRootId: ApplicationRootId,
): boolean =>
  context.applicationRootId === undefined || sameId(context.applicationRootId, applicationRootId);

const readDatabaseClock = async (
  transaction: RequestDatabaseTransaction,
): Promise<number | undefined> => {
  try {
    const rows = await transaction.query<DatabaseClockRow>`
      select pg_catalog.clock_timestamp() as completed_at
    `;
    const parsed = timestampSchema.safeParse(databaseTimestamp(rows[0]?.completed_at));
    if (rows.length !== 1 || !parsed.success) return undefined;
    const instant = Date.parse(parsed.data);
    return Number.isFinite(instant) ? instant : undefined;
  } catch {
    return undefined;
  }
};

const refusalForPermissionFailure = (
  error: unknown,
): "not_authorized" | "connection_options_unavailable" => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return code === "42501" ? "not_authorized" : "connection_options_unavailable";
};

/**
 * Re-evaluates the fixed HUMAN permission in the current transaction and takes a fresh database
 * clock reading after the evaluator returns. A previous context is supplied after the first check
 * so changing the request identity tuple can never be blended into one page.
 */
const verifyConnectionManagement = async (
  transaction: RequestDatabaseTransaction,
  organizationId: OrganizationId,
  applicationRootId: ApplicationRootId,
  previousContext?: HumanRequestContext,
): Promise<PermissionCheck> => {
  try {
    const rows = await transaction.query<PermissionCompletionRow>`
      select vortex_access.validated_human_request_context() as request_context,
        eligibility.outcome,
        eligibility.operation_key,
        eligibility.target_kind,
        eligibility.target_application_root_id,
        eligibility.organization_id,
        eligibility.organization_account_id,
        eligibility.access_version,
        eligibility.checked_at,
        eligibility.valid_until,
        eligibility.correlation_id,
        eligibility.reason_code
      from vortex_access.evaluate_organization_permission_eligibility(
        ${JSON.stringify(connectionManagementDeclaration)}::text::jsonb
      ) as eligibility
    `;
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined)
      return { ok: false, reasonCode: "connection_options_unavailable" };

    if (!isRecord(row.request_context))
      return { ok: false, reasonCode: "not_authorized" };
    const { channel: rawChannel, ...sessionContextCandidate } = row.request_context;
    const channel = protectedOperationChannelSchema.safeParse(rawChannel);
    // This chooser is for the Web HUMAN flow; transport metadata is not SessionContext.
    if (!channel.success || channel.data !== "web")
      return { ok: false, reasonCode: "not_authorized" };

    const parsedContext = sessionContextSchema.safeParse(sessionContextCandidate);
    if (!parsedContext.success || parsedContext.data.callerKind !== "human")
      return { ok: false, reasonCode: "not_authorized" };
    const context = parsedContext.data;
    if (
      !sameId(context.organizationId, organizationId) ||
      !sameSelectedApplicationContext(context, applicationRootId) ||
      (previousContext !== undefined && !sameHumanContext(previousContext, context))
    )
      return { ok: false, reasonCode: "not_authorized" };

    const eligibility = organizationPermissionEligibilitySchema.safeParse({
      outcome: row.outcome,
      operationKey: row.operation_key,
      target: { kind: row.target_kind },
      organizationId: row.organization_id,
      organizationAccountId: row.organization_account_id,
      accessVersion: databaseRevision(row.access_version),
      checkedAt: databaseTimestamp(row.checked_at),
      correlationId: row.correlation_id,
      ...(row.outcome === "eligible"
        ? { validUntil: databaseTimestamp(row.valid_until) }
        : { reasonCode: row.reason_code }),
    });
    if (!eligibility.success)
      return { ok: false, reasonCode: "connection_options_unavailable" };
    const decision = eligibility.data;
    if (
      decision.outcome !== "eligible" ||
      decision.operationKey !== connectionManagementDeclaration.operationKey ||
      decision.target.kind !== "organization" ||
      row.target_application_root_id !== null ||
      row.reason_code !== null ||
      !sameId(decision.organizationId, context.organizationId) ||
      !sameId(decision.organizationAccountId, context.organizationAccountId) ||
      decision.accessVersion !== context.accessVersion ||
      !sameId(decision.correlationId, context.correlationId)
    )
      return { ok: false, reasonCode: "not_authorized" };

    const completedAt = await readDatabaseClock(transaction);
    if (completedAt === undefined)
      return { ok: false, reasonCode: "connection_options_unavailable" };
    const permissionDeadline = Date.parse(decision.validUntil);
    const sessionDeadline = Date.parse(context.expiresAt);
    const issuedAt = Date.parse(context.issuedAt);
    const checkedAt = Date.parse(decision.checkedAt);
    if (
      !Number.isFinite(permissionDeadline) ||
      !Number.isFinite(sessionDeadline) ||
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(checkedAt) ||
      issuedAt > completedAt ||
      checkedAt > completedAt ||
      permissionDeadline <= completedAt ||
      sessionDeadline <= completedAt
    )
      return { ok: false, reasonCode: "not_authorized" };

    return {
      ok: true,
      value: Object.freeze({
        context,
        deadline: Math.min(permissionDeadline, sessionDeadline),
        completedAt,
      }),
    };
  } catch (error) {
    return { ok: false, reasonCode: refusalForPermissionFailure(error) };
  }
};

const validateArchiveOptionPageQuery = (
  candidate: unknown,
): Readonly<{ after: ConnectionInstanceId | null; pageSize: number }> | undefined => {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
      return undefined;
    const value = candidate as Readonly<Record<string, unknown>>;
    if (
      Object.keys(value).some(
        (key) => key !== "afterConnectionInstanceId" && key !== "pageSize",
      )
    )
      return undefined;
    if (
      typeof value.pageSize !== "number" ||
      !Number.isInteger(value.pageSize) ||
      value.pageSize < 1 ||
      value.pageSize > MAXIMUM_CONNECTION_INSTANCE_PAGE_SIZE
    )
      return undefined;
    return Object.freeze({
      after:
        value.afterConnectionInstanceId === undefined
          ? null
          : connectionInstanceIdSchema.parse(value.afterConnectionInstanceId),
      pageSize: value.pageSize,
    });
  } catch {
    return undefined;
  }
};

const mapAdministrationUnavailable = (
  reasonCode: ConnectionInstanceReaderRefusalCode,
): EligibleArchiveConnectionUnavailableCode => {
  if (reasonCode === "invalid_parameters") return "invalid_parameters";
  if (reasonCode === "not_authorized") return "not_authorized";
  return "connection_options_unavailable";
};

const isSelectedApplication = (
  applicationIds: readonly ApplicationRootId[],
  applicationRootId: ApplicationRootId,
): boolean => applicationIds.some((candidate) => sameId(candidate, applicationRootId));

const tokenExpiryInstant = (value: string | undefined): number | null | undefined => {
  if (value === undefined) return null;
  const parsed = timestampSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const instant = Date.parse(parsed.data);
  return Number.isFinite(instant) ? instant : undefined;
};

type ReadConnectionInstanceRow = DatabaseRow & {
  readonly organization_id: unknown;
  readonly connection_instance: unknown;
};

type ListConnectionInstancesRow = DatabaseRow & {
  readonly organization_id: unknown;
  readonly connection_instances: unknown;
  readonly next_after_connection_instance_id: unknown;
};

const unavailable = (
  reasonCode: ConnectionInstanceReaderRefusalCode,
): Readonly<{ outcome: "unavailable"; reasonCode: ConnectionInstanceReaderRefusalCode }> =>
  Object.freeze({ outcome: "unavailable", reasonCode });

/** Maps a database failure to a fixed code by SQLSTATE only; the message is never read. */
const refusalForFailure = (error: unknown): ConnectionInstanceReaderRefusalCode => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  if (code === "42501") return "not_authorized";
  if (code === "22023" || code === "22003") return "invalid_parameters";
  return "administration_unavailable";
};

/** Identifiers are case-insensitive: compare the canonical lower-cased forms. */
const sameIdentifier = (left: unknown, right: string): boolean =>
  typeof left === "string" && sameId(left, right);

/** Validates the two read identifiers as shapes, returning no value when either is malformed. */
const validateIdentifiers = (
  organizationId: unknown,
  connectionInstanceId: unknown,
): Readonly<{ organization: string; connectionInstance: string }> | undefined => {
  try {
    return Object.freeze({
      organization: organizationIdSchema.parse(organizationId),
      connectionInstance: connectionInstanceIdSchema.parse(connectionInstanceId),
    });
  } catch {
    return undefined;
  }
};

/** Validates a page request as shapes, returning no value when the page size or cursor is malformed. */
const validatePageQuery = (
  organizationId: unknown,
  query: unknown,
):
  | Readonly<{
      organization: string;
      afterConnectionInstanceId: string | null;
      pageSize: number;
    }>
  | undefined => {
  try {
    if (query === null || typeof query !== "object") return undefined;
    const candidate = query as Readonly<{
      afterConnectionInstanceId?: unknown;
      pageSize?: unknown;
    }>;
    if (
      typeof candidate.pageSize !== "number" ||
      !Number.isInteger(candidate.pageSize) ||
      candidate.pageSize < 1 ||
      candidate.pageSize > MAXIMUM_CONNECTION_INSTANCE_PAGE_SIZE
    )
      return undefined;
    return Object.freeze({
      organization: organizationIdSchema.parse(organizationId),
      afterConnectionInstanceId:
        candidate.afterConnectionInstanceId === undefined
          ? null
          : connectionInstanceIdSchema.parse(candidate.afterConnectionInstanceId),
      pageSize: candidate.pageSize,
    });
  } catch {
    return undefined;
  }
};

/**
 * Reads one connection instance's safe status for the administration page.
 *
 * The organisation and the instance identity are validated as shapes first; the SQL reader then
 * re-checks the organisation, the administration permission and the instance's organisation from the
 * request context. A value that does not satisfy the page read model, a row from a different
 * organisation than the caller asserted, and a row that is absent are all one neutral
 * `unavailable`, so no secret and no other organisation's instance is ever returned.
 */
export async function readConnectionInstanceForAdministration(
  transaction: RequestDatabaseTransaction,
  organizationId: OrganizationId,
  connectionInstanceId: ConnectionInstanceId,
): Promise<ConnectionInstanceReadResult> {
  const validated = validateIdentifiers(organizationId, connectionInstanceId);
  if (validated === undefined) return unavailable("invalid_parameters");
  const { organization, connectionInstance } = validated;

  try {
    const rows = await transaction.query<ReadConnectionInstanceRow>`
      select organization_id, connection_instance
      from vortex_connection.read_connection_instance_for_administration(
        ${organization}::uuid,
        ${connectionInstance}::uuid
      )
    `;
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined) return unavailable("connection_unavailable");
    if (!sameIdentifier(row.organization_id, organization))
      return unavailable("administration_unavailable");

    const parsed = connectionInstanceStatusSchema.safeParse(row.connection_instance);
    if (!parsed.success) return unavailable("administration_unavailable");
    if (!sameIdentifier(parsed.data.connectionInstanceId, connectionInstance))
      return unavailable("administration_unavailable");

    return Object.freeze({ outcome: "available", instance: parsed.data });
  } catch (error) {
    return unavailable(refusalForFailure(error));
  }
}

/**
 * Reads one bounded page of the organisation's connection instance safe statuses.
 *
 * The page size and optional cursor are validated as shapes first; the SQL reader then re-checks the
 * organisation and the administration permission from the request context and returns only instances
 * of that organisation. A malformed page, a row from a different organisation than the caller
 * asserted, and a malformed status value are all one neutral `unavailable`, so neither a secret nor
 * another organisation's instance is ever returned.
 */
export async function listConnectionInstancesForAdministration(
  transaction: RequestDatabaseTransaction,
  organizationId: OrganizationId,
  query: ConnectionInstancePageQuery,
): Promise<ConnectionInstancePageReadResult> {
  const validated = validatePageQuery(organizationId, query);
  if (validated === undefined) return unavailable("invalid_parameters");
  const { organization, afterConnectionInstanceId, pageSize } = validated;

  try {
    const rows = await transaction.query<ListConnectionInstancesRow>`
      select organization_id, connection_instances, next_after_connection_instance_id
      from vortex_connection.list_connection_instances_for_administration(
        ${organization}::uuid,
        ${afterConnectionInstanceId}::uuid,
        ${pageSize}::integer
      )
    `;
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined) return unavailable("administration_unavailable");
    if (!sameIdentifier(row.organization_id, organization))
      return unavailable("administration_unavailable");
    if (!Array.isArray(row.connection_instances)) return unavailable("administration_unavailable");

    const parsed = connectionInstanceStatusSchema
      .array()
      .max(MAXIMUM_CONNECTION_INSTANCE_PAGE_SIZE)
      .safeParse(row.connection_instances);
    if (!parsed.success) return unavailable("administration_unavailable");

    if (
      row.next_after_connection_instance_id === null ||
      row.next_after_connection_instance_id === undefined
    )
      return Object.freeze({ outcome: "available", instances: Object.freeze([...parsed.data]) });

    const next = connectionInstanceIdSchema.safeParse(row.next_after_connection_instance_id);
    if (!next.success) return unavailable("administration_unavailable");
    return Object.freeze({
      outcome: "available",
      instances: Object.freeze([...parsed.data]),
      nextAfterConnectionInstanceId: next.data,
    });
  } catch (error) {
    return unavailable(refusalForFailure(error));
  }
}

/**
 * Derives a bounded, current HUMAN-visible archive-Connection option page for one exact
 * Application. The caller must supply the current protected destination policy and invoke this
 * method inside the same HUMAN `runChange` transaction that reads the provisioned target and saves
 * its policy. This method is read-only; the caller must rederive the selected tuple on submit.
 *
 * Connection status is first enumerated through the permission-gated administrative reader. Each
 * plausible row is then locked and checked by the existing active-evidence reader, followed by a
 * permission-gated status reread. Only the final server-side option tuple carries the destination
 * fingerprint; Web must omit it from any browser projection.
 */
export async function listEligibleArchiveConnectionsForApplication(
  transaction: RequestDatabaseTransaction,
  organizationId: OrganizationId,
  applicationRootId: ApplicationRootId,
  allowedArchiveDestinations: readonly ArchiveDestinationReference[],
  pageQuery: ConnectionInstancePageQuery,
): Promise<EligibleArchiveConnectionOptionsResult> {
  let organization: OrganizationId;
  let application: ApplicationRootId;
  let destinations: ReadonlySet<string>;
  const query = validateArchiveOptionPageQuery(pageQuery);
  try {
    organization = organizationIdSchema.parse(organizationId);
    application = applicationRootIdSchema.parse(applicationRootId);
    if (!Array.isArray(allowedArchiveDestinations))
      return unavailableArchiveOptions("invalid_parameters");
    const uniqueDestinations = new Set<string>();
    for (const candidate of allowedArchiveDestinations) {
      const destination = archiveDestinationReferenceSchema.parse(candidate);
      uniqueDestinations.add(destination);
    }
    destinations = uniqueDestinations;
  } catch {
    return unavailableArchiveOptions("invalid_parameters");
  }
  if (query === undefined) return unavailableArchiveOptions("invalid_parameters");

  try {
    let permission = await verifyConnectionManagement(transaction, organization, application);
    if (!permission.ok) return unavailableArchiveOptions(permission.reasonCode);
    const initialContext = permission.value.context;
    let permissionDeadline = permission.value.deadline;

    const refreshPermission = async (): Promise<PermissionCheck> => {
      const checked = await verifyConnectionManagement(
        transaction,
        organization,
        application,
        initialContext,
      );
      if (!checked.ok) return checked;
      permissionDeadline = Math.min(permissionDeadline, checked.value.deadline);
      if (checked.value.completedAt >= permissionDeadline)
        return { ok: false, reasonCode: "not_authorized" };
      return checked;
    };

    const page = await listConnectionInstancesForAdministration(transaction, organization, {
      ...(query.after === null ? {} : { afterConnectionInstanceId: query.after }),
      pageSize: query.pageSize,
    });
    if (page.outcome !== "available")
      return unavailableArchiveOptions(mapAdministrationUnavailable(page.reasonCode));

    const listed = page.instances;
    if (listed.length > query.pageSize)
      return unavailableArchiveOptions("stale_page");
    let previousId = query.after?.toLowerCase();
    for (const instance of listed) {
      const currentId = instance.connectionInstanceId.toLowerCase();
      if (previousId !== undefined && currentId <= previousId)
        return unavailableArchiveOptions("stale_page");
      previousId = currentId;
    }
    if (page.nextAfterConnectionInstanceId !== undefined) {
      const next = page.nextAfterConnectionInstanceId.toLowerCase();
      const last = listed[listed.length - 1]?.connectionInstanceId.toLowerCase();
      if (
        listed.length !== query.pageSize ||
        last === undefined ||
        next !== last ||
        (query.after !== null && next <= query.after.toLowerCase())
      )
        return unavailableArchiveOptions("stale_page");
    }

    permission = await refreshPermission();
    if (!permission.ok) return unavailableArchiveOptions(permission.reasonCode);

    const activeCandidates: Array<
      Readonly<{ listed: ConnectionInstanceStatus; evidence: ActiveConnectionEvidence }>
    > = [];
    for (const instance of listed) {
      if (
        instance.state !== "active" ||
        instance.lastHealthOutcome !== "healthy" ||
        !isSelectedApplication(instance.authorizedApplicationIds, application)
      )
        continue;

      const listedExpiry = tokenExpiryInstant(instance.tokenExpiresAt);
      if (listedExpiry === undefined)
        return unavailableArchiveOptions("connection_options_unavailable");
      if (listedExpiry !== null && listedExpiry <= permission.value.completedAt) continue;

      let rawEvidence: ActiveConnectionEvidence;
      try {
        rawEvidence = await readActiveConnectionEvidence(transaction, instance.connectionInstanceId);
      } catch {
        // This reader intentionally collapses absence, stale/inactive state and SQL errors.
        // None of those may be silently turned into a partial catalogue.
        return unavailableArchiveOptions("connection_options_unavailable");
      }
      const parsedEvidence = activeConnectionEvidenceSchema.safeParse(rawEvidence);
      if (!parsedEvidence.success)
        return unavailableArchiveOptions("connection_options_unavailable");
      const evidence = parsedEvidence.data;
      if (
        !sameId(evidence.connectionInstanceId, instance.connectionInstanceId) ||
        !sameId(evidence.organizationId, organization) ||
        evidence.revision !== instance.revision ||
        evidence.state !== "active" ||
        evidence.lastHealthOutcome !== "healthy"
      )
        return unavailableArchiveOptions("stale_page");
      if (!isSelectedApplication(evidence.authorizedApplicationIds, application))
        return unavailableArchiveOptions("stale_page");
      if (!destinations.has(evidence.destinationKey)) continue;
      activeCandidates.push(Object.freeze({ listed: instance, evidence }));
    }

    permission = await refreshPermission();
    if (!permission.ok) return unavailableArchiveOptions(permission.reasonCode);

    const optionCandidates: Array<
      Readonly<{ option: EligibleArchiveConnectionOption; expiresAt: number | null }>
    > = [];
    for (const candidate of activeCandidates) {
      const status = await readConnectionInstanceForAdministration(
        transaction,
        organization,
        candidate.evidence.connectionInstanceId,
      );
      if (status.outcome !== "available") {
        if (status.reasonCode === "not_authorized")
          return unavailableArchiveOptions("not_authorized");
        if (status.reasonCode === "invalid_parameters")
          return unavailableArchiveOptions("invalid_parameters");
        if (status.reasonCode === "connection_unavailable")
          return unavailableArchiveOptions("stale_page");
        return unavailableArchiveOptions("connection_options_unavailable");
      }
      const current = connectionInstanceStatusSchema.safeParse(status.instance);
      if (!current.success)
        return unavailableArchiveOptions("connection_options_unavailable");
      const instance = current.data;
      if (
        !sameId(instance.connectionInstanceId, candidate.listed.connectionInstanceId) ||
        instance.revision !== candidate.listed.revision ||
        instance.revision !== candidate.evidence.revision ||
        !sameId(instance.connectionTypeId, candidate.listed.connectionTypeId) ||
        instance.connectionTypeVersion !== candidate.listed.connectionTypeVersion ||
        instance.state !== "active" ||
        instance.lastHealthOutcome !== "healthy" ||
        !isSelectedApplication(instance.authorizedApplicationIds, application)
      )
        return unavailableArchiveOptions("stale_page");

      const expiresAt = tokenExpiryInstant(instance.tokenExpiresAt);
      if (expiresAt === undefined)
        return unavailableArchiveOptions("connection_options_unavailable");
      const fingerprint = candidate.evidence.destinationFingerprint;
      if (!/^[a-f0-9]{64}$/.test(fingerprint))
        return unavailableArchiveOptions("connection_options_unavailable");
      const option: EligibleArchiveConnectionOption = Object.freeze({
        connectionInstanceId: connectionInstanceIdSchema.parse(instance.connectionInstanceId),
        connectionTypeId: connectionTypeIdSchema.parse(instance.connectionTypeId),
        connectionTypeVersion: semanticVersionSchema.parse(instance.connectionTypeVersion),
        destinationKey: archiveDestinationReferenceSchema.parse(
          candidate.evidence.destinationKey,
        ),
        expectedRevision: instance.revision,
        destinationFingerprint: fingerprint,
      });
      optionCandidates.push(Object.freeze({ option, expiresAt }));
    }

    permission = await refreshPermission();
    if (!permission.ok) return unavailableArchiveOptions(permission.reasonCode);

    const validatedOptions: Array<
      Readonly<{ option: EligibleArchiveConnectionOption; expiresAt: number | null }>
    > = [];
    for (const candidate of optionCandidates) {
      const option = candidate.option;
      if (
        !connectionInstanceIdSchema.safeParse(option.connectionInstanceId).success ||
        !connectionTypeIdSchema.safeParse(option.connectionTypeId).success ||
        !semanticVersionSchema.safeParse(option.connectionTypeVersion).success ||
        !archiveDestinationReferenceSchema.safeParse(option.destinationKey).success ||
        !Number.isSafeInteger(option.expectedRevision) ||
        option.expectedRevision < 1 ||
        !/^[a-f0-9]{64}$/.test(option.destinationFingerprint)
      )
        return unavailableArchiveOptions("connection_options_unavailable");
      validatedOptions.push(candidate);
    }

    permission = await refreshPermission();
    if (!permission.ok) return unavailableArchiveOptions(permission.reasonCode);
    const options = validatedOptions
      .filter((candidate) => candidate.expiresAt === null || candidate.expiresAt > permission.value.completedAt)
      .map((candidate) => candidate.option);

    return Object.freeze({
      outcome: "available",
      options: Object.freeze(options),
      ...(page.nextAfterConnectionInstanceId === undefined
        ? {}
        : { nextAfterConnectionInstanceId: page.nextAfterConnectionInstanceId }),
    });
  } catch {
    return unavailableArchiveOptions("connection_options_unavailable");
  }
}
