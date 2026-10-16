import { normalizeExactDecimal, type DefinitionCompilationOutput } from "../../schema";
import { fingerprintCanonicalValue } from "../canonical-json-definition";
import type { Resolution } from "./resolution";
import { applicationModuleKeysOf, asObject, fail, type JsonObject, objectFromUniqueEntries } from "./shared";

export type ModuleValueContext = Readonly<{
  field: (reference: string, alias?: string) => JsonObject | undefined;
  parameters?: ReadonlyMap<string, string>;
  resolution: Resolution;
}>;

export const normaliseExact = (value: unknown): unknown =>
  typeof value === "string" ? (normalizeExactDecimal(value) ?? value) : value;

export function normaliseMoney(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const money = value as JsonObject;
  return { ...money, amount: normaliseExact(money.amount) };
}

export function normaliseModuleFieldValue(
  field: JsonObject | undefined,
  value: unknown,
  context: ModuleValueContext,
  fieldDefault = false,
): unknown {
  if (!field) return value;
  switch (field.type) {
    case "decimal_number":
      return normaliseExact(value);
    case "money":
      return fieldDefault ? normaliseExact(value) : normaliseMoney(value);
    case "calculation":
    case "total": {
      const settings = asObject(field.settings);
      return normaliseModuleTypedValue(
        String(settings.result_type ?? settings.resultType),
        value,
        context,
      );
    }
    case "link":
    case "link_to_one_of_several": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const link = value as JsonObject;
      if (typeof link.record_type !== "string") return value;
      return {
        recordTypeId: context.resolution.recordType(link.record_type).recordTypeId,
        recordId: link.record_id,
      };
    }
    case "link_to_person": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const person = value as JsonObject;
      return "organization_account_id" in person
        ? { organizationAccountId: person.organization_account_id }
        : value;
    }
    case "table": {
      if (!Array.isArray(value)) return value;
      const settings = asObject(field.settings);
      const columns = (settings.columns as JsonObject[]) ?? [];
      const byKey = new Map(columns.map((column) => [String(column.key), column]));
      return value.map((row) =>
        objectFromUniqueEntries(
          Object.entries(asObject(row)).map(([key, cell]) => {
            const column = byKey.get(key);
            if (column?.type === "decimal_number") return [key, normaliseExact(cell)];
            if (column?.type === "money")
              return [key, fieldDefault ? normaliseExact(cell) : normaliseMoney(cell)];
            return [key, cell];
          }),
        ),
      );
    }
    default:
      return value;
  }
}

export function normaliseModuleTypedValue(
  declaration: JsonObject | string | undefined,
  value: unknown,
  context: ModuleValueContext,
): unknown {
  if (typeof declaration === "object" && declaration !== null)
    return normaliseModuleFieldValue(declaration, value, context);
  if (declaration === "decimal_number") return normaliseExact(value);
  if (declaration === "money") return normaliseMoney(value);
  if (declaration === "record_reference") {
    const link = asObject(value);
    if (typeof link.record_type === "string")
      return {
        recordTypeId: context.resolution.recordType(link.record_type).recordTypeId,
        recordId: link.record_id,
      };
  }
  return value;
}

function conditionDeclaration(
  operandValue: unknown,
  context: ModuleValueContext,
): JsonObject | string | undefined {
  const operand = asObject(operandValue);
  if (operand.source === "field") return context.field(String(operand.field));
  if (operand.source === "parameter") return context.parameters?.get(String(operand.parameter));
  return undefined;
}

