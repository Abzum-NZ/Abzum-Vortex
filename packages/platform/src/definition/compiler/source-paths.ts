import {
  applicationSourceDocumentSchema,
  jsonValueSchema,
  walkDefinitionContract,
  definitionSourceDocumentSchema,
  moduleSourceDocumentSchema,
  sourceProvenanceRegistry,
  type SourceProvenanceAnnotation,
} from "../../schema";
import {
  asObject,
  camelCase,
  fail,
  type JsonObject,
  type Path,
  pathExists,
  pathStartsWith,
  valueAtPath,
} from "./shared";

const sourceCollectionIdKeys: Readonly<Record<string, string>> = Object.freeze({
  record_types: "recordTypeId",
  fields: "fieldId",
  relationships: "relationshipId",
  permissions: "permissionId",
  actions: "actionId",
  events: "eventId",
  extension_points: "extensionPointId",
  sharing_conditions: "conditionId",
  roles: "roleId",
  navigation: "id",
  queries: "queryId",
  contributions: "contributionId",
  block_registrations: "blockId",
  placements: "placementId",
  pages: "pageId",
  steps: "id",
  nodes: "nodeId",
  edges: "edgeId",
  pipelines: "pipelineId",
  connection_bindings: "bindingId",
  interfaces: "interfaceId",
  operations: "operationId",
  public_addresses: "addressId",
});

const directSourceKeyMap: Readonly<Record<string, string>> = Object.freeze({
  storage_contract_id: "storageContractId",
  title_field: "titleFieldId",
  ownership_relationship: "ownershipRelationshipId",
  organization_field: "organizationFieldId",
  revision_field: "revisionFieldId",
  filterable_fields: "filterableFieldIds",
  sortable_fields: "sortableFieldIds",
  protected_view: "protectedView",
  protected_operation: "protectedOperation",
  from_field: "fromFieldId",
  field: "fieldId",
  declared_fields: "declaredFieldIds",
  source_record_type: "sourceRecordTypeId",
  home_page: "homePageId",
  connection_type: "connectionTypeId",
  activity: "activityKey",
  application_root_required: "applicationRootIdRequired",
  permission: "permissionKey",
  permission_alternatives: "permissionKeys",
  required_permission: "requiredPermissionId",
  sets_choice_field: "setsChoiceFieldId",
  stage_field: "stageFieldId",
  event: "eventKey",
  message: "messageKey",
  component: "componentId",
  workflow: "workflowId",
  target_input: "targetInputKey",
  page: "pageId",
  query: "queryId",
  block: "blockId",
  connection: "connectionBindingId",
  node: "nodeId",
  relationship: "relationshipId",
  action: "actionKey",
  formatter: "formatterKey",
  responder_permission: "responderPermissionKey",
  view_permission: "viewPermissionKey",
  use_permission: "usePermissionKey",
  public_action: "publicActionKey",
  secret_fields: "secretFieldKeys",
});

export type SourceContractPositions = {
  opaqueDataRoots: readonly Path[];
  recordRoots: readonly Path[];
  provenanceTargets: readonly Readonly<{
    sourcePath: Path;
    annotation: SourceProvenanceAnnotation;
  }>[];
};

export function sourceContractPositions(source: JsonObject): SourceContractPositions {
  const opaqueDataRoots: Path[] = [];
  const recordRoots: Path[] = [];
  const provenanceTargets: {
    sourcePath: Path;
    annotation: SourceProvenanceAnnotation;
  }[] = [];
  const contract =
    source.kind === "module"
      ? moduleSourceDocumentSchema
      : source.kind === "application"
        ? applicationSourceDocumentSchema
        : definitionSourceDocumentSchema;
  walkDefinitionContract(contract, source, (schema, _value, path) => {
    if (schema === jsonValueSchema) opaqueDataRoots.push(path as Path);
    if (schema._zod.def.type === "record") recordRoots.push(path as Path);
    const annotation = sourceProvenanceRegistry.get(schema);
    if (annotation) provenanceTargets.push({ sourcePath: path as Path, annotation });
  });
  return { opaqueDataRoots, recordRoots, provenanceTargets };
}

export const isOpaqueDataPath = (positions: SourceContractPositions, path: Path) =>
  positions.opaqueDataRoots.some((root) => path.length > root.length && pathStartsWith(path, root));

const isDataProperty = (positions: SourceContractPositions, path: Path, propertyIndex: number) =>
  positions.opaqueDataRoots.some(
    (root) => propertyIndex >= root.length && pathStartsWith(path, root),
  ) ||
  positions.recordRoots.some((root) => propertyIndex === root.length && pathStartsWith(path, root));

