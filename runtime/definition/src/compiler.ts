import { createHash } from "node:crypto";
import { satisfies } from "semver";
import {
  applicationDraftSchema,
  connectionTypeSchema,
  definitionCompilationOutputSchema,
  definitionCompilationRequestSchema,
  moduleDraftSchema,
  type DefinitionCompilationOutput,
  type DefinitionProvenanceEntry,
  type DefinitionResolutionSnapshot,
  type DefinitionSourceDocument,
  type DefinitionValidationLocation,
} from "@vortex/contracts";
import {
  canonicalJson,
  compareCanonicalStrings,
  fingerprintCanonicalValue,
} from "./canonical-json";
import {
  DefinitionCompilationError,
  type DefinitionCompilerRefusalCode,
} from "./compilation-error";
import { extractSourceIdentityRequirements } from "./source-identities";

type Path = (string | number)[];
type JsonObject = Record<string, unknown>;

const ID_FIELDS = new Set([
  "root_alias",
  "id",
  "storage_contract_id",
  "title_field",
  "ownership_relationship",
  "from_field",
  "record_type",
  "source_record_type",
  "declared_fields",
  "page",
  "query",
  "block",
  "home_page",
  "connection",
]);

const DEFAULT_RULE = "vortex.definition.fixed_execution_default";
const SYSTEM_RULE = "vortex.definition.system_metadata";
const RESOLUTION_RULE = "vortex.definition.immutable_resolution";
const TRANSFORM_RULE = "vortex.definition.semantic_transform";
const MUTATING_WORKFLOW_NODES = new Set([
  "create_record",
  "change_record",
  "run_action",
  "soft_delete_record",
  "duplicate_record",
  "add_relationship",
  "copy_relationships",
  "request_form",
  "set_values",
  "start_workflow",
  "generate_export",
  "attach_file",
  "move_file",
  "call_connection",
  "acknowledge_message",
]);

export const workflowExecutionDefaults = Object.freeze({
  contractVersion: "1.0.0",
  timeoutSeconds: 300,
  retry: Object.freeze({
    maximumAttempts: 3,
    initialDelaySeconds: 1,
    maximumDelaySeconds: 30,
    backoff: "exponential" as const,
  }),
  redaction: "no_payload" as const,
});

function fail(
  ruleCode: DefinitionCompilerRefusalCode,
  family: ConstructorParameters<typeof DefinitionCompilationError>[1],
  location?: DefinitionValidationLocation,
): never {
  throw new DefinitionCompilationError(ruleCode, family, location);
}

function compilerRootLocation(source: JsonObject): DefinitionValidationLocation {
  const documentKind = source.kind as "module" | "application" | "connection_type";
  const documentKey = String(source.key);
  return {
    documentKind,
    documentKey,
    segments: [
      {
        kind:
          documentKind === "module"
            ? "module"
            : documentKind === "application"
              ? "application"
              : "connection",
        key: documentKey,
      },
    ],
  };
}

function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("vortex.definition.invalid_object", "invalid_value");
  return value as JsonObject;
}

function objectFromUniqueEntries(
  entries: Iterable<readonly [string, unknown]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (Object.prototype.hasOwnProperty.call(result, key))
      fail("vortex.definition.invalid_compilation_output", "duplicate_key");
    result[key] = value;
  }
  return result;
}

function leafPaths(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value))
    return value.flatMap((entry, index) => leafPaths(entry, [...path, index]));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, entry]) => leafPaths(entry, [...path, key]));
  return [path];
}

const sourceCollectionIdKeys: Readonly<Record<string, string>> = Object.freeze({
  record_types: "recordTypeId",
  fields: "fieldId",
  relationships: "relationshipId",
  permissions: "permissionId",
  actions: "actionId",
  rules: "ruleId",
  events: "eventId",
  extension_points: "extensionPointId",
  sharing_conditions: "conditionId",
  roles: "roleId",
  navigation: "id",
  queries: "queryId",
  block_registrations: "blockId",
  placements: "placementId",
  pages: "pageId",
  steps: "id",
  workflows: "workflowId",
  nodes: "nodeId",
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
  from_field: "fromFieldId",
  field: "fieldId",
  declared_fields: "declaredFieldIds",
  source_record_type: "sourceRecordTypeId",
  home_page: "homePageId",
  connection_type: "connectionTypeId",
  activity: "activityKey",
  application_root_required: "applicationRootIdRequired",
  permission: "permissionKey",
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
  commit_action: "commitActionKey",
  secret_fields: "secretFieldKeys",
});

const camelCase = (value: string) =>
  value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

function pathExists(value: unknown, path: Path): boolean {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      if (!(segment in current)) return false;
      current = current[segment];
      continue;
    }
    if (
      current === null ||
      typeof current !== "object" ||
      typeof segment !== "string" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    )
      return false;
    current = (current as JsonObject)[segment];
  }
  return true;
}

function valueAtPath(value: unknown, path: Path): unknown {
  let current = value;
  for (const segment of path) {
    current = Array.isArray(current)
      ? current[Number(segment)]
      : (current as JsonObject)[String(segment)];
  }
  return current;
}

function dynamicMapKeyPosition(sourcePath: Path): number | undefined {
  const normalized = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment));
  const path = normalized.join("/");
  const markers = [
    "/effects/#/values/",
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

function sourceToCanonicalPath(source: JsonObject, canonical: unknown, sourcePath: Path): Path {
  if (sourcePath.length === 1 && sourcePath[0] === "root_alias")
    return source.kind === "connection_type" ? ["connectionTypeId"] : ["envelope", "rootId"];
  if (sourcePath.length === 1 && sourcePath[0] === "key")
    return source.kind === "connection_type" ? ["key"] : ["envelope", "key"];
  if (sourcePath.length === 1 && sourcePath[0] === "kind")
    return source.kind === "connection_type" ? [] : ["envelope", "kind"];
  const mapped: Path = source.kind === "connection_type" ? [] : ["content"];
  const bodyIndex = sourcePath[0] === "body" ? 1 : 0;
  let collection: string | undefined;
  for (const segment of sourcePath.slice(bodyIndex)) {
    if (typeof segment === "number") {
      mapped.push(segment);
      continue;
    }
    const mappedKey =
      segment === "id" && collection
        ? (sourceCollectionIdKeys[collection] ?? "id")
        : (directSourceKeyMap[segment] ?? camelCase(segment));
    mapped.push(mappedKey);
    collection = segment;
  }
  if (
    source.kind === "application" &&
    sourcePath.at(-2) === "target_binding" &&
    sourcePath.at(-1) === "field"
  )
    mapped[mapped.length - 1] = "fieldId";
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "actions" &&
    sourcePath.includes("effects") &&
    sourcePath.at(-1) === "input"
  )
    mapped[mapped.length - 1] = "inputKey";
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "workflows" &&
    sourcePath.includes("config") &&
    (sourcePath.includes("inputs") ||
      sourcePath.includes("values") ||
      ["input", "file", "record", "subject", "target", "source_record", "target_record"].includes(
        String(sourcePath.at(-2)),
      )) &&
    sourcePath.at(-1) === "output"
  )
    mapped[mapped.length - 1] = "outputKey";
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "workflows" &&
    sourcePath.includes("config") &&
    sourcePath.at(-1) === "operation"
  )
    mapped[mapped.length - 1] = "operationKey";
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "workflows" &&
    sourcePath.includes("config") &&
    sourcePath.at(-1) === "record_type"
  )
    mapped[mapped.length - 1] = "recordTypeId";
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "workflows" &&
    sourcePath[5] === "config" &&
    sourcePath[6] === "relationships"
  )
    mapped[6] = "relationshipIds";
  return resolveDynamicMapPath(source, canonical, sourcePath, mapped);
}

function applicationRolePermissionTargets(
  source: JsonObject,
  canonical: unknown,
  sourcePath: Path,
): Path[] | undefined {
  if (
    source.kind !== "application" ||
    sourcePath[0] !== "body" ||
    sourcePath[1] !== "roles" ||
    typeof sourcePath[2] !== "number" ||
    sourcePath[3] !== "permissions" ||
    typeof sourcePath[4] !== "number" ||
    sourcePath.length !== 5
  )
    return undefined;
  const rolePath: Path = ["content", "roles", sourcePath[2]];
  const sourceValue = valueAtPath(source, sourcePath);
  if (sourceValue === "*") {
    const permissionKeysPath = [...rolePath, "permissionKeys"];
    const selectionPath = [...rolePath, "permissionSelection"];
    return [
      ...leafPaths(valueAtPath(canonical, permissionKeysPath), permissionKeysPath),
      ...leafPaths(valueAtPath(canonical, selectionPath), selectionPath),
    ];
  }
  const targets: Path[] = [[...rolePath, "permissionKeys", sourcePath[4]]];
  if (sourcePath[4] === 0) targets.push([...rolePath, "permissionSelection", "kind"]);
  return targets;
}

function conditionRootPaths(
  source: JsonObject,
  sourcePath: Path,
): { sourceRoot: Path; canonicalRoot: Path } | undefined {
  const [body, collection, first] = sourcePath;
  if (body !== "body" || typeof first !== "number") return undefined;
  const fixedRoots: { sourceRoot: Path; canonicalRoot: Path }[] = [];
  if (collection === "actions")
    fixedRoots.push({
      sourceRoot: ["body", "actions", first, "precondition"],
      canonicalRoot: ["content", "actions", first, "precondition"],
    });
  if (collection === "rules")
    fixedRoots.push({
      sourceRoot: ["body", "rules", first, "condition"],
      canonicalRoot: ["content", "rules", first, "condition"],
    });
  if (collection === "sharing_conditions")
    fixedRoots.push({
      sourceRoot: ["body", "sharing_conditions", first, "condition"],
      canonicalRoot: ["content", "sharingConditions", first, "condition"],
    });
  if (collection === "queries")
    fixedRoots.push({
      sourceRoot: ["body", "queries", first, "filter"],
      canonicalRoot: ["content", "queries", first, "filter"],
    });
  if (collection === "record_types" && typeof sourcePath[4] === "number") {
    const base = ["body", "record_types", first, "fields", sourcePath[4], "settings"] as Path;
    const canonicalBase = [
      "content",
      "recordTypes",
      first,
      "fields",
      sourcePath[4],
      "settings",
    ] as Path;
    fixedRoots.push(
      { sourceRoot: [...base, "filter"], canonicalRoot: [...canonicalBase, "filter"] },
      {
        sourceRoot: [...base, "expression", "condition"],
        canonicalRoot: [...canonicalBase, "expression", "condition"],
      },
    );
  }
  if (collection === "pipelines" && typeof sourcePath[4] === "number")
    fixedRoots.push({
      sourceRoot: ["body", "pipelines", first, "transitions", sourcePath[4], "gate"],
      canonicalRoot: ["content", "pipelines", first, "transitions", sourcePath[4], "gate"],
    });
  if (collection === "workflows" && typeof sourcePath[4] === "number") {
    const node = (asObject(source.body).workflows as JsonObject[])[first]?.nodes as JsonObject[];
    if (node?.[sourcePath[4]]?.type === "condition")
      fixedRoots.push({
        sourceRoot: ["body", "workflows", first, "nodes", sourcePath[4], "config"],
        canonicalRoot: [
          "content",
          "workflows",
          first,
          "nodes",
          sourcePath[4],
          "config",
          "condition",
        ],
      });
    if (typeof sourcePath[7] === "number")
      fixedRoots.push({
        sourceRoot: [
          "body",
          "workflows",
          first,
          "nodes",
          sourcePath[4],
          "config",
          "decisions",
          sourcePath[7],
          "when",
        ],
        canonicalRoot: [
          "content",
          "workflows",
          first,
          "nodes",
          sourcePath[4],
          "config",
          "decisions",
          sourcePath[7],
          "when",
        ],
      });
  }
  if (collection === "workflows")
    fixedRoots.push({
      sourceRoot: ["body", "workflows", first, "trigger", "condition"],
      canonicalRoot: ["content", "workflows", first, "trigger", "condition"],
    });
  if (collection === "pages") {
    if (sourcePath[3] === "blocks" && typeof sourcePath[4] === "number")
      fixedRoots.push({
        sourceRoot: ["body", "pages", first, "blocks", sourcePath[4], "visibility_condition"],
        canonicalRoot: ["content", "pages", first, "blocks", sourcePath[4], "visibilityCondition"],
      });
    if (
      sourcePath[3] === "steps" &&
      typeof sourcePath[4] === "number" &&
      sourcePath[5] === "blocks" &&
      typeof sourcePath[6] === "number"
    )
      fixedRoots.push({
        sourceRoot: [
          "body",
          "pages",
          first,
          "steps",
          sourcePath[4],
          "blocks",
          sourcePath[6],
          "visibility_condition",
        ],
        canonicalRoot: [
          "content",
          "pages",
          first,
          "steps",
          sourcePath[4],
          "blocks",
          sourcePath[6],
          "visibilityCondition",
        ],
      });
  }
  return fixedRoots.find(
    ({ sourceRoot }) =>
      sourceRoot.length <= sourcePath.length &&
      sourceRoot.every((segment, index) => sourcePath[index] === segment),
  );
}

