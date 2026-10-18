import {
  type FlowDefinition,
  type FlowTask,
  flowReadFieldsProjectionSchema,
  flowTaskChildLists,
} from "../../schema";
import { flowReadFieldsScalarTypeForField } from "../flow-compilation";
import type { JsonObject } from "./context";
import { object, array } from "./helpers";
import { typedValueMatchesType } from "./field-types";

export function permissionRecordScopesValid(
  permissions: readonly JsonObject[],
  records: ReadonlyMap<string, JsonObject>,
  relationships: ReadonlyMap<string, JsonObject>,
  sharingConditions: ReadonlyMap<string, JsonObject> = new Map(),
  savedConditionsAllowed = false,
  availablePermissions: readonly JsonObject[] = permissions,
): boolean {
  const permissionsById = new Map(
    availablePermissions.map((permission) => [String(permission.permissionId), permission]),
  );
  const relationshipSources = new Map<string, string[]>();
  let valid = true;
  for (const permission of permissions) {
    const recordTypeId =
      permission.recordTypeId === undefined ? undefined : String(permission.recordTypeId);
    const scope = permission.recordScope ? object(permission.recordScope) : undefined;
    const fieldPolicy = permission.fieldPolicy ? object(permission.fieldPolicy) : undefined;
    if (
      (recordTypeId === undefined) !== (scope === undefined) ||
      (recordTypeId === undefined) !== (fieldPolicy === undefined)
    ) {
      valid = false;
      continue;
    }
    if (!scope || !fieldPolicy || recordTypeId === undefined) continue;
    const record = records.get(recordTypeId);
    if (!record) {
      valid = false;
      continue;
    }
    const fieldIds = new Set(array(record.fields).map((field) => String(field.fieldId)));
    if (
      [...array(fieldPolicy.readableFieldIds), ...array(fieldPolicy.changeableFieldIds)].some(
        (fieldId) => !fieldIds.has(String(fieldId)),
      )
    )
      valid = false;
    const sources: string[] = [];
    for (const route of array(scope.routes)) {
      if (route.kind === "ownership" && record.ownershipMode === "none") valid = false;
      if (route.kind !== "relationship") continue;
      const relationship = relationships.get(String(route.relationshipId));
      const sourcePermission = permissionsById.get(String(route.sourcePermissionId));
      const targets = relationship?.toRecordType
        ? [relationship.toRecordType]
        : array(relationship?.toRecordTypes);
      if (
        !relationship ||
        !sourcePermission ||
        sourcePermission.actionKind !== "read" ||
        String(sourcePermission.recordTypeId) !== String(relationship.fromRecordTypeId) ||
        !targets.some(
          (target) =>
            object(target).state === "resolved" &&
            String(object(target).recordTypeId) === recordTypeId,
        )
      )
        valid = false;
      else sources.push(String(sourcePermission.permissionId));
    }
    relationshipSources.set(String(permission.permissionId), sources);
    const restriction = scope.savedCondition ? object(scope.savedCondition) : undefined;
    if (!restriction) continue;
    const saved = sharingConditions.get(String(restriction.conditionId));
    const declaredParameters = new Map(
      saved
        ? array(saved.parameters).map(
            (parameter) => [String(parameter.key), String(parameter.type)] as const,
          )
        : [],
    );
    const bindings = array(restriction.parameterBindings);
    if (
      !savedConditionsAllowed ||
      !saved ||
      String(saved.sourceRecordTypeId) !== recordTypeId ||
      saved.publishedRevision !== restriction.publishedRevision ||
      saved.contractFingerprint !== restriction.contractFingerprint ||
      bindings.length !== declaredParameters.size ||
      new Set(bindings.map((binding) => String(binding.key))).size !== bindings.length ||
      bindings.some((binding) => {
        const expected = declaredParameters.get(String(binding.key));
        return (
          expected === undefined ||
          (binding.source === "current_organization_account_id"
            ? !["text", "organization_account_reference", "record_reference"].includes(expected)
            : !typedValueMatchesType(binding.value, expected))
        );
      })
    )
      valid = false;
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (permissionId: string): boolean => {
    if (visiting.has(permissionId)) return false;
    if (visited.has(permissionId)) return true;
    visiting.add(permissionId);
    const acyclic = (relationshipSources.get(permissionId) ?? []).every(visit);
    visiting.delete(permissionId);
    visited.add(permissionId);
    return acyclic;
  };
  if (!permissions.map((permission) => String(permission.permissionId)).every(visit)) valid = false;
  return valid;
}

export function readFieldsTypeMapsValid(
  flows: readonly FlowDefinition[],
  recordTypes: readonly JsonObject[],
): boolean {
  let valid = true;
  const inspect = (tasks: readonly FlowTask[]): void => {
    for (const task of tasks) {
      if (task.type === "record.read_fields") {
        const recordTypeValue = object(task.properties.record_type);
        const recordTypeId =
          recordTypeValue.kind === "literal" &&
          object(recordTypeValue.literal).type === "text" &&
          typeof object(recordTypeValue.literal).value === "string"
            ? String(object(recordTypeValue.literal).value)
            : undefined;
        const fieldsValue = object(task.properties.fields);
        const projection =
          fieldsValue.kind === "literal" && object(fieldsValue.literal).type === "json"
            ? flowReadFieldsProjectionSchema.safeParse(object(fieldsValue.literal).value)
            : undefined;
        const typeMap = task.readFieldTypes;
        const recordMatches = recordTypes.filter(
          (record) => String(record.recordTypeId) === recordTypeId,
        );
        if (
          recordTypeId === undefined ||
          recordMatches.length !== 1 ||
          !projection?.success ||
          typeMap === undefined ||
          Object.keys(typeMap).length !== projection.data.length ||
          projection.data.some((entry) => !Object.hasOwn(typeMap, entry.alias))
        ) {
          valid = false;
        } else {
          const selectedFieldIds = new Set<string>();
          for (const entry of projection.data) {
            const matches = recordTypes.flatMap((record) =>
              array(record.fields)
                .filter((field) => String(field.fieldId) === entry.field)
                .map((field) => ({ field, recordTypeId: String(record.recordTypeId) })),
            );
            const scalarType =
              matches.length === 1 && matches[0]!.recordTypeId === recordTypeId
                ? flowReadFieldsScalarTypeForField(String(object(matches[0]!.field).type))
                : undefined;
            if (
              selectedFieldIds.has(entry.field) ||
              matches.length !== 1 ||
              scalarType === undefined ||
              typeMap[entry.alias] !== scalarType
            )
              valid = false;
            selectedFieldIds.add(entry.field);
          }
        }
      }
      for (const child of flowTaskChildLists(task)) inspect(child.tasks);
    }
  };
  for (const flow of flows) {
    inspect(flow.tasks);
    inspect(flow.errors);
    inspect(flow.finally);
  }
  return valid;
}
