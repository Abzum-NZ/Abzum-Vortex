import "server-only";

import {
  actorIdSchema,
  applicationRootIdSchema,
  definitionKindSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  platformIdSchema,
  revisionSchema,
  selectedOrganizationScopeSchema,
  semanticVersionSchema,
  storedDefinitionDraftSchema,
  storedModuleDefinitionDraftSchema,
  tenantIdSchema,
  timestampSchema,
  type SelectedOrganizationScope,
  type StoredDefinitionDraft,
} from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import { z } from "zod";
import { fingerprintCanonicalValue } from "./canonical-json-definition";
import { isDefinitionContextFailure } from "./definition-consumer-read-definition";
import { DefinitionError } from "./definition-error";

const draftReadCommandSchema = z
  .object({
    rootId: applicationRootIdSchema,
    expectedDraftRevision: revisionSchema.optional(),
  })
  .strict();

type ApplicationDefinitionDraftReadCommand = z.infer<typeof draftReadCommandSchema>;
export type StoredApplicationDefinitionDraft = Extract<
  StoredDefinitionDraft,
  { kind: "application" }
>;

const moduleDraftReadCommandSchema = z
  .object({
    rootId: moduleRootIdSchema,
    expectedDraftRevision: revisionSchema.optional(),
  })
  .strict();

type ModuleDefinitionDraftReadCommand = z.infer<typeof moduleDraftReadCommandSchema>;
export type StoredModuleDefinitionDraft = z.infer<typeof storedModuleDefinitionDraftSchema>;

