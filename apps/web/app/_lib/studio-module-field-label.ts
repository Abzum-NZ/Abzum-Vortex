import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "@web/platform-server";
import {
  builderKeySchema, canonicalJson, databaseRevision, databaseTimestamp, describeFailure, fingerprintSchema, labelSchema,
  moduleRootIdSchema, moduleSourceDocumentSchema, organizationAccessDeclarationSchema,
  organizationIdSchema, organizationPermissionEligibilitySchema, platformIdSchema, revisionSchema, sameId,
  sessionContextSchema, storedModuleDefinitionDraftSchema, timestampSchema,
  translateDefinitionRuleFailures, translateDefinitionSchemaError,
  type DefinitionValidationLocation, type DefinitionValidationResult, type IdentitySession,
  type ModuleSourceDocument, type SelectedOrganizationScope,
} from "@vortex/platform/schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "@web/platform-server";
import {
  BuilderAuthorityError, createDefinitionStore, fingerprintCanonicalValue,
  readModuleDefinitionDraft, requireBuilderAuthority, validateDefinitionSource,
  type StoredModuleDefinitionDraft,
} from "@web/platform-server";
import { platformPermissionDeclarations, platformPermissionOwnerId } from "@vortex/definitions";
import { z } from "zod";
import {
  deriveFieldAlias, deriveFieldKey, newAuthoredField, offeredFieldTypes, settingsForType,
} from "./studio-module-field-shape";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";
import { DefinitionError } from "@web/platform-server";

export type StudioModuleFieldDescriptor = Readonly<{
  recordAlias: string; recordKey: string; recordName: string;
  fieldAlias: string; fieldKey: string; label: string; type: string;
}>;