function conditionSourceTargets(source: JsonObject, sourcePath: Path): Path[] | undefined {
  const roots = conditionRootPaths(source, sourcePath);
  if (!roots) return undefined;
  let node = valueAtPath(source, roots.sourceRoot);
  let suffix = sourcePath.slice(roots.sourceRoot.length);
  const canonicalPath = [...roots.canonicalRoot];
  const targets: Path[] = [];
  while (node !== null && typeof node === "object" && !Array.isArray(node)) {
    const object = node as JsonObject;
    if ("all" in object || "any" in object) {
      const branch = "all" in object ? "all" : "any";
      if (suffix[0] !== branch || typeof suffix[1] !== "number") return undefined;
      const firstLeaf = leafPaths(node)[0];
      if (firstLeaf && pathKey(firstLeaf) === pathKey(suffix))
        targets.push([...canonicalPath, "kind"]);
      node = (object[branch] as unknown[])[suffix[1]];
      canonicalPath.push("conditions", suffix[1]);
      suffix = suffix.slice(2);
      continue;
    }
    if ("not" in object) {
      if (suffix[0] !== "not") return undefined;
      const firstLeaf = leafPaths(node)[0];
      if (firstLeaf && pathKey(firstLeaf) === pathKey(suffix))
        targets.push([...canonicalPath, "kind"]);
      node = object.not;
      canonicalPath.push("condition");
      suffix = suffix.slice(1);
      continue;
    }
    break;
  }
  if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
  const comparison = asObject(node);
  if (suffix[0] === "operator")
    return [...targets, [...canonicalPath, "kind"], [...canonicalPath, "operator"]];
  if (suffix[0] === "field")
    return [
      ...targets,
      [...canonicalPath, "left", "source"],
      [...canonicalPath, "left", "fieldId"],
    ];
  if (suffix[0] === "parameter")
    return [...targets, [...canonicalPath, "right", "source"], [...canonicalPath, "right", "key"]];
  if (suffix[0] === "value")
    return [
      ...targets,
      ...(pathKey(leafPaths(comparison.value, ["value"])[0] ?? []) === pathKey(suffix)
        ? [[...canonicalPath, "right", "source"] as Path]
        : []),
      [...canonicalPath, "right", "value", ...suffix.slice(1)],
    ];
  if ((suffix[0] === "left" || suffix[0] === "right") && typeof suffix[1] === "string") {
    const operandPath = [...canonicalPath, suffix[0]];
    const mappedKey =
      suffix[1] === "field" ? "fieldId" : suffix[1] === "parameter" ? "key" : suffix[1];
    return [...targets, [...operandPath, mappedKey, ...suffix.slice(2)]];
  }
  return undefined;
}

function explicitSourceTargets(
  source: JsonObject,
  canonical: unknown,
  sourcePath: Path,
): Path[] | undefined {
  const conditionTargets = conditionSourceTargets(source, sourcePath);
  if (conditionTargets) {
    if (
      source.kind === "module" &&
      sourcePath[0] === "body" &&
      sourcePath[1] === "record_types" &&
      typeof sourcePath[2] === "number" &&
      sourcePath[3] === "fields" &&
      typeof sourcePath[4] === "number" &&
      sourcePath[5] === "settings" &&
      sourcePath[6] === "expression" &&
      sourcePath[7] === "condition" &&
      sourcePath.at(-1) === "field"
    ) {
      const fieldTarget = conditionTargets.find((target) => target.at(-1) === "fieldId");
      const dependencyPath: Path = [
        "content",
        "recordTypes",
        sourcePath[2],
        "fields",
        sourcePath[4],
        "settings",
        "dependencyFieldIds",
      ];
      const dependencies = valueAtPath(canonical, dependencyPath) as unknown[];
      const dependencyIndex = fieldTarget
        ? dependencies.indexOf(valueAtPath(canonical, fieldTarget))
        : -1;
      return dependencyIndex >= 0
        ? [...conditionTargets, [...dependencyPath, dependencyIndex]]
        : conditionTargets;
    }
    return conditionTargets;
  }
  const roleTargets = applicationRolePermissionTargets(source, canonical, sourcePath);
  if (roleTargets) return roleTargets;
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "actions" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "inputs" &&
    typeof sourcePath[4] === "number" &&
    sourcePath[5] === "record_types" &&
    typeof sourcePath[6] === "number" &&
    sourcePath.length === 7
  ) {
    const targetPath: Path = [
      "content",
      "actions",
      sourcePath[2],
      "inputs",
      sourcePath[4],
      "recordTypes",
      sourcePath[6],
    ];
    return leafPaths(valueAtPath(canonical, targetPath), targetPath);
  }
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "actions" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "effects" &&
    typeof sourcePath[4] === "number" &&
    sourcePath[5] === "record_type" &&
    sourcePath.length === 6
  ) {
    const targetPath: Path = [
      "content",
      "actions",
      sourcePath[2],
      "effects",
      sourcePath[4],
      "recordType",
    ];
    return leafPaths(valueAtPath(canonical, targetPath), targetPath);
  }
  if (source.kind === "connection_type" && sourcePath[0] === "body") {
    const connectionKeys: Readonly<Record<string, string>> = {
      path: "pathTemplate",
      input: "inputShapeKey",
      output: "outputShapeKey",
      max_attempts: "maximumAttempts",
      workflow_trigger: "workflowTriggerKey",
      health_operation: "healthOperationKey",
      revocation_operation: "revocationOperationKey",
    };
    const mappedKey = connectionKeys[String(sourcePath.at(-1))];
    if (mappedKey) {
      const proposed = sourceToCanonicalPath(source, canonical, sourcePath);
      proposed[proposed.length - 1] = mappedKey;
      return [proposed];
    }
  }
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "workflows" &&
    sourcePath.includes("config") &&
    sourcePath.at(-1) === "input" &&
    asObject(valueAtPath(source, sourcePath.slice(0, -1))).source === "trigger_input"
  ) {
    const target = sourceToCanonicalPath(source, canonical, sourcePath);
    target[target.length - 1] = "inputKey";
    return [target];
  }
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "workflows" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "nodes" &&
    typeof sourcePath[4] === "number" &&
    sourcePath[5] === "config" &&
    sourcePath[6] === "field" &&
    sourcePath.length === 7
  ) {
    const workflows = asObject(source.body).workflows as JsonObject[];
    const node = (workflows[sourcePath[2]]?.nodes as JsonObject[] | undefined)?.[sourcePath[4]];
    if (node?.type === "wait_until")
      return [
        [
          "content",
          "workflows",
          sourcePath[2],
          "nodes",
          sourcePath[4],
          "config",
          "dateTimeFieldId",
        ],
      ];
  }
  if (
    source.kind === "module" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "dependencies" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "module" &&
    sourcePath.length === 4
  ) {
    const base: Path = ["content", "dependencies", sourcePath[2]];
    return ["moduleRootId", "moduleKey", "resolvedVersion"].map((key) => [...base, key]);
  }
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "pipelines" &&
    typeof sourcePath[2] === "number"
  ) {
    const pipelineBase: Path = ["content", "pipelines", sourcePath[2]];
    if (sourcePath[3] === "record_type" && sourcePath.length === 4) {
      const recordTypePath = [...pipelineBase, "recordType"];
      return leafPaths(valueAtPath(canonical, recordTypePath), recordTypePath);
    }
    if (sourcePath[3] === "stage_field" && sourcePath.length === 4)
      return [[...pipelineBase, "stageFieldId"]];
    if (
      sourcePath[3] === "stages" &&
      typeof sourcePath[4] === "number" &&
      typeof sourcePath[5] === "string" &&
      typeof sourcePath[6] === "number"
    ) {
      const targetCollection: Readonly<Record<string, string>> = {
        entry_actions: "entryActionKeys",
        exit_actions: "exitActionKeys",
        entry_workflows: "entryWorkflowIds",
        exit_workflows: "exitWorkflowIds",
      };
      const target = targetCollection[sourcePath[5]];
      if (target) return [[...pipelineBase, "stages", sourcePath[4], target, sourcePath[6]]];
    }
    if (
      sourcePath[3] === "time_targets" &&
      typeof sourcePath[4] === "number" &&
      typeof sourcePath[5] === "string"
    ) {
      const targetKey: Readonly<Record<string, string>> = {
        stage: "stageKey",
        field: "dateTimeFieldId",
        escalation_event: "escalationEventKey",
      };
      const target = targetKey[sourcePath[5]];
      if (target) return [[...pipelineBase, "timeTargets", sourcePath[4], target]];
    }
  }
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "workflows" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "nodes" &&
    typeof sourcePath[4] === "number" &&
    sourcePath[5] === "config" &&
    sourcePath[6] === "outputs" &&
    typeof sourcePath[7] === "number" &&
    sourcePath[8] === "record_types" &&
    typeof sourcePath[9] === "number"
  )
    return [
      [
        "content",
        "workflows",
        sourcePath[2],
        "nodes",
        sourcePath[4],
        "config",
        "outputs",
        sourcePath[7],
        "recordTypeIds",
        sourcePath[9],
      ],
    ];
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "workflows" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "edges" &&
    typeof sourcePath[4] === "number" &&
    typeof sourcePath[5] === "number" &&
    sourcePath.length === 6
  ) {
    const edgeKey = ["fromNodeId", "toNodeId", "outcome"][sourcePath[5]];
    return edgeKey
      ? [["content", "workflows", sourcePath[2], "edges", sourcePath[4], edgeKey]]
      : undefined;
  }
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "pages" &&
    typeof sourcePath[2] === "number"
  ) {
    const pageBase: Path = ["content", "pages", sourcePath[2]];
    if (sourcePath[3] === "permission" && sourcePath.length === 4)
      return [[...pageBase, "accessPermissionKey"]];
    if (sourcePath[3] === "record_type" && sourcePath.length === 4) {
      const recordTypePath = [...pageBase, "recordType"];
      return leafPaths(valueAtPath(canonical, recordTypePath), recordTypePath);
    }
    if (
      sourcePath[3] === "standard_page_replacement" &&
      sourcePath[4] === "record_type" &&
      sourcePath.length === 5
    ) {
      const recordTypePath = [...pageBase, "standardPageReplacement", "recordType"];
      return leafPaths(valueAtPath(canonical, recordTypePath), recordTypePath);
    }
    if (
      sourcePath[3] === "public_fields" &&
      typeof sourcePath[4] === "number" &&
      sourcePath.length === 5
    )
      return [[...pageBase, "publicFieldIds", sourcePath[4]]];
    if (sourcePath[3] === "calendar_mapping" && typeof sourcePath[4] === "string") {
      const calendarKey: Readonly<Record<string, string>> = {
        start: "startFieldId",
        end: "endFieldId",
        duration_field: "durationFieldId",
      };
      const key = calendarKey[sourcePath[4]];
      if (key)
        return [
          [...pageBase, "calendarMapping", key],
          ...(["end", "duration_field"].includes(String(sourcePath[4]))
            ? [[...pageBase, "calendarMapping", "kind"] as Path]
            : []),
        ];
    }
    const blockCoordinates =
      sourcePath[3] === "blocks" && typeof sourcePath[4] === "number"
        ? { canonical: [...pageBase, "blocks", sourcePath[4]] as Path, propertyIndex: 5 }
        : sourcePath[3] === "steps" &&
            typeof sourcePath[4] === "number" &&
            sourcePath[5] === "blocks" &&
            typeof sourcePath[6] === "number"
          ? {
              canonical: [...pageBase, "steps", sourcePath[4], "blocks", sourcePath[6]] as Path,
              propertyIndex: 7,
            }
          : undefined;
    if (blockCoordinates && sourcePath[blockCoordinates.propertyIndex] === "id")
      return [[...blockCoordinates.canonical, "placementId"]];
  }
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "workflows" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "trigger"
  ) {
    const triggerBase: Path = ["content", "workflows", sourcePath[2], "trigger"];
    if (sourcePath[4] === "record_type" && sourcePath.length === 5)
      return [[...triggerBase, "recordTypeId"]];
    if (sourcePath[4] === "operation" && sourcePath.length === 5)
      return [[...triggerBase, "operationKey"]];
    if (sourcePath[4] === "inputs" && typeof sourcePath[5] === "number" && sourcePath.length >= 7) {
      const inputBase: Path = [...triggerBase, "inputs", sourcePath[5]];
      if (sourcePath[6] === "record_types" && typeof sourcePath[7] === "number")
        return [[...inputBase, "recordTypeIds", sourcePath[7]]];
      if (sourcePath[6] === "source" && sourcePath[7] === "kind") return [[...inputBase, "source"]];
      if (sourcePath[6] === "source" && sourcePath[7] === "field")
        return [[...inputBase, "fieldId"]];
      if (sourcePath[6] === "source" && sourcePath[7] === "key")
        return [[...inputBase, "payloadKey"]];
    }
  }
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "queries" &&
    typeof sourcePath[2] === "number"
  ) {
    const base: Path = ["content", "queries", sourcePath[2]];
    if (sourcePath[3] === "record_type" && sourcePath.length === 4) {
      const recordTypePath = [...base, "recordType"];
      return leafPaths(valueAtPath(canonical, recordTypePath), recordTypePath);
    }
    if (sourcePath[3] === "select" && typeof sourcePath[4] === "number")
      return [[...base, "selectedFieldIds", sourcePath[4]]];
    if (sourcePath[3] === "group_by" && typeof sourcePath[4] === "number")
      return [[...base, "groupByFieldIds", sourcePath[4]]];
  }
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "module_bindings" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "module" &&
    sourcePath.length === 4
  )
    return [
      ["content", "moduleBindings", sourcePath[2], "moduleRootId"],
      ["content", "moduleBindings", sourcePath[2], "resolvedVersion"],
    ];
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "connection_bindings" &&
    typeof sourcePath[2] === "number"
  ) {
    const base: Path = ["content", "connectionBindings", sourcePath[2]];
    if (sourcePath[3] === "connection_type" && sourcePath.length === 4)
      return [
        [...base, "connectionTypeId"],
        [...base, "resolvedVersion"],
      ];
    if (
      sourcePath[3] === "required_operations" &&
      typeof sourcePath[4] === "number" &&
      sourcePath.length === 5
    )
      return [[...base, "requiredOperationKeys", sourcePath[4]]];
  }
  if (
    source.kind === "module" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "record_types" &&
    typeof sourcePath[2] === "number"
  ) {
    const base: Path = ["content", "recordTypes", sourcePath[2]];
    if (sourcePath.length === 4 && sourcePath[3] === "id") {
      const relationshipPath = [...base, "relationships"];
      return [
        [...base, "recordTypeId"],
        ...((valueAtPath(canonical, relationshipPath) as unknown[]) ?? []).map(
          (_relationship, index) => [...relationshipPath, index, "fromRecordTypeId"] as Path,
        ),
      ];
    }
    if (sourcePath.length === 4 && sourcePath[3] === "name") return [[...base, "singularLabel"]];
    if (sourcePath.length === 4 && sourcePath[3] === "plural_name")
      return [[...base, "pluralLabel"]];
    if (
      sourcePath[3] === "custom_actions" &&
      typeof sourcePath[4] === "number" &&
      sourcePath.length === 5
    )
      return [[...base, "customActionIds", sourcePath[4]]];
    if (
      sourcePath[3] === "relationships" &&
      typeof sourcePath[4] === "number" &&
      ((sourcePath[5] === "to_record_type" && sourcePath.length === 6) ||
        (sourcePath[5] === "to_record_types" &&
          typeof sourcePath[6] === "number" &&
          sourcePath.length === 7))
    ) {
      const relationshipTargetPath: Path = [
        ...base,
        "relationships",
        sourcePath[4],
        sourcePath[5] === "to_record_type" ? "toRecordType" : "toRecordTypes",
        ...(sourcePath[5] === "to_record_types" ? [sourcePath[6] as number] : []),
      ];
      return leafPaths(valueAtPath(canonical, relationshipTargetPath), relationshipTargetPath);
    }
    if (
      sourcePath[3] === "fields" &&
      typeof sourcePath[4] === "number" &&
      sourcePath[5] === "settings" &&
      sourcePath.length === 7 &&
      sourcePath[6] === "relationship"
    )
      return [[...base, "fields", sourcePath[4], "settings", "relationshipId"]];
    if (
      sourcePath[3] === "fields" &&
      typeof sourcePath[4] === "number" &&
      sourcePath[5] === "settings" &&
      ((sourcePath[6] === "target" && sourcePath.length === 7) ||
        (sourcePath[6] === "targets" &&
          typeof sourcePath[7] === "number" &&
          sourcePath.length === 8))
    ) {
      const targetPath: Path = [
        ...base,
        "fields",
        sourcePath[4],
        "settings",
        sourcePath[6],
        ...(sourcePath[6] === "targets" ? [sourcePath[7] as number] : []),
      ];
      return leafPaths(valueAtPath(canonical, targetPath), targetPath);
    }
    if (
      sourcePath[3] === "fields" &&
      typeof sourcePath[4] === "number" &&
      sourcePath[5] === "settings" &&
      sourcePath[6] === "expression"
    ) {
      const fieldBase: Path = [...base, "fields", sourcePath[4], "settings"];
      const expressionBase: Path = [...fieldBase, "expression"];
      if (sourcePath.length === 8 && sourcePath[7] === "operation")
        return [[...expressionBase, "kind"]];
      if (sourcePath.length === 8 && sourcePath[7] === "numeric_operation")
        return [[...expressionBase, "operation"]];
      if (
        sourcePath[7] === "fields" &&
        typeof sourcePath[8] === "number" &&
        sourcePath.length === 9
      )
        return [
          [...expressionBase, "fieldIds", sourcePath[8]],
          [...fieldBase, "dependencyFieldIds", sourcePath[8]],
        ];
      const dependencyByKey: Readonly<Record<string, number>> = {
        amount_field: 0,
        percentage_field: 1,
        date_field: 0,
        due_field: 0,
        status_field: 1,
      };
      if (sourcePath.length === 8 && typeof sourcePath[7] === "string") {
        const expressionKeyBySource: Readonly<Record<string, string>> = {
          amount_field: "amountFieldId",
          percentage_field: "percentageFieldId",
          date_field: "dateFieldId",
          due_field: "dueFieldId",
          status_field: "statusFieldId",
        };
        const expressionKey = expressionKeyBySource[sourcePath[7]];
        const dependencyIndex = dependencyByKey[sourcePath[7]];
        if (expressionKey !== undefined && dependencyIndex !== undefined)
          return [
            [...expressionBase, expressionKey],
            [...fieldBase, "dependencyFieldIds", dependencyIndex],
          ];
      }
      if (
        sourcePath[7] === "operands" &&
        typeof sourcePath[8] === "number" &&
        typeof sourcePath[9] === "string"
      ) {
        const operandBase: Path = [...expressionBase, "operands", sourcePath[8]];
        if (sourcePath[9] === "field") {
          const expression = asObject(
            valueAtPath(source, [
              "body",
              "record_types",
              sourcePath[2],
              "fields",
              sourcePath[4],
              "settings",
              "expression",
            ]),
          );
          const dependencyIndex =
            (expression.operands as JsonObject[])
              .slice(0, sourcePath[8] + 1)
              .filter((operand) => operand.source === "field").length - 1;
          return [
            [...operandBase, "fieldId"],
            [...fieldBase, "dependencyFieldIds", dependencyIndex],
          ];
        }
        return [[...operandBase, sourcePath[9]]];
      }
      if (sourcePath[7] === "amount" && typeof sourcePath[8] === "string") {
        if (sourcePath[8] === "field")
          return [
            [...expressionBase, "amount", "fieldId"],
            [...fieldBase, "dependencyFieldIds", 1],
          ];
        return [[...expressionBase, "amount", sourcePath[8]]];
      }
    }
  }
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "record_type" &&
    sourcePath.length === 4
  ) {
    const collection = String(sourcePath[1]);
    const collectionMap: Readonly<Record<string, string>> = {
      permissions: "permissions",
      actions: "actions",
      events: "events",
      rules: "rules",
      extension_points: "extensionPoints",
    };
    const canonicalCollection = collectionMap[collection];
    if (canonicalCollection) {
      const targetKey =
        collection === "actions" || collection === "rules" ? "subjectRecordTypeId" : "recordTypeId";
      return [["content", canonicalCollection, sourcePath[2], targetKey]];
    }
  }
  if (
    source.kind === "module" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "actions" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "shareable" &&
    sourcePath.length === 4
  )
    return [["content", "actions", sourcePath[2], "sharing"]];
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "events" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "carries" &&
    typeof sourcePath[4] === "number" &&
    sourcePath.length === 5
  )
    return [["content", "events", sourcePath[2], "carriedFieldIds", sourcePath[4]]];
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "actions" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "effects" &&
    typeof sourcePath[4] === "number" &&
    sourcePath[5] === "relationships" &&
    typeof sourcePath[6] === "number" &&
    sourcePath.length === 7
  )
    return [
      [
        "content",
        "actions",
        sourcePath[2],
        "effects",
        sourcePath[4],
        "relationshipIds",
        sourcePath[6],
      ],
    ];
  return undefined;
}

