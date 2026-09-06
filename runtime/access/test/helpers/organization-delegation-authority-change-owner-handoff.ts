import "server-only";

import {
  organizationDelegationAuthorityChangeCommandSchema,
  organizationDelegationAuthorityChangeResultSchema,
  type AccessAssignee,
  type DelegationScope,
  type OrganizationDelegationAuthorityChangeCommand,
  type OrganizationDelegationAuthorityChangeResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { canonicalJson } from "@vortex/definition";
import { verifyPreparedOrganizationDelegationScope } from "../../src/organization-delegation-scope-evidence";

export const organizationDelegationAuthorityChangeHandoffErrorCodes = [
  "INVALID_ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_COMMAND",
  "INVALID_ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_STORAGE_RESULT",
  "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_SCOPE_UNAVAILABLE",
  "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_STALE_OR_UNAVAILABLE",
  "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_VERSION_EXHAUSTED",
  "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_FAILED",
] as const;

export type OrganizationDelegationAuthorityChangeHandoffErrorCode =
  (typeof organizationDelegationAuthorityChangeHandoffErrorCodes)[number];

export class OrganizationDelegationAuthorityChangeHandoffError extends Error {
  readonly code: OrganizationDelegationAuthorityChangeHandoffErrorCode;

  constructor(code: OrganizationDelegationAuthorityChangeHandoffErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationDelegationAuthorityChangeHandoffError";
    this.code = code;
  }
}

export interface OrganizationDelegationAuthorityChangeOwnerHandoff {
  change(
    command: OrganizationDelegationAuthorityChangeCommand,
  ): Promise<OrganizationDelegationAuthorityChangeResult>;
}

type ChangeRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  delegation: unknown;
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
const sameInstant = (left: string, right: string): boolean =>
  Date.parse(left) === Date.parse(right);
const sameOptionalInstant = (left: string | undefined, right: string | undefined): boolean =>
  left === undefined ? right === undefined : right !== undefined && sameInstant(left, right);
const sameScope = (left: DelegationScope, right: DelegationScope): boolean =>
  canonicalJson(left) === canonicalJson(right);
const sameHolder = (left: AccessAssignee, right: AccessAssignee): boolean => {
  if (left.kind !== right.kind) return false;
  return left.kind === "organization_account" && right.kind === "organization_account"
    ? sameUuid(left.organizationAccountId, right.organizationAccountId)
    : left.kind === "group" && right.kind === "group"
      ? sameUuid(left.groupId, right.groupId)
      : false;
};

const invalidStorage = (): never => {
  throw new OrganizationDelegationAuthorityChangeHandoffError(
    "INVALID_ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_STORAGE_RESULT",
  );
};

const parseResult = (
  rows: readonly ChangeRow[],
  command: OrganizationDelegationAuthorityChangeCommand,
): OrganizationDelegationAuthorityChangeResult => {
  if (rows.length !== 1 || rows[0] === undefined) return invalidStorage();
  const row = rows[0];
  const parsed = organizationDelegationAuthorityChangeResultSchema.safeParse({
    outcome: row.outcome,
    operation: row.operation,
    delegation: row.delegation,
    accessVersion: revision(row.access_version),
    correlationId: row.correlation_id,
  });
  if (!parsed.success) return invalidStorage();

  const delegation = parsed.data.delegation;
  if (
    parsed.data.operation !== command.operation ||
    !sameUuid(parsed.data.correlationId, command.correlationId) ||
    !sameUuid(delegation.organizationId, command.organizationId) ||
    !sameUuid(delegation.delegationAuthorityId, command.delegationAuthorityId) ||
    !sameUuid(delegation.changedByActorId, command.changedBy) ||
    !sameUuid(delegation.changeCorrelationId, command.correlationId)
  )
    return invalidStorage();

  if (command.operation === "grant_delegation") {
    if (
      delegation.revision !== 1 ||
      delegation.state !== "live" ||
      !sameHolder(delegation.holder, command.holder) ||
      !sameScope(delegation.scope, command.scope) ||
      !sameInstant(delegation.startsAt, command.startsAt) ||
      !sameOptionalInstant(delegation.expiresAt, command.expiresAt) ||
      !sameUuid(delegation.grantedByActorId, command.changedBy) ||
      !sameUuid(delegation.grantCorrelationId, command.correlationId)
    )
      return invalidStorage();
    return parsed.data;
  }

  if (delegation.revision !== command.expectedDelegationRevision + 1) return invalidStorage();
  if (command.operation === "replace_delegation_scope") {
    if (delegation.state !== "live" || !sameScope(delegation.scope, command.scope))
      return invalidStorage();
    return parsed.data;
  }

  if (
    delegation.state !== "revoked" ||
    delegation.revokedByActorId === undefined ||
    !sameUuid(delegation.revokedByActorId, command.changedBy) ||
    delegation.revocationCorrelationId === undefined ||
    !sameUuid(delegation.revocationCorrelationId, command.correlationId)
  )
    return invalidStorage();
  return parsed.data;
};

const mapStorageFailure = (error: unknown): OrganizationDelegationAuthorityChangeHandoffError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (databaseCode === "22023")
    return new OrganizationDelegationAuthorityChangeHandoffError(
      "INVALID_ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_COMMAND",
    );
  if (databaseCode === "42501")
    return new OrganizationDelegationAuthorityChangeHandoffError(
      "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_SCOPE_UNAVAILABLE",
    );
  if (databaseCode === "22003")
    return new OrganizationDelegationAuthorityChangeHandoffError(
      "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_VERSION_EXHAUSTED",
    );
  if (["23503", "23505", "23514", "40001", "55000"].includes(databaseCode ?? ""))
    return new OrganizationDelegationAuthorityChangeHandoffError(
      "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_STALE_OR_UNAVAILABLE",
    );
  return new OrganizationDelegationAuthorityChangeHandoffError(
    "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_FAILED",
  );
};

