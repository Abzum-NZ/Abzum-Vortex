import {
  calculationMaximumNestingDepth,
  conditionNodeSchema,
  jsonValueSchema,
  walkDefinitionContract,
  type ModuleCompilationOutput,
  type DefinitionCompilationOutput,
  type DefinitionValidationLocation,
} from "../../schema";
import { fingerprintCanonicalValue } from "../canonical-json-definition";
import { DefinitionCompilationError } from "../compilation-error";
import type { Resolution } from "./resolution";
import { compatibleVersion } from "./resolution";
import { asObject, fail, type JsonObject } from "./shared";
import { condition, type ModuleValueContext, normaliseExact } from "./values";
import { moduleDependencies } from "../module-dependencies";

function linkApplicationAccessSettingLocation(
  field: JsonObject,
  qualifiedRecordType: string,
  resolution: Resolution,
): DefinitionValidationLocation {
  const recordKey = qualifiedRecordType.slice(qualifiedRecordType.lastIndexOf(":") + 1);
  const location = resolution.location("field", String(field.key), `record:${recordKey}`);
  return {
    ...location,
    segments: [...location.segments, { kind: "setting", key: "application_root_required" }],
  };
}

/**
 * An enabled access requirement belongs only to a resolved organization-account projection. Local
 * records belong to the same compiled Module draft, which is contract-checked before returning.
 */
export function validateLinkApplicationAccess(
  source: JsonObject,
  resolution: Resolution,
  organizationId: unknown,
  localRecords: readonly JsonObject[],
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): void {
  const body = asObject(source.body);
  const ownKey = String(source.key);
  for (const record of body.record_types as JsonObject[]) {
    const qualifiedRecordType = `${ownKey}:${String(record.key)}`;
    for (const field of record.fields as JsonObject[]) {
      if (field.type !== "link") continue;
      const settings = asObject(field.settings);
      if (settings.application_root_required !== true) continue;
      const location = linkApplicationAccessSettingLocation(field, qualifiedRecordType, resolution);
      try {
        const reference = String(settings.target);
        const target = resolution.recordType(reference);
        const moduleKey = reference.slice(0, reference.lastIndexOf(":"));
        const expected = resolution.definition(moduleKey, "module");
        let records = localRecords;
        if (moduleKey !== ownKey) {
          const declarations = (moduleDependencies(source) as unknown as JsonObject[]).filter(
            (dependency) => dependency.module === moduleKey,
          );
          const candidates = dependencyOutputs.filter(
            (output): output is ModuleCompilationOutput =>
              output.kind === "module" && output.artifact.definitionKey === moduleKey,
          );
          if (declarations.length !== 1 || candidates.length !== 1)
            fail("vortex.definition.application_dependency_manifest", "broken_reference", location);
          const requirement = declarations[0]!.version as Parameters<typeof compatibleVersion>[0];
          const output = candidates[0]!;
          const canonical = asObject(output.canonical);
          const envelope = asObject(canonical.envelope);
          const content = asObject(canonical.content);
          if (
            !compatibleVersion(requirement, expected.exactVersion) ||
            output.artifact.rootId !== expected.rootId ||
            output.artifact.exactVersion !== expected.exactVersion ||
            output.artifact.resolutionFingerprint !== output.resolutionFingerprint ||
            envelope.kind !== "module" ||
            envelope.key !== moduleKey ||
            envelope.rootId !== expected.rootId ||
            envelope.organizationId !== organizationId ||
            output.artifact.contentFingerprint !== fingerprintCanonicalValue(content)
          )
            fail("vortex.definition.application_dependency_manifest", "broken_reference", location);
          records = content.recordTypes as JsonObject[];
        }
        const matches = records.filter(
          (candidate) => candidate.recordTypeId === target.recordTypeId,
        );
        if (
          target.moduleRootId !== expected.rootId ||
          matches.length !== 1 ||
          (matches[0]!.systemProjection as JsonObject | undefined)?.protectedView !==
            "organization_accounts"
        )
          fail("vortex.definition.invalid_record_type_reference", "broken_reference", location);
      } catch (error) {
        if (!(error instanceof DefinitionCompilationError)) throw error;
        throw new DefinitionCompilationError(error.ruleCode, error.family, location);
      }
    }
  }
}

