import "server-only";

import {
  applicationPermissionCatalogueSnapshotCommandSchema,
  applicationPermissionCatalogueSnapshotSchema,
  initializePlatformPermissionCatalogueCommandSchema,
  initializePlatformPermissionCatalogueResultSchema,
  permissionCatalogueEntrySchema,
  permissionCatalogueLookupCommandSchema,
  permissionRegistryMutationCommandSchema,
  permissionRegistryMutationResultSchema,
  type ApplicationPermissionCatalogueSnapshot,
  type ApplicationPermissionCatalogueSnapshotCommand,
  type InitializePlatformPermissionCatalogueCommand,
  type InitializePlatformPermissionCatalogueResult,
  type PermissionCatalogueLookupCommand,
  type PermissionCatalogueLookupResult,
  type PermissionRegistryMutationCommand,
  type PermissionRegistryMutationResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { verifyPreparedApplicationPermissionRegistration } from "./permission-registry-definition-adapter";

export const permissionRegistryRepositoryErrorCodes = [
  "INVALID_PERMISSION_REGISTRY_COMMAND",
  "INVALID_PERMISSION_REGISTRY_STORAGE_RESULT",
  "PERMISSION_REGISTRY_SCOPE_UNAVAILABLE",
  "PERMISSION_REGISTRY_STALE_OR_UNAVAILABLE",
  "PERMISSION_REGISTRY_ACCESS_VERSION_EXHAUSTED",
  "PERMISSION_REGISTRY_OPERATION_FAILED",
] as const;

export type PermissionRegistryRepositoryErrorCode =
  (typeof permissionRegistryRepositoryErrorCodes)[number];

export class PermissionRegistryRepositoryError extends Error {
  readonly code: PermissionRegistryRepositoryErrorCode;

  constructor(code: PermissionRegistryRepositoryErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "PermissionRegistryRepositoryError";
    this.code = code;
  }
}

export interface PermissionRegistryPrivateRepository {
  initializePlatformCatalogue(
    command: InitializePlatformPermissionCatalogueCommand,
  ): Promise<InitializePlatformPermissionCatalogueResult>;
  mutate(command: PermissionRegistryMutationCommand): Promise<PermissionRegistryMutationResult>;
  lookup(command: PermissionCatalogueLookupCommand): Promise<PermissionCatalogueLookupResult>;
  readApplicationSnapshot(
    command: ApplicationPermissionCatalogueSnapshotCommand,
  ): Promise<ApplicationPermissionCatalogueSnapshot | undefined>;
}

type PlatformInitializationRow = DatabaseRow & {
  organization_id: unknown;
  registration_revision: unknown;
  access_version: unknown;
};

type MutationRow = DatabaseRow & {
  operation: unknown;
  organization_id: unknown;
  application_root_id: unknown;
  registration_state: unknown;
  registration_revision: unknown;
  access_version: unknown;
  correlation_id: unknown;
};

type PermissionEntryRow = DatabaseRow & {
  organization_id: unknown;
  application_root_id: unknown;
  registration_revision: unknown;
  owner_kind: unknown;
  owner_id: unknown;
  permission_id: unknown;
  permission_key: unknown;
  label: unknown;
  description: unknown;
  record_type_id: unknown;
  action_kind: unknown;
  named_action: unknown;
  administrative: unknown;
  source_kind: unknown;
  source_definition_key: unknown;
  source_root_id: unknown;
  source_version: unknown;
  source_revision: unknown;
  source_validation_contract_version: unknown;
  source_content_fingerprint: unknown;
  source_resolution_fingerprint: unknown;
  source_catalogue_fingerprint: unknown;
  meaning_fingerprint: unknown;
};

type ApplicationSnapshotRow = DatabaseRow & {
  organization_id: unknown;
  application_root_id: unknown;
  registration_revision: unknown;
  release_revision: unknown;
  definition_key: unknown;
  release_version: unknown;
  validation_contract_version: unknown;
  content_fingerprint: unknown;
  resolution_fingerprint: unknown;
  catalogue_fingerprint: unknown;
  permission_ids: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const optional = <Value>(value: Value | null | undefined): Value | undefined =>
  value === null || value === undefined ? undefined : value;

const requireOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_STORAGE_RESULT");
  return rows[0];
};

const invalidStorage = (): never => {
  throw new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_STORAGE_RESULT");
};

const parsePlatformInitialization = (
  row: PlatformInitializationRow,
): InitializePlatformPermissionCatalogueResult => {
  const parsed = initializePlatformPermissionCatalogueResultSchema.safeParse({
    organizationId: row.organization_id,
    registrationRevision: revision(row.registration_revision),
    accessVersion: revision(row.access_version),
  });
  return parsed.success ? parsed.data : invalidStorage();
};

const parseMutation = (row: MutationRow): PermissionRegistryMutationResult => {
  const parsed = permissionRegistryMutationResultSchema.safeParse({
    operation: row.operation,
    organizationId: row.organization_id,
    applicationRootId: row.application_root_id,
    registrationState: row.registration_state,
    registrationRevision: revision(row.registration_revision),
    accessVersion: revision(row.access_version),
    correlationId: row.correlation_id,
  });
  return parsed.success ? parsed.data : invalidStorage();
};

const parseEntry = (row: PermissionEntryRow): PermissionCatalogueLookupResult => {
  const platformSource = row.source_kind === "platform_catalogue";
  const parsed = permissionCatalogueEntrySchema.safeParse({
    organizationId: row.organization_id,
    applicationRootId: optional(row.application_root_id),
    registrationRevision: revision(row.registration_revision),
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    permission: {
      permissionId: row.permission_id,
      key: row.permission_key,
      label: row.label,
      description: row.description,
      recordTypeId: optional(row.record_type_id),
      actionKind: row.action_kind,
      namedAction: optional(row.named_action),
      administrative: row.administrative,
    },
    sourceRelease: platformSource
      ? {
          kind: "platform_catalogue",
          ownerId: row.source_root_id ?? row.owner_id,
          catalogueVersion: row.source_version,
          catalogueFingerprint: row.source_catalogue_fingerprint,
        }
      : {
          kind: row.source_kind,
          definitionKey: row.source_definition_key,
          rootId: row.source_root_id,
          releaseRevision: revision(row.source_revision),
          releaseVersion: row.source_version,
          validationContractVersion: row.source_validation_contract_version,
          contentFingerprint: row.source_content_fingerprint,
          resolutionFingerprint: row.source_resolution_fingerprint,
        },
    meaningFingerprint: row.meaning_fingerprint,
  });
  return parsed.success ? { outcome: "available", entry: parsed.data } : invalidStorage();
};

const parseSnapshot = (row: ApplicationSnapshotRow): ApplicationPermissionCatalogueSnapshot => {
  const parsed = applicationPermissionCatalogueSnapshotSchema.safeParse({
    organizationId: row.organization_id,
    applicationRootId: row.application_root_id,
    registrationRevision: revision(row.registration_revision),
    applicationRelease: {
      kind: "application",
      definitionKey: row.definition_key,
      rootId: row.application_root_id,
      releaseRevision: revision(row.release_revision),
      releaseVersion: row.release_version,
      validationContractVersion: row.validation_contract_version,
      contentFingerprint: row.content_fingerprint,
      resolutionFingerprint: row.resolution_fingerprint,
    },
    catalogueFingerprint: row.catalogue_fingerprint,
    permissionIds: row.permission_ids,
  });
  return parsed.success ? parsed.data : invalidStorage();
};

const mapStorageFailure = (error: unknown): PermissionRegistryRepositoryError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (databaseCode === "22023")
    return new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_COMMAND");
  if (databaseCode === "42501")
    return new PermissionRegistryRepositoryError("PERMISSION_REGISTRY_SCOPE_UNAVAILABLE");
  if (databaseCode === "22003")
    return new PermissionRegistryRepositoryError("PERMISSION_REGISTRY_ACCESS_VERSION_EXHAUSTED");
  if (["23503", "23505", "40001", "55000"].includes(databaseCode ?? ""))
    return new PermissionRegistryRepositoryError("PERMISSION_REGISTRY_STALE_OR_UNAVAILABLE");
  return new PermissionRegistryRepositoryError("PERMISSION_REGISTRY_OPERATION_FAILED");
};

