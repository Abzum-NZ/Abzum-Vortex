import { canonicalJson } from "./canonical-json";
import { DefinitionError } from "./definition-error";

/**
 * The part of a platform system application that people holding `system_applications.manage` can
 * never change (architecture decision 11): the protected platform operations and everything that
 * feeds or triggers them, the shape of its system projections, the permissions and roles it gives,
 * and the pages and navigation through which the organisation's steward keeps a working way to
 * manage access. A release is compared with the release it follows;
 * `vortex_definition.system_application_surface_violation` makes the same comparison, with the same
 * sentences, inside the publish transaction. Labels, descriptions and messages stay free.
 */

type Json = unknown;
type SurfaceKind =
  | "flow"
  | "flow_binding"
  | "action_operation"
  | "system_projection"
  | "permission"
  | "role"
  | "page"
  | "navigation";
type SurfaceEntry = Readonly<{ kind: SurfaceKind; ident: string; block: string; detail: Json }>;

const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: Json): Record<string, Json>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const text = (value: Json): string => (typeof value === "string" ? value : "");

/** Whether a flow, nested task lists included, has a task that calls a protected operation. */
const callsProtectedOperation = (value: Json): boolean =>
  Array.isArray(value)
    ? value.some(callsProtectedOperation)
    : isRecord(value) &&
      (value.type === "operation.call" || Object.values(value).some(callsProtectedOperation));

/** The value without the named presentation keys and, when asked, without interface steps. */
const strip = (value: Json, keys: readonly string[], dropInterface: boolean): Json => {
  if (Array.isArray(value))
    return value
      .filter(
        (item) => !(dropInterface && isRecord(item) && text(item.type).startsWith("interface.")),
      )
      .map((item) => strip(item, keys, dropInterface));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !keys.includes(key))
      .map(([key, item]) => [key, strip(item, keys, dropInterface)]),
  );
};

const flowPresentation = ["labels", "description", "refusal_feedback"] as const;
const namePresentation = [
  "label",
  "labels",
  "description",
  "singularLabel",
  "pluralLabel",
] as const;

/** Every page-type navigation entry, headings' children included. */
const navigationPages = (value: Json): Record<string, Json>[] =>
  records(value).flatMap((item) => [
    ...(item.type === "page" ? [item] : []),
    ...navigationPages(item.children),
  ]);

const surfaceOf = (content: Json, withScreens: boolean): SurfaceEntry[] => {
  const body = isRecord(content) ? content : {};
  const entries: SurfaceEntry[] = [];
  const protectedFlows = records(body.flows).filter(callsProtectedOperation);
  const protectedFlowIds = new Set(protectedFlows.map((flow) => text(flow.id)));
  for (const flow of protectedFlows)
    entries.push({
      kind: "flow",
      ident: text(flow.id),
      block: text(flow.key),
      detail: strip(flow, flowPresentation, true),
    });
  for (const binding of records(body.flowBindings))
    if (isRecord(binding.flow) && protectedFlowIds.has(text(binding.flow.flowId)))
      entries.push({
        kind: "flow_binding",
        ident: text(binding.bindingId),
        block: text(binding.bindingId),
        detail: binding,
      });
  for (const action of records(body.actions))
    if (action.protectedOperation !== undefined)
      entries.push({
        kind: "action_operation",
        ident: text(action.key),
        block: text(action.key),
        detail: strip(action, namePresentation, false),
      });
  for (const recordType of records(body.recordTypes))
    if (recordType.systemProjection !== undefined)
      entries.push({
        kind: "system_projection",
        ident: text(recordType.key),
        block: text(recordType.key),
        detail: strip(recordType, namePresentation, false),
      });
  for (const permission of records(body.permissions))
    entries.push({
      kind: "permission",
      ident: text(permission.key),
      block: text(permission.key),
      detail: strip(permission, ["label", "description"], false),
    });
  for (const role of records(body.roles))
    entries.push({
      kind: "role",
      ident: text(role.key),
      block: text(role.key),
      detail: strip(role, ["name"], false),
    });
  // The steward's screens: where the release before has something protected, no page or page
  // entry of the menu goes away or changes the permission that opens it.
  if (withScreens) {
    for (const page of records(body.pages))
      entries.push({
        kind: "page",
        ident: text(page.pageId),
        block: text(page.key),
        detail: {
          pageId: page.pageId,
          key: page.key,
          accessPermissionKey: page.accessPermissionKey,
        },
      });
    for (const item of navigationPages(body.navigation))
      entries.push({
        kind: "navigation",
        ident: text(item.id),
        block: text(item.id),
        detail: { id: item.id, pageId: item.pageId, permissionKey: item.permissionKey },
      });
  }
  return entries;
};

const noun: Record<SurfaceKind, string> = {
  flow: "The protected flow",
  flow_binding: "The flow binding",
  action_operation: "The action",
  system_projection: "The platform data view",
  permission: "The permission",
  role: "The role",
  page: "The page",
  navigation: "The menu entry",
};

const tail = (kind: SurfaceKind): string => {
  switch (kind) {
    case "flow":
    case "flow_binding":
    case "action_operation":
      return "A platform application keeps the protected operations the platform gave it, with what feeds and triggers them, so undo this change before publishing.";
    case "system_projection":
      return "A platform data view stays exactly as the platform defines it, so undo this change before publishing.";
    default:
      return "The organisation's steward must always keep a working way to manage access, so a platform application keeps the permissions, roles, pages and menu entries the platform gave it. Undo this change before publishing.";
  }
};

/**
 * The first change a release makes to the protected surface of the release it follows, worded for
 * the person publishing and naming the block or binding it is about, or null when it makes none.
 * Without a previous release every protected entry is an addition.
 */
const systemApplicationSurfaceViolation = (previous: Json, next: Json): string | null => {
  const protectedPresent = surfaceOf(previous, false).some((entry) =>
    ["flow", "action_operation", "system_projection"].includes(entry.kind),
  );
  const previousEntries = surfaceOf(previous, protectedPresent);
  const id = (entry: SurfaceEntry) => `${entry.kind}\u0000${entry.ident}`;
  const before = new Map(previousEntries.map((entry) => [id(entry), entry]));
  const after = new Map(surfaceOf(next, protectedPresent).map((entry) => [id(entry), entry]));
  const problems: { entry: SurfaceEntry; state: "removed" | "added" | "changed" }[] = [];
  for (const [key, entry] of before) {
    const other = after.get(key);
    if (other === undefined) problems.push({ entry, state: "removed" });
    else if (canonicalJson(other.detail) !== canonicalJson(entry.detail))
      problems.push({ entry, state: "changed" });
  }
  for (const [key, entry] of after) if (!before.has(key)) problems.push({ entry, state: "added" });
  const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  problems.sort(
    (left, right) =>
      order(left.entry.kind, right.entry.kind) ||
      order(left.entry.block, right.entry.block) ||
      order(left.entry.ident, right.entry.ident),
  );
  const first = problems[0];
  return first === undefined
    ? null
    : `${noun[first.entry.kind]} "${first.entry.block}" would ${first.state === "removed" ? "be removed" : first.state === "added" ? "be added" : "change"}. ${tail(first.entry.kind)}`;
};

/** Refuses a release of a platform system application that changes its protected surface. */
export const assertSystemApplicationSurfaceUnchanged = (previous: Json, next: Json): void => {
  const sentence = systemApplicationSurfaceViolation(previous, next);
  if (sentence !== null)
    throw new DefinitionError("DEFINITION_SYSTEM_SURFACE_CHANGED", { sentence });
};
