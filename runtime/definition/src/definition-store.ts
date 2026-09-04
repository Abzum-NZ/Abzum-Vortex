import "server-only";

import {
  createDefinitionRootCommandSchema,
  saveDefinitionDraftCommandSchema,
  storedDefinitionDraftSchema,
  type CreateDefinitionRootCommand,
  type SaveDefinitionDraftCommand,
  type SessionContext,
  type StoredDefinitionDraft,
} from "@vortex/contracts";
import {
  withRequestTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "@vortex/db";
import { fingerprintCanonicalValue } from "./canonical-json";
import { extractSourceIdentityRequirements } from "./source-identities";
import { validateDefinitionSource } from "./validation";

export const definitionStoreErrorCodes = [
  "INVALID_DEFINITION_COMMAND",
  "INVALID_DEFINITION_SOURCE",
  "INVALID_DEFINITION_STORAGE_RESULT",
  "DEFINITION_DRAFT_STALE_OR_MISSING",
  "DEFINITION_ROOT_ALREADY_EXISTS",
  "DEFINITION_ROOT_MISSING",
  "DEFINITION_IDENTITY_ALIAS_CONFLICT",
  "DEFINITION_CONTEXT_REFUSED",
  "DEFINITION_STORAGE_VALIDATION_FAILED",
  "DEFINITION_STORAGE_FAILED",
] as const;

export type DefinitionStoreErrorCode = (typeof definitionStoreErrorCodes)[number];

export class DefinitionStoreError extends Error {
  readonly code: DefinitionStoreErrorCode;

  constructor(code: DefinitionStoreErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "DefinitionStoreError";
    this.code = code;
  }
}

type DefinitionTransactionRunner = <Result>(
  context: SessionContext,
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

type StoredDraftRow = DatabaseRow & {
  root_id: unknown;
  organization_id: unknown;
  kind: unknown;
  definition_key: unknown;
  draft_revision: unknown;
  published_revision: unknown;
  authored_source: unknown;
  source_contract_version: unknown;
  source_fingerprint: unknown;
  created_at: unknown;
  created_by: unknown;
  updated_at: unknown;
  updated_by: unknown;
  restored_from_release_revision?: unknown;
  restored_from_source_fingerprint?: unknown;
  restored_by?: unknown;
  restored_at?: unknown;
  restore_correlation_id?: unknown;
};

const parseRevision = (value: unknown): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const parseTimestamp = (value: unknown): string | undefined => {
  if (value instanceof Date && Number.isFinite(value.valueOf())) return value.toISOString();
  return typeof value === "string" ? value : undefined;
};

const parseStoredDraft = (row: StoredDraftRow): StoredDefinitionDraft => {
  const rawRestoreProvenance = [
    row.restored_from_release_revision,
    row.restored_from_source_fingerprint,
    row.restored_by,
    row.restored_at,
    row.restore_correlation_id,
  ];
  const hasRestoreProvenance = rawRestoreProvenance.some(
    (value) => value !== null && value !== undefined,
  );
  const restoredFromReleaseRevision = parseRevision(row.restored_from_release_revision);
  const restoredFromSourceFingerprint = row.restored_from_source_fingerprint;
  const restoredBy = row.restored_by;
  const restoredAt = parseTimestamp(row.restored_at);
  const restoreCorrelationId = row.restore_correlation_id;
  if (
    (row.restored_from_release_revision !== null &&
      row.restored_from_release_revision !== undefined &&
      restoredFromReleaseRevision === undefined) ||
    (row.restored_at !== null && row.restored_at !== undefined && restoredAt === undefined)
  )
    throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
  const result = storedDefinitionDraftSchema.safeParse({
    rootId: row.root_id,
    organizationId: row.organization_id,
    kind: row.kind,
    key: row.definition_key,
    draftRevision: parseRevision(row.draft_revision),
    ...(row.published_revision === null || row.published_revision === undefined
      ? {}
      : { publishedRevision: parseRevision(row.published_revision) }),
    source: row.authored_source,
    sourceContractVersion: row.source_contract_version,
    sourceFingerprint: row.source_fingerprint,
    createdAt: parseTimestamp(row.created_at),
    createdBy: row.created_by,
    updatedAt: parseTimestamp(row.updated_at),
    updatedBy: row.updated_by,
    ...(hasRestoreProvenance
      ? {
          restoredFromReleaseRevision,
          restoredFromSourceFingerprint,
          restoredBy,
          restoredAt,
          restoreCorrelationId,
        }
      : {}),
  });
  if (!result.success) throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
  return result.data;
};

const validateSource = (source: CreateDefinitionRootCommand["source"]) => {
  const validation = validateDefinitionSource(source);
  if (!validation.valid) throw new DefinitionStoreError("INVALID_DEFINITION_SOURCE");
  return source;
};

type DefinitionStoreOperation = "create_root" | "save_draft";

const safeStoreOperation = async <Result>(
  operationKind: DefinitionStoreOperation,
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DefinitionStoreError) throw error;
    const databaseCode =
      error !== null && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
    if (databaseCode === "40001")
      throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
    if (databaseCode === "23505")
      throw new DefinitionStoreError(
        operationKind === "create_root"
          ? "DEFINITION_ROOT_ALREADY_EXISTS"
          : "DEFINITION_IDENTITY_ALIAS_CONFLICT",
      );
    if (databaseCode === "42501") throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
    if (databaseCode === "23503")
      throw new DefinitionStoreError(
        operationKind === "create_root" ? "DEFINITION_CONTEXT_REFUSED" : "DEFINITION_ROOT_MISSING",
      );
    if (databaseCode === "22023" || databaseCode === "23514")
      throw new DefinitionStoreError("DEFINITION_STORAGE_VALIDATION_FAILED");
    throw new DefinitionStoreError("DEFINITION_STORAGE_FAILED");
  }
};

