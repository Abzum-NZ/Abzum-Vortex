import { canonicalJson } from "./canonical-json";
import { DefinitionError } from "./definition-error";

/**
 * What a person holding `system_applications.manage` may change in a platform system application
 * (architecture decision 11), as an allow-list. A release is compared with the release it follows.
 * Everything is compared as it is, ids by their lower-case form, except:
 *
 * - free: the application's name, description, icon and theme, a module's name and description,
 *   flows, bindings and actions that are not protected, and the cosmetic positions named below
 *   (descriptions, the title, message and details of a result message, the label of a message
 *   action, page text, record type and field labels);
 * - additive: pages, menu entries (page, heading and external), queries, events and platform block
 *   dependencies may be added, never removed or changed.
 *
 * A flow is protected when it calls a protected operation, or names a protected flow (a run, a
 * message action or a back-end run), to a fixpoint. The name of a protected action and the wording
 * of its confirmation, verification and guided steps are the platform's: only the text of a result
 * message is free. A binding is protected when it starts a protected flow or sits on a control
 * that does (the page runs the first binding of an event). A page is the steward's when it holds
 * the control of a protected binding: it is compared as it is, apart from its text. Content nested
 * deeper than the comparison bounds is refused. A number beyond 2^53 cannot be told apart from its
 * neighbour once parsed; the database comparison, which is the gate, refuses that change.
 * `vortex_definition.system_application_surface_violation` makes the same comparison, with the
 * same sentences, inside the publish transaction.
 */

type Json = unknown;
type SurfaceKind =
  | "flow"
  | "flow_binding"
  | "action_operation"
  | "record_type"
  | "permission"
  | "role"
  | "page"
  | "page_content"
  | "navigation"
  | "query"
  | "event"
  | "block_dependency"
  | "setting"
  | "module_setting"
  | "module_binding";
type SurfaceEntry = Readonly<{
  kind: SurfaceKind;
  ident: string;
  block: string;
  detail: Json;
  /** Nested deeper than the comparison bounds. */
  deep?: boolean;
}>;

/** The kinds that may be added to; every other kind is compared as it is. */
const additiveKinds: ReadonlySet<SurfaceKind> = new Set([
  "page",
  "navigation",
  "query",
  "event",
  "block_dependency",
]);

const maximumDepth = 64;
/** A flow nested deeper than this cannot be told from one past the task bound: it is refused. */
const maximumFlowLevels = 129;
const deepMarker = "__too_deeply_nested__";

const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: Json): Record<string, Json>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const text = (value: Json): string => (typeof value === "string" ? value : "");
const lower = (value: Json): string => text(value).toLowerCase();
const named = (value: string): string => (value === "" ? "(unnamed)" : value);
const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const without = (value: Json, ...keys: string[]): Json =>
  isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
    : value;

/** An array of objects as a set: its elements in one fixed order, so a reorder is no change. */
const asSet = (value: Json): Json =>
  Array.isArray(value) && value.every(isRecord)
    ? [...value].sort((left, right) => order(canonicalJson(left), canonicalJson(right)))
    : value;

const callsProtectedOperation = (value: Json): boolean =>
  Array.isArray(value)
    ? value.some(callsProtectedOperation)
    : isRecord(value) &&
      (value.type === "operation.call" || Object.values(value).some(callsProtectedOperation));

/** A result message's text; the wording of a confirmation or verification is the platform's. */
const messageText = ["title", "message", "details"];

/** The levels below the root of the deepest item, stopping at the bound. */
const levelsBelow = (root: Json): number => {
  let deepest = 0;
  const stack: [Json, number][] = [[root, 0]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [value, level] = item;
    if (level > deepest) deepest = level;
    if (level >= maximumFlowLevels) return level;
    if (Array.isArray(value)) for (const child of value) stack.push([child, level + 1]);
    else if (isRecord(value))
      for (const child of Object.values(value)) stack.push([child, level + 1]);
  }
  return deepest;
};

