import { flowFormulaSchema, flowFormulaUsesNow } from "../../workflows/flow-values";
import { calculationFormulaDependencies } from "../module-calculation-formula";
import type { DefinitionValidationLocation } from "../../catalogue/validation-errors";
import type {
  ModuleCompilationOutput,
  DefinitionCompilationOutput,
} from "../definition-compilation-contracts";
import { fingerprintCanonicalValue } from "../canonical-json-definition";
import { DefinitionCompilationError } from "../compilation-error";
import type { Resolution } from "./resolution";
import { compatibleVersion } from "./resolution";
import { asObject, fail, type JsonObject } from "./shared";
import { condition, type ModuleValueContext, normaliseExact } from "./values";
import { moduleDependencies } from "../module-dependencies";

function personLinkSettingLocation(
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
export function validatePersonLinkApplicationAccess(
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
      const location = personLinkSettingLocation(field, qualifiedRecordType, resolution);
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
        currencyMode: settings.currency_mode,
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
        ...(settings.display_time_zone ? { displayTimeZone: settings.display_time_zone } : {}),
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
          ...(option.parent_values === undefined ? {} : { parentValues: option.parent_values }),
        })),
        ...(settings.depends_on === undefined
          ? {}
          : {
              dependsOn: {
                parentFieldId: localField(String(asObject(settings.depends_on).parent_field)),
              },
            }),
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
          reverseName: settings.reverse_name,
          onParentDelete: settings.on_parent_delete,
          ...(settings.application_root_required === undefined
            ? {}
            : { applicationRootIdRequired: settings.application_root_required }),
          ...(settings.depends_on === undefined
            ? {}
            : {
                dependsOn: {
                  parentFieldId: localField(String(asObject(settings.depends_on).parent_field)),
                  filterFieldId: resolution.field(
                    String(settings.target),
                    String(asObject(settings.depends_on).filter_field),
                  ),
                },
              }),
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
          personLinkSettingLocation(field, qualifiedRecordType, resolution),
        );
      }
    }
    case "link_to_one_of_several":
      return {
        targets: (settings.targets as string[]).map((target) => resolution.recordType(target)),
        onParentDelete: settings.on_parent_delete,
      };
    case "calculation": {
      const authored = flowFormulaSchema.parse(settings.expression);
      // Resolve names only: the authored and compiled expression are both FlowFormula.
      const resolve = (value: unknown): unknown => {
        if (value === null || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(resolve);
        const node = value as JsonObject;
        if (node.op === "literal") return node;
        if (node.op === "reference") {
          const reference = asObject(node.reference);
          if (reference.source !== "trigger_record")
            fail("vortex.definition.invalid_object", "invalid_value");
          return {
            op: "reference",
            reference: { source: "module_field", fieldId: localField(String(reference.field)) },
          };
        }
        return Object.fromEntries(
          Object.entries(node).map(([key, child]) => [key, resolve(child)]),
        );
      };
      const compiled = flowFormulaSchema.parse(resolve(authored));
      const dependencies = calculationFormulaDependencies(compiled);
      const evaluation =
        settings.evaluation ?? (flowFormulaUsesNow(compiled) ? "read_time" : "stored");
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