const moduleSourceTransformPatterns = [
  /^root_alias$/,
  /^body\/(?:record_types|permissions|actions|events|rules|extension_points|sharing_conditions)\/#\/id$/,
  /^body\/record_types\/#\/(?:fields|relationships)\/#\/id$/,
  /^body\/dependencies\/#\/module$/,
  /^body\/record_types\/#\/(?:name|plural_name|custom_actions\/#|ownership_mode|storage_scope)$/,
  /^body\/record_types\/#\/(?:storage_contract_id|title_field|ownership_relationship)$/,
  /^body\/record_types\/#\/relationships\/#\/(?:from_field|to_record_type|to_record_types\/#)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/(?:application_root_required|audience|currency_mode|field|relationship|target|targets\/#)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/display_time_zone$/,
  /^body\/record_types\/#\/fields\/#\/settings\/expression\/(?:operation|numeric_operation|amount_field|percentage_field|fields\/#|date_field|due_field|status_field)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/expression\/operands\/#\/(?:field|source|value)(?:\/.*)?$/,
  /^body\/record_types\/#\/fields\/#\/settings\/expression\/amount\/(?:field|source|value)(?:\/.*)?$/,
  /^body\/(?:permissions|events|rules|extension_points)\/#\/record_type$/,
  /^body\/events\/#\/carries\/#$/,
  /^body\/actions\/#\/(?:record_type|permission|shareable)$/,
  /^body\/actions\/#\/inputs\/#\/(?:type|record_types\/#)$/,
  /^body\/actions\/#\/effects\/#\/(?:field|record_type|relationships\/#|target_input|event)$/,
  /^body\/actions\/#\/effects\/#\/value\/(?:source|input|field|value)(?:\/.*)?$/,
  /^body\/actions\/#\/effects\/#\/values\/[^/]+\/(?:source|input|field|value)(?:\/.*)?$/,
  /^body\/rules\/#\/effect\/(?:field|message|component|workflow|reason_code)$/,
  /^body\/sharing_conditions\/#\/(?:source_record_type|declared_fields\/#)$/,
  /^body\/sharing_conditions\/#\/publication_tests\/#\/(?:field_values|parameters)\/[^/]+(?:\/.*)?$/,
] as const;

const applicationSourceTransformPatterns = [
  /^root_alias$/,
  /^body\/(?:permissions|roles|block_registrations|pages|pipelines|workflows|interfaces|public_addresses)\/#\/id$/,
  /^body\/workflows\/#\/nodes\/#\/id$/,
  /^body\/interfaces\/#\/operations\/#\/id$/,
  /^body\/pages\/#\/steps\/#\/id$/,
  /^body\/module_bindings\/#\/module$/,
  /^body\/connection_bindings\/#\/(?:id|connection_type|required_operations\/#)$/,
  /^body\/home_page$/,
  /^body\/roles\/#\/(?:home_page|permissions\/#)$/,
  /^body\/navigation\/#(?:\/children\/#)*\/(?:id|page|permission)$/,
  /^body\/queries\/#\/(?:id|record_type|select\/#|group_by\/#)$/,
  /^body\/queries\/#\/filter$/,
  /^body\/queries\/#\/sort\/#\/field$/,
  /^body\/queries\/#\/aggregates\/#\/field$/,
  /^body\/pages\/#\/(?:id|record_type|query|permission|commit_action|public_action|public_fields\/#)$/,
  /^body\/pages\/#\/standard_page_replacement\/record_type$/,
  /^body\/pages\/#\/calendar_mapping\/(?:start|end|duration_field)$/,
  /^body\/pages\/#\/layout\/(?:desktop|phone)\/component_order\/#$/,
  /^body\/pages\/#\/(?:blocks\/#|steps\/#\/blocks\/#)\/(?:id|block|query|view_permission|use_permission)$/,
  /^body\/pipelines\/#\/(?:id|record_type|stage_field)$/,
  /^body\/pipelines\/#\/stages\/#\/(?:entry_workflows|exit_workflows)\/#$/,
  /^body\/pipelines\/#\/transitions\/#\/(?:permission|action)$/,
  /^body\/pipelines\/#\/time_targets\/#\/(?:stage|field|escalation_event)$/,
  /^body\/public_addresses\/#\/(?:id|page)$/,
  /^body\/block_registrations\/#\/allowed_child_blocks\/#$/,
  /^body\/interfaces\/#\/operations\/#\/(?:id|permission|authentication|visibility)$/,
  /^body\/interfaces\/#\/operations\/#\/(?:input_shape|output_shape)\/[^/]+\/target_binding\/(?:kind|key|field|value)$/,
  /^body\/workflows\/#\/(?:id|run_as)$/,
  /^body\/workflows\/#\/nodes\/#\/permission$/,
  /^body\/workflows\/#\/edges\/#\/#$/,
  /^body\/workflows\/#\/trigger\/(?:record_type|event|schedule|message|action|operation|workflow)$/,
  /^body\/workflows\/#\/trigger\/inputs\/#\/(?:key|type|record_types\/#|source\/(?:kind|field|key))$/,
  /^body\/workflows\/#\/trigger\/duplicate_protection$/,
  /^body\/workflows\/#\/nodes\/#\/config\/outputs\/#\/record_types\/#$/,
  /^body\/workflows\/#\/nodes\/#\/config\/(?:action|connection|field|formatter|message|operation|operator|page|query|record_type|relationship|relationships\/#|responder_permission|workflow)$/,
  /^body\/workflows\/#\/nodes\/#\/config\/(?:input|file|record|subject|target|source_record|target_record)\/(?:field|node|output)$/,
  /^body\/workflows\/#\/nodes\/#\/config\/(?:inputs|values)\/[^/]+\/(?:source|node|output|field|value)(?:\/.*)?$/,
  /^body\/workflows\/#\/nodes\/#\/config\/decisions\/#\/when\/(?:field|operator|value)(?:\/.*)?$/,
  /^body\/workflows\/#\/nodes\/#\/config\/value(?:\/#|\/.*)?$/,
  /^body\/(?:permissions|actions|events|rules)\/#\/record_type$/,
  /^body\/actions\/#\/(?:permission|sharing)$/,
  /^body\/actions\/#\/inputs\/#\/(?:type|record_types\/#)$/,
  /^body\/actions\/#\/effects\/#\/(?:field|record_type|relationships\/#|target_input|event)$/,
  /^body\/actions\/#\/effects\/#\/value\/(?:source|input|field|value)(?:\/.*)?$/,
  /^body\/actions\/#\/effects\/#\/values\/[^/]+\/(?:source|input|field|value)(?:\/.*)?$/,
  /^body\/rules\/#\/effect\/(?:field|message|component|workflow|reason_code)$/,
  /^body\/pipelines\/#\/stages\/#\/(?:entry_actions|exit_actions)\/#$/,
] as const;

const connectionSourceTransformPatterns = [
  /^root_alias$/,
  /^body\/authentication\/secret_fields\/#$/,
  /^body\/operations\/#\/(?:input|output|path|max_attempts)$/,
  /^body\/incoming_messages\/#\/(?:input|workflow_trigger)$/,
  /^body\/(?:health_operation|revocation_operation)$/,
] as const;

function conditionSourcePathMatches(path: string, root: string): boolean {
  const prefix = root.replaceAll("#", "\\#").replaceAll("/", "\\/");
  return new RegExp(
    `^${prefix}(?:(?:\\/(?:all|any)\\/#)|(?:\\/not))*\\/(?:field|operator|parameter|value|(?:left|right)\\/(?:source|field|parameter|value))(?:\\/.*)?$`,
  ).test(path);
}

