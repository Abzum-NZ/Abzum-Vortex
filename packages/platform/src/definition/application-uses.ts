import type { ApplicationSourceDocument } from "./application-source-contracts";
import { standardPermissionKeys } from "./module-field-shape";

/**
 * Where the parts of an Application draft are used: the one reference index of the draft. Studio's
 * "Used in" sections and every refusal that says "Show me where" read it, and so does every removal
 * that is refused while something still uses what it removes.
 *
 * The index is built once per draft source (a source is never changed in place: every edit makes a
 * new one) from every string the source holds, with its path and the property it sits in. A part
 * is used where its reference appears outside the part itself and outside what goes with it when it
 * is removed. Each use is named as a person knows it and says which item Studio opens to show it.
 */

type Source = ApplicationSourceDocument;

export type SourcePath = readonly (string | number)[];
type Path = SourcePath;
type Visit = (text: string, path: Path, key: string | undefined) => void;

/** Visits every string under a value with its path and the property it sits in. */
export const walkSourceStrings = (value: unknown, path: Path, visit: Visit, key?: string): void => {
  if (typeof value === "string") visit(value, path, key);
  else if (Array.isArray(value)) value.forEach((item, index) => walkSourceStrings(item, [...path, index], visit, key));
  else if (value !== null && typeof value === "object")
    for (const [childKey, child] of Object.entries(value)) walkSourceStrings(child, [...path, childKey], visit, childKey);
};

/**
 * The item Studio opens to show a place, named as a Studio selection names it (the application,
 * a page, layout, block, menu entry, flow or flow step, module, record type, field, query or role),
 * or nothing Studio can open.
 */
export type ApplicationPlaceOpen =
  | Readonly<{ kind: "application" }>
  | Readonly<{ kind: "page"; pageAlias: string }>
  | Readonly<{ kind: "shell"; shellAlias: string }>
  | Readonly<{ kind: "placement"; placementAlias: string }>
  | Readonly<{ kind: "navigation"; navigationItemAlias: string }>
  | Readonly<{ kind: "flow"; flowAlias: string; moduleKey: string | null }>
  | Readonly<{ kind: "flow_step"; flowAlias: string; moduleKey: string | null; taskId: string }>
  | Readonly<{ kind: "module"; moduleKey: string }>
  | Readonly<{ kind: "record_type"; moduleKey: string; recordKey: string }>
  | Readonly<{ kind: "field"; moduleKey: string; recordKey: string; fieldKey: string }>
  | Readonly<{ kind: "query"; moduleKey: string; queryKey: string }>
  | Readonly<{ kind: "role"; roleKey: string }>
  | Readonly<{ kind: "none" }>;

/**
 * One place that uses a part of the draft: its name for a person, the item that shows it and, for a
 * block or a flow step, what holds it ("page Contacts"), so Studio can name the block its own way.
 */
export type ApplicationUsePlace = Readonly<{ label: string; open: ApplicationPlaceOpen; within?: string }>;

/** A part of the draft that other parts can use. */
export type ApplicationUseTarget =
  | Readonly<{ kind: "record_type"; moduleKey: string; recordKey: string }>
  | Readonly<{ kind: "field"; moduleKey: string; recordKey: string; fieldKey: string }>
  | Readonly<{ kind: "query"; moduleKey: string; queryKey: string }>
  | Readonly<{ kind: "flow"; flowAlias: string; moduleKey: string | null }>
  | Readonly<{ kind: "action"; moduleKey: string; actionKey: string }>
  | Readonly<{ kind: "permission"; permissionKey: string }>
  | Readonly<{ kind: "page"; pageAlias: string }>
  | Readonly<{ kind: "navigation"; navigationItemAlias: string }>
  /** One option of a choice field, such as a pipeline stage. */
  | Readonly<{ kind: "choice_option"; moduleKey: string; recordKey: string; fieldKey: string; option: string }>
  /** A pipeline of a record type, which the boards over its choice field show. */
  | Readonly<{ kind: "pipeline"; moduleKey: string; recordKey: string; pipelineKey: string }>;

// ---------------------------------------------------------------------------------------------
// Naming a place.
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const at = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>((node, segment) => (node as Record<string | number, unknown> | undefined)?.[segment], value);
const quoted = (name: string) => `“${name}”`;

