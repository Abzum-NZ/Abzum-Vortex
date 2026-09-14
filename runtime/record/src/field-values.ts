import { isDeepStrictEqual } from "node:util";
import {
  currencyCodeV2Schema,
  exactDecimalTextV2Schema,
  exactDecimalWithinBoundsV2,
  fieldDefinitionSchema,
  fileIdSchema,
  moduleFieldV2Schema,
  moduleFieldValueV2Schemas,
  moneyValueV2Schema,
  normalizeExactDecimal,
  parseExactDecimal,
  recordTypeDefinitionV2Schema,
  sourceExactDecimalTextV2Schema,
  sourceModuleFieldValueV2Schemas,
  sourceMoneyValueV2Schema,
  timestampSchema,
  type FieldDefinition,
  type FileId,
  type JsonValue,
  type ModuleFieldV2,
  type PermissionId,
  type RecordTypeDefinitionV2,
} from "@vortex/contracts";

type ValueMap = Readonly<Record<string, unknown>>;
type ValuePath = readonly (string | number)[];

export type RecordFieldValuePreparationIssueCode =
  | "invalid_input"
  | "invalid_existing_value"
  | "unknown_field"
  | "generated_field_input"
  | "required_field_missing"
  | "required_field_clear"
  | "required_attachment_empty"
  | "invalid_value"
  | "organization_currency_required"
  | "unresolved_record_target";

export type RecordFieldValuePreparationIssue = Readonly<{
  code: RecordFieldValuePreparationIssueCode;
  fieldId?: string;
  path: ValuePath;
  requirement?: Readonly<{ code: string; message: string }>;
}>;

export type RecordFieldValuePendingCheck =
  | Readonly<{
      kind: "choice_permission";
      fieldId: string;
      path: ValuePath;
      permissionId: PermissionId;
    }>
  | Readonly<{
      kind: "record_reference";
      fieldId: string;
      path: ValuePath;
      recordTypeId: string;
      recordId: string;
    }>
  | Readonly<{
      kind: "person_reference";
      fieldId: string;
      path: ValuePath;
      organizationAccountId: string;
      audience:
        | "organization_accounts"
        | "application_accounts"
        | "organization_identities_and_external_requesters";
      applicationRootIdRequired: boolean;
    }>
  | Readonly<{
      kind: "file_reference";
      fieldId: string;
      path: ValuePath;
      fileId: FileId;
    }>;

export type PrepareRecordFieldValuesV2Input = Readonly<{
  operation: "create" | "update";
  recordType: RecordTypeDefinitionV2;
  submittedValues: ValueMap;
  existingValues?: ValueMap;
  organizationCurrency?: string;
}>;

export type PrepareRecordFieldValuesV2Result =
  | Readonly<{
      success: true;
      setValues: Readonly<Record<string, JsonValue>>;
      clearFieldIds: readonly string[];
      pendingChecks: readonly RecordFieldValuePendingCheck[];
    }>
  | Readonly<{
      success: false;
      issues: readonly RecordFieldValuePreparationIssue[];
    }>;

export type RecordFieldValueRequirementV2 = Readonly<{
  fieldId: string;
  code: string;
  message: string;
}>;

type RecordFieldValueOriginV2 = "submitted" | "existing" | "default";

export type InitialRecordFieldCandidateV2 = Readonly<{
  operation: "create" | "update";
  recordTypeId: string;
  originalValues: ValueMap;
  candidateValues: Readonly<Record<string, JsonValue>>;
  valueOrigins: Readonly<Record<string, RecordFieldValueOriginV2>>;
  submittedFieldIds: readonly string[];
  submittedClearFieldIds: readonly string[];
}>;

export type PrepareInitialRecordFieldCandidateV2Result =
  | Readonly<{ success: true; candidate: InitialRecordFieldCandidateV2 }>
  | Readonly<{ success: false; issues: readonly RecordFieldValuePreparationIssue[] }>;

export type FinalizeRecordFieldCandidateV2Input = Readonly<{
  recordType: RecordTypeDefinitionV2;
  initialCandidate: InitialRecordFieldCandidateV2;
  candidateValues: ValueMap;
  requirements?: readonly RecordFieldValueRequirementV2[];
  /**
   * The generated fields that the invoking Record operation has produced.
   * Omitting this option preserves the public finalizer's full generated-field
   * requirement; a bounded engine can require only the generated kinds it owns.
   */
  requiredGeneratedFieldIds?: readonly string[];
  organizationCurrency?: string;
}>;

