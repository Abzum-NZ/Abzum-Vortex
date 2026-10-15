import "server-only";

import { randomUUID } from "node:crypto";
import {
  describeFailure,
  activityIdSchema,
  applicationRootIdSchema,
  databaseRevision,
  eventOccurrenceIdSchema,
  fieldIdSchema,
  organizationRuntimeSettingsSchema,
  recordTypeDefinitionSchema,
  saveRecordCommandSchema,
  saveRecordResultSchema,
  writableSystemProjectionRegistrations,
  type IdentitySession,
  type ExecutionAuthorityContext,
  type OrganizationSelectionCandidate,
  type RecordSaveFieldCorrection,
  type SaveRecordCommand,
  type SaveRecordResult,
} from "../schema";
import {
  createHumanOrganizationRequestService,
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "../access/index";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import type { BeforeSaveRuleWarning } from "../rules/index";
import {
  beforeSaveRuleRefusedIssueCode,
  beforeSaveRuleUnavailableIssueCode,
  beginBeforeSaveRuleExecution,
  parseBeforeSaveRuleSet,
  type BeforeSaveRuleExecution,
} from "./before-save-rules";
import {
  calculateLockedRelationshipTotalSave,
  type LockedRelationshipTotalPreparation,
  type RelationshipTotalParentMutation,
} from "./relationship-total-save";
import { calculateAndFinalize, operationClock } from "./field-candidate";
export { calculateAndFinalize, operationClock };

type PreparationRow = DatabaseRow & { readonly preparation: unknown };
type SaveRow = DatabaseRow & { readonly result: unknown };

/** @internal Shared only by the fixed named-action save composition. */
export type PreparedSave = Readonly<{
  outcome: "prepared";
  recordType: ReturnType<typeof recordTypeDefinitionSchema.parse>;
  existingValues: Readonly<Record<string, unknown>>;
  readableFieldIds: ReadonlySet<string>;
  correlationId: string;
  /** The exact release's compiled before-save rules as the preparation returned them, unparsed. */
  beforeSaveRules?: unknown;
}>;

type PreparationOutcome =
  | PreparedSave
  | Readonly<{ outcome: "replayed"; result: SaveRecordResult }>
  | Readonly<{ outcome: "refused_recorded" }>
  | Readonly<{ outcome: "conflict"; correlationId?: string }>
  | Readonly<{ outcome: "unavailable"; correlationId?: string }>;

/** @internal Shared only by the fixed named-action save composition. */
export type RelationshipTotalPreparationOutcome =
  | LockedRelationshipTotalPreparation
  | Readonly<{
      outcome: "restart" | "conflict" | "refused" | "refused_recorded" | "defer" | "not_required";
      correlationId?: string;
      /** The database's own reason for a refusal, kept so the refusal can be logged with its cause. */
      reasonCode?: string;
    }>;

type StoredResult =
  | Readonly<{ outcome: "restart" }>
  | Readonly<{
      outcome: "saved";
      recordId: string;
      concurrencyNumber: number | bigint | string;
      values: Readonly<Record<string, unknown>>;
      correlationId: string;
      backgroundDelivery: "none" | "pending";
      replayed: boolean;
    }>
  | Readonly<{
      outcome: "conflict";
      concurrencyNumber?: number | bigint | string;
      reasonCode?: string;
    }>
  | Readonly<{
      outcome: "refused";
      reasonCode?: string;
      fieldId?: string;
    }>
  | Readonly<{
      outcome: "refused_recorded";
      reasonCode?: string;
    }>;

const recordedRefusal = Symbol("recordedRecordSaveRefusal");
const restartRelationshipTotalSave = Symbol("restartRelationshipTotalSave");
const contractError = (code: string, cause: unknown): Error =>
  Object.assign(new Error(code, { cause }), { code });

const writableSystemProjection = (
  recordType: ReturnType<typeof recordTypeDefinitionSchema.parse>,
) => {
  const registration =
    writableSystemProjectionRegistrations[
      recordType.key as keyof typeof writableSystemProjectionRegistrations
    ];
  return registration !== undefined &&
    recordType.systemProjection?.protectedView === registration.protectedView
    ? registration
    : undefined;
};

/** @internal Shared only by the fixed named-action save composition. */
export const revision = (candidate: unknown): number | undefined => {
  const value = databaseRevision(candidate);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("RECORD_SAVE_RESULT_INVALID");
  return rows[0];
};

const parsePreparation = (candidate: unknown): PreparationOutcome => {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
    throw contractError("RECORD_SAVE_PREPARATION_INVALID", candidate);
  const value = candidate as Record<string, unknown>;
  const correlationId = typeof value.correlationId === "string" ? value.correlationId : undefined;
  if (value.outcome === "saved") {
    const replay = saveRecordResultSchema.safeParse({
      contractVersion: "2.0.0",
      outcome: "saved",
      recordId: value.recordId,
      concurrencyNumber: revision(value.concurrencyNumber),
      readableValues: value.values,
      correlationId,
      backgroundDelivery: value.backgroundDelivery,
    });
    if (!replay.success) throw contractError("RECORD_SAVE_REPLAY_INVALID", replay.error);
    return { outcome: "replayed", result: replay.data };
  }
  if (value.outcome === "refused" && value.reasonCode === "command_identity_conflict")
    return { outcome: "conflict", ...(correlationId ? { correlationId } : {}) };
  if (value.outcome === "refused_recorded") return { outcome: "refused_recorded" };
  if (value.outcome === "conflict")
    return { outcome: "conflict", ...(correlationId ? { correlationId } : {}) };
  if (value.outcome === "refused")
    return { outcome: "unavailable", ...(correlationId ? { correlationId } : {}) };
  if (value.outcome !== "prepared")
    throw contractError("RECORD_SAVE_PREPARATION_INVALID", value.outcome);
  const recordType = recordTypeDefinitionSchema.safeParse(value.recordType);
  // A system projection has no ordinary write path. Only an exact entry in the closed protected
  // writer registration can reach its matching protected SQL writer.
  if (!recordType.success) throw contractError("RECORD_SAVE_RECORD_TYPE_INVALID", recordType.error);
  if (
    (recordType.data.systemProjection !== undefined &&
      writableSystemProjection(recordType.data) === undefined) ||
    typeof value.existingValues !== "object" ||
    value.existingValues === null ||
    Array.isArray(value.existingValues)
  )
    throw contractError("RECORD_SAVE_PREPARATION_INVALID", "record type or values");
  if (correlationId === undefined)
    throw contractError("RECORD_SAVE_PREPARATION_INVALID", "missing correlationId");
  if (!Array.isArray(value.readableFieldIds))
    throw contractError("RECORD_SAVE_PREPARATION_INVALID", "missing readableFieldIds");
  const readableFieldIds = value.readableFieldIds.map((fieldId) =>
    fieldIdSchema.safeParse(fieldId),
  );
  if (readableFieldIds.some((fieldId) => !fieldId.success))
    throw contractError("RECORD_SAVE_PREPARATION_INVALID", "invalid readableFieldIds");
  let existingValues = value.existingValues as Readonly<Record<string, unknown>>;
  if (recordType.data.systemProjection === undefined) {
    // Unset optional SQL columns are absent from the ordinary field candidate.
    const ordinaryValues = { ...existingValues };
    for (const field of recordType.data.fields) {
      if (
        !field.required &&
        field.type !== "reference_number" &&
        field.type !== "calculation" &&
        field.type !== "total" &&
        ordinaryValues[field.fieldId] === null
      )
        delete ordinaryValues[field.fieldId];
    }
    existingValues = ordinaryValues;
  }
  return {
    outcome: "prepared",
    recordType: recordType.data,
    existingValues,
    readableFieldIds: new Set(
      readableFieldIds.flatMap((fieldId) => (fieldId.success ? [fieldId.data] : [])),
    ),
    correlationId,
    ...(value.beforeSaveRules === undefined ? {} : { beforeSaveRules: value.beforeSaveRules }),
  };
};

const correctionCode = (code: string): RecordSaveFieldCorrection["code"] => {
  if (code.startsWith("required_")) return "required_value";
  if (
    code === "unknown_field" ||
    code === "generated_field_input" ||
    code === beforeSaveRuleRefusedIssueCode
  )
    return "field_refused";
  return "invalid_value";
};

const correctionsFor = (
  issues: readonly Readonly<{
    code: string;
    fieldId?: string;
    path: readonly (string | number)[];
    requirement?: Readonly<{ code: string; message: string }>;
  }>[],
  readableFieldIds: ReadonlySet<string>,
  operation: "create" | "update",
): readonly RecordSaveFieldCorrection[] | undefined => {
  const corrections = new Map<string, RecordSaveFieldCorrection>();
  for (const issue of issues) {
    if (issue.fieldId === undefined) return undefined;
    const code = correctionCode(issue.code);
    // A create has no readable bounds before the row exists, and the caller is shown the whole
    // form, so naming a required field whose value is missing discloses nothing new.
    const visible =
      readableFieldIds.has(issue.fieldId) || (code === "required_value" && operation === "create");
    if (!visible) return undefined;
    // The nested path is whatever follows the field id, wherever the issue's path root puts it.
    const fieldPosition = issue.path.indexOf(issue.fieldId);
    const nested = fieldPosition < 0 ? [] : issue.path.slice(fieldPosition + 1);
    const correction: RecordSaveFieldCorrection = {
      code,
      fieldId: issue.fieldId as RecordSaveFieldCorrection["fieldId"],
      ...(nested.length === 0
        ? {}
        : { nestedPath: nested as RecordSaveFieldCorrection["nestedPath"] }),
      // A rule's authored message is the one text that leaves with a located correction.
      ...(issue.code === beforeSaveRuleRefusedIssueCode && issue.requirement !== undefined
        ? { message: issue.requirement.message }
        : {}),
    };
    corrections.set(
      `${correction.fieldId}:${correction.code}:${JSON.stringify(nested)}`,
      correction,
    );
  }
  return [...corrections.values()];
};

/** The field and option labels are the only text a permission-gated choice refusal shows. */
const choicePermissionRefusalMessage = (
  recordType: Readonly<{
    fields: readonly Readonly<{
      fieldId: string;
      label: string;
      settings?: unknown;
    }>[];
  }>,
  check: Readonly<{ fieldId: string; optionValue: string }>,
): string | undefined => {
  const field = recordType.fields.find((candidate) => candidate.fieldId === check.fieldId);
  const options =
    typeof field?.settings === "object" &&
    field.settings !== null &&
    "options" in field.settings &&
    Array.isArray(field.settings.options)
      ? (field.settings.options as readonly unknown[])
      : [];
  const option = options.find(
    (candidate): candidate is { value: string; label: string } =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { value?: unknown }).value === check.optionValue &&
      typeof (candidate as { label?: unknown }).label === "string",
  );
  const fieldLabel = field?.label.trim() ?? "";
  const optionLabel = option?.label.trim() ?? "";
  if (fieldLabel === "" || optionLabel === "") return undefined;
  return `${fieldLabel} can't be set to ${optionLabel} here. Use the action provided for it.`;
};

