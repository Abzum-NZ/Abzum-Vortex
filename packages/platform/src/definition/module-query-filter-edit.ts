import "server-only";

import { createBuilderAuthority } from "../access/builder-authority";
import { createHumanOrganizationRequestService } from "../access/human-organization-request";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import { BuilderAuthorityError, requireBuilderAuthority } from "./builder-authority";
import {
  readModuleDefinitionDraft,
  type StoredModuleDefinitionDraft,
} from "./definition-draft-read";
import { DefinitionError } from "./definition-error";
import { createDatabaseDefinitionPublicationService } from "./publication/publish";
import {
  fingerprintModuleQueryFilterOperandBinding,
  type ModuleQueryFilterDraftContext,
  type ModuleQueryFilterQueryChoice,
} from "./definition-publication";
import {
  canonicalJson,
  conditionNodeSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  platformIdSchema,
  revisionSchema,
  sameId,
  type DefinitionValidationResult,
  type IdentitySession,
  type IdentitySessionResolution,
  type ModuleSourceDocument,
  type SelectedOrganizationScope,
} from "../schema";
import { z } from "zod";
import { readLiveHumanContext, type LiveHumanContext } from "../access/live-context";
import { encodeModuleQueryFilter } from "./module-query-filter-encoding";
import {
  sameUuid,
  moduleTargetFacts,
  evaluateDraftPermission as evaluateModuleDraftPermission,
  snapshotFor,
  sameDraft,
  saveModuleDraftEdit,
  type ModuleDraftEditDependencies,
} from "./module-draft-edit";

export type StudioModuleQueryFilterSnapshot = Readonly<{
  organizationId: string;
  rootId: string;
  key: string;
  draftRevision: number;
  publishedRevision: number | null;
  sourceFingerprint: string;
}>;