type PreparationContext = {
  readonly issues: RecordFieldValuePreparationIssue[];
  readonly pendingChecks: RecordFieldValuePendingCheck[];
  readonly organizationCurrency?: string;
};

type ValueOrigin = RecordFieldValueOriginV2 | "candidate";
type FieldPolicyMode = "structural" | "final";

export type PersistedRecordFieldValueInput =
  | Readonly<{
      validationContractVersion: "1.0.0";
      field: FieldDefinition;
      value: unknown;
    }>
  | Readonly<{
      validationContractVersion: "2.0.0";
      field: ModuleFieldV2;
      value: unknown;
    }>;

const generatedFieldTypes = new Set<ModuleFieldV2["type"]>([
  "reference_number",
  "calculation",
  "total",
]);

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const calculatedV1ValueMatches = (
  resultType: Extract<FieldDefinition, { type: "calculation" | "total" }>["settings"]["resultType"],
  value: unknown,
): boolean => {
  if (resultType === "whole_number") return Number.isInteger(value);
  if (resultType === "decimal_number" || resultType === "money") return finiteNumber(value);
  if (resultType === "yes_no") return typeof value === "boolean";
  if (resultType === "date") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (resultType === "date_time") return timestampSchema.safeParse(value).success;
  return typeof value === "string";
};

const decimalV1ValueMatches = (
  value: unknown,
  settings: Extract<FieldDefinition, { type: "decimal_number" }>["settings"],
): boolean => {
  if (!finiteNumber(value) || String(value).toLowerCase().includes("e")) return false;
  const [whole, fraction = ""] = String(Math.abs(value)).split(".");
  return (
    whole!.length <= settings.digitsBeforeDecimal &&
    fraction.length <= settings.decimalPlaces &&
    (settings.minimum === undefined || value >= settings.minimum) &&
    (settings.maximum === undefined || value <= settings.maximum)
  );
};

