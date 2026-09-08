import {
  builderKeySchema,
  moduleSourceDocumentV2Schema,
  moduleSourceDocumentV3Schema,
  sourceRuleGraphTypedValueSchema,
  type ModuleSourceDocumentV1,
  type ModuleSourceDocumentV2,
  type ModuleSourceDocumentV3,
  type ModuleSourceFieldV2,
  type SourceRuleGraphCondition,
  type SourceRuleGraphOperand,
  type SourceRuleGraphTypedValue,
} from "@vortex/contracts";
import {
  convertModuleSourceV1ToV2,
  type ModuleDraftConversionDiagnostic,
  type ModuleDraftConversionPath,
  type ModuleDraftConversionResolution,
} from "./module-draft-conversion";

export type ModuleV3DraftConversionResolution =
  | ModuleDraftConversionResolution
  | Readonly<{
      kind: "rule_message";
      /** Exact path to the legacy rule effect. */
      path: ModuleDraftConversionPath;
      /** Required only when the legacy effect had no safe code of its own. */
      code?: string;
      message: string;
    }>;

export type ModuleV3RuleMessageResolution = Extract<
  ModuleV3DraftConversionResolution,
  { kind: "rule_message" }
>;

export type ModuleV3DraftConversionDiagnosticCode =
  | "invalid_v2_source"
  | "invalid_v3_source"
  | "unsupported_rule_trigger"
  | "unsupported_rule_effect"
  | "unsupported_rule_condition"
  | "invalid_rule_field"
  | "invalid_rule_value"
  | "missing_rule_message"
  | "invalid_rule_message"
  | "duplicate_resolution"
  | "unrecognized_resolution";

export type ModuleV3DraftConversionDiagnostic = Readonly<{
  code: ModuleV3DraftConversionDiagnosticCode;
  path: ModuleDraftConversionPath;
  message: string;
}>;

export type ModuleV3DraftConversionResult =
  | Readonly<{ success: true; source: ModuleSourceDocumentV3 }>
  | Readonly<{
      success: false;
      diagnostics: readonly (ModuleDraftConversionDiagnostic | ModuleV3DraftConversionDiagnostic)[];
    }>;

type SourceRule = ModuleSourceDocumentV2["body"]["rules"][number];
type SourceField = ModuleSourceFieldV2;
type LegacyCondition = SourceRule["condition"];

const append = (path: ModuleDraftConversionPath, ...entries: (string | number)[]) => [
  ...path,
  ...entries,
];
const pathKey = (path: ModuleDraftConversionPath): string => JSON.stringify(path);
const diagnosticPath = (path: readonly PropertyKey[]): ModuleDraftConversionPath =>
  path.map((entry) => (typeof entry === "symbol" ? String(entry) : entry));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

class RuleConversionContext {
  readonly diagnostics: ModuleV3DraftConversionDiagnostic[] = [];
  private readonly messages = new Map<string, ModuleV3RuleMessageResolution>();
  private readonly consumed = new Set<string>();

  constructor(resolutions: readonly ModuleV3RuleMessageResolution[]) {
    for (const resolution of resolutions) {
      const key = pathKey(resolution.path);
      if (this.messages.has(key))
        this.add(
          "duplicate_resolution",
          resolution.path,
          "A legacy rule effect may have only one message resolution",
        );
      else this.messages.set(key, resolution);
    }
  }

  add(
    code: ModuleV3DraftConversionDiagnosticCode,
    path: ModuleDraftConversionPath,
    message: string,
  ): void {
    this.diagnostics.push({ code, path: [...path], message });
  }

  message(
    path: ModuleDraftConversionPath,
    legacyCode?: string,
  ): Readonly<{ code: string; message: string }> {
    const key = pathKey(path);
    const resolution = this.messages.get(key);
    if (!resolution) {
      this.add(
        "missing_rule_message",
        path,
        "This legacy effect requires an explicit safe code and message",
      );
      return { code: "missing_rule_message", message: "Missing rule message." };
    }
    this.consumed.add(key);
    const code = legacyCode ?? resolution.code;
    if (
      !builderKeySchema.safeParse(code).success ||
      (legacyCode !== undefined &&
        resolution.code !== undefined &&
        resolution.code !== legacyCode) ||
      resolution.message.length < 1 ||
      resolution.message.length > 300 ||
      resolution.message.trim().length === 0
    ) {
      this.add(
        "invalid_rule_message",
        path,
        "The supplied rule code and message must match the safe graph contract",
      );
      return { code: "invalid_rule_message", message: "Invalid rule message." };
    }
    return { code: code!, message: resolution.message };
  }