export type StudioModuleQueryFilterResult =
  | Readonly<{
      kind: "available";
      snapshot: StudioModuleQueryFilterSnapshot;
      queryChoices: readonly ModuleQueryFilterQueryChoice[];
      selected?: ModuleQueryFilterDraftContext;
    }>
  | Readonly<{
      kind: "readonly";
      queryChoices: readonly ModuleQueryFilterQueryChoice[];
      selectedAlias?: string;
      reason:
        "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported";
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type StudioModuleQueryFilterSaveResult =
  | Readonly<{
      kind: "saved" | "unchanged";
      snapshot: StudioModuleQueryFilterSnapshot;
      selected: ModuleQueryFilterDraftContext;
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{
      kind: "readonly";
      reason:
        "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported";
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type StudioModuleQueryFilterValidationResult =
  | Readonly<{ kind: "valid" }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{
      kind: "readonly";
      reason:
        "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported";
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export const moduleQueryFilterEdits = (dependencies: ModuleDraftEditDependencies) => {
  const installedReleaseCatalogue = dependencies.releaseCatalogue;
  const humanOrganizationRequests = () =>
    createHumanOrganizationRequestService(dependencies.requestDependencies);
  const evaluateDraftPermission = (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    session: IdentitySession,
    issuedAt: string,
    context: LiveHumanContext,
    draft: StoredModuleDefinitionDraft,
    originalValidUntil?: string,
  ) =>
    evaluateModuleDraftPermission(
      transaction,
      scope,
      session,
      issuedAt,
      context,
      draft,
      dependencies.access,
      originalValidUntil,
    );
  const loadRequestSchema = z
    .object({
      rootId: moduleRootIdSchema,
      queryAlias: z.string().min(1).max(160).optional(),
    })
    .strict();

  const filterRequestSchema = z
    .object({
      rootId: moduleRootIdSchema,
      queryAlias: z.string().min(1).max(160),
      expectedDraftRevision: revisionSchema,
      expectedSavedSourceFingerprint: fingerprintSchema,
      expectedResolutionFingerprint: fingerprintSchema,
      expectedOperandBindingFingerprint: fingerprintSchema,
      condition: conditionNodeSchema.nullable(),
    })
    .strict();

  const safeFailure = (
    error: unknown,
  ):
    | Extract<
        StudioModuleQueryFilterResult,
        { kind: "conflict" | "refused" | "temporarily_unavailable" }
      >
    | Extract<
        StudioModuleQueryFilterSaveResult,
        { kind: "conflict" | "refused" | "temporarily_unavailable" }
      > => {
    if (error instanceof BuilderAuthorityError) return { kind: "refused" };
    if (error instanceof DefinitionError) {
      if (
        error.code === "DEFINITION_DRAFT_STALE_OR_MISSING" ||
        error.code === "DEFINITION_ROOT_MISSING" ||
        error.code === "DEFINITION_IDENTITY_ALIAS_CONFLICT"
      )
        return { kind: "conflict" };
      if (
        error.code === "INVALID_DEFINITION_COMMAND" ||
        error.code === "INVALID_DEFINITION_SOURCE" ||
        error.code === "DEFINITION_CONTEXT_REFUSED" ||
        error.code === "DEFINITION_STORAGE_VALIDATION_FAILED"
      )
        return { kind: "refused" };
      return { kind: "temporarily_unavailable" };
    }
    if (error instanceof DefinitionError) {
      if (
        error.code === "DEFINITION_DRAFT_STALE_OR_MISSING" ||
        error.code === "DEFINITION_ORGANIZATION_MISMATCH" ||
        error.code === "DEFINITION_SOURCE_EVIDENCE_MISMATCH" ||
        error.code === "DEFINITION_HISTORY_INVALID"
      )
        return { kind: "conflict" };
      if (error.code === "INVALID_DEFINITION_PUBLICATION_COMMAND") return { kind: "refused" };
    }
    console.error("[studio] query filter failed unexpectedly", error);
    return { kind: "temporarily_unavailable" };
  };

  const queryFilterService = (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
  ) =>
    createDatabaseDefinitionPublicationService(
      installedReleaseCatalogue,
      transaction,
      createBuilderAuthority({
        transaction,
        scope,
        targetFacts: moduleTargetFacts,
        permissions: installedReleaseCatalogue.permissions,
      }),
    );

  const sameOperandBindingIdentity = (
    left: ModuleQueryFilterDraftContext,
    right: ModuleQueryFilterDraftContext,
  ): boolean =>
    canonicalJson({
      organizationId: left.organizationId,
      rootId: left.rootId,
      definitionKey: left.definitionKey,
      resolutionFingerprint: left.resolutionFingerprint,
      query: left.query,
      fields: left.fields,
      parameters: left.parameters,
    }) ===
    canonicalJson({
      organizationId: right.organizationId,
      rootId: right.rootId,
      definitionKey: right.definitionKey,
      resolutionFingerprint: right.resolutionFingerprint,
      query: right.query,
      fields: right.fields,
      parameters: right.parameters,
    });

  const changesOnlySelectedQueryFilter = (
    previous: ModuleSourceDocument,
    candidate: ModuleSourceDocument,
    queryAlias: string,
  ): boolean => {
    const matches = previous.body.queries.filter((query) => query.id === queryAlias);
    if (matches.length !== 1) return false;
    const expected = structuredClone(previous);
    const expectedQueries = expected.body.queries.filter((query) => query.id === queryAlias);
    const nextQueries = candidate.body.queries.filter((query) => query.id === queryAlias);
    if (
      expectedQueries.length !== 1 ||
      nextQueries.length !== 1 ||
      expectedQueries[0]!.key !== nextQueries[0]!.key
    )
      return false;
    expectedQueries[0]!.filter = nextQueries[0]!.filter;
    return canonicalJson(expected) === canonicalJson(candidate);
  };

  const loadInTransaction = async (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    session: IdentitySession,
    issuedAt: string,
    organizationId: string,
    request: z.infer<typeof loadRequestSchema>,
  ): Promise<StudioModuleQueryFilterResult> => {
    if (!sameUuid(scope.organizationId, organizationId)) return { kind: "refused" };
    const liveContext = await readLiveHumanContext(transaction, { scope, session, issuedAt });
    const authority = createBuilderAuthority({
      transaction,
      scope,
      targetFacts: moduleTargetFacts,
      permissions: installedReleaseCatalogue.permissions,
    });
    await requireBuilderAuthority(authority, {
      kind: "draft_change",
      rootId: platformIdSchema.parse(request.rootId),
    });
    const draft = await readModuleDefinitionDraft(transaction, scope, { rootId: request.rootId });
    if (!sameId(draft.organizationId, organizationId)) return { kind: "conflict" };
    const service = queryFilterService(transaction, scope);
    const loaded = await service.readModuleQueryFilterDraft(liveContext, {
      rootId: platformIdSchema.parse(draft.rootId),
      expectedDraftRevision: draft.draftRevision,
      expectedSavedSourceFingerprint: draft.sourceFingerprint,
      ...(request.queryAlias === undefined ? {} : { queryAlias: request.queryAlias }),
    });
    if (loaded.kind === "validation_failed") return loaded;
    if (loaded.kind === "unsupported_context")
      return {
        kind: "readonly",
        queryChoices: [],
        ...(request.queryAlias === undefined ? {} : { selectedAlias: request.queryAlias }),
        reason: loaded.reason,
      };
    const current = await readModuleDefinitionDraft(transaction, scope, {
      rootId: draft.rootId,
      expectedDraftRevision: draft.draftRevision,
    });
    if (!sameDraft(current, draft)) return { kind: "conflict" };
    await evaluateDraftPermission(transaction, scope, session, issuedAt, liveContext, current);
    if (request.queryAlias !== undefined && loaded.selected === undefined) {
      const selectedChoice = loaded.queryChoices.find(
        (choice) => choice.alias === request.queryAlias,
      );
      if (selectedChoice !== undefined)
        return {
          kind: "readonly",
          queryChoices: loaded.queryChoices,
          selectedAlias: request.queryAlias,
          reason: selectedChoice.reason ?? "operand_context_unsupported",
        };
      return { kind: "conflict" };
    }
    return {
      kind: "available",
      snapshot: snapshotFor(current),
      queryChoices: loaded.queryChoices,
      ...(loaded.selected === undefined ? {} : { selected: loaded.selected }),
    };
  };

  const loadStudioModuleQueryFilter = async (
    candidateOrganizationId: string,
    candidateRootId: string,
    queryAlias: string | undefined,
    sessionResolution: IdentitySessionResolution,
  ): Promise<StudioModuleQueryFilterResult> => {
    const organization = organizationIdSchema.safeParse(candidateOrganizationId);
    const root = moduleRootIdSchema.safeParse(candidateRootId);
    const request = loadRequestSchema.safeParse({
      rootId: candidateRootId,
      ...(queryAlias === undefined ? {} : { queryAlias }),
    });
    if (!organization.success || !root.success || !request.success) return { kind: "refused" };
    try {
      const resolved = sessionResolution;
      if (resolved.kind !== "active")
        return resolved.kind === "temporarily_unavailable"
          ? { kind: "temporarily_unavailable" }
          : { kind: "refused" };
      let failure: ReturnType<typeof safeFailure> | undefined;
      const result = await humanOrganizationRequests().run(
        resolved.session,
        { organizationId: organization.data },
        async (transaction, scope, issuedAt) => {
          try {
            return await loadInTransaction(
              transaction,
              scope,
              resolved.session,
              issuedAt,
              organization.data,
              request.data,
            );
          } catch (error) {
            failure = safeFailure(error);
            throw error;
          }
        },
      );
      return result.kind === "available"
        ? result.value
        : (failure ??
            (result.kind === "unavailable"
              ? { kind: "refused" }
              : { kind: "temporarily_unavailable" }));
    } catch {
      return { kind: "temporarily_unavailable" };
    }
  };

  const saveRequestSchema = filterRequestSchema;

  class ValidationFailure extends Error {
    constructor(readonly validation: DefinitionValidationResult) {
      super("STUDIO_MODULE_QUERY_FILTER_VALIDATION_FAILED");
    }
  }

  class ReadonlyContext extends Error {
    constructor(
      readonly reason:
        "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported",
    ) {
      super("STUDIO_MODULE_QUERY_FILTER_READONLY");
    }
  }

  const currentFilter = async (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    session: IdentitySession,
    issuedAt: string,
    organizationId: string,
    request: z.infer<typeof saveRequestSchema>,
  ): Promise<
    Readonly<{
      draft: StoredModuleDefinitionDraft;
      context: ModuleQueryFilterDraftContext;
      source: StoredModuleDefinitionDraft["source"];
      sourceFingerprint: string;
      noChange: boolean;
      liveContext: LiveHumanContext;
    }>
  > => {
    if (!sameUuid(scope.organizationId, organizationId))
      throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
    const liveContext = await readLiveHumanContext(transaction, { scope, session, issuedAt });
    const authority = createBuilderAuthority({
      transaction,
      scope,
      targetFacts: moduleTargetFacts,
      permissions: installedReleaseCatalogue.permissions,
    });
    await requireBuilderAuthority(authority, {
      kind: "draft_change",
      rootId: platformIdSchema.parse(request.rootId),
    });
    const draft = await readModuleDefinitionDraft(transaction, scope, {
      rootId: request.rootId,
      expectedDraftRevision: request.expectedDraftRevision,
    });
    if (
      !sameId(draft.organizationId, organizationId) ||
      draft.sourceFingerprint !== request.expectedSavedSourceFingerprint
    )
      throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
    const service = queryFilterService(transaction, scope);
    const current = await service.readModuleQueryFilterDraft(liveContext, {
      rootId: platformIdSchema.parse(draft.rootId),
      expectedDraftRevision: draft.draftRevision,
      expectedSavedSourceFingerprint: draft.sourceFingerprint,
      queryAlias: request.queryAlias,
    });
    if (current.kind === "validation_failed") throw new ValidationFailure(current.validation);
    if (current.kind === "unsupported_context") throw new ReadonlyContext(current.reason);
    if (current.selected === undefined) {
      const choice = current.queryChoices.find((entry) => entry.alias === request.queryAlias);
      throw new ReadonlyContext(choice?.reason ?? "query_target_unsupported");
    }
    if (
      current.selected.resolutionFingerprint !== request.expectedResolutionFingerprint ||
      current.selected.operandBindingFingerprint !== request.expectedOperandBindingFingerprint
    )
      throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
    const encoded = encodeModuleQueryFilter(request.condition, current.selected);
    if (encoded.kind === "invalid") throw new DefinitionError("INVALID_DEFINITION_COMMAND");
    if (encoded.kind === "unsupported") throw new ReadonlyContext("operand_context_unsupported");
    const validated = await service.validateModuleQueryFilterDraft(liveContext, {
      rootId: platformIdSchema.parse(draft.rootId),
      expectedDraftRevision: draft.draftRevision,
      expectedSavedSourceFingerprint: draft.sourceFingerprint,
      expectedResolutionFingerprint: request.expectedResolutionFingerprint,
      expectedOperandBindingFingerprint: request.expectedOperandBindingFingerprint,
      queryAlias: request.queryAlias,
      filter: encoded.filter,
    });
    if (validated.kind === "validation_failed") throw new ValidationFailure(validated.validation);
    if (validated.kind === "unsupported_context") throw new ReadonlyContext(validated.reason);
    if (
      !validated.noChange &&
      !changesOnlySelectedQueryFilter(draft.source, validated.source, request.queryAlias)
    )
      throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
    return {
      draft,
      context: validated.context,
      source: validated.source,
      sourceFingerprint: validated.sourceFingerprint,
      noChange: validated.noChange,
      liveContext,
    };
  };

  const safeSaveFailure = (error: unknown): StudioModuleQueryFilterSaveResult =>
    error instanceof ValidationFailure
      ? { kind: "validation_failed", validation: error.validation }
      : error instanceof ReadonlyContext
        ? { kind: "readonly", reason: error.reason }
        : safeFailure(error);

  const safeValidationFailure = (error: unknown): StudioModuleQueryFilterValidationResult =>
    error instanceof ValidationFailure
      ? { kind: "validation_failed", validation: error.validation }
      : error instanceof ReadonlyContext
        ? { kind: "readonly", reason: error.reason }
        : safeFailure(error);

  const validateStudioModuleQueryFilter = async (
    candidateOrganizationId: string,
    candidate: unknown,
    sessionResolution: IdentitySessionResolution,
  ): Promise<StudioModuleQueryFilterValidationResult> => {
    const organization = organizationIdSchema.safeParse(candidateOrganizationId);
    const request = saveRequestSchema.safeParse(candidate);
    if (!organization.success || !request.success) return { kind: "refused" };
    try {
      const resolved = sessionResolution;
      if (resolved.kind !== "active")
        return resolved.kind === "temporarily_unavailable"
          ? { kind: "temporarily_unavailable" }
          : { kind: "refused" };
      let failure: StudioModuleQueryFilterValidationResult | undefined;
      const result = await humanOrganizationRequests().run(
        resolved.session,
        { organizationId: organization.data },
        async (transaction, scope, issuedAt) => {
          try {
            const value = await currentFilter(
              transaction,
              scope,
              resolved.session,
              issuedAt,
              organization.data,
              request.data,
            );
            const originalDeadline = await evaluateDraftPermission(
              transaction,
              scope,
              resolved.session,
              issuedAt,
              value.liveContext,
              value.draft,
            );
            const current = await readModuleDefinitionDraft(transaction, scope, {
              rootId: value.draft.rootId,
              expectedDraftRevision: value.draft.draftRevision,
            });
            if (!sameDraft(current, value.draft)) return { kind: "conflict" } as const;
            await evaluateDraftPermission(
              transaction,
              scope,
              resolved.session,
              issuedAt,
              value.liveContext,
              current,
              originalDeadline,
            );
            return { kind: "valid" } as const;
          } catch (error) {
            failure = safeValidationFailure(error);
            throw error;
          }
        },
      );
      return result.kind === "available"
        ? result.value
        : (failure ??
            (result.kind === "unavailable"
              ? { kind: "refused" }
              : { kind: "temporarily_unavailable" }));
    } catch {
      return { kind: "temporarily_unavailable" };
    }
  };

  const saveStudioModuleQueryFilter = async (
    candidateOrganizationId: string,
    candidate: unknown,
    sessionResolution: IdentitySessionResolution,
  ): Promise<StudioModuleQueryFilterSaveResult> => {
    const organization = organizationIdSchema.safeParse(candidateOrganizationId);
    const request = saveRequestSchema.safeParse(candidate);
    if (!organization.success || !request.success) return { kind: "refused" };
    try {
      const resolved = sessionResolution;
      if (resolved.kind !== "active")
        return resolved.kind === "temporarily_unavailable"
          ? { kind: "temporarily_unavailable" }
          : { kind: "refused" };
      let failure: StudioModuleQueryFilterSaveResult | undefined;
      const result = await humanOrganizationRequests().runChange(
        resolved.session,
        { organizationId: organization.data },
        async (transaction, scope, issuedAt) => {
          try {
            const validated = await currentFilter(
              transaction,
              scope,
              resolved.session,
              issuedAt,
              organization.data,
              request.data,
            );
            const originalDeadline = await evaluateDraftPermission(
              transaction,
              scope,
              resolved.session,
              issuedAt,
              validated.liveContext,
              validated.draft,
            );
            if (validated.noChange) {
              const current = await readModuleDefinitionDraft(transaction, scope, {
                rootId: validated.draft.rootId,
                expectedDraftRevision: validated.draft.draftRevision,
              });
              if (!sameDraft(current, validated.draft)) return { kind: "conflict" } as const;
              const rereadResult = await queryFilterService(
                transaction,
                scope,
              ).readModuleQueryFilterDraft(validated.liveContext, {
                rootId: platformIdSchema.parse(current.rootId),
                expectedDraftRevision: current.draftRevision,
                expectedSavedSourceFingerprint: current.sourceFingerprint,
                queryAlias: validated.context.query.alias,
              });
              if (rereadResult.kind === "validation_failed")
                throw new ValidationFailure(rereadResult.validation);
              if (
                rereadResult.kind !== "available" ||
                rereadResult.selected === undefined ||
                canonicalJson(rereadResult.selected) !== canonicalJson(validated.context)
              )
                return { kind: "conflict" } as const;
              await evaluateDraftPermission(
                transaction,
                scope,
                resolved.session,
                issuedAt,
                validated.liveContext,
                current,
                originalDeadline,
              );
              return {
                kind: "unchanged",
                snapshot: snapshotFor(current),
                selected: rereadResult.selected,
              } as const;
            }
            const reread = await saveModuleDraftEdit(
              transaction,
              scope,
              validated.draft,
              validated.source,
              installedReleaseCatalogue.permissions,
            );
            const rereadResult = await queryFilterService(
              transaction,
              scope,
            ).readModuleQueryFilterDraft(validated.liveContext, {
              rootId: platformIdSchema.parse(reread.rootId),
              expectedDraftRevision: reread.draftRevision,
              expectedSavedSourceFingerprint: reread.sourceFingerprint,
              queryAlias: validated.context.query.alias,
            });
            if (rereadResult.kind === "validation_failed")
              throw new ValidationFailure(rereadResult.validation);
            if (rereadResult.kind !== "available" || rereadResult.selected === undefined)
              throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
            const selectedAfterWrite = rereadResult.selected;
            const expectedBindingFingerprint = fingerprintModuleQueryFilterOperandBinding({
              organizationId: selectedAfterWrite.organizationId,
              rootId: selectedAfterWrite.rootId,
              definitionKey: selectedAfterWrite.definitionKey,
              draftRevision: reread.draftRevision,
              savedSourceFingerprint: reread.sourceFingerprint,
              resolutionFingerprint: selectedAfterWrite.resolutionFingerprint,
              query: selectedAfterWrite.query,
              fields: selectedAfterWrite.fields,
              parameters: selectedAfterWrite.parameters,
            });
            if (
              selectedAfterWrite.organizationId !== reread.organizationId ||
              selectedAfterWrite.rootId !== reread.rootId ||
              selectedAfterWrite.definitionKey !== reread.key ||
              selectedAfterWrite.draftRevision !== reread.draftRevision ||
              selectedAfterWrite.savedSourceFingerprint !== reread.sourceFingerprint ||
              !sameOperandBindingIdentity(selectedAfterWrite, validated.context) ||
              selectedAfterWrite.operandBindingFingerprint !== expectedBindingFingerprint ||
              canonicalJson(selectedAfterWrite.filter) !== canonicalJson(validated.context.filter)
            )
              throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
            await evaluateDraftPermission(
              transaction,
              scope,
              resolved.session,
              issuedAt,
              validated.liveContext,
              reread,
              originalDeadline,
            );
            return {
              kind: "saved",
              snapshot: snapshotFor(reread),
              selected: rereadResult.selected,
            } as const;
          } catch (error) {
            failure = safeSaveFailure(error);
            throw error;
          }
        },
      );
      return result.kind === "available"
        ? result.value
        : (failure ??
            (result.kind === "unavailable"
              ? { kind: "refused" }
              : { kind: "temporarily_unavailable" }));
    } catch {
      return { kind: "temporarily_unavailable" };
    }
  };
  return {
    loadStudioModuleQueryFilter,
    validateStudioModuleQueryFilter,
    saveStudioModuleQueryFilter,
  };
};
