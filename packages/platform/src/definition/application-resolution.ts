import {
  definitionResolutionSnapshotSchema,
  type DefinitionResolutionSnapshot,
} from "./definition-compilation-contracts";
import type { sourceQualifiedConditionSchema } from "./definition-source";
import type { ModuleField } from "./module-contracts";
import type { ConditionNode } from "./module-foundation-contracts";
import type { z } from "zod";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "./canonical-json-definition";

export type ApplicationCompositionResolution = Readonly<{
  identity(
    kind:
      | "shell"
      | "shell_content_slot"
      | "block_placement"
      | "guided_step"
      | "page"
      | "pipeline"
      | "flow"
      | "event"
      | "flow_node"
      | "flow_edge"
      | "flow_binding",
    alias: string,
    scope?: string,
  ): string;
  /**
   * The identity of a query a bound Module exposes, from its dependency-qualified reference (the
   * Module's key and the query's key). An unbound Module or an unknown query is refused.
   */
  moduleQuery(reference: string): string;
  field(reference: string): string;
  /**
   * The module field an automatic field input binds, read by permanent field identity. Undefined
   * when the field is not part of an exactly bound module release, so publication refuses it.
   */
  fieldInput(fieldId: string): FieldInputSourceField | undefined;
  relationship(reference: string): string;
  action(reference: string): string;
  permission(reference: string): string;
  condition(authored: z.infer<typeof sourceQualifiedConditionSchema>): ConditionNode;
  recordType(reference: string): Readonly<{
    state: "resolved";
    moduleRootId: string;
    recordTypeId: string;
  }>;
}>;

/**
 * The exact module-field metadata the compiler derives one automatic field input from: its stable
 * key, label, requirement, module field type, declared format, choices and type-specific settings
 * the automatic input needs. Link fields also carry their resolved target record types.
 */
export type FieldInputSourceField = Readonly<{
  key: string;
  label: string;
  required: boolean;
  type: string;
  attachmentSettings?: Extract<ModuleField, { type: "attachment" }>["settings"] | undefined;
  tableSettings?: Extract<ModuleField, { type: "table" }>["settings"] | undefined;
  textFormat?: string | undefined;
  displayTimeZone?: "person" | "organization" | "utc" | undefined;
  maximumSelections?: number | undefined;
  choices: readonly Readonly<{ key: string; label: string; parentValues?: readonly string[] }>[];
  /** The field of the same record type whose chosen value narrows this field's choices. */
  dependsOn?: Readonly<{ fieldKey: string; label: string }> | undefined;
  recordTypes: readonly Readonly<{
    state: "resolved";
    moduleRootId: string;
    recordTypeId: string;
  }>[];
}>;

type FieldInputJson = Readonly<Record<string, unknown>>;

/**
 * The automatic field input metadata of one canonical module field, read by the compiler for a
 * bound release and by the runtime for a contributed field. Undefined when a link field names a
 * target that is not resolved: an automatic input never invents a record type identity. A link or
 * choice that depends on another field takes that field's key and label from `parentOf`; it is
 * undefined too when the parent cannot be found, so the dependency is never left off the control.
 */
export const fieldInputSourceField = (
  field: FieldInputJson,
  parentOf: (fieldId: string) => FieldInputJson | undefined = () => undefined,
): FieldInputSourceField | undefined => {
  const type = String(field.type);
  const settings: FieldInputJson =
    typeof field.settings === "object" && field.settings !== null
      ? (field.settings as FieldInputJson)
      : {};
  const resolvedRecordType = (
    value: unknown,
  ): FieldInputSourceField["recordTypes"][number] | undefined => {
    const recordType = (typeof value === "object" && value !== null ? value : {}) as FieldInputJson;
    return recordType.state === "resolved"
      ? {
          state: "resolved",
          moduleRootId: String(recordType.moduleRootId),
          recordTypeId: String(recordType.recordTypeId),
        }
      : undefined;
  };
  // The field's options source: a parent field that narrows its options, and each option's parents.
  const optionsSource = (
    typeof settings.optionsSource === "object" && settings.optionsSource !== null
      ? settings.optionsSource
      : {}
  ) as FieldInputJson;
  const optionParents = (
    typeof optionsSource.optionParents === "object" && optionsSource.optionParents !== null
      ? optionsSource.optionParents
      : {}
  ) as FieldInputJson;
  const choices =
    (type === "choice" || type === "several_choices") && Array.isArray(settings.options)
      ? (settings.options as FieldInputJson[]).map((option) => ({
          key: String(option.value),
          label: String(option.label),
          ...(Array.isArray(optionParents[String(option.value)])
            ? {
                parentValues: (optionParents[String(option.value)] as unknown[]).map(String),
              }
            : {}),
        }))
      : [];
  const dependsOn =
    (type === "link" || type === "choice") && optionsSource.parentFieldId !== undefined
      ? optionsSource
      : undefined;
  const parent = dependsOn === undefined ? undefined : parentOf(String(dependsOn.parentFieldId));
  if (dependsOn !== undefined && parent === undefined) return undefined;
  const targets: unknown[] =
    type === "link" && settings.target !== undefined
      ? [settings.target]
      : type === "link_to_one_of_several" && Array.isArray(settings.targets)
        ? (settings.targets as unknown[])
        : [];
  const recordTypes = targets.map(resolvedRecordType);
  if (recordTypes.some((recordType) => recordType === undefined)) return undefined;
  return {
    key: String(field.key),
    label: String(field.label),
    required: field.required === true,
    type,
    ...(type === "date_time" &&
    (settings.displayTimeZone === "person" ||
      settings.displayTimeZone === "organization" ||
      settings.displayTimeZone === "utc")
      ? { displayTimeZone: settings.displayTimeZone }
      : {}),
    ...(type === "several_choices" && typeof settings.maximumSelections === "number"
      ? { maximumSelections: settings.maximumSelections }
      : {}),
    ...(type === "attachment"
      ? {
          attachmentSettings: settings as unknown as NonNullable<
            FieldInputSourceField["attachmentSettings"]
          >,
        }
      : {}),
    ...(type === "table"
      ? {
          tableSettings: settings as unknown as NonNullable<FieldInputSourceField["tableSettings"]>,
        }
      : {}),
    choices,
    ...(parent === undefined
      ? {}
      : { dependsOn: { fieldKey: String(parent.key), label: String(parent.label) } }),
    recordTypes: recordTypes as FieldInputSourceField["recordTypes"],
  };
};

