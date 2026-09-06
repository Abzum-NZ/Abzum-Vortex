import "server-only";

import {
  organizationRoleActivationChangeCommandSchema,
  organizationRoleActivationChangeResultSchema,
  type OrganizationRoleActivationChangeCommand,
  type OrganizationRoleActivationChangeResult,
  type RoleActivation,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

export const organizationRoleActivationChangeHandoffErrorCodes = [
  "INVALID_ORGANIZATION_ROLE_ACTIVATION_CHANGE_COMMAND",
  "INVALID_ORGANIZATION_ROLE_ACTIVATION_CHANGE_STORAGE_RESULT",
  "ORGANIZATION_ROLE_ACTIVATION_CHANGE_SCOPE_UNAVAILABLE",
  "ORGANIZATION_ROLE_ACTIVATION_CHANGE_STALE_OR_UNAVAILABLE",
  "ORGANIZATION_ROLE_ACTIVATION_CHANGE_VERSION_EXHAUSTED",
  "ORGANIZATION_ROLE_ACTIVATION_CHANGE_FAILED",
] as const;

export type OrganizationRoleActivationChangeHandoffErrorCode =
  (typeof organizationRoleActivationChangeHandoffErrorCodes)[number];

export class OrganizationRoleActivationChangeHandoffError extends Error {
  readonly code: OrganizationRoleActivationChangeHandoffErrorCode;

  constructor(code: OrganizationRoleActivationChangeHandoffErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationRoleActivationChangeHandoffError";
    this.code = code;
  }
}

export interface OrganizationRoleActivationChangeOwnerHandoff {
  change(
    command: OrganizationRoleActivationChangeCommand,
  ): Promise<OrganizationRoleActivationChangeResult>;
}

type ChangeRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  activation: unknown;
  access_version: unknown;
  correlation_id: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};
const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const invalidStorage = (): never => {
  throw new OrganizationRoleActivationChangeHandoffError(
    "INVALID_ORGANIZATION_ROLE_ACTIVATION_CHANGE_STORAGE_RESULT",
  );
};

const sameEligibilitySource = (
  activation: RoleActivation,
  command: Extract<OrganizationRoleActivationChangeCommand, { operation: "activate_role" }>,
): boolean => {
  const actual = activation.eligibilitySource;
  const expected = command.eligibilitySource;
  if (
    actual.kind !== expected.kind ||
    !sameUuid(
      actual.eligibilityAssignment.roleAssignmentId,
      expected.eligibilityAssignment.roleAssignmentId,
    ) ||
    actual.eligibilityAssignment.revision !== expected.eligibilityAssignment.revision
  )
    return false;
  if (actual.kind === "direct" || expected.kind === "direct") return actual.kind === expected.kind;
  return (
    sameUuid(
      actual.originatingMembership.membershipId,
      expected.originatingMembership.membershipId,
    ) && actual.originatingMembership.revision === expected.originatingMembership.revision
  );
};

const parseResult = (
  rows: readonly ChangeRow[],
  command: OrganizationRoleActivationChangeCommand,
): OrganizationRoleActivationChangeResult => {
  if (rows.length !== 1 || rows[0] === undefined) return invalidStorage();
  const row = rows[0];
  const parsed = organizationRoleActivationChangeResultSchema.safeParse({
    outcome: row.outcome,
    operation: row.operation,
    activation: row.activation,
    accessVersion: revision(row.access_version),
    correlationId: row.correlation_id,
  });
  if (!parsed.success) return invalidStorage();

  const activation = parsed.data.activation;
  if (
    parsed.data.operation !== command.operation ||
    !sameUuid(parsed.data.correlationId, command.correlationId) ||
    !sameUuid(activation.organizationId, command.organizationId) ||
    !sameUuid(activation.roleActivationId, command.roleActivationId) ||
    !sameUuid(activation.changedByActorId, command.changedBy) ||
    !sameUuid(activation.changeCorrelationId, command.correlationId)
  )
    return invalidStorage();

  if (command.operation === "activate_role") {
    const durationSeconds =
      (Date.parse(activation.expiresAt) - Date.parse(activation.activatedAt)) / 1000;
    if (
      !sameUuid(activation.organizationAccountId, command.organizationAccountId) ||
      !sameUuid(activation.roleId, command.roleId) ||
      activation.historicalRoleRevision !== command.expectedRoleRevision ||
      !sameEligibilitySource(activation, command) ||
      activation.revision !== 1 ||
      activation.state !== "live" ||
      !sameUuid(activation.activatedByActorId, command.changedBy) ||
      !sameUuid(activation.activationCorrelationId, command.correlationId) ||
      !(durationSeconds > 0 && durationSeconds <= command.requestedDurationSeconds)
    )
      return invalidStorage();
    return parsed.data;
  }

  if (
    activation.revision !== command.expectedActivationRevision + 1 ||
    activation.state !== "revoked" ||
    activation.revokedByActorId === undefined ||
    !sameUuid(activation.revokedByActorId, command.changedBy) ||
    activation.revocationCorrelationId === undefined ||
    !sameUuid(activation.revocationCorrelationId, command.correlationId)
  )
    return invalidStorage();
  return parsed.data;
};

