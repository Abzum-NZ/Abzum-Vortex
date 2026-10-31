import "server-only";

import type {
  HumanOrganizationRequestDependencies,
  HumanOrganizationRequestResult,
} from "../access/human-organization-request";
import { readCurrentOrganizationRuntimeSettingsAfterAuthorization } from "../access/organization-runtime-settings-administration";
import { organizationRuntimeSettingsSchema } from "../access/organization-runtime-settings-schema";
import { applicationRootIdSchema, fieldIdSchema } from "../catalogue/identifiers";
import { databaseRevision, describeFailure, sameId } from "../catalogue/runtime-primitives";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import {
  isWritableSystemProjection,
  recordTypeDefinitionSchema,
} from "../definition/module-contracts";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";
import {
  beforeSaveRuleRefusedIssueCode,
  beforeSaveRuleUnavailableIssueCode,
} from "./before-save-rules";
import { decideChoiceOptionPermission } from "./choice-option-permission";
import type { calculateAndFinalize } from "./field-candidate";
import { storedRecordCandidateValues, type RecordFieldValuePendingCheck } from "./field-values";
import { firstFieldDependencyRefusal } from "./link-dependencies";
import { firstOptionSourceRefusal, type OptionMembershipCheck } from "./option-membership";
import {
  saveRecordResultSchema,
  type RecordSaveFieldCorrection,
  type SaveRecordCommand,
  type SaveRecordResult,
} from "./records";
import type { calculateLockedRelationshipTotalSave } from "./relationship-total-save";
import type { LockedRelationshipTotalPreparation } from "./relationship-total-save";
import {
  parentCycleRefusal,
  uniqueValueRefusal,
  violatedParentFieldId,
  violatedUniqueFieldId,
} from "./unique-violation";

/** @internal Shared only by the fixed named-action save composition. */
export type PreparedSave = Readonly<{
  outcome: "prepared";
  recordType: ReturnType<typeof recordTypeDefinitionSchema.parse>;
  existingValues: Readonly<Record<string, unknown>>;
  readableFieldIds: ReadonlySet<string>;
  correlationId: string;
  /** The exact release's compiled before-save rules as the preparation returned them, unparsed. */
  beforeSaveFlows?: unknown;
}>;

export type PreparationOutcome =
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

export const contractError = (code: string, cause: unknown): Error =>
  Object.assign(new Error(code, { cause }), { code });

const writableSystemProjection = (
  recordType: ReturnType<typeof recordTypeDefinitionSchema.parse>,
): boolean =>
  recordType.systemProjection !== undefined &&
  isWritableSystemProjection(recordType.systemProjection.protectedView);

/** @internal Shared only by the fixed named-action save composition. */
export const revision = (candidate: unknown): number | undefined => {
  const value = databaseRevision(candidate);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

export const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("RECORD_SAVE_RESULT_INVALID");
  return rows[0];
};

