import "server-only";

import {
  organizationGroupMembershipChangeCommandSchema,
  organizationGroupMembershipChangeResultSchema,
  type GroupMembership,
  type OrganizationGroupMembershipChangeCommand,
  type OrganizationGroupMembershipChangeResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

export const organizationGroupMembershipChangeHandoffErrorCodes = [
  "INVALID_ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_COMMAND",
  "INVALID_ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STORAGE_RESULT",
  "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_SCOPE_UNAVAILABLE",
  "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STALE_OR_UNAVAILABLE",
  "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_VERSION_EXHAUSTED",
  "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_FAILED",
] as const;

export type OrganizationGroupMembershipChangeHandoffErrorCode =
  (typeof organizationGroupMembershipChangeHandoffErrorCodes)[number];

export class OrganizationGroupMembershipChangeHandoffError extends Error {
  readonly code: OrganizationGroupMembershipChangeHandoffErrorCode;

  constructor(code: OrganizationGroupMembershipChangeHandoffErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationGroupMembershipChangeHandoffError";
    this.code = code;
  }
}

export interface OrganizationGroupMembershipChangeOwnerHandoff {
  change(
    command: OrganizationGroupMembershipChangeCommand,
  ): Promise<OrganizationGroupMembershipChangeResult>;
}

type ChangeRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  membership: unknown;
  closed_predecessor: unknown;
  access_version: unknown;
  correlation_id: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};
const normalizedUuid = (value: string): string => value.toLowerCase();
const sameUuid = (left: string, right: string): boolean =>
  normalizedUuid(left) === normalizedUuid(right);
const sameTimestamp = (left: string, right: string): boolean =>
  Date.parse(left) === Date.parse(right);
const sameOptionalTimestamp = (left: string | undefined, right: string | undefined): boolean =>
  left === undefined ? right === undefined : right !== undefined && sameTimestamp(left, right);

const invalidStorage = (): never => {
  throw new OrganizationGroupMembershipChangeHandoffError(
    "INVALID_ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STORAGE_RESULT",
  );
};

const hasExactChangeEvidence = (
  membership: GroupMembership,
  command: OrganizationGroupMembershipChangeCommand,
): boolean =>
  sameUuid(membership.organizationId, command.organizationId) &&
  sameUuid(membership.changedByActorId, command.changedBy) &&
  sameUuid(membership.changeCorrelationId, command.correlationId);

const parseResult = (
  rows: readonly ChangeRow[],
  command: OrganizationGroupMembershipChangeCommand,
): OrganizationGroupMembershipChangeResult => {
  if (rows.length !== 1 || rows[0] === undefined) return invalidStorage();
  const row = rows[0];
  const parsed = organizationGroupMembershipChangeResultSchema.safeParse({
    outcome: row.outcome,
    operation: row.operation,
    membership: row.membership,
    ...(row.closed_predecessor === null || row.closed_predecessor === undefined
      ? {}
      : { closedPredecessor: row.closed_predecessor }),
    accessVersion: revision(row.access_version),
    correlationId: row.correlation_id,
  });
  if (!parsed.success) return invalidStorage();

  const membership = parsed.data.membership;
  if (
    parsed.data.operation !== command.operation ||
    !hasExactChangeEvidence(membership, command) ||
    !sameUuid(parsed.data.correlationId, command.correlationId)
  )
    return invalidStorage();

  if (command.operation === "add_membership") {
    if (
      !sameUuid(membership.membershipId, command.membershipId) ||
      !sameUuid(membership.groupId, command.groupId) ||
      !sameUuid(membership.organizationAccountId, command.organizationAccountId) ||
      membership.revision !== 1 ||
      membership.state !== "live" ||
      !sameTimestamp(membership.startsAt, command.startsAt) ||
      !sameOptionalTimestamp(membership.expiresAt, command.expiresAt) ||
      !sameUuid(membership.grantedByActorId, command.changedBy) ||
      !sameUuid(membership.grantCorrelationId, command.correlationId)
    )
      return invalidStorage();
    return parsed.data;
  }

  if (command.operation === "remove_membership") {
    if (
      !sameUuid(membership.membershipId, command.membershipId) ||
      membership.revision !== command.expectedMembershipRevision + 1 ||
      membership.state !== "revoked" ||
      membership.revokedByActorId === undefined ||
      !sameUuid(membership.revokedByActorId, command.changedBy) ||
      membership.revocationCorrelationId === undefined ||
      !sameUuid(membership.revocationCorrelationId, command.correlationId)
    )
      return invalidStorage();
    return parsed.data;
  }

  if (command.operation === "restore_membership") {
    if (
      !sameUuid(membership.membershipId, command.membershipId) ||
      membership.revision !== command.expectedMembershipRevision + 1 ||
      membership.state !== "live" ||
      membership.revokedByActorId !== undefined ||
      membership.revokedAt !== undefined ||
      membership.revocationCorrelationId !== undefined
    )
      return invalidStorage();
    return parsed.data;
  }

  const predecessor = parsed.data.closedPredecessor;
  if (
    !sameUuid(membership.membershipId, command.replacementMembershipId) ||
    membership.revision !== 1 ||
    membership.state !== "live" ||
    !sameTimestamp(membership.startsAt, command.startsAt) ||
    !sameOptionalTimestamp(membership.expiresAt, command.expiresAt) ||
    !sameUuid(membership.grantedByActorId, command.changedBy) ||
    !sameUuid(membership.grantCorrelationId, command.correlationId) ||
    !sameUuid(predecessor.membershipId, command.membershipId) ||
    predecessor.revision !== command.expectedMembershipRevision + 1 ||
    predecessor.state !== "revoked" ||
    !sameUuid(predecessor.organizationId, command.organizationId) ||
    !sameUuid(predecessor.groupId, membership.groupId) ||
    !sameUuid(predecessor.organizationAccountId, membership.organizationAccountId) ||
    !sameUuid(predecessor.changedByActorId, command.changedBy) ||
    !sameUuid(predecessor.changeCorrelationId, command.correlationId) ||
    predecessor.revokedByActorId === undefined ||
    !sameUuid(predecessor.revokedByActorId, command.changedBy) ||
    predecessor.revocationCorrelationId === undefined ||
    !sameUuid(predecessor.revocationCorrelationId, command.correlationId)
  )
    return invalidStorage();
  return parsed.data;
};