// The protected context also contains trusted transport and identity evidence.
// Parse only the fields needed to bind this read to the resolved request scope.
const humanReadContextSchema = z
  .object({
    callerKind: z.literal("human"),
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    accessVersion: revisionSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strip();

const requiredJsonSchema = z.unknown().refine((value) => value !== undefined);
const draftReadRowSchema = z
  .object({ request_context: requiredJsonSchema, publication_state: requiredJsonSchema })
  .strict();
const publicationStateSchema = z
  .object({
    root: z
      .object({
        rootId: platformIdSchema,
        organizationId: organizationIdSchema,
        kind: definitionKindSchema,
        key: namespacedKeySchema,
        currentReleaseRevision: revisionSchema.nullable(),
        createdAt: timestampSchema,
        createdBy: actorIdSchema,
      })
      .strict(),
    draft: requiredJsonSchema,
    historyLatestReleaseRevision: revisionSchema.nullable(),
    historyLatestReleaseVersion: semanticVersionSchema.nullable(),
    identities: z.array(requiredJsonSchema),
  })
  .strict();

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const hasMatchingLiveContext = (candidate: unknown, scope: SelectedOrganizationScope): boolean => {
  const parsed = humanReadContextSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const context = parsed.data;
  const issuedAt = Date.parse(context.issuedAt);
  const expiresAt = Date.parse(context.expiresAt);
  const now = Date.now();
  return (
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    issuedAt <= now &&
    expiresAt > now &&
    issuedAt < expiresAt &&
    sameUuid(context.tenantId, scope.tenantId) &&
    sameUuid(context.organizationId, scope.organizationId) &&
    sameUuid(context.organizationAccountId, scope.organizationAccountId) &&
    context.accessVersion === scope.accessVersion &&
    (scope.applicationRootId === undefined
      ? context.applicationRootId === undefined
      : context.applicationRootId !== undefined &&
        sameUuid(context.applicationRootId, scope.applicationRootId))
  );
};

const normalizeStoredDraft = (candidate: unknown): unknown => {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
    return candidate;
  const draft = candidate as Record<string, unknown>;
  if (!Object.hasOwn(draft, "publishedRevision") || draft.publishedRevision === undefined)
    throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  if (draft.publishedRevision !== null) return candidate;
  return Object.fromEntries(Object.entries(draft).filter(([key]) => key !== "publishedRevision"));
};

type DraftReadRow = DatabaseRow & { request_context: unknown; publication_state: unknown };

/**
 * Reads the current authored Application draft on an already authenticated human
 * organization transaction. Its real revision is evidence for the next save,
 * not a write lock or permission to save after a concurrent change.
 */
export const readApplicationDefinitionDraft = async (
  transaction: RequestDatabaseTransaction,
  serverResolvedScope: SelectedOrganizationScope,
  commandCandidate: ApplicationDefinitionDraftReadCommand,
): Promise<StoredApplicationDefinitionDraft> => {
  const command = draftReadCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new DefinitionError("INVALID_DEFINITION_COMMAND");
  const scope = selectedOrganizationScopeSchema.safeParse(serverResolvedScope);
  if (
    !scope.success ||
    (scope.data.applicationRootId !== undefined &&
      !sameUuid(scope.data.applicationRootId, command.data.rootId))
  )
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");

  let rows: readonly DraftReadRow[];
  try {
    rows = await transaction.query<DraftReadRow>`
      select
        vortex_access.validated_human_request_context() as request_context,
        vortex_definition.read_publication_state(${command.data.rootId}) as publication_state
    `;
  } catch (error) {
    if (isDefinitionContextFailure(error)) throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "23503" &&
      error.message === "A Definition root requires its current draft"
    )
      throw new DefinitionError("DEFINITION_ROOT_MISSING");
    throw new DefinitionError("DEFINITION_STORAGE_FAILED");
  }

  if (rows.length !== 1) throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  const row = draftReadRowSchema.safeParse(rows[0]);
  if (!row.success) throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  if (!hasMatchingLiveContext(row.data.request_context, scope.data))
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  if (row.data.publication_state === null) throw new DefinitionError("DEFINITION_ROOT_MISSING");

  const state = publicationStateSchema.safeParse(row.data.publication_state);
  if (!state.success) throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  const root = state.data.root;
  if (!sameUuid(root.organizationId, scope.data.organizationId))
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  if (root.kind !== "application") throw new DefinitionError("DEFINITION_ROOT_MISSING");
  const parsedDraft = storedDefinitionDraftSchema.safeParse(normalizeStoredDraft(state.data.draft));
  if (!parsedDraft.success) throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  const draft = parsedDraft.data;
  if (
    draft.kind !== "application" ||
    !sameUuid(root.rootId, command.data.rootId) ||
    !sameUuid(draft.rootId, root.rootId) ||
    !sameUuid(draft.organizationId, root.organizationId) ||
    draft.key !== root.key ||
    draft.source.kind !== draft.kind ||
    draft.source.key !== draft.key ||
    (draft.publishedRevision ?? null) !== root.currentReleaseRevision ||
    draft.createdAt !== root.createdAt ||
    !sameUuid(draft.createdBy, root.createdBy) ||
    fingerprintCanonicalValue(draft.source) !== draft.sourceFingerprint
  )
    throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  if (
    command.data.expectedDraftRevision !== undefined &&
    command.data.expectedDraftRevision !== draft.draftRevision
  )
    throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
  return draft;
};

/** Rechecks the exact saved revision without transferring or parsing its source again. */
export const requireApplicationDefinitionDraftConsistency = async (
  transaction: RequestDatabaseTransaction,
  serverResolvedScope: SelectedOrganizationScope,
  draft: StoredApplicationDefinitionDraft,
): Promise<void> => {
  const scope = selectedOrganizationScopeSchema.parse(serverResolvedScope);
  if (
    !sameUuid(scope.organizationId, draft.organizationId) ||
    (scope.applicationRootId !== undefined && !sameUuid(scope.applicationRootId, draft.rootId))
  )
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  const rows = await transaction.query`
    select vortex_access.validated_human_request_context() as request_context,
      vortex_definition.read_application_draft_consistency(
        ${draft.rootId}::uuid, ${draft.draftRevision}::bigint,
        ${draft.sourceFingerprint}::text, ${draft.publishedRevision ?? null}::bigint
      ) as consistency
  `;
  const row = z
    .object({
      request_context: requiredJsonSchema,
      consistency: z
        .object({
          draftRevision: revisionSchema,
          sourceFingerprint: fingerprintSchema,
          publishedRevision: revisionSchema.nullable(),
        })
        .strict()
        .nullable(),
    })
    .strict()
    .safeParse(rows[0]);
  if (rows.length !== 1 || !row.success)
    throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT", {
      cause: row.success ? rows.length : row.error,
    });
  if (!hasMatchingLiveContext(row.data.request_context, scope))
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  const current = row.data.consistency;
  if (
    current === null ||
    current.draftRevision !== draft.draftRevision ||
    current.sourceFingerprint !== draft.sourceFingerprint ||
    current.publishedRevision !== (draft.publishedRevision ?? null)
  )
    throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
};

