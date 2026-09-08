import {
  currencyCodeV2Schema,
  moduleSourceDocumentV1Schema,
  moduleSourceDocumentV2Schema,
  normalizeExactDecimal,
  platformIdSchema,
  type ModuleSourceDocumentV1,
  type ModuleSourceDocumentV2,
} from "@vortex/contracts";

export type ModuleDraftConversionPath = readonly (string | number)[];

export type ModuleDraftConversionResolution =
  | Readonly<{
      kind: "polymorphic_record_target";
      path: ModuleDraftConversionPath;
      recordType: string;
    }>
  | Readonly<{
      kind: "organisation_default_money_currency";
      path: ModuleDraftConversionPath;
      currency: string;
    }>;

export type ModuleDraftConversionDiagnosticCode =
  | "invalid_v1_source"
  | "missing_table_column_settings"
  | "missing_polymorphic_record_target"
  | "invalid_polymorphic_record_target"
  | "missing_money_currency"
  | "invalid_money_currency"
  | "invalid_value"
  | "external_field_context_unavailable"
  | "duplicate_resolution"
  | "unrecognized_resolution"
  | "invalid_v2_source";

export type ModuleDraftConversionDiagnostic = Readonly<{
  code: ModuleDraftConversionDiagnosticCode;
  path: ModuleDraftConversionPath;
  message: string;
}>;

export type ModuleDraftConversionResult =
  | Readonly<{ success: true; source: ModuleSourceDocumentV2 }>
  | Readonly<{ success: false; diagnostics: readonly ModuleDraftConversionDiagnostic[] }>;

type SourceRecordType = ModuleSourceDocumentV1["body"]["record_types"][number];
type SourceField = SourceRecordType["fields"][number];
type ValueMode = "definition_default" | "record_value";