export function condition(
  input: unknown,
  resolveField: (alias: string) => string,
  valueContext?: ModuleValueContext,
): unknown {
  const value = asObject(input);
  if ("all" in value)
    return {
      kind: "all",
      conditions: (value.all as unknown[]).map((entry) =>
        condition(entry, resolveField, valueContext),
      ),
    };
  if ("any" in value)
    return {
      kind: "any",
      conditions: (value.any as unknown[]).map((entry) =>
        condition(entry, resolveField, valueContext),
      ),
    };
  if ("not" in value)
    return { kind: "not", condition: condition(value.not, resolveField, valueContext) };
  const operator = String(value.operator);
  const authoredLeft = "left" in value ? value.left : { source: "field", field: value.field };
  const authoredRight =
    "right" in value
      ? value.right
      : "parameter" in value
        ? { source: "parameter", parameter: value.parameter }
        : { source: "value", value: value.value };
  const leftDeclaration = valueContext
    ? conditionDeclaration(authoredLeft, valueContext)
    : undefined;
  const rightDeclaration = valueContext
    ? conditionDeclaration(authoredRight, valueContext)
    : undefined;
  const operand = (
    inputOperand: unknown,
    declaration: JsonObject | string | undefined,
    side: "left" | "right",
  ) => {
    const source = asObject(inputOperand);
    if (source.source === "field")
      return { source: "field", fieldId: resolveField(String(source.field)) };
    if (source.source === "parameter")
      return { source: "parameter", key: String(source.parameter) };
    const authoredValue = source.value;
    const normalisedValue =
      valueContext &&
      Array.isArray(authoredValue) &&
      ((side === "right" && ["in", "not_in"].includes(operator)) ||
        (side === "left" && ["contains", "not_contains"].includes(operator)))
        ? authoredValue.map((entry) => normaliseModuleTypedValue(declaration, entry, valueContext))
        : valueContext
          ? normaliseModuleTypedValue(declaration, authoredValue, valueContext)
          : authoredValue;
    return {
      source: "value",
      value: normalisedValue,
    };
  };
  const hasExplicitOperands = "left" in value;
  return {
    kind: "comparison",
    operator,
    left: hasExplicitOperands
      ? operand(authoredLeft, rightDeclaration, "left")
      : { source: "field", fieldId: resolveField(String(value.field)) },
    ...(!["is_empty", "is_not_empty"].includes(operator)
      ? {
          right: operand(authoredRight, leftDeclaration, "right"),
        }
      : {}),
  };
}

export function qualifiedField(resolution: Resolution, reference: string): string {
  const separator = reference.lastIndexOf(".");
  if (separator < 1) fail("vortex.definition.qualified_field_required", "unresolved_reference");
  return resolution.field(reference.slice(0, separator), reference.slice(separator + 1));
}

/**
 * One action task value in canonical form. References pass through unchanged; a `json` literal is
 * normalised to its target field's canonical value, as a field default is, so a link literal's
 * record type alias resolves to its identity and exact numbers and money take one form.
 */
export function actionTaskValue(
  value: unknown,
  targetField: JsonObject | undefined,
  valueContext: ModuleValueContext | undefined,
): unknown {
  if (valueContext === undefined) return value;
  const entry = asObject(value);
  if (entry.kind !== "literal") return value;
  const literal = asObject(entry.literal);
  if (literal.type !== "json") return value;
  return {
    ...entry,
    literal: {
      ...literal,
      value: normaliseModuleFieldValue(targetField, literal.value, valueContext),
    },
  };
}

/** Module-owned inputs carry exact decimal and money bounds; Application action inputs keep theirs. */
export function actionInput(
  input: JsonObject,
  resolution: Resolution,
  moduleOwned = false,
): unknown {
  const validation = input.validation ? asObject(input.validation) : undefined;
  const compiledValidation = validation
    ? input.type === "text"
      ? {
          ...(validation.minimum_length !== undefined
            ? { minimumLength: validation.minimum_length }
            : {}),
          ...(validation.maximum_length !== undefined
            ? { maximumLength: validation.maximum_length }
            : {}),
          ...(validation.pattern !== undefined ? { pattern: validation.pattern } : {}),
        }
      : input.type === "formatted_text"
        ? {
            allowedBlocks: validation.allowed_blocks,
            ...(validation.maximum_length !== undefined
              ? { maximumLength: validation.maximum_length }
              : {}),
          }
        : moduleOwned && (input.type === "decimal_number" || input.type === "money")
          ? {
              ...(validation.minimum !== undefined
                ? { minimum: normaliseExact(validation.minimum) }
                : {}),
              ...(validation.maximum !== undefined
                ? { maximum: normaliseExact(validation.maximum) }
                : {}),
            }
          : validation
    : undefined;
  return {
    key: input.key,
    label: input.label,
    required: input.required,
    type:
      input.type === "organisation_account_reference"
        ? "organization_account_reference"
        : input.type,
    ...(compiledValidation ? { validation: compiledValidation } : {}),
    ...(input.record_types
      ? {
          recordTypes: (input.record_types as string[]).map((key) => resolution.recordType(key)),
        }
      : {}),
  };
}

type ApplicationRecordValuePair = Readonly<{
  record: JsonObject;
}>;

type ApplicationActionValuePair = Readonly<{
  action: JsonObject;
}>;

export type ApplicationModuleValueIndex = Readonly<{
  record: (reference: string) => ApplicationRecordValuePair | undefined;
  recordById: (recordTypeId: string) => ApplicationRecordValuePair | undefined;
  fieldId: (recordTypeId: string, alias: string) => string | undefined;
  fieldById: (fieldId: string) => Readonly<{ field: JsonObject }> | undefined;
  action: (key: string) => ApplicationActionValuePair | undefined;
  /** The identity of a bound Module's query, from "module_key:query_key"; refused when unknown. */
  query: (reference: string) => string;
  context: (defaultRecordReference?: string) => ModuleValueContext;
  contextForRecordId: (recordTypeId: string) => ModuleValueContext;
}>;