function dynamicMapKeyPosition(sourcePath: Path): number | undefined {
  const normalized = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment));
  const path = normalized.join("/");
  const markers = [
    "/tasks/#/properties/values/",
    "/publication_tests/#/field_values/",
    "/publication_tests/#/parameters/",
    "/nodes/#/config/values/",
    "/nodes/#/config/inputs/",
    "/operations/#/input_shape/",
    "/operations/#/output_shape/",
  ];
  const marker = markers.find((candidate) => path.includes(candidate));
  if (!marker) return undefined;
  const prefix = path.slice(0, path.indexOf(marker) + marker.length);
  return prefix.split("/").length - 1;
}

function resolveDynamicMapPath(
  source: JsonObject,
  canonical: unknown,
  sourcePath: Path,
  proposed: Path,
): Path {
  const keyPosition = dynamicMapKeyPosition(sourcePath);
  if (keyPosition === undefined || typeof sourcePath[keyPosition] !== "string") return proposed;
  const sourceContainerPath = sourcePath.slice(0, keyPosition);
  const canonicalContainerPath = proposed.slice(0, keyPosition);
  if (!pathExists(canonical, canonicalContainerPath)) return proposed;
  const sourceContainer = asObject(valueAtPath(source, sourceContainerPath));
  const canonicalContainer = asObject(valueAtPath(canonical, canonicalContainerPath));
  const sourceKeys = Object.keys(sourceContainer);
  const keyOffset = sourceKeys.indexOf(String(sourcePath[keyPosition]));
  const canonicalKeys = Object.keys(canonicalContainer);
  if (keyOffset < 0 || sourceKeys.length !== canonicalKeys.length)
    fail("vortex.definition.invalid_compilation_output", "invalid_value");
  return [
    ...proposed.slice(0, keyPosition),
    canonicalKeys[keyOffset]!,
    ...proposed.slice(keyPosition + 1),
  ];
}

export function sourceToCanonicalPath(
  source: JsonObject,
  canonical: unknown,
  sourcePath: Path,
  positions: SourceContractPositions,
): Path {
  if (
    source.kind === "application" &&
    sourcePath.length === 4 &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "pages" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "replaces_page"
  )
    return ["content", "pages", sourcePath[2], "replacementOfPageId"];
  if (sourcePath.length === 1 && sourcePath[0] === "root_alias")
    return source.kind === "connection_type" ? ["connectionTypeId"] : ["envelope", "rootId"];
  if (sourcePath.length === 1 && sourcePath[0] === "key")
    return source.kind === "connection_type" ? ["key"] : ["envelope", "key"];
  if (sourcePath.length === 1 && sourcePath[0] === "kind")
    return source.kind === "connection_type" ? [] : ["envelope", "kind"];
  const mapped: Path = source.kind === "connection_type" ? [] : ["content"];
  const bodyIndex = sourcePath[0] === "body" ? 1 : 0;
  let collection: string | undefined;
  for (const [offset, segment] of sourcePath.slice(bodyIndex).entries()) {
    if (typeof segment === "number") {
      mapped.push(segment);
      continue;
    }
    const sourceIndex = bodyIndex + offset;
    // A flow value's `trigger_record.field` names a readable field key, not a permanent identity,
    // so it never takes the field-to-identity suffix map.
    const flowReferenceField = segment === "field" && sourcePath[sourceIndex - 1] === "reference";
    const mappedKey =
      isDataProperty(positions, sourcePath, sourceIndex) || flowReferenceField
        ? segment
        : segment === "id" && collection
          ? (sourceCollectionIdKeys[collection] ?? "id")
          : (directSourceKeyMap[segment] ?? camelCase(segment));
    mapped.push(mappedKey);
    collection = segment;
  }
  if (source.kind === "module") {
    const leaf = sourcePath.at(-1);
    if (leaf === "record_type") mapped[mapped.length - 1] = "recordTypeId";
    if (leaf === "record_id") mapped[mapped.length - 1] = "recordId";
    if (leaf === "organization_account_id") mapped[mapped.length - 1] = "organizationAccountId";
  }
  if (isOpaqueDataPath(positions, sourcePath))
    return resolveDynamicMapPath(source, canonical, sourcePath, mapped);
  if (
    source.kind === "application" &&
    sourcePath.at(-2) === "target_binding" &&
    sourcePath.at(-1) === "field"
  )
    mapped[mapped.length - 1] = "fieldId";
  return resolveDynamicMapPath(source, canonical, sourcePath, mapped);
}
