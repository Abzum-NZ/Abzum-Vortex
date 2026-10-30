import { namespacedKeySchema, builderKeySchema } from "../../catalogue/identifiers";
import type { DefinitionValidationLocation } from "../../catalogue/validation-errors";
import { type JsonObject, type DefinitionPath, isApplicationSource } from "./context";
import { array, object } from "./helpers";

export const actionPermissionKeys = (action: JsonObject): string[] =>
  action.permissionKeys === undefined
    ? action.permissionKey === undefined
      ? []
      : [String(action.permissionKey)]
    : array(action.permissionKeys).map(String);

export const actionPermissionsMatch = (
  action: JsonObject,
  permissionsByKey: ReadonlyMap<string, JsonObject>,
  permissionOwnersByKey?: ReadonlyMap<string, string>,
): boolean => {
  if (action.permissionKeys === undefined)
    return action.permissionKey !== undefined && permissionsByKey.has(String(action.permissionKey));
  const permissions = actionPermissionKeys(action).map((key) => permissionsByKey.get(key));
  const first = permissions[0];
  if (first === undefined || String(first.recordTypeId) !== String(action.subjectRecordTypeId))
    return false;
  const firstOwner = permissionOwnersByKey?.get(String(first.key));
  return permissions.every(
    (permission) =>
      permission !== undefined &&
      String(permission.recordTypeId) === String(action.subjectRecordTypeId) &&
      permission.actionKind === first.actionKind &&
      String(permission.namedAction ?? "") === String(first.namedAction ?? "") &&
      (first.actionKind !== "named" ||
        permissionOwnersByKey?.get(String(permission.key)) === firstOwner),
  );
};

/**
 * The flow a canonical action runs: a `transaction` flow of its Module with no trigger, whose
 * record input is the action's subject and whose other inputs are exactly the action's own inputs.
 * `undefined` when the action has no flow (a protected-operation action) or the flow is not that.
 */
export const actionFlowOf = (
  action: JsonObject,
  flows: ReadonlyMap<string, unknown>,
): JsonObject | undefined => {
  const flow = flows.get(String(action.flowId)) as JsonObject | undefined;
  if (flow === undefined || flow.execution !== "transaction" || array(flow.triggers).length > 0)
    return undefined;
  const flowInputs = object(flow.inputs);
  const recordInput = flow.recordInput === undefined ? undefined : String(flow.recordInput);
  const subject = recordInput === undefined ? undefined : object(flowInputs[recordInput]);
  const subjectTypes = subject === undefined ? [] : array(subject.recordTypeIds).map(String);
  if (
    subject === undefined ||
    subject.type !== "record_reference" ||
    subjectTypes.length !== 1 ||
    subjectTypes[0]!.toLowerCase() !== String(action.subjectRecordTypeId).toLowerCase()
  )
    return undefined;
  // An action flow is a linear list of record steps, which the write policy is derived from.
  if (
    !array(flow.tasks).every((task) =>
      [
        "record.set_fields",
        "record.create",
        "record.changes",
        "record.delete",
        "event.announce",
        "stop",
      ].includes(String(task.type)),
    )
  )
    return undefined;
  const declared = array(action.inputs);
  const others = Object.entries(flowInputs).filter(([key]) => key !== recordInput);
  return others.length === declared.length &&
    declared.every((input) => object(flowInputs[String(input.key)]).type === input.type)
    ? flow
    : undefined;
};

/** Every top-level task of an action's flow, in order. */
const actionFlowTasks = (flow: JsonObject): JsonObject[] => array(flow.tasks);

/**
 * A `record.delete` task deletes the subject at the revision the command
 * names, so a deleting action has exactly one delete and may otherwise only copy
 * relationships (which write the target, never the subject) and announce Events.
 * A subject write or a creation can move that revision. The Record runtime
 * refuses the same combination when it composes the action.
 */
export const actionDeleteEffectsSupported = (flow: JsonObject | undefined): boolean => {
  const types = flow === undefined ? [] : actionFlowTasks(flow).map((task) => String(task.type));
  return (
    !types.includes("record.delete") ||
    (types.filter((type) => type === "record.delete").length === 1 &&
      types.every((type) => ["record.delete", "record.changes", "event.announce"].includes(type)))
  );
};

/** The `record.set_fields` entries of an action's flow: field key and the flow value it is set to. */
export const actionFlowSetFields = (
  flow: JsonObject,
): readonly Readonly<{ field: string; value: JsonObject }>[] =>
  actionFlowTasks(flow).flatMap((task) =>
    String(task.type) === "record.set_fields"
      ? Object.entries(object(object(object(task.properties).values).entries)).map(
          ([field, value]) => ({ field, value: object(value) }),
        )
      : [],
  );

const sourceCollectionLocationKind = {
  record_types: "record_type",
  fields: "field",
  relationships: "relationship",
  actions: "action",
  events: "event",
  extension_points: "extension_point",
  pages: "page",
  blocks: "block",
  block_registrations: "block",
  pipelines: "pipeline",
  queries: "query",
  roles: "role",
  connection_bindings: "connection",
  interfaces: "interface",
  settings: "setting",
  shapes: "setting",
  operations: "setting",
  incoming_messages: "setting",
  flows: "flow",
  flow_bindings: "flow_binding",
} as const satisfies Partial<
  Record<string, DefinitionValidationLocation["segments"][number]["kind"]>
>;

const flowTaskListNames: ReadonlySet<string> = new Set([
  "tasks",
  "then",
  "else",
  "default",
  "errors",
  "finally",
]);