/** The innermost block (a Puck item with an id) along a path under a page or layout. */
const blockAlong = (root: unknown, rest: Path): string | undefined => {
  let node = root;
  let found: string | undefined;
  for (const segment of rest) {
    node = (node as Record<string | number, unknown> | undefined)?.[segment];
    if (isObject(node) && typeof node.type === "string" && isObject(node.props) && typeof node.props.id === "string")
      found = node.props.id;
  }
  return found;
};

const taskLists: ReadonlySet<string | number> = new Set(["tasks", "then", "else", "default", "errors", "finally"]);

/** The innermost task along a path under a flow, by its id. */
const taskAlong = (flow: unknown, rest: Path): string | undefined => {
  let node = flow;
  let found: string | undefined;
  rest.forEach((segment, index) => {
    node = (node as Record<string | number, unknown> | undefined)?.[segment];
    const container = rest[index - 1];
    const inList = typeof segment === "number" && container !== undefined &&
      (taskLists.has(container) || (typeof container === "number" && rest[index - 2] === "branches"));
    if (inList && isObject(node) && typeof node.id === "string" && typeof node.type === "string") found = node.id;
  });
  return found;
};

const navigationAt = (source: Source, path: Path): { id?: string; label?: string } | undefined => {
  let node: unknown = source.body.navigation;
  let found: { id?: string; label?: string } | undefined;
  for (let index = 2; index < path.length; index += 1) {
    const segment = path[index]!;
    node = (node as Record<string | number, unknown> | undefined)?.[segment];
    if (typeof segment === "number" && isObject(node)) found = node as { id?: string; label?: string };
  }
  return found;
};

const flowPlace = (flow: Json, rest: Path, name: string, moduleKey: string | null): ApplicationUsePlace => {
  const flowAlias = String(flow.id ?? "");
  const taskId = taskAlong(flow, rest);
  return taskId === undefined ? { label: name, open: { kind: "flow", flowAlias, moduleKey } }
    : { label: `A step of ${name.charAt(0).toLowerCase()}${name.slice(1)}`, within: name.charAt(0).toLowerCase() + name.slice(1),
      open: { kind: "flow_step", flowAlias, moduleKey, taskId } };
};

/** The page or layout block, by its alias, that a form binding names. */
const placementPath = (source: Source, alias: string): Path | undefined => {
  let found: Path | undefined;
  for (const section of ["pages", "shells"] as const)
    walkSourceStrings(source.body[section], ["body", section], (text, path, key) => {
      if (found === undefined && key === "id" && text === alias && path[path.length - 2] === "props") found = path;
    });
  return found;
};

const areaWords: Readonly<Record<string, string>> = {
  interfaces: "An interface operation", public_addresses: "A public address", events: "A form event of the application",
  connection_bindings: "A connection of the application", search: "Search settings",
  experiences: "A page shown when another cannot be opened",
};