const safeRefusal = (
  correlationId: string,
  code: "invalid_request" | "operation_refused" | "conflict",
  ruleReason?: Readonly<{ code: string; message: string }>,
): SaveRecordResult =>
  saveRecordResultSchema.parse({
    contractVersion: "2.0.0",
    outcome: "refused",
    error: {
      code,
      messageKey: `errors.${code}`,
      correlationId,
      ...(ruleReason === undefined ? {} : { reason: ruleReason }),
    },
  });

const prepare = async (
  transaction: RequestDatabaseTransaction,
  command: SaveRecordCommand,
  activityId: string,
): Promise<PreparationOutcome> => {
  await transaction.query`set local role vortex_runtime`;
  const rows = await transaction.query<PreparationRow>`
    select vortex_record.prepare_base_record_save(
      ${command.commandId}::uuid,
      ${command.operation}::text,
      ${command.recordTypeId}::uuid,
      ${command.operation === "update" ? command.recordId : null}::uuid,
      ${command.operation === "update" ? command.expectedConcurrencyNumber : null}::bigint,
      ${JSON.stringify(command.submittedValues)}::text::jsonb,
      ${command.operation === "create" ? (command.selectedOwnerGroupId ?? null) : null}::uuid,
      ${activityId}::uuid
    ) as preparation
  `;
  return parsePreparation(one(rows).preparation);
};