/**
 * Contract/result-binding proof for the owner-only delegation composition. It
 * is not an authority gateway. #40 must check caller/approver management
 * permission, before/after scope and onward-delegation ceiling before exposure.
 */
export const createOrganizationDelegationAuthorityChangeOwnerHandoff = (
  transaction: RequestDatabaseTransaction,
): OrganizationDelegationAuthorityChangeOwnerHandoff =>
  Object.freeze({
    async change(commandCandidate: OrganizationDelegationAuthorityChangeCommand) {
      const command =
        organizationDelegationAuthorityChangeCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new OrganizationDelegationAuthorityChangeHandoffError(
          "INVALID_ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_COMMAND",
        );

      let scope: DelegationScope | undefined;
      try {
        scope =
          command.data.operation === "revoke_delegation"
            ? undefined
            : verifyPreparedOrganizationDelegationScope(command.data.scope);
      } catch (error) {
        throw new OrganizationDelegationAuthorityChangeHandoffError(
          "INVALID_ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_COMMAND",
          { cause: error },
        );
      }
      const grant = command.data.operation === "grant_delegation" ? command.data : undefined;
      const direct = grant?.holder.kind === "organization_account" ? grant : undefined;
      const group = grant?.holder.kind === "group" ? grant : undefined;
      try {
        const rows = await transaction.query<ChangeRow>`
          select *
          from vortex_access.coordinate_organization_delegation_authority_change(
            ${command.data.operation}::text,
            ${command.data.organizationId}::uuid,
            ${command.data.delegationAuthorityId}::uuid,
            ${command.data.operation === "grant_delegation" ? null : command.data.expectedDelegationRevision}::bigint,
            ${grant?.holder.kind ?? null}::text,
            ${direct?.holder.organizationAccountId ?? null}::uuid,
            ${group?.holder.groupId ?? null}::uuid,
            ${scope?.kind ?? null}::text,
            ${scope?.kind === "bounded" ? JSON.stringify(scope.permissions) : null}::jsonb,
            ${scope?.kind === "bounded" ? scope.scopeFingerprint : null}::text,
            ${grant?.startsAt ?? null}::timestamptz,
            ${grant?.expiresAt ?? null}::timestamptz,
            ${command.data.changedBy}::uuid,
            ${command.data.correlationId}::uuid
          )
        `;
        return parseResult(rows, command.data);
      } catch (error) {
        if (error instanceof OrganizationDelegationAuthorityChangeHandoffError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