  finish(): void {
    for (const [key, resolution] of this.messages)
      if (!this.consumed.has(key))
        this.add(
          "unrecognized_resolution",
          resolution.path,
          "The message path is not a supported legacy rule effect",
        );
  }
}

const fieldValueType = (field: SourceField): SourceRuleGraphTypedValue["type"] | undefined => {
  if (field.type === "reference_number") return "text";
  if (field.type === "calculation" || field.type === "total") return field.settings.result_type;
  return field.type;
};

const tableColumns = (field: SourceField) =>
  field.type === "table"
    ? field.settings.columns.map(({ key, type, required }) => ({ key, type, required }))
    : undefined;

const typedValue = (
  value: unknown,
  field: SourceField,
  operator: string | undefined,
  path: ModuleDraftConversionPath,
  context: RuleConversionContext,
): SourceRuleGraphTypedValue | undefined => {
  let type = fieldValueType(field);
  const textLike = new Set([
    "text",
    "long_text",
    "choice",
    "email_address",
    "phone_number",
    "web_address",
    "reference_number",
  ]);
  if (field.type === "several_choices" && (operator === "contains" || operator === "not_contains"))
    type = "text";
  else if (
    type !== undefined &&
    textLike.has(type) &&
    (operator === "in" || operator === "not_in") &&
    Array.isArray(value)
  )
    type = "several_choices";
  if (!type) {
    context.add(
      "unsupported_rule_condition",
      path,
      "The legacy condition value has no graph value representation",
    );
    return undefined;
  }
  const parsed = sourceRuleGraphTypedValueSchema.safeParse({
    type,
    value,
    ...(type === "table" ? { columns: tableColumns(field)! } : {}),
  });
  if (!parsed.success) {
    context.add(
      "invalid_rule_value",
      path,
      "The legacy value does not match the owning field's graph value type",
    );
    return undefined;
  }
  return parsed.data;
};

const fieldOperand = (field: string): SourceRuleGraphOperand => ({
  source: "current_field",
  field,
});

const convertCondition = (
  condition: LegacyCondition,
  fields: ReadonlyMap<string, SourceField>,
  path: ModuleDraftConversionPath,
  context: RuleConversionContext,
): SourceRuleGraphCondition | undefined => {
  if ("all" in condition || "any" in condition) {
    const key = "all" in condition ? "all" : "any";
    const sourceChildren = "all" in condition ? condition.all : condition.any;
    const children = sourceChildren.map((child, index) =>
      convertCondition(child, fields, append(path, key, index), context),
    );
    return children.every((child) => child !== undefined)
      ? { kind: key, conditions: children as SourceRuleGraphCondition[] }
      : undefined;
  }
  if ("not" in condition) {
    const child = convertCondition(condition.not, fields, append(path, "not"), context);
    return child ? { kind: "not", condition: child } : undefined;
  }

  if ("field" in condition) {
    const field = fields.get(condition.field);
    if (!field) {
      context.add("invalid_rule_field", append(path, "field"), "The rule field is not declared");
      return undefined;
    }
    const left = fieldOperand(condition.field);
    if (condition.operator === "is_empty" || condition.operator === "is_not_empty")
      return { kind: "comparison", operator: condition.operator, left };
    if ("parameter" in condition) {
      context.add(
        "unsupported_rule_condition",
        append(path, "parameter"),
        "Legacy Module rules do not declare graph inputs for condition parameters",
      );
      return undefined;
    }
    if (!("value" in condition)) return undefined;
    const value = typedValue(
      condition.value,
      field,
      condition.operator,
      append(path, "value"),
      context,
    );
    return value
      ? {
          kind: "comparison",
          operator: condition.operator,
          left,
          right: { source: "literal", value },
        }
      : undefined;
  }

  const operand = (
    candidate: Extract<LegacyCondition, { left: unknown }>["left"],
    other: Extract<LegacyCondition, { left: unknown }>["left"] | undefined,
    operandPath: ModuleDraftConversionPath,
  ): SourceRuleGraphOperand | undefined => {
    if (candidate.source === "field") {
      if (!fields.has(candidate.field)) {
        context.add(
          "invalid_rule_field",
          append(operandPath, "field"),
          "The rule field is not declared",
        );
        return undefined;
      }
      return fieldOperand(candidate.field);
    }
    if (candidate.source === "parameter") {
      context.add(
        "unsupported_rule_condition",
        append(operandPath, "parameter"),
        "Legacy Module rules do not declare graph inputs for condition parameters",
      );
      return undefined;
    }
    const otherField = other?.source === "field" ? fields.get(other.field) : undefined;
    if (!otherField) {
      context.add(
        "unsupported_rule_condition",
        operandPath,
        "A legacy literal requires an opposing owning field declaration",
      );
      return undefined;
    }
    const value = typedValue(candidate.value, otherField, condition.operator, operandPath, context);
    return value ? { source: "literal", value } : undefined;
  };

  const left = operand(condition.left, "right" in condition ? condition.right : undefined, [
    ...path,
    "left",
  ]);
  if (condition.operator === "is_empty" || condition.operator === "is_not_empty")
    return left ? { kind: "comparison", operator: condition.operator, left } : undefined;
  if (!("right" in condition)) return undefined;
  const right = operand(condition.right, condition.left, [...path, "right"]);
  return left && right
    ? { kind: "comparison", operator: condition.operator, left, right }
    : undefined;
};