/** @internal Shared only by the fixed named-action save composition. */
export const parseRelationshipTotalPreparation = (
  candidate: unknown,
): RelationshipTotalPreparationOutcome => {
  if (typeof candidate !== "object" || candidate === null) return { outcome: "refused" };
  const value = candidate as Record<string, unknown>;
  if (
    ["restart", "conflict", "refused", "refused_recorded", "defer", "not_required"].includes(
      String(value.outcome),
    )
  )
    return {
      outcome: value.outcome as
        "restart" | "conflict" | "refused" | "refused_recorded" | "defer" | "not_required",
      ...(typeof value.correlationId === "string" ? { correlationId: value.correlationId } : {}),
      ...(typeof value.reasonCode === "string" ? { reasonCode: value.reasonCode } : {}),
    };
  if (
    value.outcome !== "prepared" ||
    typeof value.correlationId !== "string" ||
    !Array.isArray(value.readableFieldIds) ||
    value.readableFieldIds.some((fieldId) => !fieldIdSchema.safeParse(fieldId).success) ||
    !Array.isArray(value.records)
  )
    return { outcome: "refused" };
  const records = [];
  for (const candidateRecord of value.records) {
    if (typeof candidateRecord !== "object" || candidateRecord === null)
      return { outcome: "refused" };
    const record = candidateRecord as Record<string, unknown>;
    const recordType = recordTypeDefinitionSchema.safeParse(record.recordType);
    const concurrencyNumber =
      record.concurrencyNumber === undefined ? undefined : revision(record.concurrencyNumber);
    if (
      !recordType.success ||
      typeof record.recordKey !== "string" ||
      typeof record.existingValues !== "object" ||
      record.existingValues === null ||
      Array.isArray(record.existingValues) ||
      !Array.isArray(record.relationshipSources) ||
      (record.recordId !== undefined && typeof record.recordId !== "string") ||
      (record.recordId !== undefined && concurrencyNumber === undefined)
    )
      return { outcome: "refused" };
    const relationshipSources = [];
    for (const candidateSource of record.relationshipSources) {
      if (typeof candidateSource !== "object" || candidateSource === null)
        return { outcome: "refused" };
      const source = candidateSource as Record<string, unknown>;
      const sourceRecordType = recordTypeDefinitionSchema.safeParse(source.sourceRecordType);
      if (
        !sourceRecordType.success ||
        typeof source.relationshipId !== "string" ||
        !Array.isArray(source.records)
      )
        return { outcome: "refused" };
      const relatedRecords = [];
      for (const candidateRelated of source.records) {
        if (typeof candidateRelated !== "object" || candidateRelated === null)
          return { outcome: "refused" };
        const related = candidateRelated as Record<string, unknown>;
        if (
          typeof related.fieldValues !== "object" ||
          related.fieldValues === null ||
          Array.isArray(related.fieldValues) ||
          (related.recordKey !== undefined && typeof related.recordKey !== "string")
        )
          return { outcome: "refused" };
        relatedRecords.push({
          ...(related.recordKey === undefined ? {} : { recordKey: related.recordKey }),
          fieldValues: related.fieldValues as Readonly<Record<string, unknown>>,
        });
      }
      relationshipSources.push({
        relationshipId: source.relationshipId,
        sourceRecordType: sourceRecordType.data,
        records: relatedRecords,
      });
    }
    records.push({
      recordKey: record.recordKey,
      ...(record.recordId === undefined ? {} : { recordId: record.recordId }),
      recordType: recordType.data,
      ...(concurrencyNumber === undefined ? {} : { concurrencyNumber }),
      existingValues: record.existingValues as Readonly<Record<string, unknown>>,
      ...(record.beforeSaveRules === undefined ? {} : { beforeSaveRules: record.beforeSaveRules }),
      relationshipSources,
    });
  }
  return records.filter((record) => record.recordKey === "root").length === 1
    ? {
        outcome: "prepared",
        correlationId: value.correlationId,
        readableFieldIds: value.readableFieldIds as string[],
        records,
      }
    : { outcome: "refused" };
};

