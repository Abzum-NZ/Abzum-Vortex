import "server-only";

import {
  moduleInstallationStorageCommandSchema,
  moduleInstallationStorageResultSchema,
  type ModuleInstallationStorageCommand,
  type ModuleInstallationStorageErrorCode,
  type ModuleInstallationStorageResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

export class ModuleInstallationStorageError extends Error {
  readonly code: ModuleInstallationStorageErrorCode;

  constructor(code: ModuleInstallationStorageErrorCode) {
    super(code);
    this.name = "ModuleInstallationStorageError";
    this.code = code;
  }
}

type ProvisionRow = DatabaseRow & {
  readonly state: unknown;
  readonly changed: unknown;
  readonly binding_revision: unknown;
  readonly application_root_id: unknown;
  readonly application_release_revision: unknown;
  readonly module_root_id: unknown;
  readonly module_release_revision: unknown;
  readonly content_fingerprint: unknown;
  readonly resolution_fingerprint: unknown;
  readonly generator_contract_version: unknown;
  readonly storage_contract_ids: unknown;
};

const safeRevision = (value: unknown): number | undefined => {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  if (typeof value === "bigint") {
    const candidate = Number(value);
    return Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : undefined;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) ? candidate : undefined;
};

const parseResult = (row: ProvisionRow): ModuleInstallationStorageResult => {
  const result = moduleInstallationStorageResultSchema.safeParse({
    state: row.state,
    changed: row.changed,
    bindingRevision: safeRevision(row.binding_revision),
    applicationRootId: row.application_root_id,
    applicationReleaseRevision: safeRevision(row.application_release_revision),
    moduleRootId: row.module_root_id,
    moduleReleaseRevision: safeRevision(row.module_release_revision),
    contentFingerprint: row.content_fingerprint,
    resolutionFingerprint: row.resolution_fingerprint,
    generatorContractVersion: row.generator_contract_version,
    storageContractIds: row.storage_contract_ids,
  });
  if (!result.success)
    throw new ModuleInstallationStorageError("RECORD_STORAGE_PROVISIONING_FAILED");
  return result.data;
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapFailure = (error: unknown): ModuleInstallationStorageError => {
  if (error instanceof ModuleInstallationStorageError) return error;
  switch (databaseCode(error)) {
    case "22023":
      return new ModuleInstallationStorageError("INVALID_MODULE_INSTALLATION_STORAGE_COMMAND");
    case "42501":
      return new ModuleInstallationStorageError("MODULE_INSTALLATION_AUTHORITY_REFUSED");
    case "P0002":
      return new ModuleInstallationStorageError("MODULE_INSTALLATION_RELEASE_UNAVAILABLE");
    case "23514":
      return new ModuleInstallationStorageError("MODULE_INSTALLATION_RELEASE_MISMATCH");
    case "40001":
      return new ModuleInstallationStorageError("MODULE_INSTALLATION_BINDING_CONFLICT");
    case "55000":
      return new ModuleInstallationStorageError("RECORD_STORAGE_INCOMPATIBLE");
    default:
      return new ModuleInstallationStorageError("RECORD_STORAGE_PROVISIONING_FAILED");
  }
};

export interface ModuleInstallationStorageRepository {
  provision(command: ModuleInstallationStorageCommand): Promise<ModuleInstallationStorageResult>;
}

/**
 * Calls the sole request-visible storage coordinator. The supplied transaction
 * already carries trusted request context; neither SQL nor physical names are inputs.
 */
export const createModuleInstallationStorageRepository = (
  transaction: RequestDatabaseTransaction,
): ModuleInstallationStorageRepository =>
  Object.freeze({
    async provision(commandCandidate: ModuleInstallationStorageCommand) {
      const command = moduleInstallationStorageCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new ModuleInstallationStorageError("INVALID_MODULE_INSTALLATION_STORAGE_COMMAND");
      try {
        const rows = await transaction.query<ProvisionRow>`
          select *
          from vortex_module.provision_module_installation_storage(
            ${command.data.applicationRootId}::uuid,
            ${command.data.applicationReleaseRevision}::bigint,
            ${command.data.moduleRootId}::uuid,
            ${command.data.moduleReleaseRevision}::bigint,
            ${command.data.expectedBindingRevision}::bigint
          )
        `;
        if (rows.length !== 1 || rows[0] === undefined)
          throw new ModuleInstallationStorageError("RECORD_STORAGE_PROVISIONING_FAILED");
        return parseResult(rows[0]);
      } catch (error) {
        throw mapFailure(error);
      }
    },
  });
