import "server-only";

import {
  archiveDestinationReferenceSchema,
  connectionInstanceIdSchema,
  organizationIdSchema,
  applicationRootIdSchema,
  activeConnectionEvidenceSchema,
  timestampSchema,
  type ActiveConnectionEvidence,
  type ArchiveDestinationReference,
  type ConnectionInstanceId,
  type ApplicationRootId,
  type OrganizationId,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  assertDestinationFingerprint,
  assertFiniteTokenExpiry,
  assertSafeIntegerRevision,
  ConnectionInstanceStateError,
} from "./connection-instance-state";

/** The closed set of reasons a readiness request may be refused. */
export const connectionReadinessRefusalCodes = [
  "invalid_parameters",
  "organization_mismatch",
  "application_scope_required",
  "application_mismatch",
  "connection_unavailable",
  "connection_not_active",
  "connection_unhealthy",
  "connection_token_expired",
  "destination_mismatch",
  "stale_revision",
  "stale_fingerprint",
  "grant_unauthorized",
  "database_error",
] as const;

export type ConnectionReadinessRefusalCode = (typeof connectionReadinessRefusalCodes)[number];

const connectionReadinessRefusalCodeSet: ReadonlySet<string> = new Set<string>(
  connectionReadinessRefusalCodes,
);

const asConnectionReadinessRefusalCode = (value: unknown): ConnectionReadinessRefusalCode =>
  typeof value === "string" && connectionReadinessRefusalCodeSet.has(value)
    ? (value as ConnectionReadinessRefusalCode)
    : "connection_unavailable";

export interface ConnectionReadinessQuery {
  readonly connectionInstanceId: ConnectionInstanceId;
  readonly destinationKey: ArchiveDestinationReference;
  readonly applicationRootId: ApplicationRootId;
  readonly expectedRevision: number;
  readonly expectedFingerprint: string;
}

export type ConnectionReadinessResult =
  | Readonly<{
      outcome: "ready";
      connectionInstanceId: ConnectionInstanceId;
      organizationId: OrganizationId;
      applicationRootId: ApplicationRootId;
      destinationKey: ArchiveDestinationReference;
      destinationFingerprint: string;
      revision: number;
      healthOutcome: "healthy";
      state: "active";
      verifiedAt: string;
    }>
  | Readonly<{
      outcome: "refused";
      reasonCode: ConnectionReadinessRefusalCode;
      message: string;
      currentState?: string;
      currentHealthOutcome?: string;
      currentRevision?: number;
    }>;

type SqlReadinessRow = DatabaseRow & {
  readonly readiness_result: unknown;
};

type SqlEvidenceRow = DatabaseRow & {
  readonly connection_instance_id: unknown;
  readonly destination_key: unknown;
  readonly destination_fingerprint: unknown;
  readonly organization_id: unknown;
  readonly authorized_application_ids: unknown;
  readonly state: unknown;
  readonly revision: unknown;
  readonly last_health_outcome: unknown;
};

export class ConnectionReadinessError extends Error {
  readonly code: ConnectionReadinessRefusalCode;

  constructor(code: ConnectionReadinessRefusalCode, message: string) {
    super(message);
    this.name = "ConnectionReadinessError";
    this.code = code;
  }
}

/** Identifiers are case-insensitive: compare the canonical lower-cased forms. */
const sameIdentifier = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const isValidationError = (error: unknown): boolean =>
  error instanceof ConnectionInstanceStateError ||
  (error instanceof Error && error.name === "ZodError");

/**
 * Executes authoritative SQL readiness resolution for an exact Connection instance
 * against the current request context transaction.
 *
 * Exposes the owner-projected read/check surface that 20260923010000 policy SQL consumes.
 * Fails closed on inactive, unhealthy, expired, mismatched destination, ungranted application,
 * or stale revision/fingerprint. Every failure, including malformed input and an unreadable
 * token expiry, is returned as a fixed safe refusal; no database message is propagated.
 */