const preflightUnsupportedEffects = (source: unknown): ModuleV3DraftConversionDiagnostic[] => {
  if (!isRecord(source) || !isRecord(source.body) || !Array.isArray(source.body.rules)) return [];
  return source.body.rules.flatMap((rule, index) => {
    if (!isRecord(rule) || !isRecord(rule.effect)) return [];
    return rule.effect.kind === "show_or_hide" || rule.effect.kind === "start_background_work"
      ? [
          {
            code: "unsupported_rule_effect" as const,
            path: ["body", "rules", index, "effect", "kind"],
            message: "This legacy effect belongs to a later graph profile",
          },
        ]
      : [];
  });
};

const convertRule = (
  rule: SourceRule,
  ruleIndex: number,
  fields: ReadonlyMap<string, SourceField>,
  context: RuleConversionContext,
) => {
  const rulePath: ModuleDraftConversionPath = ["body", "rules", ruleIndex];
  if (rule.trigger !== "create" && rule.trigger !== "change") {
    context.add(
      "unsupported_rule_trigger",
      append(rulePath, "trigger"),
      "Only legacy create and change rules can become before-save graphs",
    );
    return undefined;
  }
  const condition = convertCondition(
    rule.condition,
    fields,
    append(rulePath, "condition"),
    context,
  );
  const effectPath = append(rulePath, "effect");
  let effectNode: Record<string, unknown> | undefined;
  if (rule.effect.kind === "set_value") {
    const target = fields.get(rule.effect.field);
    if (!target) {
      context.add(
        "invalid_rule_field",
        append(effectPath, "field"),
        "The set-value field is not declared",
      );
    } else if (
      target.type === "reference_number" ||
      target.type === "calculation" ||
      target.type === "total"
    ) {
      context.add(
        "unsupported_rule_effect",
        append(effectPath, "field"),
        "The legacy rule writes a generator-owned field that before-save graphs cannot assign",
      );
    } else {
      const value =
        rule.effect.value === null
          ? undefined
          : typedValue(rule.effect.value, target, undefined, append(effectPath, "value"), context);
      effectNode = {
        id: "effect",
        node_version: "1.0.0",
        type: "set_field",
        field: rule.effect.field,
        assignment:
          rule.effect.value === null
            ? { kind: "clear" }
            : { kind: "set", value: { source: "literal", value } },
      };
    }
  } else if (rule.effect.kind === "require") {
    if (!fields.has(rule.effect.field))
      context.add(
        "invalid_rule_field",
        append(effectPath, "field"),
        "The required field is not declared",
      );
    const message = context.message(effectPath);
    effectNode = {
      id: "effect",
      node_version: "1.0.0",
      type: "require_field",
      field: rule.effect.field,
      ...message,
    };
  } else if (rule.effect.kind === "warn") {
    effectNode = {
      id: "effect",
      node_version: "1.0.0",
      type: "warn",
      ...context.message(effectPath, rule.effect.message),
    };
  } else if (rule.effect.kind === "refuse") {
    effectNode = {
      id: "effect",
      node_version: "1.0.0",
      type: "refuse",
      ...context.message(effectPath, rule.effect.reason_code),
    };
  } else {
    context.add(
      "unsupported_rule_effect",
      append(effectPath, "kind"),
      "This legacy effect belongs to a later graph profile",
    );
  }
  if (!condition || !effectNode) return undefined;

  const terminalEffect = rule.effect.kind === "refuse";
  const nodes = [
    {
      id: "start",
      node_version: "1.0.0" as const,
      type: "start" as const,
      operations: [rule.trigger === "create" ? "create" : "update"] as const,
    },
    {
      id: "condition",
      node_version: "1.0.0" as const,
      type: "condition" as const,
      condition,
    },
    effectNode,
    ...(!terminalEffect ? [{ id: "finish_effect", node_version: "1.0.0", type: "finish" }] : []),
    { id: "finish_false", node_version: "1.0.0", type: "finish" },
  ];
  const edges = [
    { from: "start", port: "next" as const, to: "condition" },
    { from: "condition", port: "true" as const, to: "effect" },
    { from: "condition", port: "false" as const, to: "finish_false" },
    ...(!terminalEffect ? [{ from: "effect", port: "next" as const, to: "finish_effect" }] : []),
  ];
  return {
    id: rule.id,
    key: rule.key,
    record_type: rule.record_type,
    profile: "before_save" as const,
    graph_version: "1.0.0" as const,
    priority: rule.priority,
    inputs: [],
    variables: [],
    nodes,
    edges,
  };
};

