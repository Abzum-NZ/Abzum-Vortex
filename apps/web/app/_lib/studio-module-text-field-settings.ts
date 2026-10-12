import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "@vortex/access";
import {
  canonicalJson, correlationIdSchema, databaseRevision, databaseTimestamp, fingerprintSchema,
  moduleRootIdSchema, moduleSourceDocumentSchema, organizationAccessDeclarationSchema,
  organizationIdSchema, organizationPermissionEligibilitySchema, platformIdSchema, revisionSchema, sameId,
  sessionContextSchema, storedModuleDefinitionDraftSchema, timestampSchema,
  translateDefinitionRuleFailures, translateDefinitionSchemaError,
  type DefinitionValidationLocation, type DefinitionValidationResult, type IdentitySession,
  type ModuleSourceDocument, type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  BuilderAuthorityError, createDefinitionStore, DefinitionStoreError, fingerprintCanonicalValue,
  readModuleDefinitionDraft, requireBuilderAuthority, validateDefinitionSource,
  type StoredModuleDefinitionDraft,
} from "@vortex/definition";
import { platformPermissionDeclarations, platformPermissionOwnerId } from "@vortex/modules";
import { z } from "zod";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";

type TextModuleField = Extract<ModuleSourceDocument["body"]["record_types"][number]["fields"][number], { type: "text" }>;

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

export type StudioModuleTextFieldSettingsResult =
  | Readonly<{ kind: "available"; draft: StoredModuleDefinitionDraft; fields: readonly StudioModuleTextFieldDescriptor[] }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

// Stable authored aliases select one field; they convey no identity or grant.
const requestSchema = z.object({
  rootId: moduleRootIdSchema,
  expectedDraftRevision: revisionSchema,
  expectedSavedSourceFingerprint: fingerprintSchema,
  recordAlias: z.string().min(1).max(160),
  fieldAlias: z.string().min(1).max(160),
  maxLength: z.number().int().refine(Number.isSafeInteger),
}).strict();

class LocatedValidationFailure extends Error {
  constructor(readonly validation: DefinitionValidationResult) {
    super("STUDIO_MODULE_VALIDATION_FAILED");
  }
}

function invalidResult(): never {
  throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
}

const safeFailure = (error: unknown): StudioModuleTextFieldSettingsResult => {
  if (error instanceof LocatedValidationFailure) return { kind: "validation_failed", validation: error.validation };
  if (error instanceof BuilderAuthorityError) return { kind: "refused" };
  if (error instanceof DefinitionStoreError) {
    if (error.code === "DEFINITION_DRAFT_STALE_OR_MISSING" || error.code === "DEFINITION_ROOT_MISSING" ||
        error.code === "DEFINITION_IDENTITY_ALIAS_CONFLICT") return { kind: "conflict" };
    if (error.code === "INVALID_DEFINITION_COMMAND" || error.code === "INVALID_DEFINITION_SOURCE" ||
        error.code === "DEFINITION_CONTEXT_REFUSED" || error.code === "DEFINITION_STORAGE_VALIDATION_FAILED")
      return { kind: "refused" };
  }
  return { kind: "temporarily_unavailable" };
};

/** Only a trusted same-organization Module read can establish these non-Application facts. */
const moduleTargetFacts: BuilderTargetFactsReader = async (transaction, scope, candidateRootId) => {
  const root = moduleRootIdSchema.safeParse(candidateRootId);
  if (!root.success) throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  const draft = await readModuleDefinitionDraft(transaction, scope, { rootId: root.data });
  if (draft.kind !== "module" || !sameId(draft.rootId, root.data) || !sameId(draft.organizationId, scope.organizationId))
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  return { isSystemApplication: false };
};

const textFieldDescriptors = (draft: StoredModuleDefinitionDraft): readonly StudioModuleTextFieldDescriptor[] =>
  draft.source.body.record_types.flatMap((record) => record.fields.flatMap((field) => {
    if (field.type !== "text") return [];
    return [{
      recordAlias: record.id,
      recordKey: record.key,
      recordName: record.name,
      fieldAlias: field.id,
      fieldKey: field.key,
      label: field.label,
      type: "text" as const,
      maxLength: field.settings.max_length,
      ...(field.settings.format === undefined ? {} : { format: field.settings.format }),
    }];
  }));

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
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  return context;
};