function isConditionSourcePath(path: string): boolean {
  const roots = [
    "body/actions/#/precondition",
    "body/rules/#/condition",
    "body/sharing_conditions/#/condition",
    "body/record_types/#/fields/#/settings/filter",
    "body/record_types/#/fields/#/settings/expression/condition",
    "body/queries/#/filter",
    "body/pipelines/#/transitions/#/gate",
    "body/workflows/#/nodes/#/config/decisions/#/when",
    "body/workflows/#/trigger/condition",
    "body/pages/#/blocks/#/visibility_condition",
    "body/pages/#/steps/#/blocks/#/visibility_condition",
  ];
  return roots.some((root) => conditionSourcePathMatches(path, root));
}

function isWorkflowConditionNodePath(
  source: JsonObject,
  sourcePath: Path,
  normalizedPath: string,
): boolean {
  if (
    source.kind !== "application" ||
    sourcePath[0] !== "body" ||
    sourcePath[1] !== "workflows" ||
    typeof sourcePath[2] !== "number" ||
    sourcePath[3] !== "nodes" ||
    typeof sourcePath[4] !== "number" ||
    sourcePath[5] !== "config"
  )
    return false;
  const body = asObject(source.body);
  const workflow = (body.workflows as JsonObject[])[sourcePath[2]];
  const node = workflow ? (workflow.nodes as JsonObject[])[sourcePath[4]] : undefined;
  return (
    node?.type === "condition" &&
    conditionSourcePathMatches(normalizedPath, "body/workflows/#/nodes/#/config")
  );
}

function sourceTransformationApproved(source: JsonObject, sourcePath: Path): boolean {
  const normalized = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment));
  const path = normalized.join("/");
  if (isConditionSourcePath(path) || isWorkflowConditionNodePath(source, sourcePath, path))
    return true;
  const patterns =
    source.kind === "module"
      ? moduleSourceTransformPatterns
      : source.kind === "application"
        ? applicationSourceTransformPatterns
        : connectionSourceTransformPatterns;
  return patterns.some((pattern) => pattern.test(path));
}

function sourceResolvesIdentity(sourcePath: Path): boolean {
  const normalized = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment));
  const path = normalized.join("/");
  const last = sourcePath.at(-1);
  return (
    path === "root_alias" ||
    (typeof last === "string" && ID_FIELDS.has(last)) ||
    /\/(?:custom_actions|carries|declared_fields|public_fields|select|group_by|component_order|relationships|record_types|allowed_child_blocks)\/#$/.test(
      path,
    ) ||
    /\/(?:record_type|source_record_type|to_record_type|target|field|page|query|block|home_page|module|connection_type|workflow|node|relationship|amount_field|percentage_field|date_field|due_field|status_field)$/.test(
      path,
    ) ||
    /\/expression\/fields\/#$/.test(path) ||
    /\/(?:effects\/#\/values|sharing_conditions\/#\/publication_tests\/#\/field_values|workflows\/#\/nodes\/#\/config\/values)\/[^/]+\//.test(
      path,
    ) ||
    (sourcePath.length === 6 &&
      sourcePath[0] === "body" &&
      sourcePath[1] === "workflows" &&
      sourcePath[3] === "edges" &&
      (sourcePath[5] === 0 || sourcePath[5] === 1))
  );
}

function sourceCombinesResolvedKeyAndValue(sourcePath: Path): boolean {
  const path = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment)).join("/");
  return /\/(?:effects\/#\/values|sharing_conditions\/#\/publication_tests\/#\/field_values|workflows\/#\/nodes\/#\/config\/values)\/[^/]+\//.test(
    path,
  );
}

function pathKey(path: Path): string {
  return JSON.stringify(path);
}

function isSystemCanonicalPath(path: Path): boolean {
  if (path[0] !== "envelope") return false;
  const leaf = path.at(-1);
  return leaf !== "rootId" && leaf !== "key";
}

function isFixedWorkflowDefaultPath(path: Path): boolean {
  const joined = path.join(".");
  return (
    /\.nodes\.\d+\.(?:timeoutSeconds|duplicateProtection|activityKey|redaction)$/.test(joined) ||
    /\.nodes\.\d+\.retry\./.test(joined)
  );
}

type SourceProvenanceMapping = {
  canonicalPath: Path;
  origin: "source" | "resolved";
  sourcePath: Path;
  ruleCode?: typeof RESOLUTION_RULE | typeof TRANSFORM_RULE;
};

function provenanceFor(source: unknown, canonical: unknown): DefinitionProvenanceEntry[] {
  const sourceObject = asObject(source);
  const sourceLeafPaths = leafPaths(source).filter(
    (path) => !(path.length === 1 && (path[0] === "source_contract_version" || path[0] === "kind")),
  );
  const canonicalLeafPaths = leafPaths(canonical);
  const canonicalLeafSet = new Set(canonicalLeafPaths.map(pathKey));
  const entries: DefinitionProvenanceEntry[] = [];

  for (const sourcePath of sourceLeafPaths) {
    const explicitTargets = explicitSourceTargets(sourceObject, canonical, sourcePath);
    const canonicalPath =
      explicitTargets?.[0] ?? sourceToCanonicalPath(sourceObject, canonical, sourcePath);
    const mapsToCanonicalLeaf = canonicalLeafSet.has(pathKey(canonicalPath));
    const resolved = sourceResolvesIdentity(sourcePath);
    const transformTargets = explicitTargets ?? (mapsToCanonicalLeaf ? [canonicalPath] : []);
    if (transformTargets.length === 0)
      fail("vortex.definition.invalid_compilation_output", "invalid_value");
    for (const targetPath of transformTargets) {
      const transformed =
        canonicalJson(valueAtPath(source, sourcePath)) !==
        canonicalJson(valueAtPath(canonical, targetPath));
      if (transformed && !sourceTransformationApproved(sourceObject, sourcePath))
        fail("vortex.definition.invalid_compilation_output", "invalid_value");
      const mapping: SourceProvenanceMapping = {
        canonicalPath: targetPath,
        origin: resolved ? "resolved" : "source",
        sourcePath,
        ...(resolved
          ? { ruleCode: RESOLUTION_RULE }
          : transformed
            ? { ruleCode: TRANSFORM_RULE }
            : {}),
      };
      entries.push(mapping);
      if (resolved && sourceCombinesResolvedKeyAndValue(sourcePath))
        entries.push({
          canonicalPath: targetPath,
          origin: "source",
          sourcePath,
          ruleCode: TRANSFORM_RULE,
        });
    }
    if (sourcePath.at(-1) === "operator" && canonicalPath.at(-1) === "operator") {
      const conditionKindPath = [...canonicalPath.slice(0, -1), "kind"];
      if (pathExists(canonical, conditionKindPath))
        entries.push({
          canonicalPath: conditionKindPath,
          origin: "source",
          sourcePath,
          ruleCode: TRANSFORM_RULE,
        });
    }
    if (sourceObject.kind === "connection_type" && pathKey(sourcePath) === pathKey(["root_alias"]))
      entries.push({
        canonicalPath: ["version"],
        origin: "resolved",
        sourcePath,
        ruleCode: RESOLUTION_RULE,
      });
  }

  const representedCanonicalPaths = new Set(entries.map((entry) => pathKey(entry.canonicalPath)));
  for (const canonicalPath of canonicalLeafPaths) {
    const canonicalKey = pathKey(canonicalPath);
    if (representedCanonicalPaths.has(canonicalKey)) continue;

    const isSystem = isSystemCanonicalPath(canonicalPath);
    const isPublicationMetadata =
      canonicalPath.at(-1) === "publishedRevision" ||
      canonicalPath.at(-1) === "contractFingerprint";
    const isFixedWorkflowDefault = isFixedWorkflowDefaultPath(canonicalPath);
    if (isSystem || isPublicationMetadata || isFixedWorkflowDefault) {
      entries.push({
        canonicalPath,
        origin: isSystem || isPublicationMetadata ? "system_metadata" : "fixed_default",
        ruleCode: isSystem || isPublicationMetadata ? SYSTEM_RULE : DEFAULT_RULE,
      });
      representedCanonicalPaths.add(canonicalKey);
      continue;
    }
    fail("vortex.definition.invalid_compilation_output", "invalid_value");
  }
  return entries;
}

class Resolution {
  readonly snapshot: DefinitionResolutionSnapshot;
  readonly sourceLocation: DefinitionValidationLocation;

  constructor(snapshot: DefinitionResolutionSnapshot, source: JsonObject) {
    this.snapshot = snapshot;
    this.sourceLocation = compilerRootLocation(source);
    const authenticSourceIdentities = new Set(
      extractSourceIdentityRequirements(source as unknown as DefinitionSourceDocument).flatMap(
        (requirement) =>
          requirement.aliases.map((alias) =>
            JSON.stringify([
              requirement.scope,
              requirement.kind,
              requirement.componentOwner,
              alias,
            ]),
          ),
      ),
    );
    const actualFingerprint = `sha256:${createHash("sha256")
      .update(
        canonicalJson({
          contractVersion: snapshot.contractVersion,
          definitions: snapshot.definitions,
          identities: snapshot.identities,
        }),
        "utf8",
      )
      .digest("hex")}`;
    if (snapshot.fingerprint !== actualFingerprint)
      fail(
        "vortex.definition.invalid_resolution_fingerprint",
        "invalid_value",
        this.sourceLocation,
      );
    const definitions = new Set<string>();
    const ownersByIdentifier = new Map<string, string>();
    const identityOwnerGroups = new Map<
      string,
      { aliases: Set<string>; identifiers: Set<string>; kind: string; owner: string }
    >();
    const registerOwner = (
      identifier: string,
      owner: string,
      code: DefinitionCompilerRefusalCode,
    ) => {
      const existingOwner = ownersByIdentifier.get(identifier);
      if (existingOwner !== undefined && existingOwner !== owner)
        fail(code, "duplicate_key", this.sourceLocation);
      ownersByIdentifier.set(identifier, owner);
    };
    for (const definition of snapshot.definitions) {
      const key = `${definition.kind}:${definition.key}`;
      if (definitions.has(key))
        fail("vortex.definition.duplicate_resolution", "duplicate_key", this.sourceLocation);
      definitions.add(key);
      registerOwner(
        definition.rootId,
        `${definition.key}:root`,
        "vortex.definition.duplicate_resolution",
      );
    }
    const identities = new Set<string>();
    for (const identity of snapshot.identities) {
      const key = `${identity.definitionKey}:${identity.scope}:${identity.kind}:${identity.alias}`;
      if (identities.has(key))
        fail(
          "vortex.definition.duplicate_identity_resolution",
          "duplicate_key",
          this.sourceLocation,
        );
      identities.add(key);
      const ownerGroupKey = `${identity.definitionKey}:${identity.scope}:${identity.kind}:${identity.componentOwner}`;
      const ownerGroup = identityOwnerGroups.get(ownerGroupKey) ?? {
        aliases: new Set<string>(),
        identifiers: new Set<string>(),
        kind: identity.kind,
        owner: identity.componentOwner,
      };
      ownerGroup.aliases.add(identity.alias);
      ownerGroup.identifiers.add(identity.identifier);
      identityOwnerGroups.set(ownerGroupKey, ownerGroup);
      if (
        identity.definitionKey === source.key &&
        !authenticSourceIdentities.has(
          JSON.stringify([identity.scope, identity.kind, identity.componentOwner, identity.alias]),
        )
      ) {
        fail(
          "vortex.definition.duplicate_identity_resolution",
          "duplicate_key",
          this.sourceLocation,
        );
      }
      const componentOwner =
        identity.kind === "root"
          ? `${identity.definitionKey}:root`
          : `${identity.definitionKey}:${identity.scope}:${identity.kind}:${identity.componentOwner}`;
      registerOwner(
        identity.identifier,
        componentOwner,
        "vortex.definition.duplicate_identity_resolution",
      );
    }
    for (const group of identityOwnerGroups.values())
      if (group.identifiers.size !== 1)
        fail(
          "vortex.definition.duplicate_identity_resolution",
          "duplicate_key",
          this.sourceLocation,
        );
  }

  location(kind: string, key: string, scope?: string): DefinitionValidationLocation {
    const componentKinds: Readonly<
      Record<string, DefinitionValidationLocation["segments"][number]["kind"]>
    > = {
      module: "module",
      application: "application",
      connection_type: "connection",
      record_type: "record_type",
      field: "field",
      relationship: "relationship",
      action: "action",
      rule: "rule",
      event: "event",
      page: "page",
      block: "block",
      workflow: "workflow",
      workflow_node: "workflow_node",
      pipeline: "pipeline",
      query: "query",
      role: "role",
      connection_binding: "connection",
      interface: "interface",
    };
    const segments = [...this.sourceLocation.segments];
    if (scope?.startsWith("record:"))
      segments.push({ kind: "record_type", key: scope.slice("record:".length) });
    else if (scope?.startsWith("workflow:"))
      segments.push({ kind: "workflow", key: scope.slice("workflow:".length) });
    const componentKind = componentKinds[kind];
    if (componentKind) segments.push({ kind: componentKind, key });
    return { ...this.sourceLocation, segments };
  }

  definition(key: string, kind?: "module" | "application" | "connection_type") {
    const matches = this.snapshot.definitions.filter(
      (entry) => entry.key === key && (kind === undefined || entry.kind === kind),
    );
    const location = this.location(kind ?? "module", key);
    if (matches.length === 0)
      fail("vortex.definition.missing_definition", "unresolved_reference", location);
    if (matches.length > 1)
      fail("vortex.definition.ambiguous_definition", "unresolved_reference", location);
    return matches[0]!;
  }

  id(definitionKey: string, kind: string, alias: string, scope?: string): string {
    const matches = this.snapshot.identities.filter(
      (entry) =>
        entry.definitionKey === definitionKey &&
        entry.kind === kind &&
        entry.alias === alias &&
        (scope === undefined || entry.scope === scope),
    );
    const unique = [...new Set(matches.map((entry) => entry.identifier))];
    const location = this.location(kind, alias, scope);
    if (unique.length === 0)
      fail("vortex.definition.missing_identity", "unresolved_reference", location);
    if (unique.length > 1)
      fail("vortex.definition.ambiguous_identity", "unresolved_reference", location);
    return unique[0]!;
  }