export type StudioModuleFieldLabelResult =
  | Readonly<{ kind: "available"; draft: StoredModuleDefinitionDraft; fields: readonly StudioModuleFieldDescriptor[] }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{ kind: "conflict"; reason?: "draft_changed" | "draft_missing" | "alias_conflict" }>
  | Readonly<{ kind: "refused"; reason?: "permission_missing" | "source_invalid" | "context_changed" | "session_ended" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

// Aliases only select a member of the protected authored source; they convey no identity or grant.
const requestSchema = z.object({
  rootId: moduleRootIdSchema,
  expectedDraftRevision: revisionSchema,
  expectedSavedSourceFingerprint: fingerprintSchema,
  recordAlias: z.string().min(1).max(160),
  fieldAlias: z.string().min(1).max(160),
  label: z.string().max(1_000),
}).strict();

class LocatedValidationFailure extends Error {
  constructor(readonly validation: DefinitionValidationResult) {
    super("STUDIO_MODULE_VALIDATION_FAILED");
  }
}

function invalidResult(): never {
  throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
}

/** A refusal decided before or after the database transaction: one log line with a stable code. */
const declined = (code: string, reason: "permission_missing" | "source_invalid" | "context_changed" | "session_ended"): StudioModuleFieldLabelResult => {
  console.error(`[studio] field label refused STUDIO_FIELD_LABEL_${code}`);
  return { kind: "refused", reason };
};

// Every failure mapped here is rethrown through the request transaction, where the request boundary logs
// its cause and stable code once.
const safeFailure = (error: unknown): StudioModuleFieldLabelResult => {
  const refuse = (reason: "permission_missing" | "source_invalid" | "context_changed"): StudioModuleFieldLabelResult => {
    return { kind: "refused", reason };
  };
  const conflict = (reason: "draft_changed" | "draft_missing" | "alias_conflict"): StudioModuleFieldLabelResult => {
    return { kind: "conflict", reason };
  };
  if (error instanceof LocatedValidationFailure) return { kind: "validation_failed", validation: error.validation };
  if (error instanceof BuilderAuthorityError) return refuse("permission_missing");
  if (error instanceof DefinitionError) {
    if (error.code === "DEFINITION_DRAFT_STALE_OR_MISSING") return conflict("draft_changed");
    if (error.code === "DEFINITION_ROOT_MISSING") return conflict("draft_missing");
    if (error.code === "DEFINITION_IDENTITY_ALIAS_CONFLICT") return conflict("alias_conflict");
    if (error.code === "INVALID_DEFINITION_COMMAND" || error.code === "INVALID_DEFINITION_SOURCE") return refuse("source_invalid");
    if (error.code === "DEFINITION_CONTEXT_REFUSED" || error.code === "DEFINITION_STORAGE_VALIDATION_FAILED")
      return refuse("context_changed");
  }
  return { kind: "temporarily_unavailable" };
};

/** Only a trusted same-organization Module read can establish these non-Application facts. */
const moduleTargetFacts: BuilderTargetFactsReader = async (transaction, scope, candidateRootId) => {
  const root = moduleRootIdSchema.safeParse(candidateRootId);
  if (!root.success) throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  const draft = await readModuleDefinitionDraft(transaction, scope, { rootId: root.data });
  if (draft.kind !== "module" || !sameId(draft.rootId, root.data) || !sameId(draft.organizationId, scope.organizationId))
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  return { isSystemApplication: false };
};

const fieldDescriptors = (draft: StoredModuleDefinitionDraft): readonly StudioModuleFieldDescriptor[] =>
  draft.source.body.record_types.flatMap((record) => record.fields.map((field) => ({
    recordAlias: record.id, recordKey: record.key, recordName: record.name,
    fieldAlias: field.id, fieldKey: field.key, label: field.label, type: field.type,
  })));

const databaseClock = async (transaction: RequestDatabaseTransaction): Promise<number> => {
  const rows = await transaction.query<DatabaseRow>`select pg_catalog.clock_timestamp() as completed_at`;
  const parsed = timestampSchema.safeParse(databaseTimestamp(rows[0]?.completed_at));
  if (rows.length !== 1 || !parsed.success) return invalidResult();
  return Date.parse(parsed.data);
};

/** Bind the live protected context to this request's freshly resolved session and scope. */
const readLiveContext = async (
  transaction: RequestDatabaseTransaction, scope: SelectedOrganizationScope, session: IdentitySession, issuedAt: string,
) => {
  const rows = await transaction.query<DatabaseRow>`select vortex_access.validated_human_request_context() as context`;
  const transport = rows[0]?.context;
  if (rows.length !== 1 || transport === null || typeof transport !== "object" || Array.isArray(transport) ||
      !("channel" in transport) || transport.channel !== "web") return invalidResult();
  const context = sessionContextSchema.parse(Object.fromEntries(Object.entries(transport).filter(([key]) => key !== "channel")));
  const now = await databaseClock(transaction);
  if (context.callerKind !== "human" || Object.hasOwn(scope, "applicationRootId") || Object.hasOwn(context, "applicationRootId") ||
      context.delegatedContext !== undefined || context.supportContext !== undefined ||
      !sameId(context.tenantId, scope.tenantId) || !sameId(context.organizationId, scope.organizationId) ||
      !sameId(context.organizationAccountId, scope.organizationAccountId) || context.accessVersion !== scope.accessVersion ||
      !sameId(context.identityId, session.identityId) || !sameId(context.sessionId, session.sessionId) ||
      context.authenticationStrength !== session.authenticationStrength || context.issuedAt !== issuedAt ||
      context.expiresAt !== session.accessTokenExpiresAt || context.accessTokenIssuedAt !==
        (session.primaryAuthenticatedAt !== undefined || session.multiFactorAuthenticatedAt !== undefined ? session.accessTokenIssuedAt : undefined) ||
      context.primaryAuthenticatedAt !== session.primaryAuthenticatedAt || context.multiFactorAuthenticatedAt !== session.multiFactorAuthenticatedAt ||
      Date.parse(context.issuedAt) > now || Date.parse(context.expiresAt) <= now ||
      Date.parse(context.issuedAt) >= Date.parse(context.expiresAt))
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  return context;
};

/** A row read or written is not completion authority: re-evaluate the exact live permission. */
const assertLiveCompletion = async (
  transaction: RequestDatabaseTransaction, scope: SelectedOrganizationScope, session: IdentitySession,
  issuedAt: string, originalContext: Awaited<ReturnType<typeof readLiveContext>>, draft: StoredModuleDefinitionDraft,
) => {
  await moduleTargetFacts(transaction, scope, draft.rootId);
  const permission = platformPermissionDeclarations.find((item) => item.key === "platform.organization.definition_drafts.manage");
  if (permission === undefined) throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  const declaration = organizationAccessDeclarationSchema.parse({
    operationKey: permission.key, action: { actionKind: permission.actionKind }, target: { kind: "organization" },
    requiredPermission: { ownerKind: "platform", ownerId: platformPermissionOwnerId, permissionId: permission.permissionId },
    recentAuthentication: { kind: "none" }, authority: { kind: "permission" },
  });
  const rows = await transaction.query<DatabaseRow>`
    select eligibility.*, pg_catalog.clock_timestamp() as completed_at
    from vortex_access.evaluate_organization_permission_eligibility(${JSON.stringify(declaration)}::text::jsonb) as eligibility
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) return invalidResult();
  const decision = organizationPermissionEligibilitySchema.safeParse({
    outcome: row.outcome, operationKey: row.operation_key, target: { kind: row.target_kind },
    organizationId: row.organization_id, organizationAccountId: row.organization_account_id,
    accessVersion: databaseRevision(row.access_version), checkedAt: databaseTimestamp(row.checked_at),
    correlationId: row.correlation_id,
    ...(row.outcome === "eligible" ? { validUntil: databaseTimestamp(row.valid_until) } : { reasonCode: row.reason_code }),
  });
  const completed = timestampSchema.safeParse(databaseTimestamp(row.completed_at));
  const current = await readLiveContext(transaction, scope, session, issuedAt);
  if (!decision.success || decision.data.outcome !== "eligible" || !completed.success ||
      canonicalJson(current) !== canonicalJson(originalContext))
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  const eligible = decision.data;
  const now = Date.parse(completed.data);
  if (eligible.operationKey !== permission.key || eligible.target.kind !== "organization" ||
      row.target_application_root_id !== null || row.reason_code !== null ||
      !sameId(eligible.organizationId, scope.organizationId) || !sameId(eligible.organizationAccountId, scope.organizationAccountId) ||
      eligible.accessVersion !== scope.accessVersion || !sameId(eligible.correlationId, current.correlationId) ||
      Date.parse(eligible.checkedAt) > now || Date.parse(eligible.validUntil) <= now || Date.parse(draft.updatedAt) > now ||
      (await databaseClock(transaction)) >= Math.min(Date.parse(eligible.validUntil), Date.parse(current.expiresAt)))
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
};

const verifySaved = (
  candidate: unknown, source: ModuleSourceDocument, previous: StoredModuleDefinitionDraft,
  scope: SelectedOrganizationScope, startedAt: number,
): StoredModuleDefinitionDraft => {
  const parsed = storedModuleDefinitionDraftSchema.safeParse(candidate);
  if (!parsed.success) return invalidResult();
  const draft = parsed.data;
  if (!sameId(draft.organizationId, scope.organizationId) || !sameId(draft.rootId, previous.rootId) ||
      draft.key !== previous.key || draft.source.key !== source.key || draft.source.root_alias !== previous.source.root_alias ||
      draft.draftRevision !== previous.draftRevision + 1 || draft.sourceContractVersion !== source.source_contract_version ||
      draft.sourceFingerprint !== fingerprintCanonicalValue(source) || canonicalJson(draft.source) !== canonicalJson(source) ||
      !sameId(draft.updatedBy, scope.organizationAccountId) || Date.parse(draft.createdAt) !== Date.parse(previous.createdAt) ||
      !sameId(draft.createdBy, previous.createdBy) || draft.publishedRevision !== previous.publishedRevision ||
      Date.parse(draft.updatedAt) < startedAt || Date.parse(draft.updatedAt) < Date.parse(previous.updatedAt) ||
      Date.parse(draft.updatedAt) < Date.parse(draft.createdAt) || draft.restoredFromReleaseRevision !== undefined ||
      draft.restoredFromSourceFingerprint !== undefined || draft.restoredAt !== undefined || draft.restoredBy !== undefined ||
      draft.restoreCorrelationId !== undefined) return invalidResult();
  return draft;
};

export const loadStudioModuleFieldLabel = async (
  candidateOrganizationId: string, candidateRootId: string,
): Promise<StudioModuleFieldLabelResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = moduleRootIdSchema.safeParse(candidateRootId);
  if (!organization.success || !root.success) return declined("REQUEST_INVALID", "source_invalid");
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : declined("SESSION_NOT_ACTIVE", "session_ended");
    let failure: StudioModuleFieldLabelResult | undefined;
    const result = await humanOrganizationRequests().run(resolved.session, { organizationId: organization.data },
      async (transaction, scope, issuedAt) => {
        try {
          const context = await readLiveContext(transaction, scope, resolved.session, issuedAt);
          const draft = await readModuleDefinitionDraft(transaction, scope, { rootId: root.data });
          const authority = createBuilderAuthority({ transaction, scope, targetFacts: moduleTargetFacts });
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: draft.rootId });
          const current = await readModuleDefinitionDraft(transaction, scope, {
            rootId: draft.rootId, expectedDraftRevision: draft.draftRevision,
          });
          if (canonicalJson(current) !== canonicalJson(draft)) return invalidResult();
          const fields = fieldDescriptors(draft);
          await assertLiveCompletion(transaction, scope, resolved.session, issuedAt, context, draft);
          return { kind: "available", draft, fields } as const;
        } catch (error) { failure = safeFailure(error); throw error; }
      });
    return result.kind === "available" ? result.value : failure ?? (result.kind === "unavailable"
      ? declined("REFUSED_BY_REQUEST_SERVICE", "context_changed") : { kind: "temporarily_unavailable" });
  } catch (error) { console.error(`[studio] field label failed unexpectedly STUDIO_FIELD_LABEL_FAILED: ${describeFailure(error)}`); return { kind: "temporarily_unavailable" }; }
};

/** Patch exactly one semantic field on server-read source in the initiating HUMAN transaction. */
export const saveStudioModuleFieldLabel = async (
  candidateOrganizationId: string, candidate: unknown,
): Promise<StudioModuleFieldLabelResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const request = requestSchema.safeParse(candidate);
  if (!organization.success || !request.success) return declined("REQUEST_INVALID", "source_invalid");
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : declined("SESSION_NOT_ACTIVE", "session_ended");
    let failure: StudioModuleFieldLabelResult | undefined;
    const result = await humanOrganizationRequests().runChange(resolved.session, { organizationId: organization.data },
      async (transaction, scope, issuedAt) => {
        try {
          const context = await readLiveContext(transaction, scope, resolved.session, issuedAt);
          const previous = await readModuleDefinitionDraft(transaction, scope, {
            rootId: request.data.rootId, expectedDraftRevision: request.data.expectedDraftRevision,
          });
          if (!sameId(previous.organizationId, organization.data) || previous.sourceFingerprint !== request.data.expectedSavedSourceFingerprint)
            throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
          const authority = createBuilderAuthority({ transaction, scope, targetFacts: moduleTargetFacts });
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: previous.rootId });
          const records = previous.source.body.record_types.filter((item) => item.id === request.data.recordAlias);
          const record = records[0];
          const fields = record?.fields.filter((item) => item.id === request.data.fieldAlias);
          const field = fields?.[0];
          if (records.length !== 1 || record === undefined || fields?.length !== 1 || field === undefined)
            throw new DefinitionError("INVALID_DEFINITION_COMMAND");
          const location: DefinitionValidationLocation = { documentKind: "module", documentKey: previous.key,
            segments: [{ kind: "module", key: previous.key }, { kind: "record_type", key: record.key }, { kind: "field", key: field.key }] };
          const label = labelSchema.safeParse(request.data.label);
          if (!label.success) throw new LocatedValidationFailure(translateDefinitionSchemaError(label.error,
            { correlationId: context.correlationId, rootLocation: location }));
          const source = structuredClone(previous.source);
          // Semantic identity determines the destination; array order is never request authority.
          const destination = source.body.record_types.find((item) => item.id === record.id)?.fields.find((item) => item.id === field.id);
          if (destination === undefined) return invalidResult();
          destination.label = label.data;
          const shape = moduleSourceDocumentSchema.safeParse(source);
          if (!shape.success) throw new LocatedValidationFailure(translateDefinitionSchemaError(shape.error,
            { correlationId: context.correlationId, rootLocation: location }));
          const validation = validateDefinitionSource(shape.data);
          if (!validation.valid) throw new LocatedValidationFailure(translateDefinitionRuleFailures(validation.failures,
            { correlationId: context.correlationId, rootLocation: location }));
          const startedAt = await databaseClock(transaction);
          const returned = verifySaved(await createDefinitionStore(transaction, authority).saveDraft({
            rootId: platformIdSchema.parse(previous.rootId), expectedDraftRevision: previous.draftRevision, source: shape.data,
          }), shape.data, previous, scope, startedAt);
          const reread = verifySaved(await readModuleDefinitionDraft(transaction, scope, {
            rootId: returned.rootId, expectedDraftRevision: returned.draftRevision,
          }), shape.data, previous, scope, startedAt);
          // SQL row timestamps and JSON timestamps may spell the same instant differently.
          // Both full source/identity/revision receipts were checked above; compare their times as instants.
          if (Date.parse(reread.createdAt) !== Date.parse(returned.createdAt) ||
              Date.parse(reread.updatedAt) !== Date.parse(returned.updatedAt) || reread.createdAt !== previous.createdAt)
            return invalidResult();
          const descriptors = fieldDescriptors(reread);
          await assertLiveCompletion(transaction, scope, resolved.session, issuedAt, context, reread);
          return { kind: "available", draft: reread, fields: descriptors } as const;
        } catch (error) {
          failure = safeFailure(error);
          // Every completion/validation failure escapes runChange and rolls back all partial writes.
          throw error;
        }
      });
    return result.kind === "available" ? result.value : failure ?? (result.kind === "unavailable"
      ? declined("REFUSED_BY_REQUEST_SERVICE", "context_changed") : { kind: "temporarily_unavailable" });
  } catch (error) { console.error(`[studio] field label failed unexpectedly STUDIO_FIELD_LABEL_FAILED: ${describeFailure(error)}`); return { kind: "temporarily_unavailable" }; }
};

export type StudioModuleFieldChangeResult =
  | Readonly<{ kind: "available"; draft: StoredModuleDefinitionDraft }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{ kind: "conflict"; reason: string }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

// Without a field alias the request adds a field to the record type; with one it edits that field.
const fieldChangeSchema = z.object({
  rootId: moduleRootIdSchema,
  expectedDraftRevision: revisionSchema,
  expectedSavedSourceFingerprint: fingerprintSchema,
  recordAlias: z.string().min(1).max(160),
  fieldAlias: z.string().min(1).max(160).optional(),
  label: z.string().max(1_000),
  type: z.string().min(1).max(80),
  required: z.boolean(),
  maxLength: z.number().int().optional(),
}).strict();

const changeFailure = (error: unknown): StudioModuleFieldChangeResult => {
  const cause = describeFailure(error);
  if (error instanceof LocatedValidationFailure) {
    console.warn(`[studio] module field change failed validation: ${error.validation.errors.map((item) => item.code).join(",")}`);
    return { kind: "validation_failed", validation: error.validation };
  }
  if (error instanceof BuilderAuthorityError) {
    console.warn(`[studio] module field change refused by builder authority: ${cause} code=${error.code}`);
    return { kind: "refused", reason: error.code };
  }
  if (error instanceof DefinitionError) {
    if (error.code === "DEFINITION_DRAFT_STALE_OR_MISSING" || error.code === "DEFINITION_ROOT_MISSING" ||
        error.code === "DEFINITION_IDENTITY_ALIAS_CONFLICT") {
      console.warn(`[studio] module field change conflicted: ${cause} code=${error.code}`);
      return { kind: "conflict", reason: error.code };
    }
    if (error.code === "INVALID_DEFINITION_COMMAND" || error.code === "INVALID_DEFINITION_SOURCE" ||
        error.code === "DEFINITION_CONTEXT_REFUSED" || error.code === "DEFINITION_STORAGE_VALIDATION_FAILED") {
      console.warn(`[studio] module field change refused: ${cause} code=${error.code}`);
      return { kind: "refused", reason: error.code };
    }
  }
  console.error(`[studio] module field change failed unexpectedly: ${cause}`);
  return { kind: "temporarily_unavailable" };
};

/** Add a field to one record type, or edit one field's label, type and required flag, in the draft. */
export const saveStudioModuleFieldChange = async (
  candidateOrganizationId: string, candidate: unknown,
): Promise<StudioModuleFieldChangeResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const request = fieldChangeSchema.safeParse(candidate);
  if (!organization.success || !request.success) {
    console.warn("[studio] module field change request was malformed:",
      request.success ? "organization" : request.error.issues.map((issue) => `${issue.path.join(".")}=${issue.code}`).join(","));
    return { kind: "refused", reason: "INVALID_REQUEST" };
  }
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") {
      if (resolved.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
      console.warn(`[studio] module field change without an active session: ${resolved.kind}`);
      return { kind: "refused", reason: "SESSION_NOT_ACTIVE" };
    }
    let failure: StudioModuleFieldChangeResult | undefined;
    const result = await humanOrganizationRequests().runChange(resolved.session, { organizationId: organization.data },
      async (transaction, scope, issuedAt) => {
        try {
          const context = await readLiveContext(transaction, scope, resolved.session, issuedAt);
          const previous = await readModuleDefinitionDraft(transaction, scope, {
            rootId: request.data.rootId, expectedDraftRevision: request.data.expectedDraftRevision,
          });
          if (!sameId(previous.organizationId, organization.data) || previous.sourceFingerprint !== request.data.expectedSavedSourceFingerprint)
            throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
          const authority = createBuilderAuthority({ transaction, scope, targetFacts: moduleTargetFacts });
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: previous.rootId });
          const source = structuredClone(previous.source);
          const record = source.body.record_types.find((item) => item.id === request.data.recordAlias);
          if (record === undefined) throw new DefinitionError("INVALID_DEFINITION_COMMAND");
          const existing = request.data.fieldAlias === undefined ? undefined
            : record.fields.find((item) => item.id === request.data.fieldAlias);
          if (request.data.fieldAlias !== undefined && existing === undefined) throw new DefinitionError("INVALID_DEFINITION_COMMAND");
          const key = existing?.key ?? deriveFieldKey(request.data.label, new Set(record.fields.map((item) => item.key)));
          const location: DefinitionValidationLocation = { documentKind: "module", documentKey: previous.key,
            segments: [{ kind: "module", key: previous.key }, { kind: "record_type", key: record.key }, { kind: "field", key: key ?? "new_field" }] };
          const rejected = (error: z.ZodError) => new LocatedValidationFailure(translateDefinitionSchemaError(error,
            { correlationId: context.correlationId, rootLocation: location }));
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
            const taken = new Set(source.body.record_types.flatMap((item) => [item.id, ...item.fields.map((field) => field.id)]));
            record.fields.push(newAuthoredField(deriveFieldAlias(record.key, key, taken), key, label.data,
              request.data.required, request.data.type, settings));
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
          const shape = moduleSourceDocumentSchema.safeParse(source);
          if (!shape.success) throw rejected(shape.error);
          const validation = validateDefinitionSource(shape.data);
          if (!validation.valid) throw new LocatedValidationFailure(translateDefinitionRuleFailures(validation.failures,
            { correlationId: context.correlationId, rootLocation: location }));
          const startedAt = await databaseClock(transaction);
          const returned = verifySaved(await createDefinitionStore(transaction, authority).saveDraft({
            rootId: platformIdSchema.parse(previous.rootId), expectedDraftRevision: previous.draftRevision, source: shape.data,
          }), shape.data, previous, scope, startedAt);
          const reread = verifySaved(await readModuleDefinitionDraft(transaction, scope, {
            rootId: returned.rootId, expectedDraftRevision: returned.draftRevision,
          }), shape.data, previous, scope, startedAt);
          if (Date.parse(reread.createdAt) !== Date.parse(returned.createdAt) ||
              Date.parse(reread.updatedAt) !== Date.parse(returned.updatedAt) || reread.createdAt !== previous.createdAt)
            return invalidResult();
          await assertLiveCompletion(transaction, scope, resolved.session, issuedAt, context, reread);
          return { kind: "available", draft: reread } as const;
        } catch (error) { failure = changeFailure(error); throw error; }
      });
    if (result.kind === "available") return result.value;
    if (failure !== undefined) return failure;
    if (result.kind === "unavailable") {
      console.warn("[studio] module field change unavailable for the organization request");
      return { kind: "refused", reason: "ORGANIZATION_REQUEST_UNAVAILABLE" };
    }
    return { kind: "temporarily_unavailable" };
  } catch (error) { return changeFailure(error); }
};
