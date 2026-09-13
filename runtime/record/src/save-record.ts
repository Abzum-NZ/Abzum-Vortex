import "server-only";

import { randomUUID } from "node:crypto";
import {
  activityIdSchema,
  eventOccurrenceIdSchema,
  fieldIdSchema,
  recordTypeDefinitionV2Schema,
  saveRecordCommandV2Schema,
  saveRecordResultV2Schema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type RecordSaveFieldCorrection,
  type SaveRecordCommandV2,
  type SaveRecordResultV2,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { evaluateRecordCalculationsV2 } from "./calculations";
import {
  finalizeRecordFieldCandidateV2,
  prepareInitialRecordFieldCandidateV2,
  type PrepareRecordFieldValuesV2Result,
} from "./field-values";

type PreparationRow = DatabaseRow & { readonly preparation: unknown };
type SaveRow = DatabaseRow & { readonly result: unknown };

type PreparedSave = Readonly<{
  outcome: "prepared";
  recordType: ReturnType<typeof recordTypeDefinitionV2Schema.parse>;
  existingValues: Readonly<Record<string, unknown>>;
  readableFieldIds: ReadonlySet<string>;
  correlationId: string;
}>;

type PreparationOutcome =
  | PreparedSave
  | Readonly<{ outcome: "replayed"; result: SaveRecordResultV2 }>
  | Readonly<{ outcome: "refused_recorded" }>
  | Readonly<{ outcome: "conflict"; correlationId?: string }>
  | Readonly<{ outcome: "unavailable"; correlationId?: string }>;

type StoredResult =
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
    }>
  | Readonly<{
      outcome: "refused";
      reasonCode?: string;
    }>
  | Readonly<{
      outcome: "refused_recorded";
      reasonCode?: string;
    }>;

const recordedRefusal = Symbol("recordedRecordSaveRefusal");

const revision = (candidate: unknown): number | undefined => {
  if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0)
    return candidate;
  if (
    typeof candidate === "bigint" &&
    candidate > 0n &&
    candidate <= BigInt(Number.MAX_SAFE_INTEGER)
  )
    return Number(candidate);
  if (typeof candidate === "string" && /^[1-9][0-9]*$/.test(candidate)) {
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
};

const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("RECORD_SAVE_RESULT_INVALID");
  return rows[0];
};

const parsePreparation = (candidate: unknown): PreparationOutcome => {
  if (typeof candidate !== "object" || candidate === null) return { outcome: "unavailable" };
  const value = candidate as Record<string, unknown>;
  const correlationId = typeof value.correlationId === "string" ? value.correlationId : undefined;
  if (value.outcome === "saved") {
    const replay = saveRecordResultV2Schema.safeParse({
      contractVersion: "2.0.0",
      outcome: "saved",
      recordId: value.recordId,
      concurrencyNumber: revision(value.concurrencyNumber),
      readableValues: value.values,
      correlationId,
      backgroundDelivery: value.backgroundDelivery,
    });
    return replay.success
      ? { outcome: "replayed", result: replay.data }
      : { outcome: "unavailable", ...(correlationId ? { correlationId } : {}) };
  }
  if (value.outcome === "refused" && value.reasonCode === "command_identity_conflict")
    return { outcome: "conflict", ...(correlationId ? { correlationId } : {}) };
  if (value.outcome === "refused_recorded") return { outcome: "refused_recorded" };
  if (value.outcome === "conflict")
    return { outcome: "conflict", ...(correlationId ? { correlationId } : {}) };
  if (value.outcome !== "prepared")
    return { outcome: "unavailable", ...(correlationId ? { correlationId } : {}) };
  const recordType = recordTypeDefinitionV2Schema.safeParse(value.recordType);
  if (
    !recordType.success ||
    typeof value.existingValues !== "object" ||
    value.existingValues === null ||
    Array.isArray(value.existingValues)
  )
    return { outcome: "unavailable", ...(correlationId ? { correlationId } : {}) };
  if (correlationId === undefined) return { outcome: "unavailable" };
  const readableFieldIds = Array.isArray(value.readableFieldIds)
    ? value.readableFieldIds.map((fieldId) => fieldIdSchema.safeParse(fieldId))
    : [];
  if (readableFieldIds.some((fieldId) => !fieldId.success))
    return { outcome: "unavailable", correlationId };
  return {
    outcome: "prepared",
    recordType: recordType.data,
    existingValues: value.existingValues as Readonly<Record<string, unknown>>,
    readableFieldIds: new Set(
      readableFieldIds.flatMap((fieldId) => (fieldId.success ? [fieldId.data] : [])),
    ),
    correlationId,
  };
};

const correctionCode = (code: string): RecordSaveFieldCorrection["code"] => {
  if (code.startsWith("required_")) return "required_value";
  if (code === "unknown_field" || code === "generated_field_input") return "field_refused";
  return "invalid_value";
};

