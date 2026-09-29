import {
  recordIdSchema,
  recordTypeDefinitionV3Schema,
  type FieldId,
  type JsonValue,
  type RecordId,
  type RecordTypeDefinitionV3,
} from "@vortex/contracts";
import {
  prepareRecordFieldValuesV2,
  type RecordFieldValuePendingCheck,
  type RecordFieldValuePreparationIssueCode,
} from "./field-values";

/** Maximum number of already-decoded rows accepted in one preview. */
export const RECORD_IMPORT_PREVIEW_MAX_ROWS = 500;
/** Maximum number of source columns accepted in one preview. */
export const RECORD_IMPORT_PREVIEW_MAX_COLUMNS = 500;
/** Maximum number of row errors returned by one preview. */
export const RECORD_IMPORT_PREVIEW_MAX_ERRORS = 1_000;
/** Maximum number of relationship, file, and choice checks resolved for one row. */
export const RECORD_IMPORT_PREVIEW_MAX_PENDING_CHECKS_PER_ROW = 1_000;

type ValueMap = Readonly<Record<string, unknown>>;

export type RecordImportColumnMapping = Readonly<{
  /** Stable decoder column key, not a display name chosen by this module. */
  columnId: string;
  fieldId: FieldId;
}>;

export type RecordImportDuplicatePolicy =
  | Readonly<{ kind: "create_only" }>
  | Readonly<{ kind: "update_by_record_id"; columnId: string }>
  | Readonly<{ kind: "update_by_unique_field"; fieldId: FieldId }>;

/** A row has already passed protected upload checks and a bounded format decoder. */
export type DecodedRecordImportRow = Readonly<{
  /** One-based source row number, unique within the preview. */
  rowNumber: number;
  /** Decoded cells keyed by their stable decoder column IDs. */
  cells: ValueMap;
}>;

export type RecordImportRowAccessFact = Readonly<{
  state: "allowed" | "denied" | "unresolved";
  operation: "create" | "update";
}>;

type UnmatchedRecordImportTarget = Readonly<{
  state: "not_found" | "ambiguous" | "unresolved";
}>;

export type RecordImportRowMatchFact =
  | Readonly<{ method: "none"; state: "not_required" }>
  | (Readonly<{ method: "record_id" }> & UnmatchedRecordImportTarget)
  | Readonly<{
      method: "record_id";
      state: "matched";
      recordId: RecordId;
      existingValues: ValueMap;
    }>
  | (Readonly<{ method: "unique_field"; fieldId: FieldId }> & UnmatchedRecordImportTarget)
  | Readonly<{
      method: "unique_field";
      fieldId: FieldId;
      state: "matched";
      recordId: RecordId;
      existingValues: ValueMap;
    }>;

export type RecordImportUniqueCheckFact = Readonly<{
  fieldId: FieldId;
  state: "confirmed" | "conflict" | "unresolved";
  /** The update target excluded by the protected uniqueness check. Omit for creates. */
  targetRecordId?: RecordId;
}>;

/**
 * Protected resolver facts for one decoded row. The caller must resolve these
 * against the current organisation, published definition, actor, and row.
 * Unique checks must cover the exact values after field normalization and the
 * current update target. Missing or partial facts never authorize an operation.
 */
export type RecordImportRowResolverFacts = Readonly<{
  rowNumber: number;
  access: RecordImportRowAccessFact;
  match: RecordImportRowMatchFact;
  uniqueChecks: readonly RecordImportUniqueCheckFact[];
  /** Exact field checks returned by prepareRecordFieldValuesV2 and confirmed by protected services. */
  resolvedPendingChecks: readonly RecordFieldValuePendingCheck[];
}>;