/** Names the place in the source a reference sits at, with what Studio opens to show it. */
export const describeSourcePlace = (source: Source, path: Path): ApplicationUsePlace => {
  const [, section, index] = path;
  const body = source.body;
  if (section === "modules" && typeof index === "number") {
    const module = body.modules[index]!;
    const [, , , part, partIndex, child, childIndex] = path;
    if (part === "record_types" && typeof partIndex === "number") {
      const record = module.record_types[partIndex]!;
      const recordOpen = { kind: "record_type", moduleKey: module.key, recordKey: record.key } as const;
      if (child === "pipelines" && typeof childIndex === "number")
        return { label: `Pipeline ${record.pipelines[childIndex]!.name} of ${record.name}`, open: recordOpen };
      const field = child === "fields" && typeof childIndex === "number" ? record.fields[childIndex]
        : child === "relationships" && typeof childIndex === "number"
          ? record.fields.find((item) => item.key === record.relationships[childIndex]?.from_field) : undefined;
      return field === undefined ? { label: `Record type ${record.name}`, open: recordOpen }
        : { label: `Field ${field.label} of ${record.name}`, open: { ...recordOpen, kind: "field", fieldKey: field.key } };
    }
    const item = typeof partIndex === "number" ? at(module, [part!, partIndex]) as Json | undefined : undefined;
    const itemName = typeof item?.label === "string" ? item.label : typeof item?.name === "string" ? item.name
      : typeof item?.key === "string" ? String(item.key).replace(`${module.key}.`, "").replace(/[._]+/g, " ") : "";
    const moduleOpen = { kind: "module", moduleKey: module.key } as const;
    switch (part) {
      case "queries":
        return { label: `Query ${itemName}`, open: { kind: "query", moduleKey: module.key, queryKey: String(item?.key ?? "") } };
      case "permissions": return { label: `Permission ${itemName} in ${module.name}`, open: { kind: "none" } };
      case "actions": return { label: `Action ${itemName} in ${module.name}`,
        open: typeof item?.record_type === "string" ? { kind: "record_type", moduleKey: module.key, recordKey: item.record_type } : moduleOpen };
      case "events": return { label: `Event ${itemName} in ${module.name}`, open: moduleOpen };
      case "flows": return item === undefined ? { label: `Module ${module.name}`, open: moduleOpen }
        : flowPlace(item, path.slice(5), `Rule or flow ${itemName} in ${module.name}`, module.key);
      case "extension_points": return { label: `Extension point ${itemName} in ${module.name}`, open: moduleOpen };
      case "sharing_conditions": return { label: `Sharing condition ${itemName} in ${module.name}`, open: moduleOpen };
      default: return { label: `Module ${module.name}`, open: moduleOpen };
    }
  }
  if ((section === "pages" || section === "shells") && typeof index === "number") {
    const owner = section === "pages" ? body.pages[index]! : body.shells[index]!;
    const within = `${section === "pages" ? "page" : "layout"} ${quoted(owner.name)}`;
    const block = blockAlong(owner, path.slice(3));
    if (block !== undefined) return { label: `A block on the ${within}`, within, open: { kind: "placement", placementAlias: block } };
    return section === "pages" ? { label: `Page ${owner.name}`, open: { kind: "page", pageAlias: owner.id } }
      : { label: `Layout ${owner.name}`, open: { kind: "shell", shellAlias: owner.id } };
  }
  if (section === "flows" && typeof index === "number") {
    const flow = body.flows[index]!;
    return flowPlace(flow as unknown as Json, path.slice(3),
      `Flow ${Object.values(flow.labels)[0] ?? flow.key.replaceAll("_", " ")}`, null);
  }
  if (section === "navigation") {
    const entry = navigationAt(source, path);
    return { label: `Menu entry ${entry?.label ?? ""}`.trim(),
      open: entry?.id === undefined ? { kind: "none" } : { kind: "navigation", navigationItemAlias: entry.id } };
  }
  if (section === "roles" && typeof index === "number") {
    const role = body.roles[index]!;
    return { label: path[3] === "home_page" ? `The start page of the role ${role.name}` : `Role ${role.name}`,
      open: { kind: "role", roleKey: role.key } };
  }
  if (section === "flow_bindings" && typeof index === "number") {
    const control = body.flow_bindings[index]?.control;
    const block = control === undefined ? undefined : placementPath(source, control);
    return block === undefined ? { label: "A form of the application", open: { kind: "none" } }
      : describeSourcePlace(source, block);
  }
  if (section === "home_page") return { label: "The application's home page", open: { kind: "application" } };
  if (section === "permissions" && typeof index === "number") return { label: `Permission ${body.permissions[index]!.label}`, open: { kind: "none" } };
  if (typeof section === "string" && areaWords[section] !== undefined) return { label: areaWords[section]!, open: { kind: "none" } };
  return { label: "An application setting", open: { kind: "none" } };
};

// ---------------------------------------------------------------------------------------------
// The index.
// ---------------------------------------------------------------------------------------------

type Occurrence = Readonly<{ path: Path; key: string | undefined }>;
type UseIndex = Readonly<{
  /** Every string of the source, with where it is. */
  strings: ReadonlyMap<string, readonly Occurrence[]>;
  /** The places found per target, as they are asked for. */
  uses: Map<string, readonly ApplicationUsePlace[]>;
}>;

const indexes = new WeakMap<Source, UseIndex>();
const indexOf = (source: Source): UseIndex => {
  const known = indexes.get(source);
  if (known !== undefined) return known;
  const strings = new Map<string, Occurrence[]>();
  walkSourceStrings(source, [], (text, path, key) => {
    const list = strings.get(text);
    if (list === undefined) strings.set(text, [{ path, key }]);
    else list.push({ path, key });
  });
  const built: UseIndex = { strings, uses: new Map() };
  indexes.set(source, built);
  return built;
};
const occurrences = (index: UseIndex, text: string): readonly Occurrence[] => index.strings.get(text) ?? [];