export const convertModuleSourceV2ToV3 = (
  candidate: ModuleSourceDocumentV2,
  resolutions: readonly ModuleV3RuleMessageResolution[],
): ModuleV3DraftConversionResult => {
  const unsupported = preflightUnsupportedEffects(candidate);
  if (unsupported.length > 0) return { success: false, diagnostics: unsupported };
  const parsed = moduleSourceDocumentV2Schema.safeParse(candidate);
  if (!parsed.success)
    return {
      success: false,
      diagnostics: parsed.error.issues.map((entry) => ({
        code: "invalid_v2_source" as const,
        path: diagnosticPath(entry.path),
        message: entry.message,
      })),
    };
  const source = parsed.data;
  const context = new RuleConversionContext(resolutions);
  const fieldsByRecord = new Map(
    source.body.record_types.map((record) => [
      record.key,
      new Map(record.fields.map((field) => [field.key, field])),
    ]),
  );
  const rules = source.body.rules.map((rule, index) => {
    const fields = fieldsByRecord.get(rule.record_type);
    if (!fields) {
      context.add(
        "invalid_rule_field",
        ["body", "rules", index, "record_type"],
        "The rule record type is not declared",
      );
      return undefined;
    }
    return convertRule(rule, index, fields, context);
  });
  context.finish();
  if (context.diagnostics.length > 0 || rules.some((rule) => rule === undefined))
    return { success: false, diagnostics: context.diagnostics };

  const converted = moduleSourceDocumentV3Schema.safeParse({
    ...source,
    source_contract_version: "3.0.0",
    body: { ...source.body, rules },
  });
  if (!converted.success)
    return {
      success: false,
      diagnostics: converted.error.issues.map((entry) => ({
        code: "invalid_v3_source" as const,
        path: diagnosticPath(entry.path),
        message: entry.message,
      })),
    };
  return { success: true, source: converted.data };
};

export const convertModuleSourceV1ToV3 = (
  source: ModuleSourceDocumentV1,
  resolutions: readonly ModuleV3DraftConversionResolution[],
): ModuleV3DraftConversionResult => {
  const unsupported = preflightUnsupportedEffects(source);
  if (unsupported.length > 0) return { success: false, diagnostics: unsupported };
  const v2 = convertModuleSourceV1ToV2(
    source,
    resolutions.filter(
      (resolution): resolution is ModuleDraftConversionResolution =>
        resolution.kind !== "rule_message",
    ),
  );
  if (!v2.success) return v2;
  return convertModuleSourceV2ToV3(
    v2.source,
    resolutions.filter(
      (resolution): resolution is ModuleV3RuleMessageResolution =>
        resolution.kind === "rule_message",
    ),
  );
};
