import { createHash } from "node:crypto";
import { satisfies } from "semver";
import {
  applicationSourceDocumentV2Schema,
  applicationCompilationOutputV2Schema,
  applicationCompilationRequestV2Schema,
  applicationDraftV2Schema,
  applicationToolBundleSchema,
  calculationMaximumNestingDepth,
  descriptionSchema,
  conditionNodeSchema,
  jsonValueSchema,
  walkDefinitionContract,
  connectionTypeSchema,
  definitionCompilationOutputSchema,
  definitionCompilationRequestSchema,
  definitionPublicationContextSchema,
  definitionSourceDocumentSchema,
  moduleDraftV3Schema,
  moduleCompilationOutputV3Schema,
  moduleCompilationRequestV3Schema,
  moduleSourceDocumentSchema,
  sourceFlowCollectionSchema,
  ruleIdSchema,
  containedComponentIdSchema,
  recordTypeIdSchema,
  fieldIdSchema,
  isPlatformPermissionKey,
  PLATFORM_SERVICE_OPERATIONS,
  flowContractVersion,
  normalizeExactDecimal,
  readModuleSourceRecordOwnershipMode,
  type ApplicationCompilationOutputV2,
  type ApplicationCompilationRequestV2,
  type ApplicationDraftV2,
  type ApplicationToolBundleInput,
  type ApplicationToolOperationReference,
  type ApplicationToolBundle,
  type NavigationItem,
  type PlatformServiceOperationKey,
  type ModuleCompilationOutputV3,
  type ModuleCompilationRequestV3,
  type ModuleSourceDocument,
  type CompiledFlowSet,
  type FlowDefinition,
  type FlowFormula,
  type FlowReference,
  type FlowInputDeclaration,
  type FlowTask,
  type FlowValue,
  type JsonValue,
  type RuleGraph,
  type DefinitionCompilationRequest,
  type ApplicationSourceDocumentV2,
  type DefinitionCompilationOutput,
  type DefinitionProvenanceEntry,
  type DefinitionResolutionSnapshot,
  type DefinitionResolutionSnapshotV2,
  type DefinitionResolutionSnapshotV3,
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
  extractModuleSourceIdentityRequirementsV3,
} from "./source-identities";
import { deriveFormCommitActionKeys } from "./form-commit";
import { compileRuleGraph } from "./rule-graph-compilation";
import {
  materialiseApplicationCompositionV2,
  type MaterialisedApplicationCompositionV2,
} from "./application-v2-composition";
import type {
  ApplicationCompositionResolutionV2,
  FieldInputSourceField,
} from "./application-v2-resolution";
import { validateApplicationSourceCatalogue } from "./application-catalogue-validation";
import { settleDefinitionRuleFailures } from "./rule-failure-order";
import { compileFlowSources, type ResolvedFlowIdentity } from "./flow-compilation";
import { isBeforeSaveFlow, lowerBeforeSaveFlow } from "./before-save-flow-rules";
import {
  findOperationCallIssue,
  namedActionInputs,
  platformOperationLookup,
} from "./flow-operation-calls";
import { flowIssueLocation } from "./flow-validation";

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
  "organization_field",
  "revision_field",
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
  workflows: "workflowId",
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
    source.kind === "module"
      ? moduleSourceDocumentSchema
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
    // A flow value's `trigger_record.field` names a readable field key, not a permanent identity,
    // so it never takes the field-to-identity suffix map.
    const flowReferenceField =
      segment === "field" && sourcePath[sourceIndex - 1] === "reference";
    const mappedKey = isDataProperty(positions, sourcePath, sourceIndex) || flowReferenceField
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
    source.source_contract_version === "2.0.0" || source.kind === "module"
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

/**
 * An interface operation that changes data or starts background work targets an application flow
 * entry point by its source alias, which compiles to that flow's permanent identity (#1097).
 */
function isInterfaceOperationFlowTargetPath(source: JsonObject, sourcePath: Path): boolean {
  return (
    source.kind === "application" &&
    sourcePath.length === 7 &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "interfaces" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "operations" &&
    typeof sourcePath[4] === "number" &&
    sourcePath[5] === "target" &&
    sourcePath[6] === "flow"
  );
}

function explicitSourceTargets(
  source: JsonObject,
  canonical: unknown,
  sourcePath: Path,
  positions: SourceContractPositions,
  resolution: Resolution,
): Path[] | undefined {
  if (isInterfaceOperationFlowTargetPath(source, sourcePath))
    return [["content", ...sourcePath.slice(1, -1), "flowId"]];
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
    (sourcePath[1] === "actions" || sourcePath[1] === "queries") &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "inputs" &&
    typeof sourcePath[4] === "number" &&
    sourcePath[5] === "record_types" &&
    typeof sourcePath[6] === "number" &&
    sourcePath.length === 7
  ) {
    const targetPath: Path = [
      "content",
      sourcePath[1],
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
    sourcePath[3] === "tasks" &&
    typeof sourcePath[4] === "number" &&
    sourcePath[5] === "properties" &&
    sourcePath[6] === "record_type" &&
    sourcePath.length === 7
  ) {
    const targetPath: Path = [
      "content",
      "actions",
      sourcePath[2],
      "tasks",
      sourcePath[4],
      "properties",
      "recordType",
    ];
    return leafPaths(valueAtPath(canonical, targetPath), targetPath);
  }
  if (
    (source.kind === "module" || source.kind === "application") &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "actions" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "protected_operation" &&
    sourcePath.length === 4
  ) {
    const targetPath: Path = ["content", "actions", sourcePath[2], "protectedOperation"];
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
    source.kind === "module" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "contributions" &&
    typeof sourcePath[2] === "number" &&
    typeof sourcePath[3] === "string"
  ) {
    const base: Path = ["content", "contributions", sourcePath[2]];
    if (sourcePath[3] === "dependency" && sourcePath.length === 4) {
      const targetModulePath: Path = [...base, "targetModule"];
      return leafPaths(valueAtPath(canonical, targetModulePath), targetModulePath);
    }
    if (sourcePath[3] === "extension_point" && sourcePath.length === 4)
      return [[...base, "targetExtensionPointId"]];
    if (sourcePath[3] === "contributed_action" && sourcePath.length === 4)
      return [[...base, "actionId"]];
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
      sourcePath[3] === "public_fields" &&
      typeof sourcePath[4] === "number" &&
      sourcePath.length === 5
    )
      return [[...pageBase, "publicFieldIds", sourcePath[4]]];
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
    (source.kind === "application" || source.kind === "module") &&
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
      sourcePath.length === 7 &&
      sourcePath[6] === "decimal_places"
    )
      return [[...base, "fields", sourcePath[4], "settings", "decimalPlaces"]];
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
      // A numeric operand may itself be a numeric operation over nested operands; the nesting keeps
      // its shape and only the operation and field keys are renamed.
      let leafIndex = 9;
      while (sourcePath[leafIndex] === "operands" && typeof sourcePath[leafIndex + 1] === "number")
        leafIndex += 2;
      const leaf = sourcePath[leafIndex];
      if (
        sourcePath[7] === "operands" &&
        typeof sourcePath[8] === "number" &&
        typeof leaf === "string"
      ) {
        const operandBase: Path = [...expressionBase, ...sourcePath.slice(7, leafIndex)];
        if (leaf === "numeric_operation") return [[...operandBase, "operation"]];
        if (leaf === "field") {
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
          // Field dependencies are collected depth first, in operand order, as the compiler does.
          const fieldOperandPaths: string[] = [];
          const collect = (operands: JsonObject[], prefix: Path) =>
            operands.forEach((operand, index) => {
              if (operand.source === "field") fieldOperandPaths.push(pathKey([...prefix, index]));
              else if (operand.source === "numeric")
                collect(operand.operands as JsonObject[], [...prefix, index, "operands"]);
            });
          collect(expression.operands as JsonObject[], ["operands"]);
          const dependencyIndex = fieldOperandPaths.indexOf(
            pathKey(sourcePath.slice(7, leafIndex)),
          );
          return [
            [...operandBase, "fieldId"],
            [...fieldBase, "dependencyFieldIds", dependencyIndex],
          ];
        }
        return [[...operandBase, leaf]];
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
      extension_points: "extensionPoints",
    };
    const canonicalCollection = collectionMap[collection];
    if (canonicalCollection) {
      const targetKey =
        collection === "actions" ? "subjectRecordTypeId" : "recordTypeId";
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
    sourcePath[3] === "tasks" &&
    typeof sourcePath[4] === "number" &&
    sourcePath[5] === "properties" &&
    sourcePath[6] === "changes" &&
    typeof sourcePath[7] === "number" &&
    sourcePath[8] === "relationships" &&
    typeof sourcePath[9] === "number" &&
    sourcePath.length === 10
  )
    return [
      [
        "content",
        "actions",
        sourcePath[2],
        "tasks",
        sourcePath[4],
        "properties",
        "changes",
        sourcePath[7],
        "relationshipIds",
        sourcePath[9],
      ],
    ];
  return undefined;
}

const moduleSourceTransformPatterns = [
  /^root_alias$/,
  /^body\/(?:record_types|permissions|actions|events|rules|extension_points|sharing_conditions|queries)\/#\/id$/,
  /^body\/record_types\/#\/(?:fields|relationships)\/#\/id$/,
  /^body\/dependencies\/#\/module$/,
  /^body\/contributions\/#\/(?:id|dependency|extension_point|record_type|field|contributed_action)$/,
  /^body\/record_types\/#\/(?:name|plural_name|custom_actions\/#|ownership_mode|storage_scope)$/,
  /^body\/record_types\/#\/(?:storage_contract_id|title_field|ownership_relationship)$/,
  /^body\/record_types\/#\/system_projection\/(?:organization_field|revision_field)$/,
  /^body\/record_types\/#\/system_projection\/(?:filterable_fields|sortable_fields)\/#$/,
  /^body\/record_types\/#\/fields\/#\/default(?:\/.*)?$/,
  /^body\/record_types\/#\/fields\/#\/settings\/(?:minimum|maximum)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/decimal_places$/,
  /^body\/record_types\/#\/fields\/#\/settings\/columns\/#\/settings\/(?:minimum|maximum)$/,
  /^body\/record_types\/#\/relationships\/#\/(?:from_field|to_record_type|to_record_types\/#)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/(?:application_root_required|audience|currency_mode|field|relationship|target|targets\/#)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/(?:options\/#|columns\/#\/settings\/options\/#)\/required_permission$/,
  /^body\/record_types\/#\/fields\/#\/settings\/columns\/#\/settings\/(?:currency_mode|display_time_zone)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/display_time_zone$/,
  /^body\/record_types\/#\/fields\/#\/settings\/expression\/(?:operation|numeric_operation|amount_field|percentage_field|fields\/#|date_field|due_field|status_field)$/,
  /^body\/record_types\/#\/fields\/#\/settings\/expression\/operands\/#\/(?:operands\/#\/)*(?:field|source|value|numeric_operation)(?:\/.*)?$/,
  /^body\/record_types\/#\/fields\/#\/settings\/expression\/amount\/(?:field|source|value)(?:\/.*)?$/,
  /^body\/(?:permissions|events|rules|extension_points)\/#\/record_type$/,
  /^body\/events\/#\/carries\/#$/,
  /^body\/actions\/#\/(?:record_type|permission|shareable)$/,
  /^body\/actions\/#\/inputs\/#\/(?:type|record_types\/#)$/,
  /^body\/actions\/#\/inputs\/#\/validation\/(?:minimum|maximum)$/,
  /^body\/actions\/#\/protected_operation$/,
  /^body\/actions\/#\/tasks\/#\/properties\/(?:record_type|event)$/,
  /^body\/actions\/#\/tasks\/#\/properties\/changes\/#\/(?:relationships\/#|target_input)$/,
  /^body\/actions\/#\/tasks\/#\/properties\/values\/[^/]+\/literal\/value(?:\/.*)?$/,
  /^body\/queries\/#\/(?:id|record_type|select\/#|group_by\/#)$/,
  /^body\/queries\/#\/inputs\/#\/(?:type|record_types\/#)$/,
  /^body\/queries\/#\/inputs\/#\/validation\/(?:minimum|maximum)$/,
  /^body\/queries\/#\/filter$/,
  /^body\/queries\/#\/sort\/#\/field$/,
  /^body\/queries\/#\/aggregates\/#\/field$/,
  /^body\/rules\/#\/effect\/(?:field|message|component|workflow|reason_code)$/,
  /^body\/rules\/#\/effect\/value(?:\/.*)?$/,
  /^body\/sharing_conditions\/#\/(?:source_record_type|declared_fields\/#)$/,
  /^body\/sharing_conditions\/#\/publication_tests\/#\/(?:field_values|parameters)\/[^/]+(?:\/.*)?$/,
  /^body\/permissions\/#\/record_scope\/.+$/,
  /^body\/permissions\/#\/field_policy\/(?:readable_fields|changeable_fields)\/#$/,
] as const;