/** A stable key for a target. */
export const applicationUseTargetKey = (target: ApplicationUseTarget): string => {
  switch (target.kind) {
    case "record_type": return `record_type:${target.moduleKey}:${target.recordKey}`;
    case "field": return `field:${target.moduleKey}:${target.recordKey}.${target.fieldKey}`;
    case "query": return `query:${target.moduleKey}:${target.queryKey}`;
    case "flow": return `flow:${target.moduleKey ?? ""}:${target.flowAlias}`;
    case "action": return `action:${target.moduleKey}:${target.actionKey}`;
    case "permission": return `permission:${target.permissionKey}`;
    case "page": return `page:${target.pageAlias}`;
    case "navigation": return `navigation:${target.navigationItemAlias}`;
    case "choice_option": return `choice_option:${target.moduleKey}:${target.recordKey}.${target.fieldKey}=${target.option}`;
    case "pipeline": return `pipeline:${target.moduleKey}:${target.recordKey}.${target.pipelineKey}`;
  }
};

/** A use: where it sits, and the label it is named by when its place's own name says too little. */
type Use = Readonly<{ path: Path; label?: string }>;
const starts = (path: Path, prefix: Path): boolean => prefix.every((segment, index) => path[index] === segment);

const locate = (source: Source, moduleKey: string, recordKey?: string) => {
  const moduleIndex = source.body.modules.findIndex((module) => module.key === moduleKey);
  const module = source.body.modules[moduleIndex];
  const recordIndex = recordKey === undefined ? -1 : module?.record_types.findIndex((record) => record.key === recordKey) ?? -1;
  return { module, moduleIndex, record: module?.record_types[recordIndex], recordIndex };
};

// Record types --------------------------------------------------------------------------------

const localRecordProperties: ReadonlySet<string> = new Set(["record_type", "to_record_type", "to_record_types", "record_types"]);

/**
 * A record type is used by its qualified reference (`module:record`, or a field of it), and in an
 * owned Module also by its standard permissions, by its queries' references and, inside its own
 * Module, by its local key. It and its standard permissions (which go with it) do not count.
 */
const recordTypeUses = (source: Source, index: UseIndex, moduleKey: string, recordKey: string): Use[] => {
  const qualified = `${moduleKey}:${recordKey}`;
  const { module, moduleIndex, record, recordIndex } = locate(source, moduleKey, recordKey);
  const owned = module !== undefined && record !== undefined;
  const ownPermissions = owned ? standardPermissionKeys(moduleKey, recordKey) : new Set<string>();
  const ownPermissionIndexes = new Set(module?.permissions.flatMap((permission, at) => ownPermissions.has(permission.key) ? [at] : []) ?? []);
  const isOwn = (path: Path): boolean =>
    owned && path[1] === "modules" && path[2] === moduleIndex &&
    ((path[3] === "record_types" && path[4] === recordIndex) ||
      (path[3] === "permissions" && typeof path[4] === "number" && ownPermissionIndexes.has(path[4])));
  const texts = [qualified, ...[...index.strings.keys()].filter((text) => text.startsWith(`${qualified}.`))];
  if (owned) {
    texts.push(...ownPermissions);
    texts.push(...module.queries.filter((query) => query.record_type === recordKey || query.record_type === qualified)
      .map((query) => `${moduleKey}:${query.key}`));
  }
  const uses: Use[] = [];
  for (const text of texts)
    for (const { path } of occurrences(index, text)) {
      // Access groups list the standard permissions, which are removed with the record type.
      if (isOwn(path) || (path[1] === "roles" && ownPermissions.has(text))) continue;
      uses.push({ path });
    }
  if (owned)
    for (const { path, key } of occurrences(index, recordKey))
      if (path[1] === "modules" && path[2] === moduleIndex && key !== undefined && localRecordProperties.has(key) && !isOwn(path))
        uses.push({ path });
  return uses;
};

// Fields --------------------------------------------------------------------------------------

/** Properties whose string values name fields of the record type in scope by their local key. */
const fieldProperty = (key: string | undefined): boolean =>
  key !== undefined && (/^(?:.*_)?fields?$/u.test(key) || key === "select" || key === "group_by" ||
    key === "ownership_relationship" || key === "from_field");
