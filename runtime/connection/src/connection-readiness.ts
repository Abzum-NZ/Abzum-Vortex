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
  connectionHealthOutcomeValues,
  connectionStateValues,
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

const connectionStateSet: ReadonlySet<string> = new Set<string>(connectionStateValues);
const connectionHealthOutcomeSet: ReadonlySet<string> = new Set<string>(
  connectionHealthOutcomeValues,
);

const knownValue = (value: unknown, allowed: ReadonlySet<string>): string | undefined =>
  typeof value === "string" && allowed.has(value) ? value : undefined;

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
    if (query === null || typeof query !== "object") {
      throw new ConnectionInstanceStateError("CONNECTION_INVALID_STATE", "Readiness query is invalid");
    }
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
    const outcome = raw.outcome;
    if (outcome !== "ready" && outcome !== "refused") {
      throw new ConnectionReadinessError("database_error", "SQL readiness outcome is invalid");
    }

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
      const verifiedAtInstant = Date.parse(verifiedAt);
      if (!Number.isFinite(verifiedAtInstant)) {
        throw new ConnectionReadinessError("database_error", "SQL readiness timestamp is unreadable");
      }
      const tokenExpiry = assertFiniteTokenExpiry(raw.tokenExpiresAt);
      if (tokenExpiry !== null && tokenExpiry.getTime() <= verifiedAtInstant) {
        throw new ConnectionReadinessError(
          "connection_token_expired",
          "SQL readiness result includes an expired token",
        );
      }

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
    const currentState = knownValue(raw.currentState, connectionStateSet);
    const currentHealthOutcome = knownValue(
      raw.currentHealthOutcome,
      connectionHealthOutcomeSet,
    );
    const currentRevision =
      raw.currentRevision === undefined || raw.currentRevision === null
        ? undefined
        : assertSafeIntegerRevision(raw.currentRevision, "SQL readiness current revision");
    return Object.freeze({
      outcome: "refused",
      reasonCode,
      message: `Connection readiness refused: ${reasonCode}`,
      ...(currentState === undefined ? {} : { currentState }),
      ...(currentHealthOutcome === undefined ? {} : { currentHealthOutcome }),
      ...(currentRevision === undefined ? {} : { currentRevision }),
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
  try {
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
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined) {
      throw new ConnectionReadinessError("connection_unavailable", "Active connection evidence is unavailable");
    }

    const evidence = activeConnectionEvidenceSchema.parse({
      connectionInstanceId: row.connection_instance_id,
      destinationKey: row.destination_key,
      destinationFingerprint: row.destination_fingerprint,
      organizationId: row.organization_id,
      authorizedApplicationIds: row.authorized_application_ids,
      state: row.state,
      revision: assertSafeIntegerRevision(row.revision, "Active connection evidence"),
      lastHealthOutcome: row.last_health_outcome,
    });
    if (!sameIdentifier(evidence.connectionInstanceId, validatedConnId)) {
      throw new ConnectionReadinessError("connection_unavailable", "Active connection evidence is unavailable");
    }
    return evidence;
  } catch {
    throw new ConnectionReadinessError("connection_unavailable", "Active connection evidence is unavailable");
  }
}
