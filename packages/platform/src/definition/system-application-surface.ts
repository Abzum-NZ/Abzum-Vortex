import { canonicalJson } from "./canonical-json";
import { DefinitionError } from "./definition-error";

/**
 * The part of a platform system application that people holding `system_applications.manage` can
 * never change: the protected platform operations its actions and flow steps call, the shape of
 * its system projections, and the permissions and roles through which the organisation's steward
 * keeps a working way to manage access (architecture decision 11). A release is compared with the
 * release it follows; `vortex_definition.system_application_surface_violation` makes the same
 * comparison, with the same sentences, inside the publish transaction.
 */

type Json = unknown;
type SurfaceKind =
  "action_operation" | "flow_operation" | "system_projection" | "permission" | "role";
type SurfaceEntry = Readonly<{ kind: SurfaceKind; block: string; detail: Json }>;

const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: Json): Record<string, Json>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const text = (value: Json): string => (typeof value === "string" ? value : "");

/** Every task of a flow, nested lists included, that calls a protected operation. */
const operationCalls = (value: Json): Record<string, Json>[] => {
  if (Array.isArray(value)) return value.flatMap(operationCalls);
  if (!isRecord(value)) return [];
  return [
    ...(value.type === "operation.call" ? [value] : []),
    ...Object.values(value).flatMap(operationCalls),
  ];
};

const without = (value: Record<string, Json>, ...keys: string[]): Record<string, Json> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

const surfaceOf = (content: Json): SurfaceEntry[] => {
  const body = isRecord(content) ? content : {};
  const entries: SurfaceEntry[] = [];
  for (const action of records(body.actions))
    if (action.protectedOperation !== undefined)
      entries.push({
        kind: "action_operation",
        block: text(action.key),
        detail: { operation: action.protectedOperation, subject: action.subjectRecordTypeId },
      });
  for (const flow of records(body.flows))
    for (const task of operationCalls(flow))
      entries.push({
        kind: "flow_operation",
        block: `${text(flow.key)}/${text(task.id)}`,
        detail: isRecord(task.properties) ? (task.properties.operation ?? null) : null,
      });
  for (const recordType of records(body.recordTypes))
    if (recordType.systemProjection !== undefined)
      entries.push({
        kind: "system_projection",
        block: text(recordType.key),
        detail: {
          recordTypeId: recordType.recordTypeId,
          storageContractId: recordType.storageContractId,
          projection: recordType.systemProjection,
          standardActions: recordType.standardActions,
          customActionIds: recordType.customActionIds,
          fields: records(recordType.fields)
            .map((field) => ({ fieldId: field.fieldId, key: field.key, type: field.type }))
            .sort((left, right) => (text(left.fieldId) < text(right.fieldId) ? -1 : 1)),
        },
      });
  for (const permission of records(body.permissions))
    entries.push({
      kind: "permission",
      block: text(permission.key),
      detail: without(permission, "label", "description"),
    });
  for (const role of records(body.roles))
    entries.push({ kind: "role", block: text(role.key), detail: without(role, "name") });
  return entries;
};

const noun: Record<SurfaceKind, string> = {
  action_operation: "The action",
  flow_operation: "The flow step",
  system_projection: "The platform data view",
  permission: "The permission",
  role: "The role",
};

const change = (kind: SurfaceKind, state: "removed" | "added" | "changed"): string => {
  switch (kind) {
    case "action_operation":
    case "flow_operation":
      return state === "removed"
        ? "no longer calls its protected platform operation"
        : state === "added"
          ? "would call a protected platform operation the platform did not give it"
          : "would call a different protected platform operation than the platform gave it";
    case "system_projection":
      return state === "removed"
        ? "would be removed"
        : state === "added"
          ? "would be added"
          : "would change its shape or its platform actions";
    default:
      return state === "removed"
        ? "would be removed"
        : state === "added"
          ? "would be added"
          : "would change";
  }
};

const tail = (kind: SurfaceKind): string => {
  switch (kind) {
    case "action_operation":
    case "flow_operation":
      return "A platform application keeps the protected operations the platform gave it, so undo this change before publishing.";
    case "system_projection":
      return "A platform data view stays exactly as the platform defines it, so undo this change before publishing.";
    default:
      return "The organisation's steward must always keep a working way to manage access, so a platform application keeps the permissions and roles the platform gave it. Undo this change before publishing.";
  }
};

/**
 * The first change a release makes to the protected surface of the release it follows, worded for
 * the person publishing and naming the block or binding it is about, or null when it makes none.
 * Without a previous release every protected entry is an addition.
 */
const systemApplicationSurfaceViolation = (previous: Json, next: Json): string | null => {
  const before = new Map(
    surfaceOf(previous).map((entry) => [`${entry.kind}\u0000${entry.block}`, entry]),
  );
  const after = new Map(
    surfaceOf(next).map((entry) => [`${entry.kind}\u0000${entry.block}`, entry]),
  );
  const problems: { kind: SurfaceKind; block: string; state: "removed" | "added" | "changed" }[] =
    [];
  for (const [key, entry] of before) {
    const other = after.get(key);
    if (other === undefined)
      problems.push({ kind: entry.kind, block: entry.block, state: "removed" });
    else if (canonicalJson(other.detail) !== canonicalJson(entry.detail))
      problems.push({ kind: entry.kind, block: entry.block, state: "changed" });
  }
  for (const [key, entry] of after)
    if (!before.has(key)) problems.push({ kind: entry.kind, block: entry.block, state: "added" });
  problems.sort((left, right) =>
    left.kind === right.kind
      ? left.block < right.block
        ? -1
        : left.block > right.block
          ? 1
          : 0
      : left.kind < right.kind
        ? -1
        : 1,
  );
  const first = problems[0];
  return first === undefined
    ? null
    : `${noun[first.kind]} "${first.block}" ${change(first.kind, first.state)}. ${tail(first.kind)}`;
};

/** Refuses a release of a platform system application that changes its protected surface. */
export const assertSystemApplicationSurfaceUnchanged = (previous: Json, next: Json): void => {
  const sentence = systemApplicationSurfaceViolation(previous, next);
  if (sentence !== null)
    throw new DefinitionError("DEFINITION_SYSTEM_SURFACE_CHANGED", { sentence });
};
