import type { DefinitionCompilationOutput } from "../definition-compilation-contracts";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "../canonical-json-definition";
import type { Resolution } from "./resolution";
import { compatibleVersion } from "./resolution";
import {
  applicationModuleKeysOf,
  asObject,
  CURRENT_MODULE_RELEASE,
  fail,
  type JsonObject,
} from "./shared";
import {
  type ModuleValueContext,
  normaliseExact,
  normaliseModuleTypedValue,
  normaliseMoney,
} from "./values";
import { moduleDependencies } from "../module-dependencies";

const permissionScopeRouteRank: Readonly<Record<string, number>> = {
  all_records: 0,
  ownership: 1,
  direct_share: 2,
  relationship: 3,
};

const compiledPermissionScopeRouteIdentity = (route: JsonObject): string =>
  route.kind === "relationship"
    ? `${permissionScopeRouteRank.relationship}:${String(route.relationshipId).toLowerCase()}:${String(route.sourcePermissionId).toLowerCase()}`
    : `${permissionScopeRouteRank[String(route.kind)]}:`;

export function permissionScopeSourceOwners(source: JsonObject): string[] {
  const body = asObject(source.body);
  return source.kind === "module"
    ? [String(source.key)]
    : [String(source.key), ...applicationModuleKeysOf(body)];
}

export function moduleFieldPermissionSourceOwners(source: JsonObject): string[] {
  return [String(source.key), ...moduleDependencies(source).map((dependency) => dependency.module)];
}

export function compilePermissionRecordScope(
  permission: JsonObject,
  source: JsonObject,
  resolution: Resolution,
  sharingConditions: readonly JsonObject[] = [],
  valueContext?: ModuleValueContext,
): unknown | undefined {
  if (permission.record_scope === undefined) return undefined;
  const sourceScope = asObject(permission.record_scope);
  const routes = (sourceScope.routes as JsonObject[])
    .map((route) => {
      if (route.kind !== "relationship") return { kind: route.kind };
      const relationship = String(route.relationship);
      const separator = relationship.lastIndexOf(".");
      if (separator < 1) fail("vortex.definition.invalid_compilation_output", "invalid_value");
      return {
        kind: "relationship",
        relationshipId: resolution.relationship(
          relationship.slice(0, separator),
          relationship.slice(separator + 1),
        ),
        sourcePermissionId: resolution.permission(
          String(route.source_permission),
          permissionScopeSourceOwners(source),
        ),
      };
    })
    .sort((left, right) =>
      compareCanonicalStrings(
        compiledPermissionScopeRouteIdentity(left),
        compiledPermissionScopeRouteIdentity(right),
      ),
    );
  if (sourceScope.saved_condition === undefined) return { routes };
  const sourceCondition = asObject(sourceScope.saved_condition);
  const conditionKey = String(sourceCondition.condition);
  const matches = sharingConditions.filter((condition) => condition.key === conditionKey);
  if (matches.length !== 1)
    fail("vortex.definition.saved_condition_revision_required", "unresolved_reference");
  const saved = matches[0]!;
  const parameterTypes = new Map(
    ((saved.parameters as JsonObject[]) ?? []).map((parameter) => [
      String(parameter.key),
      String(parameter.type),
    ]),
  );
  const parameterBindings = (sourceCondition.parameter_bindings as JsonObject[])
    .map((binding) => ({
      key: binding.key,
      source: binding.source,
      ...(binding.source === "literal"
        ? {
            value: valueContext
              ? normaliseModuleTypedValue(
                  parameterTypes.get(String(binding.key)),
                  binding.value,
                  valueContext,
                )
              : parameterTypes.get(String(binding.key)) === "decimal_number"
                ? normaliseExact(binding.value)
                : parameterTypes.get(String(binding.key)) === "money"
                  ? normaliseMoney(binding.value)
                  : binding.value,
          }
        : {}),
    }))
    .sort((left, right) => compareCanonicalStrings(String(left.key), String(right.key)));
  return {
    routes,
    savedCondition: {
      conditionId: saved.conditionId,
      publishedRevision: saved.publishedRevision,
      contractFingerprint: saved.contractFingerprint,
      parameterBindings,
    },
  };
}