export function applicationModuleValueIndex(
  source: JsonObject,
  resolution: Resolution,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): ApplicationModuleValueIndex {
  const body = asObject(source.body);
  const recordsById = new Map<string, ApplicationRecordValuePair>();
  const fieldsById = new Map<string, { field: JsonObject }>();
  const actionsByKey = new Map<string, ApplicationActionValuePair>();
  const queryIdsByReference = new Map<string, string>();
  for (const moduleKey of applicationModuleKeysOf(body)) {
    const expected = resolution.definition(moduleKey, "module");
    const candidates = dependencyOutputs.filter(
      (candidate) => candidate.kind === "module" && candidate.artifact.definitionKey === moduleKey,
    );
    const matches = candidates.filter(
      (candidate) =>
        candidate.artifact.rootId === expected.rootId &&
        candidate.artifact.exactVersion === expected.exactVersion &&
        candidate.artifact.resolutionFingerprint === candidate.resolutionFingerprint,
    );
    if (candidates.length === 0) continue;
    if (matches.length !== 1)
      fail("vortex.definition.application_dependency_manifest", "broken_reference");
    const output = matches[0]!;
    const canonical = asObject(output.canonical);
    const envelope = asObject(canonical.envelope);
    const content = asObject(canonical.content);
    if (
      envelope.rootId !== expected.rootId ||
      envelope.key !== moduleKey ||
      output.artifact.contentFingerprint !== fingerprintCanonicalValue(content)
    )
      fail("vortex.definition.application_dependency_manifest", "broken_reference");
    for (const record of content.recordTypes as JsonObject[]) {
      const recordTypeId = String(record.recordTypeId);
      if (recordsById.has(recordTypeId))
        fail("vortex.definition.application_dependency_manifest", "broken_reference");
      recordsById.set(recordTypeId, { record });
      for (const field of record.fields as JsonObject[]) {
        const fieldId = String(field.fieldId);
        if (fieldsById.has(fieldId))
          fail("vortex.definition.application_dependency_manifest", "broken_reference");
        fieldsById.set(fieldId, { field });
      }
    }
    for (const action of content.actions as JsonObject[]) {
      const key = String(action.key);
      if (actionsByKey.has(key))
        fail("vortex.definition.application_dependency_manifest", "broken_reference");
      actionsByKey.set(key, { action });
    }
    // `queries` defaults to empty, so stored canonical content may omit it.
    for (const query of (content.queries ?? []) as JsonObject[])
      queryIdsByReference.set(`${moduleKey}:${String(query.key)}`, String(query.queryId));
  }
  const record = (reference: string) => {
    const recordTypeId = String(resolution.recordType(reference).recordTypeId);
    return recordsById.get(recordTypeId);
  };
  const fieldIdForRecord = (recordTypeId: string, alias: string) => {
    const pair = recordsById.get(recordTypeId);
    const matches = pair
      ? (pair.record.fields as JsonObject[]).filter((field) => field.key === alias)
      : [];
    return matches.length === 1 ? String(matches[0]!.fieldId) : undefined;
  };
  const valueContext = (
    defaultRecordReference?: string,
    defaultRecordTypeId?: string,
  ): ModuleValueContext => ({
    resolution,
    field: (reference, alias) => {
      const fieldId =
        alias !== undefined
          ? resolution.field(reference, alias)
          : reference.includes(".")
            ? qualifiedField(resolution, reference)
            : defaultRecordReference !== undefined
              ? resolution.field(defaultRecordReference, reference)
              : defaultRecordTypeId !== undefined
                ? fieldIdForRecord(defaultRecordTypeId, reference)
                : undefined;
      if (fieldId === undefined) return undefined;
      return fieldsById.get(fieldId)?.field;
    },
  });
  return {
    record,
    recordById: (recordTypeId) => recordsById.get(recordTypeId),
    fieldId: fieldIdForRecord,
    fieldById: (fieldId) => fieldsById.get(fieldId),
    action: (key) => actionsByKey.get(key),
    query: (reference) => {
      const queryId = queryIdsByReference.get(reference);
      if (queryId === undefined)
        fail(
          "vortex.definition.application_page_query",
          "unresolved_reference",
          resolution.location("query", reference),
        );
      return queryId;
    },
    context: (defaultRecordReference) => valueContext(defaultRecordReference),
    contextForRecordId: (recordTypeId) => valueContext(undefined, recordTypeId),
  };
}