const localDate = (instant: string, timeZone: string): string | undefined => {
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    const year = value("year");
    const month = value("month");
    const day = value("day");
    return year && month && day ? `${year}-${month}-${day}` : undefined;
  } catch {
    return undefined;
  }
};

type CalculatedFieldValues =
  | PrepareRecordFieldValuesV2Result
  | Readonly<{
      success: false;
      issues: ReadonlyArray<
        Readonly<{
          code: string;
          fieldId?: string;
          path: readonly (string | number)[];
        }>
      >;
    }>;

/**
 * Builds one complete candidate before the fixed writer sees it. Submitted
 * generated values were already refused by the initial preparation; only the
 * trusted calculation engine can add calculation values here.
 */
const calculateAndFinalize = (
  prepared: Extract<PreparationOutcome, { outcome: "prepared" }>,
  command: SaveRecordCommandV2,
  issuedAt: string,
  organizationCurrency: string | undefined,
  timeZone: string | undefined,
): CalculatedFieldValues => {
  const initial = prepareInitialRecordFieldCandidateV2({
    operation: command.operation,
    recordType: prepared.recordType,
    submittedValues: command.submittedValues,
    ...(organizationCurrency === undefined ? {} : { organizationCurrency }),
    ...(command.operation === "update" ? { existingValues: prepared.existingValues } : {}),
  });
  if (!initial.success) return initial;

  const calculationFieldIds = prepared.recordType.fields
    .filter((field) => field.type === "calculation")
    .map((field) => field.fieldId);
  if (calculationFieldIds.length === 0)
    return finalizeRecordFieldCandidateV2({
      recordType: prepared.recordType,
      initialCandidate: initial.candidate,
      candidateValues: initial.candidate.candidateValues,
      requiredGeneratedFieldIds: [],
      ...(organizationCurrency === undefined ? {} : { organizationCurrency }),
    });

  // Most calculation forms do not use the organisation clock. Only a
  // deadline comparison needs the organisation-local date; requiring runtime
  // settings for every calculation would refuse otherwise deterministic saves.
  const needsOrganizationLocalDate = prepared.recordType.fields.some(
    (field) => field.type === "calculation" && field.settings.expression.kind === "deadline_passed",
  );
  const organizationLocalDate = needsOrganizationLocalDate
    ? timeZone === undefined
      ? undefined
      : localDate(issuedAt, timeZone)
    : issuedAt.slice(0, 10);
  if (organizationLocalDate === undefined)
    return {
      success: false,
      issues: [{ code: "invalid_input", path: ["organizationRuntimeSettings"] }],
    };

  const calculations = evaluateRecordCalculationsV2({
    recordType: prepared.recordType,
    authoritativeFieldValues: initial.candidate.candidateValues,
    clock: { instant: issuedAt, organizationLocalDate },
  });
  if (!calculations.success) return calculations;

  const candidateValues: Record<string, unknown> = {
    ...initial.candidate.candidateValues,
    ...calculations.setValues,
  };
  for (const fieldId of calculations.clearFieldIds) delete candidateValues[fieldId];
  return finalizeRecordFieldCandidateV2({
    recordType: prepared.recordType,
    initialCandidate: initial.candidate,
    candidateValues,
    requiredGeneratedFieldIds: calculationFieldIds,
    ...(organizationCurrency === undefined ? {} : { organizationCurrency }),
  });
};

const correctionsFor = (
  issues: readonly Readonly<{
    code: string;
    fieldId?: string;
    path: readonly (string | number)[];
  }>[],
  readableFieldIds: ReadonlySet<string>,
): readonly RecordSaveFieldCorrection[] | undefined => {
  const corrections = new Map<string, RecordSaveFieldCorrection>();
  for (const issue of issues) {
    if (issue.fieldId === undefined || !readableFieldIds.has(issue.fieldId)) return undefined;
    const code = correctionCode(issue.code);
    const nested = issue.path.slice(2);
    const correction: RecordSaveFieldCorrection = {
      code,
      fieldId: issue.fieldId as RecordSaveFieldCorrection["fieldId"],
      ...(nested.length === 0
        ? {}
        : { nestedPath: nested as RecordSaveFieldCorrection["nestedPath"] }),
    };
    corrections.set(
      `${correction.fieldId}:${correction.code}:${JSON.stringify(nested)}`,
      correction,
    );
  }
  return [...corrections.values()];
};

const safeRefusal = (
  correlationId: string,
  code: "invalid_request" | "operation_refused" | "conflict",
): SaveRecordResultV2 =>
  saveRecordResultV2Schema.parse({
    contractVersion: "2.0.0",
    outcome: "refused",
    error: {
      code,
      messageKey: `errors.${code}`,
      correlationId,
    },
  });

