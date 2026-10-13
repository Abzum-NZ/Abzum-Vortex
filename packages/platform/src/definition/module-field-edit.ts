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
import { validateDefinitionSource } from "./validation";
import {
  deriveFieldAlias,
  deriveFieldKey,
  newAuthoredField,
  offeredFieldTypes,
  settingsForType,
} from "./module-field-shape";
import {
  moduleTargetFacts,
  invalidResult,
  readLiveContext,
  evaluateDraftPermission,
  saveModuleDraftEdit,
  type HumanContext,
  type ModuleDraftEditDependencies,
} from "./module-draft-edit";
import {
  builderKeySchema,
  canonicalJson,
  describeFailure,
  fingerprintSchema,
  labelSchema,
  moduleRootIdSchema,
  moduleSourceDocumentSchema,
  organizationIdSchema,
  revisionSchema,
  sameId,
  translateDefinitionRuleFailures,
  translateDefinitionSchemaError,
  type correlationIdSchema,
  type DefinitionValidationLocation,
  type DefinitionValidationResult,
  type IdentitySession,
  type IdentitySessionResolution,
  type ModuleSourceDocument,
  type SelectedOrganizationScope,
} from "../schema";
import { z } from "zod";

export type StudioModuleFieldDescriptor = Readonly<{
  recordAlias: string;
  recordKey: string;
  recordName: string;
  fieldAlias: string;
  fieldKey: string;
  label: string;
  type: string;
}>;

type TextModuleField = Extract<
  ModuleSourceDocument["body"]["record_types"][number]["fields"][number],
  { type: "text" }
>;

export type StudioModuleTextFieldDescriptor = Readonly<{
  recordAlias: string;
  recordKey: string;
  recordName: string;
  fieldAlias: string;
  fieldKey: string;
  label: string;
  type: "text";
  maxLength: number;
  format?: TextModuleField["settings"]["format"];
}>;

