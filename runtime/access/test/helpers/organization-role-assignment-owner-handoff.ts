import "server-only";

import {
  organizationRoleAssignmentChangeCommandSchema,
  organizationRoleAssignmentChangeResultSchema,
  type OrganizationRoleAssignmentChangeCommand,
  type OrganizationRoleAssignmentChangeResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

export const organizationRoleAssignmentHandoffErrorCodes = [
  "INVALID_ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_COMMAND",
  "INVALID_ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STORAGE_RESULT",
  "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_SCOPE_UNAVAILABLE",
  "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STALE_OR_UNAVAILABLE",
  "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_VERSION_EXHAUSTED",
  "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_FAILED",
] as const;

export type OrganizationRoleAssignmentHandoffErrorCode =
  (typeof organizationRoleAssignmentHandoffErrorCodes)[number];

export class OrganizationRoleAssignmentHandoffError extends Error {
  readonly code: OrganizationRoleAssignmentHandoffErrorCode;

  constructor(code: OrganizationRoleAssignmentHandoffErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationRoleAssignmentHandoffError";
    this.code = code;
  }
}

export interface OrganizationRoleAssignmentOwnerHandoff {
  change(
    command: OrganizationRoleAssignmentChangeCommand,
  ): Promise<OrganizationRoleAssignmentChangeResult>;
}

type ChangeRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  organization_id: unknown;
  role_assignment_id: unknown;
  role_id: unknown;
  assignee_kind: unknown;
  organization_account_id: unknown;
  group_id: unknown;
  assignment_kind: unknown;
  revision: unknown;
  starts_at: unknown;
  expires_at: unknown;
  state: unknown;
  granted_by_actor_id: unknown;
  granted_at: unknown;
  grant_correlation_id: unknown;
  changed_by_actor_id: unknown;
  changed_at: unknown;
  change_correlation_id: unknown;
  revoked_by_actor_id: unknown;
  revoked_at: unknown;
  revocation_correlation_id: unknown;
  access_version: unknown;
  correlation_id: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const timestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;
const optional = (value: unknown): unknown => (value === null ? undefined : value);
const optionalTimestamp = (value: unknown): unknown => optional(timestamp(value));
const sameTimestamp = (left: string, right: string): boolean =>
  Date.parse(left) === Date.parse(right);
const sameOptionalTimestamp = (left: string | undefined, right: string | undefined): boolean =>
  left === undefined ? right === undefined : right !== undefined && sameTimestamp(left, right);

const invalidStorage = (): never => {
  throw new OrganizationRoleAssignmentHandoffError(
    "INVALID_ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STORAGE_RESULT",
  );
};

const assignee = (row: ChangeRow): unknown => {
  if (
    row.assignee_kind === "organization_account" &&
    (row.group_id === null || row.group_id === undefined)
  )
    return {
      kind: "organization_account",
      organizationAccountId: row.organization_account_id,
    };
  if (
    row.assignee_kind === "group" &&
    (row.organization_account_id === null || row.organization_account_id === undefined)
  )
    return { kind: "group", groupId: row.group_id };
  return { kind: row.assignee_kind };
};

const parseResult = (
  rows: readonly ChangeRow[],
  command: OrganizationRoleAssignmentChangeCommand,
): OrganizationRoleAssignmentChangeResult => {
  if (rows.length !== 1 || rows[0] === undefined) return invalidStorage();
  const row = rows[0];
  const parsed = organizationRoleAssignmentChangeResultSchema.safeParse({
    outcome: row.outcome,
    operation: row.operation,
    assignment: {
      roleAssignmentId: row.role_assignment_id,
      organizationId: row.organization_id,
      roleId: row.role_id,
      assignee: assignee(row),
      assignmentKind: row.assignment_kind,
      revision: revision(row.revision),
      startsAt: timestamp(row.starts_at),
      expiresAt: optionalTimestamp(row.expires_at),
      state: row.state,
      grantedByActorId: row.granted_by_actor_id,
      grantedAt: timestamp(row.granted_at),
      grantCorrelationId: row.grant_correlation_id,
      changedByActorId: row.changed_by_actor_id,
      changedAt: timestamp(row.changed_at),
      changeCorrelationId: row.change_correlation_id,
      revokedByActorId: optional(row.revoked_by_actor_id),
      revokedAt: optionalTimestamp(row.revoked_at),
      revocationCorrelationId: optional(row.revocation_correlation_id),
    },
    accessVersion: revision(row.access_version),
    correlationId: row.correlation_id,
  });
  if (!parsed.success) return invalidStorage();

  const expectedRevision =
    command.operation === "grant" ? 1 : command.expectedAssignmentRevision + 1;
  if (
    parsed.data.operation !== command.operation ||
    parsed.data.assignment.organizationId !== command.organizationId ||
    parsed.data.assignment.roleAssignmentId !== command.roleAssignmentId ||
    parsed.data.assignment.revision !== expectedRevision ||
    parsed.data.correlationId !== command.correlationId ||
    parsed.data.assignment.changedByActorId !== command.changedBy ||
    parsed.data.assignment.changeCorrelationId !== command.correlationId ||
    (command.operation === "grant" &&
      (parsed.data.assignment.roleId !== command.roleId ||
        parsed.data.assignment.assignmentKind !== command.assignmentKind ||
        !sameTimestamp(parsed.data.assignment.startsAt, command.startsAt) ||
        !sameOptionalTimestamp(parsed.data.assignment.expiresAt, command.expiresAt) ||
        JSON.stringify(parsed.data.assignment.assignee) !== JSON.stringify(command.assignee) ||
        parsed.data.assignment.state !== "live" ||
        parsed.data.assignment.grantedByActorId !== command.changedBy ||
        parsed.data.assignment.grantCorrelationId !== command.correlationId ||
        parsed.data.assignment.revokedAt !== undefined)) ||
    (command.operation === "revoke" &&
      (parsed.data.assignment.state !== "revoked" ||
        parsed.data.assignment.revokedByActorId !== command.changedBy ||
        parsed.data.assignment.revocationCorrelationId !== command.correlationId))
  )
    return invalidStorage();

  return parsed.data;
};

const mapStorageFailure = (error: unknown): OrganizationRoleAssignmentHandoffError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (databaseCode === "22023")
    return new OrganizationRoleAssignmentHandoffError(
      "INVALID_ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_COMMAND",
    );
  if (databaseCode === "42501")
    return new OrganizationRoleAssignmentHandoffError(
      "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_SCOPE_UNAVAILABLE",
    );
  if (databaseCode === "22003")
    return new OrganizationRoleAssignmentHandoffError(
      "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_VERSION_EXHAUSTED",
    );
  if (["23503", "23505", "23514", "40001", "55000"].includes(databaseCode ?? ""))
    return new OrganizationRoleAssignmentHandoffError(
      "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STALE_OR_UNAVAILABLE",
    );
  return new OrganizationRoleAssignmentHandoffError("ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_FAILED");
};

