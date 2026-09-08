import { createHash } from "node:crypto";
import { satisfies } from "semver";
import {
  applicationSourceDocumentV2Schema,
  applicationCompilationOutputV2Schema,
  applicationCompilationRequestV2Schema,
  applicationDraftSchema,
  applicationDraftV2Schema,
  conditionNodeSchema,
  jsonValueSchema,
  walkDefinitionContract,
  connectionTypeSchema,
  definitionCompilationOutputSchema,
  definitionCompilationRequestSchema,
  definitionPublicationContextSchema,
  definitionSourceDocumentSchema,
  moduleDraftSchema,
  moduleDraftV2Schema,
  moduleCompilationOutputV2Schema,
  moduleCompilationRequestV2Schema,
  moduleSourceDocumentV2Schema,
  normalizeExactDecimal,
  readModuleSourceRecordOwnershipModeV1,
  writeModuleRecordOwnershipModeV1,
  type ApplicationCompilationOutputV2,
  type ApplicationCompilationRequestV2,
  type ModuleCompilationOutputV2,
  type ModuleCompilationRequestV2,
  type DefinitionCompilationRequest,
  type ApplicationSourceDocumentV2,
  type DefinitionCompilationOutput,
  type DefinitionProvenanceEntry,
  type DefinitionResolutionSnapshot,
  type DefinitionResolutionSnapshotV2,
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
import {
  extractApplicationSourceIdentityRequirementsV2,
  extractSourceIdentityRequirements,
} from "./source-identities";
import {
  materialiseApplicationCompositionV2,
  type MaterialisedApplicationCompositionV2,
} from "./application-v2-composition";
import type { ApplicationCompositionResolutionV2 } from "./application-v2-resolution";

type Path = (string | number)[];
type JsonObject = Record<string, unknown>;

export type DefinitionCompilationContext = Readonly<{
  dependencyOutputs?: readonly DefinitionCompilationOutput[];
}>;

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
  permission_alternatives: "permissionKeys",
  required_permission: "requiredPermissionId",
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

type SourceContractPositions = {
  opaqueDataRoots: readonly Path[];
  recordRoots: readonly Path[];
};

const pathStartsWith = (path: Path, prefix: Path) =>
  prefix.every((segment, index) => path[index] === segment);

function sourceContractPositions(source: JsonObject): SourceContractPositions {
  const opaqueDataRoots: Path[] = [];
  const recordRoots: Path[] = [];
  const contract =
    source.kind === "module" && source.source_contract_version === "2.0.0"
      ? moduleSourceDocumentV2Schema
      : source.kind === "application" && source.source_contract_version === "2.0.0"
        ? applicationSourceDocumentV2Schema
        : definitionSourceDocumentSchema;
  walkDefinitionContract(contract, source, (schema, _value, path) => {
    if (schema === jsonValueSchema) opaqueDataRoots.push(path as Path);
    if (schema._zod.def.type === "record") recordRoots.push(path as Path);
  });
  return { opaqueDataRoots, recordRoots };
}

const isOpaqueDataPath = (positions: SourceContractPositions, path: Path) =>
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

function sourceToCanonicalPath(
  source: JsonObject,
  canonical: unknown,
  sourcePath: Path,
  positions: SourceContractPositions,
): Path {
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
    const mappedKey = isDataProperty(positions, sourcePath, sourceIndex)
      ? segment
      : segment === "id" && collection
        ? (sourceCollectionIdKeys[collection] ?? "id")
        : (directSourceKeyMap[segment] ?? camelCase(segment));
    mapped.push(mappedKey);
    collection = segment;
  }
  if (source.kind === "module" && source.source_contract_version === "2.0.0") {
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

function conditionSourceTargets(
  source: JsonObject,
  sourcePath: Path,
  fixedRoots?: { sourceRoot: Path; canonicalRoot: Path },
): Path[] | undefined {
  const roots = fixedRoots ?? conditionRootPaths(source, sourcePath);
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
  const valueSuffix = (suffixPath: Path): Path =>
    source.source_contract_version === "2.0.0"
      ? suffixPath.map((segment) => {
          if (segment === "record_type") return "recordTypeId";
          if (segment === "record_id") return "recordId";
          if (segment === "organization_account_id") return "organizationAccountId";
          return segment;
        })
      : suffixPath;
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
      [...canonicalPath, "right", "value", ...valueSuffix(suffix.slice(1))],
    ];
  if ((suffix[0] === "left" || suffix[0] === "right") && typeof suffix[1] === "string") {
    const operandPath = [...canonicalPath, suffix[0]];
    const mappedKey =
      suffix[1] === "field" ? "fieldId" : suffix[1] === "parameter" ? "key" : suffix[1];
    return [
      ...targets,
      [
        ...operandPath,
        mappedKey,
        ...(mappedKey === "value" ? valueSuffix(suffix.slice(2)) : suffix.slice(2)),
      ],
    ];
  }
  return undefined;
}

function permissionRecordScopeTargets(
  source: JsonObject,
  canonical: unknown,
  sourcePath: Path,
  resolution: Resolution,
): Path[] | undefined {
  if (
    (source.kind !== "module" && source.kind !== "application") ||
    sourcePath[0] !== "body" ||
    sourcePath[1] !== "permissions" ||
    typeof sourcePath[2] !== "number" ||
    sourcePath[3] !== "record_scope"
  )
    return undefined;
  const permissionIndex = sourcePath[2];
  const canonicalScopePath: Path = ["content", "permissions", permissionIndex, "recordScope"];
  if (sourcePath[4] === "routes" && typeof sourcePath[5] === "number") {
    const body = asObject(source.body);
    const sourcePermission = (body.permissions as JsonObject[])[permissionIndex]!;
    const route = (asObject(sourcePermission.record_scope).routes as JsonObject[])[sourcePath[5]]!;
    const canonicalRoutes = valueAtPath(canonical, [
      ...canonicalScopePath,
      "routes",
    ]) as JsonObject[];
    const compiledRoute =
      route.kind === "relationship"
        ? (() => {
            const relationship = String(route.relationship);
            const separator = relationship.lastIndexOf(".");
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
          })()
        : { kind: route.kind };
    const targetIndex = canonicalRoutes.findIndex(
      (candidate) => canonicalJson(candidate) === canonicalJson(compiledRoute),
    );
    if (targetIndex < 0) fail("vortex.definition.invalid_compilation_output", "invalid_value");
    const target = [...canonicalScopePath, "routes", targetIndex] as Path;
    if (sourcePath[6] === "relationship") return [[...target, "relationshipId"]];
    if (sourcePath[6] === "source_permission") return [[...target, "sourcePermissionId"]];
    return [[...target, ...sourcePath.slice(6).map((part) => camelCase(String(part)))]];
  }
  if (sourcePath[4] !== "saved_condition") return undefined;
  if (sourcePath[5] === "condition")
    return [
      [...canonicalScopePath, "savedCondition", "conditionId"],
      [...canonicalScopePath, "savedCondition", "publishedRevision"],
      [...canonicalScopePath, "savedCondition", "contractFingerprint"],
    ];
  if (sourcePath[5] !== "parameter_bindings" || typeof sourcePath[6] !== "number") return undefined;
  const body = asObject(source.body);
  const sourcePermission = (body.permissions as JsonObject[])[permissionIndex]!;
  const binding = (
    asObject(asObject(sourcePermission.record_scope).saved_condition)
      .parameter_bindings as JsonObject[]
  )[sourcePath[6]]!;
  const canonicalBindings = valueAtPath(canonical, [
    ...canonicalScopePath,
    "savedCondition",
    "parameterBindings",
  ]) as JsonObject[];
  const targetIndex = canonicalBindings.findIndex((candidate) => candidate.key === binding.key);
  if (targetIndex < 0) fail("vortex.definition.invalid_compilation_output", "invalid_value");
  return [
    [
      ...canonicalScopePath,
      "savedCondition",
      "parameterBindings",
      targetIndex,
      ...sourcePath.slice(7).map((part) => camelCase(String(part))),
    ],
  ];
}

function permissionFieldPolicyTargets(
  source: JsonObject,
  canonical: unknown,
  sourcePath: Path,
  resolution: Resolution,
): Path[] | undefined {
  if (
    (source.kind !== "module" && source.kind !== "application") ||
    sourcePath[0] !== "body" ||
    sourcePath[1] !== "permissions" ||
    typeof sourcePath[2] !== "number" ||
    sourcePath[3] !== "field_policy" ||
    (sourcePath[4] !== "readable_fields" && sourcePath[4] !== "changeable_fields") ||
    typeof sourcePath[5] !== "number" ||
    sourcePath.length !== 6
  )
    return undefined;
  const permissionIndex = sourcePath[2];
  const permission = (asObject(source.body).permissions as JsonObject[])[permissionIndex]!;
  const recordType = String(permission.record_type);
  const resolvedFieldId = resolution.field(
    source.kind === "module" ? `${String(source.key)}:${recordType}` : recordType,
    String(valueAtPath(source, sourcePath)),
  );
  const canonicalCollection =
    sourcePath[4] === "readable_fields" ? "readableFieldIds" : "changeableFieldIds";
  const canonicalFields = valueAtPath(canonical, [
    "content",
    "permissions",
    permissionIndex,
    "fieldPolicy",
    canonicalCollection,
  ]) as string[];
  const targetIndex = canonicalFields.findIndex((fieldId) => fieldId === resolvedFieldId);
  if (targetIndex < 0) fail("vortex.definition.invalid_compilation_output", "invalid_value");
  return [
    ["content", "permissions", permissionIndex, "fieldPolicy", canonicalCollection, targetIndex],
  ];
}

function explicitSourceTargets(
  source: JsonObject,
  canonical: unknown,
  sourcePath: Path,
  positions: SourceContractPositions,
  resolution: Resolution,
): Path[] | undefined {
  const fieldPolicyTargets = permissionFieldPolicyTargets(
    source,
    canonical,
    sourcePath,
    resolution,
  );
  if (fieldPolicyTargets) return fieldPolicyTargets;
  const recordScopeTargets = permissionRecordScopeTargets(
    source,
    canonical,
    sourcePath,
    resolution,
  );
  if (recordScopeTargets) return recordScopeTargets;
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
  if (isOpaqueDataPath(positions, sourcePath)) return undefined;
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
      const proposed = sourceToCanonicalPath(source, canonical, sourcePath, positions);
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
    const target = sourceToCanonicalPath(source, canonical, sourcePath, positions);
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
  /^body\/record_types\/#\/fields\/#\/default(?:\/.*)?$/,
  /^body\/record_types\/#\/fields\/#\/settings\/(?:minimum|maximum)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/columns\/#\/settings\/(?:minimum|maximum)$/,
  /^body\/record_types\/#\/relationships\/#\/(?:from_field|to_record_type|to_record_types\/#)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/(?:application_root_required|audience|currency_mode|field|relationship|target|targets\/#)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/(?:options\/#|columns\/#\/settings\/options\/#)\/required_permission$/,
  /^body\/record_types\/#\/fields\/#\/settings\/columns\/#\/settings\/(?:currency_mode|display_time_zone)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/display_time_zone$/,
  /^body\/record_types\/#\/fields\/#\/settings\/expression\/(?:operation|numeric_operation|amount_field|percentage_field|fields\/#|date_field|due_field|status_field)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/expression\/operands\/#\/(?:field|source|value)(?:\/.*)?$/,
  /^body\/record_types\/#\/fields\/#\/settings\/expression\/amount\/(?:field|source|value)(?:\/.*)?$/,
  /^body\/(?:permissions|events|rules|extension_points)\/#\/record_type$/,
  /^body\/events\/#\/carries\/#$/,
  /^body\/actions\/#\/(?:record_type|permission|shareable)$/,
  /^body\/actions\/#\/inputs\/#\/(?:type|record_types\/#)$/,
  /^body\/actions\/#\/inputs\/#\/validation\/(?:minimum|maximum)$/,
  /^body\/actions\/#\/effects\/#\/(?:field|record_type|relationships\/#|target_input|event)$/,
  /^body\/actions\/#\/effects\/#\/value\/(?:source|input|field|value)(?:\/.*)?$/,
  /^body\/actions\/#\/effects\/#\/values\/[^/]+\/(?:source|input|field|value)(?:\/.*)?$/,
  /^body\/rules\/#\/effect\/(?:field|message|component|workflow|reason_code)$/,
  /^body\/rules\/#\/effect\/value(?:\/.*)?$/,
  /^body\/sharing_conditions\/#\/(?:source_record_type|declared_fields\/#)$/,
  /^body\/sharing_conditions\/#\/publication_tests\/#\/(?:field_values|parameters)\/[^/]+(?:\/.*)?$/,
  /^body\/permissions\/#\/record_scope\/.+$/,
  /^body\/permissions\/#\/field_policy\/(?:readable_fields|changeable_fields)\/#$/,
] as const;

const applicationSourceTransformPatterns = [
  /^root_alias$/,
  /^body\/(?:permissions|actions|roles|block_registrations|pages|pipelines|workflows|interfaces|public_addresses)\/#\/id$/,
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
  /^body\/permissions\/#\/record_scope\/.+$/,
  /^body\/permissions\/#\/field_policy\/(?:readable_fields|changeable_fields)\/#$/,
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

function sourceResolvesIdentity(sourcePath: Path, positions: SourceContractPositions): boolean {
  const normalized = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment));
  const path = normalized.join("/");
  const last = sourcePath.at(-1);
  const resolvesDynamicMapKey =
    /\/(?:effects\/#\/values|sharing_conditions\/#\/publication_tests\/#\/field_values|workflows\/#\/nodes\/#\/config\/values)\/[^/]+\//.test(
      path,
    );
  if (isOpaqueDataPath(positions, sourcePath)) return resolvesDynamicMapKey;
  return (
    path === "root_alias" ||
    (typeof last === "string" && ID_FIELDS.has(last)) ||
    /\/(?:custom_actions|carries|declared_fields|public_fields|select|group_by|component_order|relationships|record_types|allowed_child_blocks)\/#$/.test(
      path,
    ) ||
    /\/(?:record_type|source_record_type|to_record_type|target|field|page|query|block|home_page|module|connection_type|workflow|node|relationship|amount_field|percentage_field|date_field|due_field|status_field|required_permission)$/.test(
      path,
    ) ||
    /\/expression\/fields\/#$/.test(path) ||
    resolvesDynamicMapKey ||
    (sourcePath.length === 6 &&
      sourcePath[0] === "body" &&
      sourcePath[1] === "workflows" &&
      sourcePath[3] === "edges" &&
      (sourcePath[5] === 0 || sourcePath[5] === 1))
  );
}