export type RecordImportPreviewRowErrorCode =
  | RecordFieldValuePreparationIssueCode
  | "access_denied"
  | "access_unresolved"
  | "access_fact_mismatch"
  | "match_policy_mismatch"
  | "match_unresolved"
  | "record_not_found"
  | "ambiguous_match"
  | "invalid_record_id"
  | "record_id_mismatch"
  | "missing_match_value"
  | "duplicate_target"
  | "unresolved_unique_check"
  | "unique_conflict"
  | "unexpected_unique_check"
  | "unresolved_pending_check"
  | "unexpected_resolved_check";

/** Errors intentionally contain no submitted or existing record values. */
export type RecordImportPreviewRowError = Readonly<{
  rowNumber: number;
  code: RecordImportPreviewRowErrorCode;
  fieldId?: string;
  path?: readonly (string | number)[];
  checkKind?: RecordFieldValuePendingCheck["kind"];
}>;

export type RecordImportPreviewInputErrorCode =
  | "invalid_record_type"
  | "record_type_too_large"
  | "invalid_mapping"
  | "mapping_too_large"
  | "invalid_duplicate_policy"
  | "invalid_rows"
  | "row_limit_exceeded"
  | "invalid_resolver_facts"
  | "resolver_facts_limit_exceeded"
  | "error_limit_exceeded";

export type RecordImportPreviewInputError = Readonly<{
  code: RecordImportPreviewInputErrorCode;
  columnId?: string;
  fieldId?: FieldId;
  rowNumber?: number;
}>;

export type RecordImportPreviewOperation = Readonly<{
  rowNumber: number;
  operation: "create" | "update";
  recordId?: RecordId;
  /** Canonical Record patch produced by the same validation used at execution. */
  values: Readonly<{
    setValues: Readonly<Record<string, JsonValue>>;
    clearFieldIds: readonly string[];
  }>;
}>;

export type RecordImportPreviewPlan = Readonly<{
  recordTypeId: RecordTypeDefinitionV3["recordTypeId"];
  /** Canonical mapping to retain unchanged for confirmed execution. */
  mapping: readonly RecordImportColumnMapping[];
  duplicatePolicy: RecordImportDuplicatePolicy;
  operations: readonly RecordImportPreviewOperation[];
  rowErrors: readonly RecordImportPreviewRowError[];
}>;

export type PlanRecordImportPreviewInput = Readonly<{
  /** Trusted published definition resolved by the protected caller. */
  recordType: RecordTypeDefinitionV3;
  /** Already-decoded rows from the trusted File pipeline; this module reads no bytes. */
  rows: readonly DecodedRecordImportRow[];
  columnMapping: readonly RecordImportColumnMapping[];
  duplicatePolicy: RecordImportDuplicatePolicy;
  /** Backend-resolved access, match, and pending-check facts for each row. */
  rowFacts: readonly RecordImportRowResolverFacts[];
  organizationCurrency?: string;
}>;

export type PlanRecordImportPreviewResult =
  | Readonly<{ success: true; plan: RecordImportPreviewPlan }>
  | Readonly<{
      success: false;
      error: RecordImportPreviewInputError;
      /** Bounded diagnostics are provided only when the input itself exceeded the error cap. */
      rowErrors?: readonly RecordImportPreviewRowError[];
    }>;

type PreparedRow = {
  readonly rowNumber: number;
  readonly errors: RecordImportPreviewRowError[];
  readonly operation?: RecordImportPreviewOperation;
};

const generatedFieldTypes = new Set(["reference_number", "calculation", "total"]);

const hasPlainDataProperties = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
};

const isPlainDataRecord = (value: unknown): value is Record<string, unknown> =>
  hasPlainDataProperties(value);

const lexicographic = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalMapping = (
  mapping: readonly RecordImportColumnMapping[],
): readonly RecordImportColumnMapping[] =>
  [...mapping]
    .map(({ columnId, fieldId }) => ({ columnId, fieldId }))
    .sort(
      (left, right) =>
        lexicographic(left.fieldId, right.fieldId) || lexicographic(left.columnId, right.columnId),
    );

