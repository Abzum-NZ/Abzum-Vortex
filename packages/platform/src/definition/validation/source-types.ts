import type { DefinitionRuleFailure } from "../../schema";
import {
  type PreparedValidationContext,
  editSaveSources,
  parseEditSaveSource,
  type JsonObject,
} from "./context";
import { object, array } from "./helpers";
import {
  fieldDeclaredResultType,
  typedFieldValueType,
  typedConditionTypesValid,
  typedSemanticFieldType,
  typedValueMatchesType,
} from "./field-types";
import { actionValueCompatible } from "./action-values";

function totalFilterFieldsFilterable(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
): boolean {
  const condition = object(value);
  if (condition.all)
    return array(condition.all).every((entry) => totalFilterFieldsFilterable(entry, fields));
  if (condition.any)
    return array(condition.any).every((entry) => totalFilterFieldsFilterable(entry, fields));
  if (condition.not) return totalFilterFieldsFilterable(condition.not, fields);
  const operands = condition.field === undefined ? [condition.left, condition.right] : [];
  const fieldKeys = [
    ...(condition.field === undefined ? [] : [String(condition.field)]),
    ...operands
      .map((operand) => object(operand ?? {}))
      .filter((operand) => operand.source === "field")
      .map((operand) => String(operand.field)),
  ];
  return fieldKeys.every((fieldKey) => fields.get(fieldKey)?.filterable === true);
}