function recordScopeSourceResolvesIdentity(sourcePath: Path): boolean {
  const normalized = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment));
  const path = normalized.join("/");
  return (
    /^body\/permissions\/#\/record_scope\/routes\/#\/(?:relationship|source_permission)$/.test(
      path,
    ) || /^body\/permissions\/#\/record_scope\/saved_condition\/condition$/.test(path)
  );
}

function fieldPolicySourceResolvesIdentity(sourcePath: Path): boolean {
  const path = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment)).join("/");
  return /^body\/permissions\/#\/field_policy\/(?:readable_fields|changeable_fields)\/#$/.test(
    path,
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

function provenanceFor(
  source: unknown,
  canonical: unknown,
  resolution: Resolution,
): DefinitionProvenanceEntry[] {
  const sourceObject = asObject(source);
  const positions = sourceContractPositions(sourceObject);
  const sourceLeafPaths = leafPaths(source).filter(
    (path) => !(path.length === 1 && (path[0] === "source_contract_version" || path[0] === "kind")),
  );
  const canonicalLeafPaths = leafPaths(canonical);
  const canonicalLeafSet = new Set(canonicalLeafPaths.map(pathKey));
  const entries: DefinitionProvenanceEntry[] = [];

  for (const sourcePath of sourceLeafPaths) {
    const explicitTargets = explicitSourceTargets(
      sourceObject,
      canonical,
      sourcePath,
      positions,
      resolution,
    );
    const canonicalPath =
      explicitTargets?.[0] ?? sourceToCanonicalPath(sourceObject, canonical, sourcePath, positions);
    const mapsToCanonicalLeaf = canonicalLeafSet.has(pathKey(canonicalPath));
    const resolved =
      sourceResolvesIdentity(sourcePath, positions) ||
      recordScopeSourceResolvesIdentity(sourcePath) ||
      fieldPolicySourceResolvesIdentity(sourcePath);
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
  readonly snapshot: DefinitionResolutionSnapshot | DefinitionResolutionSnapshotV2;
  readonly sourceLocation: DefinitionValidationLocation;

  constructor(
    snapshot: DefinitionResolutionSnapshot | DefinitionResolutionSnapshotV2,
    source: JsonObject,
  ) {
    this.snapshot = snapshot;
    this.sourceLocation = compilerRootLocation(source);
    const requirements =
      source.kind === "application" && source.source_contract_version === "2.0.0"
        ? extractApplicationSourceIdentityRequirementsV2(
            source as unknown as ApplicationSourceDocumentV2,
          )
        : extractSourceIdentityRequirements(source as unknown as DefinitionSourceDocument);
    const authenticSourceIdentities = new Set(
      requirements.flatMap((requirement) =>
        requirement.aliases.map((alias) =>
          JSON.stringify([requirement.scope, requirement.kind, requirement.componentOwner, alias]),
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

  permission(key: string, allowedDefinitionKeys: readonly string[]): string {
    const allowed = new Set(allowedDefinitionKeys);
    const matches = this.snapshot.identities.filter(
      (entry) =>
        allowed.has(entry.definitionKey) &&
        entry.scope === "content" &&
        entry.kind === "permission" &&
        entry.alias === key,
    );
    const unique = [...new Set(matches.map((entry) => entry.identifier))];
    if (unique.length === 0)
      fail(
        "vortex.definition.missing_identity",
        "unresolved_reference",
        this.location("permission", key),
      );
    if (unique.length > 1)
      fail(
        "vortex.definition.ambiguous_identity",
        "unresolved_reference",
        this.location("permission", key),
      );
    return unique[0]!;
  }

  exactOwnedReference(
    kind: "action" | "permission",
    key: string,
    allowedDefinitionKeys: readonly string[],
  ): string {
    const allowed = new Set(allowedDefinitionKeys);
    const matches = this.snapshot.identities.filter(
      (entry) =>
        allowed.has(entry.definitionKey) &&
        entry.scope === "content" &&
        entry.kind === kind &&
        entry.alias === key,
    );
    const unique = [...new Set(matches.map((entry) => entry.identifier))];
    if (unique.length === 0)
      fail("vortex.definition.missing_identity", "unresolved_reference", this.location(kind, key));
    if (unique.length > 1)
      fail(
        "vortex.definition.ambiguous_identity",
        "unresolved_reference",
        this.location(kind, key),
      );
    return key;
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

type ModuleValueContext = Readonly<{
  field: (reference: string, alias?: string) => JsonObject | undefined;
  parameters?: ReadonlyMap<string, string>;
  resolution: Resolution;
}>;

const normaliseExactV2 = (value: unknown): unknown =>
  typeof value === "string" ? (normalizeExactDecimal(value) ?? value) : value;

function normaliseMoneyV2(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const money = value as JsonObject;
  return { ...money, amount: normaliseExactV2(money.amount) };
}

function normaliseModuleFieldValueV2(
  field: JsonObject | undefined,
  value: unknown,
  context: ModuleValueContext,
  fieldDefault = false,
): unknown {
  if (!field) return value;
  switch (field.type) {
    case "decimal_number":
      return normaliseExactV2(value);
    case "money":
      return fieldDefault ? normaliseExactV2(value) : normaliseMoneyV2(value);
    case "calculation":
    case "total": {
      const settings = asObject(field.settings);
      return normaliseModuleTypedValueV2(
        String(settings.result_type ?? settings.resultType),
        value,
        context,
      );
    }
    case "link":
    case "link_to_one_of_several": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const link = value as JsonObject;
      if (typeof link.record_type !== "string") return value;
      return {
        recordTypeId: context.resolution.recordType(link.record_type).recordTypeId,
        recordId: link.record_id,
      };
    }
    case "link_to_person": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const person = value as JsonObject;
      return "organization_account_id" in person
        ? { organizationAccountId: person.organization_account_id }
        : value;
    }
    case "table": {
      if (!Array.isArray(value)) return value;
      const settings = asObject(field.settings);
      const columns = (settings.columns as JsonObject[]) ?? [];
      const byKey = new Map(columns.map((column) => [String(column.key), column]));
      return value.map((row) =>
        objectFromUniqueEntries(
          Object.entries(asObject(row)).map(([key, cell]) => {
            const column = byKey.get(key);
            if (column?.type === "decimal_number") return [key, normaliseExactV2(cell)];
            if (column?.type === "money")
              return [key, fieldDefault ? normaliseExactV2(cell) : normaliseMoneyV2(cell)];
            return [key, cell];
          }),
        ),
      );
    }
    default:
      return value;
  }
}

function normaliseModuleTypedValueV2(
  declaration: JsonObject | string | undefined,
  value: unknown,
  context: ModuleValueContext,
): unknown {
  if (typeof declaration === "object" && declaration !== null)
    return normaliseModuleFieldValueV2(declaration, value, context);
  if (declaration === "decimal_number") return normaliseExactV2(value);
  if (declaration === "money") return normaliseMoneyV2(value);
  if (declaration === "record_reference") {
    const link = asObject(value);
    if (typeof link.record_type === "string")
      return {
        recordTypeId: context.resolution.recordType(link.record_type).recordTypeId,
        recordId: link.record_id,
      };
  }
  return value;
}

function conditionDeclarationV2(
  operandValue: unknown,
  context: ModuleValueContext,
): JsonObject | string | undefined {
  const operand = asObject(operandValue);
  if (operand.source === "field") return context.field(String(operand.field));
  if (operand.source === "parameter") return context.parameters?.get(String(operand.parameter));
  return undefined;
}

function condition(
  input: unknown,
  resolveField: (alias: string) => string,
  valueContext?: ModuleValueContext,
): unknown {
  const value = asObject(input);
  if ("all" in value)
    return {
      kind: "all",
      conditions: (value.all as unknown[]).map((entry) =>
        condition(entry, resolveField, valueContext),
      ),
    };
  if ("any" in value)
    return {
      kind: "any",
      conditions: (value.any as unknown[]).map((entry) =>
        condition(entry, resolveField, valueContext),
      ),
    };
  if ("not" in value)
    return { kind: "not", condition: condition(value.not, resolveField, valueContext) };
  const operator = String(value.operator);
  const authoredLeft = "left" in value ? value.left : { source: "field", field: value.field };
  const authoredRight =
    "right" in value
      ? value.right
      : "parameter" in value
        ? { source: "parameter", parameter: value.parameter }
        : { source: "value", value: value.value };
  const leftDeclaration = valueContext
    ? conditionDeclarationV2(authoredLeft, valueContext)
    : undefined;
  const rightDeclaration = valueContext
    ? conditionDeclarationV2(authoredRight, valueContext)
    : undefined;
  const operand = (
    inputOperand: unknown,
    declaration: JsonObject | string | undefined,
    side: "left" | "right",
  ) => {
    const source = asObject(inputOperand);
    if (source.source === "field")
      return { source: "field", fieldId: resolveField(String(source.field)) };
    if (source.source === "parameter")
      return { source: "parameter", key: String(source.parameter) };
    const authoredValue = source.value;
    const normalisedValue =
      valueContext &&
      Array.isArray(authoredValue) &&
      ((side === "right" && ["in", "not_in"].includes(operator)) ||
        (side === "left" && ["contains", "not_contains"].includes(operator)))
        ? authoredValue.map((entry) =>
            normaliseModuleTypedValueV2(declaration, entry, valueContext),
          )
        : valueContext
          ? normaliseModuleTypedValueV2(declaration, authoredValue, valueContext)
          : authoredValue;
    return {
      source: "value",
      value: normalisedValue,
    };
  };
  const hasExplicitOperands = "left" in value;
  return {
    kind: "comparison",
    operator,
    left: hasExplicitOperands
      ? operand(authoredLeft, rightDeclaration, "left")
      : { source: "field", fieldId: resolveField(String(value.field)) },
    ...(!["is_empty", "is_not_empty"].includes(operator)
      ? {
          right: operand(authoredRight, leftDeclaration, "right"),
        }
      : {}),
  };
}

function qualifiedField(resolution: Resolution, reference: string): string {
  const separator = reference.lastIndexOf(".");
  if (separator < 1) fail("vortex.definition.qualified_field_required", "unresolved_reference");
  return resolution.field(reference.slice(0, separator), reference.slice(separator + 1));
}

function actionValue(
  value: unknown,
  field: (alias: string) => string,
  targetField?: JsonObject,
  valueContext?: ModuleValueContext,
): unknown {
  const input = asObject(value);
  if (input.source === "input") return { source: "input", inputKey: input.input };
  if (input.source === "subject_field")
    return { source: "subject_field", fieldId: field(String(input.field)) };
  if (input.source === "literal" && valueContext)
    return {
      ...input,
      value: normaliseModuleFieldValueV2(targetField, input.value, valueContext),
    };
  return input;
}

function actionInput(input: JsonObject, resolution: Resolution, moduleV2 = false): unknown {
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
        : moduleV2 && (input.type === "decimal_number" || input.type === "money")
          ? {
              ...(validation.minimum !== undefined
                ? { minimum: normaliseExactV2(validation.minimum) }
                : {}),
              ...(validation.maximum !== undefined
                ? { maximum: normaliseExactV2(validation.maximum) }
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

function permissionScopeSourceOwners(source: JsonObject): string[] {
  const body = asObject(source.body);
  return source.kind === "module"
    ? [String(source.key)]
    : [
        String(source.key),
        ...(body.module_bindings as JsonObject[]).map((binding) => String(binding.module)),
      ];
}

function moduleFieldPermissionSourceOwners(source: JsonObject): string[] {
  const body = asObject(source.body);
  return [
    String(source.key),
    ...(body.dependencies as JsonObject[]).map((dependency) => String(dependency.module)),
  ];
}

function compilePermissionRecordScope(
  permission: JsonObject,
  source: JsonObject,
  resolution: Resolution,
  sharingConditions: readonly JsonObject[] = [],
  valueContext?: ModuleValueContext,
  referencedModuleV2 = false,
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
              ? normaliseModuleTypedValueV2(
                  parameterTypes.get(String(binding.key)),
                  binding.value,
                  valueContext,
                )
              : referencedModuleV2 && parameterTypes.get(String(binding.key)) === "decimal_number"
                ? normaliseExactV2(binding.value)
                : referencedModuleV2 && parameterTypes.get(String(binding.key)) === "money"
                  ? normaliseMoneyV2(binding.value)
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

function compilePermissionFieldPolicy(
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

function applicationPermissionSharingConditions(
  permission: JsonObject,
  source: JsonObject,
  resolution: Resolution,
  organizationId: unknown,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): Readonly<{ conditions: readonly JsonObject[]; moduleV2: boolean }> {
  if (permission.record_scope === undefined) return { conditions: [], moduleV2: false };
  const sourceScope = asObject(permission.record_scope);
  if (sourceScope.saved_condition === undefined) return { conditions: [], moduleV2: false };
  if (permission.record_type === undefined)
    fail("vortex.definition.saved_condition_revision_required", "unresolved_reference");
  const qualifiedRecordType = String(permission.record_type);
  const separator = qualifiedRecordType.lastIndexOf(":");
  if (separator < 1)
    fail("vortex.definition.saved_condition_revision_required", "unresolved_reference");
  const moduleKey = qualifiedRecordType.slice(0, separator);
  const expectedModule = resolution.definition(moduleKey, "module");
  const recordType = resolution.recordType(qualifiedRecordType);
  const bindings = (asObject(source.body).module_bindings as JsonObject[]).filter(
    (binding) => binding.module === moduleKey,
  );
  const matches = dependencyOutputs.filter(
    (output) => output.kind === "module" && output.artifact.definitionKey === moduleKey,
  );
  if (bindings.length !== 1 || matches.length !== 1)
    fail("vortex.definition.saved_condition_revision_required", "unresolved_reference");
  const binding = bindings[0]!;
  const requirement = binding.version as Parameters<typeof compatibleVersion>[0];
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
    output.artifact.resolutionFingerprint !== resolution.snapshot.fingerprint ||
    output.resolutionFingerprint !== resolution.snapshot.fingerprint ||
    envelope.rootId !== expectedModule.rootId ||
    envelope.key !== moduleKey ||
    envelope.organizationId !== organizationId ||
    output.artifact.contentFingerprint !== fingerprintCanonicalValue(content) ||
    records.length !== 1
  )
    fail("vortex.definition.saved_condition_revision_required", "unresolved_reference");
  return {
    conditions: content.sharingConditions as JsonObject[],
    moduleV2: "validationContractVersion" in output,
  };
}

function fieldSettings(
  field: JsonObject,
  qualifiedRecordType: string,
  resolution: Resolution,
  permissionOwners: readonly string[],
  moduleV2 = false,
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
        ...(settings.minimum !== undefined
          ? { minimum: moduleV2 ? normaliseExactV2(settings.minimum) : settings.minimum }
          : {}),
        ...(settings.maximum !== undefined
          ? { maximum: moduleV2 ? normaliseExactV2(settings.maximum) : settings.maximum }
          : {}),
      };
    case "money":
      return {
        currencyMode:
          settings.currency_mode === "organisation_default"
            ? "organization_default"
            : settings.currency_mode,
        ...(settings.currency ? { currency: settings.currency } : {}),
        ...(settings.minimum !== undefined
          ? { minimum: moduleV2 ? normaliseExactV2(settings.minimum) : settings.minimum }
          : {}),
        ...(settings.maximum !== undefined
          ? { maximum: moduleV2 ? normaliseExactV2(settings.maximum) : settings.maximum }
          : {}),
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
                  moduleV2,
                  valueContext,
                ),
              }),
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
            : {
                source: "literal",
                value: moduleV2 ? normaliseExactV2(operand.value) : operand.value,
              },
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
                value: moduleV2 ? normaliseExactV2(amount.value) : amount.value,
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

function compileModule(
  source: JsonObject,
  resolution: Resolution,
  metadata: JsonObject,
  savedConditionRevisions: readonly JsonObject[],
  moduleV2 = false,
  dependencyOutputs: readonly DefinitionCompilationOutput[] = [],
) {
  const body = asObject(source.body);
  const definitionKey = String(source.key);
  const root = resolution.definition(definitionKey, "module");
  const permissionOwners = moduleFieldPermissionSourceOwners(source);
  const fieldsById = new Map<string, JsonObject>();
  for (const recordType of body.record_types as JsonObject[]) {
    const qualified = `${definitionKey}:${String(recordType.key)}`;
    for (const field of recordType.fields as JsonObject[])
      fieldsById.set(resolution.field(qualified, String(field.id)), field);
  }
  for (const output of dependencyOutputs) {
    if (output.kind !== "module") continue;
    for (const recordType of output.canonical.content.recordTypes as unknown as JsonObject[])
      for (const field of recordType.fields as JsonObject[])
        fieldsById.set(String(field.fieldId), field);
  }
  const fieldFor = (qualifiedRecordType: string, alias: string): JsonObject | undefined =>
    fieldsById.get(resolution.field(qualifiedRecordType, alias));
  const valueContextFor = (
    qualifiedRecordType: string,
    parameters?: ReadonlyMap<string, string>,
  ): ModuleValueContext => ({
    field: (reference, alias) => {
      if (alias !== undefined) return fieldFor(reference, alias);
      const separator = reference.lastIndexOf(".");
      return separator > reference.lastIndexOf(":")
        ? fieldFor(reference.slice(0, separator), reference.slice(separator + 1))
        : fieldFor(qualifiedRecordType, reference);
    },
    ...(parameters ? { parameters } : {}),
    resolution,
  });
  const recordTypes = (body.record_types as JsonObject[]).map((recordType) => {
    const recordKey = String(recordType.key);
    const qualified = `${definitionKey}:${recordKey}`;
    const valueContext = valueContextFor(qualified);
    const recordTypeId = resolution.id(definitionKey, "record_type", recordKey, "content");
    const fields = (recordType.fields as JsonObject[]).map((field) => ({
      fieldId: resolution.id(definitionKey, "field", String(field.id), `record:${recordKey}`),
      key: field.key,
      label: field.label,
      ...(field.help_text ? { helpText: field.help_text } : {}),
      required: field.required,
      ...(field.default !== undefined
        ? {
            default: moduleV2
              ? normaliseModuleFieldValueV2(field, field.default, valueContext, true)
              : field.default,
          }
        : {}),
      unique: field.unique,
      filterable: field.filterable,
      sortable: field.sortable,
      ...(field.search_priority ? { searchPriority: field.search_priority } : {}),
      personalData: field.personal_data,
      publicDisplay: field.public_display,
      type: field.type,
      settings: fieldSettings(
        field,
        qualified,
        resolution,
        permissionOwners,
        moduleV2,
        moduleV2 ? valueContext : undefined,
      ),
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
      ownershipMode: writeModuleRecordOwnershipModeV1(
        readModuleSourceRecordOwnershipModeV1(recordType.ownership_mode),
      ),
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
  const actions = (body.actions as JsonObject[]).map((action) => {
    const record = qualifiedForRecord(String(action.record_type));
    const localField = (alias: string) => resolution.field(record, alias);
    const inputTypes = new Map(
      (action.inputs as JsonObject[]).map((input) => [String(input.key), String(input.type)]),
    );
    const valueContext = valueContextFor(record, inputTypes);
    return {
      actionId: resolution.id(definitionKey, "action", String(action.id), "content"),
      key: action.key,
      label: action.label,
      subjectRecordTypeId: resolution.recordType(record).recordTypeId,
      ...(action.permission_alternatives
        ? { permissionKeys: action.permission_alternatives }
        : { permissionKey: action.permission }),
      sharing: action.shareable ? "allowed" : "refused",
      inputs: (action.inputs as JsonObject[]).map((input) =>
        actionInput(input, resolution, moduleV2),
      ),
      ...(action.precondition
        ? {
            precondition: condition(
              action.precondition,
              localField,
              moduleV2 ? valueContext : undefined,
            ),
          }
        : {}),
      effects: (action.effects as JsonObject[]).map((effect) => {
        if (effect.kind === "set_field")
          return (() => {
            const fieldId = localField(String(effect.field));
            return {
              kind: "set_field",
              fieldId,
              value: actionValue(
                effect.value,
                localField,
                fieldsById.get(fieldId),
                moduleV2 ? valueContext : undefined,
              ),
            };
          })();
        if (effect.kind === "create_record") {
          const target = String(effect.record_type);
          return {
            kind: "create_record",
            recordType: resolution.recordType(target),
            values: objectFromUniqueEntries(
              Object.entries(asObject(effect.values)).map(([key, value]) => {
                const fieldId = resolution.field(target, key);
                return [
                  fieldId,
                  actionValue(
                    value,
                    localField,
                    fieldsById.get(fieldId),
                    moduleV2 ? valueContext : undefined,
                  ),
                ];
              }),
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
    const valueContext = valueContextFor(record);
    const effect = asObject(rule.effect);
    let compiledEffect: unknown;
    if (effect.kind === "set_value")
      compiledEffect = {
        kind: "set_value",
        fieldId: localField(String(effect.field)),
        value: moduleV2
          ? normaliseModuleFieldValueV2(
              fieldsById.get(localField(String(effect.field))),
              effect.value,
              valueContext,
            )
          : effect.value,
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
      condition: condition(rule.condition, localField, moduleV2 ? valueContext : undefined),
      priority: rule.priority,
      effect: compiledEffect,
    };
  });
  const sharingConditions = (body.sharing_conditions as JsonObject[]).map((saved) => {
    const record = qualifiedForRecord(String(saved.source_record_type));
    const localField = (alias: string) => resolution.field(record, alias);
    const parameterTypes = new Map(
      (saved.parameters as JsonObject[]).map((parameter) => [
        String(parameter.key),
        String(parameter.type),
      ]),
    );
    const valueContext = valueContextFor(record, parameterTypes);
    const compiledCondition = condition(
      saved.condition,
      localField,
      moduleV2 ? valueContext : undefined,
    );
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
        parameters: moduleV2
          ? objectFromUniqueEntries(
              Object.entries(asObject(test.parameters)).map(([key, value]) => [
                key,
                normaliseModuleTypedValueV2(parameterTypes.get(key), value, valueContext),
              ]),
            )
          : test.parameters,
        fieldValues: objectFromUniqueEntries(
          Object.entries(asObject(test.field_values)).map(([key, value]) => [
            localField(key),
            moduleV2
              ? normaliseModuleFieldValueV2(fieldFor(record, key), value, valueContext)
              : value,
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
  const permissions = (body.permissions as JsonObject[]).map((permission) => {
    const recordScope = compilePermissionRecordScope(
      permission,
      source,
      resolution,
      sharingConditions,
      moduleV2
        ? valueContextFor(`${definitionKey}:${String(permission.record_type ?? "")}`)
        : undefined,
    );
    const fieldPolicy = compilePermissionFieldPolicy(permission, source, resolution);
    return {
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
      ...(recordScope === undefined ? {} : { recordScope }),
      ...(fieldPolicy === undefined ? {} : { fieldPolicy }),
    };
  });
  const canonical = (moduleV2 ? moduleDraftV2Schema : moduleDraftSchema).parse({
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

function compileApplicationPagesV2(
  source: JsonObject,
  resolution: Resolution,
  composition: MaterialisedApplicationCompositionV2,
) {
  const body = asObject(source.body);
  const definitionKey = String(source.key);
  const pageId = (alias: string) => resolution.id(definitionKey, "page", alias, "content");
  const queryId = (alias: string) => resolution.id(definitionKey, "query", alias, "content");
  const allowedPermissionOwners = permissionScopeSourceOwners(source);
  return (body.pages as JsonObject[]).map((page, index) => {
    const compiledComposition = composition.pages[index];
    if (compiledComposition === undefined)
      fail("vortex.definition.invalid_compilation_output", "invalid_value");
    const base = {
      pageId: pageId(String(page.id)),
      key: page.key,
      name: page.name,
      accessPermissionKey: resolution.exactOwnedReference(
        "permission",
        String(page.permission),
        allowedPermissionOwners,
      ),
      states: page.states,
      composition: compiledComposition.composition,
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
    if (page.type === "dashboard") return { ...base, type: "dashboard" };
    if (page.type === "detail")
      return {
        ...base,
        type: "detail",
        recordType: resolution.recordType(String(page.record_type)),
      };
    if (page.type === "form")
      return {
        ...base,
        type: "form",
        recordType: resolution.recordType(String(page.record_type)),
        commitActionKey: resolution.exactOwnedReference(
          "action",
          String(page.commit_action),
          allowedPermissionOwners,
        ),
      };
    if (page.type === "guided_form")
      return {
        ...base,
        type: "guided_form",
        recordType: resolution.recordType(String(page.record_type)),
        commitActionKey: resolution.exactOwnedReference(
          "action",
          String(page.commit_action),
          allowedPermissionOwners,
        ),
        steps: (page.steps as JsonObject[]).map((step) => ({
          id: resolution.id(
            definitionKey,
            "guided_step",
            String(step.id),
            `page:${String(page.key)}`,
          ),
          name: step.name,
          summary: step.summary,
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
      ...(page.public_action
        ? {
            publicActionKey: resolution.exactOwnedReference(
              "action",
              String(page.public_action),
              allowedPermissionOwners,
            ),
          }
        : {}),
      rateLimitPerMinute: page.rate_limit_per_minute,
    };
  });
}

function compileApplication(
  source: JsonObject,
  resolution: Resolution,
  metadata: JsonObject,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  compositionV2?: MaterialisedApplicationCompositionV2,
) {
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
  const pagesV1 =
    compositionV2 === undefined
      ? (body.pages as JsonObject[]).map((page) => {
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
                            durationFieldId: resolution.field(
                              record,
                              String(mapping.duration_field),
                            ),
                            durationUnit: mapping.duration_unit,
                          },
                  }
                : {}),
            };
          }
          if (page.type === "dashboard")
            return {
              ...base,
              type: "dashboard",
              blocks: (page.blocks as JsonObject[]).map(placement),
            };
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
            ...(page.record_type
              ? { recordType: resolution.recordType(String(page.record_type)) }
              : {}),
            publicFieldIds: page.record_type
              ? (page.public_fields as string[]).map((alias) =>
                  resolution.field(String(page.record_type), alias),
                )
              : [],
            ...(page.public_action ? { publicActionKey: page.public_action } : {}),
            blocks: (page.blocks as JsonObject[]).map(placement),
            rateLimitPerMinute: page.rate_limit_per_minute,
          };
        })
      : [];
  const pages =
    compositionV2 === undefined
      ? pagesV1
      : compileApplicationPagesV2(source, resolution, compositionV2);
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
  const permissions = (body.permissions as JsonObject[]).map((permission) => {
    const referencedSharing = applicationPermissionSharingConditions(
      permission,
      source,
      resolution,
      metadata.organizationId,
      dependencyOutputs,
    );
    const recordScope = compilePermissionRecordScope(
      permission,
      source,
      resolution,
      referencedSharing.conditions,
      undefined,
      referencedSharing.moduleV2,
    );
    const fieldPolicy = compilePermissionFieldPolicy(permission, source, resolution);
    return {
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
      ...(recordScope === undefined ? {} : { recordScope }),
      ...(fieldPolicy === undefined ? {} : { fieldPolicy }),
    };
  });
  const wildcardPermissions = permissions
    .filter((permission) => permission.administrative === false)
    .sort((left, right) => compareCanonicalStrings(String(left.key), String(right.key)));
  const wildcardPermissionKeys = wildcardPermissions.map((permission) => permission.key);
  const wildcardCatalogueFingerprint = fingerprintCanonicalValue(wildcardPermissions);
  const canonical = (compositionV2 ? applicationDraftV2Schema : applicationDraftSchema).parse({
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
      ...(compositionV2
        ? {
            platformBlockDependencies: compositionV2.platformBlockDependencies,
            shells: compositionV2.shells,
          }
        : {
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
          }),
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
          ...(action.permission_alternatives
            ? { permissionKeys: action.permission_alternatives }
            : { permissionKey: action.permission }),
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
        compositionV2?.theme ??
        (asObject(body.theme).mode === "application"
          ? {
              mode: "application",
              lightAndDark: asObject(body.theme).light_and_dark,
              tokens: asObject(body.theme).tokens,
            }
          : {
              mode: "platform",
              catalogueThemeId: asObject(body.theme).catalogue_theme_id,
              version: asObject(body.theme).version,
            }),
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

function parseDefinitionCompilationContext(
  context: unknown,
): readonly DefinitionCompilationOutput[] {
  if (context === undefined) return [];
  if (
    context === null ||
    typeof context !== "object" ||
    Array.isArray(context) ||
    Object.keys(context).some((key) => key !== "dependencyOutputs")
  )
    fail("vortex.definition.invalid_compilation_request", "invalid_value");
  const parsed = definitionPublicationContextSchema.safeParse({
    ...(context as JsonObject),
    publishedHistories: [],
  });
  if (!parsed.success) fail("vortex.definition.invalid_compilation_request", "invalid_value");
  return parsed.data.dependencyOutputs ?? [];
}

function compileDefinitionInternal(
  input: unknown,
  context?: DefinitionCompilationContext,
): DefinitionCompilationOutput {
  const parsed = definitionCompilationRequestSchema.safeParse(input);
  if (!parsed.success) fail("vortex.definition.invalid_compilation_request", "invalid_value");
  const request = parsed.data;
  const dependencyOutputs = parseDefinitionCompilationContext(context);
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
        dependencyOutputs,
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
      provenance: provenanceFor(source, canonical, resolution),
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

const applicationCompositionResolutionV2 = (
  source: ApplicationSourceDocumentV2,
  resolution: Resolution,
): ApplicationCompositionResolutionV2 => {
  const definitionKey = source.key;
  const allowedOwners = permissionScopeSourceOwners(source as unknown as JsonObject);
  const splitMember = (
    reference: string,
    code: DefinitionCompilerRefusalCode,
  ): readonly [string, string] => {
    const separator = reference.lastIndexOf(".");
    if (separator < 1) fail(code, "unresolved_reference");
    return [reference.slice(0, separator), reference.slice(separator + 1)];
  };
  return {
    identity: (kind, alias, scope = "content") => resolution.id(definitionKey, kind, alias, scope),
    field: (reference) => qualifiedField(resolution, reference),
    relationship: (reference) => {
      const [recordType, alias] = splitMember(
        reference,
        "vortex.definition.qualified_field_required",
      );
      return resolution.relationship(recordType, alias);
    },
    action: (reference) => resolution.exactOwnedReference("action", reference, allowedOwners),
    permission: (reference) =>
      resolution.exactOwnedReference("permission", reference, allowedOwners),
    condition: (authored) =>
      conditionNodeSchema.parse(
        condition(authored, (reference) => qualifiedField(resolution, reference)),
      ),
    recordType: (reference) => resolution.recordType(reference),
  };
};

const v2SpecialRoot = (path: Path): boolean =>
  path[0] === "body" &&
  (path[1] === "platform_block_dependencies" ||
    path[1] === "shells" ||
    path[1] === "theme" ||
    (path[1] === "pages" && path.includes("composition")));

const v2ThemeValueTargets = (
  sourcePath: Path,
  sourceValueRoot: Path,
  canonicalRoot: Path,
): Path[] => {
  const suffix = sourcePath.slice(sourceValueRoot.length);
  const mapped = suffix.map((segment) =>
    typeof segment === "string"
      ? ((
          {
            size_rem: "sizeRem",
            line_height: "lineHeight",
            width_rem: "widthRem",
            color_token: "colorToken",
            asset_id: "assetId",
          } as Readonly<Record<string, string>>
        )[segment] ?? segment)
      : segment,
  );
  return [[...canonicalRoot, ...mapped]];
};

const v2PropertyValueTargets = (
  source: ApplicationSourceDocumentV2,
  sourcePath: Path,
  sourceValueRoot: Path,
  canonicalRoot: Path,
): Path[] => {
  const suffix = sourcePath.slice(sourceValueRoot.length);
  if (suffix[0] === "kind") return [[...canonicalRoot, "kind"]];
  const leaf = String(suffix.at(-1));
  const valueKind = String(asObject(valueAtPath(source, sourcePath.slice(0, -1))).kind);
  const valueLeaf: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    asset_reference: { asset_id: "assetId" },
    icon: { icon_key: "iconKey" },
    theme_token: { token: "tokenKey" },
    field_reference: { field: "fieldId" },
    relationship_reference: { relationship: "relationshipId" },
    action_reference: { action: "actionKey" },
    page_reference: { page: "pageId" },
    query_reference: { query: "queryId" },
    pipeline_reference: { pipeline: "pipelineId" },
    record_reference: { record_id: "recordId" },
  };
  if (
    leaf === "record_type" &&
    (valueKind === "record_type_reference" || valueKind === "record_reference")
  ) {
    const target = [...canonicalRoot, ...suffix.slice(0, -1), "recordType"] as Path;
    return [
      [...target, "state"],
      [...target, "moduleRootId"],
      [...target, "recordTypeId"],
    ];
  }
  return [
    [...canonicalRoot, ...suffix.slice(0, -1), valueLeaf[valueKind]?.[leaf] ?? suffix.at(-1)!],
  ];
};

function v2SlotSourceTargets(
  source: ApplicationSourceDocumentV2,
  sourcePath: Path,
  sourceSlotRoot: Path,
  canonicalSlotRoot: Path,
  resolution: Resolution,
): Path[] | undefined {
  let sourceRoot = sourceSlotRoot;
  let canonicalRoot = canonicalSlotRoot;
  while (true) {
    const suffix = sourcePath.slice(sourceRoot.length);
    if (suffix[0] === "order" && typeof suffix[1] === "string") {
      const authoredOrder = asObject(valueAtPath(source, sourceRoot)).order as JsonObject;
      const breakpoint = suffix[1];
      const inherited = [
        breakpoint,
        ...(breakpoint === "desktop" && authoredOrder.tablet === undefined ? ["tablet"] : []),
        ...((
          breakpoint === "desktop"
            ? authoredOrder.tablet === undefined && authoredOrder.phone === undefined
            : breakpoint === "tablet" && authoredOrder.phone === undefined
        )
          ? ["phone"]
          : []),
      ];
      return inherited.map((target) => [...canonicalRoot, "order", target, ...suffix.slice(2)]);
    }
    if (suffix[0] !== "placements" || typeof suffix[1] !== "string") return undefined;
    const alias = suffix[1];
    sourceRoot = [...sourceRoot, "placements", alias];
    canonicalRoot = [
      ...canonicalRoot,
      "placements",
      resolution.id(source.key, "block_placement", alias, "content"),
    ];
    const placementSuffix = sourcePath.slice(sourceRoot.length);
    const property = placementSuffix[0];
    if (property === "slots" && typeof placementSuffix[1] === "string") {
      sourceRoot = [...sourceRoot, "slots", placementSuffix[1]];
      canonicalRoot = [...canonicalRoot, "slots", placementSuffix[1]];
      continue;
    }
    if (property === "block")
      return [
        [
          ...canonicalRoot,
          "block",
          placementSuffix[1] === "block_id" ? "blockId" : "releaseVersion",
        ],
      ];
    if (property === "view_permission") return [[...canonicalRoot, "viewPermissionKey"]];
    if (property === "use_permission") return [[...canonicalRoot, "usePermissionKey"]];
    if (property === "query") return [[...canonicalRoot, "queryId"]];
    if (property === "visibility_condition")
      return conditionSourceTargets(source as unknown as JsonObject, sourcePath, {
        sourceRoot: [...sourceRoot, "visibility_condition"],
        canonicalRoot: [...canonicalRoot, "visibilityCondition"],
      });
    if (
      property === "responsive" &&
      typeof placementSuffix[1] === "string" &&
      typeof placementSuffix[2] === "string"
    ) {
      const responsive = asObject(asObject(valueAtPath(source, sourceRoot)).responsive);
      const breakpoint = placementSuffix[1];
      const inherited = [
        breakpoint,
        ...(breakpoint === "desktop" && responsive.tablet === undefined ? ["tablet"] : []),
        ...((
          breakpoint === "desktop"
            ? responsive.tablet === undefined && responsive.phone === undefined
            : breakpoint === "tablet" && responsive.phone === undefined
        )
          ? ["phone"]
          : []),
      ];
      return inherited.map((target) => [
        ...canonicalRoot,
        "responsive",
        target,
        ...placementSuffix
          .slice(2)
          .map((segment) => (segment === "start_column" ? "startColumn" : segment)),
      ]);
    }
    if (property === "theme_overrides" && typeof placementSuffix[1] === "string")
      return v2ThemeValueTargets(
        sourcePath,
        [...sourceRoot, "theme_overrides", placementSuffix[1]],
        [...canonicalRoot, "themeOverrides", placementSuffix[1]],
      );
    if (property === "settings" && typeof placementSuffix[1] === "string")
      return v2PropertyValueTargets(
        source,
        sourcePath,
        [...sourceRoot, "settings", placementSuffix[1]],
        [...canonicalRoot, "settings", placementSuffix[1]],
      );
    return undefined;
  }
}

function v2SpecialSourceTargets(
  source: ApplicationSourceDocumentV2,
  sourcePath: Path,
  resolution: Resolution,
): Path[] | undefined {
  if (sourcePath[1] === "platform_block_dependencies" && typeof sourcePath[2] === "number")
    return [
      [
        "content",
        "platformBlockDependencies",
        sourcePath[2],
        ...sourcePath.slice(3).map((segment) => camelCase(String(segment))),
      ],
    ];
  if (sourcePath[1] === "theme") {
    if (sourcePath[2] === "base")
      return [
        [
          "content",
          "theme",
          "base",
          ...sourcePath.slice(3).map((segment) => camelCase(String(segment))),
        ],
      ];
    if (sourcePath[2] === "token_overrides" && typeof sourcePath[3] === "string")
      return v2ThemeValueTargets(
        sourcePath,
        ["body", "theme", "token_overrides", sourcePath[3]],
        ["content", "theme", "tokens", sourcePath[3]],
      );
  }
  if (sourcePath[1] === "shells" && typeof sourcePath[2] === "number") {
    const shell = source.body.shells[sourcePath[2]];
    if (shell === undefined) return undefined;
    const shellRoot: Path = ["content", "shells", sourcePath[2]];
    if (sourcePath[3] === "layout")
      return v2SlotSourceTargets(
        source,
        sourcePath,
        ["body", "shells", sourcePath[2], "layout"],
        [...shellRoot, "layout"],
        resolution,
      );
    if (
      sourcePath[3] === "content_slots" &&
      typeof sourcePath[4] === "number" &&
      typeof sourcePath[5] === "string"
    ) {
      const key: Readonly<Record<string, string>> = {
        id: "slotId",
        allowed_child_categories: "allowedChildCategories",
        parent_placement: "parentPlacementId",
        parent_slot: "parentSlotKey",
      };
      return [
        [
          ...shellRoot,
          "contentSlots",
          sourcePath[4],
          key[sourcePath[5]] ?? camelCase(sourcePath[5]),
          ...sourcePath.slice(6),
        ],
      ];
    }
    if (sourcePath[3] === "id") return [[...shellRoot, "shellId"]];
    if (typeof sourcePath[3] === "string") return [[...shellRoot, camelCase(sourcePath[3])]];
  }
  if (
    sourcePath[1] === "pages" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "composition"
  ) {
    const page = source.body.pages[sourcePath[2]];
    if (page === undefined) return undefined;
    const composition = page.composition;
    const root: Path = ["content", "pages", sourcePath[2], "composition"];
    if (sourcePath[4] === "shell_kind") return [[...root, "shellKind"]];
    if (sourcePath[4] === "shell") return [[...root, "shellId"]];
    if (sourcePath[4] === "main")
      return v2SlotSourceTargets(
        source,
        sourcePath,
        ["body", "pages", sourcePath[2], "composition", "main"],
        [...root, "main"],
        resolution,
      );
    if (sourcePath[4] === "content" && typeof sourcePath[5] === "string") {
      const slotAlias = sourcePath[5];
      return v2SlotSourceTargets(
        source,
        sourcePath,
        ["body", "pages", sourcePath[2], "composition", "content", slotAlias],
        [...root, "content", resolution.id(source.key, "shell_content_slot", slotAlias, "content")],
        resolution,
      );
    }
    if (sourcePath[4] === "step_content" && typeof sourcePath[5] === "string") {
      const stepAlias = sourcePath[5];
      const stepId = resolution.id(source.key, "guided_step", stepAlias, "page:" + page.key);
      if (composition.shell_kind === "default")
        return v2SlotSourceTargets(
          source,
          sourcePath,
          ["body", "pages", sourcePath[2], "composition", "step_content", stepAlias],
          [...root, "stepContent", stepId],
          resolution,
        );
      if (typeof sourcePath[6] !== "string") return undefined;
      const slotAlias = sourcePath[6];
      return v2SlotSourceTargets(
        source,
        sourcePath,
        ["body", "pages", sourcePath[2], "composition", "step_content", stepAlias, slotAlias],
        [
          ...root,
          "stepContent",
          stepId,
          resolution.id(source.key, "shell_content_slot", slotAlias, "content"),
        ],
        resolution,
      );
    }
  }
  return undefined;
}

function applicationProvenanceV2(
  source: ApplicationSourceDocumentV2,
  canonical: unknown,
  resolution: Resolution,
): DefinitionProvenanceEntry[] {
  const sourceObject = source as unknown as JsonObject;
  const positions = sourceContractPositions(sourceObject);
  const sourceLeaves = leafPaths(source).filter(
    (path) => !(path.length === 1 && (path[0] === "source_contract_version" || path[0] === "kind")),
  );
  const canonicalLeaves = leafPaths(canonical);
  const canonicalLeafSet = new Set(canonicalLeaves.map(pathKey));
  const entries: DefinitionProvenanceEntry[] = [];
  for (const sourcePath of sourceLeaves) {
    const targets = v2SpecialRoot(sourcePath)
      ? v2SpecialSourceTargets(source, sourcePath, resolution)
      : (explicitSourceTargets(sourceObject, canonical, sourcePath, positions, resolution) ?? [
          sourceToCanonicalPath(sourceObject, canonical, sourcePath, positions),
        ]);
    if (targets === undefined || targets.length === 0) {
      fail("vortex.definition.invalid_compilation_output", "invalid_value");
    }
    for (const canonicalPath of targets) {
      if (!canonicalLeafSet.has(pathKey(canonicalPath))) {
        fail("vortex.definition.invalid_compilation_output", "invalid_value");
      }
      const transformed =
        canonicalJson(valueAtPath(source, sourcePath)) !==
        canonicalJson(valueAtPath(canonical, canonicalPath));
      const pageReference =
        sourcePath[0] === "body" &&
        sourcePath[1] === "pages" &&
        typeof sourcePath[2] === "number" &&
        ["permission", "commit_action", "public_action"].includes(String(sourcePath.at(-1)));
      const sourceParentValue = valueAtPath(source, sourcePath.slice(0, -1));
      const sourceParent =
        sourceParentValue !== null &&
        typeof sourceParentValue === "object" &&
        !Array.isArray(sourceParentValue)
          ? (sourceParentValue as JsonObject)
          : undefined;
      const propertyReferenceLeaf: Readonly<Record<string, string>> = {
        action_reference: "action",
        field_reference: "field",
        page_reference: "page",
        pipeline_reference: "pipeline",
        query_reference: "query",
        record_reference: "record_type",
        record_type_reference: "record_type",
        relationship_reference: "relationship",
        theme_token: "token",
      };
      const propertyReference =
        sourceParent !== undefined &&
        propertyReferenceLeaf[String(sourceParent.kind)] === String(sourcePath.at(-1));
      const compositionReference =
        v2SpecialRoot(sourcePath) &&
        (["shell", "parent_placement", "view_permission", "use_permission"].includes(
          String(sourcePath.at(-1)),
        ) ||
          propertyReference);
      const resolved =
        sourceResolvesIdentity(sourcePath, positions) ||
        recordScopeSourceResolvesIdentity(sourcePath) ||
        fieldPolicySourceResolvesIdentity(sourcePath) ||
        pageReference ||
        compositionReference ||
        (v2SpecialRoot(sourcePath) &&
          sourcePath.includes("order") &&
          typeof sourcePath.at(-1) === "number");
      entries.push({
        canonicalPath,
        origin: resolved ? "resolved" : "source",
        sourcePath,
        ...(resolved
          ? { ruleCode: RESOLUTION_RULE }
          : transformed
            ? { ruleCode: TRANSFORM_RULE }
            : {}),
      });
    }
  }
  const represented = new Set(entries.map((entry) => pathKey(entry.canonicalPath)));
  for (const canonicalPath of canonicalLeaves) {
    if (represented.has(pathKey(canonicalPath))) continue;
    if (isSystemCanonicalPath(canonicalPath)) {
      entries.push({ canonicalPath, origin: "system_metadata", ruleCode: SYSTEM_RULE });
      continue;
    }
    if (isFixedWorkflowDefaultPath(canonicalPath)) {
      entries.push({ canonicalPath, origin: "fixed_default", ruleCode: DEFAULT_RULE });
      continue;
    }
    if (canonicalPath[0] === "content" && canonicalPath[1] === "theme") {
      entries.push({
        canonicalPath,
        origin: "resolved",
        sourcePath: ["body", "theme", "base", "content_fingerprint"],
        ruleCode: RESOLUTION_RULE,
      });
      continue;
    }
    const placementsIndex = canonicalPath.lastIndexOf("placements");
    if (placementsIndex >= 0 && canonicalPath.includes("settings")) {
      const placement = asObject(
        valueAtPath(canonical, canonicalPath.slice(0, placementsIndex + 2)),
      );
      const blockId = String(asObject(placement.block).blockId);
      const dependencyIndex = source.body.platform_block_dependencies.findIndex(
        (dependency) => String(dependency.block_id) === blockId,
      );
      if (dependencyIndex < 0)
        fail("vortex.definition.application_dependency_manifest", "broken_reference");
      entries.push({
        canonicalPath,
        origin: "resolved",
        sourcePath: ["body", "platform_block_dependencies", dependencyIndex, "content_fingerprint"],
        ruleCode: RESOLUTION_RULE,
      });
      continue;
    }
    fail("vortex.definition.invalid_compilation_output", "invalid_value");
  }
  return entries;
}

function compileApplicationV2Internal(
  input: unknown,
  context?: DefinitionCompilationContext,
): ApplicationCompilationOutputV2 {
  const parsed = applicationCompilationRequestV2Schema.safeParse(input);
  if (!parsed.success) fail("vortex.definition.invalid_compilation_request", "invalid_value");
  const request = parsed.data;
  const source = request.source;
  const sourceObject = source as unknown as JsonObject;
  const dependencyOutputs = parseDefinitionCompilationContext(context);
  try {
    const resolution = new Resolution(request.resolution, sourceObject);
    const composition = materialiseApplicationCompositionV2(
      source,
      request.catalogueSnapshot,
      applicationCompositionResolutionV2(source, resolution),
    );
    const canonical = applicationDraftV2Schema.parse(
      compileApplication(
        sourceObject,
        resolution,
        request.draftMetadata as unknown as JsonObject,
        dependencyOutputs,
        composition,
      ),
    );
    const ownDefinition = resolution.definition(source.key, "application");
    const artifact = {
      kind: "application" as const,
      definitionKey: source.key,
      rootId: ownDefinition.rootId,
      exactVersion: ownDefinition.exactVersion,
      contentFingerprint: fingerprintCanonicalValue(canonical.content),
      resolutionFingerprint: request.resolution.fingerprint,
    };
    const output = applicationCompilationOutputV2Schema.safeParse({
      kind: "application",
      validationContractVersion: "2.0.0",
      canonical,
      artifact,
      provenance: applicationProvenanceV2(source, canonical, resolution),
      dependencyOrder: dependencyOrder(sourceObject),
      resolvedDependencies: resolvedDependencies(sourceObject, resolution),
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
            compilerRootLocation(sourceObject),
          );
    return fail("vortex.definition.invalid_compilation_output", "invalid_value");
  }
}

function compileModuleV2Internal(
  input: unknown,
  context?: DefinitionCompilationContext,
): ModuleCompilationOutputV2 {
  const parsed = moduleCompilationRequestV2Schema.safeParse(input);
  if (!parsed.success) fail("vortex.definition.invalid_compilation_request", "invalid_value");
  const request = parsed.data;
  const source = request.source as unknown as JsonObject;
  const dependencyOutputs = parseDefinitionCompilationContext(context);
  try {
    const resolution = new Resolution(request.resolution, source);
    const canonical = moduleDraftV2Schema.parse(
      compileModule(
        source,
        resolution,
        request.draftMetadata as unknown as JsonObject,
        (request.savedConditionRevisions ?? []) as unknown as JsonObject[],
        true,
        dependencyOutputs,
      ),
    );
    const ownDefinition = resolution.definition(request.source.key, "module");
    const artifact = {
      kind: "module" as const,
      definitionKey: request.source.key,
      rootId: ownDefinition.rootId,
      exactVersion: ownDefinition.exactVersion,
      contentFingerprint: fingerprintCanonicalValue(canonical.content),
      resolutionFingerprint: request.resolution.fingerprint,
    };
    const output = moduleCompilationOutputV2Schema.safeParse({
      kind: "module",
      validationContractVersion: "2.0.0",
      canonical,
      artifact,
      provenance: provenanceFor(source, canonical, resolution),
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

const explicitCompilationKind = (input: unknown): "module" | "application" | undefined => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const request = input as JsonObject;
  if (!("sourceContractVersion" in request) && !("validationContractVersion" in request))
    return undefined;
  if (
    request.source === null ||
    typeof request.source !== "object" ||
    Array.isArray(request.source)
  )
    return undefined;
  const kind = (request.source as JsonObject).kind;
  return kind === "module" || kind === "application" ? kind : undefined;
};

export function compileDefinition(
  input: ApplicationCompilationRequestV2,
): ApplicationCompilationOutputV2;
export function compileDefinition(input: ModuleCompilationRequestV2): ModuleCompilationOutputV2;
export function compileDefinition(input: DefinitionCompilationRequest): DefinitionCompilationOutput;
export function compileDefinition(
  input: unknown,
): DefinitionCompilationOutput | ApplicationCompilationOutputV2 {
  const explicitKind = explicitCompilationKind(input);
  if (explicitKind === "module") return compileModuleV2Internal(input);
  if (explicitKind === "application") return compileApplicationV2Internal(input);
  return compileDefinitionInternal(input);
}

export function compileDefinitionWithContext(
  input: ApplicationCompilationRequestV2,
  context: DefinitionCompilationContext,
): ApplicationCompilationOutputV2;
export function compileDefinitionWithContext(
  input: ModuleCompilationRequestV2,
  context: DefinitionCompilationContext,
): ModuleCompilationOutputV2;
export function compileDefinitionWithContext(
  input: DefinitionCompilationRequest,
  context: DefinitionCompilationContext,
): DefinitionCompilationOutput;
export function compileDefinitionWithContext(
  input: unknown,
  context: DefinitionCompilationContext,
): DefinitionCompilationOutput | ApplicationCompilationOutputV2 {
  const explicitKind = explicitCompilationKind(input);
  if (explicitKind === "module") return compileModuleV2Internal(input, context);
  if (explicitKind === "application") return compileApplicationV2Internal(input, context);
  return compileDefinitionInternal(input, context);
}
