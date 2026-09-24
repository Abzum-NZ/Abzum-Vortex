import "server-only";

import {
  definitionValidationCatalogueVersion,
  definitionValidationErrorCatalogue,
  namespacedKeySchema,
  publicDefinitionValidationErrorSchema,
  translateDefinitionRuleFailures,
  type DefinitionConsumerReadResult,
  type DefinitionReleaseHistoryResult,
  type DefinitionReleaseMetadataResult,
  type DefinitionValidationErrorCode,
  type DefinitionValidationLocation,
  type PrepareDefinitionPublicationResult,
  type PublicDefinitionValidationError,
  type PublishDefinitionResult,
  type SessionContext,
  type StoredDefinitionDraft,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";
import { DefinitionConsumerReadError } from "./definition-consumer-read";
import { createDatabaseDefinitionConsumerReadService } from "./definition-consumer-read-composition";
import { DefinitionHistoryError } from "./definition-history";
import { createDatabaseDefinitionHistoryService } from "./definition-history-composition";
import { DefinitionPublicationError } from "./definition-publication";
import { createDatabaseDefinitionPublicationService } from "./definition-publication-composition";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./definition-publication-catalogue";
import { DefinitionStoreError, createDefinitionStore } from "./definition-store";
import { validateDefinitionSource } from "./validation";

/**
 * The headless Application editing lifecycle: create, save, validate, prepare, publish, history,
 * exact-release read and restore.
 *
 * This is a composition of the existing Definition store, publication, history and consumer-read
 * services. It owns no storage, holds no authority of its own and never reads the caller's
 * request for identity or permission: every operation runs as the supplied session context over
 * the caller's already-bound database transaction.
 *
 * Installation is deliberately outside this surface. No operation here accepts, reads or writes
 * an installation, so publishing or restoring an Application can only append a release or write a
 * new draft; an installed Application keeps the exact release it was installed at until a
 * separate installation operation moves it.
 */

export type ApplicationLifecycleOperation =
  | "create"
  | "save"
  | "validate"
  | "prepare"
  | "publish"
  | "history"
  | "release_metadata"
  | "read"
  | "restore";

export type ApplicationLifecycleRefusalReason =
  | "invalid_request"
  | "invalid_source"
  | "stale_revision"
  | "not_found"
  | "missing_dependency"
  | "incompatible_dependency"
  | "compilation_refused"
  | "version_refused"
  | "context_refused"
  | "already_exists"
  | "failed";

/**
 * A safe, catalogue-worded refusal. Every error carries the versioned public text and, where the
 * caller supplied the source being judged, the located document path that caused it. Nothing here
 * carries storage detail, dependency evidence or unpublished content.
 */
export type ApplicationLifecycleRefusal = Readonly<{
  operation: ApplicationLifecycleOperation;
  reason: ApplicationLifecycleRefusalReason;
  rootId?: string;
  correlationId: string;
  errors: readonly PublicDefinitionValidationError[];
}>;

export type ApplicationLifecycleResult<Value> =
  | Readonly<{ status: "ok"; value: Value }>
  | Readonly<{ status: "refused"; refusal: ApplicationLifecycleRefusal }>;

const catalogueCodeByReason: Readonly<
  Record<ApplicationLifecycleRefusalReason, DefinitionValidationErrorCode>
> = {
  invalid_request: "definition_invalid_value",
  invalid_source: "definition_invalid_value",
  stale_revision: "definition_incompatible_change",
  not_found: "definition_unresolved_reference",
  missing_dependency: "definition_unresolved_reference",
  incompatible_dependency: "definition_incompatible_version",
  compilation_refused: "definition_validation_failed",
  version_refused: "definition_incompatible_change",
  context_refused: "definition_scope_conflict",
  already_exists: "definition_duplicate_key",
  failed: "definition_validation_failed",
};

const reasonByCode: Readonly<Record<string, ApplicationLifecycleRefusalReason>> = {
  INVALID_DEFINITION_COMMAND: "invalid_request",
  INVALID_DEFINITION_SOURCE: "invalid_source",
  INVALID_DEFINITION_STORAGE_RESULT: "failed",
  DEFINITION_DRAFT_STALE_OR_MISSING: "stale_revision",
  DEFINITION_ROOT_ALREADY_EXISTS: "already_exists",
  DEFINITION_ROOT_MISSING: "not_found",
  DEFINITION_IDENTITY_ALIAS_CONFLICT: "already_exists",
  DEFINITION_CONTEXT_REFUSED: "context_refused",
  DEFINITION_STORAGE_VALIDATION_FAILED: "invalid_source",
  DEFINITION_STORAGE_FAILED: "failed",
  INVALID_DEFINITION_PUBLICATION_COMMAND: "invalid_request",
  DEFINITION_ORGANIZATION_MISMATCH: "context_refused",
  DEFINITION_SOURCE_EVIDENCE_MISMATCH: "stale_revision",
  DEFINITION_HISTORY_INVALID: "failed",
  DEFINITION_DEPENDENCY_MISSING: "missing_dependency",
  DEFINITION_DEPENDENCY_PRERELEASE_ONLY: "incompatible_dependency",
  DEFINITION_DEPENDENCY_INCOMPATIBLE: "incompatible_dependency",
  DEFINITION_DEPENDENCY_AMBIGUOUS: "incompatible_dependency",
  DEFINITION_DEPENDENCY_SUBSTITUTED: "incompatible_dependency",
  DEFINITION_DEPENDENCY_CYCLE: "incompatible_dependency",
  DEFINITION_COMPILATION_REFUSED: "compilation_refused",
  DEFINITION_VERSION_REFUSED: "version_refused",
  DEFINITION_NO_CHANGE: "version_refused",
  DEFINITION_CONFIRMATION_MISMATCH: "stale_revision",
  DEFINITION_PUBLICATION_FAILED: "failed",
  INVALID_DEFINITION_HISTORY_COMMAND: "invalid_request",
  INVALID_DEFINITION_RESTORE_COMMAND: "invalid_request",
  INVALID_DEFINITION_HISTORY_RESULT: "failed",
  DEFINITION_HISTORY_NOT_FOUND: "not_found",
  DEFINITION_RELEASE_NOT_FOUND: "not_found",
  DEFINITION_RELEASE_INTEGRITY_FAILED: "failed",
  DEFINITION_HISTORY_FAILED: "failed",
  DEFINITION_RESTORE_FAILED: "failed",
  INVALID_DEFINITION_READ_COMMAND: "invalid_request",
  DEFINITION_READ_FAILED: "failed",
};

const dependencyCodeCatalogue: Readonly<Record<string, DefinitionValidationErrorCode>> = {
  DEFINITION_DEPENDENCY_CYCLE: "definition_dependency_cycle",
};

const publicError = (
  code: DefinitionValidationErrorCode,
  correlationId: string,
  location: DefinitionValidationLocation | undefined,
): PublicDefinitionValidationError => {
  const entry = definitionValidationErrorCatalogue[code];
  return publicDefinitionValidationErrorSchema.parse({
    catalogueVersion: definitionValidationCatalogueVersion,
    code,
    message: entry.message,
    guidance: entry.guidance,
    correlationId,
    ...(location === undefined ? {} : { location }),
  });
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The located application document, when the supplied source at least names its own key. */
const applicationLocation = (source: unknown): DefinitionValidationLocation | undefined => {
  const key = namespacedKeySchema.safeParse(record(source)?.key);
  return key.success
    ? {
        documentKind: "application",
        documentKey: key.data,
        segments: [{ kind: "application", key: key.data }],
      }
    : undefined;
};

const refuse = (
  operation: ApplicationLifecycleOperation,
  reason: ApplicationLifecycleRefusalReason,
  context: SessionContext,
  options: Readonly<{
    rootId?: string;
    errorCode?: DefinitionValidationErrorCode;
    location?: DefinitionValidationLocation;
  }> = {},
): ApplicationLifecycleResult<never> => ({
  status: "refused",
  refusal: {
    operation,
    reason,
    ...(options.rootId === undefined ? {} : { rootId: options.rootId }),
    correlationId: context.correlationId,
    errors: [
      publicError(
        options.errorCode ?? catalogueCodeByReason[reason],
        context.correlationId,
        options.location,
      ),
    ],
  },
});

const refuseFromError = (
  operation: ApplicationLifecycleOperation,
  error: unknown,
  context: SessionContext,
  options: Readonly<{ rootId?: string; location?: DefinitionValidationLocation }> = {},
): ApplicationLifecycleResult<never> => {
  const code =
    error instanceof DefinitionStoreError ||
    error instanceof DefinitionPublicationError ||
    error instanceof DefinitionHistoryError ||
    error instanceof DefinitionConsumerReadError
      ? error.code
      : undefined;
  const reason = (code === undefined ? undefined : reasonByCode[code]) ?? "failed";
  return refuse(operation, reason, context, {
    ...options,
    ...(code !== undefined && dependencyCodeCatalogue[code] !== undefined
      ? { errorCode: dependencyCodeCatalogue[code] }
      : {}),
  });
};

/** Runs one delegated service call and turns any thrown service error into a safe refusal. */
const run = async <Value>(
  operation: ApplicationLifecycleOperation,
  context: SessionContext,
  options: Readonly<{ rootId?: string; location?: DefinitionValidationLocation }>,
  call: () => Promise<Value>,
): Promise<ApplicationLifecycleResult<Value>> => {
  try {
    return { status: "ok", value: await call() };
  } catch (error) {
    return refuseFromError(operation, error, context, options);
  }
};

/**
 * Judges one authored Application source with the same edit-save rules the store applies,
 * including the immutable platform catalogue rule, and returns every located failure.
 */
const judgeSource = (
  operation: ApplicationLifecycleOperation,
  context: SessionContext,
  source: unknown,
): ApplicationLifecycleResult<undefined> => {
  const location = applicationLocation(source);
  if (record(source)?.kind !== "application")
    return refuse(operation, "invalid_source", context, {
      ...(location === undefined ? {} : { location }),
    });
  const validation = validateDefinitionSource(source);
  if (validation.valid) return { status: "ok", value: undefined };
  // A source that does not even name a valid key cannot be located; it is refused as a whole.
  if (location === undefined) return refuse(operation, "invalid_source", context);
  const errors = translateDefinitionRuleFailures(validation.failures, {
    correlationId: context.correlationId,
    rootLocation: location,
  }).errors;
  return {
    status: "refused",
    refusal: {
      operation,
      reason: "invalid_source",
      correlationId: context.correlationId,
      errors,
    },
  };
};

const sourceOf = (command: unknown): unknown => record(command)?.source;

const isApplicationDraft = (draft: StoredDefinitionDraft): boolean =>
  draft.kind === "application" && draft.source.kind === "application";

export type ApplicationLifecycleServices = Readonly<{
  store: ReturnType<typeof createDefinitionStore>;
  publication: ReturnType<typeof createDatabaseDefinitionPublicationService>;
  history: ReturnType<typeof createDatabaseDefinitionHistoryService>;
  consumerRead: ReturnType<typeof createDatabaseDefinitionConsumerReadService>;
}>;

/** Composes the lifecycle over already-built Definition services. */
export const createApplicationLifecycleService = (services: ApplicationLifecycleServices) => ({
  /** Creates a new Application root and its first draft. */
  async create(
    context: SessionContext,
    command: unknown,
  ): Promise<ApplicationLifecycleResult<StoredDefinitionDraft>> {
    const source = sourceOf(command);
    const judged = judgeSource("create", context, source);
    if (judged.status === "refused") return judged;
    const outcome = await run(
      "create",
      context,
      { ...locationOption(source) },
      () => services.store.createRoot(command as Parameters<typeof services.store.createRoot>[0]),
    );
    return outcome.status === "ok" && !isApplicationDraft(outcome.value)
      ? refuse("create", "failed", context)
      : outcome;
  },

  /** Saves a draft under an optimistic revision check; a stale revision is refused, never merged. */
  async save(
    context: SessionContext,
    command: unknown,
  ): Promise<ApplicationLifecycleResult<StoredDefinitionDraft>> {
    const source = sourceOf(command);
    const judged = judgeSource("save", context, source);
    if (judged.status === "refused") return judged;
    const rootId = record(command)?.rootId;
    const outcome = await run(
      "save",
      context,
      {
        ...locationOption(source),
        ...(typeof rootId === "string" ? { rootId } : {}),
      },
      () => services.store.saveDraft(command as Parameters<typeof services.store.saveDraft>[0]),
    );
    return outcome.status === "ok" && !isApplicationDraft(outcome.value)
      ? refuse("save", "failed", context)
      : outcome;
  },

  /** Reports every located source failure without storing anything. */
  validate(context: SessionContext, source: unknown): ApplicationLifecycleResult<undefined> {
    return judgeSource("validate", context, source);
  },

  /**
   * Compiles the current draft against its exact dependencies and returns the confirmation a
   * publication needs. A stale draft revision or a missing exact dependency is refused here.
   */
  async prepare(
    context: SessionContext,
    command: unknown,
  ): Promise<ApplicationLifecycleResult<PrepareDefinitionPublicationResult>> {
    const rootId = record(command)?.rootId;
    return run("prepare", context, typeof rootId === "string" ? { rootId } : {}, () =>
      services.publication.prepare(context, command),
    );
  },

  /** Publishes only the exact confirmation that `prepare` produced; it recomputes everything. */
  async publish(
    context: SessionContext,
    command: unknown,
  ): Promise<ApplicationLifecycleResult<PublishDefinitionResult>> {
    const rootId = record(record(command)?.confirmation)?.rootId;
    return run("publish", context, typeof rootId === "string" ? { rootId } : {}, () =>
      services.publication.publish(context, command),
    );
  },

  /** Lists an Application's immutable release history, newest first. */
  async listHistory(
    context: SessionContext,
    command: unknown,
  ): Promise<ApplicationLifecycleResult<DefinitionReleaseHistoryResult>> {
    return runApplicationKind("history", context, command, (candidate) =>
      services.history.list(context, candidate),
    );
  },

  /** Reads one exact release's safe metadata. */
  async readReleaseMetadata(
    context: SessionContext,
    command: unknown,
  ): Promise<ApplicationLifecycleResult<DefinitionReleaseMetadataResult>> {
    return runApplicationKind("release_metadata", context, command, (candidate) =>
      services.history.readMetadata(context, candidate),
    );
  },

  /** Reads one exact, verified release for a consumer. */
  async read(
    context: SessionContext,
    command: unknown,
  ): Promise<ApplicationLifecycleResult<DefinitionConsumerReadResult>> {
    return runApplicationKind("read", context, command, (candidate) =>
      services.consumerRead.read(context, candidate),
    );
  },

  /**
   * Restores an immutable release into a new draft revision with restore provenance. The release
   * itself and every installation stay as they are; the draft is then edited and published like
   * any other.
   */
  async restore(
    context: SessionContext,
    command: unknown,
  ): Promise<ApplicationLifecycleResult<StoredDefinitionDraft>> {
    const candidate = record(command);
    const rootId = typeof candidate?.rootId === "string" ? candidate.rootId : undefined;
    const targetReleaseRevision = candidate?.["targetReleaseRevision"];
    const expectedDraftRevision = candidate?.["expectedDraftRevision"];
    const outcome = await runApplicationKind("restore", context, command, (checked) =>
      services.history.restoreDraft(context, checked),
    );
    if (outcome.status === "refused") return outcome;
    const draft = outcome.value;
    if (
      !isApplicationDraft(draft) ||
      (rootId !== undefined && String(draft.rootId) !== rootId) ||
      draft.restoredFromReleaseRevision !== targetReleaseRevision ||
      typeof expectedDraftRevision !== "number" ||
      draft.draftRevision <= expectedDraftRevision
    )
      return refuse("restore", "failed", context, rootId === undefined ? {} : { rootId });
    return outcome;
  },
});

const locationOption = (source: unknown): { location?: DefinitionValidationLocation } => {
  const location = applicationLocation(source);
  return location === undefined ? {} : { location };
};

/** History, read and restore commands must name an Application root explicitly. */
const runApplicationKind = async <Value>(
  operation: ApplicationLifecycleOperation,
  context: SessionContext,
  command: unknown,
  call: (command: unknown) => Promise<Value>,
): Promise<ApplicationLifecycleResult<Value>> => {
  const candidate = record(command);
  const rootId = typeof candidate?.rootId === "string" ? candidate.rootId : undefined;
  if (candidate?.kind !== "application")
    return refuse(operation, "invalid_request", context, rootId === undefined ? {} : { rootId });
  return run(operation, context, rootId === undefined ? {} : { rootId }, () => call(command));
};

/** Builds the production lifecycle over one request transaction and the platform release catalogue. */
export const createDatabaseApplicationLifecycleService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
) =>
  createApplicationLifecycleService({
    store: createDefinitionStore(transaction),
    publication: createDatabaseDefinitionPublicationService(catalogueDefinition, transaction),
    history: createDatabaseDefinitionHistoryService(catalogueDefinition, transaction),
    consumerRead: createDatabaseDefinitionConsumerReadService(catalogueDefinition, transaction),
  });