  recordType(qualifiedKey: string) {
    const split = qualifiedKey.lastIndexOf(":");
    if (split < 1)
      fail(
        "vortex.definition.invalid_record_type_reference",
        "broken_reference",
        this.location("record_type", qualifiedKey),
      );
    const moduleKey = qualifiedKey.slice(0, split);
    const recordKey = qualifiedKey.slice(split + 1);
    const definition = this.definition(moduleKey, "module");
    return {
      state: "resolved" as const,
      moduleRootId: definition.rootId,
      recordTypeId: this.id(moduleKey, "record_type", recordKey, "content"),
    };
  }

  field(qualifiedRecordType: string, fieldAlias: string): string {
    const split = qualifiedRecordType.lastIndexOf(":");
    const moduleKey = qualifiedRecordType.slice(0, split);
    const recordKey = qualifiedRecordType.slice(split + 1);
    return this.id(moduleKey, "field", fieldAlias, `record:${recordKey}`);
  }

  relationship(qualifiedRecordType: string, alias: string): string {
    const split = qualifiedRecordType.lastIndexOf(":");
    const moduleKey = qualifiedRecordType.slice(0, split);
    const recordKey = qualifiedRecordType.slice(split + 1);
    try {
      return this.id(moduleKey, "relationship", alias, `record:${recordKey}`);
    } catch (error) {
      if (!(error instanceof DefinitionCompilationError)) throw error;
      return this.id(moduleKey, "relationship", alias);
    }
  }
}

function compatibleVersion(
  requirement:
    { selection: "exact"; version: string } | { selection: "allowed_range"; expression: string },
  exactVersion: string,
) {
  if (requirement.selection === "exact") return requirement.version === exactVersion;
  return satisfies(exactVersion, requirement.expression, { includePrerelease: false });
}

function exactVersion(
  resolution: Resolution,
  key: string,
  kind: "module" | "connection_type",
  requirement:
    { selection: "exact"; version: string } | { selection: "allowed_range"; expression: string },
) {
  const definition = resolution.definition(key, kind);
  if (!compatibleVersion(requirement, definition.exactVersion))
    fail(
      "vortex.definition.incompatible_version",
      "incompatible_version",
      resolution.location(kind, key),
    );
  return definition.exactVersion;
}

function condition(input: unknown, resolveField: (alias: string) => string): unknown {
  const value = asObject(input);
  if ("all" in value)
    return {
      kind: "all",
      conditions: (value.all as unknown[]).map((entry) => condition(entry, resolveField)),
    };
  if ("any" in value)
    return {
      kind: "any",
      conditions: (value.any as unknown[]).map((entry) => condition(entry, resolveField)),
    };
  if ("not" in value) return { kind: "not", condition: condition(value.not, resolveField) };
  const operator = String(value.operator);
  const operand = (inputOperand: unknown) => {
    const source = asObject(inputOperand);
    if (source.source === "field")
      return { source: "field", fieldId: resolveField(String(source.field)) };
    if (source.source === "parameter")
      return { source: "parameter", key: String(source.parameter) };
    return { source: "value", value: source.value };
  };
  const hasExplicitOperands = "left" in value;
  return {
    kind: "comparison",
    operator,
    left: hasExplicitOperands
      ? operand(value.left)
      : { source: "field", fieldId: resolveField(String(value.field)) },
    ...(!["is_empty", "is_not_empty"].includes(operator)
      ? {
          right: hasExplicitOperands
            ? operand(value.right)
            : "parameter" in value
              ? { source: "parameter", key: String(value.parameter) }
              : { source: "value", value: value.value },
        }
      : {}),
  };
}

function qualifiedField(resolution: Resolution, reference: string): string {
  const separator = reference.lastIndexOf(".");
  if (separator < 1) fail("vortex.definition.qualified_field_required", "unresolved_reference");
  return resolution.field(reference.slice(0, separator), reference.slice(separator + 1));
}

function actionValue(value: unknown, field: (alias: string) => string): unknown {
  const input = asObject(value);
  if (input.source === "input") return { source: "input", inputKey: input.input };
  if (input.source === "subject_field")
    return { source: "subject_field", fieldId: field(String(input.field)) };
  return input;
}