const pathKey = (path: ModuleDraftConversionPath) => JSON.stringify(path);
const append = (path: ModuleDraftConversionPath, ...entries: (string | number)[]) => [
  ...path,
  ...entries,
];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const numberToExactText = (value: unknown): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (Object.is(value, -0)) return "0";
  const text = value.toString().toLowerCase();
  if (!text.includes("e")) return normalizeExactDecimal(text);

  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(text);
  if (!match) return undefined;
  const sign = match[1]!;
  const integer = match[2]!;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4]);
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  const expanded =
    decimalIndex <= 0
      ? `${sign}0.${"0".repeat(-decimalIndex)}${digits}`
      : decimalIndex >= digits.length
        ? `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`
        : `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return normalizeExactDecimal(expanded);
};

class ConversionContext {
  readonly diagnostics: ModuleDraftConversionDiagnostic[] = [];
  private readonly resolutions = new Map<string, ModuleDraftConversionResolution>();
  private readonly consumed = new Set<string>();

  constructor(resolutions: readonly ModuleDraftConversionResolution[]) {
    resolutions.forEach((resolution) => {
      const key = `${resolution.kind}:${pathKey(resolution.path)}`;
      if (this.resolutions.has(key)) {
        this.add(
          "duplicate_resolution",
          resolution.path,
          "A conversion path may have only one resolution of each kind",
        );
      } else {
        this.resolutions.set(key, resolution);
      }
    });
  }

  add(code: ModuleDraftConversionDiagnosticCode, path: ModuleDraftConversionPath, message: string) {
    this.diagnostics.push({ code, path: [...path], message });
  }

  polymorphicTarget(path: ModuleDraftConversionPath, allowedTargets: readonly string[]): string {
    const key = `polymorphic_record_target:${pathKey(path)}`;
    const resolution = this.resolutions.get(key);
    if (!resolution || resolution.kind !== "polymorphic_record_target") {
      this.add(
        "missing_polymorphic_record_target",
        path,
        "A legacy polymorphic record identifier requires one explicit allowed target",
      );
      return allowedTargets[0] ?? "invalid:target";
    }
    this.consumed.add(key);
    if (!allowedTargets.includes(resolution.recordType)) {
      this.add(
        "invalid_polymorphic_record_target",
        path,
        "The selected record type must be one target declared by the field",
      );
      return allowedTargets[0] ?? "invalid:target";
    }
    return resolution.recordType;
  }

  moneyCurrency(path: ModuleDraftConversionPath): string {
    const key = `organisation_default_money_currency:${pathKey(path)}`;
    const resolution = this.resolutions.get(key);
    if (!resolution || resolution.kind !== "organisation_default_money_currency") {
      this.add(
        "missing_money_currency",
        path,
        "A legacy organisation-default money record value requires an explicit currency",
      );
      return "ZZZ";
    }
    this.consumed.add(key);
    if (!currencyCodeV2Schema.safeParse(resolution.currency).success) {
      this.add("invalid_money_currency", path, "Currency must be an uppercase three-letter code");
      return "ZZZ";
    }
    return resolution.currency;
  }

  finishResolutions() {
    for (const [key, resolution] of this.resolutions)
      if (!this.consumed.has(key))
        this.add(
          "unrecognized_resolution",
          resolution.path,
          "The resolution path is not a recognized ambiguous value in this source",
        );
  }
}

const invalidValue = (
  context: ConversionContext,
  path: ModuleDraftConversionPath,
  description: string,
) => {
  context.add("invalid_value", path, description);
  return null;
};

const exactValue = (
  value: unknown,
  path: ModuleDraftConversionPath,
  context: ConversionContext,
): string | null =>
  numberToExactText(value) ??
  invalidValue(context, path, "The legacy value must be a finite number to convert exactly");

const richTextValue = (
  value: unknown,
  path: ModuleDraftConversionPath,
  context: ConversionContext,
) =>
  typeof value === "string"
    ? {
        blocks: [
          { kind: "paragraph" as const, children: [{ kind: "text" as const, text: value }] },
        ],
      }
    : invalidValue(context, path, "The legacy formatted value must be plain text");

const fieldSemanticType = (field: SourceField): SourceField["type"] | string =>
  field.type === "calculation" || field.type === "total" ? field.settings.result_type : field.type;

const fixedMoneyCurrency = (field: SourceField): string | undefined => {
  if (field.type === "money" && field.settings.currency_mode === "fixed")
    return field.settings.currency;
  if (field.type === "total" && field.settings.result_type === "money")
    return field.settings.currency;
  return undefined;
};

const recordTarget = (
  field: SourceField,
  path: ModuleDraftConversionPath,
  context: ConversionContext,
): string | undefined => {
  if (field.type === "link") return field.settings.target;
  if (field.type === "link_to_one_of_several")
    return context.polymorphicTarget(path, field.settings.targets);
  return undefined;
};

const convertTableRows = (
  value: unknown,
  field: Extract<SourceField, { type: "table" }>,
  path: ModuleDraftConversionPath,
  context: ConversionContext,
  mode: ValueMode,
): unknown => {
  if (!Array.isArray(value))
    return invalidValue(context, path, "The legacy table value must be an array of rows");
  return value.map((row, rowIndex) => {
    if (!isRecord(row))
      return invalidValue(context, append(path, rowIndex), "A legacy table row must be an object");
    const converted: Record<string, unknown> = { ...row };
    for (const [columnIndex, column] of field.settings.columns.entries()) {
      if (!("settings" in column)) continue;
      if (!Object.prototype.hasOwnProperty.call(row, column.key)) continue;
      const cellPath = append(path, rowIndex, column.key);
      const cell = row[column.key];
      if (column.type === "decimal_number")
        converted[column.key] = exactValue(cell, cellPath, context);
      if (column.type === "money") {
        const amount = exactValue(cell, cellPath, context);
        if (mode === "definition_default") converted[column.key] = amount;
        else {
          const currency =
            column.settings.currency_mode === "fixed"
              ? column.settings.currency!
              : context.moneyCurrency(cellPath);
          converted[column.key] = { amount, currency };
        }
      }
      void columnIndex;
    }
    return converted;
  });
};

const convertFieldValue = (
  value: unknown,
  field: SourceField,
  path: ModuleDraftConversionPath,
  context: ConversionContext,
  mode: ValueMode,
): unknown => {
  if (value === null) return null;
  const semanticType = fieldSemanticType(field);
  if (semanticType === "decimal_number") return exactValue(value, path, context);
  if (semanticType === "money") {
    const amount = exactValue(value, path, context);
    if (mode === "definition_default") return amount;
    return { amount, currency: fixedMoneyCurrency(field) ?? context.moneyCurrency(path) };
  }
  if (semanticType === "formatted_text") return richTextValue(value, path, context);
  if (semanticType === "link" || semanticType === "link_to_one_of_several") {
    if (typeof value !== "string" || !platformIdSchema.safeParse(value).success)
      return invalidValue(context, path, "The legacy record link value must be a platform ID");
    const target = recordTarget(field, path, context);
    return target === undefined
      ? invalidValue(context, path, "The declared field does not provide a record target")
      : { record_type: target, record_id: value };
  }
  if (semanticType === "link_to_person") {
    if (typeof value !== "string" || !platformIdSchema.safeParse(value).success)
      return invalidValue(context, path, "The legacy person link value must be an account ID");
    return { organization_account_id: value };
  }
  if (semanticType === "attachment") {
    if (typeof value === "string" && platformIdSchema.safeParse(value).success) return [value];
    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string" && platformIdSchema.safeParse(entry).success)
    )
      return [...value];
    return invalidValue(context, path, "An attachment value must contain ordered file IDs");
  }
  if (field.type === "table") return convertTableRows(value, field, path, context, mode);
  return value;
};

const convertConditionLiteral = (
  value: unknown,
  field: SourceField,
  operator: unknown,
  path: ModuleDraftConversionPath,
  context: ConversionContext,
): unknown => {
  if (
    Array.isArray(value) &&
    ["in", "not_in", "contains", "not_contains"].includes(String(operator)) &&
    !["several_choices", "table", "attachment"].includes(fieldSemanticType(field))
  )
    return value.map((entry, index) =>
      convertFieldValue(entry, field, append(path, index), context, "record_value"),
    );
  return convertFieldValue(value, field, path, context, "record_value");
};

const convertCondition = (
  condition: unknown,
  fieldsByKey: ReadonlyMap<string, SourceField>,
  path: ModuleDraftConversionPath,
  context: ConversionContext,
): unknown => {
  if (!isRecord(condition)) return condition;
  if (Array.isArray(condition.all))
    return {
      all: condition.all.map((child, index) =>
        convertCondition(child, fieldsByKey, append(path, "all", index), context),
      ),
    };
  if (Array.isArray(condition.any))
    return {
      any: condition.any.map((child, index) =>
        convertCondition(child, fieldsByKey, append(path, "any", index), context),
      ),
    };
  if (condition.not !== undefined)
    return { not: convertCondition(condition.not, fieldsByKey, append(path, "not"), context) };

  const converted: Record<string, unknown> = { ...condition };
  if (typeof condition.field === "string" && condition.value !== undefined) {
    const field = fieldsByKey.get(condition.field);
    if (field)
      converted.value = convertConditionLiteral(
        condition.value,
        field,
        condition.operator,
        append(path, "value"),
        context,
      );
    return converted;
  }

  const left = isRecord(condition.left) ? condition.left : undefined;
  const right = isRecord(condition.right) ? condition.right : undefined;
  const leftField =
    left?.source === "field" && typeof left.field === "string"
      ? fieldsByKey.get(left.field)
      : undefined;
  const rightField =
    right?.source === "field" && typeof right.field === "string"
      ? fieldsByKey.get(right.field)
      : undefined;
  if (left?.source === "value" && rightField)
    converted.left = {
      ...left,
      value: convertConditionLiteral(
        left.value,
        rightField,
        condition.operator,
        append(path, "left", "value"),
        context,
      ),
    };
  if (right?.source === "value" && leftField)
    converted.right = {
      ...right,
      value: convertConditionLiteral(
        right.value,
        leftField,
        condition.operator,
        append(path, "right", "value"),
        context,
      ),
    };
  return converted;
};

const conditionContainsLiteral = (condition: unknown): boolean => {
  if (!isRecord(condition)) return false;
  if (condition.value !== undefined) return true;
  if (isRecord(condition.left) && condition.left.source === "value") return true;
  if (isRecord(condition.right) && condition.right.source === "value") return true;
  if (Array.isArray(condition.all)) return condition.all.some(conditionContainsLiteral);
  if (Array.isArray(condition.any)) return condition.any.some(conditionContainsLiteral);
  return condition.not !== undefined && conditionContainsLiteral(condition.not);
};

const convertNumericOperand = (
  operand: Readonly<Record<string, unknown>>,
  path: ModuleDraftConversionPath,
  context: ConversionContext,
) =>
  operand.source === "literal"
    ? { ...operand, value: exactValue(operand.value, append(path, "value"), context) }
    : operand;

const convertField = (
  field: SourceField,
  fieldPath: ModuleDraftConversionPath,
  fieldsByKey: ReadonlyMap<string, SourceField>,
  totalFilterFields: ReadonlyMap<string, SourceField> | undefined,
  context: ConversionContext,
): unknown => {
  const converted: Record<string, unknown> = { ...field, settings: field.settings };
  if (field.type === "decimal_number")
    converted.settings = {
      ...field.settings,
      ...(field.settings.minimum === undefined
        ? {}
        : {
            minimum: exactValue(
              field.settings.minimum,
              append(fieldPath, "settings", "minimum"),
              context,
            ),
          }),
      ...(field.settings.maximum === undefined
        ? {}
        : {
            maximum: exactValue(
              field.settings.maximum,
              append(fieldPath, "settings", "maximum"),
              context,
            ),
          }),
    };
  if (field.type === "money")
    converted.settings = {
      ...field.settings,
      ...(field.settings.minimum === undefined
        ? {}
        : {
            minimum: exactValue(
              field.settings.minimum,
              append(fieldPath, "settings", "minimum"),
              context,
            ),
          }),
      ...(field.settings.maximum === undefined
        ? {}
        : {
            maximum: exactValue(
              field.settings.maximum,
              append(fieldPath, "settings", "maximum"),
              context,
            ),
          }),
    };
  if (field.type === "table")
    converted.settings = {
      ...field.settings,
      columns: field.settings.columns.map((column, index) => {
        const columnPath = append(fieldPath, "settings", "columns", index);
        if (!("settings" in column)) {
          context.add(
            "missing_table_column_settings",
            columnPath,
            "Every V2 table column requires typed settings",
          );
          return column;
        }
        if (column.type !== "decimal_number" && column.type !== "money") return column;
        return {
          ...column,
          settings: {
            ...column.settings,
            ...(column.settings.minimum === undefined
              ? {}
              : {
                  minimum: exactValue(
                    column.settings.minimum,
                    append(columnPath, "settings", "minimum"),
                    context,
                  ),
                }),
            ...(column.settings.maximum === undefined
              ? {}
              : {
                  maximum: exactValue(
                    column.settings.maximum,
                    append(columnPath, "settings", "maximum"),
                    context,
                  ),
                }),
          },
        };
      }),
    };
  if (field.type === "calculation") {
    const expression = field.settings.expression;
    let convertedExpression: unknown = expression;
    if (expression.operation === "numeric")
      convertedExpression = {
        ...expression,
        operands: expression.operands.map((operand, index) =>
          convertNumericOperand(
            operand,
            append(fieldPath, "settings", "expression", "operands", index),
            context,
          ),
        ),
      };
    if (expression.operation === "date_offset")
      convertedExpression = {
        ...expression,
        amount: convertNumericOperand(
          expression.amount,
          append(fieldPath, "settings", "expression", "amount"),
          context,
        ),
      };
    if (expression.operation === "condition")
      convertedExpression = {
        ...expression,
        condition: convertCondition(
          expression.condition,
          fieldsByKey,
          append(fieldPath, "settings", "expression", "condition"),
          context,
        ),
      };
    if (expression.operation === "deadline_passed" && expression.status_field) {
      const statusField = fieldsByKey.get(expression.status_field);
      if (statusField)
        convertedExpression = {
          ...expression,
          terminal_status_values: expression.terminal_status_values.map((value, index) =>
            convertFieldValue(
              value,
              statusField,
              append(fieldPath, "settings", "expression", "terminal_status_values", index),
              context,
              "record_value",
            ),
          ),
        };
    }
    converted.settings = { ...field.settings, expression: convertedExpression };
  }
  if (field.type === "total" && field.settings.filter !== undefined) {
    const filterPath = append(fieldPath, "settings", "filter");
    if (!totalFilterFields && conditionContainsLiteral(field.settings.filter))
      context.add(
        "external_field_context_unavailable",
        filterPath,
        "A literal-bearing external total filter requires the related Module field contract",
      );
    converted.settings = {
      ...field.settings,
      filter: totalFilterFields
        ? convertCondition(field.settings.filter, totalFilterFields, filterPath, context)
        : field.settings.filter,
    };
  }
  if (field.default !== undefined)
    converted.default = convertFieldValue(
      field.default,
      field,
      append(fieldPath, "default"),
      context,
      "definition_default",
    );
  return converted;
};

const localTotalFilterFields = (
  moduleKey: string,
  relationship: string,
  recordsByKey: ReadonlyMap<string, SourceRecordType>,
): ReadonlyMap<string, SourceField> | undefined => {
  const separator = relationship.indexOf(":");
  if (separator < 0 || relationship.slice(0, separator) !== moduleKey) return undefined;
  const ownerAndRelationship = relationship.slice(separator + 1).split(".");
  if (ownerAndRelationship.length !== 2) return undefined;
  const owner = recordsByKey.get(ownerAndRelationship[0]!);
  return owner ? new Map(owner.fields.map((field) => [field.key, field] as const)) : undefined;
};

const localRecordForQualifiedType = (
  moduleKey: string,
  qualifiedRecordType: string,
  recordsByKey: ReadonlyMap<string, SourceRecordType>,
): SourceRecordType | undefined => {
  const separator = qualifiedRecordType.indexOf(":");
  if (separator < 0 || qualifiedRecordType.slice(0, separator) !== moduleKey) return undefined;
  return recordsByKey.get(qualifiedRecordType.slice(separator + 1));
};

const diagnosticPath = (path: readonly PropertyKey[]): ModuleDraftConversionPath =>
  path.map((entry) => (typeof entry === "number" ? entry : String(entry)));

/**
 * Purely converts an authored Module V1 draft to V2 source. It performs no reads or writes and
 * reports every ambiguity at its source path instead of consulting mutable installation state.
 */
export const convertModuleSourceV1ToV2 = (
  sourceInput: ModuleSourceDocumentV1,
  resolutions: readonly ModuleDraftConversionResolution[],
): ModuleDraftConversionResult => {
  const parsed = moduleSourceDocumentV1Schema.safeParse(sourceInput);
  if (!parsed.success)
    return {
      success: false,
      diagnostics: parsed.error.issues.map((issue) => ({
        code: "invalid_v1_source" as const,
        path: diagnosticPath(issue.path),
        message: issue.message,
      })),
    };

  const source = parsed.data;
  const context = new ConversionContext(resolutions);
  const recordsByKey = new Map(
    source.body.record_types.map((record) => [record.key, record] as const),
  );
  const convertedRecords = source.body.record_types.map((record, recordIndex) => {
    const recordPath = ["body", "record_types", recordIndex] as const;
    const fieldsByKey = new Map(record.fields.map((field) => [field.key, field] as const));
    return {
      ...record,
      fields: record.fields.map((field, fieldIndex) => {
        const totalFields =
          field.type === "total"
            ? localTotalFilterFields(source.key, field.settings.relationship, recordsByKey)
            : undefined;
        return convertField(
          field,
          append(recordPath, "fields", fieldIndex),
          fieldsByKey,
          totalFields,
          context,
        );
      }),
    };
  });
  const fieldsForRecord = (recordKey: string) => {
    const record = recordsByKey.get(recordKey);
    return new Map((record?.fields ?? []).map((field) => [field.key, field] as const));
  };

  const convertedActions = source.body.actions.map((action, actionIndex) => {
    const fieldsByKey = fieldsForRecord(action.record_type);
    const actionPath = ["body", "actions", actionIndex] as const;
    return {
      ...action,
      ...(action.precondition === undefined
        ? {}
        : {
            precondition: convertCondition(
              action.precondition,
              fieldsByKey,
              append(actionPath, "precondition"),
              context,
            ),
          }),
      effects: action.effects.map((effect, effectIndex) => {
        const effectPath = append(actionPath, "effects", effectIndex);
        if (effect.kind === "set_field") {
          const targetField = fieldsByKey.get(effect.field);
          return targetField && effect.value.source === "literal"
            ? {
                ...effect,
                value: {
                  ...effect.value,
                  value: convertFieldValue(
                    effect.value.value,
                    targetField,
                    append(effectPath, "value", "value"),
                    context,
                    "record_value",
                  ),
                },
              }
            : effect;
        }
        if (effect.kind !== "create_record") return effect;
        const targetRecord = localRecordForQualifiedType(
          source.key,
          effect.record_type,
          recordsByKey,
        );
        const targetFields = targetRecord
          ? new Map(targetRecord.fields.map((field) => [field.key, field] as const))
          : undefined;
        return {
          ...effect,
          values: Object.fromEntries(
            Object.entries(effect.values).map(([key, actionValue]) => {
              const valuePath = append(effectPath, "values", key, "value");
              if (actionValue.source !== "literal") return [key, actionValue];
              const targetField = targetFields?.get(key);
              if (!targetFields) {
                context.add(
                  "external_field_context_unavailable",
                  valuePath,
                  "A literal value for an external created record requires its Module field contract",
                );
                return [key, actionValue];
              }
              return [
                key,
                targetField
                  ? {
                      ...actionValue,
                      value: convertFieldValue(
                        actionValue.value,
                        targetField,
                        valuePath,
                        context,
                        "record_value",
                      ),
                    }
                  : actionValue,
              ];
            }),
          ),
        };
      }),
    };
  });

  const convertedRules = source.body.rules.map((rule, ruleIndex) => {
    const fieldsByKey = fieldsForRecord(rule.record_type);
    const rulePath = ["body", "rules", ruleIndex] as const;
    const effect =
      rule.effect.kind === "set_value"
        ? (() => {
            const field = fieldsByKey.get(rule.effect.field);
            return field
              ? {
                  ...rule.effect,
                  value: convertFieldValue(
                    rule.effect.value,
                    field,
                    append(rulePath, "effect", "value"),
                    context,
                    "record_value",
                  ),
                }
              : rule.effect;
          })()
        : rule.effect;
    return {
      ...rule,
      condition: convertCondition(
        rule.condition,
        fieldsByKey,
        append(rulePath, "condition"),
        context,
      ),
      effect,
    };
  });

  const convertedSharingConditions = source.body.sharing_conditions.map((sharing, sharingIndex) => {
    const fieldsByKey = fieldsForRecord(sharing.source_record_type);
    const sharingPath = ["body", "sharing_conditions", sharingIndex] as const;
    return {
      ...sharing,
      condition: convertCondition(
        sharing.condition,
        fieldsByKey,
        append(sharingPath, "condition"),
        context,
      ),
      publication_tests: sharing.publication_tests.map((test, testIndex) => ({
        ...test,
        field_values: Object.fromEntries(
          Object.entries(test.field_values).map(([key, value]) => {
            const field = fieldsByKey.get(key);
            return [
              key,
              field
                ? convertFieldValue(
                    value,
                    field,
                    append(sharingPath, "publication_tests", testIndex, "field_values", key),
                    context,
                    "record_value",
                  )
                : value,
            ];
          }),
        ),
      })),
    };
  });

  const candidate = {
    ...source,
    source_contract_version: "2.0.0" as const,
    body: {
      ...source.body,
      record_types: convertedRecords,
      actions: convertedActions,
      rules: convertedRules,
      sharing_conditions: convertedSharingConditions,
    },
  };

  context.finishResolutions();
  if (context.diagnostics.length > 0) return { success: false, diagnostics: context.diagnostics };

  const converted = moduleSourceDocumentV2Schema.safeParse(candidate);
  if (!converted.success)
    return {
      success: false,
      diagnostics: converted.error.issues.map((issue) => ({
        code: "invalid_v2_source" as const,
        path: diagnosticPath(issue.path),
        message: issue.message,
      })),
    };
  return { success: true, source: converted.data };
};