const applicationSourceTransformPatterns = [
  /^root_alias$/,
  /^body\/(?:permissions|actions|rules|events|roles|block_registrations|pages|pipelines|interfaces|public_addresses)\/#\/id$/,
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
  /^body\/pages\/#\/(?:id|record_type|query|permission|public_action|public_fields\/#)$/,
  /^body\/experiences\/#\/page$/,
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
  /^body\/(?:permissions|actions|events|rules)\/#\/record_type$/,
  /^body\/permissions\/#\/record_scope\/.+$/,
  /^body\/permissions\/#\/field_policy\/(?:readable_fields|changeable_fields)\/#$/,
  /^body\/actions\/#\/(?:permission|sharing)$/,
  /^body\/actions\/#\/inputs\/#\/(?:type|record_types\/#)$/,
  /^body\/actions\/#\/tasks\/#\/properties\/(?:record_type|event)$/,
  /^body\/actions\/#\/tasks\/#\/properties\/changes\/#\/(?:relationships\/#|target_input)$/,
  /^body\/actions\/#\/tasks\/#\/properties\/values\/[^/]+\/literal\/value(?:\/.*)?$/,
  /^body\/rules\/#\/effect\/(?:field|message|component|workflow|reason_code)$/,
  /^body\/rules\/#\/effect\/value(?:\/.*)?$/,
  /^body\/pipelines\/#\/stages\/#\/(?:entry_actions|exit_actions)\/#$/,
] as const;

const connectionSourceTransformPatterns = [
  /^root_alias$/,
  /^body\/authentication\/secret_fields\/#$/,
  /^body\/operations\/#\/(?:input|output|path|max_attempts)$/,
  /^body\/incoming_messages\/#\/(?:input|workflow_trigger)$/,
  /^body\/(?:health_operation|revocation_operation)$/,
] as const;

function conditionSourcePathPattern(root: string): RegExp {
  const prefix = root.replaceAll("#", "\\#").replaceAll("/", "\\/");
  return new RegExp(
    `^${prefix}(?:(?:\\/(?:all|any)\\/#)|(?:\\/not))*\\/(?:field|operator|parameter|value|(?:left|right)\\/(?:source|field|parameter|value))(?:\\/.*)?$`,
  );
}

// Built once: these run for every source leaf of every compile. No flags, so no lastIndex state.
const conditionSourcePathPatterns = [
  "body/actions/#/precondition",
  "body/rules/#/condition",
  "body/sharing_conditions/#/condition",
  "body/record_types/#/fields/#/settings/filter",
  "body/record_types/#/fields/#/settings/expression/condition",
  "body/queries/#/filter",
  "body/pipelines/#/transitions/#/gate",
  "body/pages/#/blocks/#/visibility_condition",
  "body/pages/#/steps/#/blocks/#/visibility_condition",
].map(conditionSourcePathPattern);

function isConditionSourcePath(path: string): boolean {
  return conditionSourcePathPatterns.some((pattern) => pattern.test(path));
}

function sourceTransformationApproved(source: JsonObject, sourcePath: Path): boolean {
  const normalized = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment));
  const path = normalized.join("/");
  if (isConditionSourcePath(path)) return true;
  const patterns =
    source.kind === "module"
      ? moduleSourceTransformPatterns
      : source.kind === "application"
        ? applicationSourceTransformPatterns
        : connectionSourceTransformPatterns;
  return patterns.some((pattern) => pattern.test(path));
}

function applicationTypedValueTarget(
  source: JsonObject,
  sourcePath: Path,
  targetPath: Path,
  canonicalLeafSet: ReadonlySet<string>,
): Path {
  // Only normalized typed-value leaves need remapping; preserve resolved targets
  // and unchanged opaque data, even when their property names look like references.
  if (
    source.kind !== "application" ||
    canonicalLeafSet.has(pathKey(targetPath)) ||
    targetPath.at(-1) !== sourcePath.at(-1) ||
    !sourceTransformationApproved(source, sourcePath) ||
    !["record_type", "record_id", "organization_account_id"].includes(String(sourcePath.at(-1)))
  )
    return targetPath;
  const leaf = String(sourcePath.at(-1));
  const canonicalLeaf =
    leaf === "record_type"
      ? "recordTypeId"
      : leaf === "record_id"
        ? "recordId"
        : "organizationAccountId";
  const candidate = [...targetPath.slice(0, -1), canonicalLeaf];
  return canonicalLeafSet.has(pathKey(candidate)) ? candidate : targetPath;
}