/**
 * Reads one current authored Module draft on the caller's resolved human
 * organization-only transaction. This revision is evidence for a later save;
 * the read neither changes the draft nor authorizes or locks that later write.
 */
export const readModuleDefinitionDraft = async (
  transaction: RequestDatabaseTransaction,
  serverResolvedScope: SelectedOrganizationScope,
  commandCandidate: ModuleDefinitionDraftReadCommand,
): Promise<StoredModuleDefinitionDraft> => {
  const command = moduleDraftReadCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new DefinitionError("INVALID_DEFINITION_COMMAND");
  const scope = selectedOrganizationScopeSchema.safeParse(serverResolvedScope);
  if (!scope.success || Object.hasOwn(scope.data, "applicationRootId"))
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");

  let rows: readonly DraftReadRow[];
  try {
    rows = await transaction.query<DraftReadRow>`
      select
        vortex_access.validated_human_request_context() as request_context,
        vortex_definition.read_publication_state(${command.data.rootId}) as publication_state
    `;
  } catch (error) {
    if (isDefinitionContextFailure(error)) throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "23503" &&
      error.message === "A Definition root requires its current draft"
    )
      throw new DefinitionError("DEFINITION_ROOT_MISSING");
    throw new DefinitionError("DEFINITION_STORAGE_FAILED");
  }

  if (rows.length !== 1) throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  const row = draftReadRowSchema.safeParse(rows[0]);
  if (!row.success) throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  const context = humanReadContextSchema.safeParse(row.data.request_context);
  if (
    !context.success ||
    Object.hasOwn(context.data, "applicationRootId") ||
    !hasMatchingLiveContext(row.data.request_context, scope.data)
  )
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  if (row.data.publication_state === null) throw new DefinitionError("DEFINITION_ROOT_MISSING");

  const state = publicationStateSchema.safeParse(row.data.publication_state);
  if (!state.success) throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  const root = state.data.root;
  if (!sameUuid(root.organizationId, scope.data.organizationId))
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  if (root.kind !== "module") throw new DefinitionError("DEFINITION_ROOT_MISSING");
  // The kind-specific schema accepts only the current Module source contract.
  const parsedDraft = storedModuleDefinitionDraftSchema.safeParse(
    normalizeStoredDraft(state.data.draft),
  );
  if (!parsedDraft.success) throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  const draft = parsedDraft.data;
  if (
    !sameUuid(root.rootId, command.data.rootId) ||
    !sameUuid(draft.rootId, root.rootId) ||
    !sameUuid(draft.organizationId, root.organizationId) ||
    draft.key !== root.key ||
    draft.source.kind !== root.kind ||
    draft.source.key !== draft.key ||
    (draft.publishedRevision ?? null) !== root.currentReleaseRevision ||
    draft.createdAt !== root.createdAt ||
    !sameUuid(draft.createdBy, root.createdBy) ||
    Date.parse(draft.updatedAt) < Date.parse(draft.createdAt) ||
    fingerprintCanonicalValue(draft.source) !== draft.sourceFingerprint
  )
    throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
  if (
    command.data.expectedDraftRevision !== undefined &&
    command.data.expectedDraftRevision !== draft.draftRevision
  )
    throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
  if (!hasMatchingLiveContext(row.data.request_context, scope.data))
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  return draft;
};