const execute = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PermissionRegistryRepositoryError) throw error;
    throw mapStorageFailure(error);
  }
};

/**
 * Adapts the owner-only SQL handoff inside a caller-supplied protected transaction.
 * Supplying this transaction does not authorise an operation; the composing #40/#64
 * boundary must already have established that authority.
 */
export const createPermissionRegistryPrivateRepository = (
  transaction: RequestDatabaseTransaction,
): PermissionRegistryPrivateRepository => {
  const repository: PermissionRegistryPrivateRepository = {
    async initializePlatformCatalogue(
      commandCandidate: InitializePlatformPermissionCatalogueCommand,
    ) {
      const command =
        initializePlatformPermissionCatalogueCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_COMMAND");
      return execute(async () => {
        const rows = await transaction.query<PlatformInitializationRow>`
          select *
          from vortex_access.initialize_platform_permission_catalogue(
            ${command.data.organizationId}::uuid,
            ${command.data.changedBy}::uuid,
            ${command.data.correlationId}::uuid
          )
        `;
        return parsePlatformInitialization(requireOne(rows));
      });
    },

    async mutate(commandCandidate: PermissionRegistryMutationCommand) {
      const command = permissionRegistryMutationCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_COMMAND");
      if (command.data.operation !== "withdraw") {
        try {
          verifyPreparedApplicationPermissionRegistration(command.data.candidate);
        } catch (error) {
          throw new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_COMMAND", {
            cause: error,
          });
        }
      }

      return execute(async () => {
        const rows =
          command.data.operation === "withdraw"
            ? await transaction.query<MutationRow>`
                select *
                from vortex_access.withdraw_application_permission_registration(
                  ${command.data.organizationId}::uuid,
                  ${command.data.applicationRootId}::uuid,
                  ${command.data.expectedRevision}::bigint,
                  ${command.data.changedBy}::uuid,
                  ${command.data.correlationId}::uuid
                )
              `
            : await transaction.query<MutationRow>`
                select *
                from vortex_access.apply_application_permission_registration(
                  ${command.data.operation}::text,
                  ${command.data.operation === "register" ? null : command.data.expectedRevision}::bigint,
                  ${JSON.stringify(command.data.candidate)}::text::jsonb,
                  ${command.data.changedBy}::uuid,
                  ${command.data.correlationId}::uuid
                )
              `;
        return parseMutation(requireOne(rows));
      });
    },

    async lookup(commandCandidate: PermissionCatalogueLookupCommand) {
      const command = permissionCatalogueLookupCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_COMMAND");
      return execute(async () => {
        const rows = await transaction.query<PermissionEntryRow>`
          select *
          from vortex_access.read_available_permission(
            ${command.data.organizationId}::uuid,
            ${command.data.applicationRootId ?? null}::uuid,
            ${command.data.ownerKind}::text,
            ${command.data.ownerId}::uuid,
            ${command.data.permissionId}::uuid
          )
        `;
        if (rows.length === 0) return { outcome: "unavailable" as const };
        return parseEntry(requireOne(rows));
      });
    },

    async readApplicationSnapshot(commandCandidate: ApplicationPermissionCatalogueSnapshotCommand) {
      const command =
        applicationPermissionCatalogueSnapshotCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_COMMAND");
      return execute(async () => {
        const rows = await transaction.query<ApplicationSnapshotRow>`
          select *
          from vortex_access.read_application_permission_snapshot(
            ${command.data.organizationId}::uuid,
            ${command.data.applicationRootId}::uuid
          )
        `;
        if (rows.length === 0) return undefined;
        return parseSnapshot(requireOne(rows));
      });
    },
  };
  return Object.freeze(repository);
};