/** Publication can select only existing indexable fields, including safe derived inputs. */
export const applicationSearchFieldIsSelectable = (
  fields: readonly ModuleField[],
  fieldId: string,
): boolean => {
  const indexable = new Set([
    "text",
    "long_text",
    "formatted_text",
    "whole_number",
    "decimal_number",
    "money",
    "date",
    "date_time",
    "choice",
    "several_choices",
    "reference_number",
    "email_address",
    "phone_number",
    "web_address",
    "table",
    "calculation",
    "total",
  ]);
  const byId = new Map(fields.map((field) => [String(field.fieldId).toLowerCase(), field]));
  if (byId.size !== fields.length) return false;
  const visiting = new Set<string>();
  const decided = new Map<string, boolean>();
  const safe = (id: string): boolean => {
    id = id.toLowerCase();
    const cached = decided.get(id);
    if (cached !== undefined) return cached;
    const field = byId.get(id);
    if (
      field === undefined ||
      visiting.has(id) ||
      (field.personalData !== "none" && field.personalData !== "personal")
    )
      return false;
    visiting.add(id);
    const inputs = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if ((key === "fieldId" || key.endsWith("FieldId")) && typeof item === "string")
          inputs.add(item);
        else if (key.endsWith("FieldIds") && Array.isArray(item))
          item.forEach((entry) => {
            if (typeof entry === "string") inputs.add(entry);
          });
        else collect(item);
      }
    };
    if (field.type === "calculation" || field.type === "total") collect(field.settings);
    const allowed = [...inputs].every(safe);
    visiting.delete(id);
    decided.set(id, allowed);
    return allowed;
  };
  const field = byId.get(fieldId.toLowerCase());
  return (
    field !== undefined &&
    (field.searchPriority === "first" ||
      field.searchPriority === "normal" ||
      field.searchPriority === "last") &&
    indexable.has(field.type) &&
    safe(fieldId)
  );
};

type ResolutionEvidence = Pick<DefinitionResolutionSnapshot, "definitions" | "identities">;

const identityOrder = (identity: DefinitionResolutionSnapshot["identities"][number]): string =>
  JSON.stringify([
    identity.definitionKey,
    identity.scope,
    identity.kind,
    identity.componentOwner,
    identity.alias,
    identity.identifier,
  ]);

/** Builds exact  resolution evidence without making caller-provided array order authoritative. */
export const createApplicationResolutionSnapshot = (
  input: ResolutionEvidence,
): DefinitionResolutionSnapshot => {
  const definitionKeys = input.definitions.map(({ kind, key }) => `${kind}:${key}`);
  if (new Set(definitionKeys).size !== definitionKeys.length)
    throw new Error(" resolution evidence contains duplicate definition selections");
  const identityKeys = input.identities.map(
    ({ definitionKey, scope, kind, alias }) => `${definitionKey}:${scope}:${kind}:${alias}`,
  );
  if (new Set(identityKeys).size !== identityKeys.length)
    throw new Error(" resolution evidence contains duplicate identity lookup keys");
  const definitions = [...input.definitions].sort((left, right) =>
    compareCanonicalStrings(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
  );
  const identities = [...input.identities].sort((left, right) =>
    compareCanonicalStrings(identityOrder(left), identityOrder(right)),
  );
  const evidence = { contractVersion: "4.0.0" as const, definitions, identities };
  return definitionResolutionSnapshotSchema.parse({
    ...evidence,
    fingerprint: fingerprintCanonicalValue(evidence),
  });
};
