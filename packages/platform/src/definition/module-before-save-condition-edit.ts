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
  fingerprintModuleBeforeSaveConditionOperandBinding,
  type ModuleBeforeSaveConditionDraftContext,
  type ModuleBeforeSaveConditionFlowChoice,
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
import {
  sameUuid,
  moduleTargetFacts,
  evaluateDraftPermission as evaluateModuleDraftPermission,
  snapshotFor,
  sameDraft,
  saveModuleDraftEdit,
  type ModuleDraftEditDependencies,
} from "./module-draft-edit";

export type StudioModuleBeforeSaveConditionSnapshot = Readonly<{
  organizationId: string;
  rootId: string;
  key: string;
  draftRevision: number;
  publishedRevision: number | null;
  sourceFingerprint: string;
}>;

export type StudioModuleBeforeSaveConditionResult =
  | Readonly<{
      kind: "available";
      snapshot: StudioModuleBeforeSaveConditionSnapshot;
      flowChoices: readonly ModuleBeforeSaveConditionFlowChoice[];
      selected?: ModuleBeforeSaveConditionDraftContext;
    }>
  | Readonly<{
      kind: "readonly";
      flowChoices: readonly ModuleBeforeSaveConditionFlowChoice[];
      selectedAlias?: string;
      selectedTaskId?: string;
      reason:
        | "flow_target_unsupported"
        | "operand_context_unsupported"
        | "retained_condition_unsupported";
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type StudioModuleBeforeSaveConditionSaveResult =
  | Readonly<{
      kind: "saved" | "unchanged";
      snapshot: StudioModuleBeforeSaveConditionSnapshot;
      selected: ModuleBeforeSaveConditionDraftContext;
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{
      kind: "readonly";
      reason:
        | "flow_target_unsupported"
        | "operand_context_unsupported"
        | "retained_condition_unsupported";
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type StudioModuleBeforeSaveConditionValidationResult =
  | Readonly<{ kind: "valid" }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{
      kind: "readonly";
      reason:
        | "flow_target_unsupported"
        | "operand_context_unsupported"
        | "retained_condition_unsupported";
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export const moduleBeforeSaveConditionEdits = (dependencies: ModuleDraftEditDependencies) => {
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
      flowAlias: z.string().min(1).max(240).optional(),
      taskId: z.string().min(1).max(160).optional(),
    })
    .strict()
    .refine((value) => (value.flowAlias === undefined) === (value.taskId === undefined));

  const conditionRequestSchema = z
    .object({
      rootId: moduleRootIdSchema,
      flowAlias: z.string().min(1).max(240),
      taskId: z.string().min(1).max(160),
      expectedDraftRevision: revisionSchema,
      expectedSavedSourceFingerprint: fingerprintSchema,
      expectedResolutionFingerprint: fingerprintSchema,
      expectedOperandBindingFingerprint: fingerprintSchema,
      condition: conditionNodeSchema,
    })
    .strict();

  const safeFailure = (
    error: unknown,
  ):
    | Extract<
        StudioModuleBeforeSaveConditionResult,
        { kind: "conflict" | "refused" | "temporarily_unavailable" }
      >
    | Extract<
        StudioModuleBeforeSaveConditionSaveResult,
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
    console.error("[studio] before-save condition failed unexpectedly", error);
    return { kind: "temporarily_unavailable" };
  };

  const beforeSaveConditionService = (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
  ) =>
    createDatabaseDefinitionPublicationService(
      installedReleaseCatalogue,
      transaction,
      createBuilderAuthority({ transaction, scope, targetFacts: moduleTargetFacts }),
    );

  const sameOperandBindingIdentity = (
    left: ModuleBeforeSaveConditionDraftContext,
    right: ModuleBeforeSaveConditionDraftContext,
  ): boolean =>
    canonicalJson({
      organizationId: left.organizationId,
      rootId: left.rootId,
      definitionKey: left.definitionKey,
      resolutionFingerprint: left.resolutionFingerprint,
      flow: left.flow,
      trigger: left.trigger,
      task: left.task,
      fields: left.fields,
    }) ===
    canonicalJson({
      organizationId: right.organizationId,
      rootId: right.rootId,
      definitionKey: right.definitionKey,
      resolutionFingerprint: right.resolutionFingerprint,
      flow: right.flow,
      trigger: right.trigger,
      task: right.task,
      fields: right.fields,
    });

  const changesOnlySelectedIfCondition = (
    previous: ModuleSourceDocument,
    candidate: ModuleSourceDocument,
    flowAlias: string,
    taskId: string,
  ): boolean => {
    const expected = structuredClone(previous);
    const flows = expected.body.flows.filter((flow) => flow.id === flowAlias);
    const nextFlows = candidate.body.flows.filter((flow) => flow.id === flowAlias);
    if (flows.length !== 1 || nextFlows.length !== 1 || flows[0]!.key !== nextFlows[0]!.key)
      return false;
    const tasks = flows[0]!.tasks.filter((task) => task.id === taskId);
    const nextTasks = nextFlows[0]!.tasks.filter((task) => task.id === taskId);
    if (tasks.length !== 1 || nextTasks.length !== 1) return false;
    const task = tasks[0];
    const nextTask = nextTasks[0];
    if (
      task === undefined ||
      nextTask === undefined ||
      task.type !== "if" ||
      !("condition" in task) ||
      nextTask.type !== "if" ||
      !("condition" in nextTask)
    )
      return false;
    task.condition = nextTask.condition;
    return canonicalJson(expected) === canonicalJson(candidate);
  };

  const loadInTransaction = async (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    session: IdentitySession,
    issuedAt: string,
    organizationId: string,
    request: z.infer<typeof loadRequestSchema>,
  ): Promise<StudioModuleBeforeSaveConditionResult> => {
    if (!sameUuid(scope.organizationId, organizationId)) return { kind: "refused" };
    const liveContext = await readLiveHumanContext(transaction, { scope, session, issuedAt });
    const authority = createBuilderAuthority({
      transaction,
      scope,
      targetFacts: moduleTargetFacts,
    });
    await requireBuilderAuthority(authority, {
      kind: "draft_change",
      rootId: platformIdSchema.parse(request.rootId),
    });
    const draft = await readModuleDefinitionDraft(transaction, scope, { rootId: request.rootId });
    if (!sameId(draft.organizationId, organizationId)) return { kind: "conflict" };
    const originalDeadline = await evaluateDraftPermission(
      transaction,
      scope,
      session,
      issuedAt,
      liveContext,
      draft,
    );
    const service = beforeSaveConditionService(transaction, scope);
    const loaded = await service.readModuleBeforeSaveConditionDraft(liveContext, {
      rootId: platformIdSchema.parse(draft.rootId),
      expectedDraftRevision: draft.draftRevision,
      expectedSavedSourceFingerprint: draft.sourceFingerprint,
      ...(request.flowAlias === undefined
        ? {}
        : { flowAlias: request.flowAlias, taskId: request.taskId }),
    });
    const current = await readModuleDefinitionDraft(transaction, scope, {
      rootId: draft.rootId,
      expectedDraftRevision: draft.draftRevision,
    });
    if (!sameDraft(current, draft)) return { kind: "conflict" };
    await evaluateDraftPermission(
      transaction,
      scope,
      session,
      issuedAt,
      liveContext,
      current,
      originalDeadline,
    );
    if (loaded.kind === "validation_failed") return loaded;
    if (loaded.kind === "unsupported_context")
      return {
        kind: "readonly",
        flowChoices: [],
        ...(request.flowAlias === undefined || request.taskId === undefined
          ? {}
          : {
              selectedAlias: request.flowAlias,
              selectedTaskId: request.taskId,
            }),
        reason: loaded.reason,
      };
    if (
      request.flowAlias !== undefined &&
      request.taskId !== undefined &&
      loaded.selected === undefined
    ) {
      const selectedChoice = loaded.flowChoices.find(
        (choice) => choice.alias === request.flowAlias && choice.taskId === request.taskId,
      );
      if (selectedChoice !== undefined)
        return {
          kind: "readonly",
          flowChoices: loaded.flowChoices,
          selectedAlias: request.flowAlias,
          selectedTaskId: request.taskId,
          reason: selectedChoice.reason ?? "operand_context_unsupported",
        };
      return { kind: "conflict" };
    }
    return {
      kind: "available",
      snapshot: snapshotFor(current),
      flowChoices: loaded.flowChoices,
      ...(loaded.selected === undefined ? {} : { selected: loaded.selected }),
    };
  };

  const loadStudioModuleBeforeSaveCondition = async (
    candidateOrganizationId: string,
    candidateRootId: string,
    flowAlias: string | undefined,
    taskId: string | undefined,
    sessionResolution: IdentitySessionResolution,
  ): Promise<StudioModuleBeforeSaveConditionResult> => {
    const organization = organizationIdSchema.safeParse(candidateOrganizationId);
    const root = moduleRootIdSchema.safeParse(candidateRootId);
    const request = loadRequestSchema.safeParse({
      rootId: candidateRootId,
      ...(flowAlias === undefined ? {} : { flowAlias, taskId }),
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

  const saveRequestSchema = conditionRequestSchema;

  class ValidationFailure extends Error {
    constructor(readonly validation: DefinitionValidationResult) {
      super("STUDIO_MODULE_BEFORE_SAVE_CONDITION_VALIDATION_FAILED");
    }
  }

  class ReadonlyContext extends Error {
    constructor(
      readonly reason:
        | "flow_target_unsupported"
        | "operand_context_unsupported"
        | "retained_condition_unsupported",
    ) {
      super("STUDIO_MODULE_BEFORE_SAVE_CONDITION_READONLY");
    }
  }

  const currentCondition = async (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    session: IdentitySession,
    issuedAt: string,
    organizationId: string,
    request: z.infer<typeof saveRequestSchema>,
  ): Promise<
    Readonly<{
      draft: StoredModuleDefinitionDraft;
      context: ModuleBeforeSaveConditionDraftContext;
      source: StoredModuleDefinitionDraft["source"];
      sourceFingerprint: string;
      noChange: boolean;
      liveContext: LiveHumanContext;
      originalDeadline: string;
    }>
  > => {
    if (!sameUuid(scope.organizationId, organizationId))
      throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
    const liveContext = await readLiveHumanContext(transaction, { scope, session, issuedAt });
    const authority = createBuilderAuthority({
      transaction,
      scope,
      targetFacts: moduleTargetFacts,
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
    const originalDeadline = await evaluateDraftPermission(
      transaction,
      scope,
      session,
      issuedAt,
      liveContext,
      draft,
    );
    const service = beforeSaveConditionService(transaction, scope);
    const current = await service.readModuleBeforeSaveConditionDraft(liveContext, {
      rootId: platformIdSchema.parse(draft.rootId),
      expectedDraftRevision: draft.draftRevision,
      expectedSavedSourceFingerprint: draft.sourceFingerprint,
      flowAlias: request.flowAlias,
      taskId: request.taskId,
    });
    if (current.kind === "validation_failed") throw new ValidationFailure(current.validation);
    if (current.kind === "unsupported_context") throw new ReadonlyContext(current.reason);
    if (current.selected === undefined) {
      const choice = current.flowChoices.find(
        (entry) => entry.alias === request.flowAlias && entry.taskId === request.taskId,
      );
      throw new ReadonlyContext(choice?.reason ?? "flow_target_unsupported");
    }
    if (
      current.selected.resolutionFingerprint !== request.expectedResolutionFingerprint ||
      current.selected.operandBindingFingerprint !== request.expectedOperandBindingFingerprint
    )
      throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
    const validated = await service.validateModuleBeforeSaveConditionDraft(liveContext, {
      rootId: platformIdSchema.parse(draft.rootId),
      expectedDraftRevision: draft.draftRevision,
      expectedSavedSourceFingerprint: draft.sourceFingerprint,
      expectedResolutionFingerprint: request.expectedResolutionFingerprint,
      expectedOperandBindingFingerprint: request.expectedOperandBindingFingerprint,
      flowAlias: request.flowAlias,
      taskId: request.taskId,
      condition: request.condition,
    });
    if (validated.kind === "validation_failed") throw new ValidationFailure(validated.validation);
    if (validated.kind === "unsupported_context") throw new ReadonlyContext(validated.reason);
    if (
      !validated.noChange &&
      !changesOnlySelectedIfCondition(
        draft.source,
        validated.source,
        request.flowAlias,
        request.taskId,
      )
    )
      throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
    await evaluateDraftPermission(
      transaction,
      scope,
      session,
      issuedAt,
      liveContext,
      draft,
      originalDeadline,
    );
    return {
      draft,
      context: validated.context,
      source: validated.source,
      sourceFingerprint: validated.sourceFingerprint,
      noChange: validated.noChange,
      liveContext,
      originalDeadline,
    };
  };

  const safeSaveFailure = (error: unknown): StudioModuleBeforeSaveConditionSaveResult =>
    error instanceof ValidationFailure
      ? { kind: "validation_failed", validation: error.validation }
      : error instanceof ReadonlyContext
        ? { kind: "readonly", reason: error.reason }
        : safeFailure(error);

  const safeValidationFailure = (
    error: unknown,
  ): StudioModuleBeforeSaveConditionValidationResult =>
    error instanceof ValidationFailure
      ? { kind: "validation_failed", validation: error.validation }
      : error instanceof ReadonlyContext
        ? { kind: "readonly", reason: error.reason }
        : safeFailure(error);

  const validateStudioModuleBeforeSaveCondition = async (
    candidateOrganizationId: string,
    candidate: unknown,
    sessionResolution: IdentitySessionResolution,
  ): Promise<StudioModuleBeforeSaveConditionValidationResult> => {
    const organization = organizationIdSchema.safeParse(candidateOrganizationId);
    const request = saveRequestSchema.safeParse(candidate);
    if (!organization.success || !request.success) return { kind: "refused" };
    try {
      const resolved = sessionResolution;
      if (resolved.kind !== "active")
        return resolved.kind === "temporarily_unavailable"
          ? { kind: "temporarily_unavailable" }
          : { kind: "refused" };
      let failure: StudioModuleBeforeSaveConditionValidationResult | undefined;
      const result = await humanOrganizationRequests().run(
        resolved.session,
        { organizationId: organization.data },
        async (transaction, scope, issuedAt) => {
          try {
            const value = await currentCondition(
              transaction,
              scope,
              resolved.session,
              issuedAt,
              organization.data,
              request.data,
            );
            const originalDeadline = value.originalDeadline;
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

  const saveStudioModuleBeforeSaveCondition = async (
    candidateOrganizationId: string,
    candidate: unknown,
    sessionResolution: IdentitySessionResolution,
  ): Promise<StudioModuleBeforeSaveConditionSaveResult> => {
    const organization = organizationIdSchema.safeParse(candidateOrganizationId);
    const request = saveRequestSchema.safeParse(candidate);
    if (!organization.success || !request.success) return { kind: "refused" };
    try {
      const resolved = sessionResolution;
      if (resolved.kind !== "active")
        return resolved.kind === "temporarily_unavailable"
          ? { kind: "temporarily_unavailable" }
          : { kind: "refused" };
      let failure: StudioModuleBeforeSaveConditionSaveResult | undefined;
      const result = await humanOrganizationRequests().runChange(
        resolved.session,
        { organizationId: organization.data },
        async (transaction, scope, issuedAt) => {
          try {
            const validated = await currentCondition(
              transaction,
              scope,
              resolved.session,
              issuedAt,
              organization.data,
              request.data,
            );
            const originalDeadline = validated.originalDeadline;
            if (validated.noChange) {
              const current = await readModuleDefinitionDraft(transaction, scope, {
                rootId: validated.draft.rootId,
                expectedDraftRevision: validated.draft.draftRevision,
              });
              if (!sameDraft(current, validated.draft)) return { kind: "conflict" } as const;
              const rereadResult = await beforeSaveConditionService(
                transaction,
                scope,
              ).readModuleBeforeSaveConditionDraft(validated.liveContext, {
                rootId: platformIdSchema.parse(current.rootId),
                expectedDraftRevision: current.draftRevision,
                expectedSavedSourceFingerprint: current.sourceFingerprint,
                flowAlias: validated.context.flow.alias,
                taskId: validated.context.task.id,
              });
              if (rereadResult.kind === "validation_failed")
                throw new ValidationFailure(rereadResult.validation);
              if (
                rereadResult.kind !== "available" ||
                rereadResult.selected === undefined ||
                canonicalJson(rereadResult.selected) !== canonicalJson(validated.context)
              )
                throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
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
            );
            const rereadResult = await beforeSaveConditionService(
              transaction,
              scope,
            ).readModuleBeforeSaveConditionDraft(validated.liveContext, {
              rootId: platformIdSchema.parse(reread.rootId),
              expectedDraftRevision: reread.draftRevision,
              expectedSavedSourceFingerprint: reread.sourceFingerprint,
              flowAlias: validated.context.flow.alias,
              taskId: validated.context.task.id,
            });
            if (rereadResult.kind === "validation_failed")
              throw new ValidationFailure(rereadResult.validation);
            if (rereadResult.kind !== "available" || rereadResult.selected === undefined)
              throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
            const selectedAfterWrite = rereadResult.selected;
            const expectedBindingFingerprint = fingerprintModuleBeforeSaveConditionOperandBinding({
              organizationId: selectedAfterWrite.organizationId,
              rootId: selectedAfterWrite.rootId,
              definitionKey: selectedAfterWrite.definitionKey,
              draftRevision: reread.draftRevision,
              savedSourceFingerprint: reread.sourceFingerprint,
              resolutionFingerprint: selectedAfterWrite.resolutionFingerprint,
              flow: selectedAfterWrite.flow,
              trigger: selectedAfterWrite.trigger,
              task: selectedAfterWrite.task,
              fields: selectedAfterWrite.fields,
            });
            if (
              selectedAfterWrite.organizationId !== reread.organizationId ||
              selectedAfterWrite.rootId !== reread.rootId ||
              selectedAfterWrite.definitionKey !== reread.key ||
              selectedAfterWrite.draftRevision !== reread.draftRevision ||
              selectedAfterWrite.savedSourceFingerprint !== reread.sourceFingerprint ||
              !sameOperandBindingIdentity(selectedAfterWrite, validated.context) ||
              selectedAfterWrite.operandBindingFingerprint !== expectedBindingFingerprint ||
              canonicalJson(selectedAfterWrite.condition) !==
                canonicalJson(validated.context.condition)
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
    loadStudioModuleBeforeSaveCondition,
    validateStudioModuleBeforeSaveCondition,
    saveStudioModuleBeforeSaveCondition,
  };
};
