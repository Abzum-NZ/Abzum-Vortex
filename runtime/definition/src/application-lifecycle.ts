import "server-only";

import {
  applicationRootIdSchema,
  correlationIdSchema,
  definitionValidationCatalogueVersion,
  definitionValidationErrorCatalogue,
  namespacedKeySchema,
  publicDefinitionValidationErrorSchema,
  sessionContextSchema,
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
import { BuilderAuthorityError, type BuilderAuthority } from "./builder-authority";
import {
  DefinitionConsumerReadError,
  isLiveDefinitionSystemContext,
} from "./definition-consumer-read";
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
 * request for identity or permission: every storage operation requires a live system session
 * context and runs over the caller's transaction, which must already be bound to that context.
 *
 * Builder authority is not optional. Creating, saving, restoring, preparing and publishing each
 * require the builder permissions (`definition_drafts.manage` for a draft change,
 * `definition_releases.manage` for publication, plus `system_applications.manage` for a system
 * application), decided server-side by the required `BuilderAuthority` before anything is read or
 * written. The authority is bound to the caller's own selected organisation, which must be the
 * context's organisation. A refusal is thrown as the safe `BuilderAuthorityError` (a permission or
 * recent-authentication refusal, never a validation error) so the transaction rolls back.
 *
 * Installation is deliberately outside this surface. No operation here accepts, reads or writes
 * an installation, so publishing or restoring an Application can only append a release or write a
 * new draft revision; an installed Application keeps the exact release it was installed at until
 * a separate installation operation moves it.
 *
 * Outcomes come in two shapes. A refusal is returned: it is safe, catalogue-worded and located,
 * and it is only ever produced before any write, or after the database has already refused the
 * statement. A fault (an unreadable storage result, a broken integrity check or an unexpected
 * failure) is thrown as the delegated service's own safe error or an `ApplicationLifecycleError`,
 * so the caller's request transaction rolls back rather than committing a write it cannot trust.
 */

export const applicationLifecycleErrorCodes = [
  "APPLICATION_LIFECYCLE_CONTEXT_INVALID",
  "APPLICATION_LIFECYCLE_RESULT_INVALID",
  "APPLICATION_LIFECYCLE_FAILED",
] as const;

export type ApplicationLifecycleErrorCode = (typeof applicationLifecycleErrorCodes)[number];

/** A lifecycle fault. It carries only its code; it is never a caller-facing refusal. */
export class ApplicationLifecycleError extends Error {
  readonly code: ApplicationLifecycleErrorCode;

  constructor(code: ApplicationLifecycleErrorCode) {
    super(code);
    this.name = "ApplicationLifecycleError";
    this.code = code;
  }
}

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
  | "already_exists";