/** A task without its text: a result message's text and its message actions' labels, nested task lists included. */
const stripTask = (task: Json, depth: number): Json => {
  if (depth > maximumDepth) return deepMarker;
  if (!isRecord(task)) return task;
  const stripped: Record<string, Json> = Object.fromEntries(
    Object.entries(task).filter(([key]) => key !== "description"),
  );
  if (task.type === "interface.show_message" && isRecord(task.properties)) {
    const properties = without(task.properties, ...messageText) as Record<string, Json>;
    const actions = properties.actions;
    if (isRecord(actions) && actions.kind === "array" && Array.isArray(actions.items))
      properties.actions = {
        ...actions,
        items: actions.items.map((item) =>
          isRecord(item) && item.kind === "map" && isRecord(item.entries)
            ? { ...item, entries: without(item.entries, "label") }
            : item,
        ),
      };
    stripped.properties = properties;
  }
  for (const key of ["then", "else", "default", "tasks"])
    if (Array.isArray(stripped[key]))
      stripped[key] = (stripped[key] as Json[]).map((child) => stripTask(child, depth + 1));
  if (Array.isArray(stripped.cases))
    stripped.cases = (stripped.cases as Json[]).map((entry) =>
      isRecord(entry) && Array.isArray(entry.tasks)
        ? { ...entry, tasks: entry.tasks.map((child) => stripTask(child, depth + 1)) }
        : entry,
    );
  return stripped;
};

const stripFlow = (flow: Record<string, Json>): Json => {
  const stripped: Record<string, Json> = Object.fromEntries(
    Object.entries(flow).filter(([key]) => !["description", "refusal_feedback"].includes(key)),
  );
  for (const key of ["tasks", "errors", "finally"])
    if (Array.isArray(stripped[key]))
      stripped[key] = (stripped[key] as Json[]).map((task) => stripTask(task, 1));
  return stripped;
};

const pageText = ["title", "label", "text", "description", "placeholder", "helpText", "heading"];

/** A page or shell composition without the text properties of its typed blocks, except a protected control. */
const stripPageText = (value: Json, depth: number, controls: readonly string[]): Json => {
  if (depth > maximumDepth) return deepMarker;
  if (Array.isArray(value)) return value.map((item) => stripPageText(item, depth + 1, controls));
  if (!isRecord(value)) return value;
  const stripped: Record<string, Json> = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, stripPageText(item, depth + 1, controls)]),
  );
  // The text of a block is at known positions only: the properties of a typed block.
  if (
    typeof stripped.type === "string" &&
    isRecord(stripped.props) &&
    !controls.includes(lower(stripped.props.id))
  )
    stripped.props = without(stripped.props, ...pageText);
  return stripped;
};

const stripRecordType = (recordType: Record<string, Json>): Json => {
  const stripped: Record<string, Json> = Object.fromEntries(
    Object.entries(recordType).filter(
      ([key]) => !["singularLabel", "pluralLabel", "description"].includes(key),
    ),
  );
  if (Array.isArray(stripped.fields))
    stripped.fields = (stripped.fields as Json[]).map((field) =>
      without(field, "label", "description"),
    );
  return stripped;
};

/** Whether an entry other than a heading holds entries: the menu is then malformed. */
const menuMalformed = (value: Json): boolean =>
  records(value).some(
    (item) =>
      (item.type !== "heading" && item.children !== undefined) || menuMalformed(item.children),
  );