const prepareRelationshipTotals = async (
  transaction: RequestDatabaseTransaction,
  command: SaveRecordCommand,
  activityId: string,
): Promise<RelationshipTotalPreparationOutcome> => {
  await transaction.query`set local role vortex_runtime`;
  const rows = await transaction.query<PreparationRow>`
    select vortex_record.prepare_relationship_total_save(
      ${command.commandId}::uuid,
      ${command.operation}::text,
      ${command.recordTypeId}::uuid,
      ${command.operation === "update" ? command.recordId : null}::uuid,
      ${command.operation === "update" ? command.expectedConcurrencyNumber : null}::bigint,
      ${JSON.stringify(command.submittedValues)}::text::jsonb,
      ${command.operation === "create" ? (command.selectedOwnerGroupId ?? null) : null}::uuid,
      ${activityId}::uuid
    ) as preparation
  `;
  return parseRelationshipTotalPreparation(one(rows).preparation);
};

const persist = async (
  transaction: RequestDatabaseTransaction,
  command: SaveRecordCommand,
  recordType: ReturnType<typeof recordTypeDefinitionSchema.parse>,
  finalValues: Readonly<Record<string, unknown>>,
  activityId: string,
  occurrenceId: string,
  parentMutations: readonly RelationshipTotalParentMutation[] = [],
): Promise<StoredResult> => {
  if (recordType.systemProjection !== undefined) {
    if (command.previewInstallationId !== undefined)
      return { outcome: "refused", reasonCode: "field_refused" };
    const registration = writableSystemProjection(recordType);
    if (
      command.operation !== "update" ||
      registration === undefined ||
      command.recordId === undefined ||
      command.expectedConcurrencyNumber === undefined
    )
      return { outcome: "refused", reasonCode: "field_refused" };
    const rows = await transaction.query<SaveRow>`
      select vortex_record.apply_settings_record_changes(
        ${command.commandId}::uuid,
        ${command.recordTypeId}::uuid,
        ${command.recordId}::uuid,
        ${command.expectedConcurrencyNumber}::bigint,
        ${JSON.stringify(command.submittedValues)}::text::jsonb,
        ${JSON.stringify(finalValues)}::text::jsonb,
        ${activityId}::uuid,
        ${occurrenceId}::uuid
      ) as result
    `;
    const candidate = one(rows).result;
    if (typeof candidate !== "object" || candidate === null)
      throw new Error("RECORD_SAVE_RESULT_INVALID");
    return candidate as StoredResult;
  }

  const rows = await transaction.query<SaveRow>`
      select vortex_record.save_base_record_with_relationship_totals(
        ${command.commandId}::uuid,
        ${command.operation}::text,
        ${command.recordTypeId}::uuid,
        ${command.operation === "update" ? command.recordId : null}::uuid,
        ${command.operation === "update" ? command.expectedConcurrencyNumber : null}::bigint,
        ${JSON.stringify(command.submittedValues)}::text::jsonb,
        ${JSON.stringify(finalValues)}::text::jsonb,
        ${command.operation === "create" ? (command.selectedOwnerGroupId ?? null) : null}::uuid,
        ${activityId}::uuid,
        ${occurrenceId}::uuid,
        ${JSON.stringify(parentMutations)}::text::jsonb
      ) as result
  `;
  const candidate = one(rows).result;
  if (typeof candidate !== "object" || candidate === null)
    throw new Error("RECORD_SAVE_RESULT_INVALID");
  return candidate as StoredResult;
};