type FieldEditResult<Descriptor> =
  | Readonly<{
      kind: "available";
      draft: StoredModuleDefinitionDraft;
      fields: readonly Descriptor[];
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{ kind: "conflict"; reason?: "draft_changed" | "draft_missing" | "alias_conflict" }>
  | Readonly<{
      kind: "refused";
      reason?: "permission_missing" | "source_invalid" | "context_changed" | "session_ended";
    }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type StudioModuleFieldLabelResult = FieldEditResult<StudioModuleFieldDescriptor>;
export type StudioModuleTextFieldSettingsResult = FieldEditResult<StudioModuleTextFieldDescriptor>;

export type StudioModuleFieldChangeResult =
  | Readonly<{ kind: "available"; draft: StoredModuleDefinitionDraft }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{ kind: "conflict"; reason: string }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

// Aliases only select a member of the protected authored source; they convey no identity or grant.
const labelRequestSchema = z
  .object({
    rootId: moduleRootIdSchema,
    expectedDraftRevision: revisionSchema,
    expectedSavedSourceFingerprint: fingerprintSchema,
    recordAlias: z.string().min(1).max(160),
    fieldAlias: z.string().min(1).max(160),
    label: z.string().max(1_000),
  })
  .strict();

const textSettingsRequestSchema = z
  .object({
    rootId: moduleRootIdSchema,
    expectedDraftRevision: revisionSchema,
    expectedSavedSourceFingerprint: fingerprintSchema,
    recordAlias: z.string().min(1).max(160),
    fieldAlias: z.string().min(1).max(160),
    maxLength: z.number().int().refine(Number.isSafeInteger),
  })
  .strict();

// Without a field alias the request adds a field to the record type; with one it edits that field.
const fieldChangeSchema = z
  .object({
    rootId: moduleRootIdSchema,
    expectedDraftRevision: revisionSchema,
    expectedSavedSourceFingerprint: fingerprintSchema,
    recordAlias: z.string().min(1).max(160),
    fieldAlias: z.string().min(1).max(160).optional(),
    label: z.string().max(1_000),
    type: z.string().min(1).max(80),
    required: z.boolean(),
    maxLength: z.number().int().optional(),
  })
  .strict();

class LocatedValidationFailure extends Error {
  constructor(readonly validation: DefinitionValidationResult) {
    super("STUDIO_MODULE_VALIDATION_FAILED");
  }
}

type RefusalReason = "permission_missing" | "source_invalid" | "context_changed" | "session_ended";

/** The log prefix and stable code stem of one editing surface. */
type Surface = Readonly<{ name: string; code: string }>;
const labelSurface: Surface = { name: "field label", code: "STUDIO_FIELD_LABEL" };
const textSurface: Surface = { name: "text field settings", code: "STUDIO_TEXT_FIELD_SETTINGS" };

type SaveTranslation = Readonly<{
  correlationId: z.infer<typeof correlationIdSchema>;
  rootLocation: DefinitionValidationLocation;
  pathMap?: Parameters<typeof translateDefinitionSchemaError>[1]["pathMap"];
}>;

type PlannedEdit = Readonly<{
  source: ModuleSourceDocument;
  translation: SaveTranslation;
}>;

const fieldDescriptors = (draft: StoredModuleDefinitionDraft): readonly StudioModuleFieldDescriptor[] =>
  draft.source.body.record_types.flatMap((record) =>
    record.fields.map((field) => ({
      recordAlias: record.id,
      recordKey: record.key,
      recordName: record.name,
      fieldAlias: field.id,
      fieldKey: field.key,
      label: field.label,
      type: field.type,
    })),
  );

const textFieldDescriptors = (
  draft: StoredModuleDefinitionDraft,
): readonly StudioModuleTextFieldDescriptor[] =>
  draft.source.body.record_types.flatMap((record) =>
    record.fields.flatMap((field) => {
      if (field.type !== "text") return [];
      return [
        {
          recordAlias: record.id,
          recordKey: record.key,
          recordName: record.name,
          fieldAlias: field.id,
          fieldKey: field.key,
          label: field.label,
          type: "text" as const,
          maxLength: field.settings.max_length,
          ...(field.settings.format === undefined ? {} : { format: field.settings.format }),
        },
      ];
    }),
  );

const settingLocation = (
  draft: StoredModuleDefinitionDraft,
  recordKey: string,
  fieldKey: string,
  settingKey: string,
): DefinitionValidationLocation => ({
  documentKind: "module",
  documentKey: draft.key,
  segments: [
    { kind: "module", key: draft.key },
    { kind: "record_type", key: recordKey },
    { kind: "field", key: fieldKey },
    { kind: "setting", key: settingKey },
  ],
});

const fieldLocation = (
  draft: StoredModuleDefinitionDraft,
  recordKey: string,
  fieldKey: string,
): DefinitionValidationLocation => ({
  documentKind: "module",
  documentKey: draft.key,
  segments: [
    { kind: "module", key: draft.key },
    { kind: "record_type", key: recordKey },
    { kind: "field", key: fieldKey },
  ],
});

const textFieldValidationContext = (
  draft: StoredModuleDefinitionDraft,
  recordAlias: string,
  fieldAlias: string,
  correlationId: z.infer<typeof correlationIdSchema>,
) => {
  const recordIndexes = draft.source.body.record_types.flatMap((record, index) =>
    record.id === recordAlias ? [index] : [],
  );
  const record = draft.source.body.record_types[recordIndexes[0] ?? -1];
  const fieldIndexes =
    record?.fields.flatMap((field, index) => (field.id === fieldAlias ? [index] : [])) ?? [];
  const field = record?.fields[fieldIndexes[0] ?? -1];
  if (
    recordIndexes.length !== 1 ||
    record === undefined ||
    fieldIndexes.length !== 1 ||
    field === undefined ||
    field.type !== "text"
  )
    throw new DefinitionError("INVALID_DEFINITION_COMMAND");
  const rootLocation = settingLocation(draft, record.key, field.key, "max_length");
  const recordIndex = recordIndexes[0]!;
  const fieldIndex = fieldIndexes[0]!;
  const prefix = ["body", "record_types", recordIndex, "fields", fieldIndex] as const;
  return {
    record,
    field,
    rootLocation,
    translation: {
      correlationId,
      rootLocation,
      pathMap: [
        { sourcePath: [...prefix, "settings"], location: rootLocation },
        { sourcePath: [...prefix, "settings", "max_length"], location: rootLocation },
        { sourcePath: [...prefix, "default"], location: settingLocation(draft, record.key, field.key, "default") },
      ],
    },
  };
};

/** Module draft field operations: label, text settings, and add/edit field, all in the caller's transaction. */
export const moduleFieldEdits = (dependencies: ModuleDraftEditDependencies) => {
  const humanOrganizationRequests = () =>
    createHumanOrganizationRequestService(dependencies.requestDependencies);

  /** A refusal decided before or after the database transaction: one log line with a stable code. */
  const declined = (surface: Surface, code: string, reason: RefusalReason) => {
    console.error(`[studio] ${surface.name} refused ${surface.code}_${code}`);
    return { kind: "refused", reason } as const;
  };

  // Every failure mapped here is rethrown through the request transaction, where the request boundary logs
  // its cause and stable code once.
  const safeFailure = (error: unknown) => {
    if (error instanceof LocatedValidationFailure)
      return { kind: "validation_failed", validation: error.validation } as const;
    if (error instanceof BuilderAuthorityError)
      return { kind: "refused", reason: "permission_missing" } as const;
    if (error instanceof DefinitionError) {
      if (error.code === "DEFINITION_DRAFT_STALE_OR_MISSING")
        return { kind: "conflict", reason: "draft_changed" } as const;
      if (error.code === "DEFINITION_ROOT_MISSING")
        return { kind: "conflict", reason: "draft_missing" } as const;
      if (error.code === "DEFINITION_IDENTITY_ALIAS_CONFLICT")
        return { kind: "conflict", reason: "alias_conflict" } as const;
      if (error.code === "INVALID_DEFINITION_COMMAND" || error.code === "INVALID_DEFINITION_SOURCE")
        return { kind: "refused", reason: "source_invalid" } as const;
      if (
        error.code === "DEFINITION_CONTEXT_REFUSED" ||
        error.code === "DEFINITION_STORAGE_VALIDATION_FAILED"
      )
        return { kind: "refused", reason: "context_changed" } as const;
    }
    return { kind: "temporarily_unavailable" } as const;
  };

  const unexpected = (surface: Surface, error: unknown) => {
    console.error(
      `[studio] ${surface.name} failed unexpectedly ${surface.code}_FAILED: ${describeFailure(error)}`,
    );
    return { kind: "temporarily_unavailable" } as const;
  };

  const changeFailure = (error: unknown): StudioModuleFieldChangeResult => {
    const cause = describeFailure(error);
    if (error instanceof LocatedValidationFailure) {
      console.warn(
        `[studio] module field change failed validation: ${error.validation.errors.map((item) => item.code).join(",")}`,
      );
      return { kind: "validation_failed", validation: error.validation };
    }
    if (error instanceof BuilderAuthorityError) {
      console.warn(
        `[studio] module field change refused by builder authority: ${cause} code=${error.code}`,
      );
      return { kind: "refused", reason: error.code };
    }
    if (error instanceof DefinitionError) {
      if (
        error.code === "DEFINITION_DRAFT_STALE_OR_MISSING" ||
        error.code === "DEFINITION_ROOT_MISSING" ||
        error.code === "DEFINITION_IDENTITY_ALIAS_CONFLICT"
      ) {
        console.warn(`[studio] module field change conflicted: ${cause} code=${error.code}`);
        return { kind: "conflict", reason: error.code };
      }
      if (
        error.code === "INVALID_DEFINITION_COMMAND" ||
        error.code === "INVALID_DEFINITION_SOURCE" ||
        error.code === "DEFINITION_CONTEXT_REFUSED" ||
        error.code === "DEFINITION_STORAGE_VALIDATION_FAILED"
      ) {
        console.warn(`[studio] module field change refused: ${cause} code=${error.code}`);
        return { kind: "refused", reason: error.code };
      }
    }
    console.error(`[studio] module field change failed unexpectedly: ${cause}`);
    return { kind: "temporarily_unavailable" };
  };

  /** Read the draft inside the caller's own transaction, after the builder authority and live permission checks. */
  const readFields = async <Descriptor>(
    surface: Surface,
    candidateOrganizationId: string,
    candidateRootId: string,
    sessionResolution: IdentitySessionResolution,
    describe: (draft: StoredModuleDefinitionDraft) => readonly Descriptor[],
  ): Promise<FieldEditResult<Descriptor>> => {
    const organization = organizationIdSchema.safeParse(candidateOrganizationId);
    const root = moduleRootIdSchema.safeParse(candidateRootId);
    if (!organization.success || !root.success) return declined(surface, "REQUEST_INVALID", "source_invalid");
    try {
      const resolved = sessionResolution;
      if (resolved.kind !== "active")
        return resolved.kind === "temporarily_unavailable"
          ? { kind: "temporarily_unavailable" }
          : declined(surface, "SESSION_NOT_ACTIVE", "session_ended");
      let failure: FieldEditResult<Descriptor> | undefined;
      const result = await humanOrganizationRequests().run(
        resolved.session,
        { organizationId: organization.data },
        async (transaction, scope, issuedAt) => {
          try {
            const context = await readLiveContext(transaction, scope, resolved.session, issuedAt);
            const draft = await readModuleDefinitionDraft(transaction, scope, { rootId: root.data });
            const authority = createBuilderAuthority({ transaction, scope, targetFacts: moduleTargetFacts });
            await requireBuilderAuthority(authority, { kind: "draft_change", rootId: draft.rootId });
            const current = await readModuleDefinitionDraft(transaction, scope, {
              rootId: draft.rootId,
              expectedDraftRevision: draft.draftRevision,
            });
            if (canonicalJson(current) !== canonicalJson(draft)) return invalidResult();
            const fields = describe(draft);
            await evaluateDraftPermission(
              transaction, scope, resolved.session, issuedAt, context, draft, dependencies.access,
            );
            return { kind: "available", draft, fields } as const;
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
              ? declined(surface, "REFUSED_BY_REQUEST_SERVICE", "context_changed")
              : { kind: "temporarily_unavailable" }));
    } catch (error) {
      return unexpected(surface, error);
    }
  };

  /**
   * One atomic read, plan, validate, write and reread path for a module draft field edit in the
   * initiating HUMAN transaction. `plan` patches the server-read source and names how failures are located.
   */
  const commitFieldEdit = async <Outcome, Failure>(
    organizationId: z.infer<typeof organizationIdSchema>,
    request: Readonly<{
      rootId: z.infer<typeof moduleRootIdSchema>;
      expectedDraftRevision: number;
      expectedSavedSourceFingerprint: string;
    }>,
    session: IdentitySession,
    plan: (
      previous: StoredModuleDefinitionDraft,
      context: HumanContext,
    ) => PlannedEdit,
    onSaved: (draft: StoredModuleDefinitionDraft) => Outcome,
    onFailure: (error: unknown) => Failure,
  ) => {
    let failure: Failure | undefined;
    const result = await humanOrganizationRequests().runChange(
      session,
      { organizationId },
      async (transaction: RequestDatabaseTransaction, scope: SelectedOrganizationScope, issuedAt: string) => {
        try {
          const context = await readLiveContext(transaction, scope, session, issuedAt);
          const previous = await readModuleDefinitionDraft(transaction, scope, {
            rootId: request.rootId,
            expectedDraftRevision: request.expectedDraftRevision,
          });
          if (
            !sameId(previous.organizationId, scope.organizationId) ||
            previous.sourceFingerprint !== request.expectedSavedSourceFingerprint
          )
            throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
          const authority = createBuilderAuthority({ transaction, scope, targetFacts: moduleTargetFacts });
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: previous.rootId });
          const planned = plan(previous, context);
          const shape = moduleSourceDocumentSchema.safeParse(planned.source);
          if (!shape.success)
            throw new LocatedValidationFailure(
              translateDefinitionSchemaError(shape.error, planned.translation),
            );
          const validation = validateDefinitionSource(shape.data);
          if (!validation.valid)
            throw new LocatedValidationFailure(
              translateDefinitionRuleFailures(validation.failures, {
                correlationId: planned.translation.correlationId,
                rootLocation: planned.translation.rootLocation,
              }),
            );
          const reread = await saveModuleDraftEdit(transaction, scope, previous, shape.data);
          await evaluateDraftPermission(
            transaction, scope, session, issuedAt, context, reread, dependencies.access,
          );
          return onSaved(reread);
        } catch (error) {
          failure = onFailure(error);
          // Every completion or validation failure escapes runChange and rolls back all partial writes.
          throw error;
        }
      },
    );
    return { result, failure };
  };

  const saveFieldEdit = async <Descriptor>(
    surface: Surface,
    candidateOrganizationId: string,
    parsed: z.ZodSafeParseResult<{
      rootId: z.infer<typeof moduleRootIdSchema>;
      expectedDraftRevision: number;
      expectedSavedSourceFingerprint: string;
    }>,
    sessionResolution: IdentitySessionResolution,
    plan: (previous: StoredModuleDefinitionDraft, context: HumanContext) => PlannedEdit,
    describe: (draft: StoredModuleDefinitionDraft) => readonly Descriptor[],
  ): Promise<FieldEditResult<Descriptor>> => {
    const organization = organizationIdSchema.safeParse(candidateOrganizationId);
    if (!organization.success || !parsed.success)
      return declined(surface, "REQUEST_INVALID", "source_invalid");
    try {
      const resolved = sessionResolution;
      if (resolved.kind !== "active")
        return resolved.kind === "temporarily_unavailable"
          ? { kind: "temporarily_unavailable" }
          : declined(surface, "SESSION_NOT_ACTIVE", "session_ended");
      const { result, failure } = await commitFieldEdit<FieldEditResult<Descriptor>, FieldEditResult<Descriptor>>(
        organization.data,
        parsed.data,
        resolved.session,
        plan,
        (draft) => ({ kind: "available", draft, fields: describe(draft) }),
        safeFailure,
      );
      return result.kind === "available"
        ? result.value
        : (failure ??
            (result.kind === "unavailable"
              ? declined(surface, "REFUSED_BY_REQUEST_SERVICE", "context_changed")
              : { kind: "temporarily_unavailable" }));
    } catch (error) {
      return unexpected(surface, error);
    }
  };

  const loadStudioModuleFieldLabel = (
    organizationId: string,
    rootId: string,
    session: IdentitySessionResolution,
  ) => readFields(labelSurface, organizationId, rootId, session, fieldDescriptors);

  /** Patch exactly one semantic field label on server-read source. */
  const saveStudioModuleFieldLabel = (
    organizationId: string,
    candidate: unknown,
    session: IdentitySessionResolution,
  ) => {
    const request = labelRequestSchema.safeParse(candidate);
    return saveFieldEdit(
      labelSurface,
      organizationId,
      request,
      session,
      (previous, context) => {
        if (!request.success) return invalidResult();
        const records = previous.source.body.record_types.filter(
          (item) => item.id === request.data.recordAlias,
        );
        const record = records[0];
        const fields = record?.fields.filter((item) => item.id === request.data.fieldAlias);
        const field = fields?.[0];
        if (records.length !== 1 || record === undefined || fields?.length !== 1 || field === undefined)
          throw new DefinitionError("INVALID_DEFINITION_COMMAND");
        const translation = {
          correlationId: context.correlationId,
          rootLocation: fieldLocation(previous, record.key, field.key),
        };
        const label = labelSchema.safeParse(request.data.label);
        if (!label.success)
          throw new LocatedValidationFailure(translateDefinitionSchemaError(label.error, translation));
        const source = structuredClone(previous.source);
        // Semantic identity determines the destination; array order is never request authority.
        const destination = source.body.record_types
          .find((item) => item.id === record.id)
          ?.fields.find((item) => item.id === field.id);
        if (destination === undefined) return invalidResult();
        destination.label = label.data;
        return { source, translation };
      },
      fieldDescriptors,
    );
  };

  const loadStudioModuleTextFieldSettings = (
    organizationId: string,
    rootId: string,
    session: IdentitySessionResolution,
  ) => readFields(textSurface, organizationId, rootId, session, textFieldDescriptors);

  /** Save only text settings.max_length on server-read source. */
  const saveStudioModuleTextFieldSettings = (
    organizationId: string,
    candidate: unknown,
    session: IdentitySessionResolution,
  ) => {
    const request = textSettingsRequestSchema.safeParse(candidate);
    return saveFieldEdit(
      textSurface,
      organizationId,
      request,
      session,
      (previous, context) => {
        if (!request.success) return invalidResult();
        const selected = textFieldValidationContext(
          previous,
          request.data.recordAlias,
          request.data.fieldAlias,
          context.correlationId,
        );
        const source = structuredClone(previous.source);
        const targetRecords = source.body.record_types.filter((item) => item.id === selected.record.id);
        const targetRecord = targetRecords[0];
        const targetFields = targetRecord?.fields.filter((item) => item.id === selected.field.id);
        const targetField = targetFields?.[0];
        if (
          targetRecords.length !== 1 ||
          targetRecord === undefined ||
          targetFields?.length !== 1 ||
          targetField === undefined ||
          targetField.type !== "text"
        )
          return invalidResult();
        targetField.settings.max_length = request.data.maxLength;
        const unchanged = structuredClone(source);
        const unchangedRecord = unchanged.body.record_types.find((item) => item.id === selected.record.id);
        const unchangedField = unchangedRecord?.fields.find((item) => item.id === selected.field.id);
        if (unchangedField === undefined || unchangedField.type !== "text") return invalidResult();
        unchangedField.settings.max_length = selected.field.settings.max_length;
        if (canonicalJson(unchanged) !== canonicalJson(previous.source)) return invalidResult();
        return { source, translation: selected.translation };
      },
      textFieldDescriptors,
    );
  };

  /** Add a field to one record type, or edit one field's label, type and required flag, in the draft. */
  const saveStudioModuleFieldChange = async (
    candidateOrganizationId: string,
    candidate: unknown,
    sessionResolution: IdentitySessionResolution,
  ): Promise<StudioModuleFieldChangeResult> => {
    const organization = organizationIdSchema.safeParse(candidateOrganizationId);
    const request = fieldChangeSchema.safeParse(candidate);
    if (!organization.success || !request.success) {
      console.warn(
        "[studio] module field change request was malformed:",
        request.success
          ? "organization"
          : request.error.issues.map((issue) => `${issue.path.join(".")}=${issue.code}`).join(","),
      );
      return { kind: "refused", reason: "INVALID_REQUEST" };
    }
    try {
      const resolved = sessionResolution;
      if (resolved.kind !== "active") {
        if (resolved.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
        console.warn(`[studio] module field change without an active session: ${resolved.kind}`);
        return { kind: "refused", reason: "SESSION_NOT_ACTIVE" };
      }
      const { result, failure } = await commitFieldEdit<StudioModuleFieldChangeResult, StudioModuleFieldChangeResult>(
        organization.data,
        request.data,
        resolved.session,
        (previous, context) => {
          const source = structuredClone(previous.source);
          const record = source.body.record_types.find((item) => item.id === request.data.recordAlias);
          if (record === undefined) throw new DefinitionError("INVALID_DEFINITION_COMMAND");
          const existing =
            request.data.fieldAlias === undefined
              ? undefined
              : record.fields.find((item) => item.id === request.data.fieldAlias);
          if (request.data.fieldAlias !== undefined && existing === undefined)
            throw new DefinitionError("INVALID_DEFINITION_COMMAND");
          const key =
            existing?.key ??
            deriveFieldKey(request.data.label, new Set(record.fields.map((item) => item.key)));
          const translation = {
            correlationId: context.correlationId,
            rootLocation: fieldLocation(previous, record.key, key ?? "new_field"),
          };
          const rejected = (error: z.ZodError) =>
            new LocatedValidationFailure(translateDefinitionSchemaError(error, translation));
          const label = labelSchema.safeParse(request.data.label);
          if (!label.success) throw rejected(label.error);
          if (key === undefined) {
            const keyShape = builderKeySchema.safeParse("");
            if (!keyShape.success) throw rejected(keyShape.error);
            throw new DefinitionError("INVALID_DEFINITION_COMMAND");
          }
          // A type the schema does not offer still goes to the schema, so the schema's own reason is what the builder reads.
          const offered = offeredFieldTypes(previous.source).find((item) => item.type === request.data.type);
          const settings = offered === undefined ? {} : settingsForType(offered, request.data.maxLength);
          if (existing === undefined) {
            const taken = new Set(
              source.body.record_types.flatMap((item) => [item.id, ...item.fields.map((field) => field.id)]),
            );
            record.fields.push(
              newAuthoredField(
                deriveFieldAlias(record.key, key, taken),
                key,
                label.data,
                request.data.required,
                request.data.type,
                settings,
              ),
            );
          } else {
            const destination = existing as Record<string, unknown>;
            destination.label = label.data;
            destination.required = request.data.required;
            if (existing.type !== request.data.type) {
              // A default and settings belong to one type; the previous ones cannot carry over.
              delete destination.default;
              destination.type = request.data.type;
              destination.settings = settings;
            }
          }
          return { source, translation };
        },
        (draft) => ({ kind: "available", draft }),
        changeFailure,
      );
      if (result.kind === "available") return result.value;
      if (failure !== undefined) return failure;
      if (result.kind === "unavailable") {
        console.warn("[studio] module field change unavailable for the organization request");
        return { kind: "refused", reason: "ORGANIZATION_REQUEST_UNAVAILABLE" };
      }
      return { kind: "temporarily_unavailable" };
    } catch (error) {
      return changeFailure(error);
    }
  };

  return {
    loadStudioModuleFieldLabel,
    saveStudioModuleFieldLabel,
    loadStudioModuleTextFieldSettings,
    saveStudioModuleTextFieldSettings,
    saveStudioModuleFieldChange,
  };
};