export function fieldSettings(
  field: JsonObject,
  qualifiedRecordType: string,
  resolution: Resolution,
  permissionOwners: readonly string[],
  valueContext?: ModuleValueContext,
): unknown {
  const settings = asObject(field.settings);
  const localField = (alias: string) => resolution.field(qualifiedRecordType, alias);
  switch (field.type) {
    case "text":
      return {
        maxLength: settings.max_length,
        ...(settings.format ? { format: settings.format } : {}),
      };
    case "long_text":
      return { maxLength: settings.max_length };
    case "formatted_text":
      return {
        allowedBlocks: settings.allowed_blocks,
        ...(settings.max_length ? { maxLength: settings.max_length } : {}),
      };
    case "whole_number":
      return {
        ...(settings.minimum !== undefined ? { minimum: settings.minimum } : {}),
        ...(settings.maximum !== undefined ? { maximum: settings.maximum } : {}),
        ...(settings.step !== undefined ? { step: settings.step } : {}),
      };
    case "decimal_number":
      return {
        digitsBeforeDecimal: settings.digits_before_decimal,
        decimalPlaces: settings.decimal_places,
        ...(settings.minimum !== undefined ? { minimum: normaliseExact(settings.minimum) } : {}),
        ...(settings.maximum !== undefined ? { maximum: normaliseExact(settings.maximum) } : {}),
      };
    case "money":
      return {
        currencyMode:
          settings.currency_mode === "organisation_default"
            ? "organization_default"
            : settings.currency_mode,
        ...(settings.currency ? { currency: settings.currency } : {}),
        ...(settings.minimum !== undefined ? { minimum: normaliseExact(settings.minimum) } : {}),
        ...(settings.maximum !== undefined ? { maximum: normaliseExact(settings.maximum) } : {}),
      };
    case "yes_no":
    case "email_address":
      return {};
    case "date":
      return {
        ...(settings.earliest ? { earliest: settings.earliest } : {}),
        ...(settings.latest ? { latest: settings.latest } : {}),
      };
    case "date_time":
      return {
        ...(settings.display_time_zone
          ? {
              displayTimeZone:
                settings.display_time_zone === "organisation"
                  ? "organization"
                  : settings.display_time_zone,
            }
          : {}),
      };
    case "choice":
      return {
        options: (settings.options as JsonObject[]).map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.required_permission
            ? {
                requiredPermissionId: resolution.permission(
                  String(option.required_permission),
                  permissionOwners,
                ),
              }
            : {}),
        })),
      };
    case "several_choices":
      return {
        options: (settings.options as JsonObject[]).map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.required_permission
            ? {
                requiredPermissionId: resolution.permission(
                  String(option.required_permission),
                  permissionOwners,
                ),
              }
            : {}),
        })),
        ...(settings.maximum_selections ? { maximumSelections: settings.maximum_selections } : {}),
      };
    case "reference_number":
      return {
        digits: settings.digits,
        ...(settings.prefix ? { prefix: settings.prefix } : {}),
        ...(settings.suffix ? { suffix: settings.suffix } : {}),
        ...(settings.starting_number ? { startingNumber: settings.starting_number } : {}),
      };
    case "phone_number":
      return { ...(settings.default_country ? { defaultCountry: settings.default_country } : {}) };
    case "web_address":
      return { ...(settings.allowed_schemes ? { allowedSchemes: settings.allowed_schemes } : {}) };
    case "table":
      return {
        columns: (settings.columns as JsonObject[]).map((column) => ({
          key: column.key,
          type: column.type,
          required: column.required,
          ...(column.settings === undefined
            ? {}
            : {
                settings: fieldSettings(
                  column,
                  qualifiedRecordType,
                  resolution,
                  permissionOwners,
                  valueContext,
                ),
              }),
        })),
        minimumRows: settings.minimum_rows,
        maximumRows: settings.maximum_rows,
      };
    case "link": {
      try {
        return {
          target: resolution.recordType(String(settings.target)),
          reverseKey: settings.reverse_key,
          onParentDelete: settings.on_parent_delete,
          ...(settings.application_root_required === undefined
            ? {}
            : { applicationRootIdRequired: settings.application_root_required }),
        };
      } catch (error) {
        if (
          settings.application_root_required === undefined ||
          !(error instanceof DefinitionCompilationError)
        )
          throw error;
        throw new DefinitionCompilationError(
          error.ruleCode,
          error.family,
          linkApplicationAccessSettingLocation(field, qualifiedRecordType, resolution),
        );
      }
    }
    case "link_to_one_of_several":
      return {
        targets: (settings.targets as string[]).map((target) => resolution.recordType(target)),
        onParentDelete: settings.on_parent_delete,
      };
    case "calculation": {
      const expression = asObject(settings.expression);
      let compiled: unknown;
      let dependencies: string[];
      if (expression.operation === "join_text") {
        dependencies = (expression.fields as string[]).map(localField);
        compiled = { kind: "join_text", fieldIds: dependencies, separator: expression.separator };
      } else if (expression.operation === "numeric") {
        const dependenciesInOrder: string[] = [];
        const numberValue = (operand: JsonObject, depth: number): unknown => {
          if (depth > calculationMaximumNestingDepth)
            fail("vortex.definition.invalid_object", "invalid_value");
          if (operand.source === "numeric")
            return {
              source: "numeric",
              operation: operand.numeric_operation,
              operands: (operand.operands as JsonObject[]).map((nested) =>
                numberValue(asObject(nested), depth + 1),
              ),
            };
          if (operand.source === "field") {
            const fieldId = localField(String(operand.field));
            dependenciesInOrder.push(fieldId);
            return { source: "field", fieldId };
          }
          return { source: "literal", value: normaliseExact(operand.value) };
        };
        const operands = (expression.operands as JsonObject[]).map((operand) =>
          numberValue(asObject(operand), 1),
        );
        dependencies = dependenciesInOrder;
        compiled = {
          kind: "numeric",
          operation: expression.numeric_operation,
          operands,
        };
      } else if (expression.operation === "condition") {
        const compiledCondition = condition(expression.condition, localField, valueContext);
        const dependencySet = new Set<string>();
        walkDefinitionContract(conditionNodeSchema, compiledCondition, (schema, value) => {
          if (schema === jsonValueSchema) return;
          if (value === null || typeof value !== "object") return;
          const entry = value as JsonObject;
          if (entry.source === "field" && typeof entry.fieldId === "string")
            dependencySet.add(entry.fieldId);
        });
        dependencies = [...dependencySet];
        compiled = { kind: "condition", condition: compiledCondition };
      } else if (expression.operation === "date_offset") {
        const dateFieldId = localField(String(expression.date_field));
        const amount = asObject(expression.amount);
        const compiledAmount =
          amount.source === "field"
            ? { source: "field", fieldId: localField(String(amount.field)) }
            : {
                source: "literal",
                value: normaliseExact(amount.value),
              };
        dependencies = [
          dateFieldId,
          ...(amount.source === "field" ? [String(compiledAmount.fieldId)] : []),
        ];
        compiled = {
          kind: "date_offset",
          dateFieldId,
          amount: compiledAmount,
          unit: expression.unit,
        };
      } else {
        const dueFieldId = localField(String(expression.due_field));
        const statusFieldId =
          expression.status_field === undefined
            ? undefined
            : localField(String(expression.status_field));
        dependencies = [dueFieldId, ...(statusFieldId ? [statusFieldId] : [])];
        compiled = {
          kind: "deadline_passed",
          dueFieldId,
          ...(statusFieldId ? { statusFieldId } : {}),
          terminalStatusValues: expression.terminal_status_values,
        };
      }
      const evaluation =
        settings.evaluation === "read_time" || settings.evaluation === "stored"
          ? settings.evaluation
          : expression.operation === "deadline_passed"
            ? "read_time"
            : "stored";
      return {
        resultType: settings.result_type,
        evaluation,
        ...(settings.decimal_places !== undefined
          ? { decimalPlaces: settings.decimal_places }
          : {}),
        expression: compiled,
        dependencyFieldIds: dependencies,
      };
    }
    case "total": {
      const relationshipReference = String(settings.relationship);
      const separator = relationshipReference.lastIndexOf(".");
      if (separator < 1) fail("vortex.definition.qualified_field_required", "unresolved_reference");
      const relationshipRecord = relationshipReference.slice(0, separator);
      const relationshipAlias = relationshipReference.slice(separator + 1);
      const aggregateField = (alias: string) => resolution.field(relationshipRecord, alias);
      const aggregateValueContext = valueContext
        ? {
            ...valueContext,
            field: (reference: string, alias?: string) =>
              alias === undefined
                ? valueContext.field(relationshipRecord, reference)
                : valueContext.field(reference, alias),
          }
        : undefined;
      return {
        relationshipId: resolution.relationship(relationshipRecord, relationshipAlias),
        operation: settings.operation,
        resultType: settings.result_type,
        ...(settings.decimal_places !== undefined
          ? { decimalPlaces: settings.decimal_places }
          : {}),
        ...(settings.field ? { fieldId: aggregateField(String(settings.field)) } : {}),
        ...(settings.filter
          ? { filter: condition(settings.filter, aggregateField, aggregateValueContext) }
          : {}),
        ...(settings.currency ? { currency: settings.currency } : {}),
      };
    }
    case "attachment":
      return {
        allowedKinds: settings.allowed_kinds,
        ...(settings.allowed_extensions ? { allowedExtensions: settings.allowed_extensions } : {}),
        maxFileSizeMb: settings.max_file_size_mb,
        multiple: settings.multiple,
        ...(settings.max_files ? { maxFiles: settings.max_files } : {}),
      };
    default:
      fail("vortex.definition.unsupported_field_type", "unsupported_choice");
  }
}