function actionInput(input: JsonObject, resolution: Resolution): unknown {
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

function fieldSettings(
  field: JsonObject,
  qualifiedRecordType: string,
  resolution: Resolution,
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
        ...(settings.minimum !== undefined ? { minimum: settings.minimum } : {}),
        ...(settings.maximum !== undefined ? { maximum: settings.maximum } : {}),
      };
    case "money":
      return {
        currencyMode:
          settings.currency_mode === "organisation_default"
            ? "organization_default"
            : settings.currency_mode,
        ...(settings.currency ? { currency: settings.currency } : {}),
        ...(settings.minimum !== undefined ? { minimum: settings.minimum } : {}),
        ...(settings.maximum !== undefined ? { maximum: settings.maximum } : {}),
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
      return { options: settings.options };
    case "several_choices":
      return {
        options: settings.options,
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
        })),
        minimumRows: settings.minimum_rows,
        maximumRows: settings.maximum_rows,
      };
    case "link":
      return {
        target: resolution.recordType(String(settings.target)),
        reverseKey: settings.reverse_key,
        onParentDelete: settings.on_parent_delete,
      };
    case "link_to_one_of_several":
      return {
        targets: (settings.targets as string[]).map((target) => resolution.recordType(target)),
        onParentDelete: settings.on_parent_delete,
      };
    case "link_to_person":
      return {
        audience: String(settings.audience).replace("organisation", "organization"),
        applicationRootIdRequired: settings.application_root_required,
        onPersonDeactivation: settings.on_person_deactivation,
      };
    case "calculation": {
      const expression = asObject(settings.expression);
      let compiled: unknown;
      let dependencies: string[];
      if (expression.operation === "join_text") {
        dependencies = (expression.fields as string[]).map(localField);
        compiled = { kind: "join_text", fieldIds: dependencies, separator: expression.separator };
      } else if (expression.operation === "subtract_percentage") {
        dependencies = [
          localField(String(expression.amount_field)),
          localField(String(expression.percentage_field)),
        ];
        compiled = {
          kind: "subtract_percentage",
          amountFieldId: dependencies[0],
          percentageFieldId: dependencies[1],
        };
      } else if (expression.operation === "numeric") {
        const operands = (expression.operands as JsonObject[]).map((operand) =>
          operand.source === "field"
            ? { source: "field", fieldId: localField(String(operand.field)) }
            : { source: "literal", value: operand.value },
        );
        dependencies = (expression.operands as JsonObject[])
          .filter((operand) => operand.source === "field")
          .map((operand) => localField(String(operand.field)));
        compiled = {
          kind: "numeric",
          operation: expression.numeric_operation,
          operands,
        };
      } else if (expression.operation === "condition") {
        const compiledCondition = condition(expression.condition, localField);
        const dependencySet = new Set<string>();
        const collectFieldDependencies = (value: unknown): void => {
          if (Array.isArray(value)) {
            value.forEach(collectFieldDependencies);
            return;
          }
          if (value === null || typeof value !== "object") return;
          const entry = value as JsonObject;
          if (entry.source === "field" && typeof entry.fieldId === "string")
            dependencySet.add(entry.fieldId);
          Object.values(entry).forEach(collectFieldDependencies);
        };
        collectFieldDependencies(compiledCondition);
        dependencies = [...dependencySet];
        compiled = { kind: "condition", condition: compiledCondition };
      } else if (expression.operation === "date_offset") {
        const dateFieldId = localField(String(expression.date_field));
        const amount = asObject(expression.amount);
        const compiledAmount =
          amount.source === "field"
            ? { source: "field", fieldId: localField(String(amount.field)) }
            : { source: "literal", value: amount.value };
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
      return {
        resultType: settings.result_type,
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
      return {
        relationshipId: resolution.relationship(relationshipRecord, relationshipAlias),
        operation: settings.operation,
        resultType: settings.result_type,
        ...(settings.field ? { fieldId: aggregateField(String(settings.field)) } : {}),
        ...(settings.filter ? { filter: condition(settings.filter, aggregateField) } : {}),
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

function compileModule(
  source: JsonObject,
  resolution: Resolution,
  metadata: JsonObject,
  savedConditionRevisions: readonly JsonObject[],
) {
  const body = asObject(source.body);
  const definitionKey = String(source.key);
  const root = resolution.definition(definitionKey, "module");
  const recordTypes = (body.record_types as JsonObject[]).map((recordType) => {
    const recordKey = String(recordType.key);
    const qualified = `${definitionKey}:${recordKey}`;
    const recordTypeId = resolution.id(definitionKey, "record_type", recordKey, "content");
    const fields = (recordType.fields as JsonObject[]).map((field) => ({
      fieldId: resolution.id(definitionKey, "field", String(field.id), `record:${recordKey}`),
      key: field.key,
      label: field.label,
      ...(field.help_text ? { helpText: field.help_text } : {}),
      required: field.required,
      ...(field.default !== undefined ? { default: field.default } : {}),
      unique: field.unique,
      filterable: field.filterable,
      sortable: field.sortable,
      ...(field.search_priority ? { searchPriority: field.search_priority } : {}),
      personalData: field.personal_data,
      publicDisplay: field.public_display,
      type: field.type,
      settings: fieldSettings(field, qualified, resolution),
    }));
    const relationships = (recordType.relationships as JsonObject[]).map((relationship) => ({
      relationshipId: resolution.id(
        definitionKey,
        "relationship",
        String(relationship.id),
        `record:${recordKey}`,
      ),
      key: relationship.key,
      fromRecordTypeId: recordTypeId,
      fromFieldId: resolution.field(qualified, String(relationship.from_field)),
      ...(relationship.to_record_type
        ? { toRecordType: resolution.recordType(String(relationship.to_record_type)) }
        : {
            toRecordTypes: (relationship.to_record_types as string[]).map((target) =>
              resolution.recordType(target),
            ),
          }),
      cardinality: relationship.cardinality,
      onParentDelete: relationship.on_parent_delete,
    }));
    return {
      recordTypeId,
      key: recordType.key,
      singularLabel: recordType.name,
      pluralLabel: recordType.plural_name,
      titleFieldId: resolution.field(qualified, String(recordType.title_field)),
      storageContractId: resolution.id(
        definitionKey,
        "storage_contract",
        String(recordType.storage_contract_id),
        `record:${recordKey}`,
      ),
      storageScope:
        recordType.storage_scope === "organisation_shared"
          ? "organization_shared"
          : recordType.storage_scope,
      ownershipMode:
        recordType.ownership_mode === "organisation_account"
          ? "organization_account"
          : recordType.ownership_mode,
      ...(recordType.ownership_relationship
        ? {
            ownershipRelationshipId: resolution.relationship(
              qualified,
              String(recordType.ownership_relationship),
            ),
          }
        : {}),
      fields,
      relationships,
      standardActions: recordType.standard_actions,
      customActionIds: (recordType.custom_actions as string[]).map((alias) =>
        resolution.id(definitionKey, "action", alias, "content"),
      ),
    };
  });
  const qualifiedForRecord = (recordKey: string) => `${definitionKey}:${recordKey}`;
  const permissions = (body.permissions as JsonObject[]).map((permission) => ({
    permissionId: resolution.id(definitionKey, "permission", String(permission.id), "content"),
    key: permission.key,
    label: permission.label,
    description: permission.description,
    ...(permission.record_type
      ? {
          recordTypeId: resolution.recordType(qualifiedForRecord(String(permission.record_type)))
            .recordTypeId,
        }
      : {}),
    actionKind: permission.action_kind,
    ...(permission.named_action ? { namedAction: permission.named_action } : {}),
    administrative: permission.administrative,
  }));
  const actions = (body.actions as JsonObject[]).map((action) => {
    const record = qualifiedForRecord(String(action.record_type));
    const localField = (alias: string) => resolution.field(record, alias);
    return {
      actionId: resolution.id(definitionKey, "action", String(action.id), "content"),
      key: action.key,
      label: action.label,
      subjectRecordTypeId: resolution.recordType(record).recordTypeId,
      permissionKey: action.permission,
      sharing: action.shareable ? "allowed" : "refused",
      inputs: (action.inputs as JsonObject[]).map((input) => actionInput(input, resolution)),
      ...(action.precondition ? { precondition: condition(action.precondition, localField) } : {}),
      effects: (action.effects as JsonObject[]).map((effect) => {
        if (effect.kind === "set_field")
          return {
            kind: "set_field",
            fieldId: localField(String(effect.field)),
            value: actionValue(effect.value, localField),
          };
        if (effect.kind === "create_record") {
          const target = String(effect.record_type);
          return {
            kind: "create_record",
            recordType: resolution.recordType(target),
            values: objectFromUniqueEntries(
              Object.entries(asObject(effect.values)).map(([key, value]) => [
                resolution.field(target, key),
                actionValue(value, localField),
              ]),
            ),
          };
        }
        if (effect.kind === "copy_relationships")
          return {
            kind: "copy_relationships",
            relationshipIds: (effect.relationships as string[]).map((alias) =>
              resolution.relationship(record, alias),
            ),
            targetInputKey: effect.target_input,
          };
        if (effect.kind === "announce_event")
          return { kind: "announce_event", eventKey: effect.event };
        return { kind: "soft_delete_subject" };
      }),
    };
  });
  const events = (body.events as JsonObject[]).map((event) => {
    const record = qualifiedForRecord(String(event.record_type));
    return {
      eventId: resolution.id(definitionKey, "event", String(event.id), "content"),
      key: event.key,
      recordTypeId: resolution.recordType(record).recordTypeId,
      carriedFieldIds: (event.carries as string[]).map((alias) => resolution.field(record, alias)),
      personalOrSensitiveValuesAllowed: false,
    };
  });
  const rules = (body.rules as JsonObject[]).map((rule) => {
    const record = qualifiedForRecord(String(rule.record_type));
    const localField = (alias: string) => resolution.field(record, alias);
    const effect = asObject(rule.effect);
    let compiledEffect: unknown;
    if (effect.kind === "set_value")
      compiledEffect = {
        kind: "set_value",
        fieldId: localField(String(effect.field)),
        value: effect.value,
      };
    else if (effect.kind === "require")
      compiledEffect = { kind: "require", fieldId: localField(String(effect.field)) };
    else if (effect.kind === "show_or_hide")
      compiledEffect = {
        kind: "show_or_hide",
        componentId: resolution.id(definitionKey, "extension_point", String(effect.component)),
        visibility: effect.visibility,
      };
    else if (effect.kind === "warn") compiledEffect = { kind: "warn", messageKey: effect.message };
    else if (effect.kind === "start_background_work")
      compiledEffect = {
        kind: "start_background_work",
        workflowId: resolution.id(definitionKey, "workflow", String(effect.workflow)),
      };
    else compiledEffect = { kind: "refuse", reasonCode: effect.reason_code };
    return {
      ruleId: resolution.id(definitionKey, "rule", String(rule.id), "content"),
      key: rule.key,
      subjectRecordTypeId: resolution.recordType(record).recordTypeId,
      trigger: rule.trigger,
      condition: condition(rule.condition, localField),
      priority: rule.priority,
      effect: compiledEffect,
    };
  });
  const sharingConditions = (body.sharing_conditions as JsonObject[]).map((saved) => {
    const record = qualifiedForRecord(String(saved.source_record_type));
    const localField = (alias: string) => resolution.field(record, alias);
    const compiledCondition = condition(saved.condition, localField);
    const conditionId = resolution.id(
      definitionKey,
      "sharing_condition",
      String(saved.id),
      "content",
    );
    const revisionMatches = savedConditionRevisions.filter(
      (assignment) => assignment.conditionId === conditionId,
    );
    if (revisionMatches.length !== 1)
      fail("vortex.definition.saved_condition_revision_required", "unresolved_reference");
    const resolved = {
      conditionId,
      sourceRecordTypeId: resolution.recordType(record).recordTypeId,
      key: saved.key,
      publishedRevision: revisionMatches[0]!.revision,
      parameters: saved.parameters,
      condition: compiledCondition,
      declaredFieldIds: (saved.declared_fields as string[]).map(localField),
      publicationTests: (saved.publication_tests as JsonObject[]).map((test) => ({
        name: test.name,
        parameters: test.parameters,
        fieldValues: objectFromUniqueEntries(
          Object.entries(asObject(test.field_values)).map(([key, value]) => [
            localField(key),
            value,
          ]),
        ),
        expected: test.expected,
      })),
    };
    const fingerprint = `sha256:${createHash("sha256")
      .update(canonicalJson(resolved), "utf8")
      .digest("hex")}`;
    return { ...resolved, contractFingerprint: fingerprint };
  });
  const canonical = moduleDraftSchema.parse({
    envelope: {
      kind: "module",
      rootId: root.rootId,
      organizationId: metadata.organizationId,
      key: definitionKey,
      draftRevision: metadata.draftRevision,
      ...(metadata.publishedRevision ? { publishedRevision: metadata.publishedRevision } : {}),
      createdAt: metadata.createdAt,
      createdBy: metadata.createdBy,
      updatedAt: metadata.updatedAt,
      updatedBy: metadata.updatedBy,
    },
    content: {
      name: body.name,
      description: body.description,
      dependencies: (body.dependencies as JsonObject[]).map((dependency) => {
        const requirement = dependency.version as Parameters<typeof compatibleVersion>[0];
        const target = resolution.definition(String(dependency.module), "module");
        return {
          dependencyKey: dependency.dependency_key,
          moduleRootId: target.rootId,
          moduleKey: target.key,
          version: requirement,
          resolvedVersion: exactVersion(
            resolution,
            String(dependency.module),
            "module",
            requirement,
          ),
        };
      }),
      recordTypes,
      permissions,
      actions,
      events,
      rules,
      sharingConditions,
      extensionPoints: (body.extension_points as JsonObject[]).map((point) => ({
        extensionPointId: resolution.id(
          definitionKey,
          "extension_point",
          String(point.id),
          "content",
        ),
        key: point.key,
        recordTypeId: resolution.recordType(qualifiedForRecord(String(point.record_type)))
          .recordTypeId,
        accepts: point.accepts,
      })),
    },
  });
  return canonical;
}

function workflowValue(
  value: unknown,
  resolution: Resolution,
  applicationKey: string,
  triggerRecord?: string,
): unknown {
  const input = asObject(value);
  if (input.source === "trigger_field") {
    const fieldReference = String(input.field);
    const dot = fieldReference.lastIndexOf(".");
    const explicitRecord =
      dot > fieldReference.lastIndexOf(":") ? fieldReference.slice(0, dot) : undefined;
    return {
      source: "trigger_field",
      fieldId: resolution.field(
        explicitRecord ??
          triggerRecord ??
          fail("vortex.definition.trigger_record_required", "scope_conflict"),
        explicitRecord ? fieldReference.slice(dot + 1) : fieldReference,
      ),
    };
  }
  if (input.source === "trigger_input") return { source: "trigger_input", inputKey: input.input };
  if (input.source === "node_output")
    return {
      source: "node_output",
      nodeId: resolution.id(applicationKey, "workflow_node", String(input.node)),
      outputKey: input.output,
    };
  return input;
}

function compileWorkflow(
  workflow: JsonObject,
  applicationKey: string,
  resolution: Resolution,
): unknown {
  const workflowId = resolution.id(applicationKey, "workflow", String(workflow.id), "content");
  const trigger = asObject(workflow.trigger);
  const triggerRecord = trigger.kind === "event" ? String(trigger.record_type) : undefined;
  const workflowField = (reference: string) => qualifiedField(resolution, reference);
  const value = (input: unknown) => workflowValue(input, resolution, applicationKey, triggerRecord);
  const nodes = (workflow.nodes as JsonObject[]).map((node) => {
    const config = asObject(node.config);
    let compiledConfig: unknown;
    switch (node.type) {
      case "start":
        compiledConfig = {};
        break;
      case "condition":
        compiledConfig = { condition: condition(config, workflowField) };
        break;
      case "decision_table":
        compiledConfig = {
          decisions: (config.decisions as JsonObject[]).map((decision) => ({
            when: condition(decision.when, workflowField),
            output: decision.output,
          })),
        };
        break;
      case "bounded_loop":
        compiledConfig = {
          queryId: resolution.id(applicationKey, "query", String(config.query), "content"),
          maximumRecords: config.maximum_records,
        };
        break;
      case "delay":
        compiledConfig = config;
        break;
      case "wait_until": {
        const qualified = String(config.field);
        const dot = qualified.lastIndexOf(".");
        compiledConfig = {
          dateTimeFieldId: resolution.field(qualified.slice(0, dot), qualified.slice(dot + 1)),
        };
        break;
      }
      case "start_workflow":
        compiledConfig = {
          workflowId: resolution.id(applicationKey, "workflow", String(config.workflow), "content"),
        };
        break;
      case "stop":
        compiledConfig = { reasonCode: config.reason_code };
        break;
      case "create_record": {
        const record = String(config.record_type);
        compiledConfig = {
          recordTypeId: resolution.recordType(record).recordTypeId,
          values: objectFromUniqueEntries(
            Object.entries(asObject(config.values)).map(([key, entry]) => [
              resolution.field(record, key),
              value(entry),
            ]),
          ),
        };
        break;
      }
      case "change_record": {
        const record = String(config.record_type);
        compiledConfig = {
          recordTypeId: resolution.recordType(record).recordTypeId,
          record: value(config.record),
          values: objectFromUniqueEntries(
            Object.entries(asObject(config.values)).map(([key, entry]) => [
              resolution.field(record, key),
              value(entry),
            ]),
          ),
        };
        break;
      }
      case "run_action":
        compiledConfig = {
          actionKey: config.action,
          subject: value(config.subject),
          inputs: objectFromUniqueEntries(
            Object.entries(asObject(config.inputs)).map(([key, entry]) => [key, value(entry)]),
          ),
        };
        break;
      case "soft_delete_record":
      case "duplicate_record": {
        const record = String(config.record_type);
        compiledConfig = {
          recordTypeId: resolution.recordType(record).recordTypeId,
          record: value(config.record),
        };
        break;
      }
      case "add_relationship": {
        const qualified = String(config.relationship);
        const dot = qualified.lastIndexOf(".");
        compiledConfig = {
          relationshipId: resolution.relationship(
            qualified.slice(0, dot),
            qualified.slice(dot + 1),
          ),
          subject: value(config.subject),
          target: value(config.target),
        };
        break;
      }
      case "copy_relationships":
        compiledConfig = {
          relationshipIds: (config.relationships as string[]).map((qualified) => {
            const dot = qualified.lastIndexOf(".");
            return resolution.relationship(qualified.slice(0, dot), qualified.slice(dot + 1));
          }),
          sourceRecord: value(config.source_record),
          targetRecord: value(config.target_record),
        };
        break;
      case "request_form":
        compiledConfig = {
          pageId: resolution.id(applicationKey, "page", String(config.page), "content"),
          responderPermissionKey: config.responder_permission,
          dueInSeconds: config.due_in_seconds,
          timeoutOutcome: config.timeout_outcome,
          outputs: (config.outputs as JsonObject[]).map((output) => ({
            key: output.key,
            type: output.type,
            ...(output.record_types
              ? {
                  recordTypeIds: (output.record_types as string[]).map(
                    (recordType) => resolution.recordType(recordType).recordTypeId,
                  ),
                }
              : {}),
          })),
        };
        break;
      case "query_records":
        compiledConfig = {
          queryId: resolution.id(applicationKey, "query", String(config.query), "content"),
        };
        break;
      case "set_values":
        compiledConfig = {
          record: value(config.record),
          values: objectFromUniqueEntries(
            Object.entries(asObject(config.values)).map(([qualified, entry]) => {
              const dot = qualified.lastIndexOf(".");
              return [
                resolution.field(qualified.slice(0, dot), qualified.slice(dot + 1)),
                value(entry),
              ];
            }),
          ),
        };
        break;
      case "format_value":
        compiledConfig = { formatterKey: config.formatter, input: value(config.input) };
        break;
      case "generate_export":
        compiledConfig = {
          queryId: resolution.id(applicationKey, "query", String(config.query), "content"),
          maximumRows: config.maximum_rows,
        };
        break;
      case "attach_file":
      case "move_file": {
        const qualified = String(config.field);
        const dot = qualified.lastIndexOf(".");
        compiledConfig = {
          record: value(config.record),
          fieldId: resolution.field(qualified.slice(0, dot), qualified.slice(dot + 1)),
          file: value(config.file),
        };
        break;
      }
      case "call_connection":
        compiledConfig = {
          connectionBindingId: resolution.id(
            applicationKey,
            "connection_binding",
            String(config.connection),
            "content",
          ),
          operationKey: config.operation,
          inputs: objectFromUniqueEntries(
            Object.entries(asObject(config.inputs)).map(([key, entry]) => [key, value(entry)]),
          ),
        };
        break;
      case "acknowledge_message":
        compiledConfig = { messageKey: config.message };
        break;
      default:
        fail("vortex.definition.unsupported_workflow_node", "unsupported_choice");
    }
    const requiredDuplicateProtection = MUTATING_WORKFLOW_NODES.has(String(node.type))
      ? "required"
      : "not_applicable";
    if (
      node.duplicate_protection !== undefined &&
      node.duplicate_protection !== requiredDuplicateProtection
    )
      fail("vortex.definition.unsafe_duplicate_protection", "unsafe_content");
    return {
      nodeId: resolution.id(
        applicationKey,
        "workflow_node",
        String(node.id),
        `workflow:${workflow.key}`,
      ),
      type: node.type,
      config: compiledConfig,
      ...(node.permission ? { permissionKey: node.permission } : {}),
      timeoutSeconds: node.timeout_seconds ?? workflowExecutionDefaults.timeoutSeconds,
      retry: node.retry
        ? {
            maximumAttempts: asObject(node.retry).maximum_attempts,
            initialDelaySeconds: asObject(node.retry).initial_delay_seconds,
            maximumDelaySeconds: asObject(node.retry).maximum_delay_seconds,
            backoff: asObject(node.retry).backoff,
          }
        : workflowExecutionDefaults.retry,
      duplicateProtection: node.duplicate_protection ?? requiredDuplicateProtection,
      activityKey: node.activity ?? node.type,
      redaction: node.redaction ?? workflowExecutionDefaults.redaction,
    };
  });
  const compileTriggerInputs = () =>
    (trigger.inputs as JsonObject[]).map((input) => {
      const inputSource = asObject(input.source);
      return inputSource.kind === "record_field"
        ? {
            source: "record_field" as const,
            key: input.key,
            type: input.type,
            fieldId: resolution.field(
              triggerRecord ?? fail("vortex.definition.trigger_record_required", "scope_conflict"),
              String(inputSource.field),
            ),
          }
        : {
            source: "payload" as const,
            key: input.key,
            type: input.type,
            payloadKey: inputSource.key,
            ...(input.record_types
              ? {
                  recordTypeIds: (input.record_types as string[]).map(
                    (recordType) => resolution.recordType(recordType).recordTypeId,
                  ),
                }
              : {}),
          };
    });
  const compiledTriggerCommon = {
    inputs: compileTriggerInputs(),
    condition: trigger.condition
      ? condition(trigger.condition, (field) =>
          resolution.field(
            triggerRecord ?? fail("vortex.definition.trigger_record_required", "scope_conflict"),
            field,
          ),
        )
      : null,
    duplicateProtection: trigger.duplicate_protection,
  };
  let compiledTrigger: unknown;
  switch (trigger.kind) {
    case "event":
      compiledTrigger = {
        kind: "event",
        eventKey: trigger.event,
        recordTypeId: resolution.recordType(String(trigger.record_type)).recordTypeId,
        ...compiledTriggerCommon,
      };
      break;
    case "schedule": {
      const schedule = asObject(trigger.schedule);
      compiledTrigger = {
        kind: "schedule",
        schedule: {
          cadence: schedule.cadence,
          interval: schedule.interval,
          timeZone: schedule.time_zone,
          minute: schedule.minute,
          ...(schedule.hour === undefined ? {} : { hour: schedule.hour }),
          ...(schedule.week_day === undefined ? {} : { weekDay: schedule.week_day }),
          ...(schedule.month_day === undefined ? {} : { monthDay: schedule.month_day }),
        },
        ...compiledTriggerCommon,
      };
      break;
    }
    case "incoming_message":
      compiledTrigger = {
        kind: "incoming_message",
        messageKey: trigger.message,
        ...compiledTriggerCommon,
      };
      break;
    case "button":
      compiledTrigger = { kind: "button", actionKey: trigger.action, ...compiledTriggerCommon };
      break;
    case "interface":
      compiledTrigger = {
        kind: "interface",
        operationKey: trigger.operation,
        ...compiledTriggerCommon,
      };
      break;
    case "workflow":
      compiledTrigger = {
        kind: "workflow",
        workflowId: resolution.id(applicationKey, "workflow", String(trigger.workflow), "content"),
        ...compiledTriggerCommon,
      };
      break;
    default:
      fail("vortex.definition.unsupported_workflow_trigger", "unsupported_choice");
  }
  return {
    workflowId,
    key: workflow.key,
    name: workflow.name,
    trigger: compiledTrigger,
    runAs: workflow.run_as === "triggering_account" ? "initiating_person" : workflow.run_as,
    nodes,
    edges: (workflow.edges as unknown[][]).map(([from, to, outcome]) => ({
      fromNodeId: resolution.id(
        applicationKey,
        "workflow_node",
        String(from),
        `workflow:${workflow.key}`,
      ),
      toNodeId: resolution.id(
        applicationKey,
        "workflow_node",
        String(to),
        `workflow:${workflow.key}`,
      ),
      ...(outcome ? { outcome } : {}),
    })),
    maximumNestingDepth: workflow.maximum_nesting_depth,
  };
}

function compileApplication(source: JsonObject, resolution: Resolution, metadata: JsonObject) {
  const body = asObject(source.body);
  const definitionKey = String(source.key);
  const root = resolution.definition(definitionKey, "application");
  const pageId = (alias: string) => resolution.id(definitionKey, "page", alias, "content");
  const queryId = (alias: string) => resolution.id(definitionKey, "query", alias, "content");
  const blockId = (alias: string) => resolution.id(definitionKey, "block", alias, "content");
  const compileBlockSetting = (settingValue: unknown) => {
    const setting = asObject(settingValue);
    if (setting.kind === "literal" || setting.kind === "action_reference")
      return setting.kind === "literal"
        ? { kind: "literal", value: setting.value }
        : { kind: "action_reference", actionKey: setting.action };
    if (setting.kind === "field_reference")
      return {
        kind: "field_reference",
        fieldId: qualifiedField(resolution, String(setting.field)),
      };
    if (setting.kind === "relationship_reference") {
      const reference = String(setting.relationship);
      const separator = reference.lastIndexOf(".");
      if (separator < 1) fail("vortex.definition.qualified_field_required", "unresolved_reference");
      return {
        kind: "relationship_reference",
        relationshipId: resolution.relationship(
          reference.slice(0, separator),
          reference.slice(separator + 1),
        ),
      };
    }
    if (setting.kind === "page_reference")
      return { kind: "page_reference", pageId: pageId(String(setting.page)) };
    if (setting.kind === "query_reference")
      return { kind: "query_reference", queryId: queryId(String(setting.query)) };
    if (setting.kind === "pipeline_reference")
      return {
        kind: "pipeline_reference",
        pipelineId: resolution.id(definitionKey, "pipeline", String(setting.pipeline), "content"),
      };
    if (setting.kind === "record_type_reference")
      return {
        kind: "record_type_reference",
        recordType: resolution.recordType(String(setting.record_type)),
      };
    if (setting.kind === "record_reference")
      return {
        kind: "record_reference",
        recordType: resolution.recordType(String(setting.record_type)),
        recordId: setting.record_id,
      };
    fail("vortex.definition.invalid_compilation_output", "unsupported_choice");
  };
  const placement = (input: JsonObject) => ({
    placementId: resolution.id(definitionKey, "block_placement", String(input.id)),
    blockId: blockId(String(input.block)),
    blockReleaseVersion: input.block_release_version,
    settings: objectFromUniqueEntries(
      Object.entries(asObject(input.settings)).map(([key, value]) => [
        key,
        compileBlockSetting(value),
      ]),
    ),
    desktop: {
      startColumn: asObject(input.desktop).start_column,
      span: asObject(input.desktop).span,
      height: asObject(input.desktop).height,
    },
    phone: input.phone,
    ...(input.visibility_condition
      ? {
          visibilityCondition: condition(input.visibility_condition, (reference) =>
            qualifiedField(resolution, reference),
          ),
        }
      : {}),
    viewPermissionKey: input.view_permission,
    ...(input.use_permission ? { usePermissionKey: input.use_permission } : {}),
    ...(input.query ? { queryId: queryId(String(input.query)) } : {}),
  });
  const layout = (input: JsonObject) => ({
    desktop: {
      columns: 12,
      componentOrder: (asObject(input.desktop).component_order as string[]).map((alias) =>
        resolution.id(definitionKey, "block_placement", alias),
      ),
    },
    phone: {
      componentOrder: (asObject(input.phone).component_order as string[]).map((alias) =>
        resolution.id(definitionKey, "block_placement", alias),
      ),
    },
  });
  const pages = (body.pages as JsonObject[]).map((page) => {
    const base = {
      pageId: resolution.id(definitionKey, "page", String(page.id), "content"),
      key: page.key,
      name: page.name,
      accessPermissionKey: page.permission,
      states: page.states,
      layout: layout(asObject(page.layout)),
      ...(page.standard_page_replacement
        ? {
            standardPageReplacement: {
              standardPage: asObject(page.standard_page_replacement).standard_page,
              recordType: resolution.recordType(
                String(asObject(page.standard_page_replacement).record_type),
              ),
            },
          }
        : {}),
    };
    if (page.type === "list") {
      const record = String(page.record_type);
      const mapping = page.calendar_mapping ? asObject(page.calendar_mapping) : undefined;
      return {
        ...base,
        type: "list",
        recordType: resolution.recordType(record),
        queryId: queryId(String(page.query)),
        arrangements: page.arrangements,
        ...(mapping
          ? {
              calendarMapping:
                "end" in mapping
                  ? {
                      kind: "start_end",
                      startFieldId: resolution.field(record, String(mapping.start)),
                      endFieldId: resolution.field(record, String(mapping.end)),
                    }
                  : {
                      kind: "start_duration",
                      startFieldId: resolution.field(record, String(mapping.start)),
                      durationFieldId: resolution.field(record, String(mapping.duration_field)),
                      durationUnit: mapping.duration_unit,
                    },
            }
          : {}),
      };
    }
    if (page.type === "dashboard")
      return { ...base, type: "dashboard", blocks: (page.blocks as JsonObject[]).map(placement) };
    if (page.type === "detail")
      return {
        ...base,
        type: "detail",
        recordType: resolution.recordType(String(page.record_type)),
        blocks: (page.blocks as JsonObject[]).map(placement),
      };
    if (page.type === "form")
      return {
        ...base,
        type: "form",
        recordType: resolution.recordType(String(page.record_type)),
        commitActionKey: page.commit_action,
        blocks: (page.blocks as JsonObject[]).map(placement),
      };
    if (page.type === "guided_form")
      return {
        ...base,
        type: "guided_form",
        recordType: resolution.recordType(String(page.record_type)),
        commitActionKey: page.commit_action,
        steps: (page.steps as JsonObject[]).map((step) => ({
          id: resolution.id(definitionKey, "guided_step", String(step.id)),
          name: step.name,
          summary: step.summary,
          blocks: (step.blocks as JsonObject[]).map(placement),
        })),
      };
    return {
      ...base,
      type: "public",
      ...(page.record_type ? { recordType: resolution.recordType(String(page.record_type)) } : {}),
      publicFieldIds: page.record_type
        ? (page.public_fields as string[]).map((alias) =>
            resolution.field(String(page.record_type), alias),
          )
        : [],
      ...(page.public_action ? { publicActionKey: page.public_action } : {}),
      blocks: (page.blocks as JsonObject[]).map(placement),
      rateLimitPerMinute: page.rate_limit_per_minute,
    };
  });
  const queries = (body.queries as JsonObject[]).map((query) => {
    const record = String(query.record_type);
    return {
      queryId: resolution.id(definitionKey, "query", String(query.id), "content"),
      key: query.key,
      recordType: resolution.recordType(record),
      selectedFieldIds: (query.select as string[]).map((alias) => resolution.field(record, alias)),
      filter: query.filter
        ? condition(query.filter, (alias) => resolution.field(record, alias))
        : null,
      groupByFieldIds: (query.group_by as string[]).map((alias) => resolution.field(record, alias)),
      aggregates: (query.aggregates as JsonObject[]).map((aggregate) => ({
        operation: aggregate.operation,
        ...(aggregate.field ? { fieldId: resolution.field(record, String(aggregate.field)) } : {}),
        alias: aggregate.alias,
      })),
      sort: (query.sort as JsonObject[]).map((sort) => ({
        fieldId: resolution.field(record, String(sort.field)),
        direction: sort.direction,
      })),
      pageSize: query.page_size,
      relationshipHops: query.relationship_hops,
    };
  });
  const permissions = (body.permissions as JsonObject[]).map((permission) => ({
    permissionId: resolution.id(definitionKey, "permission", String(permission.id), "content"),
    key: permission.key,
    label: permission.label,
    description: permission.description,
    ...(permission.record_type
      ? { recordTypeId: resolution.recordType(String(permission.record_type)).recordTypeId }
      : {}),
    actionKind: permission.action_kind,
    ...(permission.named_action ? { namedAction: permission.named_action } : {}),
    administrative: permission.administrative,
  }));
  const wildcardPermissions = permissions
    .filter((permission) => permission.administrative === false)
    .sort((left, right) => compareCanonicalStrings(String(left.key), String(right.key)));
  const wildcardPermissionKeys = wildcardPermissions.map((permission) => permission.key);
  const wildcardCatalogueFingerprint = fingerprintCanonicalValue(wildcardPermissions);
  const canonical = applicationDraftSchema.parse({
    envelope: {
      kind: "application",
      rootId: root.rootId,
      organizationId: metadata.organizationId,
      key: definitionKey,
      draftRevision: metadata.draftRevision,
      ...(metadata.publishedRevision ? { publishedRevision: metadata.publishedRevision } : {}),
      createdAt: metadata.createdAt,
      createdBy: metadata.createdBy,
      updatedAt: metadata.updatedAt,
      updatedBy: metadata.updatedBy,
    },
    content: {
      name: body.name,
      description: body.description,
      icon: body.icon,
      moduleBindings: (body.module_bindings as JsonObject[]).map((binding) => {
        const requirement = binding.version as Parameters<typeof compatibleVersion>[0];
        const target = resolution.definition(String(binding.module), "module");
        return {
          moduleRootId: target.rootId,
          version: requirement,
          resolvedVersion: exactVersion(resolution, String(binding.module), "module", requirement),
          purpose: binding.purpose,
        };
      }),
      navigation: (body.navigation as JsonObject[]).map(function visit(item): unknown {
        if (item.type === "heading")
          return {
            id: resolution.id(definitionKey, "navigation_item", String(item.id)),
            type: "heading",
            label: item.label,
            children: (item.children as JsonObject[]).map(visit),
          };
        if (item.type === "external")
          return {
            id: resolution.id(definitionKey, "navigation_item", String(item.id)),
            type: "external",
            label: item.label,
            address: item.address,
            permissionKey: item.permission,
          };
        return {
          id: resolution.id(definitionKey, "navigation_item", String(item.id)),
          type: "page",
          label: item.label,
          pageId: pageId(String(item.page)),
          permissionKey: item.permission,
        };
      }),
      pages,
      roles: (body.roles as JsonObject[]).map((role) => {
        const authoredPermissionKeys = role.permissions as string[];
        const usesApplicationWildcard =
          authoredPermissionKeys.length === 1 && authoredPermissionKeys[0] === "*";
        return {
          roleId: resolution.id(definitionKey, "role", String(role.id), "content"),
          key: role.key,
          name: role.name,
          homePageId: pageId(String(role.home_page)),
          permissionKeys: usesApplicationWildcard ? wildcardPermissionKeys : authoredPermissionKeys,
          permissionSelection: usesApplicationWildcard
            ? {
                kind: "application_wildcard",
                catalogueFingerprint: wildcardCatalogueFingerprint,
              }
            : { kind: "exact" },
        };
      }),
      queries,
      blockRegistrations: (body.block_registrations as JsonObject[]).map((block) => ({
        blockId: resolution.id(definitionKey, "block", String(block.id), "content"),
        releaseVersion: block.release_version,
        name: block.name,
        icon: block.icon,
        paletteGroup: block.palette_group,
        settings: block.settings,
        allowedChildBlockIds: (block.allowed_child_blocks as string[]).map(blockId),
        phoneBehaviour: block.phone_behaviour,
        resizableHeight: block.resizable_height,
        liveUpdate: block.live_update,
        publicPage: block.public_page,
      })),
      pipelines: (body.pipelines as JsonObject[]).map((pipeline) => {
        const record = String(pipeline.record_type);
        return {
          pipelineId: resolution.id(definitionKey, "pipeline", String(pipeline.id), "content"),
          key: pipeline.key,
          name: pipeline.name,
          recordType: resolution.recordType(record),
          stageFieldId: resolution.field(record, String(pipeline.stage_field)),
          stages: (pipeline.stages as JsonObject[]).map((stage) => ({
            key: stage.key,
            label: stage.label,
            entryActionKeys: stage.entry_actions,
            exitActionKeys: stage.exit_actions,
            entryWorkflowIds: (stage.entry_workflows as string[]).map((alias) =>
              resolution.id(definitionKey, "workflow", alias, "content"),
            ),
            exitWorkflowIds: (stage.exit_workflows as string[]).map((alias) =>
              resolution.id(definitionKey, "workflow", alias, "content"),
            ),
          })),
          transitions: (pipeline.transitions as JsonObject[]).map((transition) => ({
            from: transition.from,
            to: transition.to,
            ...(transition.permission ? { permissionKey: transition.permission } : {}),
            ...(transition.action ? { actionKey: transition.action } : {}),
            ...(transition.gate
              ? { gate: condition(transition.gate, (alias) => resolution.field(record, alias)) }
              : {}),
          })),
          timeTargets: (pipeline.time_targets as JsonObject[]).map((target) => ({
            stageKey: target.stage,
            dateTimeFieldId: resolution.field(record, String(target.field)),
            escalationEventKey: target.escalation_event,
          })),
        };
      }),
      permissions,
      actions: (body.actions as JsonObject[]).map((action) => {
        const record = String(action.record_type);
        const localField = (alias: string) => resolution.field(record, alias);
        return {
          actionId: resolution.id(definitionKey, "action", String(action.id), "content"),
          key: action.key,
          label: action.label,
          subjectRecordTypeId: resolution.recordType(record).recordTypeId,
          permissionKey: action.permission,
          sharing: action.sharing,
          inputs: (action.inputs as JsonObject[]).map((input) => actionInput(input, resolution)),
          ...(action.precondition
            ? { precondition: condition(action.precondition, localField) }
            : {}),
          effects: (action.effects as JsonObject[]).map((effect) => {
            if (effect.kind === "set_field")
              return {
                kind: "set_field",
                fieldId: localField(String(effect.field)),
                value: actionValue(effect.value, localField),
              };
            if (effect.kind === "create_record") {
              const target = String(effect.record_type);
              return {
                kind: "create_record",
                recordType: resolution.recordType(target),
                values: objectFromUniqueEntries(
                  Object.entries(asObject(effect.values)).map(([key, value]) => [
                    resolution.field(target, key),
                    actionValue(value, localField),
                  ]),
                ),
              };
            }
            if (effect.kind === "copy_relationships")
              return {
                kind: "copy_relationships",
                relationshipIds: (effect.relationships as string[]).map((alias) =>
                  resolution.relationship(record, alias),
                ),
                targetInputKey: effect.target_input,
              };
            if (effect.kind === "announce_event")
              return { kind: "announce_event", eventKey: effect.event };
            return { kind: "soft_delete_subject" };
          }),
        };
      }),
      rules: (body.rules as JsonObject[]).map((rule) => {
        const record = String(rule.record_type);
        const localField = (alias: string) => resolution.field(record, alias);
        const effect = asObject(rule.effect);
        const compiledEffect =
          effect.kind === "set_value"
            ? {
                kind: "set_value",
                fieldId: localField(String(effect.field)),
                value: effect.value,
              }
            : effect.kind === "require"
              ? { kind: "require", fieldId: localField(String(effect.field)) }
              : effect.kind === "show_or_hide"
                ? {
                    kind: "show_or_hide",
                    componentId: resolution.id(
                      definitionKey,
                      "block_placement",
                      String(effect.component),
                    ),
                    visibility: effect.visibility,
                  }
                : effect.kind === "warn"
                  ? { kind: "warn", messageKey: effect.message }
                  : effect.kind === "start_background_work"
                    ? {
                        kind: "start_background_work",
                        workflowId: resolution.id(
                          definitionKey,
                          "workflow",
                          String(effect.workflow),
                          "content",
                        ),
                      }
                    : { kind: "refuse", reasonCode: effect.reason_code };
        return {
          ruleId: resolution.id(definitionKey, "rule", String(rule.id), "content"),
          key: rule.key,
          subjectRecordTypeId: resolution.recordType(record).recordTypeId,
          trigger: rule.trigger,
          condition: condition(rule.condition, localField),
          priority: rule.priority,
          effect: compiledEffect,
        };
      }),
      events: (body.events as JsonObject[]).map((event) => {
        const record = String(event.record_type);
        return {
          eventId: resolution.id(definitionKey, "event", String(event.id), "content"),
          key: event.key,
          recordTypeId: resolution.recordType(record).recordTypeId,
          carriedFieldIds: (event.carries as string[]).map((alias) =>
            resolution.field(record, alias),
          ),
          personalOrSensitiveValuesAllowed: false,
        };
      }),
      workflows: (body.workflows as JsonObject[]).map((workflow) =>
        compileWorkflow(workflow, definitionKey, resolution),
      ),
      connectionBindings: (body.connection_bindings as JsonObject[]).map((binding) => {
        const requirement = binding.version as Parameters<typeof compatibleVersion>[0];
        const target = resolution.definition(String(binding.connection_type), "connection_type");
        if (target.kind !== "connection_type")
          fail("vortex.definition.connection_type_mismatch", "unresolved_reference");
        if (
          (binding.required_operations as string[]).some(
            (operation) => !target.operationKeys.includes(operation),
          )
        )
          fail("vortex.definition.connection_operation_missing", "unresolved_reference");
        return {
          bindingId: resolution.id(
            definitionKey,
            "connection_binding",
            String(binding.id),
            "content",
          ),
          key: binding.key,
          connectionTypeId: target.rootId,
          version: requirement,
          resolvedVersion: exactVersion(
            resolution,
            String(binding.connection_type),
            "connection_type",
            requirement,
          ),
          requiredOperationKeys: binding.required_operations,
        };
      }),
      interfaces: (body.interfaces as JsonObject[]).map((definition) => ({
        interfaceId: resolution.id(definitionKey, "interface", String(definition.id), "content"),
        key: definition.key,
        version: definition.version,
        state: definition.state,
        operations: (definition.operations as JsonObject[]).map((operation) => ({
          operationId: resolution.id(
            definitionKey,
            "interface_operation",
            String(operation.id),
            `interface:${definition.key}`,
          ),
          key: operation.key,
          description: operation.description,
          method: operation.method,
          path: operation.path,
          inputShape: objectFromUniqueEntries(
            Object.entries(asObject(operation.input_shape)).map(([key, descriptorValue]) => {
              const descriptor = asObject(descriptorValue);
              const targetBinding = asObject(descriptor.target_binding);
              return [
                key,
                {
                  type: descriptor.type,
                  required: descriptor.required,
                  targetBinding:
                    targetBinding.kind === "action_input"
                      ? { kind: "action_input", key: targetBinding.key }
                      : { kind: "action_subject" },
                },
              ];
            }),
          ),
          outputShape: objectFromUniqueEntries(
            Object.entries(asObject(operation.output_shape)).map(([key, descriptorValue]) => {
              const descriptor = asObject(descriptorValue);
              const targetBinding = asObject(descriptor.target_binding);
              return [
                key,
                {
                  type: descriptor.type,
                  required: descriptor.required,
                  targetBinding:
                    targetBinding.kind === "query_field"
                      ? {
                          kind: "query_field",
                          fieldId: qualifiedField(resolution, String(targetBinding.field)),
                        }
                      : targetBinding.kind === "query_page_information"
                        ? { kind: "query_page_information", value: targetBinding.value }
                        : { kind: "workflow_run_id" },
                },
              ];
            }),
          ),
          authentication: String(operation.authentication).replace("organisation", "organization"),
          permissionKey: operation.permission,
          visibility: String(operation.visibility).replace("organisation", "organization"),
          rateLimitPerMinute: operation.rate_limit_per_minute,
          maximumRequestBytes: operation.maximum_request_bytes,
          duplicateProtection: operation.duplicate_protection,
          target: operation.target,
          errorCodes: operation.error_codes,
        })),
      })),
      publicAddresses: (body.public_addresses as JsonObject[]).map((address) => ({
        addressId: resolution.id(definitionKey, "public_address", String(address.id), "content"),
        pageId: pageId(String(address.page)),
        path: address.path,
        state: address.state,
        rateLimitPerMinute: address.rate_limit_per_minute,
      })),
      theme:
        asObject(body.theme).mode === "application"
          ? {
              mode: "application",
              lightAndDark: asObject(body.theme).light_and_dark,
              tokens: asObject(body.theme).tokens,
            }
          : {
              mode: "platform",
              catalogueThemeId: asObject(body.theme).catalogue_theme_id,
              version: asObject(body.theme).version,
            },
      homePageId: pageId(String(body.home_page)),
    },
  });
  return canonical;
}

function compileConnection(source: JsonObject, resolution: Resolution) {
  const body = asObject(source.body);
  const definitionKey = String(source.key);
  const root = resolution.definition(definitionKey, "connection_type");
  const authentication = asObject(body.authentication);
  const compiledAuthentication =
    authentication.kind === "oauth2"
      ? {
          kind: "oauth2",
          secretFieldKeys: authentication.secret_fields,
          scopes: authentication.scopes,
        }
      : authentication.kind === "signed_secret"
        ? {
            kind: "signed_secret",
            secretFieldKeys: authentication.secret_fields,
            algorithm: authentication.algorithm,
          }
        : {
            kind: "api_key",
            secretFieldKeys: authentication.secret_fields,
            placement: authentication.placement,
          };
  return connectionTypeSchema.parse({
    connectionTypeId: root.rootId,
    key: definitionKey,
    version: root.exactVersion,
    name: body.name,
    purpose: body.purpose,
    provider: body.provider,
    authentication: compiledAuthentication,
    allowedHosts: body.allowed_hosts,
    allowRedirects: body.allow_redirects,
    shapes: (body.shapes as JsonObject[]).map((shape) => ({
      key: shape.key,
      fields: shape.fields,
    })),
    operations: (body.operations as JsonObject[]).map((operation) => ({
      key: operation.key,
      method: operation.method,
      pathTemplate: operation.path,
      inputShapeKey: operation.input,
      outputShapeKey: operation.output,
      timeoutSeconds: operation.timeout_seconds,
      maximumAttempts: operation.max_attempts,
      maximumResponseBytes: operation.maximum_response_bytes,
    })),
    incomingMessages: (body.incoming_messages as JsonObject[]).map((message) => ({
      key: message.key,
      signature: message.signature,
      replayWindowSeconds: message.replay_window_seconds,
      inputShapeKey: message.input,
      workflowTriggerKey: message.workflow_trigger,
    })),
    ...(body.health_operation ? { healthOperationKey: body.health_operation } : {}),
    ...(body.revocation_operation ? { revocationOperationKey: body.revocation_operation } : {}),
  });
}

function dependencyOrder(source: JsonObject): string[] {
  const body = asObject(source.body);
  if (source.kind === "module")
    return [
      ...(body.dependencies as JsonObject[]).map((entry) => String(entry.module)),
      String(source.key),
    ];
  if (source.kind === "application")
    return [
      ...(body.module_bindings as JsonObject[]).map((entry) => String(entry.module)),
      ...(body.connection_bindings as JsonObject[]).map((entry) => String(entry.connection_type)),
      String(source.key),
    ];
  return [String(source.key)];
}

function resolvedDependencies(source: JsonObject, resolution: Resolution) {
  const body = asObject(source.body);
  const keys =
    source.kind === "module"
      ? (body.dependencies as JsonObject[]).map((entry) => String(entry.module))
      : source.kind === "application"
        ? [
            ...(body.module_bindings as JsonObject[]).map((entry) => String(entry.module)),
            ...(body.connection_bindings as JsonObject[]).map((entry) =>
              String(entry.connection_type),
            ),
          ]
        : [];
  return keys.map((key) => resolution.definition(key));
}

export function compileDefinition(input: unknown): DefinitionCompilationOutput {
  const parsed = definitionCompilationRequestSchema.safeParse(input);
  if (!parsed.success) fail("vortex.definition.invalid_compilation_request", "invalid_value");
  const request = parsed.data;
  const sourceDocument = request.source;
  const source = sourceDocument as unknown as JsonObject;
  try {
    const resolution = new Resolution(request.resolution, source);
    let canonical: unknown;
    if (source.kind === "module") {
      if (!request.draftMetadata)
        fail("vortex.definition.draft_metadata_required", "required_value");
      canonical = compileModule(
        source,
        resolution,
        request.draftMetadata as unknown as JsonObject,
        (request.savedConditionRevisions ?? []) as unknown as JsonObject[],
      );
    } else if (source.kind === "application") {
      if (!request.draftMetadata)
        fail("vortex.definition.draft_metadata_required", "required_value");
      canonical = compileApplication(
        source,
        resolution,
        request.draftMetadata as unknown as JsonObject,
      );
    } else canonical = compileConnection(source, resolution);
    const ownDefinition = resolution.definition(sourceDocument.key, sourceDocument.kind);
    const canonicalObject = asObject(canonical);
    const artifact = {
      kind: sourceDocument.kind,
      definitionKey: sourceDocument.key,
      rootId: ownDefinition.rootId,
      exactVersion: ownDefinition.exactVersion,
      contentFingerprint: fingerprintCanonicalValue(
        sourceDocument.kind === "connection_type" ? canonicalObject : canonicalObject.content,
      ),
      resolutionFingerprint: request.resolution.fingerprint,
    };
    const output = definitionCompilationOutputSchema.safeParse({
      kind: sourceDocument.kind,
      canonical,
      artifact,
      provenance: provenanceFor(source, canonical),
      dependencyOrder: dependencyOrder(source),
      resolvedDependencies: resolvedDependencies(source, resolution),
      resolutionFingerprint: request.resolution.fingerprint,
    });
    if (!output.success) fail("vortex.definition.invalid_compilation_output", "invalid_value");
    return output.data;
  } catch (error) {
    if (error instanceof DefinitionCompilationError)
      throw error.location
        ? error
        : new DefinitionCompilationError(
            error.ruleCode,
            error.family,
            compilerRootLocation(source),
          );
    return fail("vortex.definition.invalid_compilation_output", "invalid_value");
  }
}