export const createDefinitionStore = (
  runInTransaction: DefinitionTransactionRunner = withRequestTransaction,
) => ({
  async createRoot(
    context: SessionContext,
    candidate: CreateDefinitionRootCommand,
  ): Promise<StoredDefinitionDraft> {
    return safeStoreOperation("create_root", async () => {
      const command = createDefinitionRootCommandSchema.safeParse(candidate);
      if (!command.success) throw new DefinitionStoreError("INVALID_DEFINITION_COMMAND");
      const source = validateSource(command.data.source);
      const sourceFingerprint = fingerprintCanonicalValue(source);
      const identityRequirements = extractSourceIdentityRequirements(source);
      return runInTransaction(context, async (transaction) => {
        const rows = await transaction.query<StoredDraftRow>`
          select *
          from vortex_definition.create_root(
            ${source.kind},
            ${source.key},
            ${JSON.stringify(source)},
            ${sourceFingerprint},
            ${JSON.stringify(identityRequirements)}
          )
        `;
        if (rows.length !== 1) throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
        return parseStoredDraft(rows[0]!);
      });
    });
  },

  async saveDraft(
    context: SessionContext,
    candidate: SaveDefinitionDraftCommand,
  ): Promise<StoredDefinitionDraft> {
    return safeStoreOperation("save_draft", async () => {
      const command = saveDefinitionDraftCommandSchema.safeParse(candidate);
      if (!command.success) throw new DefinitionStoreError("INVALID_DEFINITION_COMMAND");
      const source = validateSource(command.data.source);
      const sourceFingerprint = fingerprintCanonicalValue(source);
      const identityRequirements = extractSourceIdentityRequirements(source);
      return runInTransaction(context, async (transaction) => {
        const rows = await transaction.query<StoredDraftRow>`
          select *
          from vortex_definition.save_draft(
            ${command.data.rootId},
            ${command.data.expectedDraftRevision},
            ${JSON.stringify(source)},
            ${sourceFingerprint},
            ${JSON.stringify(identityRequirements)}
          )
        `;
        if (rows.length === 0) throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
        if (rows.length !== 1) throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
        return parseStoredDraft(rows[0]!);
      });
    });
  },
});

const definitionStore = createDefinitionStore();

export const createDefinitionRoot = definitionStore.createRoot;
export const saveDefinitionDraft = definitionStore.saveDraft;