/**
 * Contract/result-binding proof for the owner-only assignment composition. It is
 * not executable by a current runtime/request transaction. D/#40 must supply the
 * stewardship and caller-authority wrapper before a shipping adapter exists.
 */
export const createOrganizationRoleAssignmentOwnerHandoff = (
  transaction: RequestDatabaseTransaction,
): OrganizationRoleAssignmentOwnerHandoff =>
  Object.freeze({
    async change(commandCandidate: OrganizationRoleAssignmentChangeCommand) {
      const command = organizationRoleAssignmentChangeCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new OrganizationRoleAssignmentHandoffError(
          "INVALID_ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_COMMAND",
        );

      const grant = command.data.operation === "grant" ? command.data : undefined;
      const revoke = command.data.operation === "revoke" ? command.data : undefined;
      try {
        const rows = await transaction.query<ChangeRow>`
          select *
          from vortex_access.coordinate_organization_role_assignment_change(
            ${command.data.operation}::text,
            ${command.data.organizationId}::uuid,
            ${command.data.roleAssignmentId}::uuid,
            ${revoke?.expectedAssignmentRevision ?? null}::bigint,
            ${grant?.roleId ?? null}::uuid,
            ${grant?.expectedRoleRevision ?? null}::bigint,
            ${grant?.assignee.kind ?? null}::text,
            ${grant?.assignee.kind === "organization_account" ? grant.assignee.organizationAccountId : null}::uuid,
            ${grant?.assignee.kind === "group" ? grant.assignee.groupId : null}::uuid,
            ${grant?.assignmentKind ?? null}::text,
            ${grant?.startsAt ?? null}::timestamptz,
            ${grant?.expiresAt ?? null}::timestamptz,
            ${command.data.changedBy}::uuid,
            ${command.data.correlationId}::uuid
          )
        `;
        return parseResult(rows, command.data);
      } catch (error) {
        if (error instanceof OrganizationRoleAssignmentHandoffError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