const inputFailure = (
  code: RecordImportPreviewInputErrorCode,
  details: Omit<RecordImportPreviewInputError, "code"> = {},
): PlanRecordImportPreviewResult => ({ success: false, error: { code, ...details } });

const pendingCheckKey = (check: RecordFieldValuePendingCheck): string => {
  switch (check.kind) {
    case "choice_permission":
      return JSON.stringify([check.kind, check.fieldId, check.path, check.permissionId]);
    case "record_reference":
      return JSON.stringify([
        check.kind,
        check.fieldId,
        check.path,
        check.recordTypeId,
        check.recordId,
      ]);
    case "person_reference":
      return JSON.stringify([
        check.kind,
        check.fieldId,
        check.path,
        check.organizationAccountId,
        check.audience,
        check.applicationRootIdRequired,
      ]);
    case "file_reference":
      return JSON.stringify([check.kind, check.fieldId, check.path, check.fileId]);
  }
};

const isPendingCheck = (value: unknown): value is RecordFieldValuePendingCheck => {
  if (!isPlainDataRecord(value) || typeof value.kind !== "string" || !Array.isArray(value.path))
    return false;
  if (
    typeof value.fieldId !== "string" ||
    !value.path.every((part) => typeof part === "string" || Number.isSafeInteger(part))
  )
    return false;
  switch (value.kind) {
    case "choice_permission":
      return typeof value.permissionId === "string";
    case "record_reference":
      return typeof value.recordTypeId === "string" && typeof value.recordId === "string";
    case "person_reference":
      return (
        typeof value.organizationAccountId === "string" &&
        (value.audience === "organization_accounts" ||
          value.audience === "application_accounts" ||
          value.audience === "organization_identities_and_external_requesters") &&
        typeof value.applicationRootIdRequired === "boolean"
      );
    case "file_reference":
      return typeof value.fileId === "string";
    default:
      return false;
  }
};

const canonicalDuplicatePolicy = (
  policy: RecordImportDuplicatePolicy,
): RecordImportDuplicatePolicy => {
  switch (policy.kind) {
    case "create_only":
      return { kind: "create_only" };
    case "update_by_record_id":
      return { kind: "update_by_record_id", columnId: policy.columnId };
    case "update_by_unique_field":
      return { kind: "update_by_unique_field", fieldId: policy.fieldId };
  }
};

