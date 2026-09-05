import "server-only";

import {
  applicationAccessChangeCommandSchema,
  applicationAccessChangeResultSchema,
  type ApplicationAccessChangeCommand,
  type ApplicationAccessChangeResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { verifyPreparedApplicationRoleTemplates } from "../../src/application-role-template-adapter";

export const applicationAccessRepositoryErrorCodes = [
  "INVALID_APPLICATION_ACCESS_COMMAND",
  "INVALID_APPLICATION_ACCESS_STORAGE_RESULT",
  "APPLICATION_ACCESS_SCOPE_UNAVAILABLE",
  "APPLICATION_ACCESS_STALE_OR_UNAVAILABLE",
  "APPLICATION_ACCESS_VERSION_EXHAUSTED",
  "APPLICATION_ACCESS_OPERATION_FAILED",
] as const;

export type ApplicationAccessRepositoryErrorCode =
  (typeof applicationAccessRepositoryErrorCodes)[number];

export class ApplicationAccessRepositoryError extends Error {
  readonly code: ApplicationAccessRepositoryErrorCode;

  constructor(code: ApplicationAccessRepositoryErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "ApplicationAccessRepositoryError";
    this.code = code;
  }
}

export interface ApplicationAccessPrivateRepository {
  change(command: ApplicationAccessChangeCommand): Promise<ApplicationAccessChangeResult>;
}

type ApplicationAccessChangeRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  organization_id: unknown;
  application_root_id: unknown;
  registration_state: unknown;
  registration_revision: unknown;
  access_version: unknown;
  correlation_id: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const invalidStorage = (): never => {
  throw new ApplicationAccessRepositoryError("INVALID_APPLICATION_ACCESS_STORAGE_RESULT");
};

const parseResult = (
  rows: readonly ApplicationAccessChangeRow[],
  command: ApplicationAccessChangeCommand,
): ApplicationAccessChangeResult => {
  if (rows.length !== 1 || rows[0] === undefined) return invalidStorage();
  const row = rows[0];
  const parsed = applicationAccessChangeResultSchema.safeParse({
    outcome: row.outcome,
    operation: row.operation,
    organizationId: row.organization_id,
    applicationRootId: row.application_root_id,
    registrationState: row.registration_state,
    registrationRevision: revision(row.registration_revision),
    accessVersion: revision(row.access_version),
    correlationId: row.correlation_id,
  });
  if (!parsed.success) return invalidStorage();

  const organizationId =
    command.operation === "withdraw"
      ? command.organizationId
      : command.preparedTemplates.permissionRegistration.organizationId;
  const applicationRootId =
    command.operation === "withdraw"
      ? command.applicationRootId
      : command.preparedTemplates.permissionRegistration.applicationRootId;
  const expectedRegistrationRevision =
    command.operation === "register"
      ? 1
      : command.operation === "update" && parsed.data.outcome === "unchanged"
        ? command.expectedRevision
        : command.expectedRevision + 1;

  if (
    parsed.data.operation !== command.operation ||
    parsed.data.organizationId !== organizationId ||
    parsed.data.applicationRootId !== applicationRootId ||
    parsed.data.correlationId !== command.correlationId ||
    parsed.data.registrationRevision !== expectedRegistrationRevision ||
    (parsed.data.outcome === "unchanged" && command.operation !== "update")
  )
    return invalidStorage();

  return parsed.data;
};

const mapStorageFailure = (error: unknown): ApplicationAccessRepositoryError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (databaseCode === "22023")
    return new ApplicationAccessRepositoryError("INVALID_APPLICATION_ACCESS_COMMAND");
  if (databaseCode === "42501")
    return new ApplicationAccessRepositoryError("APPLICATION_ACCESS_SCOPE_UNAVAILABLE");
  if (databaseCode === "22003")
    return new ApplicationAccessRepositoryError("APPLICATION_ACCESS_VERSION_EXHAUSTED");
  if (["23503", "23505", "40001", "55000"].includes(databaseCode ?? ""))
    return new ApplicationAccessRepositoryError("APPLICATION_ACCESS_STALE_OR_UNAVAILABLE");
  return new ApplicationAccessRepositoryError("APPLICATION_ACCESS_OPERATION_FAILED");
};

/**
 * Contract/result-binding proof for the owner-only SQL handoff. No current runtime or
 * request transaction may invoke it. The future #40/#64 boundary must expose an
 * authority-checking wrapper and a shipping adapter that targets that wrapper.
 */
export const createApplicationAccessPrivateRepository = (
  transaction: RequestDatabaseTransaction,
): ApplicationAccessPrivateRepository =>
  Object.freeze({
    async change(commandCandidate: ApplicationAccessChangeCommand) {
      const command = applicationAccessChangeCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new ApplicationAccessRepositoryError("INVALID_APPLICATION_ACCESS_COMMAND");

      if (command.data.operation !== "withdraw") {
        try {
          verifyPreparedApplicationRoleTemplates(command.data.preparedTemplates);
        } catch (error) {
          throw new ApplicationAccessRepositoryError("INVALID_APPLICATION_ACCESS_COMMAND", {
            cause: error,
          });
        }
      }

      const organizationId =
        command.data.operation === "withdraw"
          ? command.data.organizationId
          : command.data.preparedTemplates.permissionRegistration.organizationId;
      const applicationRootId =
        command.data.operation === "withdraw"
          ? command.data.applicationRootId
          : command.data.preparedTemplates.permissionRegistration.applicationRootId;

      try {
        const rows = await transaction.query<ApplicationAccessChangeRow>`
          select *
          from vortex_access.coordinate_application_access_change(
            ${command.data.operation}::text,
            ${command.data.operation === "register" ? null : command.data.expectedRevision}::bigint,
            ${command.data.operation === "withdraw" ? null : JSON.stringify(command.data.preparedTemplates)}::text::jsonb,
            ${organizationId}::uuid,
            ${applicationRootId}::uuid,
            ${command.data.changedBy}::uuid,
            ${command.data.correlationId}::uuid
          )
        `;
        return parseResult(rows, command.data);
      } catch (error) {
        if (error instanceof ApplicationAccessRepositoryError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
