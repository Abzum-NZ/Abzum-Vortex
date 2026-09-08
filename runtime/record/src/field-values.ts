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

type PreparationContext = {
  readonly issues: RecordFieldValuePreparationIssue[];
  readonly pendingChecks: RecordFieldValuePendingCheck[];
  readonly organizationCurrency?: string;
};

type ValueOrigin = "submitted" | "existing" | "default";

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
): undefined => {
  context.issues.push({ code, ...(fieldId === undefined ? {} : { fieldId }), path });
  return undefined;
};

const valueRoot = (origin: ValueOrigin, fieldId: string): ValuePath =>
  origin === "default"
    ? ["recordType", "fields", fieldId, "default"]
    : [origin === "submitted" ? "submittedValues" : "existingValues", fieldId];

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
): JsonValue | undefined => {
  const invalidCode = origin === "existing" ? "invalid_existing_value" : "invalid_value";
  if (origin === "default") {
    const amount = exactDecimalTextV2Schema.safeParse(value);
    if (!amount.success || !validateExactBounds(amount.data, field.settings))
      return issue(context, invalidCode, path, field.fieldId);
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
  if (amount === undefined || !validateExactBounds(amount, field.settings))
    return issue(context, invalidCode, path, field.fieldId);
  if (field.settings.currencyMode === "fixed" && parsed.data.currency !== field.settings.currency)
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
): JsonValue | undefined => {
  const invalidCode = origin === "existing" ? "invalid_existing_value" : "invalid_value";
  let amount: string;
  let currency: string | undefined;
  if (origin === "default") {
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
    if (column.settings.currencyMode === "fixed" && currency !== column.settings.currency)
      return issue(context, invalidCode, path, parent.fieldId);
  }
  if (!validateExactBounds(amount, column.settings))
    return issue(context, invalidCode, path, parent.fieldId);
  return { amount, currency: currency! };
};

const normalizeTable = (
  field: TableField,
  value: unknown,
  origin: ValueOrigin,
  path: ValuePath,
  context: PreparationContext,
  collectPending: boolean,
): JsonValue | undefined => {
  const invalidCode = origin === "existing" ? "invalid_existing_value" : "invalid_value";
  if (!Array.isArray(value)) return issue(context, invalidCode, path, field.fieldId);
  if (value.length < field.settings.minimumRows || value.length > field.settings.maximumRows)
    return issue(context, invalidCode, path, field.fieldId);

  const columns = new Map(field.settings.columns.map((column) => [column.key, column]));
  const result: Record<string, JsonValue>[] = [];
  let valid = true;
  for (const [rowIndex, candidate] of value.entries()) {
    const rowPath = [...path, rowIndex];
    if (!isValueMap(candidate)) {
      issue(context, invalidCode, rowPath, field.fieldId);
      valid = false;
      continue;
    }
    const row: Record<string, JsonValue> = {};
    for (const key of Object.keys(candidate))
      if (!columns.has(key)) {
        issue(context, invalidCode, [...rowPath, key], field.fieldId);
        valid = false;
      }
    for (const column of field.settings.columns) {
      const cellPath = [...rowPath, column.key];
      if (!hasOwn(candidate, column.key)) {
        if (column.required) {
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
        if (decimal === undefined || !tableCellAccepts(field, column, decimal))
          normalized = issue(context, invalidCode, cellPath, field.fieldId);
        else normalized = decimal;
      } else if (column.type === "money") {
        normalized = normalizeTableMoney(field, column, raw, origin, cellPath, context);
      } else if (tableCellAccepts(field, column, raw)) {
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
  if (field.type === "money") return normalizeMoney(field, value, origin, path, context);
  if (field.type === "table")
    return normalizeTable(field, value, origin, path, context, collectPending);

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
    field.type === "attachment" || syntheticFieldAcceptsDefault(field, leaf.data);
  if (!leaf.success || !settingsValid)
    return issue(
      context,
      origin === "existing" ? "invalid_existing_value" : "invalid_value",
      path,
      field.fieldId,
    );
  const normalized = leaf.data as JsonValue;
  if (field.type === "attachment") {
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
  if (!collectPending) return normalized;

  switch (field.type) {
    case "choice":
      collectChoicePermission(
        field.fieldId,
        normalized as string,
        field.settings.options,
        path,
        context,
      );
      break;
    case "several_choices":
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
      if (targets.some((target) => target.state !== "resolved"))
        return issue(context, "unresolved_record_target", path, field.fieldId);
      if (
        !targets.some(
          (target) => target.state === "resolved" && target.recordTypeId === link.recordTypeId,
        )
      )
        return issue(context, "invalid_value", path, field.fieldId);
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
  return normalizeValue(field.data, input.value, "existing", context, true) !== undefined;
};

export const prepareRecordFieldValuesV2 = (
  input: PrepareRecordFieldValuesV2Input,
): PrepareRecordFieldValuesV2Result => {
  const trustedRecordType = recordTypeDefinitionV2Schema.parse(input.recordType);
  const issues: RecordFieldValuePreparationIssue[] = [];
  const pendingChecks: RecordFieldValuePendingCheck[] = [];
  const context: PreparationContext = {
    issues,
    pendingChecks,
    ...(input.organizationCurrency === undefined
      ? {}
      : { organizationCurrency: input.organizationCurrency }),
  };
  if (!isValueMap(input.submittedValues)) issue(context, "invalid_input", ["submittedValues"]);
  if (input.operation === "update" && !isValueMap(input.existingValues))
    issue(context, "invalid_input", ["existingValues"]);
  if (
    input.organizationCurrency !== undefined &&
    !currencyCodeV2Schema.safeParse(input.organizationCurrency).success
  )
    issue(context, "invalid_input", ["organizationCurrency"]);
  if (issues.length > 0) return { success: false, issues };

  const submittedValues = input.submittedValues;
  const existingValues = input.existingValues ?? {};
  const fieldsById = new Map<string, ModuleFieldV2>(
    trustedRecordType.fields.map((field) => [field.fieldId, field]),
  );
  const setValues: Record<string, JsonValue> = {};
  const clearFieldIds: string[] = [];
  const present = new Set<string>();

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
      if (normalizeValue(field, value, "existing", context, false) !== undefined)
        present.add(fieldId);
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
    if (value === null) {
      present.delete(fieldId);
      if (field.required)
        issue(context, "required_field_clear", ["submittedValues", fieldId], fieldId);
      else if (input.operation === "update") clearFieldIds.push(fieldId);
      continue;
    }
    const normalized = normalizeValue(field, value, "submitted", context, true);
    if (normalized !== undefined) {
      setValues[fieldId] = normalized;
      present.add(fieldId);
    }
  }

  if (input.operation === "create")
    for (const field of trustedRecordType.fields) {
      if (hasOwn(submittedValues, field.fieldId) || field.default === undefined) continue;
      const normalized = normalizeValue(field, field.default, "default", context, true);
      if (normalized !== undefined) {
        setValues[field.fieldId] = normalized;
        present.add(field.fieldId);
      }
    }

  for (const field of trustedRecordType.fields)
    if (field.required && !generatedFieldTypes.has(field.type) && !present.has(field.fieldId))
      issue(
        context,
        "required_field_missing",
        ["recordType", "fields", field.fieldId],
        field.fieldId,
      );

  return issues.length > 0
    ? { success: false, issues }
    : { success: true, setValues, clearFieldIds, pendingChecks };
};