/** Properties that put a component in a record type's scope. */
const scopeProperties: ReadonlySet<string> = new Set(["record_type", "recordTypeId", "record_types", "to_record_type", "to_record_types"]);

const componentScoped = (value: unknown, local: string | undefined, qualified: string): boolean => {
  let scoped = false;
  walkSourceStrings(value, [], (text, _path, key) => {
    if (key !== undefined && scopeProperties.has(key) && (text === qualified || (local !== undefined && text === local))) scoped = true;
  });
  return scoped;
};

/** Every object key under a value equal to `name`, inside a `values` or `field_values` map. */
const mapKeyPaths = (value: unknown, name: string, path: Path = [], parent?: string): Path[] => {
  if (Array.isArray(value)) return value.flatMap((item, index) => mapKeyPaths(item, name, [...path, index], parent));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...((parent === "values" || parent === "field_values") && key === name ? [[...path, key]] : []),
    ...mapKeyPaths(child, name, [...path, key], key),
  ]);
};

/**
 * A field is used by its qualified reference or alias anywhere (pages, menus, search, flows and
 * other modules) and, in an owned Module, by its local key in the components that work on its
 * record type (other fields' settings, queries, actions, rules and flows, non-standard permissions)
 * and by a total of another record type that adds it up. Being the title field counts. The field
 * itself, the relationship it declares and the standard permissions' field lists (which follow it)
 * do not.
 */
const fieldUses = (source: Source, index: UseIndex, moduleKey: string, recordKey: string, fieldKey: string): Use[] => {
  const qualifiedRecord = `${moduleKey}:${recordKey}`;
  const { module, moduleIndex, record, recordIndex } = locate(source, moduleKey, recordKey);
  const fieldIndex = record?.fields.findIndex((field) => field.key === fieldKey) ?? -1;
  const field = record?.fields[fieldIndex];
  if (module === undefined || record === undefined || field === undefined)
    return occurrences(index, `${qualifiedRecord}.${fieldKey}`).map(({ path }) => ({ path }));
  const qualifiedNames = [`${qualifiedRecord}.${fieldKey}`, field.id,
    ...record.relationships.filter((relationship) => relationship.from_field === fieldKey)
      .map((relationship) => `${qualifiedRecord}.${relationship.key}`)];
  const ownRelationshipIndexes = new Set(record.relationships.flatMap((relationship, at) =>
    relationship.from_field === fieldKey ? [at] : []));
  const standard = standardPermissionKeys(moduleKey, recordKey);
  const isSelf = (path: Path): boolean =>
    path[1] === "modules" && path[2] === moduleIndex && path[3] === "record_types" && path[4] === recordIndex &&
    ((path[5] === "fields" && path[6] === fieldIndex) ||
      (path[5] === "relationships" && typeof path[6] === "number" && ownRelationshipIndexes.has(path[6])));
  const isStandardPolicy = (path: Path): boolean =>
    path[1] === "modules" && path[2] === moduleIndex && path[3] === "permissions" && typeof path[4] === "number" &&
    standard.has(module.permissions[path[4]]!.key) && path[5] === "field_policy";
  const uses: Use[] = [];
  for (const text of qualifiedNames)
    for (const { path } of occurrences(index, text)) if (!isSelf(path)) uses.push({ path });
  // The local key, in the components that work on this record type.
  const scopes: Readonly<{ value: unknown; path: Path }>[] = [
    { value: record, path: ["body", "modules", moduleIndex, "record_types", recordIndex] },
    ...(["permissions", "actions", "events", "flows", "extension_points", "sharing_conditions", "queries"] as const)
      .flatMap((section) => (module[section] as unknown[]).flatMap((item, at) =>
        componentScoped(item, recordKey, qualifiedRecord) ? [{ value: item, path: ["body", "modules", moduleIndex, section, at] }] : [])),
    ...(["pages", "flows"] as const).flatMap((section) => (source.body[section] as unknown[]).flatMap((item, at) =>
      componentScoped(item, undefined, qualifiedRecord) ? [{ value: item, path: ["body", section, at] }] : [])),
    ...(source.body.search?.record_types ?? []).flatMap((item, at) =>
      componentScoped(item, undefined, qualifiedRecord) ? [{ value: item, path: ["body", "search", "record_types", at] }] : []),
  ];
  for (const scope of scopes) {
    for (const { path, key } of occurrences(index, fieldKey)) {
      if (!starts(path, scope.path) || !fieldProperty(key) || isSelf(path) || isStandardPolicy(path)) continue;
      uses.push(path[5] === "title_field" && path.length === 6
        ? { path, label: `${record.name} names each record by it (its title field)` } : { path });
    }
    for (const path of mapKeyPaths(scope.value, fieldKey, scope.path)) uses.push({ path });
  }
  // A total of another record type adds up this field of its related records.
  source.body.modules.forEach((other, otherIndex) => other.record_types.forEach((otherRecord, otherRecordIndex) =>
    otherRecord.fields.forEach((candidate, candidateIndex) => {
      const settings = candidate.settings as { relationship?: string; field?: string };
      if (candidate.type === "total" && settings.field === fieldKey && (otherIndex !== moduleIndex || otherRecordIndex !== recordIndex))
        uses.push({ path: ["body", "modules", otherIndex, "record_types", otherRecordIndex, "fields", candidateIndex] });
    })));
  return uses;
};