const settingsFieldId = (
  recordType: ReturnType<typeof recordTypeDefinitionSchema.parse>,
  key: string,
): string | undefined => recordType.fields.find((field) => field.key === key)?.fieldId;

const invalidSettingsCorrections = (
  prepared: PreparedSave,
  command: SaveRecordCommand,
  finalValues: Readonly<Record<string, unknown>>,
): readonly RecordSaveFieldCorrection[] | undefined => {
  if (
    command.operation !== "update" ||
    command.expectedConcurrencyNumber === undefined ||
    writableSystemProjection(prepared.recordType) === undefined
  )
    return undefined;

  const values = { ...prepared.existingValues, ...finalValues };
  const valueFor = (key: string): unknown => {
    const fieldId = settingsFieldId(prepared.recordType, key);
    return fieldId === undefined ? undefined : values[fieldId];
  };
  const currentRevision = revision(valueFor("revision"));
  if (currentRevision !== command.expectedConcurrencyNumber) return undefined;

  const settings = organizationRuntimeSettingsSchema.safeParse({
    organizationId: valueFor("organization_id"),
    language: valueFor("language"),
    timeZone: valueFor("time_zone"),
    currency: valueFor("currency"),
    dateFormat: valueFor("date_format"),
    numberFormat: valueFor("number_format"),
    revision: currentRevision,
  });
  const corrections = new Map<string, RecordSaveFieldCorrection>();
  if (!settings.success) {
    const fieldBySchemaKey: Readonly<Record<string, string>> = {
      language: "language",
      timeZone: "time_zone",
      currency: "currency",
      dateFormat: "date_format",
      numberFormat: "number_format",
    };
    for (const issue of settings.error.issues) {
      const schemaKey = issue.path[0];
      const recordFieldKey =
        typeof schemaKey === "string" ? fieldBySchemaKey[schemaKey] : undefined;
      const fieldId =
        recordFieldKey === undefined
          ? undefined
          : settingsFieldId(prepared.recordType, recordFieldKey);
      if (fieldId === undefined || !prepared.readableFieldIds.has(fieldId)) return undefined;
      corrections.set(fieldId, {
        code: "invalid_value",
        fieldId: fieldId as RecordSaveFieldCorrection["fieldId"],
      });
    }
  }

  const defaultApplication = applicationRootIdSchema
    .nullable()
    .safeParse(valueFor("default_application_root_id"));
  if (!defaultApplication.success) {
    const fieldId = settingsFieldId(prepared.recordType, "default_application_root_id");
    if (fieldId === undefined || !prepared.readableFieldIds.has(fieldId)) return undefined;
    corrections.set(fieldId, {
      code: "invalid_value",
      fieldId: fieldId as RecordSaveFieldCorrection["fieldId"],
    });
  }
  return [...corrections.values()];
};