/**
 * A safe, catalogue-worded refusal. Every error carries the versioned public text and, where the
 * Application document is known, its location: the supplied source for create, save and
 * validate, and the addressed Application root for prepare, publish and restore. Nothing here
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
  stale_revision: "definition_validation_failed",
  not_found: "definition_unresolved_reference",
  missing_dependency: "definition_unresolved_reference",
  incompatible_dependency: "definition_incompatible_version",
  compilation_refused: "definition_validation_failed",
  version_refused: "definition_incompatible_change",
  context_refused: "definition_scope_conflict",
  already_exists: "definition_duplicate_key",
};

/** Service codes that are refusals. Every other service code is a fault and is rethrown. */
const reasonByCode: Readonly<Record<string, ApplicationLifecycleRefusalReason>> = {
  INVALID_DEFINITION_COMMAND: "invalid_request",
  INVALID_DEFINITION_SOURCE: "invalid_source",
  DEFINITION_DRAFT_STALE_OR_MISSING: "stale_revision",
  DEFINITION_ROOT_ALREADY_EXISTS: "already_exists",
  DEFINITION_ROOT_MISSING: "not_found",
  DEFINITION_IDENTITY_ALIAS_CONFLICT: "already_exists",
  DEFINITION_CONTEXT_REFUSED: "context_refused",
  DEFINITION_STORAGE_VALIDATION_FAILED: "invalid_source",
  INVALID_DEFINITION_PUBLICATION_COMMAND: "invalid_request",
  DEFINITION_ORGANIZATION_MISMATCH: "context_refused",
  DEFINITION_SOURCE_EVIDENCE_MISMATCH: "stale_revision",
  DEFINITION_DEPENDENCY_MISSING: "missing_dependency",
  DEFINITION_DEPENDENCY_UNAVAILABLE: "missing_dependency",
  DEFINITION_DEPENDENCY_PRERELEASE_ONLY: "incompatible_dependency",
  DEFINITION_DEPENDENCY_INCOMPATIBLE: "incompatible_dependency",
  DEFINITION_DEPENDENCY_AMBIGUOUS: "incompatible_dependency",
  DEFINITION_DEPENDENCY_SUBSTITUTED: "incompatible_dependency",
  DEFINITION_DEPENDENCY_CYCLE: "incompatible_dependency",
  DEFINITION_COMPILATION_REFUSED: "compilation_refused",
  DEFINITION_VERSION_REFUSED: "version_refused",
  DEFINITION_NO_CHANGE: "version_refused",
  DEFINITION_CONFIRMATION_MISMATCH: "stale_revision",
  INVALID_DEFINITION_HISTORY_COMMAND: "invalid_request",
  INVALID_DEFINITION_RESTORE_COMMAND: "invalid_request",
  DEFINITION_HISTORY_NOT_FOUND: "not_found",
  DEFINITION_RELEASE_NOT_FOUND: "not_found",
  INVALID_DEFINITION_READ_COMMAND: "invalid_request",
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

const documentLocation = (key: string): DefinitionValidationLocation => ({
  documentKind: "application",
  documentKey: key,
  segments: [{ kind: "application", key }],
});

/** The located application document, when the supplied source at least names its own key. */
const applicationLocation = (source: unknown): DefinitionValidationLocation | undefined => {
  const key = namespacedKeySchema.safeParse(record(source)?.key);
  return key.success ? documentLocation(key.data) : undefined;
};

type RefusalOptions = Readonly<{ rootId?: string; location?: DefinitionValidationLocation }>;

/** A root identifier is echoed back only when it is a well-formed Application root identifier. */
const rootIdOption = (candidate: unknown): { rootId?: string } => {
  const rootId = applicationRootIdSchema.safeParse(candidate);
  return rootId.success ? { rootId: String(rootId.data) } : {};
};

const refuse = (
  operation: ApplicationLifecycleOperation,
  reason: ApplicationLifecycleRefusalReason,
  correlationId: string,
  options: RefusalOptions & Readonly<{ errorCode?: DefinitionValidationErrorCode }> = {},
): Readonly<{ status: "refused"; refusal: ApplicationLifecycleRefusal }> => ({
  status: "refused",
  refusal: {
    operation,
    reason,
    ...(options.rootId === undefined ? {} : { rootId: options.rootId }),
    correlationId,
    errors: [
      publicError(
        options.errorCode ?? catalogueCodeByReason[reason],
        correlationId,
        options.location,
      ),
    ],
  },
});

const serviceCode = (error: unknown): string | undefined =>
  error instanceof DefinitionStoreError ||
  error instanceof DefinitionPublicationError ||
  error instanceof DefinitionHistoryError ||
  error instanceof DefinitionConsumerReadError
    ? error.code
    : undefined;

/**
 * Runs one delegated service call. A service refusal becomes a safe located refusal; a service
 * fault is rethrown as the service's own safe error, and anything else as a lifecycle fault.
 */
const run = async <Value>(
  operation: ApplicationLifecycleOperation,
  correlationId: string,
  options: RefusalOptions,
  call: () => Promise<Value>,
): Promise<ApplicationLifecycleResult<Value>> => {
  try {
    return { status: "ok", value: await call() };
  } catch (error) {
    const code = serviceCode(error);
    const reason = code === undefined ? undefined : reasonByCode[code];
    if (reason === undefined) {
      if (
        code !== undefined ||
        error instanceof ApplicationLifecycleError ||
        error instanceof BuilderAuthorityError
      )
        throw error;
      throw new ApplicationLifecycleError("APPLICATION_LIFECYCLE_FAILED");
    }
    const errorCode = dependencyCodeCatalogue[code!];
    return refuse(operation, reason, correlationId, {
      ...options,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }
};

type CheckedContext =
  | Readonly<{ status: "ok"; context: SessionContext }>
  | Readonly<{ status: "refused"; refusal: ApplicationLifecycleRefusal }>;

/** The correlation every refusal carries. A context without one is a caller wiring fault. */
const correlationOf = (candidate: unknown): string => {
  const correlationId = correlationIdSchema.safeParse(record(candidate)?.correlationId);
  if (!correlationId.success)
    throw new ApplicationLifecycleError("APPLICATION_LIFECYCLE_CONTEXT_INVALID");
  return String(correlationId.data);
};

/**
 * Storage operations run only for a live system context, the same gate history, restore and
 * consumer read apply. The store itself reads its authority from the bound transaction, so the
 * lifecycle checks the supplied context here and compares every stored result against it.
 */
const checkSystemContext = (
  operation: ApplicationLifecycleOperation,
  candidate: unknown,
  options: RefusalOptions = {},
): CheckedContext => {
  const correlationId = correlationOf(candidate);
  const context = sessionContextSchema.safeParse(candidate);
  return context.success && isLiveDefinitionSystemContext(context.data)
    ? { status: "ok", context: context.data }
    : refuse(operation, "context_refused", correlationId, options);
};

/**
 * Judges one authored Application source with the same edit-save rules the store applies,
 * including the #592 located platform catalogue rule, and returns every located failure.
 */
const judgeSource = (
  operation: ApplicationLifecycleOperation,
  correlationId: string,
  source: unknown,
): ApplicationLifecycleResult<undefined> => {
  const location = applicationLocation(source);
  if (record(source)?.kind !== "application")
    return refuse(
      operation,
      "invalid_source",
      correlationId,
      location === undefined ? {} : { location },
    );
  const validation = validateDefinitionSource(source);
  if (validation.valid) return { status: "ok", value: undefined };
  // A source that does not even name a valid key cannot be located; it is refused as a whole.
  if (location === undefined) return refuse(operation, "invalid_source", correlationId);
  const errors = translateDefinitionRuleFailures(validation.failures, {
    correlationId,
    rootLocation: location,
  }).errors;
  return {
    status: "refused",
    refusal: { operation, reason: "invalid_source", correlationId, errors },
  };
};

const sourceOf = (command: unknown): unknown => record(command)?.source;

/**
 * A stored draft the lifecycle returns must be an Application draft of the caller's organisation
 * and, where one was addressed, of that root. Anything else is a fault: the write has happened,
 * so it is thrown for the caller's transaction to roll back.
 */
const assertApplicationDraft = (
  draft: StoredDefinitionDraft,
  context: SessionContext,
  rootId?: string,
): void => {
  if (
    draft.kind !== "application" ||
    draft.source.kind !== "application" ||
    draft.organizationId !== context.organizationId ||
    (rootId !== undefined && String(draft.rootId) !== rootId)
  )
    throw new ApplicationLifecycleError("APPLICATION_LIFECYCLE_RESULT_INVALID");
};

export type ApplicationLifecycleServices = Readonly<{
  store: ReturnType<typeof createDefinitionStore>;
  publication: ReturnType<typeof createDatabaseDefinitionPublicationService>;
  history: ReturnType<typeof createDatabaseDefinitionHistoryService>;
  consumerRead: ReturnType<typeof createDatabaseDefinitionConsumerReadService>;
  /** The caller's own builder authority; every draft change and publication requires it. */
  authority: BuilderAuthority;
}>;

/** Composes the lifecycle over already-built Definition services. */
export const createApplicationLifecycleService = (services: ApplicationLifecycleServices) => {
  /**
   * The live system context, and the same organisation the builder authority decides for. A
   * context for another organisation is refused before any authority or storage is consulted.
   */
  const checkContext = (
    operation: ApplicationLifecycleOperation,
    candidate: unknown,
    options: RefusalOptions = {},
  ): CheckedContext => {
    const checked = checkSystemContext(operation, candidate, options);
    return checked.status === "ok" &&
      checked.context.organizationId.toLowerCase() !== services.authority.organizationId.toLowerCase()
      ? refuse(operation, "context_refused", checked.context.correlationId, options)
      : checked;
  };

  /**
   * Resolves an addressed root as an Application of the caller's organisation through the
   * kind-checked history read, so a Module root or another organisation's root is refused as not
   * found, and yields the document location for that root's refusals.
   */
  const applicationRoot = async (
    operation: ApplicationLifecycleOperation,
    context: SessionContext,
    rootIdCandidate: unknown,
  ): Promise<ApplicationLifecycleResult<Required<RefusalOptions>>> => {
    const rootId = rootIdOption(rootIdCandidate).rootId;
    if (rootId === undefined) return refuse(operation, "invalid_request", context.correlationId);
    const root = await run(operation, context.correlationId, { rootId }, () =>
      services.history.list(context, { kind: "application", rootId, pageSize: 1 }),
    );
    return root.status === "refused"
      ? root
      : { status: "ok", value: { rootId, location: documentLocation(root.value.definitionKey) } };
  };

  /** History, release metadata and read commands must name an Application root explicitly. */
  const runApplicationKind = async <Value>(
    operation: ApplicationLifecycleOperation,
    contextCandidate: unknown,
    command: unknown,
    call: (context: SessionContext) => Promise<Value>,
  ): Promise<ApplicationLifecycleResult<Value>> => {
    const options = rootIdOption(record(command)?.rootId);
    const checked = checkContext(operation, contextCandidate, options);
    if (checked.status === "refused") return checked;
    const context = checked.context;
    if (record(command)?.kind !== "application")
      return refuse(operation, "invalid_request", context.correlationId, options);
    return run(operation, context.correlationId, options, () => call(context));
  };

  return {
    /** Creates a new Application root and its first draft. */
    async create(
      contextCandidate: SessionContext,
      command: unknown,
    ): Promise<ApplicationLifecycleResult<StoredDefinitionDraft>> {
      const checked = checkContext("create", contextCandidate);
      if (checked.status === "refused") return checked;
      const context = checked.context;
      const source = sourceOf(command);
      const judged = judgeSource("create", context.correlationId, source);
      if (judged.status === "refused") return judged;
      const location = applicationLocation(source);
      const outcome = await run(
        "create",
        context.correlationId,
        location === undefined ? {} : { location },
        () => services.store.createRoot(command as Parameters<typeof services.store.createRoot>[0]),
      );
      if (outcome.status === "ok") assertApplicationDraft(outcome.value, context);
      return outcome;
    },

    /** Saves a draft under an optimistic revision check; a stale revision is refused, never merged. */
    async save(
      contextCandidate: SessionContext,
      command: unknown,
    ): Promise<ApplicationLifecycleResult<StoredDefinitionDraft>> {
      const options = rootIdOption(record(command)?.rootId);
      const checked = checkContext("save", contextCandidate, options);
      if (checked.status === "refused") return checked;
      const context = checked.context;
      const source = sourceOf(command);
      const judged = judgeSource("save", context.correlationId, source);
      if (judged.status === "refused") return judged;
      const location = applicationLocation(source);
      const outcome = await run(
        "save",
        context.correlationId,
        { ...options, ...(location === undefined ? {} : { location }) },
        () => services.store.saveDraft(command as Parameters<typeof services.store.saveDraft>[0]),
      );
      if (outcome.status === "ok") assertApplicationDraft(outcome.value, context, options.rootId);
      return outcome;
    },

    /**
     * Reports every located source failure without storing anything. It reads no data, so it
     * needs only the caller's correlation.
     */
    validate(
      contextCandidate: SessionContext,
      source: unknown,
    ): ApplicationLifecycleResult<undefined> {
      return judgeSource("validate", correlationOf(contextCandidate), source);
    },

    /**
     * Compiles the current Application draft against its exact dependencies and returns the
     * confirmation a publication needs. A stale draft revision or a missing exact dependency is
     * refused here, located to the Application document.
     */
    async prepare(
      contextCandidate: SessionContext,
      command: unknown,
    ): Promise<ApplicationLifecycleResult<PrepareDefinitionPublicationResult>> {
      const rootIdCandidate = record(command)?.rootId;
      const checked = checkContext("prepare", contextCandidate, rootIdOption(rootIdCandidate));
      if (checked.status === "refused") return checked;
      const context = checked.context;
      const root = await applicationRoot("prepare", context, rootIdCandidate);
      if (root.status === "refused") return root;
      return run("prepare", context.correlationId, root.value, () =>
        services.publication.prepare(context, command),
      );
    },

    /**
     * Publishes only the exact confirmation that `prepare` produced; publication recomputes
     * everything and refuses a stale draft or a changed dependency set. It appends a release and
     * advances only the Application root's current release; installations are untouched.
     */
    async publish(
      contextCandidate: SessionContext,
      command: unknown,
    ): Promise<ApplicationLifecycleResult<PublishDefinitionResult>> {
      const rootIdCandidate = record(record(command)?.confirmation)?.rootId;
      const checked = checkContext("publish", contextCandidate, rootIdOption(rootIdCandidate));
      if (checked.status === "refused") return checked;
      const context = checked.context;
      const root = await applicationRoot("publish", context, rootIdCandidate);
      if (root.status === "refused") return root;
      return run("publish", context.correlationId, root.value, () =>
        services.publication.publish(context, command),
      );
    },

    /** Lists an Application's immutable release history, newest first. */
    async listHistory(
      contextCandidate: SessionContext,
      command: unknown,
    ): Promise<ApplicationLifecycleResult<DefinitionReleaseHistoryResult>> {
      return runApplicationKind("history", contextCandidate, command, (context) =>
        services.history.list(context, command),
      );
    },

    /** Reads one exact release's safe metadata. */
    async readReleaseMetadata(
      contextCandidate: SessionContext,
      command: unknown,
    ): Promise<ApplicationLifecycleResult<DefinitionReleaseMetadataResult>> {
      return runApplicationKind("release_metadata", contextCandidate, command, (context) =>
        services.history.readMetadata(context, command),
      );
    },

    /** Reads one exact, verified release for a consumer. */
    async read(
      contextCandidate: SessionContext,
      command: unknown,
    ): Promise<ApplicationLifecycleResult<DefinitionConsumerReadResult>> {
      return runApplicationKind("read", contextCandidate, command, (context) =>
        services.consumerRead.read(context, command),
      );
    },

    /**
     * Restores an immutable release into a new draft revision with restore provenance, under the
     * same optimistic revision check as a save. The release itself, the current release and every
     * installation stay as they are; the draft is then edited and published like any other.
     */
    async restore(
      contextCandidate: SessionContext,
      command: unknown,
    ): Promise<ApplicationLifecycleResult<StoredDefinitionDraft>> {
      const candidate = record(command);
      const options = rootIdOption(candidate?.rootId);
      const checked = checkContext("restore", contextCandidate, options);
      if (checked.status === "refused") return checked;
      const context = checked.context;
      if (candidate?.kind !== "application")
        return refuse("restore", "invalid_request", context.correlationId, options);
      const root = await applicationRoot("restore", context, candidate?.rootId);
      if (root.status === "refused") return root;
      const outcome = await run("restore", context.correlationId, root.value, () =>
        services.history.restoreDraft(context, command),
      );
      if (outcome.status === "ok")
        assertApplicationDraft(outcome.value, context, root.value.rootId);
      return outcome;
    },
  };
};

/** Builds the production lifecycle over one request transaction and the platform release catalogue. */
export const createDatabaseApplicationLifecycleService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
  authority: BuilderAuthority,
) =>
  createApplicationLifecycleService({
    store: createDefinitionStore(transaction, authority),
    publication: createDatabaseDefinitionPublicationService(
      catalogueDefinition,
      transaction,
      authority,
    ),
    history: createDatabaseDefinitionHistoryService(catalogueDefinition, transaction, authority),
    consumerRead: createDatabaseDefinitionConsumerReadService(catalogueDefinition, transaction),
    authority,
  });