function sourceResolvesIdentity(sourcePath: Path, positions: SourceContractPositions): boolean {
  const normalized = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment));
  const path = normalized.join("/");
  const last = sourcePath.at(-1);
  const resolvesDynamicMapKey =
    /\/(?:tasks\/#\/properties\/values|sharing_conditions\/#\/publication_tests\/#\/field_values)\/[^/]+\//.test(
      path,
    );
  if (isOpaqueDataPath(positions, sourcePath)) return resolvesDynamicMapKey;
  return (
    path === "root_alias" ||
    (typeof last === "string" && ID_FIELDS.has(last)) ||
    /\/(?:custom_actions|carries|declared_fields|filterable_fields|sortable_fields|public_fields|select|group_by|component_order|relationships|record_types|allowed_child_blocks)\/#$/.test(
      path,
    ) ||
    /\/(?:record_type|source_record_type|to_record_type|target|field|page|query|block|home_page|module|connection_type|workflow|node|relationship|amount_field|percentage_field|date_field|due_field|status_field|required_permission|dependency|extension_point|contributed_action)$/.test(
      path,
    ) ||
    /\/expression\/fields\/#$/.test(path) ||
    resolvesDynamicMapKey
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
  return /\/(?:tasks\/#\/properties\/values|sharing_conditions\/#\/publication_tests\/#\/field_values)\/[^/]+\//.test(
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

/**
 * A calculation field that does not author its evaluation compiles to a fixed default (#1132):
 * stored, or read-time for a deadline or a calculation over a read-time field.
 */
function isCalculationEvaluationDefaultPath(source: JsonObject, path: Path): boolean {
  if (
    source.kind !== "module" ||
    path.length !== 7 ||
    path[0] !== "content" ||
    path[1] !== "recordTypes" ||
    typeof path[2] !== "number" ||
    path[3] !== "fields" ||
    typeof path[4] !== "number" ||
    path[5] !== "settings" ||
    path[6] !== "evaluation"
  )
    return false;
  const field = valueAtPath(source, ["body", "record_types", path[2], "fields", path[4]]);
  if (field === null || typeof field !== "object" || Array.isArray(field)) return false;
  const { type, settings } = field as JsonObject;
  return (
    type === "calculation" &&
    settings !== null &&
    typeof settings === "object" &&
    (settings as JsonObject).evaluation === undefined
  );
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

// Application content no longer carries node-and-edge workflows (#1086). A source document may
// still author them until they become durable flows (#1088, #1092); they are validated as source
// but compile to nothing, so they have no canonical provenance.
function isLegacySourceWorkflowPath(source: JsonObject, path: Path): boolean {
  return source.kind === "application" && path[0] === "body" && path[1] === "workflows";
}

function provenanceFor(
  source: unknown,
  canonical: unknown,
  resolution: Resolution,
): DefinitionProvenanceEntry[] {
  const sourceObject = asObject(source);
  const positions = sourceContractPositions(sourceObject);
  const sourceLeafPaths = leafPaths(source).filter(
    (path) =>
      !(path.length === 1 && (path[0] === "source_contract_version" || path[0] === "kind")) &&
      !isLegacySourceWorkflowPath(sourceObject, path),
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
    const initialCanonicalPath =
      explicitTargets?.[0] ?? sourceToCanonicalPath(sourceObject, canonical, sourcePath, positions);
    const canonicalPath = applicationTypedValueTarget(
      sourceObject,
      sourcePath,
      initialCanonicalPath,
      canonicalLeafSet,
    );
    const mapsToCanonicalLeaf = canonicalLeafSet.has(pathKey(canonicalPath));
    const resolved =
      sourceResolvesIdentity(sourcePath, positions) ||
      recordScopeSourceResolvesIdentity(sourcePath) ||
      fieldPolicySourceResolvesIdentity(sourcePath);
    const transformTargets = explicitTargets
      ? explicitTargets.map((target) =>
          applicationTypedValueTarget(sourceObject, sourcePath, target, canonicalLeafSet),
        )
      : mapsToCanonicalLeaf
        ? [canonicalPath]
        : [];
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
    const isFixedDefault =
      isFixedWorkflowDefaultPath(canonicalPath) ||
      isCalculationEvaluationDefaultPath(sourceObject, canonicalPath);
    if (isSystem || isPublicationMetadata || isFixedDefault) {
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

type ResolutionSnapshot =
  DefinitionResolutionSnapshot | DefinitionResolutionSnapshotV2 | DefinitionResolutionSnapshotV3;

/**
 * Narrowing key only. Every lookup still applies its own predicate to the entries it finds, so
 * a separator inside an alias can widen the candidates but never change what matches.
 */
const identityLookupKey = (definitionKey: string, kind: string, alias: string): string =>
  `${definitionKey}\0${kind}\0${alias}`;

class Resolution {
  readonly snapshot:
    DefinitionResolutionSnapshot | DefinitionResolutionSnapshotV2 | DefinitionResolutionSnapshotV3;
  readonly sourceLocation: DefinitionValidationLocation;
  /** Filled by the constructor passes that already visit every definition and identity. */
  private readonly definitionsByKey = new Map<
    string,
    ResolutionSnapshot["definitions"][number][]
  >();
  private readonly identitiesByLookup = new Map<
    string,
    ResolutionSnapshot["identities"][number][]
  >();

  constructor(
    snapshot:
      | DefinitionResolutionSnapshot
      | DefinitionResolutionSnapshotV2
      | DefinitionResolutionSnapshotV3,
    source: JsonObject,
  ) {
    this.snapshot = snapshot;
    this.sourceLocation = compilerRootLocation(source);
    const requirements =
      source.kind === "module"
        ? extractModuleSourceIdentityRequirementsV3(source as unknown as ModuleSourceDocument)
        : source.kind === "application" && source.source_contract_version === "2.0.0"
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
      const sameKey = this.definitionsByKey.get(definition.key);
      if (sameKey) sameKey.push(definition);
      else this.definitionsByKey.set(definition.key, [definition]);
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
      const lookupKey = identityLookupKey(identity.definitionKey, identity.kind, identity.alias);
      const sameLookup = this.identitiesByLookup.get(lookupKey);
      if (sameLookup) sameLookup.push(identity);
      else this.identitiesByLookup.set(lookupKey, [identity]);
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
      flow: "flow",
      flow_binding: "flow_binding",
    };
    const segments = [...this.sourceLocation.segments];
    if (scope?.startsWith("record:"))
      segments.push({ kind: "record_type", key: scope.slice("record:".length) });
    else if (scope?.startsWith("workflow:"))
      segments.push({ kind: "workflow", key: scope.slice("workflow:".length) });
    else if (scope?.startsWith("flow:"))
      segments.push({ kind: "flow", key: scope.slice("flow:".length) });
    const componentKind = componentKinds[kind];
    if (componentKind) segments.push({ kind: componentKind, key });
    return { ...this.sourceLocation, segments };
  }

  definition(key: string, kind?: "module" | "application" | "connection_type") {
    const matches = (this.definitionsByKey.get(key) ?? []).filter(
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
    const matches = (
      this.identitiesByLookup.get(identityLookupKey(definitionKey, kind, alias)) ?? []
    ).filter(
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
    const matches = [...allowed]
      .flatMap(
        (definitionKey) =>
          this.identitiesByLookup.get(identityLookupKey(definitionKey, "permission", key)) ?? [],
      )
      .filter(
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
    const matches = [...allowed]
      .flatMap(
        (definitionKey) =>
          this.identitiesByLookup.get(identityLookupKey(definitionKey, kind, key)) ?? [],
      )
      .filter(
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

/**
 * One action task value in canonical form. References pass through unchanged; a `json` literal is
 * normalised to its target field's canonical value, as a field default is, so a link literal's
 * record type alias resolves to its identity and exact numbers and money take one form.
 */
function actionTaskValue(
  value: unknown,
  targetField: JsonObject | undefined,
  valueContext: ModuleValueContext | undefined,
): unknown {
  if (valueContext === undefined) return value;
  const entry = asObject(value);
  if (entry.kind !== "literal") return value;
  const literal = asObject(entry.literal);
  if (literal.type !== "json") return value;
  return {
    ...entry,
    literal: {
      ...literal,
      value: normaliseModuleFieldValueV2(targetField, literal.value, valueContext),
    },
  };
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

type ApplicationRecordValuePair = Readonly<{
  record: JsonObject;
  moduleV2: boolean;
}>;

type ApplicationActionValuePair = Readonly<{
  action: JsonObject;
  moduleV2: boolean;
}>;

type ApplicationModuleValueIndex = Readonly<{
  record: (reference: string) => ApplicationRecordValuePair | undefined;
  recordById: (recordTypeId: string) => ApplicationRecordValuePair | undefined;
  fieldId: (recordTypeId: string, alias: string) => string | undefined;
  fieldById: (fieldId: string) => Readonly<{ field: JsonObject; moduleV2: boolean }> | undefined;
  action: (key: string) => ApplicationActionValuePair | undefined;
  context: (defaultRecordReference?: string) => ModuleValueContext;
  contextForRecordId: (recordTypeId: string) => ModuleValueContext;
}>;

function applicationModuleValueIndex(
  source: JsonObject,
  resolution: Resolution,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): ApplicationModuleValueIndex {
  const body = asObject(source.body);
  const recordsById = new Map<string, ApplicationRecordValuePair>();
  const fieldsById = new Map<string, { field: JsonObject; moduleV2: boolean }>();
  const actionsByKey = new Map<string, ApplicationActionValuePair>();
  for (const binding of body.module_bindings as JsonObject[]) {
    const moduleKey = String(binding.module);
    const expected = resolution.definition(moduleKey, "module");
    const candidates = dependencyOutputs.filter(
      (candidate) => candidate.kind === "module" && candidate.artifact.definitionKey === moduleKey,
    );
    const matches = candidates.filter(
      (candidate) =>
        candidate.artifact.rootId === expected.rootId &&
        candidate.artifact.exactVersion === expected.exactVersion &&
        candidate.artifact.resolutionFingerprint === candidate.resolutionFingerprint,
    );
    if (candidates.length === 0) continue;
    if (matches.length !== 1)
      fail("vortex.definition.application_dependency_manifest", "broken_reference");
    const output = matches[0]!;
    const canonical = asObject(output.canonical);
    const envelope = asObject(canonical.envelope);
    const content = asObject(canonical.content);
    if (
      envelope.rootId !== expected.rootId ||
      envelope.key !== moduleKey ||
      output.artifact.contentFingerprint !== fingerprintCanonicalValue(content)
    )
      fail("vortex.definition.application_dependency_manifest", "broken_reference");
    const moduleV2 = "validationContractVersion" in output;
    for (const record of content.recordTypes as JsonObject[]) {
      const recordTypeId = String(record.recordTypeId);
      if (recordsById.has(recordTypeId))
        fail("vortex.definition.application_dependency_manifest", "broken_reference");
      recordsById.set(recordTypeId, { record, moduleV2 });
      for (const field of record.fields as JsonObject[]) {
        const fieldId = String(field.fieldId);
        if (fieldsById.has(fieldId))
          fail("vortex.definition.application_dependency_manifest", "broken_reference");
        fieldsById.set(fieldId, { field, moduleV2 });
      }
    }
    for (const action of content.actions as JsonObject[]) {
      const key = String(action.key);
      if (actionsByKey.has(key))
        fail("vortex.definition.application_dependency_manifest", "broken_reference");
      actionsByKey.set(key, { action, moduleV2 });
    }
  }
  const record = (reference: string) => {
    const recordTypeId = String(resolution.recordType(reference).recordTypeId);
    return recordsById.get(recordTypeId);
  };
  const fieldIdForRecord = (recordTypeId: string, alias: string) => {
    const pair = recordsById.get(recordTypeId);
    const matches = pair
      ? (pair.record.fields as JsonObject[]).filter((field) => field.key === alias)
      : [];
    return matches.length === 1 ? String(matches[0]!.fieldId) : undefined;
  };
  const valueContext = (
    defaultRecordReference?: string,
    defaultRecordTypeId?: string,
  ): ModuleValueContext => ({
    resolution,
    field: (reference, alias) => {
      const fieldId =
        alias !== undefined
          ? resolution.field(reference, alias)
          : reference.includes(".")
            ? qualifiedField(resolution, reference)
            : defaultRecordReference !== undefined
              ? resolution.field(defaultRecordReference, reference)
              : defaultRecordTypeId !== undefined
                ? fieldIdForRecord(defaultRecordTypeId, reference)
                : undefined;
      if (fieldId === undefined) return undefined;
      const pair = fieldsById.get(fieldId);
      return pair?.moduleV2 ? pair.field : undefined;
    },
  });
  return {
    record,
    recordById: (recordTypeId) => recordsById.get(recordTypeId),
    fieldId: fieldIdForRecord,
    fieldById: (fieldId) => fieldsById.get(fieldId),
    action: (key) => actionsByKey.get(key),
    context: (defaultRecordReference) => valueContext(defaultRecordReference),
    contextForRecordId: (recordTypeId) => valueContext(undefined, recordTypeId),
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
              : parameterTypes.get(String(binding.key)) === "decimal_number"
                ? normaliseExactV2(binding.value)
                : parameterTypes.get(String(binding.key)) === "money"
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
function inheritReadTimeEvaluation<
  T extends { fieldId: string; type: unknown; settings: unknown },
>(
  sourceFields: readonly JsonObject[],
  fields: readonly T[],
): T[] {
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

function fieldSettings(
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
        ...(settings.minimum !== undefined
          ? { minimum: normaliseExactV2(settings.minimum) }
          : {}),
        ...(settings.maximum !== undefined
          ? { maximum: normaliseExactV2(settings.maximum) }
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
          ? { minimum: normaliseExactV2(settings.minimum) }
          : {}),
        ...(settings.maximum !== undefined
          ? { maximum: normaliseExactV2(settings.maximum) }
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
          return { source: "literal", value: normaliseExactV2(operand.value) };
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
                value: normaliseExactV2(amount.value),
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

/**
 * The task version every compiled named-action flow pins. A named action is compiled to a
 * `transaction` flow (#1062); until #1063 runs it through the flow runner, the action's own
 * execution path is unchanged and this flow is the compile-time home of its behaviour
 * (architecture decision 1, 08 §Actions).
 */
const ACTION_FLOW_TASK_VERSION = "1.0.0" as const;

/** The flow value type of a compiled Module action input. */
function actionFlowInputType(inputType: string): FlowInputDeclaration["type"] {
  // An action `number` input accepts any finite number, so it is a decimal, never a whole number.
  if (inputType === "number") return "decimal_number";
  if (inputType === "boolean") return "yes_no";
  return inputType as FlowInputDeclaration["type"];
}

/** A text literal flow value, for identity, key and message properties. */
const flowTextValue = (value: string): FlowValue => ({
  kind: "literal",
  literal: { type: "text", value },
});

const flowReferenceValue = (reference: FlowReference): FlowValue => ({ kind: "reference", reference });

/**
 * What an action value can read inside its compiled flow: the subject is the record the action
 * runs on, so its fields are `{{ trigger.record.<field> }}` reads and the whole subject is the
 * implicit typed `subjectInput` record input.
 */
type ActionFlowScope = Readonly<{
  subjectFieldKeyById: ReadonlyMap<string, string>;
  subjectInput: string;
}>;

const subjectFieldReference = (fieldId: unknown, scope: ActionFlowScope): FlowReference => {
  const field = scope.subjectFieldKeyById.get(String(fieldId));
  if (field === undefined) fail("vortex.definition.invalid_compilation_output", "invalid_value");
  return { source: "trigger_record", field };
};

/**
 * The `field_values` property of a compiled action's record task: the canonical action task already
 * carries its value map in the flow value grammar, keyed by permanent field identity, so it travels
 * as the one literal JSON a `field_values` property is: a map whose every entry is a flow value.
 */
const actionFlowFieldValues = (values: Readonly<Record<string, unknown>>): FlowValue => ({
  kind: "literal",
  literal: { type: "json", value: values as JsonValue },
});

/** One registered task of a compiled named-action flow, pinned to the registry task version. */
const actionFlowTask = (
  id: string,
  type: string,
  properties: Record<string, FlowValue>,
): FlowTask => ({ id, type, version: ACTION_FLOW_TASK_VERSION, properties });

/**
 * Lowers a compiled action precondition to the flow formula the one flow evaluator reads. A
 * subject field becomes a `trigger.record` read and an action parameter a declared input
 * reference, so the flow names no value as text.
 */
function actionPreconditionFormula(node: unknown, scope: ActionFlowScope): FlowFormula {
  const value = asObject(node);
  if (value.kind === "all" || value.kind === "any") {
    const children = (value.conditions as unknown[]).map((entry) =>
      actionPreconditionFormula(entry, scope),
    );
    if (children.length === 1) return children[0]!;
    return { op: value.kind === "all" ? "and" : "or", args: children };
  }
  if (value.kind === "not")
    return { op: "not", arg: actionPreconditionFormula(value.condition, scope) };
  const operand = (entry: unknown): FlowFormula => {
    const source = asObject(entry);
    if (source.source === "field")
      return { op: "reference", reference: subjectFieldReference(source.fieldId, scope) };
    if (source.source === "parameter")
      return { op: "reference", reference: { source: "input", name: String(source.key) } };
    return { op: "literal", type: "json", value: source.value as JsonValue };
  };
  const left = operand(value.left);
  const rightOperand = (): FlowFormula => operand(value.right);
  switch (String(value.operator)) {
    case "equals":
      return { op: "eq", left, right: rightOperand() };
    case "not_equals":
      return { op: "neq", left, right: rightOperand() };
    case "greater_than":
      return { op: "gt", left, right: rightOperand() };
    case "greater_than_or_equal":
      return { op: "gte", left, right: rightOperand() };
    case "less_than":
      return { op: "lt", left, right: rightOperand() };
    case "less_than_or_equal":
      return { op: "lte", left, right: rightOperand() };
    case "contains":
      return { op: "contains", left, right: rightOperand() };
    case "not_contains":
      return { op: "not", arg: { op: "contains", left, right: rightOperand() } };
    case "in":
    case "not_in": {
      const authored = asObject(value.right);
      const raw = authored.source === "value" ? authored.value : undefined;
      const options = Array.isArray(raw)
        ? raw.map(
            (entry): FlowFormula => ({ op: "literal", type: "json", value: entry as JsonValue }),
          )
        : [rightOperand()];
      const membership: FlowFormula = { op: "in", value: left, options };
      return String(value.operator) === "not_in" ? { op: "not", arg: membership } : membership;
    }
    case "is_empty":
      return { op: "is_empty", arg: left };
    case "is_not_empty":
      return { op: "is_not_empty", arg: left };
    default:
      return fail("vortex.definition.invalid_compilation_output", "invalid_value");
  }
}

/**
 * Compiles one Module named action to its `transaction` flow (#1062): the action's own permanent
 * identity, typed inputs (plus the implicit subject record input) and invocation permission. The
 * precondition becomes an If task whose otherwise branch refuses, as the action refuses, and the
 * ordered tasks become the registry record, event and change tasks.
 *
 * Placement: the registry lets `record.set_fields` and `event.announce` run in a transaction on
 * the record being saved, which for an action is its subject. It keeps `record.create`,
 * `record.changes` and `record.delete` out of transactions, because architecture decision 1 lets a
 * transaction flow change only the record being saved and every BeforeSave rule shares that run
 * location. A named action's other-record changes are one apply record changes call (decision
 * "Every record task calls one protected operation"), so how the registry admits them for action
 * flows alone is #1063's, with execution. Likewise the flow validator accepts `trigger.record`
 * reads only in a flow with a record trigger, while an action starts through its binding with its
 * subject as the record being saved. These flows are therefore not passed through the flow
 * validator yet; `flowSchema` still validates them.
 */
function compileActionFlow(
  action: JsonObject,
  canonicalAction: JsonObject,
  flowKey: string,
  namespace: string,
  subjectFieldKeyById: ReadonlyMap<string, string>,
  invocationPermissionId: FlowDefinition["invocationPermissionId"],
): FlowDefinition {
  const actionInputs: Record<string, FlowInputDeclaration> = {};
  for (const input of canonicalAction.inputs as JsonObject[]) {
    const recordTypes = (input.recordTypes as JsonObject[] | undefined) ?? [];
    actionInputs[String(input.key)] = {
      type: actionFlowInputType(String(input.type)),
      required: input.required === true,
      ...(recordTypes.length > 0
        ? {
            recordTypeIds: recordTypes.map((entry) =>
              String(entry.recordTypeId),
            ) as FlowInputDeclaration["recordTypeIds"],
          }
        : {}),
    };
  }
  // The subject is `record`, as in the default Save flow, unless the action declares its own input
  // of that name.
  let subjectInput = "record";
  for (let suffix = 1; Object.hasOwn(actionInputs, subjectInput); suffix += 1)
    subjectInput = suffix === 1 ? "subject_record" : `subject_record_${suffix}`;
  const subjectRecordTypeId = String(canonicalAction.subjectRecordTypeId);
  const scope: ActionFlowScope = { subjectFieldKeyById, subjectInput };

  const actionTasks: FlowTask[] = (canonicalAction.tasks as JsonObject[]).map((task, taskIndex) => {
    const id = task.id === undefined ? `task_${taskIndex + 1}` : String(task.id);
    const properties = asObject(task.properties);
    switch (String(task.type)) {
      case "record.set_fields":
        return actionFlowTask(id, "record.set_fields", {
          values: actionFlowFieldValues(asObject(properties.values)),
        });
      case "record.create":
        return actionFlowTask(id, "record.create", {
          record_type: flowTextValue(String(asObject(properties.recordType).recordTypeId)),
          values: actionFlowFieldValues(asObject(properties.values)),
        });
      case "record.changes":
        return actionFlowTask(id, "record.changes", {
          changes: {
            kind: "literal",
            literal: {
              type: "json",
              value: (properties.changes as JsonObject[]).map(
                (change) =>
                  ({
                    kind: "copy_relationships",
                    relationshipIds: change.relationshipIds as JsonValue,
                    subject: flowReferenceValue({ source: "input", name: subjectInput }),
                    target: flowReferenceValue({
                      source: "input",
                      name: String(change.targetInputKey),
                    }),
                  }) as unknown as JsonValue,
              ),
            },
          },
        });
      case "record.delete":
        return actionFlowTask(id, "record.delete", {
          record_type: flowTextValue(subjectRecordTypeId),
          record: flowReferenceValue({ source: "input", name: subjectInput }),
        });
      case "event.announce":
        return actionFlowTask(id, "event.announce", {
          event: flowTextValue(String(properties.eventKey)),
        });
      default:
        return fail("vortex.definition.invalid_compilation_output", "invalid_value");
    }
  });

  const precondition = canonicalAction.precondition;
  const tasks: FlowTask[] =
    precondition === undefined
      ? actionTasks
      : [
          {
            id: "precondition",
            type: "if",
            condition: actionPreconditionFormula(precondition, scope),
            then: actionTasks,
            else: [
              actionFlowTask("precondition_refused", "rule.refuse", {
                reason: flowTextValue("precondition_not_met"),
                message: flowTextValue("This action is not available for the record as it is now."),
              }),
            ],
          },
        ];

  const label = String(action.label);
  return {
    contractVersion: flowContractVersion,
    id: canonicalAction.actionId as unknown as FlowDefinition["id"],
    key: flowKey,
    ...(/\{\{|\{%/.test(label) ? {} : { description: label }),
    labels: {},
    namespace,
    execution: "transaction",
    runAs: { kind: "saver" },
    ...(invocationPermissionId === undefined ? {} : { invocationPermissionId }),
    inputs: {
      [subjectInput]: {
        type: "record_reference",
        required: true,
        recordTypeIds: [subjectRecordTypeId] as FlowInputDeclaration["recordTypeIds"],
        description: "The record the action runs on.",
      },
      ...actionInputs,
    },
    variables: {},
    triggers: [],
    tasks,
    outputs: {},
    errors: [],
    finally: [],
  };
}

/**
 * Resolves a source action's registered protected-operation key to the exact operation reference
 * the canonical action carries. Registration is the platform-service catalogue; an action never
 * names an operation identity itself.
 */
function platformServiceProtectedOperationReference(key: unknown): JsonObject {
  const operation = PLATFORM_SERVICE_OPERATIONS[String(key) as PlatformServiceOperationKey];
  if (operation === undefined)
    fail("vortex.definition.workflow_node_references", "broken_reference");
  return {
    owner: { kind: "platform_service", serviceId: operation.release.serviceId },
    operationId: operation.release.operationId,
  };
}

function compileModule(
  source: JsonObject,
  resolution: Resolution,
  metadata: JsonObject,
  savedConditionRevisions: readonly JsonObject[],
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  rules: readonly RuleGraph[],
  flows: readonly FlowDefinition[],
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
    const projection = recordType.system_projection as JsonObject | undefined;
    // A system projection record type has no ordinary write path: its changes go only through the
    // registered protected operation its actions target, so a standard write action refuses here at
    // publication with its own registered code. The source contract deliberately admits the
    // declaration so this stable refusal, not a generic shape failure, is what the author sees.
    if (
      projection !== undefined &&
      (recordType.standard_actions as string[]).some(
        (action) =>
          action === "create" ||
          action === "update" ||
          action === "soft_delete" ||
          action === "restore",
      )
    )
      fail(
        "vortex.definition.system_record_write_refused",
        "invalid_value",
        resolution.location("record_type", recordKey),
      );
    const valueContext = valueContextFor(qualified);
    const recordTypeId = resolution.id(definitionKey, "record_type", recordKey, "content");
    const compiledFields = (recordType.fields as JsonObject[]).map((field) => ({
      fieldId: resolution.id(definitionKey, "field", String(field.id), `record:${recordKey}`),
      key: field.key,
      label: field.label,
      ...(field.help_text ? { helpText: field.help_text } : {}),
      required: field.required,
      ...(field.default !== undefined
        ? { default: normaliseModuleFieldValueV2(field, field.default, valueContext, true) }
        : {}),
      unique: field.unique,
      filterable: field.filterable,
      sortable: field.sortable,
      ...(field.search_priority ? { searchPriority: field.search_priority } : {}),
      personalData: field.personal_data,
      publicDisplay: field.public_display,
      type: field.type,
      settings: fieldSettings(field, qualified, resolution, permissionOwners, valueContext),
    }));
    const fields = inheritReadTimeEvaluation(recordType.fields as JsonObject[], compiledFields);
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
      ...(projection === undefined
        ? {}
        : {
            systemProjection: {
              protectedView: projection.protected_view,
              organizationFieldId: resolution.field(
                qualified,
                String(projection.organization_field),
              ),
              revisionFieldId: resolution.field(qualified, String(projection.revision_field)),
              filterableFieldIds: (projection.filterable_fields as string[]).map((alias) =>
                resolution.field(qualified, alias),
              ),
              sortableFieldIds: (projection.sortable_fields as string[]).map((alias) =>
                resolution.field(qualified, alias),
              ),
            },
          }),
      ownershipMode: readModuleSourceRecordOwnershipMode(recordType.ownership_mode),
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
      ...(action.protected_operation
        ? {
            protectedOperation: platformServiceProtectedOperationReference(
              action.protected_operation,
            ),
          }
        : {}),
      inputs: (action.inputs as JsonObject[]).map((input) => actionInput(input, resolution, true)),
      ...(action.precondition
        ? { precondition: condition(action.precondition, localField, valueContext) }
        : {}),
      tasks: (action.tasks as JsonObject[]).map((task) => {
        const id = String(task.id);
        const properties = asObject(task.properties);
        switch (String(task.type)) {
          case "record.set_fields":
            return {
              id,
              type: "record.set_fields",
              properties: {
                values: objectFromUniqueEntries(
                  Object.entries(asObject(properties.values)).map(([key, value]) => {
                    const fieldId = localField(key);
                    return [
                      fieldId,
                      actionTaskValue(value, fieldsById.get(fieldId), valueContext),
                    ];
                  }),
                ),
              },
            };
          case "record.create": {
            const target = String(properties.record_type);
            return {
              id,
              type: "record.create",
              properties: {
                recordType: resolution.recordType(target),
                values: objectFromUniqueEntries(
                  Object.entries(asObject(properties.values)).map(([key, value]) => {
                    const fieldId = resolution.field(target, key);
                    return [
                      fieldId,
                      actionTaskValue(value, fieldsById.get(fieldId), valueContext),
                    ];
                  }),
                ),
              },
            };
          }
          case "record.changes":
            return {
              id,
              type: "record.changes",
              properties: {
                changes: (properties.changes as JsonObject[]).map((change) => ({
                  kind: "copy_relationships",
                  relationshipIds: (change.relationships as string[]).map((alias) =>
                    resolution.relationship(record, alias),
                  ),
                  targetInputKey: change.target_input,
                })),
              },
            };
          case "record.delete":
            return { id, type: "record.delete", properties: {} };
          case "event.announce":
            return {
              id,
              type: "event.announce",
              properties: { eventKey: properties.event },
            };
          default:
            return fail("vortex.definition.invalid_compilation_output", "invalid_value");
        }
      }),
    };
  });
  // Every record-task Module named action also compiles to one `transaction` flow (#1062). A
  // protected-operation action instead targets one registered platform-service operation that
  // takes the subject row's identity and expected revision automatically. Its execution is not
  // built yet, so it compiles to no flow here, and the record runtime refuses to prepare it
  // because its canonical action and system projection record type are not record-task shapes.
  const usedFlowKeys = new Set(flows.map((flow) => String(flow.key)));
  const actionFlows = (body.actions as JsonObject[]).flatMap((action, actionIndex) => {
    if (action.protected_operation !== undefined) return [];
    const recordKey = String(action.record_type);
    const subjectRecord = (body.record_types as JsonObject[]).find(
      (candidate) => String(candidate.key) === recordKey,
    );
    const subjectFieldKeyById = new Map<string, string>();
    for (const field of (subjectRecord?.fields as JsonObject[] | undefined) ?? [])
      subjectFieldKeyById.set(
        resolution.id(definitionKey, "field", String(field.id), `record:${recordKey}`),
        String(field.key),
      );
    // The flow key is the action key's last segment, kept a builder key with room for a suffix
    // that separates it from an authored flow or another action of the same name.
    const keySegment = String(action.key).slice(String(action.key).lastIndexOf(".") + 1);
    const baseKey = keySegment.slice(0, 32).replace(/_+$/, "");
    let flowKey = baseKey;
    for (let suffix = 1; usedFlowKeys.has(flowKey); suffix += 1) flowKey = `${baseKey}_${suffix}`;
    usedFlowKeys.add(flowKey);
    const canonicalAction = actions[actionIndex]! as unknown as JsonObject;
    return [
      compileActionFlow(
        action,
        canonicalAction,
        flowKey,
        definitionKey,
        subjectFieldKeyById,
        // An action with permission alternatives has no single invocation permission; a flow holds
        // exactly one, so its binding keeps checking the alternatives (#1063).
        canonicalAction.permissionKey === undefined
          ? undefined
          : (resolution.permission(
              String(canonicalAction.permissionKey),
              permissionOwners,
            ) as FlowDefinition["invocationPermissionId"]),
      ),
    ];
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
    const compiledCondition = condition(saved.condition, localField, valueContext);
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
        parameters: objectFromUniqueEntries(
          Object.entries(asObject(test.parameters)).map(([key, value]) => [
            key,
            normaliseModuleTypedValueV2(parameterTypes.get(key), value, valueContext),
          ]),
        ),
        fieldValues: objectFromUniqueEntries(
          Object.entries(asObject(test.field_values)).map(([key, value]) => [
            localField(key),
            normaliseModuleFieldValueV2(fieldFor(record, key), value, valueContext),
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
      valueContextFor(`${definitionKey}:${String(permission.record_type ?? "")}`),
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
  const queries = (body.queries as JsonObject[]).map((query) => {
    const authoredRecord = String(query.record_type);
    // A local key names this module's own record; a qualified key names a declared dependency.
    const record = authoredRecord.includes(":")
      ? authoredRecord
      : qualifiedForRecord(authoredRecord);
    const localField = (alias: string) => resolution.field(record, alias);
    const inputTypes = new Map(
      (query.inputs as JsonObject[]).map((input) => [String(input.key), String(input.type)]),
    );
    const valueContext = valueContextFor(record, inputTypes);
    return {
      queryId: resolution.id(definitionKey, "query", String(query.id), "content"),
      key: query.key,
      ...(query.label ? { label: query.label } : {}),
      ...(query.description ? { description: query.description } : {}),
      recordType: resolution.recordType(record),
      inputs: (query.inputs as JsonObject[]).map((input) => actionInput(input, resolution, true)),
      selectedFieldIds: (query.select as string[]).map(localField),
      filter: query.filter ? condition(query.filter, localField, valueContext) : null,
      groupByFieldIds: (query.group_by as string[]).map(localField),
      aggregates: (query.aggregates as JsonObject[]).map((aggregate) => ({
        operation: aggregate.operation,
        ...(aggregate.field ? { fieldId: localField(String(aggregate.field)) } : {}),
        alias: aggregate.alias,
      })),
      sort: (query.sort as JsonObject[]).map((sort) => ({
        fieldId: localField(String(sort.field)),
        direction: sort.direction,
      })),
      pageSize: query.page_size,
      relationshipHops: query.relationship_hops,
    };
  });
  const dependencies = (body.dependencies as JsonObject[]).map((dependency) => {
    const requirement = dependency.version as Parameters<typeof compatibleVersion>[0];
    const target = resolution.definition(String(dependency.module), "module");
    return {
      dependencyKey: dependency.dependency_key,
      moduleRootId: target.rootId,
      moduleKey: target.key,
      version: requirement,
      resolvedVersion: exactVersion(resolution, String(dependency.module), "module", requirement),
    };
  });
  const dependencyByKey = new Map(
    (body.dependencies as JsonObject[]).map((dependency, index) => [
      String(dependency.dependency_key),
      dependencies[index]!,
    ]),
  );
  const contributionExtensionPointId = (moduleKey: string, key: string): string => {
    try {
      return resolution.id(moduleKey, "extension_point", key, "content");
    } catch (error) {
      if (!(error instanceof DefinitionCompilationError)) throw error;
      return fail(
        "vortex.definition.module_extension_references",
        "broken_reference",
        resolution.location("extension_point", key),
      );
    }
  };
  const contributionRecordIdentity = (record: string): string => {
    try {
      return resolution.recordType(record).recordTypeId;
    } catch (error) {
      if (!(error instanceof DefinitionCompilationError)) throw error;
      return fail(
        "vortex.definition.module_extension_references",
        "broken_reference",
        resolution.location("record_type", record),
      );
    }
  };
  const contributionFieldIdentity = (record: string, field: string): string => {
    try {
      return resolution.field(record, field);
    } catch (error) {
      if (!(error instanceof DefinitionCompilationError)) throw error;
      return fail(
        "vortex.definition.module_extension_references",
        "broken_reference",
        resolution.location("field", field),
      );
    }
  };
  const contributionActionIdentity = (alias: string): string => {
    try {
      return resolution.id(definitionKey, "action", alias, "content");
    } catch (error) {
      if (!(error instanceof DefinitionCompilationError)) throw error;
      return fail(
        "vortex.definition.module_extension_references",
        "broken_reference",
        resolution.location("action", alias),
      );
    }
  };
  const authoredContributions = (body.contributions as JsonObject[] | undefined) ?? [];
  const contributions = authoredContributions.map((contribution) => {
    const targetModule = dependencyByKey.get(String(contribution.dependency));
    if (targetModule === undefined)
      return fail(
        "vortex.definition.module_extension_references",
        "broken_reference",
        resolution.location("extension_point", String(contribution.dependency)),
      );
    const targetExtensionPointId = contributionExtensionPointId(
      String(targetModule.moduleKey),
      String(contribution.extension_point),
    );
    if (contribution.kind === "field") {
      const record = qualifiedForRecord(String(contribution.record_type));
      const recordTypeId = contributionRecordIdentity(record);
      const fieldId = contributionFieldIdentity(record, String(contribution.field));
      return {
        contributionId: fieldId,
        targetModule,
        targetExtensionPointId,
        kind: "field" as const,
        recordTypeId,
        fieldId,
      };
    }
    const actionId = contributionActionIdentity(String(contribution.contributed_action));
    return {
      contributionId: actionId,
      targetModule,
      targetExtensionPointId,
      kind: "action" as const,
      actionId,
    };
  });
  const canonical = moduleDraftV3Schema.parse({
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
      dependencies,
      recordTypes,
      permissions,
      actions,
      events,
      flows: [...flows, ...actionFlows],
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
      queries,
      ...(contributions.length > 0 ? { contributions } : {}),
    },
  });
  return canonical;
}

const standardRecordActions = new Set([
  "create",
  "read",
  "update",
  "soft_delete",
  "restore",
  "export",
]);

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
      // A page keeps its exact access permission key. An application or bound-Module permission is
      // resolved against its owner; a platform administration permission is carried through as its
      // exact catalogue key, which the runtime evaluates against the viewer's platform authority.
      accessPermissionKey: isPlatformPermissionKey(String(page.permission))
        ? String(page.permission)
        : resolution.exactOwnedReference(
            "permission",
            String(page.permission),
            allowedPermissionOwners,
          ),
      composition: compiledComposition.composition,
    };
    if (page.type === "list") {
      const record = String(page.record_type);
      return {
        ...base,
        type: "list",
        recordType: resolution.recordType(record),
        queryId: queryId(String(page.query)),
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
      };
    if (page.type === "guided_form")
      return {
        ...base,
        type: "guided_form",
        recordType: resolution.recordType(String(page.record_type)),
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
  compositionV2: MaterialisedApplicationCompositionV2,
  valueIndex: ApplicationModuleValueIndex,
  flows: readonly FlowDefinition[],
) {
  const body = asObject(source.body);
  const definitionKey = String(source.key);
  const root = resolution.definition(definitionKey, "application");
  // Resolve permission-owned evidence before the general value-consumer index so
  // invalid saved-condition dependencies keep their established diagnostic.
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
      referencedSharing,
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
  const pageId = (alias: string) => resolution.id(definitionKey, "page", alias, "content");
  const pages = compileApplicationPagesV2(source, resolution, compositionV2);
  const queries = (body.queries as JsonObject[]).map((query) => {
    const record = String(query.record_type);
    const valueContext = valueIndex.record(record)?.moduleV2
      ? valueIndex.context(record)
      : undefined;
    return {
      queryId: resolution.id(definitionKey, "query", String(query.id), "content"),
      key: query.key,
      recordType: resolution.recordType(record),
      selectedFieldIds: (query.select as string[]).map((alias) => resolution.field(record, alias)),
      filter: query.filter
        ? condition(query.filter, (alias) => resolution.field(record, alias), valueContext)
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
  const wildcardPermissions = permissions
    .filter((permission) => permission.administrative === false)
    .sort((left, right) => compareCanonicalStrings(String(left.key), String(right.key)));
  const wildcardPermissionKeys = wildcardPermissions.map((permission) => permission.key);
  const wildcardCatalogueFingerprint = fingerprintCanonicalValue(wildcardPermissions);
  const canonical = applicationDraftV2Schema.parse({
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
      ...(body.experiences === undefined
        ? {}
        : {
            experiences: (body.experiences as JsonObject[]).map((experience) => ({
              state: experience.state,
              pageId: pageId(String(experience.page)),
            })),
          }),
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
      platformBlockDependencies: compositionV2.platformBlockDependencies,
      shells: compositionV2.shells,
      pipelines: (body.pipelines as JsonObject[]).map((pipeline) => {
        const record = String(pipeline.record_type);
        const valueContext = valueIndex.record(record)?.moduleV2
          ? valueIndex.context(record)
          : undefined;
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
              ? {
                  gate: condition(
                    transition.gate,
                    (alias) => resolution.field(record, alias),
                    valueContext,
                  ),
                }
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
        const subjectContext = valueIndex.record(record)?.moduleV2
          ? valueIndex.context(record)
          : undefined;
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
            ? { precondition: condition(action.precondition, localField, subjectContext) }
            : {}),
          tasks: (action.tasks as JsonObject[]).map((task) => {
            const id = String(task.id);
            const properties = asObject(task.properties);
            switch (String(task.type)) {
              case "record.set_fields":
                return {
                  id,
                  type: "record.set_fields",
                  properties: {
                    values: objectFromUniqueEntries(
                      Object.entries(asObject(properties.values)).map(([key, value]) => {
                        const fieldId = localField(key);
                        const pair = valueIndex.fieldById(fieldId);
                        return [
                          fieldId,
                          actionTaskValue(
                            value,
                            pair?.field,
                            pair?.moduleV2 ? subjectContext : undefined,
                          ),
                        ];
                      }),
                    ),
                  },
                };
              case "record.create": {
                const target = String(properties.record_type);
                const targetContext = valueIndex.record(target)?.moduleV2
                  ? valueIndex.context(target)
                  : undefined;
                return {
                  id,
                  type: "record.create",
                  properties: {
                    recordType: resolution.recordType(target),
                    values: objectFromUniqueEntries(
                      Object.entries(asObject(properties.values)).map(([key, value]) => {
                        const fieldId = resolution.field(target, key);
                        return [
                          fieldId,
                          actionTaskValue(
                            value,
                            valueIndex.fieldById(fieldId)?.field,
                            targetContext,
                          ),
                        ];
                      }),
                    ),
                  },
                };
              }
              case "record.changes":
                return {
                  id,
                  type: "record.changes",
                  properties: {
                    changes: (properties.changes as JsonObject[]).map((change) => ({
                      kind: "copy_relationships",
                      relationshipIds: (change.relationships as string[]).map((alias) =>
                        resolution.relationship(record, alias),
                      ),
                      targetInputKey: change.target_input,
                    })),
                  },
                };
              case "record.delete":
                return { id, type: "record.delete", properties: {} };
              case "event.announce":
                return {
                  id,
                  type: "event.announce",
                  properties: { eventKey: properties.event },
                };
              default:
                return fail("vortex.definition.invalid_compilation_output", "invalid_value");
            }
          }),
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
          // A change or background start names an application-owned flow entry point, resolved to
          // its permanent flow identity; a read keeps its declared query key.
          target:
            asObject(operation.target).kind === "flow"
              ? {
                  kind: "flow",
                  flowId: resolution.id(
                    definitionKey,
                    "flow",
                    String(asObject(operation.target).flow),
                    "content",
                  ),
                }
              : operation.target,
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
      theme: compositionV2.theme,
      homePageId: pageId(String(body.home_page)),
      flows,
      flowBindings: compileApplicationFlowBindings(source, resolution, flows),
    },
  });
  return canonical;
}

/**
 * The Application's bindings of component events to flows: the flow's permanent identity and its
 * typed input map. A binding starts an interactive flow, names only inputs the flow declares, and
 * supplies every input the flow requires, so a mismatch is refused here instead of when the
 * control is used. Values the invoking surface supplies are `caller` inputs the surface fills by
 * the same name.
 */
function compileApplicationFlowBindings(
  source: JsonObject,
  resolution: Resolution,
  flows: readonly FlowDefinition[],
): JsonObject[] {
  const body = asObject(source.body);
  const definitionKey = String(source.key);
  const flowsById = new Map(flows.map((flow) => [String(flow.id), flow]));
  return (body.flow_bindings as JsonObject[]).map((binding) => {
    const flowId = resolution.id(definitionKey, "flow", String(binding.flow), "content");
    const flow = flowsById.get(flowId);
    const location = resolution.location("flow_binding", String(binding.id));
    if (flow === undefined)
      fail("vortex.definition.application_flow_binding_target", "broken_reference", location);
    if (flow.execution !== "interactive")
      fail("vortex.definition.application_flow_binding_target", "invalid_value", location);
    const inputs = asObject(binding.inputs ?? {});
    for (const name of Object.keys(inputs))
      if (!Object.hasOwn(flow.inputs, name))
        fail("vortex.definition.application_flow_binding_inputs", "unknown_property", location);
    for (const [name, declared] of Object.entries(flow.inputs))
      if (declared.required && !Object.hasOwn(inputs, name))
        fail("vortex.definition.application_flow_binding_inputs", "required_value", location);
    return {
      bindingId: resolution.id(definitionKey, "flow_binding", String(binding.id), "content"),
      controlId: resolution.id(definitionKey, "block_placement", String(binding.control)),
      eventId: resolution.id(definitionKey, "event", String(binding.event_id), "content"),
      event: binding.event,
      flow: { flowId, inputs },
    };
  });
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

/**
 * The limits definitionPublicationContextSchema places on dependencyOutputs, for outputs that
 * already passed its element schema. parseDefinitionCompilationContext applied them on every
 * compile, so a set whose dependency outputs repeat a subject it has just compiled is still
 * refused here, with the same code and no location.
 */
function assertDependencyOutputLimits(
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): void {
  const subjects = dependencyOutputs.map((output) =>
    output.kind === "connection_type" ? output.canonical.key : output.canonical.envelope.key,
  );
  if (subjects.length > 10_000 || new Set(subjects).size !== subjects.length)
    fail("vortex.definition.invalid_compilation_request", "invalid_value");
}

function compileDefinitionInternal(
  input: unknown,
  context?: DefinitionCompilationContext,
): DefinitionCompilationOutput {
  const parsed = definitionCompilationRequestSchema.safeParse(input);
  if (!parsed.success) fail("vortex.definition.invalid_compilation_request", "invalid_value");
  // A connection type has no definition dependencies; the context is still parsed so a malformed
  // one is refused exactly as it is on the Application and Module entry points.
  parseDefinitionCompilationContext(context);
  return compileParsedConnectionRequest(parsed.data);
}

function compileParsedConnectionRequest(
  request: ParsedConnectionRequest,
): DefinitionCompilationOutput {
  const sourceDocument = request.source;
  const source = sourceDocument as unknown as JsonObject;
  try {
    const resolution = new Resolution(request.resolution, source);
    const canonical: unknown = compileConnection(source, resolution);
    const ownDefinition = resolution.definition(sourceDocument.key, sourceDocument.kind);
    const artifact = {
      kind: sourceDocument.kind,
      definitionKey: sourceDocument.key,
      rootId: ownDefinition.rootId,
      exactVersion: ownDefinition.exactVersion,
      contentFingerprint: fingerprintCanonicalValue(asObject(canonical)),
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
  valueIndex: ApplicationModuleValueIndex,
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
    fieldInput: (fieldId) => {
      const pair = valueIndex.fieldById(fieldId);
      // Only a field of an exactly bound V3 module release can drive an automatic field input; a
      // V1 module field is refused rather than derived, matching the one module contract (#998).
      if (pair === undefined || !pair.moduleV2) return undefined;
      const field = pair.field;
      const type = String(field.type);
      const settings = field.settings === undefined ? {} : asObject(field.settings);
      const resolvedRecordType = (
        value: unknown,
      ): FieldInputSourceField["recordTypes"][number] => {
        const recordType = asObject(value);
        // A canonical module field resolves every link target; anything else is refused rather
        // than derived, so an automatic field input never invents a record type identity.
        if (recordType.state !== "resolved")
          fail("vortex.definition.module_field_references", "broken_reference");
        return {
          state: "resolved",
          moduleRootId: String(recordType.moduleRootId),
          recordTypeId: String(recordType.recordTypeId),
        };
      };
      const choices =
        type === "choice" && Array.isArray(settings.options)
          ? (settings.options as JsonObject[]).map((option) => ({
              key: String(option.value),
              label: String(option.label),
            }))
          : [];
      const recordTypes: FieldInputSourceField["recordTypes"] =
        type === "link" && settings.target !== undefined
          ? [resolvedRecordType(settings.target)]
          : type === "link_to_one_of_several" && Array.isArray(settings.targets)
            ? (settings.targets as unknown[]).map(resolvedRecordType)
            : [];
      return {
        key: String(field.key),
        label: String(field.label),
        required: field.required === true,
        type,
        ...(type === "text" && settings.format !== undefined
          ? { textFormat: String(settings.format) }
          : {}),
        choices,
        recordTypes,
      };
    },
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
        condition(
          authored,
          (reference) => qualifiedField(resolution, reference),
          valueIndex.context(),
        ),
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
    if (property === "read_model") return [[...canonicalRoot, "readModel", "key"]];
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
    if (sourcePath[2] === "selection")
      return [
        [
          "content",
          "theme",
          "selection",
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

/**
 * The provenance of an Application's flows and flow bindings. The generic pass owns the rest of
 * the content; the flow compiler supplies each flow's exact paths, and a binding's identities
 * are resolved from its aliases while its typed input map is the same value in source and output.
 */
function applicationFlowProvenance(
  source: ApplicationSourceDocumentV2,
  canonical: ApplicationDraftV2,
  flowSet: CompiledFlowSet,
): DefinitionProvenanceEntry[] {
  const entries: DefinitionProvenanceEntry[] = flowSet.provenance.map((entry) => ({
    ...entry,
    canonicalPath: ["content", "flows", ...entry.canonicalPath],
    ...(entry.sourcePath ? { sourcePath: ["body", "flows", ...entry.sourcePath] } : {}),
  }));
  canonical.content.flowBindings.forEach((binding, index) => {
    const authored = source.body.flow_bindings[index]!;
    const canonicalBase: Path = ["content", "flowBindings", index];
    const sourceBase: Path = ["body", "flow_bindings", index];
    const resolved = (canonicalPath: Path, sourcePath: Path) =>
      entries.push({
        canonicalPath: [...canonicalBase, ...canonicalPath],
        origin: "resolved",
        sourcePath: [...sourceBase, ...sourcePath],
        ruleCode: RESOLUTION_RULE,
      });
    resolved(["bindingId"], ["id"]);
    resolved(["controlId"], ["control"]);
    resolved(["eventId"], ["event_id"]);
    resolved(["flow", "flowId"], ["flow"]);
    entries.push({
      canonicalPath: [...canonicalBase, "event"],
      origin: "source",
      sourcePath: [...sourceBase, "event"],
    });
    for (const leaf of leafPaths(binding.flow.inputs)) {
      const sourceValue = valueAtPath(authored.inputs, leaf);
      const canonicalValue = valueAtPath(binding.flow.inputs, leaf);
      entries.push({
        canonicalPath: [...canonicalBase, "flow", "inputs", ...leaf],
        origin: "source",
        sourcePath: [...sourceBase, "inputs", ...leaf],
        ...(canonicalJson(sourceValue) === canonicalJson(canonicalValue)
          ? {}
          : { ruleCode: TRANSFORM_RULE }),
      });
    }
  });
  return entries;
}

function applicationProvenanceV2(
  fullSource: ApplicationSourceDocumentV2,
  fullCanonical: ApplicationDraftV2,
  resolution: Resolution,
  flowSet: CompiledFlowSet,
): DefinitionProvenanceEntry[] {
  // The generic pass below sees the content without its flows and bindings, which are traced above.
  const source: ApplicationSourceDocumentV2 = {
    ...fullSource,
    body: { ...fullSource.body, flows: [], flow_bindings: [] },
  };
  const canonical = {
    ...fullCanonical,
    content: { ...fullCanonical.content, flows: [], flowBindings: [] },
  };
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
    for (const targetPath of targets) {
      const canonicalPath = applicationTypedValueTarget(
        sourceObject,
        sourcePath,
        targetPath,
        canonicalLeafSet,
      );
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
        ["permission", "public_action"].includes(String(sourcePath.at(-1)));
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
        isInterfaceOperationFlowTargetPath(sourceObject, sourcePath) ||
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
      const block = asObject(placement.block);
      const blockId = String(block.blockId);
      const releaseVersion = String(block.releaseVersion);
      const dependencyIndex = source.body.platform_block_dependencies.findIndex(
        (dependency) =>
          String(dependency.block_id) === blockId &&
          String(dependency.release_version) === releaseVersion,
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
  return [...entries, ...applicationFlowProvenance(fullSource, fullCanonical, flowSet)];
}

type ApplicationToolDraft = ApplicationToolBundleInput["tools"][number];
type ApplicationToolStandardRecordAction = Extract<
  ApplicationToolOperationReference,
  { kind: "standard_record_action" }
>["standardAction"];

const isApplicationToolStandardRecordAction = (
  value: string | undefined,
): value is ApplicationToolStandardRecordAction =>
  value !== undefined && standardRecordActions.has(value);

const applicationToolName = (applicationKey: string, operationKind: string, key: string): string =>
  `${applicationKey}.${operationKind}.${key}`;

/** The first label or help text that is a valid tool description, or no description. */
const applicationToolDescription = (
  ...candidates: readonly (string | undefined)[]
): { description?: string } => {
  for (const candidate of candidates) {
    const parsed = descriptionSchema.safeParse(candidate);
    if (parsed.success) return { description: parsed.data };
  }
  return {};
};

/**
 * Derives the one deterministic agent tool bundle an Application release carries. Every tool maps
 * to exactly one real operation, so repeated buttons, repeated form commits and a declared action
 * reused by a form share a single tool; names are namespaced by the application key and
 * canonically ordered, and each input contract and permission meaning is copied from the owning
 * operation. A bound Module's action or query is described only from that Module's exact bound
 * release output; publication always supplies it, and without it the operation is left out rather
 * than described with an invented contract.
 */
function compileApplicationToolBundle(
  canonical: ApplicationDraftV2,
  source: JsonObject,
  resolution: Resolution,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): ApplicationToolBundle {
  const applicationKey = String(canonical.envelope.key);
  const content = canonical.content;
  const applicationOwner = {
    kind: "application" as const,
    applicationRootId: String(canonical.envelope.rootId),
  };
  const boundVersions = new Map(
    content.moduleBindings.map((binding) => [
      String(binding.moduleRootId),
      String(binding.resolvedVersion),
    ]),
  );
  const boundModuleOutputs = dependencyOutputs.filter(
    (output): output is ModuleCompilationOutputV3 =>
      output.kind === "module" &&
      boundVersions.get(String(output.artifact.rootId)) === String(output.artifact.exactVersion),
  );
  const moduleActionsByKey = new Map(
    boundModuleOutputs.flatMap((output) =>
      output.canonical.content.actions.map(
        (action) =>
          [String(action.key), { moduleRootId: String(output.artifact.rootId), action }] as const,
      ),
    ),
  );
  const boundModuleKeys = new Set(
    (asObject(source.body).module_bindings as JsonObject[]).map((binding) =>
      String(binding.module),
    ),
  );
  const applicationActionKeys = new Set(content.actions.map((action) => String(action.key)));
  // A named action that an Application one-task entry-point flow calls with the flow's own inputs
  // is reachable through that flow's tool, the same start path a button or an interface uses, so
  // it gets no second, action-targeted tool that would bypass the flow. An action a flow calls
  // among other work, or with fewer inputs than the action declares, keeps its own tool, so no
  // permitted action or input is dropped.
  const flowEntryInputNames = new Map<string, Set<string>[]>();
  for (const flow of content.flows) {
    const [task] = flow.tasks;
    if (
      flow.execution !== "interactive" ||
      flow.tasks.length !== 1 ||
      flow.errors.length > 0 ||
      flow.finally.length > 0 ||
      task?.type !== "operation.call"
    )
      continue;
    const properties = (task as { properties?: Record<string, JsonObject> }).properties;
    const value = properties?.operation;
    if (
      properties?.inputs !== undefined ||
      value?.kind !== "literal" ||
      typeof asObject(value.literal).value !== "string"
    )
      continue;
    const key = String(asObject(value.literal).value);
    flowEntryInputNames.set(key, [
      ...(flowEntryInputNames.get(key) ?? []),
      new Set(Object.keys(flow.inputs)),
    ]);
  }
  const reachedThroughFlow = (actionKey: string, inputs: readonly unknown[]): boolean =>
    (flowEntryInputNames.get(actionKey) ?? []).some((names) =>
      inputs.every((input) => names.has(String(asObject(input).key))),
    );
  const pagesById = new Map(content.pages.map((page) => [String(page.pageId), page]));
  const tools = new Map<string, ApplicationToolDraft>();
  const add = (tool: ApplicationToolDraft): void => {
    if (!tools.has(tool.name)) tools.set(tool.name, tool);
  };
  const actionPermission = { discover: "page_access", use: "operation_permission" } as const;

  for (const action of content.actions)
    if (!reachedThroughFlow(String(action.key), action.inputs))
      add({
        name: applicationToolName(applicationKey, "action", String(action.key)),
        ...applicationToolDescription(action.label),
        inputSchema: { kind: "action_inputs", inputs: action.inputs },
        operation: {
          kind: "action",
          owner: applicationOwner,
          key: action.key,
          actionId: action.actionId,
        },
        permission: actionPermission,
      });

  // Resolved in the same order as the form commit itself: a bound Module's standard record action,
  // then an Application action (already a tool), then a bound Module's named action.
  const addCommittedAction = (
    pageName: string,
    actionKey: string,
    allowStandardRecordAction: boolean,
  ): void => {
    const name = applicationToolName(applicationKey, "action", actionKey);
    const standard = /^(.+)\.([^.]+)\.([^.]+)$/.exec(actionKey);
    const standardAction = standard?.[3];
    if (
      allowStandardRecordAction &&
      standard &&
      isApplicationToolStandardRecordAction(standardAction) &&
      boundModuleKeys.has(standard[1]!)
    ) {
      const recordType = resolution.recordType(`${standard[1]}:${standard[2]}`);
      add({
        name,
        ...applicationToolDescription(pageName),
        inputSchema: { kind: "record_type", recordTypeId: recordType.recordTypeId },
        operation: {
          kind: "standard_record_action",
          key: actionKey,
          moduleRootId: String(recordType.moduleRootId),
          recordTypeId: recordType.recordTypeId,
          standardAction,
        },
        permission: actionPermission,
      });
      return;
    }
    if (applicationActionKeys.has(actionKey)) return;
    const moduleAction = moduleActionsByKey.get(actionKey);
    if (moduleAction === undefined || reachedThroughFlow(actionKey, moduleAction.action.inputs))
      return;
    add({
      name,
      ...applicationToolDescription(moduleAction.action.label, pageName),
      inputSchema: { kind: "module_inputs", inputs: moduleAction.action.inputs },
      operation: {
        kind: "action",
        owner: { kind: "module", moduleRootId: moduleAction.moduleRootId },
        key: actionKey,
        actionId: moduleAction.action.actionId,
      },
      permission: actionPermission,
    });
  };

  // A form commits what its bound `form_submit` flows commit, derived exactly as Definition
  // validation derives it, so the tool bundle and the published contract never drift.
  const standardActionKeysByRecordAction = new Map<string, string>();
  for (const output of boundModuleOutputs) {
    const moduleKey = String(output.canonical.envelope.key);
    for (const record of output.canonical.content.recordTypes)
      for (const action of record.standardActions)
        standardActionKeysByRecordAction.set(
          `${String(record.recordTypeId)}:${action}`,
          `${moduleKey}.${String(record.key)}.${action}`,
        );
  }
  const formCommits = deriveFormCommitActionKeys(content, {
    standardActionKeysByRecordAction,
    executableActionKeys: new Set([
      ...applicationActionKeys,
      ...moduleActionsByKey.keys(),
      ...standardActionKeysByRecordAction.values(),
    ]),
  });

  for (const page of content.pages) {
    if (page.type === "form" || page.type === "guided_form") {
      for (const key of formCommits.get(String(page.pageId)) ?? [])
        if (key !== "") addCommittedAction(page.name, key, true);
    } else if (page.type === "public" && page.publicActionKey !== undefined) {
      addCommittedAction(page.name, String(page.publicActionKey), false);
    }
  }

  // A flow's record reads name only this Application's own queries, which have their own tools
  // below, so a flow contributes exactly its own entry point.
  for (const flow of content.flows)
    add({
      name: applicationToolName(applicationKey, "flow", String(flow.key)),
      ...applicationToolDescription(flow.description, flow.labels.name),
      inputSchema: {
        kind: "flow_inputs",
        inputs: Object.fromEntries(
          Object.entries(flow.inputs).map(([name, declaration]) => [
            name,
            {
              type: declaration.type,
              required: declaration.required,
              ...(declaration.recordTypeIds === undefined
                ? {}
                : { recordTypeIds: declaration.recordTypeIds }),
            },
          ]),
        ),
      },
      operation: { kind: "flow", key: flow.key, flowId: ruleIdSchema.parse(String(flow.id)) },
      permission: { discover: "page_access", use: "delegated_operations" },
    });

  for (const query of content.queries)
    add({
      name: applicationToolName(applicationKey, "query", String(query.key)),
      inputSchema: { kind: "none" },
      operation: { kind: "query", owner: applicationOwner, key: query.key, queryId: query.queryId },
      permission: { discover: "page_access", use: "none" },
    });

  const addNavigation = (items: readonly NavigationItem[]): void => {
    for (const item of items) {
      if (item.type === "heading") {
        addNavigation(item.children);
        continue;
      }
      if (item.type !== "page") continue;
      const page = pagesById.get(String(item.pageId));
      if (page === undefined) continue;
      add({
        name: applicationToolName(applicationKey, "navigation", String(page.key)),
        ...applicationToolDescription(item.label, page.name),
        inputSchema: { kind: "none" },
        operation: { kind: "navigation", key: page.key, pageId: page.pageId },
        permission: { discover: "application_navigation", use: "none" },
      });
    }
  };
  addNavigation(content.navigation);

  return applicationToolBundleSchema.parse({
    contractVersion: "1.0.0",
    applicationKey,
    tools: [...tools.values()].sort((left, right) =>
      compareCanonicalStrings(left.name, right.name),
    ),
  });
}

function compileApplicationV2Internal(
  input: unknown,
  context?: DefinitionCompilationContext,
): ApplicationCompilationOutputV2 {
  const parsed = applicationCompilationRequestV2Schema.safeParse(input);
  if (!parsed.success) fail("vortex.definition.invalid_compilation_request", "invalid_value");
  return compileParsedApplicationV2Request(parsed.data, parseDefinitionCompilationContext(context));
}

/**
 * Compiles the flows a module or application owns to permanent identities (#984), refusing an
 * unresolved alias, an unregistered task or a reference outside the declared dependencies. The
 * canonical flows go into the definition's content and their provenance into its provenance; the
 * dependency manifest contribution only ever names definitions the source already declares, so
 * the definition's own resolved dependencies stay the one record of exact releases.
 */
function compileOwnedFlowSources(source: JsonObject, resolution: Resolution) {
  const parsed = sourceFlowCollectionSchema.safeParse(asObject(source.body).flows);
  if (!parsed.success) fail("vortex.definition.source_shape", "invalid_value");
  const ownKey = String(source.key);
  const owned = (kind: string, alias: string): ResolvedFlowIdentity => {
    const split = alias.indexOf(":");
    const definitionKey = split < 1 ? ownKey : alias.slice(0, split);
    return {
      identifier: resolution.id(definitionKey, kind, alias.slice(split + 1), "content"),
      definitionKey,
    };
  };
  const qualifiedRecord = (reference: string) =>
    reference.includes(":") ? reference : `${ownKey}:${reference}`;
  const recordOwner = (reference: string) => qualifiedRecord(reference).split(":")[0]!;
  return compileFlowSources({
    flows: parsed.data,
    declaredDefinitionKeys: dependencyOrder(source).filter((key) => key !== ownKey),
    resolver: {
      definitionKey: ownKey,
      flow: (alias) => owned("flow", alias),
      recordType: (reference) => ({
        identifier: resolution.recordType(qualifiedRecord(reference)).recordTypeId,
        definitionKey: recordOwner(reference),
      }),
      field: (record, alias) => ({
        identifier: resolution.field(qualifiedRecord(record), alias),
        definitionKey: recordOwner(record),
      }),
      relationship: (record, alias) => ({
        identifier: resolution.relationship(qualifiedRecord(record), alias),
        definitionKey: recordOwner(record),
      }),
      action: (alias) => owned("action", alias),
      permission: (alias) => owned("permission", alias),
      query: (alias) => owned("query", alias),
      page: (alias) => owned("page", alias),
      // A form is the page placement that holds it.
      form: (alias) => owned("block_placement", alias),
      connectionBinding: (alias) => owned("connection_binding", alias),
      executionBinding: (alias) => owned("execution_binding", alias),
      locate: (flowKey) => resolution.location("flow", flowKey),
    },
  });
}

/**
 * Compiles the flows a definition owns and proves that every operation they call exists: a
 * registered platform-service operation, or a named action of this definition or of a Module it
 * declares as a dependency. A flow that calls anything else is refused here, on the task.
 */
function compileCheckedFlowSources(
  source: JsonObject,
  resolution: Resolution,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
) {
  const flowSet = compileOwnedFlowSources(source, resolution);
  const actions = new Map<string, ReturnType<typeof namedActionInputs>>();
  const remember = (candidates: unknown) => {
    for (const action of (Array.isArray(candidates) ? candidates : []) as JsonObject[])
      actions.set(
        String(action.key),
        namedActionInputs(
          (Array.isArray(action.inputs) ? (action.inputs as JsonObject[]) : []).map((input) => ({
            key: String(input.key),
            required: input.required === true,
          })),
        ),
      );
  };
  remember(asObject(source.body).actions);
  for (const output of dependencyOutputs)
    if (output.kind === "module") remember(output.canonical.content.actions);
  const issue = findOperationCallIssue(
    flowSet.flows,
    // Only an Application pins a platform operation's release in its manifest, so only an
    // Application may call one.
    (key) =>
      (source.kind === "application" ? platformOperationLookup(key) : undefined) ??
      actions.get(key),
  );
  if (issue !== undefined)
    throw new DefinitionCompilationError(
      issue.ruleCode,
      issue.family,
      flowIssueLocation(resolution.location("flow", issue.flowKey), { taskId: issue.taskId }),
    );
  return flowSet;
}

function compileParsedApplicationV2Request(
  request: ParsedApplicationV2Request,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): ApplicationCompilationOutputV2 {
  const source = request.source;
  const sourceObject = source as unknown as JsonObject;
  try {
    // Publication refuses with the first of the located catalogue results draft save reports,
    // before materialisation can refuse the same document without its location.
    const catalogueFailure = settleDefinitionRuleFailures(
      validateApplicationSourceCatalogue(
        source,
        request.catalogueSnapshot.platformBlocks.releases,
      ),
    )[0];
    if (catalogueFailure !== undefined)
      throw new DefinitionCompilationError(
        catalogueFailure.ruleCode,
        catalogueFailure.family,
        catalogueFailure.location,
      );
    const resolution = new Resolution(request.resolution, sourceObject);
    const flowSet = compileCheckedFlowSources(sourceObject, resolution, dependencyOutputs);
    const valueIndex = applicationModuleValueIndex(sourceObject, resolution, dependencyOutputs);
    const composition = materialiseApplicationCompositionV2(
      source,
      request.catalogueSnapshot,
      applicationCompositionResolutionV2(source, resolution, valueIndex),
    );
    const canonical = applicationDraftV2Schema.parse(
      compileApplication(
        sourceObject,
        resolution,
        request.draftMetadata as unknown as JsonObject,
        dependencyOutputs,
        composition,
        valueIndex,
        flowSet.flows,
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
      provenance: applicationProvenanceV2(source, canonical, resolution, flowSet),
      dependencyOrder: dependencyOrder(sourceObject),
      resolvedDependencies: resolvedDependencies(sourceObject, resolution),
      resolutionFingerprint: request.resolution.fingerprint,
      toolBundle: compileApplicationToolBundle(
        canonical,
        sourceObject,
        resolution,
        dependencyOutputs,
      ),
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

function compileModuleV3Internal(
  input: unknown,
  context?: DefinitionCompilationContext,
): ModuleCompilationOutputV3 {
  const parsed = moduleCompilationRequestV3Schema.safeParse(input);
  if (!parsed.success) fail("vortex.definition.invalid_compilation_request", "invalid_value");
  return compileParsedModuleV3Request(parsed.data, parseDefinitionCompilationContext(context));
}

function compileParsedModuleV3Request(
  request: ParsedModuleV3Request,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): ModuleCompilationOutputV3 {
  const source = request.source as unknown as JsonObject;
  try {
    const resolution = new Resolution(request.resolution, source);
    const flowSet = compileCheckedFlowSources(source, resolution, dependencyOutputs);
    const definitionKey = request.source.key;
    // Every BeforeSave flow is lowered to the executable rule the save transaction reads until
    // the flow interpreter replaces it. A flow that cannot be lowered refuses here, located on it.
    const ruleSources = request.source.body.flows.flatMap((flow, sourceIndex) =>
      isBeforeSaveFlow(flow) ? [{ flow, sourceIndex }] : [],
    );
    const ruleKeys = new Map(ruleSources.map(({ flow }) => [flow.id, flow.key]));
    const localRecordKey = (alias: string): string => {
      const record = request.source.body.record_types.find(
        (record) => record.id === alias || record.key === alias,
      );
      if (!record) fail("vortex.definition.missing_identity", "unresolved_reference");
      return record.key;
    };
    const nestedId = (kind: string, ruleAlias: string, alias: string): string => {
      const key = ruleKeys.get(ruleAlias);
      if (key === undefined) fail("vortex.definition.missing_identity", "unresolved_reference");
      return resolution.id(definitionKey, kind, alias, `rule:${key}`);
    };
    const rules = ruleSources
      .map(({ flow, sourceIndex }) => {
        const lowered = lowerBeforeSaveFlow(flow);
        if (!lowered.ok)
          throw new DefinitionCompilationError(
            lowered.refusal.ruleCode,
            lowered.refusal.family,
            flowIssueLocation(resolution.location("flow", flow.key), lowered.refusal),
          );
        return {
          sourceIndex,
          ...compileRuleGraph(lowered.graph, {
            // A rule is the executable form of its flow, so it keeps the flow's own identity.
            ruleId: (alias) =>
              ruleIdSchema.parse(resolution.id(definitionKey, "flow", alias, "content")),
            nodeId: (ruleAlias, alias) =>
              containedComponentIdSchema.parse(nestedId("rule_node", ruleAlias, alias)),
            inputId: (ruleAlias, alias) =>
              containedComponentIdSchema.parse(nestedId("rule_input", ruleAlias, alias)),
            variableId: (ruleAlias, alias) =>
              containedComponentIdSchema.parse(nestedId("rule_variable", ruleAlias, alias)),
            localRecordTypeId: (alias) =>
              recordTypeIdSchema.parse(
                resolution.recordType(`${definitionKey}:${alias}`).recordTypeId,
              ),
            localFieldId: (record, field) =>
              fieldIdSchema.parse(
                resolution.field(`${definitionKey}:${localRecordKey(record)}`, field),
              ),
            qualifiedRecordTypeId: (reference) =>
              recordTypeIdSchema.parse(resolution.recordType(reference).recordTypeId),
          }),
        };
      })
      .sort(
        (a, b) =>
          a.graph.priority - b.graph.priority ||
          compareCanonicalStrings(a.graph.ruleId, b.graph.ruleId),
      );
    const canonical = moduleDraftV3Schema.parse(
      compileModule(
        source,
        resolution,
        request.draftMetadata as unknown as JsonObject,
        (request.savedConditionRevisions ?? []) as unknown as JsonObject[],
        dependencyOutputs,
        rules.map(({ graph }) => graph),
        flowSet.flows,
      ),
    );
    // Existing provenance owns the unchanged Module field model. The flow compiler supplies the
    // exact paths of the flows, and each derived rule traces to the flow it is the executable
    // form of, so neither is described twice.
    const provenance = provenanceFor(
      { ...source, body: { ...request.source.body, flows: [] } },
      { ...canonical, content: { ...canonical.content, flows: [], rules: [] } },
      resolution,
    );
    for (const entry of flowSet.provenance)
      provenance.push({
        ...entry,
        canonicalPath: ["content", "flows", ...entry.canonicalPath],
        ...(entry.sourcePath ? { sourcePath: ["body", "flows", ...entry.sourcePath] } : {}),
      });
    // A compiled named action's flow shares the action's permanent identity, so every canonical
    // leaf of it traces to the action declaration that produced it.
    const actionIndexById = new Map(
      (canonical.content.actions as unknown as JsonObject[]).map((action, index) => [
        String(action.actionId),
        index,
      ]),
    );
    (canonical.content.flows as unknown as JsonObject[]).forEach((flow, canonicalIndex) => {
      const actionIndex = actionIndexById.get(String(flow.id));
      if (actionIndex === undefined) return;
      for (const leaf of leafPaths(flow))
        provenance.push({
          canonicalPath: ["content", "flows", canonicalIndex, ...leaf],
          origin: "source",
          sourcePath: ["body", "actions", actionIndex, "id"],
          ruleCode: TRANSFORM_RULE,
        });
    });
    rules.forEach((rule, canonicalIndex) => {
      for (const leaf of leafPaths(canonical.content.rules[canonicalIndex]))
        provenance.push({
          canonicalPath: ["content", "rules", canonicalIndex, ...leaf],
          origin: "source",
          sourcePath: ["body", "flows", rule.sourceIndex, "key"],
          ruleCode: TRANSFORM_RULE,
        });
    });
    const ownDefinition = resolution.definition(definitionKey, "module");
    const output = moduleCompilationOutputV3Schema.safeParse({
      kind: "module",
      validationContractVersion: "3.0.0",
      canonical,
      artifact: {
        kind: "module",
        definitionKey,
        rootId: ownDefinition.rootId,
        exactVersion: ownDefinition.exactVersion,
        contentFingerprint: fingerprintCanonicalValue(canonical.content),
        resolutionFingerprint: request.resolution.fingerprint,
      },
      provenance,
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

/** Requests as this package's own schemas return them, carrying the ids compiling needs. */
type ParsedConnectionRequest = ReturnType<typeof definitionCompilationRequestSchema.parse>;
type ParsedApplicationV2Request = ReturnType<typeof applicationCompilationRequestV2Schema.parse>;
type ParsedModuleV3Request = ReturnType<typeof moduleCompilationRequestV3Schema.parse>;

/** The request shapes the compile entry points dispatch on, as they declare them. */
type DispatchableCompilationRequest =
  | DefinitionCompilationRequest
  | ApplicationCompilationRequestV2
  | ModuleCompilationRequestV3;

/**
 * Package-internal compile entry for a request this package parsed and dependency outputs it
 * parsed or produced, so neither is parsed a second time. index.ts and compiler-api.ts do not
 * re-export it: callers outside this package use compileDefinition or
 * compileDefinitionWithContext, which parse what they are given.
 */
export function compileParsedDefinition(
  request: ApplicationCompilationRequestV2,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): ApplicationCompilationOutputV2;
export function compileParsedDefinition(
  request: ModuleCompilationRequestV3,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): ModuleCompilationOutputV3;
export function compileParsedDefinition(
  request: DefinitionCompilationRequest,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): DefinitionCompilationOutput;
export function compileParsedDefinition(
  request: DispatchableCompilationRequest,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): DefinitionCompilationOutput {
  assertDependencyOutputLimits(dependencyOutputs);
  const explicitKind = explicitCompilationKind(request);
  if (explicitKind === "module")
    return compileParsedModuleV3Request(request as ParsedModuleV3Request, dependencyOutputs);
  if (explicitKind === "application")
    return compileParsedApplicationV2Request(
      request as ParsedApplicationV2Request,
      dependencyOutputs,
    );
  return compileParsedConnectionRequest(request as ParsedConnectionRequest);
}

export function compileDefinition(
  input: ApplicationCompilationRequestV2,
): ApplicationCompilationOutputV2;
export function compileDefinition(input: ModuleCompilationRequestV3): ModuleCompilationOutputV3;
export function compileDefinition(input: DefinitionCompilationRequest): DefinitionCompilationOutput;
export function compileDefinition(
  input: unknown,
): DefinitionCompilationOutput | ApplicationCompilationOutputV2 {
  const explicitKind = explicitCompilationKind(input);
  if (explicitKind === "module") return compileModuleV3Internal(input);
  if (explicitKind === "application") return compileApplicationV2Internal(input);
  return compileDefinitionInternal(input);
}

export function compileDefinitionWithContext(
  input: ApplicationCompilationRequestV2,
  context: DefinitionCompilationContext,
): ApplicationCompilationOutputV2;
export function compileDefinitionWithContext(
  input: ModuleCompilationRequestV3,
  context: DefinitionCompilationContext,
): ModuleCompilationOutputV3;
export function compileDefinitionWithContext(
  input: DefinitionCompilationRequest,
  context: DefinitionCompilationContext,
): DefinitionCompilationOutput;
export function compileDefinitionWithContext(
  input: unknown,
  context: DefinitionCompilationContext,
): DefinitionCompilationOutput | ApplicationCompilationOutputV2 {
  const explicitKind = explicitCompilationKind(input);
  if (explicitKind === "module") return compileModuleV3Internal(input, context);
  if (explicitKind === "application") return compileApplicationV2Internal(input, context);
  return compileDefinitionInternal(input, context);
}