// Choice options and pipelines ----------------------------------------------------------------

/**
 * One option of a choice field is used by an action that owns or sets it, a flow step that saves it,
 * and a condition, filter or rule that compares the field with it, in the components that work on
 * the record type, and by another field's default, calculation or rule. The field's own options and
 * the record type's pipelines do not count; they go with the option.
 */
const choiceOptionUses = (source: Source, moduleKey: string, recordKey: string, fieldKey: string, option: string): Use[] => {
  const { module, moduleIndex, record, recordIndex } = locate(source, moduleKey, recordKey);
  if (module === undefined || record === undefined) return [];
  const qualified = `${moduleKey}:${recordKey}`;
  const uses: Use[] = [];
  // A node names the field when a field-ish property holds its key, or a values map is keyed by it.
  const namesField = (node: Json, parentKey: string | undefined): boolean =>
    node.field === fieldKey || node.sets_choice_field === fieldKey ||
    ((parentKey === "values" || parentKey === "entries" || parentKey === "field_values") && Object.hasOwn(node, fieldKey));
  const mentions = (value: unknown): boolean => {
    let hit = false;
    walkSourceStrings(value, [], (text) => { if (text === option) hit = true; });
    return hit;
  };
  // Inside a component of this record type, an object that names the field and, with its siblings,
  // holds the option uses it.
  const scan = (value: unknown, path: Path, parent: unknown, parentKey: string | undefined): void => {
    if (Array.isArray(value)) { value.forEach((item, at) => scan(item, [...path, at], value, parentKey)); return; }
    if (!isObject(value)) return;
    if (namesField(value, parentKey) && (mentions(value) || mentions(parent))) { uses.push({ path }); return; }
    for (const [key, child] of Object.entries(value)) scan(child, [...path, key], value, key);
  };
  const scoped = (value: unknown): boolean => {
    let inScope = false;
    walkSourceStrings(value, [], (text, _path, key) => {
      if ((key === "record_type" || key === "recordTypeId" || key === "record_types") && (text === qualified || text === recordKey))
        inScope = true;
    });
    return inScope;
  };
  for (const section of ["actions", "permissions", "queries", "flows", "sharing_conditions"] as const)
    (module[section] as unknown[]).forEach((item, at) => {
      if (scoped(item)) scan(item, ["body", "modules", moduleIndex, section, at], undefined, undefined);
    });
  for (const section of ["pages", "flows"] as const)
    (source.body[section] as unknown[]).forEach((item, at) => {
      if (scoped(item)) scan(item, ["body", section, at], undefined, undefined);
    });
  // The record type's own fields: a default, or a calculation or rule that compares the field.
  record.fields.forEach((field, at) => {
    const path: Path = ["body", "modules", moduleIndex, "record_types", recordIndex, "fields", at];
    if (field.key === fieldKey) { if (field.default === option) uses.push({ path }); return; }
    scan(field, path, undefined, undefined);
  });
  return uses;
};

/** A pipeline is used by every page or layout block that shows a board over its choice field. */
const pipelineUses = (source: Source, index: UseIndex, moduleKey: string, recordKey: string, pipelineKey: string): Use[] => {
  const pipeline = locate(source, moduleKey, recordKey).record?.pipelines.find((candidate) => candidate.key === pipelineKey);
  if (pipeline === undefined) return [];
  return occurrences(index, `${moduleKey}:${recordKey}.${pipeline.stage_field}`)
    .filter(({ path, key }) => key === "choice_field" && (path[1] === "pages" || path[1] === "shells")).map(({ path }) => ({ path }));
};