const mapStorageFailure = (error: unknown): OrganizationRoleActivationChangeHandoffError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (databaseCode === "22023")
    return new OrganizationRoleActivationChangeHandoffError(
      "INVALID_ORGANIZATION_ROLE_ACTIVATION_CHANGE_COMMAND",
    );
  if (databaseCode === "42501")
    return new OrganizationRoleActivationChangeHandoffError(
      "ORGANIZATION_ROLE_ACTIVATION_CHANGE_SCOPE_UNAVAILABLE",
    );
  if (databaseCode === "22003")
    return new OrganizationRoleActivationChangeHandoffError(
      "ORGANIZATION_ROLE_ACTIVATION_CHANGE_VERSION_EXHAUSTED",
    );
  if (["23503", "23505", "23514", "40001", "55000"].includes(databaseCode ?? ""))
    return new OrganizationRoleActivationChangeHandoffError(
      "ORGANIZATION_ROLE_ACTIVATION_CHANGE_STALE_OR_UNAVAILABLE",
    );
  return new OrganizationRoleActivationChangeHandoffError(
    "ORGANIZATION_ROLE_ACTIVATION_CHANGE_FAILED",
  );
};

/**
 * Contract/result-binding proof for the owner-only activation composition. It
 * is not executable by a current runtime/request transaction. #40 must add
 * caller, beneficiary, authentication and approval checks before exposure.
 */
export const createOrganizationRoleActivationChangeOwnerHandoff = (
  transaction: RequestDatabaseTransaction,
): OrganizationRoleActivationChangeOwnerHandoff =>
  Object.freeze({
    async change(commandCandidate: OrganizationRoleActivationChangeCommand) {
      const command = organizationRoleActivationChangeCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new OrganizationRoleActivationChangeHandoffError(
          "INVALID_ORGANIZATION_ROLE_ACTIVATION_CHANGE_COMMAND",
        );

      const activate = command.data.operation === "activate_role" ? command.data : undefined;
      const group = activate?.eligibilitySource.kind === "group" ? activate : undefined;
      try {
        const rows = await transaction.query<ChangeRow>`
          select *
          from vortex_access.coordinate_organization_role_activation_change(
            ${command.data.operation}::text,
            ${command.data.organizationId}::uuid,
            ${command.data.roleActivationId}::uuid,
            ${command.data.operation === "revoke_role_activation" ? command.data.expectedActivationRevision : null}::bigint,
            ${activate?.organizationAccountId ?? null}::uuid,
            ${activate?.roleId ?? null}::uuid,
            ${activate?.expectedRoleRevision ?? null}::bigint,
            ${activate?.requestedDurationSeconds ?? null}::bigint,
            ${activate?.eligibilitySource.kind ?? null}::text,
            ${activate?.eligibilitySource.eligibilityAssignment.roleAssignmentId ?? null}::uuid,
            ${activate?.eligibilitySource.eligibilityAssignment.revision ?? null}::bigint,
            ${group?.eligibilitySource.originatingMembership.membershipId ?? null}::uuid,
            ${group?.eligibilitySource.originatingMembership.revision ?? null}::bigint,
            ${command.data.changedBy}::uuid,
            ${command.data.correlationId}::uuid
          )
        `;
        return parseResult(rows, command.data);
      } catch (error) {
        if (error instanceof OrganizationRoleActivationChangeHandoffError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
