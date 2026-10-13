import "server-only";

import {
  databaseRevision,
  applicationPermissionCatalogueSnapshotCommandSchema,
  applicationPermissionCatalogueSnapshotSchema,
  permissionCatalogueEntrySchema,
  permissionCatalogueLookupCommandSchema,
  type ApplicationPermissionCatalogueSnapshot,
  type ApplicationPermissionCatalogueSnapshotCommand,
  type PermissionCatalogueLookupCommand,
  type PermissionCatalogueEntry,
} from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";

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
  /** Reads the available entries for exact permissions in one query; absent permissions yield no row. */
  lookupMany(
    commands: readonly PermissionCatalogueLookupCommand[],
  ): Promise<readonly PermissionCatalogueEntry[]>;
  readApplicationSnapshot(
    command: ApplicationPermissionCatalogueSnapshotCommand,
  ): Promise<ApplicationPermissionCatalogueSnapshot | undefined>;
}

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
  record_scope: unknown;
  field_policy: unknown;
  action_kind: unknown;
  named_action: unknown;
  administrative: unknown;
  source_kind: unknown;
  source_definition_key: unknown;
  source_root_id: unknown;
  source_version: unknown;
  source_revision: unknown;
  source_validation_contract_version: unknown;
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

const optional = <Value>(value: Value | null | undefined): Value | undefined =>
  value === null || value === undefined ? undefined : value;

const requireOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_STORAGE_RESULT");
  return rows[0];
};

const invalidStorage = (cause: unknown): never => {
  throw new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_STORAGE_RESULT", {
    cause,
  });
};

const parseEntry = (row: PermissionEntryRow): PermissionCatalogueEntry => {
  const platformSource = row.source_kind === "platform_catalogue";
  const recordScope = optional(row.record_scope);
  const fieldPolicy = optional(row.field_policy);
  const parsed = permissionCatalogueEntrySchema.safeParse({
    organizationId: row.organization_id,
    applicationRootId: optional(row.application_root_id),
    registrationRevision: databaseRevision(row.registration_revision),
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    permission: {
      permissionId: row.permission_id,
      key: row.permission_key,
      label: row.label,
      description: row.description,
      recordTypeId: optional(row.record_type_id),
      ...(recordScope === undefined ? {} : { recordScope }),
      ...(fieldPolicy === undefined ? {} : { fieldPolicy }),
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
          releaseRevision: databaseRevision(row.source_revision),
          releaseVersion: row.source_version,
          validationContractVersion: row.source_validation_contract_version,
        },
    meaningFingerprint: row.meaning_fingerprint,
  });
  return parsed.success ? parsed.data : invalidStorage(parsed.error);
};

const parseSnapshot = (row: ApplicationSnapshotRow): ApplicationPermissionCatalogueSnapshot => {
  const parsed = applicationPermissionCatalogueSnapshotSchema.safeParse({
    organizationId: row.organization_id,
    applicationRootId: row.application_root_id,
    registrationRevision: databaseRevision(row.registration_revision),
    applicationRelease: {
      kind: "application",
      definitionKey: row.definition_key,
      rootId: row.application_root_id,
      releaseRevision: databaseRevision(row.release_revision),
      releaseVersion: row.release_version,
      validationContractVersion: row.validation_contract_version,
      contentFingerprint: row.content_fingerprint,
      resolutionFingerprint: row.resolution_fingerprint,
    },
    catalogueFingerprint: row.catalogue_fingerprint,
    permissionIds: row.permission_ids,
  });
  return parsed.success ? parsed.data : invalidStorage(parsed.error);
};

const mapStorageFailure = (error: unknown): PermissionRegistryRepositoryError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (databaseCode === "22023")
    return new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_COMMAND", {
      cause: error,
    });
  if (databaseCode === "42501")
    return new PermissionRegistryRepositoryError("PERMISSION_REGISTRY_SCOPE_UNAVAILABLE", {
      cause: error,
    });
  if (databaseCode === "22003")
    return new PermissionRegistryRepositoryError("PERMISSION_REGISTRY_ACCESS_VERSION_EXHAUSTED", {
      cause: error,
    });
  if (["23503", "23505", "40001", "55000"].includes(databaseCode ?? ""))
    return new PermissionRegistryRepositoryError("PERMISSION_REGISTRY_STALE_OR_UNAVAILABLE", {
      cause: error,
    });
  return new PermissionRegistryRepositoryError("PERMISSION_REGISTRY_OPERATION_FAILED", {
    cause: error,
  });
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
    async lookupMany(commandCandidates: readonly PermissionCatalogueLookupCommand[]) {
      const commands = commandCandidates.map((candidate) => {
        const command = permissionCatalogueLookupCommandSchema.safeParse(candidate);
        if (!command.success)
          throw new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_COMMAND");
        return command.data;
      });
      const [first] = commands;
      if (first === undefined) return [];
      if (commands.some((command) => command.organizationId !== first.organizationId))
        throw new PermissionRegistryRepositoryError("INVALID_PERMISSION_REGISTRY_COMMAND");
      return execute(async () => {
        const rows = await transaction.query<PermissionEntryRow>`
          select entry.*
          from pg_catalog.jsonb_to_recordset(${JSON.stringify(
            commands.map((command) => ({
              applicationRootId: command.applicationRootId ?? null,
              ownerKind: command.ownerKind,
              ownerId: command.ownerId,
              permissionId: command.permissionId,
            })),
          )}::jsonb) as requested(
            "applicationRootId" uuid,
            "ownerKind" text,
            "ownerId" uuid,
            "permissionId" uuid
          )
          cross join lateral vortex_access.read_available_permission(
            ${first.organizationId}::uuid,
            requested."applicationRootId",
            requested."ownerKind",
            requested."ownerId",
            requested."permissionId"
          ) as entry
        `;
        return rows.map((row) => parseEntry(row));
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
