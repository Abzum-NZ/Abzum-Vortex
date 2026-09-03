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
import { validateDefinitionSource } from "./validation";

export const definitionStoreErrorCodes = [
  "INVALID_DEFINITION_COMMAND",
  "INVALID_DEFINITION_SOURCE",
  "INVALID_DEFINITION_STORAGE_RESULT",
  "DEFINITION_DRAFT_STALE_OR_MISSING",
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
  });
  if (!result.success) throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
  return result.data;
};

const validateSource = (source: CreateDefinitionRootCommand["source"]) => {
  const validation = validateDefinitionSource(source);
  if (!validation.valid) throw new DefinitionStoreError("INVALID_DEFINITION_SOURCE");
  return source;
};

export const createDefinitionStore = (
  runInTransaction: DefinitionTransactionRunner = withRequestTransaction,
) => ({
  async createRoot(
    context: SessionContext,
    candidate: CreateDefinitionRootCommand,
  ): Promise<StoredDefinitionDraft> {
    const command = createDefinitionRootCommandSchema.safeParse(candidate);
    if (!command.success) throw new DefinitionStoreError("INVALID_DEFINITION_COMMAND");
    const source = validateSource(command.data.source);
    const sourceFingerprint = fingerprintCanonicalValue(source);
    return runInTransaction(context, async (transaction) => {
      const rows = await transaction.query<StoredDraftRow>`
        select *
        from vortex_definition.create_root(
          ${source.kind},
          ${source.key},
          ${JSON.stringify(source)},
          ${sourceFingerprint}
        )
      `;
      if (rows.length !== 1) throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
      return parseStoredDraft(rows[0]!);
    });
  },

  async saveDraft(
    context: SessionContext,
    candidate: SaveDefinitionDraftCommand,
  ): Promise<StoredDefinitionDraft> {
    const command = saveDefinitionDraftCommandSchema.safeParse(candidate);
    if (!command.success) throw new DefinitionStoreError("INVALID_DEFINITION_COMMAND");
    const source = validateSource(command.data.source);
    const sourceFingerprint = fingerprintCanonicalValue(source);
    return runInTransaction(context, async (transaction) => {
      const rows = await transaction.query<StoredDraftRow>`
        select *
        from vortex_definition.save_draft(
          ${command.data.rootId},
          ${command.data.expectedDraftRevision},
          ${JSON.stringify(source)},
          ${sourceFingerprint}
        )
      `;
      if (rows.length === 0) throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
      if (rows.length !== 1) throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
      return parseStoredDraft(rows[0]!);
    });
  },
});

const definitionStore = createDefinitionStore();

export const createDefinitionRoot = definitionStore.createRoot;
export const saveDefinitionDraft = definitionStore.saveDraft;