const persistedV1FieldValueMatches = (field: FieldDefinition, value: unknown): boolean => {
  if (field.type === "reference_number") return typeof value === "string";
  if (field.type === "calculation" || field.type === "total")
    return calculatedV1ValueMatches(field.settings.resultType, value);
  if (field.type === "attachment") {
    if (!Array.isArray(value) || !value.every((entry) => fileIdSchema.safeParse(entry).success))
      return false;
    return (
      (field.settings.multiple || value.length <= 1) &&
      (field.settings.maxFiles === undefined || value.length <= field.settings.maxFiles) &&
      (!field.required || value.length > 0)
    );
  }
  if (!fieldDefinitionSchema.safeParse({ ...field, default: value }).success) return false;
  switch (field.type) {
    case "text":
    case "long_text":
      return (value as string).length <= field.settings.maxLength;
    case "formatted_text":
      return (
        field.settings.maxLength === undefined ||
        (value as string).length <= field.settings.maxLength
      );
    case "whole_number":
      return (
        (field.settings.minimum === undefined || (value as number) >= field.settings.minimum) &&
        (field.settings.maximum === undefined || (value as number) <= field.settings.maximum) &&
        (field.settings.step === undefined ||
          ((value as number) - (field.settings.minimum ?? 0)) % field.settings.step === 0)
      );
    case "decimal_number":
      return decimalV1ValueMatches(value, field.settings);
    case "money":
      return (
        (field.settings.minimum === undefined || (value as number) >= field.settings.minimum) &&
        (field.settings.maximum === undefined || (value as number) <= field.settings.maximum)
      );
    case "date":
      return (
        (field.settings.earliest === undefined || (value as string) >= field.settings.earliest) &&
        (field.settings.latest === undefined || (value as string) <= field.settings.latest)
      );
    case "several_choices":
      return (
        field.settings.maximumSelections === undefined ||
        (value as string[]).length <= field.settings.maximumSelections
      );
    case "yes_no":
    case "date_time":
    case "choice":
    case "email_address":
    case "phone_number":
    case "web_address":
    case "table":
    case "link":
    case "link_to_one_of_several":
    case "link_to_person":
      return true;
  }
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isValueMap = (value: unknown): value is ValueMap =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const issue = (
  context: PreparationContext,
  code: RecordFieldValuePreparationIssueCode,
  path: ValuePath,
  fieldId?: string,
  requirement?: Readonly<{ code: string; message: string }>,
): undefined => {
  context.issues.push({
    code,
    ...(fieldId === undefined ? {} : { fieldId }),
    path,
    ...(requirement === undefined ? {} : { requirement }),
  });
  return undefined;
};

const valueRoot = (origin: ValueOrigin, fieldId: string): ValuePath =>
  origin === "default"
    ? ["recordType", "fields", fieldId, "default"]
    : [
        origin === "submitted"
          ? "submittedValues"
          : origin === "existing"
            ? "existingValues"
            : "candidateValues",
        fieldId,
      ];

const validateExactBounds = (
  value: string,
  settings: { minimum?: string | undefined; maximum?: string | undefined },
): boolean => {
  const parsed = parseExactDecimal(value);
  if (parsed === undefined) return false;
  return exactDecimalWithinBoundsV2(
    parsed,
    settings.minimum === undefined ? undefined : parseExactDecimal(settings.minimum),
    settings.maximum === undefined ? undefined : parseExactDecimal(settings.maximum),
  );
};

const syntheticFieldAcceptsDefault = (field: ModuleFieldV2, value: unknown): boolean =>
  moduleFieldV2Schema.safeParse({ ...field, default: value }).success;

const collectRichTextFileChecks = (
  value: Extract<JsonValue, { blocks?: unknown }>,
  fieldId: string,
  root: ValuePath,
  context: PreparationContext,
): void => {
  const blocks = (value as { blocks: Array<Record<string, unknown>> }).blocks;
  for (const [index, block] of blocks.entries())
    if (block.kind === "file")
      context.pendingChecks.push({
        kind: "file_reference",
        fieldId,
        path: [...root, "blocks", index, "fileId"],
        fileId: block.fileId as FileId,
      });
};

const collectChoicePermission = (
  fieldId: string,
  value: string,
  options: readonly { value: string; requiredPermissionId?: PermissionId | undefined }[],
  path: ValuePath,
  context: PreparationContext,
): void => {
  const option = options.find((candidate) => candidate.value === value);
  if (option?.requiredPermissionId !== undefined)
    context.pendingChecks.push({
      kind: "choice_permission",
      fieldId,
      path,
      permissionId: option.requiredPermissionId,
    });
};

const normalizeMoney = (
  field: Extract<ModuleFieldV2, { type: "money" }>,
  value: unknown,
  origin: ValueOrigin,
  path: ValuePath,
  context: PreparationContext,
  policy: FieldPolicyMode,
): JsonValue | undefined => {
  const invalidCode = origin === "existing" ? "invalid_existing_value" : "invalid_value";
  if (origin === "default" && policy === "structural") {
    const amount = exactDecimalTextV2Schema.safeParse(value);
    if (!amount.success) return issue(context, invalidCode, path, field.fieldId);
    const currency =
      field.settings.currencyMode === "fixed"
        ? field.settings.currency
        : context.organizationCurrency;
    if (currency === undefined)
      return issue(context, "organization_currency_required", path, field.fieldId);
    return { amount: amount.data, currency };
  }

  const parsed =
    origin === "submitted"
      ? sourceMoneyValueV2Schema.safeParse(value)
      : moneyValueV2Schema.safeParse(value);
  if (!parsed.success) return issue(context, invalidCode, path, field.fieldId);
  const amount = normalizeExactDecimal(parsed.data.amount);
  if (amount === undefined || (policy === "final" && !validateExactBounds(amount, field.settings)))
    return issue(context, invalidCode, path, field.fieldId);
  if (
    policy === "final" &&
    field.settings.currencyMode === "fixed" &&
    parsed.data.currency !== field.settings.currency
  )
    return issue(context, invalidCode, path, field.fieldId);
  return { amount, currency: parsed.data.currency };
};

type TableField = Extract<ModuleFieldV2, { type: "table" }>;
type TableColumn = TableField["settings"]["columns"][number];

const tableCellAccepts = (parent: TableField, column: TableColumn, value: unknown): boolean => {
  const candidate = {
    ...parent,
    type: column.type,
    settings: column.settings,
    default: value,
  };
  return moduleFieldV2Schema.safeParse(candidate).success;
};

const normalizeTableMoney = (
  parent: TableField,
  column: Extract<TableColumn, { type: "money" }>,
  value: unknown,
  origin: ValueOrigin,
  path: ValuePath,
  context: PreparationContext,
  policy: FieldPolicyMode,
): JsonValue | undefined => {
  const invalidCode = origin === "existing" ? "invalid_existing_value" : "invalid_value";
  let amount: string;
  let currency: string | undefined;
  if (origin === "default" && policy === "structural") {
    const parsed = exactDecimalTextV2Schema.safeParse(value);
    if (!parsed.success) return issue(context, invalidCode, path, parent.fieldId);
    amount = parsed.data;
    currency =
      column.settings.currencyMode === "fixed"
        ? column.settings.currency
        : context.organizationCurrency;
    if (currency === undefined)
      return issue(context, "organization_currency_required", path, parent.fieldId);
  } else {
    const parsed =
      origin === "submitted"
        ? sourceMoneyValueV2Schema.safeParse(value)
        : moneyValueV2Schema.safeParse(value);
    if (!parsed.success) return issue(context, invalidCode, path, parent.fieldId);
    const normalized = normalizeExactDecimal(parsed.data.amount);
    if (normalized === undefined) return issue(context, invalidCode, path, parent.fieldId);
    amount = normalized;
    currency = parsed.data.currency;
    if (
      policy === "final" &&
      column.settings.currencyMode === "fixed" &&
      currency !== column.settings.currency
    )
      return issue(context, invalidCode, path, parent.fieldId);
  }
  if (policy === "final" && !validateExactBounds(amount, column.settings))
    return issue(context, invalidCode, path, parent.fieldId);
  return { amount, currency: currency! };
};

const normalizeTable = (
  field: TableField,
  value: unknown,
  origin: ValueOrigin,
  path: ValuePath,
  context: PreparationContext,
  policy: FieldPolicyMode,
  collectPending: boolean,
): JsonValue | undefined => {
  const invalidCode = origin === "existing" ? "invalid_existing_value" : "invalid_value";
  let tableValue = value;
  if (policy === "structural" && origin !== "default") {
    const parsed =
      origin === "submitted"
        ? sourceModuleFieldValueV2Schemas.table.safeParse(value)
        : moduleFieldValueV2Schemas.table.safeParse(value);
    if (!parsed.success) return issue(context, invalidCode, path, field.fieldId);
    tableValue = parsed.data;
  }
  if (!Array.isArray(tableValue)) return issue(context, invalidCode, path, field.fieldId);
  if (
    policy === "final" &&
    (tableValue.length < field.settings.minimumRows ||
      tableValue.length > field.settings.maximumRows)
  )
    return issue(context, invalidCode, path, field.fieldId);

  const columns = new Map(field.settings.columns.map((column) => [column.key, column]));
  const result: Record<string, JsonValue>[] = [];
  let valid = true;
  for (const [rowIndex, candidate] of tableValue.entries()) {
    const rowPath = [...path, rowIndex];
    if (!isValueMap(candidate)) {
      issue(context, invalidCode, rowPath, field.fieldId);
      valid = false;
      continue;
    }
    const row: Record<string, JsonValue> = {};
    for (const key of Object.keys(candidate))
      if (!columns.has(key)) {
        if (policy === "final") {
          issue(context, invalidCode, [...rowPath, key], field.fieldId);
          valid = false;
        } else row[key] = candidate[key] as JsonValue;
      }
    for (const column of field.settings.columns) {
      const cellPath = [...rowPath, column.key];
      if (!hasOwn(candidate, column.key)) {
        if (policy === "final" && column.required) {
          issue(context, invalidCode, cellPath, field.fieldId);
          valid = false;
        }
        continue;
      }
      const raw = candidate[column.key];
      let normalized: JsonValue | undefined;
      if (column.type === "decimal_number") {
        const parsed =
          origin === "submitted"
            ? sourceExactDecimalTextV2Schema.safeParse(raw)
            : exactDecimalTextV2Schema.safeParse(raw);
        const decimal = parsed.success ? normalizeExactDecimal(parsed.data) : undefined;
        if (
          decimal === undefined ||
          (policy === "final" && !tableCellAccepts(field, column, decimal))
        )
          normalized = issue(context, invalidCode, cellPath, field.fieldId);
        else normalized = decimal;
      } else if (column.type === "money") {
        normalized = normalizeTableMoney(field, column, raw, origin, cellPath, context, policy);
      } else if (
        policy === "final"
          ? tableCellAccepts(field, column, raw)
          : moduleFieldValueV2Schemas[column.type].safeParse(raw).success
      ) {
        normalized = raw as JsonValue;
      } else normalized = issue(context, invalidCode, cellPath, field.fieldId);

      if (normalized === undefined) {
        valid = false;
        continue;
      }
      row[column.key] = normalized;
      if (collectPending && column.type === "choice")
        collectChoicePermission(
          field.fieldId,
          normalized as string,
          column.settings.options,
          cellPath,
          context,
        );
    }
    result.push(row);
  }
  return valid ? result : undefined;
};

const normalizeGeneratedExisting = (
  field: Extract<ModuleFieldV2, { type: "reference_number" | "calculation" | "total" }>,
  value: unknown,
): JsonValue | undefined => {
  const resultType =
    field.type === "reference_number" ? "reference_number" : field.settings.resultType;
  const parsed = moduleFieldValueV2Schemas[resultType].safeParse(value);
  if (!parsed.success) return undefined;
  if (
    field.type === "total" &&
    field.settings.resultType === "money" &&
    field.settings.currency !== undefined &&
    (parsed.data as { currency: string }).currency !== field.settings.currency
  )
    return undefined;
  return parsed.data as JsonValue;
};

const normalizeValue = (
  field: ModuleFieldV2,
  value: unknown,
  origin: ValueOrigin,
  context: PreparationContext,
  policy: FieldPolicyMode,
  collectPending: boolean,
): JsonValue | undefined => {
  const path = valueRoot(origin, field.fieldId);
  if (generatedFieldTypes.has(field.type)) {
    if (origin !== "existing") return issue(context, "generated_field_input", path, field.fieldId);
    const parsed = normalizeGeneratedExisting(
      field as Extract<ModuleFieldV2, { type: "reference_number" | "calculation" | "total" }>,
      value,
    );
    return parsed ?? issue(context, "invalid_existing_value", path, field.fieldId);
  }
  if (field.type === "money") return normalizeMoney(field, value, origin, path, context, policy);
  if (field.type === "table")
    return normalizeTable(field, value, origin, path, context, policy, collectPending);

  let candidate = value;
  if (field.type === "decimal_number") {
    const parsed =
      origin === "submitted"
        ? sourceExactDecimalTextV2Schema.safeParse(value)
        : exactDecimalTextV2Schema.safeParse(value);
    if (!parsed.success)
      return issue(
        context,
        origin === "existing" ? "invalid_existing_value" : "invalid_value",
        path,
        field.fieldId,
      );
    candidate = normalizeExactDecimal(parsed.data);
  }

  const leaf = moduleFieldValueV2Schemas[field.type].safeParse(candidate);
  const settingsValid =
    policy === "structural" ||
    field.type === "attachment" ||
    syntheticFieldAcceptsDefault(field, leaf.data);
  if (!leaf.success || !settingsValid)
    return issue(
      context,
      origin === "existing" ? "invalid_existing_value" : "invalid_value",
      path,
      field.fieldId,
    );
  const normalized = leaf.data as JsonValue;
  if (field.type === "attachment" && policy === "final") {
    const files = normalized as FileId[];
    if (
      (!field.settings.multiple && files.length > 1) ||
      (field.settings.maxFiles !== undefined && files.length > field.settings.maxFiles) ||
      (field.required && files.length === 0)
    )
      return issue(
        context,
        field.required && files.length === 0
          ? "required_attachment_empty"
          : origin === "existing"
            ? "invalid_existing_value"
            : "invalid_value",
        path,
        field.fieldId,
      );
  }
  switch (field.type) {
    case "choice":
      if (collectPending)
        collectChoicePermission(
          field.fieldId,
          normalized as string,
          field.settings.options,
          path,
          context,
        );
      break;
    case "several_choices":
      if (collectPending)
        for (const [index, selected] of (normalized as string[]).entries())
          collectChoicePermission(
            field.fieldId,
            selected,
            field.settings.options,
            [...path, index],
            context,
          );
      break;
    case "link":
    case "link_to_one_of_several": {
      const link = normalized as { recordTypeId: string; recordId: string };
      const targets = field.type === "link" ? [field.settings.target] : field.settings.targets;
      if (policy === "final" && targets.some((target) => target.state !== "resolved"))
        return issue(context, "unresolved_record_target", path, field.fieldId);
      if (
        policy === "final" &&
        !targets.some(
          (target) => target.state === "resolved" && target.recordTypeId === link.recordTypeId,
        )
      )
        return issue(context, "invalid_value", path, field.fieldId);
      if (collectPending)
        context.pendingChecks.push({
          kind: "record_reference",
          fieldId: field.fieldId,
          path,
          recordTypeId: link.recordTypeId,
          recordId: link.recordId,
        });
      break;
    }
    case "link_to_person": {
      const person = normalized as { organizationAccountId: string };
      if (collectPending)
        context.pendingChecks.push({
          kind: "person_reference",
          fieldId: field.fieldId,
          path,
          organizationAccountId: person.organizationAccountId,
          audience: field.settings.audience,
          applicationRootIdRequired: field.settings.applicationRootIdRequired,
        });
      break;
    }
    case "attachment": {
      const files = normalized as FileId[];
      if (collectPending)
        for (const [index, fileId] of files.entries())
          context.pendingChecks.push({
            kind: "file_reference",
            fieldId: field.fieldId,
            path: [...path, index],
            fileId,
          });
      break;
    }
    case "formatted_text":
      if (collectPending)
        collectRichTextFileChecks(
          normalized as Extract<JsonValue, { blocks?: unknown }>,
          field.fieldId,
          path,
          context,
        );
      break;
  }
  return normalized;
};

/**
 * Checks one value already stored in a record against its owning published field.
 * Reference existence, permissions, file eligibility and other current facts stay
 * with the protected caller; this operation checks only canonical value semantics.
 */
export const persistedRecordFieldValueMatches = (
  input: PersistedRecordFieldValueInput,
): boolean => {
  if (input.validationContractVersion === "1.0.0") {
    const field = fieldDefinitionSchema.safeParse(input.field);
    return field.success && persistedV1FieldValueMatches(field.data, input.value);
  }

  const field = moduleFieldV2Schema.safeParse(input.field);
  if (!field.success) return false;
  const context: PreparationContext = { issues: [], pendingChecks: [] };
  return normalizeValue(field.data, input.value, "existing", context, "final", true) !== undefined;
};

const preparationContext = (organizationCurrency: string | undefined): PreparationContext => ({
  issues: [],
  pendingChecks: [],
  ...(organizationCurrency === undefined ? {} : { organizationCurrency }),
});

/**
 * Builds the typed in-memory candidate used by trusted Record-owned engines.
 * This is not a request or authority boundary: field policies and requiredness
 * are deliberately applied by `finalizeRecordFieldCandidateV2` after rules and
 * owning generators have produced the final candidate.
 */
export const prepareInitialRecordFieldCandidateV2 = (
  input: PrepareRecordFieldValuesV2Input,
): PrepareInitialRecordFieldCandidateV2Result => {
  const trustedRecordType = recordTypeDefinitionV2Schema.parse(input.recordType);
  const context = preparationContext(input.organizationCurrency);
  if (!isValueMap(input.submittedValues)) issue(context, "invalid_input", ["submittedValues"]);
  if (input.operation === "update" && !isValueMap(input.existingValues))
    issue(context, "invalid_input", ["existingValues"]);
  if (
    input.organizationCurrency !== undefined &&
    !currencyCodeV2Schema.safeParse(input.organizationCurrency).success
  )
    issue(context, "invalid_input", ["organizationCurrency"]);
  if (context.issues.length > 0) return { success: false, issues: context.issues };

  const submittedValues = input.submittedValues;
  const existingValues = input.existingValues ?? {};
  const fieldsById = new Map<string, ModuleFieldV2>(
    trustedRecordType.fields.map((field) => [field.fieldId, field]),
  );
  const candidateValues: Record<string, JsonValue> = {};
  const valueOrigins: Record<string, RecordFieldValueOriginV2> = {};
  const submittedFieldIds: string[] = [];
  const submittedClearFieldIds: string[] = [];

  if (input.operation === "update") {
    for (const [fieldId, value] of Object.entries(existingValues)) {
      if (hasOwn(submittedValues, fieldId)) continue;
      const field = fieldsById.get(fieldId);
      if (field === undefined) {
        issue(context, "unknown_field", ["existingValues", fieldId], fieldId);
        continue;
      }
      if (value === null) {
        issue(context, "invalid_existing_value", ["existingValues", fieldId], fieldId);
        continue;
      }
      const normalized = normalizeValue(field, value, "existing", context, "structural", false);
      if (normalized !== undefined) {
        candidateValues[fieldId] = normalized;
        valueOrigins[fieldId] = "existing";
      }
    }
  }

  for (const [fieldId, value] of Object.entries(submittedValues)) {
    const field = fieldsById.get(fieldId);
    if (field === undefined) {
      issue(context, "unknown_field", ["submittedValues", fieldId], fieldId);
      continue;
    }
    if (generatedFieldTypes.has(field.type)) {
      issue(context, "generated_field_input", ["submittedValues", fieldId], fieldId);
      continue;
    }
    submittedFieldIds.push(fieldId);
    if (value === null) {
      submittedClearFieldIds.push(fieldId);
      continue;
    }
    const normalized = normalizeValue(field, value, "submitted", context, "structural", false);
    if (normalized !== undefined) {
      candidateValues[fieldId] = normalized;
      valueOrigins[fieldId] = "submitted";
    }
  }

  if (input.operation === "create")
    for (const field of trustedRecordType.fields) {
      if (hasOwn(submittedValues, field.fieldId) || field.default === undefined) continue;
      const normalized = normalizeValue(
        field,
        field.default,
        "default",
        context,
        "structural",
        false,
      );
      if (normalized !== undefined) {
        candidateValues[field.fieldId] = normalized;
        valueOrigins[field.fieldId] = "default";
      }
    }

  return context.issues.length > 0
    ? { success: false, issues: context.issues }
    : {
        success: true,
        candidate: {
          operation: input.operation,
          recordTypeId: trustedRecordType.recordTypeId,
          originalValues: input.operation === "update" ? structuredClone(existingValues) : {},
          candidateValues,
          valueOrigins,
          submittedFieldIds,
          submittedClearFieldIds,
        },
      };
};

/**
 * Applies the owning field policy to one final Record-owned candidate and
 * derives its write patch. The candidate may contain trusted rule/calculation/
 * total output; this function is not evidence of Access or database checks.
 */
const finalizeRecordFieldCandidateV2Internal = (
  input: FinalizeRecordFieldCandidateV2Input,
  requiredGeneratedFieldIds: ReadonlySet<string>,
): PrepareRecordFieldValuesV2Result => {
  const trustedRecordType = recordTypeDefinitionV2Schema.parse(input.recordType);
  const context = preparationContext(input.organizationCurrency);
  if (!isValueMap(input.candidateValues)) issue(context, "invalid_input", ["candidateValues"]);
  if (input.initialCandidate.recordTypeId !== trustedRecordType.recordTypeId)
    issue(context, "invalid_input", ["initialCandidate", "recordTypeId"]);
  if (
    input.organizationCurrency !== undefined &&
    !currencyCodeV2Schema.safeParse(input.organizationCurrency).success
  )
    issue(context, "invalid_input", ["organizationCurrency"]);
  if (context.issues.length > 0) return { success: false, issues: context.issues };

  const fieldsById = new Map<string, ModuleFieldV2>(
    trustedRecordType.fields.map((field) => [field.fieldId, field]),
  );
  for (const fieldId of requiredGeneratedFieldIds) {
    const field = fieldsById.get(fieldId);
    if (field === undefined || !generatedFieldTypes.has(field.type))
      issue(context, "invalid_input", ["requiredGeneratedFieldIds", fieldId], fieldId);
  }
  if (context.issues.length > 0) return { success: false, issues: context.issues };
  const submittedFieldIds = new Set(input.initialCandidate.submittedFieldIds);
  const normalizedCandidate: Record<string, JsonValue> = {};
  const changedFieldIds = new Set<string>();

  for (const [fieldId, value] of Object.entries(input.candidateValues)) {
    const field = fieldsById.get(fieldId);
    if (field === undefined) {
      issue(context, "unknown_field", ["candidateValues", fieldId], fieldId);
      continue;
    }
    if (value === null) {
      issue(context, "invalid_value", ["candidateValues", fieldId], fieldId);
      continue;
    }
    const changed =
      submittedFieldIds.has(fieldId) ||
      !hasOwn(input.initialCandidate.originalValues, fieldId) ||
      !isDeepStrictEqual(input.initialCandidate.originalValues[fieldId], value);
    if (changed) changedFieldIds.add(fieldId);

    if (generatedFieldTypes.has(field.type)) {
      const normalized = normalizeGeneratedExisting(
        field as Extract<ModuleFieldV2, { type: "reference_number" | "calculation" | "total" }>,
        value,
      );
      if (normalized === undefined)
        issue(context, "invalid_value", ["candidateValues", fieldId], fieldId);
      else normalizedCandidate[fieldId] = normalized;
      continue;
    }

    const initialValue = input.initialCandidate.candidateValues[fieldId];
    const unchangedFromInitial =
      hasOwn(input.initialCandidate.candidateValues, fieldId) &&
      isDeepStrictEqual(initialValue, value);
    const origin = unchangedFromInitial
      ? (input.initialCandidate.valueOrigins[fieldId] ?? "candidate")
      : "candidate";
    const normalized = normalizeValue(field, value, origin, context, "final", changed);
    if (normalized !== undefined) normalizedCandidate[fieldId] = normalized;
  }

  const submittedClears = new Set(input.initialCandidate.submittedClearFieldIds);
  for (const field of trustedRecordType.fields) {
    const present = hasOwn(normalizedCandidate, field.fieldId);
    if (submittedClears.has(field.fieldId) && field.required && !present)
      issue(context, "required_field_clear", ["submittedValues", field.fieldId], field.fieldId);
    if (
      field.required &&
      (requiredGeneratedFieldIds.has(field.fieldId) || !generatedFieldTypes.has(field.type)) &&
      !present
    )
      issue(
        context,
        "required_field_missing",
        ["recordType", "fields", field.fieldId],
        field.fieldId,
      );
  }

  for (const requirement of input.requirements ?? []) {
    if (!fieldsById.has(requirement.fieldId)) {
      issue(context, "unknown_field", ["requirements", requirement.fieldId], requirement.fieldId);
      continue;
    }
    if (!hasOwn(normalizedCandidate, requirement.fieldId))
      issue(
        context,
        "required_field_missing",
        ["candidateValues", requirement.fieldId],
        requirement.fieldId,
        { code: requirement.code, message: requirement.message },
      );
  }

  if (context.issues.length > 0) return { success: false, issues: context.issues };

  const setValues: Record<string, JsonValue> = {};
  for (const [fieldId, value] of Object.entries(normalizedCandidate))
    if (changedFieldIds.has(fieldId)) setValues[fieldId] = value;

  const clearFieldIds: string[] = [];
  const addClear = (fieldId: string) => {
    if (
      ((input.initialCandidate.operation === "update" &&
        input.initialCandidate.submittedClearFieldIds.includes(fieldId)) ||
        hasOwn(input.initialCandidate.originalValues, fieldId)) &&
      !hasOwn(normalizedCandidate, fieldId) &&
      !clearFieldIds.includes(fieldId)
    )
      clearFieldIds.push(fieldId);
  };
  input.initialCandidate.submittedClearFieldIds.forEach(addClear);
  Object.keys(input.initialCandidate.originalValues).forEach(addClear);

  return { success: true, setValues, clearFieldIds, pendingChecks: context.pendingChecks };
};

export const finalizeRecordFieldCandidateV2 = (
  input: FinalizeRecordFieldCandidateV2Input,
): PrepareRecordFieldValuesV2Result => {
  const requiredGeneratedFieldIds =
    input.requiredGeneratedFieldIds ??
    input.recordType.fields
      .filter((field) => generatedFieldTypes.has(field.type))
      .map((field) => field.fieldId);
  return finalizeRecordFieldCandidateV2Internal(input, new Set(requiredGeneratedFieldIds));
};

export const prepareRecordFieldValuesV2 = (
  input: PrepareRecordFieldValuesV2Input,
): PrepareRecordFieldValuesV2Result => {
  const initial = prepareInitialRecordFieldCandidateV2(input);
  if (!initial.success) return initial;
  return finalizeRecordFieldCandidateV2Internal(
    {
      recordType: input.recordType,
      initialCandidate: initial.candidate,
      candidateValues: initial.candidate.candidateValues,
      ...(input.organizationCurrency === undefined
        ? {}
        : { organizationCurrency: input.organizationCurrency }),
    },
    new Set(),
  );
};