export async function resolveConnectionInstanceReadiness(
  transaction: RequestDatabaseTransaction,
  query: ConnectionReadinessQuery,
  organizationId: OrganizationId,
): Promise<ConnectionReadinessResult> {
  let parametersValidated = false;

  try {
    const validatedConnId = connectionInstanceIdSchema.parse(query.connectionInstanceId);
    const validatedDestKey = archiveDestinationReferenceSchema.parse(query.destinationKey);
    const validatedAppId = applicationRootIdSchema.parse(query.applicationRootId);
    const validatedRevision = assertSafeIntegerRevision(
      query.expectedRevision,
      `Readiness check for connection ${validatedConnId}`,
    );
    const validatedFingerprint = assertDestinationFingerprint(query.expectedFingerprint);
    const validatedOrganizationId = organizationIdSchema.parse(organizationId);
    parametersValidated = true;

    const rows = await transaction.query<SqlReadinessRow>`
      select vortex_connection.resolve_connection_instance_readiness(
        ${validatedOrganizationId},
        ${validatedAppId},
        ${validatedConnId},
        ${validatedDestKey},
        ${validatedRevision},
        ${validatedFingerprint}
      ) as readiness_result
    `;

    if (rows.length !== 1 || !rows[0]?.readiness_result) {
      return Object.freeze({
        outcome: "refused",
        reasonCode: "connection_unavailable",
        message: `Connection instance ${validatedConnId} readiness resolution returned no result`,
      });
    }

    const raw = rows[0].readiness_result as Record<string, unknown>;
    const outcome = String(raw.outcome);

    if (outcome === "ready") {
      const connId = connectionInstanceIdSchema.parse(raw.connectionInstanceId);
      const orgId = organizationIdSchema.parse(raw.organizationId);
      const appId = applicationRootIdSchema.parse(raw.applicationRootId);
      const destKey = archiveDestinationReferenceSchema.parse(raw.destinationKey);
      if (typeof raw.destinationFingerprint !== "string") {
        throw new ConnectionReadinessError(
          "database_error",
          "SQL readiness result destination fingerprint is not a string",
        );
      }
      const destFp = assertDestinationFingerprint(raw.destinationFingerprint);
      const rev = assertSafeIntegerRevision(raw.revision, "SQL readiness revision");
      const healthOutcome = raw.healthOutcome;
      const state = raw.state;
      const verifiedAt = timestampSchema.parse(raw.verifiedAt);
      assertFiniteTokenExpiry(raw.tokenExpiresAt);

      if (
        !sameIdentifier(connId, validatedConnId) ||
        !sameIdentifier(orgId, validatedOrganizationId) ||
        !sameIdentifier(appId, validatedAppId) ||
        destKey !== validatedDestKey ||
        destFp !== validatedFingerprint ||
        rev !== validatedRevision
      ) {
        throw new ConnectionReadinessError(
          "database_error",
          "SQL readiness result does not match the exact requested connection proof",
        );
      }

      if (healthOutcome !== "healthy") {
        throw new ConnectionReadinessError(
          "database_error",
          `SQL readiness result has invalid health outcome: ${String(healthOutcome)}`,
        );
      }

      if (state !== "active") {
        throw new ConnectionReadinessError(
          "database_error",
          `SQL readiness result has invalid state: ${String(state)}`,
        );
      }

      return Object.freeze({
        outcome: "ready",
        connectionInstanceId: connId,
        organizationId: orgId,
        applicationRootId: appId,
        destinationKey: destKey,
        destinationFingerprint: destFp,
        revision: rev,
        healthOutcome,
        state,
        verifiedAt,
      });
    }

    const reasonCode = asConnectionReadinessRefusalCode(raw.reasonCode);
    return Object.freeze({
      outcome: "refused",
      reasonCode,
      message: `Connection readiness refused: ${reasonCode}`,
      ...(raw.currentState ? { currentState: String(raw.currentState) } : {}),
      ...(raw.currentHealthOutcome
        ? { currentHealthOutcome: String(raw.currentHealthOutcome) }
        : {}),
      ...(raw.currentRevision !== undefined && raw.currentRevision !== null
        ? { currentRevision: Number(raw.currentRevision) }
        : {}),
    });
  } catch (error) {
    if (!parametersValidated && isValidationError(error)) {
      return Object.freeze({
        outcome: "refused",
        reasonCode: "invalid_parameters",
        message: "Connection readiness parameters are invalid",
      });
    }
    return Object.freeze({
      outcome: "refused",
      reasonCode: "database_error",
      message: "Connection readiness is unavailable",
    });
  }
}

/**
 * Reads active healthy Connection instance evidence from the database for a given
 * connection instance identity within the active request context.
 *
 * Returns canonical `ActiveConnectionEvidence` matching activeConnectionEvidenceSchema.
 * Fails closed if the connection is missing, inactive, unhealthy, expired, or has no grants.
 */
export async function readActiveConnectionEvidence(
  transaction: RequestDatabaseTransaction,
  connectionInstanceId: ConnectionInstanceId,
): Promise<ActiveConnectionEvidence> {
  const validatedConnId = connectionInstanceIdSchema.parse(connectionInstanceId);

  const rows = await transaction.query<SqlEvidenceRow>`
    select
      connection_instance_id,
      destination_key,
      destination_fingerprint,
      organization_id,
      authorized_application_ids,
      state,
      revision,
      last_health_outcome
    from vortex_connection.read_active_connection_evidence(${validatedConnId})
  `;

  if (rows.length !== 1 || !rows[0]) {
    throw new ConnectionReadinessError(
      "connection_unavailable",
      `Active healthy connection instance ${validatedConnId} is unavailable in current organization`,
    );
  }

  const row = rows[0];
  const connId = connectionInstanceIdSchema.parse(row.connection_instance_id);
  const destKey = archiveDestinationReferenceSchema.parse(row.destination_key);
  const orgId = organizationIdSchema.parse(row.organization_id);
  const state = String(row.state);
  const healthOutcome = String(row.last_health_outcome);

  if (state !== "active") {
    throw new ConnectionReadinessError(
      "connection_not_active",
      `Connection instance ${connId} is in state "${state}", expected "active"`,
    );
  }

  if (healthOutcome !== "healthy") {
    throw new ConnectionReadinessError(
      "connection_unhealthy",
      `Connection instance ${connId} has health outcome "${healthOutcome}", expected "healthy"`,
    );
  }

  const revision = assertSafeIntegerRevision(row.revision, `Connection instance ${connId}`);
  const destinationFingerprint = assertDestinationFingerprint(String(row.destination_fingerprint));

  const rawAppIds = Array.isArray(row.authorized_application_ids)
    ? row.authorized_application_ids
    : [];
  if (rawAppIds.length === 0) {
    throw new ConnectionReadinessError(
      "application_scope_required",
      `Connection instance ${connId} has no authorized applications`,
    );
  }

  const authorizedAppIds = rawAppIds.map((id) => applicationRootIdSchema.parse(id));

  return activeConnectionEvidenceSchema.parse({
    connectionInstanceId: connId,
    destinationKey: destKey,
    destinationFingerprint,
    organizationId: orgId,
    authorizedApplicationIds: authorizedAppIds,
    state: "active",
    revision,
    lastHealthOutcome: "healthy",
  });
}
