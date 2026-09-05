import "server-only";

import {
  organizationGroupChangeCommandSchema,
  organizationGroupChangeResultSchema,
  type OrganizationGroupChangeCommand,
  type OrganizationGroupChangeResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

export const organizationGroupChangeHandoffErrorCodes = [
  "INVALID_ORGANIZATION_GROUP_CHANGE_COMMAND",
  "INVALID_ORGANIZATION_GROUP_CHANGE_STORAGE_RESULT",
  "ORGANIZATION_GROUP_CHANGE_SCOPE_UNAVAILABLE",
  "ORGANIZATION_GROUP_CHANGE_STALE_OR_UNAVAILABLE",
  "ORGANIZATION_GROUP_CHANGE_VERSION_EXHAUSTED",
  "ORGANIZATION_GROUP_CHANGE_FAILED",
] as const;

export type OrganizationGroupChangeHandoffErrorCode =
  (typeof organizationGroupChangeHandoffErrorCodes)[number];

export class OrganizationGroupChangeHandoffError extends Error {
  readonly code: OrganizationGroupChangeHandoffErrorCode;

  constructor(code: OrganizationGroupChangeHandoffErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationGroupChangeHandoffError";
    this.code = code;
  }
}

export interface OrganizationGroupChangeOwnerHandoff {
  change(command: OrganizationGroupChangeCommand): Promise<OrganizationGroupChangeResult>;
}

type ChangeRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  organization_id: unknown;
  group_id: unknown;
  group_key: unknown;
  label: unknown;
  state: unknown;
  revision: unknown;
  created_by_actor_id: unknown;
  created_at: unknown;
  changed_by_actor_id: unknown;
  changed_at: unknown;
  change_correlation_id: unknown;
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
const normalizedUuid = (value: string): string => value.toLowerCase();
const sameUuid = (left: string, right: string): boolean =>
  normalizedUuid(left) === normalizedUuid(right);

const invalidStorage = (): never => {
  throw new OrganizationGroupChangeHandoffError("INVALID_ORGANIZATION_GROUP_CHANGE_STORAGE_RESULT");
};

const parseResult = (
  rows: readonly ChangeRow[],
  command: OrganizationGroupChangeCommand,
): OrganizationGroupChangeResult => {
  if (rows.length !== 1 || rows[0] === undefined) return invalidStorage();
  const row = rows[0];
  const parsed = organizationGroupChangeResultSchema.safeParse({
    outcome: row.outcome,
    operation: row.operation,
    group: {
      organizationId: row.organization_id,
      groupId: row.group_id,
      key: row.group_key,
      label: row.label,
      state: row.state,
      revision: revision(row.revision),
      createdByActorId: row.created_by_actor_id,
      createdAt: timestamp(row.created_at),
      changedByActorId: row.changed_by_actor_id,
      changedAt: timestamp(row.changed_at),
      changeCorrelationId: row.change_correlation_id,
    },
    accessVersion: revision(row.access_version),
    correlationId: row.correlation_id,
  });
  if (!parsed.success) return invalidStorage();

  const expectedRevision =
    command.operation === "create_group" ? 1 : command.expectedGroupRevision + 1;
  if (
    parsed.data.operation !== command.operation ||
    !sameUuid(parsed.data.group.organizationId, command.organizationId) ||
    !sameUuid(parsed.data.group.groupId, command.groupId) ||
    parsed.data.group.revision !== expectedRevision ||
    !sameUuid(parsed.data.group.changedByActorId, command.changedBy) ||
    !sameUuid(parsed.data.group.changeCorrelationId, command.correlationId) ||
    !sameUuid(parsed.data.correlationId, command.correlationId) ||
    (command.operation === "create_group" &&
      (parsed.data.group.key !== command.key ||
        parsed.data.group.label !== command.label ||
        parsed.data.group.state !== "active" ||
        !sameUuid(parsed.data.group.createdByActorId, command.changedBy))) ||
    (command.operation === "revise_group_label" &&
      (parsed.data.group.label !== command.label || parsed.data.group.state !== "active")) ||
    (command.operation === "retire_group" && parsed.data.group.state !== "retired")
  )
    return invalidStorage();

  return parsed.data;
};

const mapStorageFailure = (error: unknown): OrganizationGroupChangeHandoffError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (databaseCode === "22023")
    return new OrganizationGroupChangeHandoffError("INVALID_ORGANIZATION_GROUP_CHANGE_COMMAND");
  if (databaseCode === "42501")
    return new OrganizationGroupChangeHandoffError("ORGANIZATION_GROUP_CHANGE_SCOPE_UNAVAILABLE");
  if (databaseCode === "22003")
    return new OrganizationGroupChangeHandoffError("ORGANIZATION_GROUP_CHANGE_VERSION_EXHAUSTED");
  if (["23503", "23505", "23514", "40001", "55000"].includes(databaseCode ?? ""))
    return new OrganizationGroupChangeHandoffError(
      "ORGANIZATION_GROUP_CHANGE_STALE_OR_UNAVAILABLE",
    );
  return new OrganizationGroupChangeHandoffError("ORGANIZATION_GROUP_CHANGE_FAILED");
};

/**
 * Contract/result-binding proof for the owner-only Group composition. It is not
 * executable by a current runtime/request transaction. D/#40 must supply the
 * stewardship and caller-authority wrapper before a shipping adapter exists.
 */
export const createOrganizationGroupChangeOwnerHandoff = (
  transaction: RequestDatabaseTransaction,
): OrganizationGroupChangeOwnerHandoff =>
  Object.freeze({
    async change(commandCandidate: OrganizationGroupChangeCommand) {
      const command = organizationGroupChangeCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new OrganizationGroupChangeHandoffError("INVALID_ORGANIZATION_GROUP_CHANGE_COMMAND");

      const create = command.data.operation === "create_group" ? command.data : undefined;
      const revise = command.data.operation === "revise_group_label" ? command.data : undefined;
      try {
        const rows = await transaction.query<ChangeRow>`
          select *
          from vortex_access.coordinate_organization_group_change(
            ${command.data.operation}::text,
            ${command.data.organizationId}::uuid,
            ${command.data.groupId}::uuid,
            ${command.data.operation === "create_group" ? null : command.data.expectedGroupRevision}::bigint,
            ${create?.key ?? null}::text,
            ${create?.label ?? revise?.label ?? null}::text,
            ${command.data.changedBy}::uuid,
            ${command.data.correlationId}::uuid
          )
        `;
        return parseResult(rows, command.data);
      } catch (error) {
        if (error instanceof OrganizationGroupChangeHandoffError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