const mapStorageFailure = (error: unknown): OrganizationGroupMembershipChangeHandoffError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (databaseCode === "22023")
    return new OrganizationGroupMembershipChangeHandoffError(
      "INVALID_ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_COMMAND",
    );
  if (databaseCode === "42501")
    return new OrganizationGroupMembershipChangeHandoffError(
      "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_SCOPE_UNAVAILABLE",
    );
  if (databaseCode === "22003")
    return new OrganizationGroupMembershipChangeHandoffError(
      "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_VERSION_EXHAUSTED",
    );
  if (["23503", "23505", "23514", "40001", "55000"].includes(databaseCode ?? ""))
    return new OrganizationGroupMembershipChangeHandoffError(
      "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STALE_OR_UNAVAILABLE",
    );
  return new OrganizationGroupMembershipChangeHandoffError(
    "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_FAILED",
  );
};

/**
 * Contract/result-binding proof for the owner-only membership composition. It
 * is not executable by a current runtime/request transaction. D/#40 must add
 * stewardship and caller authority before a shipping adapter exists.
 */
export const createOrganizationGroupMembershipChangeOwnerHandoff = (
  transaction: RequestDatabaseTransaction,
): OrganizationGroupMembershipChangeOwnerHandoff =>
  Object.freeze({
    async change(commandCandidate: OrganizationGroupMembershipChangeCommand) {
      const command = organizationGroupMembershipChangeCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new OrganizationGroupMembershipChangeHandoffError(
          "INVALID_ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_COMMAND",
        );

      const add = command.data.operation === "add_membership" ? command.data : undefined;
      const renew = command.data.operation === "renew_membership" ? command.data : undefined;
      const expected =
        command.data.operation === "add_membership"
          ? null
          : command.data.expectedMembershipRevision;
      try {
        const rows = await transaction.query<ChangeRow>`
          select *
          from vortex_access.coordinate_organization_group_membership_change(
            ${command.data.operation}::text,
            ${command.data.organizationId}::uuid,
            ${command.data.membershipId}::uuid,
            ${expected}::bigint,
            ${add?.groupId ?? null}::uuid,
            ${add?.organizationAccountId ?? null}::uuid,
            ${add?.startsAt ?? renew?.startsAt ?? null}::timestamptz,
            ${add?.expiresAt ?? renew?.expiresAt ?? null}::timestamptz,
            ${renew?.replacementMembershipId ?? null}::uuid,
            ${command.data.changedBy}::uuid,
            ${command.data.correlationId}::uuid
          )
        `;
        return parseResult(rows, command.data);
      } catch (error) {
        if (error instanceof OrganizationGroupMembershipChangeHandoffError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