/** Every page, heading and external menu entry, with the heading each sits under ("root" at the top). */
const navigationEntries = (
  value: Json,
  parent: string,
): { item: Record<string, Json>; parent: string }[] =>
  records(value).flatMap((item) => [
    ...(item.type === "page" || item.type === "heading" || item.type === "external"
      ? [{ item, parent }]
      : []),
    ...navigationEntries(item.children, text(item.id) === "" ? parent : text(item.id)),
  ]);

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The ids (lower case) of the flows that are protected, to a fixpoint. */
const protectedFlowIds = (flows: Record<string, Json>[]): Set<string> => {
  const entries = flows.map((flow) => {
    const id = lower(flow.id);
    // The ids a flow's text names, once each: a run, a message action or a back-end run names its target.
    const text = JSON.stringify(flow).toLowerCase();
    return {
      flow,
      id,
      named: new Set((text.match(uuidPattern) ?? []).filter((name) => name !== id)),
    };
  });
  const found = new Set(
    entries.filter((entry) => callsProtectedOperation(entry.flow)).map((entry) => entry.id),
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of entries)
      if (!found.has(entry.id) && [...entry.named].some((name) => found.has(name))) {
        found.add(entry.id);
        changed = true;
      }
  }
  return found;
};

const applicationFree = ["name", "description", "icon", "theme"];
const applicationHandled = [
  "flows",
  "flowBindings",
  "actions",
  "pages",
  "navigation",
  "queries",
  "events",
  "platformBlockDependencies",
  "permissions",
  "roles",
  "moduleBindings",
];
const moduleFree = ["name", "description"];
const moduleHandled = ["recordTypes", "permissions", "actions", "flows", "queries", "events"];

const surfaceOf = (content: Json, kind: "application" | "module"): SurfaceEntry[] => {
  const body = isRecord(content) ? content : {};
  const entries: SurfaceEntry[] = [];
  const add = (entry: SurfaceEntry) => entries.push({ ...entry, block: named(entry.block) });
  const flows = records(body.flows);
  const protectedIds = protectedFlowIds(flows);
  const protectedFlows = flows.filter((flow) => protectedIds.has(lower(flow.id)));
  const flowKeys = new Map(flows.map((flow) => [lower(flow.id), text(flow.key)]));
  for (const flow of protectedFlows)
    add({
      kind: "flow",
      ident: lower(flow.id),
      block: text(flow.key),
      detail: stripFlow(flow),
      deep: levelsBelow(flow) >= maximumFlowLevels,
    });
  for (const action of records(body.actions))
    if (action.protectedOperation !== undefined)
      add({
        kind: "action_operation",
        ident: lower(action.key),
        block: text(action.key),
        detail: without(action, "label", "labels", "description"),
      });
  for (const permission of records(body.permissions))
    add({
      kind: "permission",
      ident: lower(permission.key),
      block: text(permission.key),
      detail: without(permission, "label", "description"),
    });
  for (const query of records(body.queries))
    add({
      kind: "query",
      ident: lower(query.queryId ?? query.id ?? query.key),
      block: text(query.key ?? query.name),
      detail: without(query, "name", "label", "description"),
    });
  for (const event of records(body.events))
    add({
      kind: "event",
      ident: lower(event.eventId ?? event.id ?? event.key),
      block: text(event.key ?? event.name),
      detail: without(event, "name", "label", "description"),
    });
  const settings = (
    free: string[],
    handled: string[],
    settingKind: SurfaceKind,
    protectedControls: readonly string[],
  ) => {
    for (const [key, value] of Object.entries(body))
      if (!free.includes(key) && !handled.includes(key))
        add({
          kind: settingKind,
          ident: key,
          block: key,
          detail:
            key === "shells" ? asSet(stripPageText(value, 1, protectedControls)) : asSet(value),
        });
  };
  if (kind === "module") {
    for (const recordType of records(body.recordTypes))
      add({
        kind: "record_type",
        ident: lower(recordType.recordTypeId),
        block: text(recordType.key),
        detail: stripRecordType(recordType),
      });
    settings(moduleFree, moduleHandled, "module_setting", []);
    return entries;
  }
  const flowBound = records(body.flowBindings).filter(
    (binding) => isRecord(binding.flow) && protectedIds.has(lower(binding.flow.flowId)),
  );
  const controls = flowBound.map((binding) => lower(binding.controlId)).filter((id) => id !== "");
  // Every binding on a protected control is protected: the page runs the first one of an event.
  const bindings = records(body.flowBindings).filter(
    (binding) => flowBound.includes(binding) || controls.includes(lower(binding.controlId)),
  );
  for (const binding of bindings) {
    const flow = isRecord(binding.flow) ? binding.flow : {};
    add({
      kind: "flow_binding",
      ident: lower(binding.bindingId),
      block: `${named(flowKeys.get(lower(flow.flowId)) ?? "")} (${text(binding.event)})`,
      detail: binding,
    });
  }
  const pages = records(body.pages);
  const pageKeys = new Map(pages.map((page) => [lower(page.pageId), text(page.key)]));
  for (const page of pages) {
    add({
      kind: "page",
      ident: lower(page.pageId),
      block: text(page.key),
      detail: {
        pageId: page.pageId ?? null,
        key: page.key ?? null,
        accessPermissionKey: page.accessPermissionKey ?? null,
      },
    });
    const serialized = JSON.stringify(page).toLowerCase();
    if (controls.some((control) => serialized.includes(control)))
      add({
        kind: "page_content",
        ident: lower(page.pageId),
        block: text(page.key),
        detail: stripPageText(without(page, "name"), 1, controls),
      });
  }
  for (const { item, parent } of navigationEntries(body.navigation, "root"))
    add({
      kind: "navigation",
      ident: lower(item.id),
      block: item.type === "page" ? text(pageKeys.get(lower(item.pageId))) : text(item.label),
      detail: {
        id: item.id ?? null,
        type: item.type,
        pageId: item.pageId ?? null,
        address: item.address ?? null,
        permissionKey: item.permissionKey ?? null,
        parent,
      },
    });
  for (const role of records(body.roles))
    add({
      kind: "role",
      ident: lower(role.key),
      block: text(role.key),
      detail: without(role, "name"),
    });
  for (const moduleBinding of records(body.moduleBindings))
    add({
      kind: "module_binding",
      ident: lower(moduleBinding.moduleRootId),
      block: text(moduleBinding.key),
      detail: moduleBinding,
    });
  for (const dependency of Array.isArray(body.platformBlockDependencies)
    ? body.platformBlockDependencies
    : []) {
    add({
      kind: "block_dependency",
      ident: canonicalJson(dependency).toLowerCase(),
      block: "",
      detail: dependency,
    });
  }
  settings(applicationFree, applicationHandled, "setting", controls);
  return entries;
};