/**
 * The Record service owns the privileged prepare/persist boundary, while
 * Access owns the request-scoped settings read. Keep that read between those
 * two phases: a replay or refusal never observes settings, and persistence
 * always resumes with the runtime role.
 */
/** @internal Shared only by the fixed named-action save composition. */
export const readOrganizationRuntimeSettings = async (transaction: RequestDatabaseTransaction) => {
  await transaction.query`set local role vortex_request`;
  try {
    return await readCurrentOrganizationRuntimeSettingsAfterAuthorization(transaction);
  } finally {
    await transaction.query`set local role vortex_runtime`;
  }
};

/**
 * The save result plus any before-save rule warnings of a saved attempt. The
 * closed result contract has no warning field, so they travel beside it.
 */
export type RecordSaveServiceResult = HumanOrganizationRequestResult<SaveRecordResult> &
  Readonly<{ warnings?: readonly BeforeSaveRuleWarning[] }>;

export type RecordSaveServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    activityId?: () => string;
    occurrenceId?: () => string;
  }>;

/**
 * The ordinary-human base save. Every caller supplies the same closed command;
 * all scope, actor, installation and generated facts come from the server.
 */
export const createRecordSaveService = (dependencies: RecordSaveServiceDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newActivityId = dependencies.activityId ?? randomUUID;
  const newOccurrenceId = dependencies.occurrenceId ?? randomUUID;

  return Object.freeze({
    async save(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<RecordSaveServiceResult> {
      // Do not turn a non-person authority into a person session on this adapter.
      if (caller !== null && typeof caller === "object" && "kind" in caller) {
        console.error("[record] save refused RECORD_SAVE_CALLER_NOT_A_PERSON");
        return { kind: "unavailable" };
      }
      const command = saveRecordCommandSchema.safeParse(commandCandidate);
      if (!command.success || selection.applicationRootId === undefined) {
        console.error(
          `[record] save refused RECORD_SAVE_COMMAND_INVALID: ${command.success ? "no application selected" : describeFailure(command.error)}`,
        );
        return { kind: "unavailable" };
      }

      let activityId: string;
      let occurrenceId: string | undefined;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        console.error(`[record] save identity generation failed: ${describeFailure(error)}`);
        return { kind: "temporarily_unavailable" };
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const attempted: {
          rules?: BeforeSaveRuleExecution;
          closureRules?: BeforeSaveRuleExecution[];
        } = {};
        const result = await requests.runChange(
          caller,
          selection,
          async (transaction, _scope, issuedAt) => {
            await transaction.query`
              select pg_catalog.set_config(
                'vortex_record.preview_installation_id',
                ${command.data.previewInstallationId ?? ""},
                true
              )
            `;
            const totalPreparation =
              command.data.previewInstallationId === undefined
                ? await prepareRelationshipTotals(transaction, command.data, activityId)
                : { outcome: "not_required" as const };
            if (totalPreparation.outcome === "restart") return restartRelationshipTotalSave;
            if (totalPreparation.outcome === "refused_recorded") return recordedRefusal;
            if (totalPreparation.outcome === "conflict")
              return totalPreparation.correlationId === undefined
                ? recordedRefusal
                : safeRefusal(totalPreparation.correlationId, "conflict");
            if (totalPreparation.outcome === "refused")
              return totalPreparation.correlationId === undefined
                ? recordedRefusal
                : safeRefusal(totalPreparation.correlationId, "operation_refused");
            const prepared: PreparationOutcome =
              totalPreparation.outcome === "prepared"
                ? {
                    outcome: "prepared",
                    recordType: totalPreparation.records.find(
                      (record) => record.recordKey === "root",
                    )!.recordType,
                    existingValues: totalPreparation.records.find(
                      (record) => record.recordKey === "root",
                    )!.existingValues,
                    readableFieldIds: new Set(totalPreparation.readableFieldIds),
                    correlationId: totalPreparation.correlationId,
                  }
                : await prepare(transaction, command.data, activityId);
            if (prepared.outcome === "replayed") return prepared.result;
            if (prepared.outcome === "refused_recorded") return recordedRefusal;
            if (prepared.outcome === "conflict")
              return prepared.correlationId === undefined
                ? recordedRefusal
                : safeRefusal(prepared.correlationId, "conflict");
            if (prepared.outcome === "unavailable")
              return prepared.correlationId === undefined
                ? recordedRefusal
                : safeRefusal(prepared.correlationId, "operation_refused");

            let closureRules: Map<string, BeforeSaveRuleExecution> | undefined;
            if (totalPreparation.outcome === "prepared") {
              closureRules = new Map();
              for (const record of totalPreparation.records) {
                const ruleSet = parseBeforeSaveRuleSet(
                  record.beforeSaveRules,
                  record.recordType.recordTypeId,
                );
                if (ruleSet === undefined) {
                  console.error(
                    `[record] save refused BEFORE_SAVE_RULE_SET_UNAVAILABLE: ${record.recordKey}`,
                  );
                  return safeRefusal(prepared.correlationId, "operation_refused");
                }
                const execution = beginBeforeSaveRuleExecution(ruleSet);
                closureRules.set(record.recordKey, execution);
              }
              attempted.closureRules = [...closureRules.values()];
            } else {
              const ruleSet = parseBeforeSaveRuleSet(
                prepared.beforeSaveRules,
                prepared.recordType.recordTypeId,
              );
              if (ruleSet === undefined) {
                console.error("[record] save refused BEFORE_SAVE_RULE_SET_UNAVAILABLE");
                return safeRefusal(prepared.correlationId, "operation_refused");
              }
              attempted.rules = beginBeforeSaveRuleExecution(ruleSet);
            }

            const settings = await readOrganizationRuntimeSettings(transaction);
            const totalClock =
              totalPreparation.outcome === "prepared"
                ? operationClock(
                    totalPreparation.records.map((record) => record.recordType),
                    issuedAt,
                    settings?.timeZone,
                  )
                : undefined;
            const values =
              totalPreparation.outcome === "prepared" && totalClock !== undefined
                ? calculateLockedRelationshipTotalSave({
                    command: command.data,
                    preparation: totalPreparation,
                    ...(settings?.currency === undefined
                      ? {}
                      : { organizationCurrency: settings.currency }),
                    clock: totalClock,
                    rules: closureRules!,
                  })
                : totalPreparation.outcome === "prepared"
                  ? {
                      success: false as const,
                      issues: [{ code: "invalid_input", recordKey: "root", path: ["clock"] }],
                    }
                  : calculateAndFinalize({
                      operation: command.data.operation,
                      submittedValues: command.data.submittedValues,
                      recordType: prepared.recordType,
                      existingValues: prepared.existingValues,
                      issuedAt,
                      organizationCurrency: settings?.currency,
                      timeZone: settings?.timeZone,
                      rules: attempted.rules,
                    });
            if (!values.success) {
              console.error(
                `[record] save refused RECORD_SAVE_VALUES_INVALID: ${values.issues.map((issue) => ("requirement" in issue && issue.requirement ? `${issue.code}:${issue.requirement.code}` : issue.code)).join(",")}`,
              );
              if (
                values.issues.some(
                  (issue) =>
                    issue.code === "organization_currency_required" ||
                    issue.code === beforeSaveRuleUnavailableIssueCode,
                )
              )
                return safeRefusal(prepared.correlationId, "operation_refused");
              const corrections = correctionsFor(
                values.issues
                  .filter((issue) => !("recordKey" in issue) || issue.recordKey === "root")
                  .map((issue) => ({
                    code: issue.code,
                    ...(issue.fieldId === undefined ? {} : { fieldId: issue.fieldId }),
                    path: issue.path,
                    ...("requirement" in issue && issue.requirement !== undefined
                      ? { requirement: issue.requirement }
                      : {}),
                  })),
                prepared.readableFieldIds,
                command.data.operation,
              );
              if (corrections === undefined || corrections.length === 0) {
                // A rule's authored refusal is the one reason safe to show; every other cause stays in the log.
                return safeRefusal(
                  prepared.correlationId,
                  "operation_refused",
                  values.issues.flatMap((issue) =>
                    issue.code === beforeSaveRuleRefusedIssueCode &&
                    "requirement" in issue &&
                    issue.requirement !== undefined
                      ? [issue.requirement]
                      : [],
                  )[0],
                );
              }
              return saveRecordResultSchema.parse({
                contractVersion: "2.0.0",
                outcome: "correction_required",
                correlationId: prepared.correlationId,
                corrections,
              });
            }

            const unsupportedChecks = values.pendingChecks.filter(
              (check) =>
                check.kind !== "record_reference" &&
                check.kind !== "person_reference" &&
                !(
                  command.data.previewInstallationId !== undefined &&
                  check.kind === "choice_permission"
                ),
            );
            if (unsupportedChecks.length > 0) {
              if (unsupportedChecks.some((check) => !prepared.readableFieldIds.has(check.fieldId)))
                return safeRefusal(prepared.correlationId, "operation_refused");
              const corrections = unsupportedChecks.map((check) => {
                const message =
                  check.kind === "choice_permission"
                    ? choicePermissionRefusalMessage(prepared.recordType, check)
                    : undefined;
                if (check.kind === "choice_permission" && message === undefined)
                  console.error(
                    "[record] save refused RECORD_SAVE_CHOICE_LABEL_MISSING: no field or option label for a permission-gated choice",
                  );
                return {
                  code: "field_refused" as const,
                  fieldId: check.fieldId,
                  ...(message === undefined ? {} : { message }),
                };
              });
              return saveRecordResultSchema.parse({
                contractVersion: "2.0.0",
                outcome: "correction_required",
                correlationId: prepared.correlationId,
                corrections,
              });
            }

            const finalValues: Record<string, unknown> =
              "sourceFinalValues" in values
                ? { ...values.sourceFinalValues }
                : { ...values.setValues };
            if ("clearFieldIds" in values)
              for (const fieldId of values.clearFieldIds) finalValues[fieldId] = null;
            if (prepared.recordType.systemProjection !== undefined) {
              // The shipped text input submits an empty string for an unset optional default.
              // Store that as the nullable application reference the settings writer accepts.
              const defaultApplicationFieldId = settingsFieldId(
                prepared.recordType,
                "default_application_root_id",
              );
              if (
                defaultApplicationFieldId !== undefined &&
                finalValues[defaultApplicationFieldId] === ""
              )
                finalValues[defaultApplicationFieldId] = null;
              const corrections = invalidSettingsCorrections(prepared, command.data, finalValues);
              if (corrections === undefined)
                return safeRefusal(prepared.correlationId, "operation_refused");
              if (corrections.length > 0)
                return saveRecordResultSchema.parse({
                  contractVersion: "2.0.0",
                  outcome: "correction_required",
                  correlationId: prepared.correlationId,
                  corrections,
                });
            }
            occurrenceId ??= eventOccurrenceIdSchema.parse(newOccurrenceId());
            const stored = await persist(
              transaction,
              command.data,
              prepared.recordType,
              finalValues,
              activityId,
              occurrenceId,
              "parentMutations" in values ? values.parentMutations : [],
            );
            if (stored.outcome === "restart") return restartRelationshipTotalSave;
            if (stored.outcome === "refused_recorded") return recordedRefusal;
            if (stored.outcome === "conflict") {
              console.error(
                `[record] protected save persistence conflicted (${stored.reasonCode})`,
              );
              return safeRefusal(prepared.correlationId, "conflict");
            }
            if (stored.outcome === "refused")
              console.error(
                "[record] protected save persistence refused",
                contractError(stored.reasonCode ?? "RECORD_SAVE_REFUSED", stored.reasonCode),
              );
            if (
              stored.outcome === "refused" &&
              stored.reasonCode === "person_reference_unavailable"
            ) {
              const fieldId = fieldIdSchema.safeParse(stored.fieldId);
              if (!fieldId.success) throw contractError("RECORD_SAVE_FIELD_ID_INVALID", stored);
              if (!prepared.readableFieldIds.has(fieldId.data))
                return safeRefusal(prepared.correlationId, "operation_refused");
              return saveRecordResultSchema.parse({
                contractVersion: "2.0.0",
                outcome: "correction_required",
                correlationId: prepared.correlationId,
                corrections: [{ code: "invalid_value", fieldId: fieldId.data }],
              });
            }
            if (stored.outcome === "refused")
              return safeRefusal(
                prepared.correlationId,
                stored.reasonCode === "command_invalid" ? "invalid_request" : "operation_refused",
              );
            const concurrencyNumber = revision(stored.concurrencyNumber);
            if (concurrencyNumber === undefined) throw new Error("RECORD_SAVE_RESULT_INVALID");
            return saveRecordResultSchema.parse({
              contractVersion: "2.0.0",
              outcome: "saved",
              recordId: stored.recordId,
              concurrencyNumber,
              readableValues: stored.values,
              correlationId: stored.correlationId,
              backgroundDelivery: stored.backgroundDelivery,
            });
          },
        );

        if (result.kind !== "available") return result;
        if (result.value === restartRelationshipTotalSave) continue;
        if (result.value === recordedRefusal) {
          console.error("[record] save refused RECORD_SAVE_REFUSAL_RECORDED");
          return { kind: "unavailable" };
        }
        const value = result.value as SaveRecordResult;
        const warnings = [
          ...(attempted.rules?.warnings ?? []),
          ...(attempted.closureRules?.flatMap((execution) => execution.warnings) ?? []),
        ];
        return value.outcome === "saved" && warnings.length > 0
          ? { kind: "available", value, warnings }
          : { kind: "available", value };
      }
      return { kind: "temporarily_unavailable" };
    },
  });
};
