import "server-only";

import {
  organizationManagementApplicationRequirementChangeCommandSchema,
  organizationManagementApplicationRequirementChangeResultSchema,
  type OrganizationManagementApplicationRequirementChangeCommand,
  type OrganizationManagementApplicationRequirementChangeResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

export const organizationManagementApplicationRequirementHandoffErrorCodes = [
  "INVALID_ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_COMMAND",
  "INVALID_ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_STORAGE_RESULT",
  "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_SCOPE_UNAVAILABLE",
  "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_STALE_OR_UNAVAILABLE",
  "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_VERSION_EXHAUSTED",
  "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_FAILED",
] as const;

export type OrganizationManagementApplicationRequirementHandoffErrorCode =
  (typeof organizationManagementApplicationRequirementHandoffErrorCodes)[number];

export class OrganizationManagementApplicationRequirementHandoffError extends Error {
  readonly code: OrganizationManagementApplicationRequirementHandoffErrorCode;

  constructor(
    code: OrganizationManagementApplicationRequirementHandoffErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "OrganizationManagementApplicationRequirementHandoffError";
    this.code = code;
  }
}

export interface OrganizationManagementApplicationRequirementOwnerHandoff {
  change(
    command: OrganizationManagementApplicationRequirementChangeCommand,
  ): Promise<OrganizationManagementApplicationRequirementChangeResult>;
}

type ChangeRow = DatabaseRow & {
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
  throw new OrganizationManagementApplicationRequirementHandoffError(
    "INVALID_ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_STORAGE_RESULT",
  );
};

const parseResult = (
  rows: readonly ChangeRow[],
  command: OrganizationManagementApplicationRequirementChangeCommand,
): OrganizationManagementApplicationRequirementChangeResult => {
  if (rows.length !== 1 || rows[0] === undefined) return invalidStorage();
  const row = rows[0];
  const parsed = organizationManagementApplicationRequirementChangeResultSchema.safeParse({
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
    requirement.revision !== command.expectedRequirementRevision + 1 ||
    !sameUuid(requirement.managementApplicationRootId, command.applicationRootId) ||
    !sameUuid(requirement.managementRoleId, command.roleId) ||
    requirement.requiredRoleRevision !== command.expectedRoleRevision ||
    !sameUuid(requirement.changedByActorId, command.changedBy) ||
    !sameUuid(requirement.changeCorrelationId, command.correlationId)
  )
    return invalidStorage();

  return parsed.data;
};

const mapStorageFailure = (
  error: unknown,
): OrganizationManagementApplicationRequirementHandoffError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (databaseCode === "22023")
    return new OrganizationManagementApplicationRequirementHandoffError(
      "INVALID_ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_COMMAND",
    );
  if (databaseCode === "42501")
    return new OrganizationManagementApplicationRequirementHandoffError(
      "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_SCOPE_UNAVAILABLE",
    );
  if (databaseCode === "22003")
    return new OrganizationManagementApplicationRequirementHandoffError(
      "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_VERSION_EXHAUSTED",
    );
  if (["23503", "23505", "23514", "40001", "55000"].includes(databaseCode ?? ""))
    return new OrganizationManagementApplicationRequirementHandoffError(
      "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_STALE_OR_UNAVAILABLE",
    );
  return new OrganizationManagementApplicationRequirementHandoffError(
    "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_FAILED",
  );
};

/**
 * Test-only binding proof for the private D2 composition. It does not prove an
 * installed management application or caller authority; #64/#267 and #40 own
 * those later boundaries.
 */
export const createOrganizationManagementApplicationRequirementOwnerHandoff = (
  transaction: RequestDatabaseTransaction,
): OrganizationManagementApplicationRequirementOwnerHandoff =>
  Object.freeze({
    async change(commandCandidate: OrganizationManagementApplicationRequirementChangeCommand) {
      const command =
        organizationManagementApplicationRequirementChangeCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new OrganizationManagementApplicationRequirementHandoffError(
          "INVALID_ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_COMMAND",
        );

      try {
        const rows = await transaction.query<ChangeRow>`
          select *
          from vortex_access.coordinate_organization_management_application_requirement(
            ${command.data.operation}::text,
            ${command.data.organizationId}::uuid,
            ${command.data.expectedRequirementRevision}::bigint,
            ${command.data.applicationRootId}::uuid,
            ${command.data.roleId}::uuid,
            ${command.data.expectedRoleRevision}::bigint,
            ${command.data.changedBy}::uuid,
            ${command.data.correlationId}::uuid
          )
        `;
        return parseResult(rows, command.data);
      } catch (error) {
        if (error instanceof OrganizationManagementApplicationRequirementHandoffError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