export const parsePreparation = (candidate: unknown): PreparationOutcome => {
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
  if (value.outcome === "unsupported") {
    // An Application-owned rule names this record type; only a Module's own rules run on a save.
    console.error(
      "[record] save refused RECORD_SAVE_UNSUPPORTED: an Application rule names the record type",
    );
    return { outcome: "unavailable", ...(correlationId ? { correlationId } : {}) };
  }
  if (value.outcome !== "prepared")
    throw contractError("RECORD_SAVE_PREPARATION_INVALID", value.outcome);
  const recordType = recordTypeDefinitionSchema.safeParse(value.recordType);
  // A system projection has no ordinary write path. Only a protected read model the platform
  // writes can reach its protected SQL writer.
  if (!recordType.success) throw contractError("RECORD_SAVE_RECORD_TYPE_INVALID", recordType.error);
  if (
    (recordType.data.systemProjection !== undefined &&
      !writableSystemProjection(recordType.data)) ||
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
  // An unset optional value is absent from the field candidate, whether it is an ordinary SQL
  // column or a value a system projection (organisation settings) has not stored yet.
  const existingValues = storedRecordCandidateValues(
    recordType.data,
    value.existingValues as Readonly<Record<string, unknown>>,
  );
  return {
    outcome: "prepared",
    recordType: recordType.data,
    existingValues,
    readableFieldIds: new Set(
      readableFieldIds.flatMap((fieldId) => (fieldId.success ? [fieldId.data] : [])),
    ),
    correlationId,
    ...(value.beforeSaveFlows === undefined ? {} : { beforeSaveFlows: value.beforeSaveFlows }),
  };
};

const correctionCode = (code: string): RecordSaveFieldCorrection["code"] => {
  if (code.startsWith("required_")) return "required_value";
  if (
    code === "unknown_field" ||
    code === "generated_field_input" ||
    code === "stage_move_refused" ||
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
  submittedFieldIds: ReadonlySet<string>,
): readonly RecordSaveFieldCorrection[] | undefined => {
  const corrections = new Map<string, RecordSaveFieldCorrection>();
  for (const issue of issues) {
    if (issue.fieldId === undefined) return undefined;
    const code = correctionCode(issue.code);
    // A create has no readable bounds before the row exists, and the caller is shown the whole
    // form, so naming a required field whose value is missing, or a value the person submitted,
    // discloses nothing new. A BeforeSave rule's issue carries the path ["rules"], so a rule that
    // refuses a field the person filled in is told apart by the field id.
    const visible =
      readableFieldIds.has(issue.fieldId) ||
      (operation === "create" &&
        (code === "required_value" ||
          issue.path[0] === "submittedValues" ||
          (issue.code === beforeSaveRuleRefusedIssueCode && submittedFieldIds.has(issue.fieldId))));
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
      // A rule's authored message, and a refused stage move's labels, are the only text that
      // leaves with a located correction.
      ...((issue.code === beforeSaveRuleRefusedIssueCode ||
        issue.code === "required_field_missing" ||
        issue.code === "stage_move_refused" ||
        issue.code === "invalid_value") &&
      issue.requirement !== undefined
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

export const safeRefusal = (
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

/** @internal Shared only by the fixed named-action save composition. */
export const parseRelationshipTotalPreparation = (
  candidate: unknown,
  requiredRecordKeys: readonly string[] = ["root"],
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
      typeof record.canRead !== "boolean" ||
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
      canRead: record.canRead as boolean,
      ...(concurrencyNumber === undefined ? {} : { concurrencyNumber }),
      existingValues: storedRecordCandidateValues(
        recordType.data,
        record.existingValues as Readonly<Record<string, unknown>>,
      ),
      ...(record.beforeSaveFlows === undefined ? {} : { beforeSaveFlows: record.beforeSaveFlows }),
      relationshipSources,
    });
  }
  const keys = new Set(records.map((record) => record.recordKey));
  return keys.size === records.length &&
    requiredRecordKeys.length > 0 &&
    requiredRecordKeys.every((key) => keys.has(key))
    ? {
        outcome: "prepared",
        correlationId: value.correlationId,
        readableFieldIds: value.readableFieldIds as string[],
        records,
      }
    : { outcome: "refused" };
};

/**
 * A write that another record's unique value defeated, or that would make a record its own
 * ancestor through its link to its own record type, becomes a correction located on that field,
 * worded from the definition's labels. The database holds both rules, so each check is exact under
 * concurrent writes; the failed statement rolled the whole save back, so nothing was written. A
 * field the caller neither reads nor submitted is never named.
 */
export const constraintCorrection = (
  error: unknown,
  prepared: PreparedSave | undefined,
  command: SaveRecordCommand,
): SaveRecordResult | undefined => {
  const uniqueFieldId = violatedUniqueFieldId(error);
  const parentFieldId = violatedParentFieldId(error);
  const fieldId = uniqueFieldId ?? parentFieldId;
  if (fieldId === undefined || prepared === undefined) return undefined;
  const correction =
    uniqueFieldId === undefined
      ? parentCycleRefusal(prepared.recordType, fieldId)
      : uniqueValueRefusal(prepared.recordType, fieldId);
  if (correction === undefined) return undefined;
  console.error(
    `[record] save refused ${uniqueFieldId === undefined ? "RECORD_SAVE_PARENT_CYCLE" : "RECORD_SAVE_VALUE_NOT_UNIQUE"}: field=${correction.fieldId} ${describeFailure(error)}`,
  );
  const named =
    prepared.readableFieldIds.has(correction.fieldId) ||
    Object.keys(command.submittedValues).some(
      (submitted) => submitted.toLowerCase() === correction.fieldId.toLowerCase(),
    );
  if (!named) return safeRefusal(prepared.correlationId, "operation_refused");
  return saveRecordResultSchema.parse({
    contractVersion: "2.0.0",
    outcome: "correction_required",
    correlationId: prepared.correlationId,
    corrections: [correction],
  });
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
    !writableSystemProjection(prepared.recordType)
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

  // An unset default application is absent from the candidate, like every unset optional value.
  const defaultApplicationFieldId = settingsFieldId(
    prepared.recordType,
    "default_application_root_id",
  );
  const defaultApplication = applicationRootIdSchema
    .nullable()
    .safeParse(
      defaultApplicationFieldId === undefined
        ? undefined
        : (values[defaultApplicationFieldId] ?? null),
    );
  if (!defaultApplication.success) {
    const fieldId = defaultApplicationFieldId;
    if (fieldId === undefined || !prepared.readableFieldIds.has(fieldId)) return undefined;
    corrections.set(fieldId, {
      code: "invalid_value",
      fieldId: fieldId as RecordSaveFieldCorrection["fieldId"],
    });
  }
  return [...corrections.values()];
};

/**
 * The organisation's runtime settings, read between a save's prepare and persist phases so a
 * replay or refusal never observes them.
 */
/** @internal Shared only by the fixed named-action save composition. */
export const readOrganizationRuntimeSettings = async (transaction: RequestDatabaseTransaction) =>
  readCurrentOrganizationRuntimeSettingsAfterAuthorization(transaction);

/**
 * The save result plus any before-save rule warnings of a saved attempt. The
 * closed result contract has no warning field, so they travel beside it.
 */
export type RecordSaveServiceResult = HumanOrganizationRequestResult<SaveRecordResult> &
  Readonly<{ warnings?: readonly BeforeSaveRuleWarning[] }>;

export type RecordSaveServiceDependencies = HumanOrganizationRequestDependencies;

type CalculatedValues =
  ReturnType<typeof calculateAndFinalize> | ReturnType<typeof calculateLockedRelationshipTotalSave>;

/**
 * Turns the calculated values of one save into the final values to write, or into the result that
 * ends the save: a located correction, or a safe refusal with its cause logged. It is the one
 * decision both the single save and every record of a batch take before anything is written.
 */
export const finalizeCalculatedValues = async (
  transaction: RequestDatabaseTransaction,
  command: SaveRecordCommand,
  prepared: PreparedSave,
  totalPreparation: RelationshipTotalPreparationOutcome,
  values: CalculatedValues,
  preview: boolean,
  checks?: Readonly<{
    choicePermission: (permissionId: string) => Promise<boolean>;
    readRecord: (
      recordTypeId: string,
      recordId: string,
    ) => Promise<Readonly<Record<string, unknown>> | undefined>;
    /** Whether a value is among the options its declared source offers the saver now. */
    optionMember?: OptionMembershipCheck;
  }>,
): Promise<SaveRecordResult | Readonly<{ finalValues: Record<string, unknown> }>> => {
  if (!values.success) {
    console.error(
      `[record] save refused RECORD_SAVE_VALUES_INVALID: ${values.issues.map((issue) => ("requirement" in issue && issue.requirement ? `${issue.code}:${issue.requirement.code}` : issue.code)).join(",")}`,
    );
    if (totalPreparation.outcome === "prepared") {
      const parentRefusal = values.issues.find(
        (issue) =>
          "recordKey" in issue &&
          issue.recordKey !== "root" &&
          (issue.code === beforeSaveRuleRefusedIssueCode || issue.requirement !== undefined),
      );
      if (parentRefusal !== undefined && "recordKey" in parentRefusal) {
        const parent = totalPreparation.records.find(
          (record) => record.recordKey === parentRefusal.recordKey,
        );
        if (parent?.recordId === undefined)
          throw contractError("RELATIONSHIP_TOTAL_PARENT_MISSING", parentRefusal);
        console.error(
          `[record] parent rule refused: rule=${"ruleKey" in parentRefusal ? parentRefusal.ruleKey : parentRefusal.requirement !== undefined && "ruleKey" in parentRefusal.requirement ? parentRefusal.requirement.ruleKey : "unknown"} parent=${parent.recordId} reason=${parentRefusal.requirement?.code ?? parentRefusal.code}`,
        );
        return safeRefusal(
          prepared.correlationId,
          "operation_refused",
          parent.canRead && parentRefusal.requirement !== undefined
            ? {
                code: parentRefusal.requirement.code,
                message: parentRefusal.requirement.message,
              }
            : {
                code: "related_record_rule_conflict",
                message: "This change conflicts with a rule on a related record",
              },
        );
      }
    }
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
      command.operation,
      new Set(Object.keys(command.submittedValues)),
    );
    if (corrections === undefined || corrections.length === 0) {
      // A rule's authored refusal or requirement is the one reason safe to show; every other
      // cause stays in the log. A named action has no form field to correct, so its rule's
      // sentence must reach the person as the refusal's reason, exactly as a Save shows it.
      return safeRefusal(
        prepared.correlationId,
        "operation_refused",
        values.issues.flatMap((issue) =>
          (issue.code === beforeSaveRuleRefusedIssueCode ||
            issue.code === "required_field_missing") &&
          "requirement" in issue &&
          issue.requirement !== undefined
            ? [{ code: issue.requirement.code, message: issue.requirement.message }]
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

  // A gated option is stored only when the person may use it on this record now (the decision that
  // offered it). An option the record already holds is not chosen again, so it is not re-checked.
  const pendingChecks =
    "records" in values ? values.records.get("root")!.pendingChecks : values.pendingChecks;
  const choiceDecisions = new Map<string, boolean>();
  const refusedChoices: RecordFieldValuePendingCheck[] = [];
  if (!preview)
    for (const check of pendingChecks) {
      if (check.kind !== "choice_permission") continue;
      const held = prepared.existingValues[check.fieldId];
      if (held === check.optionValue || (Array.isArray(held) && held.includes(check.optionValue)))
        continue;
      const decisionKey = String(check.permissionId).toLowerCase();
      let allowed = choiceDecisions.get(decisionKey);
      if (allowed === undefined) {
        allowed =
          checks === undefined
            ? await decideChoiceOptionPermission(
                transaction,
                prepared.recordType.recordTypeId,
                check.permissionId,
                command.operation === "update" ? command.recordId : undefined,
              )
            : await checks.choicePermission(check.permissionId);
        choiceDecisions.set(decisionKey, allowed);
      }
      if (!allowed) refusedChoices.push(check);
    }
  const unsupportedChecks = [
    ...pendingChecks.filter(
      (check) =>
        check.kind !== "record_reference" &&
        check.kind !== "file_reference" &&
        check.kind !== "choice_permission",
    ),
    ...refusedChoices,
  ];
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
    "records" in values ? { ...values.records.get("root")!.finalValues } : { ...values.setValues };
  if ("clearFieldIds" in values)
    for (const fieldId of values.clearFieldIds) finalValues[fieldId] = null;
  if (prepared.recordType.systemProjection === undefined) {
    const dependency = await firstFieldDependencyRefusal(
      transaction,
      prepared.recordType,
      prepared.existingValues,
      Object.keys(command.submittedValues),
      finalValues,
      checks?.readRecord,
    );
    if (dependency !== undefined) {
      // The cause stays in the log; the person is told only which field to choose again.
      console.error(
        `[record] save refused FIELD_DEPENDENCY_${dependency.reason.toUpperCase()}: child=${dependency.childFieldId} parent=${dependency.parentFieldId}`,
      );
      if (!prepared.readableFieldIds.has(dependency.childFieldId.toLowerCase()))
        return safeRefusal(prepared.correlationId, "operation_refused");
      const labelOf = (fieldId: string): string =>
        prepared.recordType.fields.find(
          (candidate) => String(candidate.fieldId).toLowerCase() === fieldId.toLowerCase(),
        )?.label ?? "the field";
      return saveRecordResultSchema.parse({
        contractVersion: "2.0.0",
        outcome: "correction_required",
        correlationId: prepared.correlationId,
        corrections: [
          {
            code: "field_refused" as const,
            fieldId: dependency.childFieldId,
            message: `Choose ${labelOf(dependency.childFieldId)} again: it does not belong to the chosen ${labelOf(dependency.parentFieldId)}.`,
          },
        ],
      });
    }
  }
  if (prepared.recordType.systemProjection === undefined) {
    const sourced = await firstOptionSourceRefusal(
      prepared.recordType,
      Object.keys(command.submittedValues),
      finalValues,
      prepared.existingValues,
      checks?.optionMember,
    );
    if (sourced !== undefined) {
      // The cause stays in the log; the person is told which field to choose again.
      console.error(
        `[record] save refused OPTION_SOURCE_${sourced.reason.toUpperCase()}: field=${sourced.fieldId}`,
      );
      // The person is told about a field they submitted or may read; no other.
      if (
        !prepared.readableFieldIds.has(sourced.fieldId.toLowerCase()) &&
        !Object.keys(command.submittedValues).some((submitted) =>
          sameId(submitted, sourced.fieldId),
        )
      )
        return safeRefusal(prepared.correlationId, "operation_refused");
      const label =
        prepared.recordType.fields.find(
          (candidate) => String(candidate.fieldId).toLowerCase() === sourced.fieldId.toLowerCase(),
        )?.label ?? "the field";
      return saveRecordResultSchema.parse({
        contractVersion: "2.0.0",
        outcome: "correction_required",
        correlationId: prepared.correlationId,
        corrections: [
          {
            code: "field_refused" as const,
            fieldId: sourced.fieldId,
            message:
              sourced.reason === "unchecked"
                ? `${label} cannot be saved from here: its options cannot be checked.`
                : `Choose ${label} again: it is no longer one of the options offered.`,
          },
        ],
      });
    }
  }
  if (prepared.recordType.systemProjection !== undefined) {
    // The shipped text input submits an empty string for an unset optional default.
    // Store that as the nullable application reference the settings writer accepts.
    const defaultApplicationFieldId = settingsFieldId(
      prepared.recordType,
      "default_application_root_id",
    );
    if (defaultApplicationFieldId !== undefined && finalValues[defaultApplicationFieldId] === "")
      finalValues[defaultApplicationFieldId] = null;
    const corrections = invalidSettingsCorrections(prepared, command, finalValues);
    if (corrections === undefined) return safeRefusal(prepared.correlationId, "operation_refused");
    if (corrections.length > 0)
      return saveRecordResultSchema.parse({
        contractVersion: "2.0.0",
        outcome: "correction_required",
        correlationId: prepared.correlationId,
        corrections,
      });
  }
  return { finalValues };
};