/** A row read or written is not completion authority: re-evaluate the exact live permission. */
const assertLiveCompletion = async (
  transaction: RequestDatabaseTransaction, scope: SelectedOrganizationScope, session: IdentitySession,
  issuedAt: string, originalContext: Awaited<ReturnType<typeof readLiveContext>>, draft: StoredModuleDefinitionDraft,
) => {
  await moduleTargetFacts(transaction, scope, draft.rootId);
  const permission = platformPermissionDeclarations.find((item) => item.key === "platform.organization.definition_drafts.manage");
  if (permission === undefined) throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
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
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  const eligible = decision.data;
  const now = Date.parse(completed.data);
  if (eligible.operationKey !== permission.key || eligible.target.kind !== "organization" ||
      row.target_application_root_id !== null || row.reason_code !== null ||
      !sameId(eligible.organizationId, scope.organizationId) || !sameId(eligible.organizationAccountId, scope.organizationAccountId) ||
      eligible.accessVersion !== scope.accessVersion || !sameId(eligible.correlationId, current.correlationId) ||
      Date.parse(eligible.checkedAt) > now || Date.parse(eligible.validUntil) <= now || Date.parse(draft.updatedAt) > now ||
      (await databaseClock(transaction)) >= Math.min(Date.parse(eligible.validUntil), Date.parse(current.expiresAt)))
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
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

const settingLocation = (
  draft: StoredModuleDefinitionDraft, recordKey: string, fieldKey: string, settingKey: string,
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

const fieldValidationContext = (
  draft: StoredModuleDefinitionDraft,
  recordAlias: string,
  fieldAlias: string,
  correlationId: z.infer<typeof correlationIdSchema>,
) => {
  const recordIndexes = draft.source.body.record_types.flatMap((record, index) => record.id === recordAlias ? [index] : []);
  const record = draft.source.body.record_types[recordIndexes[0] ?? -1];
  const fieldIndexes = record?.fields.flatMap((field, index) => field.id === fieldAlias ? [index] : []) ?? [];
  const field = record?.fields[fieldIndexes[0] ?? -1];
  if (recordIndexes.length !== 1 || record === undefined || fieldIndexes.length !== 1 || field === undefined || field.type !== "text")
    throw new DefinitionStoreError("INVALID_DEFINITION_COMMAND");
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

export const loadStudioModuleTextFieldSettings = async (
  candidateOrganizationId: string, candidateRootId: string,
): Promise<StudioModuleTextFieldSettingsResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = moduleRootIdSchema.safeParse(candidateRootId);
  if (!organization.success || !root.success) return { kind: "refused" };
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    let failure: StudioModuleTextFieldSettingsResult | undefined;
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
          const fields = textFieldDescriptors(draft);
          await assertLiveCompletion(transaction, scope, resolved.session, issuedAt, context, draft);
          return { kind: "available", draft, fields } as const;
        } catch (error) { failure = safeFailure(error); throw error; }
      });
    return result.kind === "available" ? result.value : failure ?? (result.kind === "unavailable"
      ? { kind: "refused" } : { kind: "temporarily_unavailable" });
  } catch { return { kind: "temporarily_unavailable" }; }
};

/** Save only text settings.max_length on server-read source in the initiating HUMAN transaction. */
export const saveStudioModuleTextFieldSettings = async (
  candidateOrganizationId: string, candidate: unknown,
): Promise<StudioModuleTextFieldSettingsResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const request = requestSchema.safeParse(candidate);
  if (!organization.success || !request.success) return { kind: "refused" };
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    let failure: StudioModuleTextFieldSettingsResult | undefined;
    const result = await humanOrganizationRequests().runChange(resolved.session, { organizationId: organization.data },
      async (transaction, scope, issuedAt) => {
        try {
          const context = await readLiveContext(transaction, scope, resolved.session, issuedAt);
          const previous = await readModuleDefinitionDraft(transaction, scope, {
            rootId: request.data.rootId, expectedDraftRevision: request.data.expectedDraftRevision,
          });
          if (!sameId(previous.organizationId, organization.data) ||
              previous.sourceFingerprint !== request.data.expectedSavedSourceFingerprint)
            throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
          const authority = createBuilderAuthority({ transaction, scope, targetFacts: moduleTargetFacts });
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: previous.rootId });
          const selected = fieldValidationContext(previous, request.data.recordAlias, request.data.fieldAlias, context.correlationId);
          const source = structuredClone(previous.source);
          const targetRecords = source.body.record_types.filter((item) => item.id === selected.record.id);
          const targetRecord = targetRecords[0];
          const targetFields = targetRecord?.fields.filter((item) => item.id === selected.field.id);
          const targetField = targetFields?.[0];
          if (targetRecords.length !== 1 || targetRecord === undefined || targetFields?.length !== 1 ||
              targetField === undefined || targetField.type !== "text") return invalidResult();
          targetField.settings.max_length = request.data.maxLength;
          const unchanged = structuredClone(source);
          const unchangedRecord = unchanged.body.record_types.find((item) => item.id === selected.record.id);
          const unchangedField = unchangedRecord?.fields.find((item) => item.id === selected.field.id);
          if (unchangedField === undefined || unchangedField.type !== "text") return invalidResult();
          unchangedField.settings.max_length = selected.field.settings.max_length;
          if (canonicalJson(unchanged) !== canonicalJson(previous.source)) return invalidResult();
          const shape = moduleSourceDocumentSchema.safeParse(source);
          if (!shape.success) throw new LocatedValidationFailure(translateDefinitionSchemaError(shape.error, selected.translation));
          const validation = validateDefinitionSource(shape.data);
          if (!validation.valid) throw new LocatedValidationFailure(translateDefinitionRuleFailures(validation.failures,
            { correlationId: context.correlationId, rootLocation: selected.rootLocation }));
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
          const fields = textFieldDescriptors(reread);
          await assertLiveCompletion(transaction, scope, resolved.session, issuedAt, context, reread);
          return { kind: "available", draft: reread, fields } as const;
        } catch (error) {
          failure = safeFailure(error);
          // Every completion or validation failure escapes runChange and rolls back partial writes.
          throw error;
        }
      });
    return result.kind === "available" ? result.value : failure ?? (result.kind === "unavailable"
      ? { kind: "refused" } : { kind: "temporarily_unavailable" });
  } catch { return { kind: "temporarily_unavailable" }; }
};
