import "server-only";

import { z } from "zod";
import {
  canonicalJson,
  createDefinitionRootCommandSchema,
  saveDefinitionDraftCommandSchema,
  storedDefinitionDraftSchema,
  type StoredDefinitionDraft,
} from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import { requireBuilderAuthority, type BuilderAuthority } from "./builder-authority";
import { fingerprintCanonicalJson } from "./canonical-json-definition";
import { extractStoredSourceIdentityRequirements } from "./source-identities";
import { identityRetiredFailure } from "./identity-retired";
import { validateDefinitionSource } from "./validation";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import {
  DefinitionError,
  classifyDatabaseError,
  unexpectedDefinitionFailure,
} from "./definition-error";

export const definitionStoreErrorCodes = [
  "INVALID_DEFINITION_COMMAND",
  "INVALID_DEFINITION_SOURCE",
  "INVALID_DEFINITION_STORAGE_RESULT",
  "DEFINITION_DRAFT_STALE_OR_MISSING",
  "DEFINITION_ROOT_ALREADY_EXISTS",
  "DEFINITION_ROOT_MISSING",
  "DEFINITION_IDENTITY_ALIAS_CONFLICT",
  "DEFINITION_IDENTITY_RETIRED",
  "DEFINITION_CONTEXT_REFUSED",
  "DEFINITION_STORAGE_VALIDATION_FAILED",
  "DEFINITION_STORAGE_FAILED",
] as const;

export type DefinitionStoreErrorCode = (typeof definitionStoreErrorCodes)[number];

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
    throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
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
  if (!result.success) throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  return result.data;
};

const sourceFailureDetail = (validation: ReturnType<typeof validateDefinitionSource>): string => {
  const first = validation.failures[0]!;
  const path =
    first.location?.segments.map((segment) => `${segment.kind}:${segment.key}`).join("/") ??
    "source";
  return `${path}: ${first.family} (${first.ruleCode})`;
};

const prepareSource = (candidate: unknown, permissions: PlatformPermissionSource) => {
  const validation = validateDefinitionSource(candidate, permissions);
  const source = validation.source;
  if (!validation.valid || source === undefined)
    throw new DefinitionError("INVALID_DEFINITION_SOURCE", {
      detail: sourceFailureDetail(validation),
    });
  // Only an Application has a draft; Modules are edited inside their owning Application.
  if (source.kind !== "application") throw new DefinitionError("INVALID_DEFINITION_COMMAND");
  const canonicalSource = canonicalJson(source);
  return {
    source,
    canonicalSource,
    sourceFingerprint: fingerprintCanonicalJson(canonicalSource),
    identityRequirements: extractStoredSourceIdentityRequirements(source),
  };
};

// Parse command metadata without parsing its source a second time. These are private envelopes;
// the public store methods always pass the unknown source through prepareSource.
const createCommandEnvelope = createDefinitionRootCommandSchema.extend({ source: z.unknown() });
const saveCommandEnvelope = saveDefinitionDraftCommandSchema.extend({ source: z.unknown() });

const verifyStoredSource = (
  row: StoredDraftRow,
  prepared: ReturnType<typeof prepareSource>,
): StoredDefinitionDraft => {
  const draft = parseStoredDraft(row);
  if (
    draft.kind !== prepared.source.kind ||
    draft.key !== prepared.source.key ||
    draft.sourceContractVersion !== prepared.source.source_contract_version ||
    draft.sourceFingerprint !== prepared.sourceFingerprint ||
    canonicalJson(draft.source) !== prepared.canonicalSource
  )
    throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  return draft;
};

const commandIssueDetail = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return "command: invalid value";
  const path = issue.path.map(String).join(".") || "command";
  return `${path}: ${issue.message}`;
};

type DefinitionStoreOperation = "create_root" | "save_draft";

const safeStoreOperation = async <Result>(
  operationKind: DefinitionStoreOperation,
  operation: () => Promise<Result>,
  source?: unknown,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DefinitionError) throw error;
    const retired = identityRetiredFailure(error, source);
    if (retired !== undefined) throw retired;
    const cause = { cause: error };
    switch (classifyDatabaseError(error)) {
      case "conflict":
        throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING", cause);
      case "duplicate":
        throw new DefinitionError(
          operationKind === "create_root"
            ? "DEFINITION_ROOT_ALREADY_EXISTS"
            : "DEFINITION_IDENTITY_ALIAS_CONFLICT",
          cause,
        );
      case "refused":
        throw new DefinitionError("DEFINITION_CONTEXT_REFUSED", cause);
      case "reference_missing":
        throw new DefinitionError(
          operationKind === "create_root"
            ? "DEFINITION_CONTEXT_REFUSED"
            : "DEFINITION_ROOT_MISSING",
          cause,
        );
      case "invalid":
        if (
          operationKind === "save_draft" &&
          error instanceof Error &&
          error.message === "Definition draft write source is invalid"
        )
          throw new DefinitionError("INVALID_DEFINITION_SOURCE", cause);
        throw new DefinitionError("DEFINITION_STORAGE_VALIDATION_FAILED", cause);
      case "constraint_failed":
        throw new DefinitionError("DEFINITION_STORAGE_VALIDATION_FAILED", cause);
      default:
        throw unexpectedDefinitionFailure(
          "DEFINITION_STORAGE_FAILED",
          error,
          "definition store " + operationKind,
        );
    }
  }
};