export function sourceTypeCompatibilityRule(
  context: PreparedValidationContext,
): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const [index, raw] of editSaveSources(context).entries()) {
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(raw);
    if (!parsed.success || parsed.data.kind !== "module") continue;
    const source = parsed.data;
    const body = object(source.body);
    const records = new Map(
      array(body.record_types).map((record) => [String(record.key), record] as const),
    );
    const fieldsFor = (record: JsonObject | undefined) =>
      new Map(
        record ? array(record.fields).map((field) => [String(field.key), field] as const) : [],
      );
    let valid = true;
    for (const [recordKey, record] of records) {
      for (const field of array(record.fields)) {
        if (field.type !== "total") continue;
        const settings = object(field.settings);
        const relationshipReference = String(settings.relationship);
        const relationshipSeparator = relationshipReference.lastIndexOf(".");
        const qualifiedRecord = relationshipReference.slice(0, relationshipSeparator);
        const recordSeparator = qualifiedRecord.lastIndexOf(":");
        if (
          relationshipSeparator < 1 ||
          recordSeparator < 1 ||
          qualifiedRecord.slice(0, recordSeparator) !== source.key
        )
          continue;
        const aggregateRecord = records.get(qualifiedRecord.slice(recordSeparator + 1));
        if (!aggregateRecord) {
          valid = false;
          continue;
        }
        const aggregateFields = fieldsFor(aggregateRecord);
        if (
          settings.filter !== undefined &&
          !totalFilterFieldsFilterable(settings.filter, aggregateFields)
        )
          failures.push({
            ruleCode: "vortex.definition.total_filter_fields",
            family: "broken_reference",
            location: {
              documentKind: "module",
              documentKey: source.key,
              segments: [
                { kind: "module", key: source.key },
                { kind: "record_type", key: recordKey },
                { kind: "field", key: String(field.key) },
              ],
            },
          });
        const relationship = array(aggregateRecord.relationships).find(
          (candidate) =>
            String(candidate.key) === relationshipReference.slice(relationshipSeparator + 1),
        );
        if (!relationship) {
          valid = false;
          continue;
        }
        const targets = relationship.to_record_type
          ? [String(relationship.to_record_type)]
          : array(relationship.to_record_types).map(String);
        const ownerReference = `${source.key}:${recordKey}`;
        const aggregateField =
          settings.field === undefined ? undefined : aggregateFields.get(String(settings.field));
        const aggregateResultType = fieldDeclaredResultType(aggregateField);
        const declaredResultType = String(settings.result_type);
        const resultTypeValid =
          (settings.operation === "count" && declaredResultType === "whole_number") ||
          (settings.operation === "average" &&
            declaredResultType ===
              (aggregateResultType === "money" ? "money" : "decimal_number")) ||
          (["sum", "minimum", "maximum"].includes(String(settings.operation)) &&
            declaredResultType === aggregateResultType);
        if (
          !relationship ||
          !targets.includes(ownerReference) ||
          (settings.operation === "count"
            ? settings.field !== undefined
            : aggregateField === undefined) ||
          (["sum", "average"].includes(String(settings.operation)) &&
            !["whole_number", "decimal_number", "money"].includes(
              typedFieldValueType(aggregateField) ?? "",
            )) ||
          (settings.filter !== undefined &&
            !typedConditionTypesValid(settings.filter, aggregateFields, new Map(), "source")) ||
          !resultTypeValid
        )
          valid = false;
      }
    }
    for (const action of array(body.actions)) {
      const subjectFields = fieldsFor(records.get(String(action.record_type)));
      const inputs = new Map(
        array(action.inputs).map((input) => [String(input.key), input] as const),
      );
      const inputTypes = new Map(
        [...inputs].map(([key, input]) => [key, typedSemanticFieldType(input.type) ?? ""] as const),
      );
      if (
        action.precondition &&
        !typedConditionTypesValid(action.precondition, subjectFields, inputTypes, "source")
      )
        valid = false;
      const subjectRecordType = `${source.key}:${String(action.record_type)}`;
      const sourceValueCompatible = (candidate: unknown, targetField: JsonObject | undefined) =>
        actionValueCompatible(
          candidate,
          targetField,
          subjectFields,
          inputs,
          subjectRecordType,
          "source",
        );
      for (const task of array(action.tasks)) {
        const properties = object(task.properties);
        if (String(task.type) === "record.set_fields") {
          for (const [fieldKey, candidate] of Object.entries(object(properties.values)))
            if (!sourceValueCompatible(candidate, subjectFields.get(fieldKey))) valid = false;
        }
        if (String(task.type) === "record.create") {
          const qualified = String(properties.record_type);
          const split = qualified.lastIndexOf(":");
          if (split >= 0 && qualified.slice(0, split) === source.key) {
            const targetFields = fieldsFor(records.get(qualified.slice(split + 1)));
            if (
              Object.entries(object(properties.values)).some(
                ([fieldKey, candidate]) =>
                  !sourceValueCompatible(candidate, targetFields.get(fieldKey)),
              )
            )
              valid = false;
          }
        }
        if (String(task.type) === "record.changes") {
          for (const change of array(properties.changes)) {
            const targetInput = inputs.get(String(change.target_input));
            if (
              targetInput?.type !== "record_reference" ||
              !array(targetInput.record_types).map(String).includes(subjectRecordType)
            )
              valid = false;
          }
        }
      }
    }
    for (const sharingCondition of array(body.sharing_conditions)) {
      const fields = fieldsFor(records.get(String(sharingCondition.source_record_type)));
      const parameters = new Map(
        array(sharingCondition.parameters).map(
          (parameter) => [String(parameter.key), String(parameter.type)] as const,
        ),
      );
      if (!typedConditionTypesValid(sharingCondition.condition, fields, parameters, "source"))
        valid = false;
    }
    for (const query of array(body.queries)) {
      // Only an own record carries authored field types here; a dependency record's filter is
      // type-checked against the compiled dependency release by the Module reference rule.
      const authoredRecord = String(query.record_type);
      const separator = authoredRecord.lastIndexOf(":");
      if (separator >= 0 && authoredRecord.slice(0, separator) !== source.key) continue;
      const fields = fieldsFor(
        records.get(separator < 0 ? authoredRecord : authoredRecord.slice(separator + 1)),
      );
      const inputTypes = new Map(
        array(query.inputs).map(
          (input) => [String(input.key), typedSemanticFieldType(input.type) ?? ""] as const,
        ),
      );
      if (query.filter && !typedConditionTypesValid(query.filter, fields, inputTypes, "source"))
        valid = false;
    }
    const sharingConditions = new Map(
      array(body.sharing_conditions).map((condition) => [String(condition.key), condition]),
    );
    for (const permission of array(body.permissions)) {
      const scope = permission.record_scope ? object(permission.record_scope) : undefined;
      const restriction = scope?.saved_condition ? object(scope.saved_condition) : undefined;
      if (!restriction) continue;
      const saved = sharingConditions.get(String(restriction.condition));
      const parameters = new Map(
        saved
          ? array(saved.parameters).map(
              (parameter) => [String(parameter.key), String(parameter.type)] as const,
            )
          : [],
      );
      const bindings = array(restriction.parameter_bindings);
      if (
        !saved ||
        String(saved.source_record_type) !== String(permission.record_type) ||
        bindings.length !== parameters.size ||
        new Set(bindings.map((binding) => String(binding.key))).size !== bindings.length ||
        bindings.some((binding) => {
          const expected = parameters.get(String(binding.key));
          return (
            expected === undefined ||
            (binding.source === "current_organization_account_id"
              ? !["text", "organization_account_reference", "record_reference"].includes(expected)
              : !typedValueMatchesType(binding.value, expected, "source"))
          );
        })
      )
        valid = false;
    }
    if (!valid)
      failures.push({
        ruleCode: "vortex.definition.source_type_compatibility",
        family: "invalid_value",
        location: {
          documentKind: "module",
          documentKey: source.key,
          segments: [{ kind: "module", key: source.key }],
        },
      });
  }
  return failures;
}