const noun: Record<SurfaceKind, string> = {
  flow: "The protected flow",
  flow_binding: "The flow binding",
  action_operation: "The action",
  record_type: "The record type",
  permission: "The permission",
  role: "The role",
  page: "The page",
  page_content: "The page",
  navigation: "The menu entry",
  query: "The query",
  event: "The event",
  block_dependency: "The platform block",
  setting: "The application setting",
  module_setting: "The module setting",
  module_binding: "The module binding",
};

const tail = (kind: SurfaceKind): string => {
  switch (kind) {
    case "flow":
    case "flow_binding":
    case "action_operation":
      return "A platform application keeps its protected operations, and what feeds or starts them, as the platform gave them. Undo this change before publishing.";
    case "record_type":
    case "module_setting":
    case "query":
    case "event":
    case "block_dependency":
      return "A platform application's data definitions stay as the platform defines them. Undo this change before publishing.";
    default:
      return "The steward must always keep a working way to manage access, so these stay as the platform gave them. Undo this change before publishing.";
  }
};

type Problem = Readonly<{
  entry: SurfaceEntry;
  change: "removed" | "added" | "changed" | "twice" | "deep" | "malformed";
}>;

const problemsOf = (previous: SurfaceEntry[], next: SurfaceEntry[]): Problem[] => {
  const problems: Problem[] = [];
  const index = (entries: SurfaceEntry[]) => {
    const map = new Map<string, SurfaceEntry>();
    for (const entry of entries) {
      const key = `${entry.kind}\u0000${entry.ident}`;
      if (map.has(key)) problems.push({ entry, change: "twice" });
      else map.set(key, entry);
    }
    return map;
  };
  const before = index(previous);
  const after = index(next);
  for (const [key, entry] of before) {
    const other = after.get(key);
    if (other === undefined) problems.push({ entry, change: "removed" });
    else if (canonicalJson(other.detail) !== canonicalJson(entry.detail))
      problems.push({ entry, change: "changed" });
  }
  for (const [key, entry] of after)
    if (!before.has(key) && !additiveKinds.has(entry.kind))
      problems.push({ entry, change: "added" });
  for (const entry of next)
    if (entry.deep === true || canonicalJson(entry.detail).includes(deepMarker))
      problems.push({ entry, change: "deep" });
  return problems;
};