export type TrustedApplicationRootOriginKind = "ordinary" | "platform_system_application";

type RootCreationMode =
  | Readonly<{ kind: "ordinary" }>
  | Readonly<{
      kind: "trusted_application";
      applicationOriginKind: TrustedApplicationRootOriginKind;
    }>;

/**
 * Every draft change requires `definition_drafts.manage` (and `system_applications.manage` for a
 * system application), decided by the builder authority before anything is stored. The authority
 * is a required argument, so no draft-change path can skip the check.
 */
export const createDefinitionStore = (
  transaction: RequestDatabaseTransaction,
  authority: BuilderAuthority,
  permissions: PlatformPermissionSource,
) => {
  const createRoot = async (
    candidate: unknown,
    mode: RootCreationMode,
  ): Promise<StoredDefinitionDraft> => {
    await requireBuilderAuthority(authority, { kind: "draft_change" });
    return safeStoreOperation("create_root", async () => {
      const command = createCommandEnvelope.safeParse(candidate);
      if (!command.success) {
        throw new DefinitionError("INVALID_DEFINITION_COMMAND", {
          detail: commandIssueDetail(command.error),
        });
      }
      const prepared = prepareSource(command.data.source, permissions);
      const { source, canonicalSource, sourceFingerprint, identityRequirements } = prepared;
      if (
        mode.kind === "trusted_application" &&
        (source.kind !== "application" ||
          (mode.applicationOriginKind !== "ordinary" &&
            mode.applicationOriginKind !== "platform_system_application"))
      )
        throw new DefinitionError("INVALID_DEFINITION_COMMAND");
      const applicationOriginKind =
        mode.kind === "trusted_application" ? mode.applicationOriginKind : "ordinary";
      const rows = await transaction.query<StoredDraftRow>`
        select *
        from vortex_definition.create_root(
          ${source.kind},
          ${source.key},
          ${canonicalSource}::text::jsonb,
          ${sourceFingerprint},
          ${JSON.stringify(identityRequirements)}::text::jsonb,
          ${applicationOriginKind}::text,
          ${null}::uuid
        )
      `;
      if (rows.length !== 1) throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
      return verifyStoredSource(rows[0]!, prepared);
    });
  };

  return {
    createRoot: (candidate: unknown): Promise<StoredDefinitionDraft> =>
      createRoot(candidate, { kind: "ordinary" }),

    /** Trusted server descriptors supply provenance separately from the strict public command. */
    createTrustedApplicationRoot: (
      candidate: unknown,
      applicationOriginKind: TrustedApplicationRootOriginKind,
    ): Promise<StoredDefinitionDraft> =>
      createRoot(candidate, { kind: "trusted_application", applicationOriginKind }),

    async saveDraft(candidate: unknown): Promise<StoredDefinitionDraft> {
      const rootId = saveDefinitionDraftCommandSchema.pick({ rootId: true }).safeParse({
        rootId:
          typeof candidate === "object" && candidate !== null
            ? (candidate as { rootId?: unknown }).rootId
            : undefined,
      });
      if (!rootId.success) throw new DefinitionError("INVALID_DEFINITION_COMMAND");
      await requireBuilderAuthority(authority, {
        kind: "draft_change",
        rootId: rootId.data.rootId,
      });
      const command = saveCommandEnvelope.safeParse(candidate);
      if (!command.success) {
        throw new DefinitionError("INVALID_DEFINITION_COMMAND", {
          detail: commandIssueDetail(command.error),
        });
      }
      return safeStoreOperation(
        "save_draft",
        async () => {
          const prepared = prepareSource(command.data.source, permissions);
          const { canonicalSource, sourceFingerprint, identityRequirements } = prepared;
          const rows = await transaction.query<StoredDraftRow>`
          select *
          from vortex_definition.save_draft(
            ${command.data.rootId},
            ${command.data.expectedDraftRevision},
            ${canonicalSource}::text::jsonb,
            ${sourceFingerprint},
            ${JSON.stringify(identityRequirements)}::text::jsonb
          )
        `;
          if (rows.length === 0) throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
          if (rows.length !== 1) throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
          return verifyStoredSource(rows[0]!, prepared);
        },
        command.data.source,
      );
    },
  };
};