const canonicalValues = (
  values: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> =>
  Object.fromEntries(Object.entries(values).sort(([left], [right]) => lexicographic(left, right)));

const canonicalFieldIds = (fieldIds: readonly string[]): readonly string[] =>
  [...fieldIds].sort(lexicographic);

/**
 * Plans bounded import rows without reading files, resolving authority, or
 * performing writes. The caller supplies trusted resolver facts; any missing,
 * mismatched, denied, or unresolved fact prevents that row from becoming an
 * operation. Execution should consume this plan's mapping and validated values
 * directly instead of mapping or normalizing the source rows again.
 */
export const planRecordImportPreview = (
  input: PlanRecordImportPreviewInput,
): PlanRecordImportPreviewResult => {
  const recordTypeResult = recordTypeDefinitionV3Schema.safeParse(input.recordType);
  if (!recordTypeResult.success) return inputFailure("invalid_record_type");
  const recordType = recordTypeResult.data;
  if (recordType.fields.length > RECORD_IMPORT_PREVIEW_MAX_COLUMNS)
    return inputFailure("record_type_too_large");

  if (!Array.isArray(input.columnMapping)) return inputFailure("invalid_mapping");
  if (input.columnMapping.length > RECORD_IMPORT_PREVIEW_MAX_COLUMNS)
    return inputFailure("mapping_too_large");
  const fieldsById = new Map(recordType.fields.map((field) => [field.fieldId, field]));
  const mappedColumns = new Set<string>();
  const mappedFields = new Set<string>();
  for (const entry of input.columnMapping) {
    if (
      !hasPlainDataProperties(entry) ||
      typeof entry.columnId !== "string" ||
      entry.columnId.length === 0 ||
      entry.columnId.length > 256 ||
      typeof entry.fieldId !== "string" ||
      !fieldsById.has(entry.fieldId) ||
      mappedColumns.has(entry.columnId) ||
      mappedFields.has(entry.fieldId)
    )
      return inputFailure("invalid_mapping");
    mappedColumns.add(entry.columnId);
    mappedFields.add(entry.fieldId);
  }
  const mapping = canonicalMapping(input.columnMapping);

  if (!Array.isArray(input.rows)) return inputFailure("invalid_rows");
  if (input.rows.length > RECORD_IMPORT_PREVIEW_MAX_ROWS) return inputFailure("row_limit_exceeded");
  const rowsByNumber = new Map<number, DecodedRecordImportRow>();
  for (const row of input.rows) {
    if (
      !hasPlainDataProperties(row) ||
      !Number.isSafeInteger(row.rowNumber) ||
      row.rowNumber <= 0 ||
      !hasPlainDataProperties(row.cells) ||
      Reflect.ownKeys(row.cells).length > RECORD_IMPORT_PREVIEW_MAX_COLUMNS ||
      rowsByNumber.has(row.rowNumber)
    )
      return inputFailure("invalid_rows");
    rowsByNumber.set(row.rowNumber, row);
  }
  const rows = [...rowsByNumber.values()].sort((left, right) => left.rowNumber - right.rowNumber);

  if (!input.duplicatePolicy || typeof input.duplicatePolicy !== "object")
    return inputFailure("invalid_duplicate_policy");
  switch (input.duplicatePolicy.kind) {
    case "create_only":
      break;
    case "update_by_record_id":
      if (
        typeof input.duplicatePolicy.columnId !== "string" ||
        input.duplicatePolicy.columnId.length === 0 ||
        input.duplicatePolicy.columnId.length > 256 ||
        mappedColumns.has(input.duplicatePolicy.columnId)
      )
        return inputFailure("invalid_duplicate_policy");
      break;
    case "update_by_unique_field": {
      const uniqueField = fieldsById.get(input.duplicatePolicy.fieldId);
      if (
        uniqueField === undefined ||
        uniqueField.unique !== true ||
        generatedFieldTypes.has(uniqueField.type) ||
        !mappedFields.has(input.duplicatePolicy.fieldId)
      )
        return inputFailure("invalid_duplicate_policy", { fieldId: input.duplicatePolicy.fieldId });
      break;
    }
    default:
      return inputFailure("invalid_duplicate_policy");
  }

  if (!Array.isArray(input.rowFacts)) return inputFailure("invalid_resolver_facts");
  if (input.rowFacts.length > RECORD_IMPORT_PREVIEW_MAX_ROWS)
    return inputFailure("resolver_facts_limit_exceeded");
  if (input.rowFacts.length !== rows.length) return inputFailure("invalid_resolver_facts");
  const factsByRowNumber = new Map<number, RecordImportRowResolverFacts>();
  for (const facts of input.rowFacts) {
    if (
      !hasPlainDataProperties(facts) ||
      !Number.isSafeInteger(facts.rowNumber) ||
      facts.rowNumber <= 0 ||
      !rowsByNumber.has(facts.rowNumber) ||
      factsByRowNumber.has(facts.rowNumber) ||
      !hasPlainDataProperties(facts.access) ||
      !["allowed", "denied", "unresolved"].includes(facts.access.state) ||
      !["create", "update"].includes(facts.access.operation) ||
      !hasPlainDataProperties(facts.match) ||
      !Array.isArray(facts.uniqueChecks) ||
      !Array.isArray(facts.resolvedPendingChecks)
    )
      return inputFailure("invalid_resolver_facts");
    if (facts.uniqueChecks.length > RECORD_IMPORT_PREVIEW_MAX_COLUMNS)
      return inputFailure("resolver_facts_limit_exceeded", { rowNumber: facts.rowNumber });
    const uniqueCheckFieldIds = new Set<string>();
    for (const check of facts.uniqueChecks) {
      if (
        !hasPlainDataProperties(check) ||
        typeof check.fieldId !== "string" ||
        fieldsById.get(check.fieldId)?.unique !== true ||
        !["confirmed", "conflict", "unresolved"].includes(check.state) ||
        uniqueCheckFieldIds.has(check.fieldId) ||
        (check.targetRecordId !== undefined &&
          !recordIdSchema.safeParse(check.targetRecordId).success)
      )
        return inputFailure("invalid_resolver_facts", { rowNumber: facts.rowNumber });
      uniqueCheckFieldIds.add(check.fieldId);
    }
    if (facts.resolvedPendingChecks.length > RECORD_IMPORT_PREVIEW_MAX_PENDING_CHECKS_PER_ROW)
      return inputFailure("resolver_facts_limit_exceeded", { rowNumber: facts.rowNumber });
    factsByRowNumber.set(facts.rowNumber, facts);
  }
  if (rows.some((row) => !factsByRowNumber.has(row.rowNumber)))
    return inputFailure("invalid_resolver_facts");

  const rowErrors: RecordImportPreviewRowError[] = [];
  let errorLimitExceeded = false;
  const addError = (error: RecordImportPreviewRowError): void => {
    if (rowErrors.length >= RECORD_IMPORT_PREVIEW_MAX_ERRORS) {
      errorLimitExceeded = true;
      return;
    }
    rowErrors.push(error);
  };

  const preparedRows: PreparedRow[] = [];
  for (const row of rows) {
    const errors: RecordImportPreviewRowError[] = [];
    const addRowError = (error: Omit<RecordImportPreviewRowError, "rowNumber">): void => {
      const complete = { rowNumber: row.rowNumber, ...error };
      const withinLimit = rowErrors.length < RECORD_IMPORT_PREVIEW_MAX_ERRORS;
      addError(complete);
      if (withinLimit) errors.push(complete);
    };
    const facts = factsByRowNumber.get(row.rowNumber)!;
    const mappedValues: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const { columnId, fieldId } of mapping) {
      if (Object.hasOwn(row.cells, columnId))
        mappedValues[fieldId] = Object.getOwnPropertyDescriptor(row.cells, columnId)!.value;
    }

    let operation: "create" | "update" | undefined;
    let recordId: RecordId | undefined;
    let existingValues: ValueMap | undefined;
    let matchCanProceed = false;

    if (input.duplicatePolicy.kind === "create_only") {
      operation = "create";
      if (facts.match.method !== "none" || facts.match.state !== "not_required")
        addRowError({ code: "match_policy_mismatch" });
      else matchCanProceed = true;
    } else if (input.duplicatePolicy.kind === "update_by_record_id") {
      operation = "update";
      const rawId = Object.hasOwn(row.cells, input.duplicatePolicy.columnId)
        ? Object.getOwnPropertyDescriptor(row.cells, input.duplicatePolicy.columnId)!.value
        : undefined;
      const parsedId = recordIdSchema.safeParse(rawId);
      if (!parsedId.success) addRowError({ code: "invalid_record_id" });
      if (facts.match.method !== "record_id") {
        addRowError({ code: "match_policy_mismatch" });
      } else if (facts.match.state === "matched") {
        const parsedTargetId = recordIdSchema.safeParse(facts.match.recordId);
        if (!parsedTargetId.success) addRowError({ code: "invalid_record_id" });
        else if (parsedId.success && parsedId.data !== parsedTargetId.data)
          addRowError({ code: "record_id_mismatch" });
        else if (parsedId.success) {
          recordId = parsedTargetId.data;
          existingValues = facts.match.existingValues;
          matchCanProceed = true;
        }
      } else if (facts.match.state === "not_found") {
        addRowError({ code: "record_not_found" });
      } else if (facts.match.state === "ambiguous") {
        addRowError({ code: "ambiguous_match" });
      } else {
        addRowError({ code: "match_unresolved" });
      }
    } else {
      operation = "update";
      const uniqueFieldId = input.duplicatePolicy.fieldId;
      const hasUniqueValue =
        Object.hasOwn(mappedValues, uniqueFieldId) &&
        mappedValues[uniqueFieldId] !== null &&
        mappedValues[uniqueFieldId] !== undefined;
      if (!hasUniqueValue) addRowError({ code: "missing_match_value", fieldId: uniqueFieldId });
      if (facts.match.method !== "unique_field" || facts.match.fieldId !== uniqueFieldId) {
        addRowError({ code: "match_policy_mismatch", fieldId: uniqueFieldId });
      } else if (facts.match.state === "matched") {
        const parsedTargetId = recordIdSchema.safeParse(facts.match.recordId);
        if (!parsedTargetId.success)
          addRowError({ code: "invalid_record_id", fieldId: uniqueFieldId });
        else if (hasUniqueValue) {
          recordId = parsedTargetId.data;
          existingValues = facts.match.existingValues;
          matchCanProceed = true;
        }
      } else if (facts.match.state === "not_found") {
        addRowError({ code: "record_not_found", fieldId: uniqueFieldId });
      } else if (facts.match.state === "ambiguous") {
        addRowError({ code: "ambiguous_match", fieldId: uniqueFieldId });
      } else {
        addRowError({ code: "match_unresolved", fieldId: uniqueFieldId });
      }
    }

    if (operation !== undefined && facts.access.operation !== operation) {
      addRowError({ code: "access_fact_mismatch" });
    } else if (facts.access.state === "denied") {
      addRowError({ code: "access_denied" });
    } else if (facts.access.state === "unresolved") {
      addRowError({ code: "access_unresolved" });
    }

    if (!matchCanProceed || errors.length > 0 || operation === undefined) {
      preparedRows.push({ rowNumber: row.rowNumber, errors });
      if (errorLimitExceeded) break;
      continue;
    }

    const prepared = prepareRecordFieldValuesV2({
      operation,
      recordType,
      submittedValues: mappedValues,
      ...(operation === "update" && existingValues !== undefined ? { existingValues } : {}),
      ...(input.organizationCurrency === undefined
        ? {}
        : { organizationCurrency: input.organizationCurrency }),
    });
    if (!prepared.success) {
      for (const issue of prepared.issues)
        addRowError({
          code: issue.code,
          ...(issue.fieldId === undefined ? {} : { fieldId: issue.fieldId }),
          path: issue.path,
        });
      preparedRows.push({ rowNumber: row.rowNumber, errors });
      if (errorLimitExceeded) break;
      continue;
    }

    const requiredUniqueFieldIds = new Set<FieldId>();
    for (const fieldId of Object.keys(prepared.setValues)) {
      const field = fieldsById.get(fieldId as FieldId);
      if (field?.unique === true && !generatedFieldTypes.has(field.type))
        requiredUniqueFieldIds.add(field.fieldId);
    }
    if (input.duplicatePolicy.kind === "update_by_unique_field")
      requiredUniqueFieldIds.add(input.duplicatePolicy.fieldId);
    const uniqueChecks = [...facts.uniqueChecks].sort((left, right) =>
      lexicographic(left.fieldId, right.fieldId),
    );
    const uniqueChecksByFieldId = new Map(
      uniqueChecks.map((check) => [check.fieldId, check] as const),
    );
    for (const check of uniqueChecks) {
      if (!requiredUniqueFieldIds.has(check.fieldId)) {
        addRowError({ code: "unexpected_unique_check", fieldId: check.fieldId });
        continue;
      }
      const expectedTargetRecordId = operation === "update" ? recordId : undefined;
      if (check.targetRecordId !== expectedTargetRecordId) {
        addRowError({ code: "unexpected_unique_check", fieldId: check.fieldId });
      } else if (check.state === "conflict") {
        addRowError({ code: "unique_conflict", fieldId: check.fieldId });
      } else if (check.state === "unresolved") {
        addRowError({ code: "unresolved_unique_check", fieldId: check.fieldId });
      }
    }
    for (const fieldId of requiredUniqueFieldIds)
      if (!uniqueChecksByFieldId.has(fieldId))
        addRowError({ code: "unresolved_unique_check", fieldId });

    const pendingChecksByKey = new Map<string, RecordFieldValuePendingCheck>();
    let invalidResolvedChecks = false;
    for (const check of facts.resolvedPendingChecks) {
      if (!isPendingCheck(check)) {
        invalidResolvedChecks = true;
        continue;
      }
      const key = pendingCheckKey(check);
      if (pendingChecksByKey.has(key)) invalidResolvedChecks = true;
      pendingChecksByKey.set(key, check);
    }
    const requiredCheckKeys = new Set(prepared.pendingChecks.map(pendingCheckKey));
    for (const check of prepared.pendingChecks) {
      const key = pendingCheckKey(check);
      if (!pendingChecksByKey.has(key))
        addRowError({
          code: "unresolved_pending_check",
          fieldId: check.fieldId,
          path: check.path,
          checkKind: check.kind,
        });
    }
    if ([...pendingChecksByKey.keys()].some((key) => !requiredCheckKeys.has(key)))
      invalidResolvedChecks = true;
    if (invalidResolvedChecks) addRowError({ code: "unexpected_resolved_check" });

    if (errors.length === 0) {
      const normalizedValues = {
        setValues: canonicalValues(prepared.setValues),
        clearFieldIds: canonicalFieldIds(prepared.clearFieldIds),
      };
      preparedRows.push({
        rowNumber: row.rowNumber,
        errors,
        operation: {
          rowNumber: row.rowNumber,
          operation,
          ...(operation === "update" && recordId !== undefined ? { recordId } : {}),
          values: normalizedValues,
        },
      });
    } else {
      preparedRows.push({ rowNumber: row.rowNumber, errors });
    }
    if (errorLimitExceeded) break;
  }

  if (errorLimitExceeded)
    return {
      success: false,
      error: {
        code: "error_limit_exceeded",
        ...(preparedRows.at(-1) === undefined ? {} : { rowNumber: preparedRows.at(-1)!.rowNumber }),
      },
      rowErrors,
    };

  const targetRowsById = new Map<RecordId, number[]>();
  for (const preparedRow of preparedRows) {
    if (
      preparedRow.operation?.operation !== "update" ||
      preparedRow.operation.recordId === undefined
    )
      continue;
    const targetRows = targetRowsById.get(preparedRow.operation.recordId) ?? [];
    targetRows.push(preparedRow.rowNumber);
    targetRowsById.set(preparedRow.operation.recordId, targetRows);
  }
  const duplicateTargetRows = new Set<number>();
  for (const targetRows of targetRowsById.values())
    if (targetRows.length > 1)
      for (const rowNumber of targetRows) duplicateTargetRows.add(rowNumber);
  for (const preparedRow of preparedRows)
    if (duplicateTargetRows.has(preparedRow.rowNumber))
      addError({ rowNumber: preparedRow.rowNumber, code: "duplicate_target" });

  if (errorLimitExceeded)
    return {
      success: false,
      error: { code: "error_limit_exceeded" },
      rowErrors,
    };

  const duplicateTargetSet = duplicateTargetRows;
  const operations = preparedRows
    .filter((row) => row.operation !== undefined && !duplicateTargetSet.has(row.rowNumber))
    .map((row) => row.operation!);
  return {
    success: true,
    plan: {
      recordTypeId: recordType.recordTypeId,
      mapping,
      duplicatePolicy: canonicalDuplicatePolicy(input.duplicatePolicy),
      operations,
      rowErrors,
    },
  };
};