export function compilePermissionFieldPolicy(
  permission: JsonObject,
  source: JsonObject,
  resolution: Resolution,
): unknown | undefined {
  if (permission.field_policy === undefined) return undefined;
  if (permission.record_type === undefined)
    fail("vortex.definition.invalid_compilation_output", "invalid_value");
  const recordType = String(permission.record_type);
  const policy = asObject(permission.field_policy);
  const resolveFields = (aliases: unknown): string[] =>
    (aliases as string[])
      .map((alias) =>
        resolution.field(
          source.kind === "module" ? `${String(source.key)}:${recordType}` : recordType,
          alias,
        ),
      )
      .sort(compareCanonicalStrings);
  return {
    readableFieldIds: resolveFields(policy.readable_fields),
    changeableFieldIds: resolveFields(policy.changeable_fields),
  };
}

export function applicationPermissionSharingConditions(
  permission: JsonObject,
  source: JsonObject,
  resolution: Resolution,
  organizationId: unknown,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): readonly JsonObject[] {
  if (permission.record_scope === undefined) return [];
  const sourceScope = asObject(permission.record_scope);
  if (sourceScope.saved_condition === undefined) return [];
  if (permission.record_type === undefined)
    fail("vortex.definition.saved_condition_revision_required", "unresolved_reference");
  const qualifiedRecordType = String(permission.record_type);
  const separator = qualifiedRecordType.lastIndexOf(":");
  if (separator < 1)
    fail("vortex.definition.saved_condition_revision_required", "unresolved_reference");
  const moduleKey = qualifiedRecordType.slice(0, separator);
  const expectedModule = resolution.definition(moduleKey, "module");
  const recordType = resolution.recordType(qualifiedRecordType);
  const bindings = applicationModuleKeysOf(asObject(source.body)).filter(
    (key) => key === moduleKey,
  );
  const matches = dependencyOutputs.filter(
    (output) => output.kind === "module" && output.artifact.definitionKey === moduleKey,
  );
  if (bindings.length !== 1 || matches.length !== 1)
    fail("vortex.definition.saved_condition_revision_required", "unresolved_reference");
  const requirement = CURRENT_MODULE_RELEASE;
  const output = matches[0]!;
  if (output.kind !== "module")
    fail("vortex.definition.saved_condition_revision_required", "unresolved_reference");
  const canonical = asObject(output.canonical);
  const envelope = asObject(canonical.envelope);
  const content = asObject(canonical.content);
  const records = (content.recordTypes as JsonObject[]).filter(
    (record) => record.recordTypeId === recordType.recordTypeId,
  );
  if (
    expectedModule.rootId !== recordType.moduleRootId ||
    !compatibleVersion(requirement, expectedModule.exactVersion) ||
    output.artifact.rootId !== expectedModule.rootId ||
    output.artifact.exactVersion !== expectedModule.exactVersion ||
    output.artifact.resolutionFingerprint !== output.resolutionFingerprint ||
    envelope.rootId !== expectedModule.rootId ||
    envelope.key !== moduleKey ||
    envelope.organizationId !== organizationId ||
    output.artifact.contentFingerprint !== fingerprintCanonicalValue(content) ||
    records.length !== 1
  )
    fail("vortex.definition.saved_condition_revision_required", "unresolved_reference");
  return content.sharingConditions as JsonObject[];
}

/**
 * A calculation that uses a read-time calculation is itself read-time, so a calculation that does
 * not author its evaluation inherits read-time from its same-record dependencies. An authored
 * `stored` evaluation is kept, and publication refuses it when it depends on a read-time field.
 */
export function inheritReadTimeEvaluation<
  T extends { fieldId: string; type: unknown; settings: unknown },
>(sourceFields: readonly JsonObject[], fields: readonly T[]): T[] {
  const readTime = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    fields.forEach((field, index) => {
      if (field.type !== "calculation" || readTime.has(field.fieldId)) return;
      const settings = asObject(field.settings);
      const inherits =
        asObject(sourceFields[index]?.settings).evaluation === undefined &&
        (settings.dependencyFieldIds as string[]).some((fieldId) => readTime.has(fieldId));
      if (settings.evaluation === "read_time" || inherits) {
        readTime.add(field.fieldId);
        changed = true;
      }
    });
  }
  return fields.map((field) =>
    readTime.has(field.fieldId)
      ? { ...field, settings: { ...asObject(field.settings), evaluation: "read_time" } }
      : field,
  );
}