const prepare = async (
  transaction: RequestDatabaseTransaction,
  command: SaveRecordCommandV2,
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

const persist = async (
  transaction: RequestDatabaseTransaction,
  command: SaveRecordCommandV2,
  finalValues: Readonly<Record<string, unknown>>,
  activityId: string,
  occurrenceId: string,
): Promise<StoredResult> => {
  const rows = await transaction.query<SaveRow>`
    select vortex_record.save_base_record(
      ${command.commandId}::uuid,
      ${command.operation}::text,
      ${command.recordTypeId}::uuid,
      ${command.operation === "update" ? command.recordId : null}::uuid,
      ${command.operation === "update" ? command.expectedConcurrencyNumber : null}::bigint,
      ${JSON.stringify(command.submittedValues)}::text::jsonb,
      ${JSON.stringify(finalValues)}::text::jsonb,
      ${command.operation === "create" ? (command.selectedOwnerGroupId ?? null) : null}::uuid,
      ${activityId}::uuid,
      ${occurrenceId}::uuid
    ) as result
  `;
  const candidate = one(rows).result;
  if (typeof candidate !== "object" || candidate === null)
    throw new Error("RECORD_SAVE_RESULT_INVALID");
  return candidate as StoredResult;
};

/**
 * The Record service owns the privileged prepare/persist boundary, while
 * Access owns the request-scoped settings read. Keep that read between those
 * two phases: a replay or refusal never observes settings, and persistence
 * always resumes with the runtime role.
 */
const readOrganizationRuntimeSettings = async (transaction: RequestDatabaseTransaction) => {
  await transaction.query`set local role vortex_request`;
  try {
    return await readCurrentOrganizationRuntimeSettingsAfterAuthorization(transaction);
  } finally {
    await transaction.query`set local role vortex_runtime`;
  }
};

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
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<SaveRecordResultV2>> {
      const command = saveRecordCommandV2Schema.safeParse(commandCandidate);
      if (!command.success || selection.applicationRootId === undefined)
        return { kind: "unavailable" };

      const result = await requests.runChange(
        session,
        selection,
        async (transaction, _scope, issuedAt) => {
          const activityId = activityIdSchema.parse(newActivityId());
          const prepared = await prepare(transaction, command.data, activityId);
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

          const settings = await readOrganizationRuntimeSettings(transaction);
          const values = calculateAndFinalize(
            prepared,
            command.data,
            issuedAt,
            settings?.currency,
            settings?.timeZone,
          );
          if (!values.success) {
            if (values.issues.some((issue) => issue.code === "organization_currency_required"))
              return safeRefusal(prepared.correlationId, "operation_refused");
            const corrections = correctionsFor(values.issues, prepared.readableFieldIds);
            return corrections === undefined || corrections.length === 0
              ? safeRefusal(prepared.correlationId, "operation_refused")
              : saveRecordResultV2Schema.parse({
                  contractVersion: "2.0.0",
                  outcome: "correction_required",
                  correlationId: prepared.correlationId,
                  corrections,
                });
          }

          const unsupportedChecks = values.pendingChecks.filter(
            (check) => check.kind !== "record_reference",
          );
          if (unsupportedChecks.length > 0) {
            if (unsupportedChecks.some((check) => !prepared.readableFieldIds.has(check.fieldId)))
              return safeRefusal(prepared.correlationId, "operation_refused");
            const corrections = unsupportedChecks.map((check) => ({
              code: "field_refused" as const,
              fieldId: check.fieldId,
            }));
            return saveRecordResultV2Schema.parse({
              contractVersion: "2.0.0",
              outcome: "correction_required",
              correlationId: prepared.correlationId,
              corrections,
            });
          }

          const finalValues: Record<string, unknown> = { ...values.setValues };
          for (const fieldId of values.clearFieldIds) finalValues[fieldId] = null;
          const occurrenceId = eventOccurrenceIdSchema.parse(newOccurrenceId());
          const stored = await persist(
            transaction,
            command.data,
            finalValues,
            activityId,
            occurrenceId,
          );
          if (stored.outcome === "refused_recorded") return recordedRefusal;
          if (stored.outcome === "conflict") return safeRefusal(prepared.correlationId, "conflict");
          if (stored.outcome === "refused")
            return safeRefusal(
              prepared.correlationId,
              stored.reasonCode === "command_invalid" ? "invalid_request" : "operation_refused",
            );
          const concurrencyNumber = revision(stored.concurrencyNumber);
          if (concurrencyNumber === undefined) throw new Error("RECORD_SAVE_RESULT_INVALID");
          return saveRecordResultV2Schema.parse({
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
      return result.value === recordedRefusal
        ? { kind: "unavailable" }
        : { kind: "available", value: result.value as SaveRecordResultV2 };
    },
  });
};
