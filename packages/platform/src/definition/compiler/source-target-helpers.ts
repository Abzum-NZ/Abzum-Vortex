import { canonicalJson } from "../canonical-json-definition";
import { permissionScopeSourceOwners } from "./permission-scopes";
import type { Resolution } from "./resolution";
import {
  asObject,
  camelCase,
  fail,
  type JsonObject,
  leafPaths,
  type Path,
  pathKey,
  valueAtPath,
} from "./shared";

export function applicationSearchTargets(
  source: JsonObject,
  canonical: unknown,
  sourcePath: Path,
): Path[] | undefined {
  if (
    source.kind === "application" &&
    sourcePath[0] === "body" &&
    sourcePath[1] === "search" &&
    sourcePath[2] === "record_types" &&
    typeof sourcePath[3] === "number"
  ) {
    const base: Path = ["content", "search", "recordTypes", sourcePath[3]];
    if (sourcePath[4] === "record_type")
      return leafPaths(valueAtPath(canonical, [...base, "recordType"]), [...base, "recordType"]);
    if (sourcePath[4] === "fields" && typeof sourcePath[5] === "number")
      return [
        [...base, "fields", sourcePath[5], sourcePath[6] === "field" ? "fieldId" : "priority"],
      ];
    const properties: Readonly<Record<string, string>> = {
      title_field: "titleFieldId",
      subtitle_field: "subtitleFieldId",
      target_page: "targetPageId",
    };
    const property = properties[String(sourcePath[4])];
    if (property !== undefined) return [[...base, property]];
  }
  return undefined;
}

export function applicationRolePermissionTargets(
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

export function conditionSourceTargets(
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
    suffixPath.map((segment) => {
      if (segment === "record_type") return "recordTypeId";
      if (segment === "record_id") return "recordId";
      if (segment === "organization_account_id") return "organizationAccountId";
      return segment;
    });
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

export function permissionRecordScopeTargets(
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

export function permissionFieldPolicyTargets(
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
 * entry point by its source alias, which compiles to that flow's permanent identity.
 */
export function isInterfaceOperationFlowTargetPath(source: JsonObject, sourcePath: Path): boolean {
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