export function sourceTranslationContext(source: unknown) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined;
  const document = source as JsonObject;
  const documentKind = document.kind;
  const parsedKey = namespacedKeySchema.safeParse(document.key);
  if (
    (documentKind !== "module" &&
      documentKind !== "application" &&
      documentKind !== "connection_type") ||
    !parsedKey.success
  )
    return undefined;
  const rootKind =
    documentKind === "module"
      ? ("module" as const)
      : documentKind === "application"
        ? ("application" as const)
        : ("connection" as const);
  const rootLocation: DefinitionValidationLocation = {
    documentKind,
    documentKey: parsedKey.data,
    segments: [{ kind: rootKind, key: parsedKey.data }],
  };
  const pathMap: { sourcePath: (string | number)[]; location: DefinitionValidationLocation }[] = [
    { sourcePath: [], location: rootLocation },
  ];
  const pending: {
    value: unknown;
    path: (string | number)[];
    segments: DefinitionValidationLocation["segments"];
    collectionName?: string;
    depth: number;
  }[] = [{ value: document, path: [], segments: rootLocation.segments, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 50_000) {
    const current = pending.pop()!;
    if (current.depth > 32) continue;
    visited += 1;
    if (Array.isArray(current.value)) {
      for (let index = Math.min(current.value.length, 1_000) - 1; index >= 0; index -= 1)
        pending.push({
          ...current,
          value: current.value[index],
          path: [...current.path, index],
          depth: current.depth + 1,
        });
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    const entry = current.value as JsonObject;
    const insideFlow = current.segments.some((segment) => segment.kind === "flow");
    // A flow's tasks, at any depth, are located by their readable task id.
    const locationKind =
      insideFlow &&
      current.collectionName !== undefined &&
      flowTaskListNames.has(current.collectionName)
        ? "flow_node"
        : current.collectionName
          ? sourceCollectionLocationKind[
              current.collectionName as keyof typeof sourceCollectionLocationKind
            ]
          : undefined;
    const candidateKey = entry.key ?? entry.id;
    const parsedCandidate = namespacedKeySchema.or(builderKeySchema).safeParse(candidateKey);
    const nextSegments: DefinitionValidationLocation["segments"] =
      locationKind && parsedCandidate.success && current.segments.length < 12
        ? [...current.segments, { kind: locationKind, key: parsedCandidate.data }]
        : current.segments;
    if (nextSegments !== current.segments)
      pathMap.push({
        sourcePath: current.path,
        location: { ...rootLocation, segments: nextSegments },
      });
    const keys: string[] = [];
    for (const key in entry) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
      keys.push(key);
      if (keys.length === 1_000) break;
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      pending.push({
        value: entry[key],
        path: [...current.path, key],
        segments: nextSegments,
        collectionName: key,
        depth: current.depth + 1,
      });
    }
  }
  return { rootLocation, pathMap };
}

export const sourceValueAtPath = (source: unknown, path: DefinitionPath): unknown =>
  path.reduce<unknown>((value, part) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string | number, unknown>)[part];
  }, source);

export const unlistedBlockPath = (source: unknown): DefinitionPath | undefined => {
  if (!isApplicationSource(source)) return undefined;
  const body = object(object(source).body);
  const listed = new Set(
    array(body.platform_block_dependencies).map(
      (entry) => `${entry.block_id}@${entry.release_version}`,
    ),
  );
  const pending: { value: unknown; path: DefinitionPath }[] = [{ value: body, path: ["body"] }];
  let visited = 0;
  while (pending.length > 0 && visited++ < 50_000) {
    const current = pending.pop()!;
    if (current.value === null || typeof current.value !== "object") continue;
    const entries = Object.entries(current.value);
    for (const [key, value] of entries) {
      if (key === "block" && value !== null && typeof value === "object") {
        const block = object(value);
        if (!listed.has(`${block.block_id}@${block.release_version}`))
          return [...current.path, "block", "block_id"];
      }
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, value] = entries[index]!;
      pending.push({
        value,
        path: [...current.path, Array.isArray(current.value) ? Number(key) : key],
      });
    }
  }
  return undefined;
};

export const issueLocation = (
  translation: NonNullable<ReturnType<typeof sourceTranslationContext>>,
  path: DefinitionPath,
): DefinitionValidationLocation => {
  const ancestor = [...translation.pathMap]
    .reverse()
    .find((entry) => entry.sourcePath.every((part, index) => path[index] === part));
  const location = ancestor?.location ?? translation.rootLocation;
  const property = [...path].reverse().find((part): part is string => typeof part === "string");
  if (
    property === undefined ||
    location.segments.length >= 12 ||
    !builderKeySchema.safeParse(property).success
  )
    return location;
  const placementIndex = path.lastIndexOf("placements");
  const placementAlias = placementIndex < 0 ? undefined : path[placementIndex + 1];
  const namedPlacement =
    typeof placementAlias === "string" &&
    builderKeySchema.safeParse(placementAlias).success &&
    location.segments.length < 11
      ? [{ kind: "setting" as const, key: placementAlias }]
      : [];
  return {
    ...location,
    segments: [...location.segments, ...namedPlacement, { kind: "setting", key: property }],
  };
};

export function leafPaths(value: unknown, path: DefinitionPath = []): DefinitionPath[] {
  if (Array.isArray(value))
    return value.flatMap((entry, index) => leafPaths(entry, [...path, index]));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, entry]) => leafPaths(entry, [...path, key]));
  return [path];
}
