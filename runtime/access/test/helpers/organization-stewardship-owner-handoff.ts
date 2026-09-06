import "server-only";

import {
  organizationStewardshipAdoptionCommandSchema,
  organizationStewardshipAdoptionResultSchema,
  type OrganizationStewardshipAdoptionCommand,
  type OrganizationStewardshipAdoptionResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

export const organizationStewardshipHandoffErrorCodes = [
  "INVALID_ORGANIZATION_STEWARDSHIP_ADOPTION_COMMAND",
  "INVALID_ORGANIZATION_STEWARDSHIP_ADOPTION_STORAGE_RESULT",
  "ORGANIZATION_STEWARDSHIP_ADOPTION_SCOPE_UNAVAILABLE",
  "ORGANIZATION_STEWARDSHIP_ADOPTION_STALE_OR_UNAVAILABLE",
  "ORGANIZATION_STEWARDSHIP_ADOPTION_VERSION_EXHAUSTED",
  "ORGANIZATION_STEWARDSHIP_ADOPTION_FAILED",
] as const;

export type OrganizationStewardshipHandoffErrorCode =
  (typeof organizationStewardshipHandoffErrorCodes)[number];

export class OrganizationStewardshipHandoffError extends Error {
  readonly code: OrganizationStewardshipHandoffErrorCode;

  constructor(code: OrganizationStewardshipHandoffErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationStewardshipHandoffError";
    this.code = code;
  }
}

export interface OrganizationStewardshipOwnerHandoff {
  adopt(
    command: OrganizationStewardshipAdoptionCommand,
  ): Promise<OrganizationStewardshipAdoptionResult>;
}

type AdoptionRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  requirement: unknown;
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
  throw new OrganizationStewardshipHandoffError(
    "INVALID_ORGANIZATION_STEWARDSHIP_ADOPTION_STORAGE_RESULT",
  );
};

const parseResult = (
  rows: readonly AdoptionRow[],
  command: OrganizationStewardshipAdoptionCommand,
): OrganizationStewardshipAdoptionResult => {
  if (rows.length !== 1 || rows[0] === undefined) return invalidStorage();
  const row = rows[0];
  const parsed = organizationStewardshipAdoptionResultSchema.safeParse({
    outcome: row.outcome,
    operation: row.operation,
    requirement: row.requirement,
    accessVersion: revision(row.access_version),
    correlationId: row.correlation_id,
  });
  if (!parsed.success) return invalidStorage();

  const requirement = parsed.data.requirement;
  if (
    parsed.data.operation !== command.operation ||
    !sameUuid(parsed.data.correlationId, command.correlationId) ||
    !sameUuid(requirement.organizationId, command.organizationId) ||
    !sameUuid(requirement.originalOrganizationAccountId, command.organizationAccountId) ||
    !sameUuid(requirement.originalRoleId, command.roleId) ||
    !sameUuid(requirement.originalRoleAssignmentId, command.roleAssignmentId) ||
    !sameUuid(requirement.originalDelegationAuthorityId, command.delegationAuthorityId) ||
    !sameUuid(requirement.adoptedByActorId, command.changedBy) ||
    !sameUuid(requirement.adoptionCorrelationId, command.correlationId) ||
    (parsed.data.outcome === "changed" &&
      (!sameUuid(requirement.changedByActorId, command.changedBy) ||
        !sameUuid(requirement.changeCorrelationId, command.correlationId)))
  )
    return invalidStorage();

  return parsed.data;
};

const mapStorageFailure = (error: unknown): OrganizationStewardshipHandoffError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (databaseCode === "22023")
    return new OrganizationStewardshipHandoffError(
      "INVALID_ORGANIZATION_STEWARDSHIP_ADOPTION_COMMAND",
    );
  if (databaseCode === "42501")
    return new OrganizationStewardshipHandoffError(
      "ORGANIZATION_STEWARDSHIP_ADOPTION_SCOPE_UNAVAILABLE",
    );
  if (databaseCode === "22003")
    return new OrganizationStewardshipHandoffError(
      "ORGANIZATION_STEWARDSHIP_ADOPTION_VERSION_EXHAUSTED",
    );
  if (["23503", "23505", "23514", "40001", "55000"].includes(databaseCode ?? ""))
    return new OrganizationStewardshipHandoffError(
      "ORGANIZATION_STEWARDSHIP_ADOPTION_STALE_OR_UNAVAILABLE",
    );
  return new OrganizationStewardshipHandoffError("ORGANIZATION_STEWARDSHIP_ADOPTION_FAILED");
};

/**
 * Contract/result-binding proof for trusted owner-only adoption. It is neither
 * a current-owner flag nor a caller-authority gateway; #30 supplies the outer
 * provisioning transaction and #40 owns later protected invocation.
 */
export const createOrganizationStewardshipOwnerHandoff = (
  transaction: RequestDatabaseTransaction,
): OrganizationStewardshipOwnerHandoff =>
  Object.freeze({
    async adopt(commandCandidate: OrganizationStewardshipAdoptionCommand) {
      const command = organizationStewardshipAdoptionCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new OrganizationStewardshipHandoffError(
          "INVALID_ORGANIZATION_STEWARDSHIP_ADOPTION_COMMAND",
        );

      try {
        const rows = await transaction.query<AdoptionRow>`
          select *
          from vortex_access.coordinate_organization_stewardship_adoption(
            ${command.data.organizationId}::uuid,
            ${command.data.organizationAccountId}::uuid,
            ${command.data.roleId}::uuid,
            ${command.data.roleKey}::text,
            ${command.data.roleLabel}::text,
            ${command.data.roleDescription}::text,
            ${command.data.roleAssignmentId}::uuid,
            ${command.data.delegationAuthorityId}::uuid,
            ${command.data.changedBy}::uuid,
            ${command.data.correlationId}::uuid
          )
        `;
        return parseResult(rows, command.data);
      } catch (error) {
        if (error instanceof OrganizationStewardshipHandoffError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