/**
 * The first change a release makes that is not on the allow-list, worded for the person publishing
 * and naming the block it is about, or null when it makes none. Without a previous release every
 * protected entry is an addition.
 */
const systemApplicationSurfaceViolation = (
  previous: Json,
  next: Json,
  kind: "application" | "module",
): string | null => {
  if (canonicalJson(previous ?? null) === canonicalJson(next ?? null)) return null;
  // A change only to what is free at the top changes nothing on the surface.
  const free = kind === "module" ? moduleFree : applicationFree;
  if (
    isRecord(previous) &&
    isRecord(next) &&
    canonicalJson(without(previous, ...free)) === canonicalJson(without(next, ...free))
  )
    return null;
  const problems = problemsOf(surfaceOf(previous, kind), surfaceOf(next, kind));
  if (kind === "application" && isRecord(next) && menuMalformed(next.navigation))
    problems.push({
      entry: { kind: "navigation", ident: "(menu)", block: "(menu)", detail: null },
      change: "malformed",
    });
  problems.sort(
    (left, right) =>
      order(left.entry.kind, right.entry.kind) ||
      order(left.entry.block, right.entry.block) ||
      order(left.entry.ident, right.entry.ident) ||
      order(left.change, right.change),
  );
  const first = problems[0];
  if (first === undefined) return null;
  const verb =
    first.change === "twice"
      ? "appears twice"
      : first.change === "malformed"
        ? "is malformed"
        : first.change === "deep"
          ? "is nested too deeply to compare"
          : `would ${first.change === "removed" ? "be removed" : first.change === "added" ? "be added" : first.entry.kind === "page_content" ? "change what it shows" : "change"}`;
  return `${noun[first.entry.kind]} "${first.entry.block}" ${verb}. ${tail(first.entry.kind)}`;
};

/** The history of one definition the comparison reads: its latest release and whether it was of an earlier contract. */
type BaselineHistory = Readonly<{
  latestRelease: Readonly<{ content: unknown }> | null;
  supersededReleaseVersion: string | null;
}>;

/** Compares a release with the one it follows; a release of an earlier definition contract is refused with the refresh sentence. */
export const assertSystemApplicationBaseline = (
  history: BaselineHistory,
  next: Json,
  kind: "application" | "module",
): void => {
  if (history.supersededReleaseVersion !== null)
    throw new DefinitionError("DEFINITION_SYSTEM_SURFACE_CHANGED", {
      sentence:
        "This platform application has not been refreshed for the current definition format yet. Publish it again after the platform refresh.",
    });
  assertSystemApplicationSurfaceUnchanged(history.latestRelease?.content ?? null, next, kind);
};

/** Refuses a release of a platform system application that changes more than the allow-list. */
const assertSystemApplicationSurfaceUnchanged = (
  previous: Json,
  next: Json,
  kind: "application" | "module",
): void => {
  const sentence = systemApplicationSurfaceViolation(previous, next, kind);
  if (sentence !== null)
    throw new DefinitionError("DEFINITION_SYSTEM_SURFACE_CHANGED", { sentence });
};