// Actions and permissions ---------------------------------------------------------------------

type FlowValueLike = Readonly<{ kind?: string; literal?: Readonly<{ value?: unknown }>; entries?: Readonly<Record<string, FlowValueLike>> }>;
const literalOf = (value: FlowValueLike | undefined): unknown => value?.kind === "literal" ? value.literal?.value : undefined;

/** Every task object under a flow that matches, with its path. */
const tasksUnder = (value: unknown, path: Path, matches: (task: Json) => boolean, into: Path[] = []): Path[] => {
  if (Array.isArray(value)) value.forEach((item, at) => tasksUnder(item, [...path, at], matches, into));
  else if (isObject(value)) {
    if (typeof value.type === "string" && matches(value)) into.push(path);
    for (const [key, child] of Object.entries(value)) tasksUnder(child, [...path, key], matches, into);
  }
  return into;
};

/**
 * A named action is used where its key or alias appears (a flow step that calls it, a block or board
 * that runs it), and by every flow step that saves the choice option it owns, which runs it. The
 * action, the permissions, the access groups and its record types' action lists (which go with it)
 * do not count.
 */
const actionUses = (source: Source, index: UseIndex, moduleKey: string, actionKey: string): Use[] => {
  const { module, moduleIndex } = locate(source, moduleKey);
  const actionIndex = module?.actions.findIndex((action) => action.key === actionKey) ?? -1;
  const action = module?.actions[actionIndex];
  if (module === undefined || action === undefined) return [];
  const uses: Use[] = [];
  for (const text of new Set([actionKey, action.id]))
    for (const { path } of occurrences(index, text)) {
      if (path[1] === "roles") continue;
      if (path[1] === "modules" && path[2] === moduleIndex &&
        ((path[3] === "actions" && path[4] === actionIndex) || path[3] === "permissions" ||
          (path[3] === "record_types" && path[5] === "custom_actions"))) continue;
      uses.push({ path });
    }
  if (action.sets_choice_field !== undefined && action.sets_choice_option !== undefined) {
    const field = action.sets_choice_field;
    const option = action.sets_choice_option;
    const qualified = `${moduleKey}:${action.record_type}`;
    const saves = (task: Json): boolean => {
      const properties = task.properties as Readonly<Record<string, FlowValueLike>> | undefined;
      const values = properties?.values;
      return task.type === "record.save" && literalOf(properties?.record_type) === qualified &&
        values?.kind === "map" && literalOf(values.entries?.[field]) === option;
    };
    source.body.flows.forEach((flow, at) => uses.push(...tasksUnder(flow, ["body", "flows", at], saves).map((path) => ({ path }))));
    source.body.modules.forEach((owner, ownerIndex) => owner.flows.forEach((flow, at) =>
      uses.push(...tasksUnder(flow, ["body", "modules", ownerIndex, "flows", at], saves).map((path) => ({ path })))));
  }
  return uses;
};

/**
 * A permission is used where a permission setting names it: an access group that holds it, a page
 * or menu entry it opens, a block shown with it, an action it gates. Its own declaration does not count.
 */
const permissionUses = (index: UseIndex, permissionKey: string): Use[] =>
  occurrences(index, permissionKey).filter(({ key }) => key?.includes("permission") === true).map(({ path }) => ({ path }));

// Pages, menu entries and flows ---------------------------------------------------------------

/** Uses by one of several names, outside the item's own declaration and outside other items' own key or id. */
const namedUses = (index: UseIndex, names: readonly string[], own: Path | undefined): Use[] =>
  [...new Set(names)].flatMap((name) => occurrences(index, name)
    .filter(({ path, key }) => key !== "id" && key !== "key" && !fieldProperty(key) && !scopeProperties.has(key ?? "") &&
      (own === undefined || !starts(path, own)))
    .map(({ path }) => ({ path })));

/** A page is used by its key or alias: the menu entries that open it, the roles that start on it, links and the application's home. */
const pageUses = (source: Source, index: UseIndex, pageAlias: string): Use[] => {
  const pageIndex = source.body.pages.findIndex((page) => page.id === pageAlias);
  const page = source.body.pages[pageIndex];
  if (page === undefined) return [];
  const own: Path = ["body", "pages", pageIndex];
  // A flow step opens a page by a literal that may name its application too (`application:page`).
  const qualified = [...index.strings.keys()].filter((text) => text.endsWith(`:${page.key}`)).flatMap((text) =>
    occurrences(index, text).filter(({ path, key }) => key === "value" && !starts(path, own)).map(({ path }) => ({ path })));
  return [...namedUses(index, [page.key, page.id], own), ...qualified];
};

/** A flow is used by its key or alias: the forms and buttons bound to it, and the steps and actions that start it. */
const flowUses = (source: Source, index: UseIndex, flowAlias: string, moduleKey: string | null): Use[] => {
  const moduleIndex = moduleKey === null ? -1 : source.body.modules.findIndex((module) => module.key === moduleKey);
  const owner = moduleKey === null ? source.body.flows : source.body.modules[moduleIndex]?.flows ?? [];
  const flowIndex = owner.findIndex((flow) => flow.id === flowAlias);
  const flow = owner[flowIndex];
  if (flow === undefined) return [];
  const own: Path = moduleKey === null ? ["body", "flows", flowIndex] : ["body", "modules", moduleIndex, "flows", flowIndex];
  return namedUses(index, [flow.key, flow.id], own);
};

/** A menu entry is used where its alias appears outside the entry itself. */
const navigationUses = (index: UseIndex, alias: string): Use[] => namedUses(index, [alias], undefined);

/** A query is used where its qualified reference (`module:query`) appears outside the query itself. */
const queryUses = (source: Source, index: UseIndex, moduleKey: string, queryKey: string): Use[] => {
  const { module, moduleIndex } = locate(source, moduleKey);
  const queryIndex = module?.queries.findIndex((query) => query.key === queryKey) ?? -1;
  return occurrences(index, `${moduleKey}:${queryKey}`)
    .filter(({ path }) => !(queryIndex >= 0 && starts(path, ["body", "modules", moduleIndex, "queries", queryIndex])))
    .map(({ path }) => ({ path }));
};

const usesOf = (source: Source, index: UseIndex, target: ApplicationUseTarget): Use[] => {
  switch (target.kind) {
    case "record_type": return recordTypeUses(source, index, target.moduleKey, target.recordKey);
    case "field": return fieldUses(source, index, target.moduleKey, target.recordKey, target.fieldKey);
    case "query": return queryUses(source, index, target.moduleKey, target.queryKey);
    case "flow": return flowUses(source, index, target.flowAlias, target.moduleKey);
    case "action": return actionUses(source, index, target.moduleKey, target.actionKey);
    case "permission": return permissionUses(index, target.permissionKey);
    case "page": return pageUses(source, index, target.pageAlias);
    case "navigation": return navigationUses(index, target.navigationItemAlias);
    case "choice_option": return choiceOptionUses(source, target.moduleKey, target.recordKey, target.fieldKey, target.option);
    case "pipeline": return pipelineUses(source, index, target.moduleKey, target.recordKey, target.pipelineKey);
  }
};

const placesOf = (source: Source, uses: readonly Use[]): readonly ApplicationUsePlace[] => {
  const found = new Map<string, ApplicationUsePlace>();
  for (const use of uses) {
    const place = describeSourcePlace(source, use.path);
    const named = use.label === undefined ? place : { ...place, label: use.label };
    // One entry per place a person can tell apart; two blocks on one page are two places.
    const identity = `${named.label}\u0000${JSON.stringify(named.open)}`;
    if (!found.has(identity)) found.set(identity, Object.freeze(named));
  }
  return Object.freeze([...found.values()]);
};

/**
 * Every place in the draft that uses a target, each once, in source order. `except` leaves out uses
 * at paths that a particular change takes away with it (for example an action's own permission
 * leaving with the action that held it).
 */
export const applicationUses = (
  source: Source, target: ApplicationUseTarget, except?: (path: SourcePath) => boolean,
): readonly ApplicationUsePlace[] => {
  const index = indexOf(source);
  if (except !== undefined) return placesOf(source, usesOf(source, index, target).filter((use) => !except(use.path)));
  const key = applicationUseTargetKey(target);
  const known = index.uses.get(key);
  if (known !== undefined) return known;
  const places = placesOf(source, usesOf(source, index, target));
  index.uses.set(key, places);
  return places;
};

