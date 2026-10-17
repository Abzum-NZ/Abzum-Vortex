import {
  applicationSourceDocumentSchema, builderKeySchema, changeableByPeople, standardPermissionKeys,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import { tokenName } from "./studio-words";

/**
 * The Access tab's model and edits of the application draft: its roles (access groups), what each
 * role holds, which fields a role reads and changes, and which permission opens each page and menu
 * entry. The data has one home in the source: a role's `permissions`, a permission's field policy,
 * a page's and a menu entry's `permission`. Structure and Menu show those values; this is the one
 * place that changes them. Every edit is applied to a copy of the draft and judged by the source
 * schema before it reaches the draft history; a refusal says why, and for something still in use it
 * lists where, so the builder can go there.
 */

type Source = ApplicationSourceDocument;
type Body = Source["body"];
type Role = Body["roles"][number];
type Module = Body["modules"][number];
type RecordType = Module["record_types"][number];
type ModulePermission = Module["permissions"][number];
type ApplicationPermission = Body["permissions"][number];
type Navigation = Body["navigation"][number];

/** The record actions the role matrix has a column for. */
export const studioAccessColumns = [
  { kind: "read", label: "Read" },
  { kind: "create", label: "Create" },
  { kind: "update", label: "Update" },
  { kind: "delete", label: "Delete" },
] as const;
export type StudioAccessColumn = (typeof studioAccessColumns)[number]["kind"];

/** One permission the draft declares: the application's own, or one of a Module it owns. */
export type StudioAccessPermission = Readonly<{
  key: string;
  label: string;
  description: string;
  /** The owning Module's key; absent for the application's own permissions. */
  moduleKey: string | undefined;
  recordKey: string | undefined;
  actionKind: string;
  administrative: boolean;
  /** One of the permissions a record type is created with, which goes only with its record type. */
  standard: boolean;
}>;

/** Somewhere the draft names a role or a permission, for "Show me where". */
export type StudioAccessPlace =
  | Readonly<{ kind: "role"; roleKey: string; label: string }>
  | Readonly<{ kind: "page"; pageAlias: string; label: string }>
  | Readonly<{ kind: "navigation"; alias: string; label: string }>
  | Readonly<{ kind: "placement"; placementAlias: string; label: string }>
  | Readonly<{ kind: "data"; moduleKey: string; label: string }>
  | Readonly<{ kind: "other"; label: string }>;

export type StudioAccessGate = Readonly<{ kind: "existing"; key: string } | { kind: "new"; label: string }>;

export type StudioAccessCommand =
  | Readonly<{ kind: "add_role"; name: string }>
  | Readonly<{ kind: "rename_role"; roleKey: string; name: string }>
  | Readonly<{ kind: "remove_role"; roleKey: string }>
  /** Makes a role the application's one default member role: the role a first install offers the installer. */
  | Readonly<{ kind: "set_default_member"; roleKey: string }>
  | Readonly<{ kind: "set_role_home_page"; roleKey: string; pageKey: string }>
  | Readonly<{ kind: "grant"; roleKey: string; permissionKey: string; granted: boolean }>
  /** A role holding every application permission is changed to hold them one by one, as the compiled draft grants them. */
  | Readonly<{ kind: "list_role_permissions"; roleKey: string; permissionKeys: readonly string[] }>
  | Readonly<{ kind: "set_field_access"; roleKey: string; moduleKey: string; recordKey: string; fieldKey: string;
      readable: boolean; changeable: boolean }>
  | Readonly<{ kind: "add_permission"; label: string }>
  | Readonly<{ kind: "remove_permission"; permissionKey: string }>
  | Readonly<{ kind: "set_page_gate"; pageAlias: string; gate: StudioAccessGate }>
  | Readonly<{ kind: "set_menu_gate"; alias: string; gate: StudioAccessGate }>;

export type StudioAccessResult =
  | Readonly<{ kind: "applied"; source: Source; message: string; roleKey?: string | undefined }>
  | Readonly<{ kind: "refused"; message: string; where?: readonly StudioAccessPlace[] }>;

class AccessRefusal extends Error {
  constructor(message: string, readonly where?: readonly StudioAccessPlace[]) { super(message); }
}
const refuse = (message: string, where?: readonly StudioAccessPlace[]): never => { throw new AccessRefusal(message, where); };
const quoted = (name: string) => `“${name}”`;
const labelLimit = 60;

const cleanLabel = (name: string, what: string): string => {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) refuse(`Give the ${what} a name.`);
  if (trimmed.length > labelLimit) refuse(`A ${what} name can be at most ${labelLimit} characters.`);
  return trimmed;
};

/** A key from a name, unique among `taken`: lowercase words joined by underscores, at most 40 characters. */
const uniqueKey = (name: string, taken: ReadonlySet<string>): string => {
  const words = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const stem = (/^[a-z]/.test(words) ? words : `item_${words}`).slice(0, 40).replace(/_+$/g, "") || "item";
  let key = stem;
  for (let suffix = 2; taken.has(key); suffix += 1) {
    const ending = `_${suffix}`;
    key = `${stem.slice(0, 40 - ending.length).replace(/_+$/g, "")}${ending}`;
  }
  return key;
};

/** Every alias the draft's roles and permissions use, so a new one never repeats one. */
const takenAliases = (body: Body): Set<string> => new Set([
  ...body.roles.map((role) => role.id), ...body.permissions.map((permission) => permission.id),
  ...body.modules.flatMap((module) => module.permissions.map((permission) => permission.id)),
]);
const uniqueAlias = (base: string, taken: Set<string>): string => {
  let alias = base.slice(0, 160);
  for (let suffix = 2; taken.has(alias); suffix += 1) alias = `${base.slice(0, 150)}_${suffix}`;
  taken.add(alias);
  return alias;
};

/** Every permission the draft declares, the application's first. */
export const studioAccessPermissions = (source: Source): readonly StudioAccessPermission[] => [
  ...source.body.permissions.map((permission): StudioAccessPermission => ({
    key: permission.key, label: permission.label, description: permission.description, moduleKey: undefined,
    recordKey: permission.record_type, actionKind: permission.action_kind, administrative: permission.administrative,
    standard: false,
  })),
  ...source.body.modules.flatMap((module) => {
    const standard = new Set(module.record_types.flatMap((record) => [...standardPermissionKeys(module.key, record.key)]));
    return module.permissions.map((permission): StudioAccessPermission => ({
      key: permission.key, label: permission.label, description: permission.description, moduleKey: module.key,
      recordKey: permission.record_type, actionKind: permission.action_kind, administrative: permission.administrative,
      standard: standard.has(permission.key),
    }));
  }),
];

/** Whether a role holds a key: unknown (`undefined`) for a role holding every permission, which only the compiler expands. */
export const studioRoleHolds = (role: Role, key: string): boolean | undefined =>
  role.permissions.includes("*") ? undefined : role.permissions.includes(key);

const holders = (body: Body, key: string): readonly Role[] =>
  body.roles.filter((role) => role.permissions.includes(key));

/** The permissions that can open a page or show a menu entry: the application's own named permissions. */
export const studioAccessGateChoices = (source: Source) =>
  source.body.permissions.filter((permission) => permission.action_kind === "named" && permission.record_type === undefined)
    .map((permission) => ({ key: permission.key, label: permission.label,
      roles: holders(source.body, permission.key).map((role) => role.name) }));

/** A record type of a Module the application owns, with its matrix cells for one role. */
export type StudioAccessRecordRow = Readonly<{
  moduleKey: string; recordKey: string; name: string;
  columns: Readonly<Record<StudioAccessColumn, readonly StudioAccessPermission[]>>;
  /** Its other permissions: restore, export, share, manage and its named actions. */
  more: readonly StudioAccessPermission[];
}>;

export const studioAccessRecordRows = (source: Source): readonly StudioAccessRecordRow[] => {
  const permissions = studioAccessPermissions(source);
  return source.body.modules.flatMap((module) => module.record_types.map((record): StudioAccessRecordRow => {
    const own = permissions.filter((permission) => permission.moduleKey === module.key && permission.recordKey === record.key);
    const columns = Object.fromEntries(studioAccessColumns.map(({ kind }) =>
      [kind, own.filter((permission) => permission.actionKind === kind)])) as Record<StudioAccessColumn, StudioAccessPermission[]>;
    return { moduleKey: module.key, recordKey: record.key, name: record.plural_name, columns,
      more: own.filter((permission) => !studioAccessColumns.some(({ kind }) => kind === permission.actionKind)) };
  }));
};

/** Where a menu entry and its page are, by page key. */
const menuEntries = (items: readonly Navigation[], into: Navigation[] = []): Navigation[] => {
  for (const item of items) {
    if (item.type === "heading") menuEntries(item.children, into);
    else into.push(item);
  }
  return into;
};
export const studioAccessMenuEntries = (source: Source) => menuEntries(source.body.navigation)
  .flatMap((entry) => entry.type === "heading" ? [] : [entry]);

// ---------------------------------------------------------------------------------------------
// Where a key is used.
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const areaWords: Readonly<Record<string, string>> = {
  pipelines: "A pipeline", interfaces: "An interface operation", flows: "A flow", search: "Search",
  public_addresses: "A public address", experiences: "A page shown when another cannot be opened",
};

/** Every place outside its own declaration that names a permission key, with what a builder knows it by. */
export const studioPermissionUses = (source: Source, key: string): readonly StudioAccessPlace[] => {
  const places: StudioAccessPlace[] = [];
  const seen = new Set<string>();
  const add = (place: StudioAccessPlace) => {
    const identity = JSON.stringify(place);
    if (!seen.has(identity)) { seen.add(identity); places.push(place); }
  };
  const body = source.body as unknown as Json;
  const visit = (value: unknown, path: readonly (string | number)[], chain: readonly Json[]): void => {
    if (typeof value === "string") {
      if (value !== key || path[path.length - 1] === "key") return;
      const [area, index] = path;
      if (area === "roles" && typeof index === "number") {
        const role = source.body.roles[index]!;
        add({ kind: "role", roleKey: role.key, label: `The role ${quoted(role.name)} holds it` });
      } else if (area === "pages" && typeof index === "number") {
        const page = source.body.pages[index]!;
        const block = [...chain].reverse().find((entry) => isObject(entry.props) && typeof entry.props.id === "string");
        if (path[2] === "permission") add({ kind: "page", pageAlias: page.id, label: `It opens the page ${quoted(page.name)}` });
        else if (block !== undefined) add({ kind: "placement", placementAlias: String((block.props as Json).id),
          label: `A block on the page ${quoted(page.name)} is shown or used with it` });
        else add({ kind: "page", pageAlias: page.id, label: `The page ${quoted(page.name)} uses it` });
      } else if (area === "shells" && typeof index === "number") {
        const block = [...chain].reverse().find((entry) => isObject(entry.props) && typeof entry.props.id === "string");
        const shell = source.body.shells[index]!;
        add(block === undefined ? { kind: "other", label: `The layout ${quoted(shell.name)} uses it` }
          : { kind: "placement", placementAlias: String((block.props as Json).id),
            label: `A block of the layout ${quoted(shell.name)} is shown or used with it` });
      } else if (area === "navigation") {
        const entry = [...chain].reverse().find((candidate) => typeof candidate.id === "string" && typeof candidate.label === "string");
        if (entry !== undefined) add({ kind: "navigation", alias: String(entry.id), label: `It shows the menu entry ${quoted(String(entry.label))}` });
      } else if (area === "modules" && typeof index === "number") {
        const module = source.body.modules[index]!;
        add({ kind: "data", moduleKey: module.key, label: `An action or rule of the module ${quoted(module.name)} needs it` });
      } else if (typeof area === "string") add({ kind: "other", label: `${areaWords[area] ?? tokenName(area)} uses it` });
      return;
    }
    if (Array.isArray(value)) value.forEach((entry, index) => visit(entry, [...path, index], chain));
    else if (isObject(value))
      for (const [field, entry] of Object.entries(value)) visit(entry, [...path, field], [...chain, value]);
  };
  visit(body, [], []);
  return places;
};

// ---------------------------------------------------------------------------------------------
// Field access of one role on one record type.
// ---------------------------------------------------------------------------------------------

type HeldPermission = Readonly<{ module: Module; permission: ModulePermission }>;
const heldOn = (body: Body, role: Role, moduleKey: string, recordKey: string, kind: string): readonly HeldPermission[] =>
  body.modules.filter((module) => module.key === moduleKey).flatMap((module) => module.permissions
    .filter((permission) => permission.record_type === recordKey && permission.action_kind === kind &&
      role.permissions.includes(permission.key))
    .map((permission) => ({ module, permission })));

export type StudioFieldAccess =
  | Readonly<{ kind: "available"; fields: readonly Readonly<{ key: string; label: string; readable: boolean;
      changeable: boolean; producedByPlatform: boolean }>[]; canChange: boolean }>
  | Readonly<{ kind: "unavailable"; message: string }>;

const recordOf = (body: Body, moduleKey: string, recordKey: string): RecordType | undefined =>
  body.modules.find((module) => module.key === moduleKey)?.record_types.find((record) => record.key === recordKey);

/** Which fields a role reads and changes on one record type, from the read and update permissions it holds. */
export const studioRoleFieldAccess = (source: Source, roleKey: string, moduleKey: string, recordKey: string): StudioFieldAccess => {
  const role = source.body.roles.find((candidate) => candidate.key === roleKey);
  const record = recordOf(source.body, moduleKey, recordKey);
  if (role === undefined || record === undefined) return { kind: "unavailable", message: "This role or record type is no longer in the draft." };
  if (role.permissions.includes("*")) return { kind: "unavailable", message: "This role holds every permission. List them one by one first." };
  const reads = heldOn(source.body, role, moduleKey, recordKey, "read");
  const updates = heldOn(source.body, role, moduleKey, recordKey, "update");
  if (reads.length === 0) return { kind: "unavailable", message: `Give ${quoted(role.name)} Read on ${record.plural_name} to choose its fields.` };
  if (reads.length > 1 || updates.length > 1)
    return { kind: "unavailable", message: `${quoted(role.name)} holds more than one read or update permission on ${record.plural_name}. Keep one of each to choose fields here.` };
  const readable = reads[0]!.permission.field_policy?.readable_fields;
  const update = updates[0]?.permission;
  const changeable = update === undefined ? [] : update.field_policy?.changeable_fields;
  return { kind: "available", canChange: update !== undefined, fields: record.fields.map((field) => ({
    key: field.key, label: field.label, producedByPlatform: !changeableByPeople(field),
    readable: readable === undefined || readable.includes(field.key),
    changeable: changeableByPeople(field) && (changeable === undefined || changeable.includes(field.key)),
  })) };
};

/**
 * The permission this role may change on its own: the permission itself when no other role holds
 * it, otherwise a copy for this role, which takes its place in the role. Others keep theirs.
 */
const ownedBy = (body: Body, role: Role, held: HeldPermission, taken: Set<string>, notes: string[]): ModulePermission => {
  if (holders(body, held.permission.key).every((holder) => holder.key === role.key)) return held.permission;
  const keys = new Set(held.module.permissions.map((permission) => permission.key));
  let key = `${held.permission.key}_${role.key}`.slice(0, 120);
  for (let suffix = 2; keys.has(key); suffix += 1) key = `${held.permission.key}_${role.key}_${suffix}`.slice(0, 120);
  const copy = { ...structuredClone(held.permission), key, id: uniqueAlias(`${held.permission.id}_${role.key}`, taken),
    label: `${held.permission.label} (${role.name})`.slice(0, labelLimit).trim() } as ModulePermission;
  held.module.permissions.push(copy);
  const entries = role.permissions as string[];
  entries.splice(entries.indexOf(held.permission.key), 1, key);
  notes.push(`${quoted(copy.label)} was made for ${quoted(role.name)}, so other roles keep their field access.`);
  return copy;
};

const setFieldAccess = (candidate: Source, command: Extract<StudioAccessCommand, { kind: "set_field_access" }>): StudioAccessResult => {
  const access = studioRoleFieldAccess(candidate, command.roleKey, command.moduleKey, command.recordKey);
  if (access.kind === "unavailable") return refuse(access.message);
  const body = candidate.body;
  const role = body.roles.find((entry) => entry.key === command.roleKey)!;
  const record = recordOf(body, command.moduleKey, command.recordKey)!;
  const field = access.fields.find((entry) => entry.key === command.fieldKey);
  if (field === undefined) return refuse("That field is no longer in the record type.");
  if (command.changeable && field.producedByPlatform) refuse(`The platform fills ${quoted(field.label)}, so nobody changes it.`);
  if (command.changeable && !access.canChange) refuse(`Give ${quoted(role.name)} Update on ${record.plural_name} first.`);
  const readable = new Set(access.fields.filter((entry) => entry.readable).map((entry) => entry.key));
  const changeable = new Set(access.fields.filter((entry) => entry.changeable).map((entry) => entry.key));
  // A field that is changed is read too; one that is not read is not changed.
  const reads = command.readable || command.changeable;
  if (reads) readable.add(field.key); else readable.delete(field.key);
  if (command.changeable) changeable.add(field.key); else changeable.delete(field.key);
  if (readable.size === 0) refuse(`${quoted(role.name)} reads ${record.plural_name}, so it reads at least one of their fields.`);
  const order = (keys: ReadonlySet<string>) => record.fields.map((entry) => entry.key).filter((key) => keys.has(key));
  const taken = takenAliases(body);
  const notes: string[] = [];
  // Only the permissions whose fields change are rewritten, so a change of what is changed leaves Read alone.
  const readChanged = field.readable !== reads;
  if (readChanged) {
    const read = ownedBy(body, role, heldOn(body, role, command.moduleKey, command.recordKey, "read")[0]!, taken, notes);
    (read as { field_policy?: unknown }).field_policy = { readable_fields: order(readable), changeable_fields: [] };
  } else if (field.changeable === command.changeable) refuse(`Nothing changes for ${quoted(field.label)}.`);
  const update = heldOn(body, role, command.moduleKey, command.recordKey, "update")[0];
  if (update !== undefined && (readChanged || field.changeable !== command.changeable)) {
    const owned = ownedBy(body, role, update, taken, notes);
    (owned as { field_policy?: unknown }).field_policy = { readable_fields: order(readable),
      changeable_fields: order(new Set([...changeable].filter((key) => readable.has(key)))) };
  }
  const what = !reads ? "does not read" : command.changeable ? "reads and changes" : "reads but does not change";
  return applied(candidate, [`${quoted(role.name)} now ${what} ${quoted(field.label)} on ${record.plural_name}.`, ...notes].join(" "), role.key);
};

// ---------------------------------------------------------------------------------------------
// Roles, grants, permissions and gates.
// ---------------------------------------------------------------------------------------------

/** Words for where the schema refused the result, never a value. */
const judged = (candidate: Source): Source => {
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  console.error("[studio] access edit refused by the source schema", issue.path.join("."), issue.code);
  return refuse(`This change would leave ${typeof issue.path[1] === "string" ? tokenName(issue.path[1]).toLowerCase() : "the application"} invalid (${issue.message}). Nothing was changed.`);
};
const applied = (candidate: Source, message: string, roleKey?: string): StudioAccessResult =>
  ({ kind: "applied", source: judged(candidate), message, roleKey });

const requireRole = (body: Body, roleKey: string): Role =>
  body.roles.find((role) => role.key === roleKey) ?? refuse("That role is no longer in the draft.");

const permissionOf = (source: Source, key: string): StudioAccessPermission =>
  studioAccessPermissions(source).find((permission) => permission.key === key) ??
    refuse("That permission is no longer in the draft.");

const pageOf = (body: Body, key: string) => body.pages.find((page) => page.key === key);

/** A new application permission that can open pages and show menu entries. */
const addPermission = (candidate: Source, label: string): ApplicationPermission => {
  const name = cleanLabel(label, "permission");
  const body = candidate.body;
  if (body.permissions.length >= 100) refuse("An application can declare at most 100 permissions of its own.");
  const keys = new Set(studioAccessPermissions(candidate).map((permission) => permission.key));
  const action = uniqueKey(name, new Set(body.permissions.flatMap((permission) => permission.named_action ?? [])));
  let key = `${candidate.key}.${action}`;
  for (let suffix = 2; keys.has(key); suffix += 1) key = `${candidate.key}.${action}_${suffix}`;
  const permission = { id: uniqueAlias(`permission_${action}`, takenAliases(body)), key, label: name,
    description: `People who hold this permission can ${name.charAt(0).toLowerCase()}${name.slice(1)}.`,
    action_kind: "named", named_action: action, administrative: false } as ApplicationPermission;
  body.permissions.push(permission);
  return permission;
};

const gateKey = (candidate: Source, gate: StudioAccessGate): Readonly<{ key: string; label: string; created: boolean }> => {
  if (gate.kind === "new") {
    const permission = addPermission(candidate, gate.label);
    return { key: permission.key, label: permission.label, created: true };
  }
  const choice = studioAccessGateChoices(candidate).find((entry) => entry.key === gate.key);
  if (choice === undefined) refuse("Only one of the application's own named permissions can open a page or show a menu entry.");
  return { key: choice!.key, label: choice!.label, created: false };
};

const createdWords = (gate: ReturnType<typeof gateKey>) => gate.created
  ? ` The permission ${quoted(gate.label)} was added; give it to the roles that should see it.` : "";

const setPageGate = (candidate: Source, command: Extract<StudioAccessCommand, { kind: "set_page_gate" }>): StudioAccessResult => {
  const page = candidate.body.pages.find((entry) => entry.id === command.pageAlias) ?? refuse("That page is no longer in the draft.");
  const previous = page.permission;
  const gate = gateKey(candidate, command.gate);
  if (gate.key === previous) refuse(`${quoted(page.name)} already opens with ${quoted(gate.label)}.`);
  (page as { permission: string }).permission = gate.key;
  // The menu entries that opened the page with its old permission follow it, so they stay consistent.
  const followed = studioAccessMenuEntries(candidate).filter((entry) => entry.type === "page" && entry.page === page.key &&
    entry.permission === previous);
  for (const entry of followed) (entry as { permission: string }).permission = gate.key;
  return applied(candidate, `${quoted(page.name)} now opens for people who hold ${quoted(gate.label)}` +
    `${followed.length === 0 ? "" : `, and so do its ${followed.length === 1 ? "menu entry" : `${followed.length} menu entries`}`}.${createdWords(gate)}`);
};

const setMenuGate = (candidate: Source, command: Extract<StudioAccessCommand, { kind: "set_menu_gate" }>): StudioAccessResult => {
  const entry = studioAccessMenuEntries(candidate).find((item) => item.id === command.alias) ?? refuse("That menu entry is no longer in the draft.");
  const gate = gateKey(candidate, command.gate);
  if (gate.key === entry.permission) refuse(`${quoted(entry.label)} is already shown with ${quoted(gate.label)}.`);
  (entry as { permission: string }).permission = gate.key;
  const page = entry.type === "page" ? pageOf(candidate.body, entry.page) : undefined;
  const differs = page !== undefined && page.permission !== gate.key;
  return applied(candidate, `The menu entry ${quoted(entry.label)} now shows for people who hold ${quoted(gate.label)}.` +
    (differs ? ` Its page ${quoted(page.name)} still opens with another permission, so check both match.` : "") + createdWords(gate));
};

const grant = (candidate: Source, command: Extract<StudioAccessCommand, { kind: "grant" }>): StudioAccessResult => {
  const role = requireRole(candidate.body, command.roleKey);
  if (role.permissions.includes("*")) refuse(`${quoted(role.name)} holds every permission. List them one by one first.`);
  const entries = role.permissions as string[];
  const declared = studioAccessPermissions(candidate).find((permission) => permission.key === command.permissionKey);
  const label = declared?.label ?? command.permissionKey;
  if (command.granted) {
    if (declared === undefined) refuse("That permission is no longer in the draft.");
    if (entries.includes(command.permissionKey)) refuse(`${quoted(role.name)} already holds ${quoted(label)}.`);
    entries.push(command.permissionKey);
    return applied(candidate, `${quoted(role.name)} now holds ${quoted(label)}.`, role.key);
  }
  if (!entries.includes(command.permissionKey)) refuse(`${quoted(role.name)} does not hold ${quoted(label)}.`);
  if (entries.length === 1) refuse(`${quoted(role.name)} needs at least one permission. Give it another first.`);
  const home = pageOf(candidate.body, role.home_page);
  if (home?.permission === command.permissionKey)
    refuse(`${quoted(role.name)} starts on ${quoted(home.name)}, which opens with ${quoted(label)}. Choose another start page first.`,
      [{ kind: "role", roleKey: role.key, label: `The start page of ${quoted(role.name)}` }]);
  entries.splice(entries.indexOf(command.permissionKey), 1);
  return applied(candidate, `${quoted(role.name)} no longer holds ${quoted(label)}.`, role.key);
};

const addRole = (candidate: Source, name: string): StudioAccessResult => {
  const label = cleanLabel(name, "role");
  const body = candidate.body;
  if (body.roles.length >= 100) refuse("An application can have at most 100 roles.");
  if (body.roles.some((role) => role.name.toLowerCase() === label.toLowerCase())) refuse(`There is already a role named ${quoted(label)}.`);
  const home = pageOf(body, body.home_page) ?? refuse("The application's home page is missing, so a new role has nowhere to start.");
  const key = uniqueKey(label, new Set(body.roles.map((role) => role.key)));
  if (!builderKeySchema.safeParse(key).success) refuse("The name has no letters to make the role's key from.");
  // A new role opens the home page and nothing else, until permissions are given to it.
  body.roles.push({ id: uniqueAlias(`role_${key}`, takenAliases(body)), key, name: label, home_page: home.key,
    permissions: [home.permission] } as Role);
  return applied(candidate, `Role ${quoted(label)} added. It opens ${quoted(home.name)}; give it what its people need.`, key);
};

const removeRole = (candidate: Source, roleKey: string): StudioAccessResult => {
  const role = requireRole(candidate.body, roleKey);
  if (candidate.body.roles.length === 1) refuse(`${quoted(role.name)} is the application's only role. Add another role first.`);
  if (role.default_member === true)
    refuse(`${quoted(role.name)} is the default member role. Make another role the default member role first.`,
      [{ kind: "role", roleKey: role.key, label: `${quoted(role.name)} is offered to whoever installs the application` }]);
  candidate.body.roles = candidate.body.roles.filter((entry) => entry.key !== roleKey);
  return applied(candidate, `Role ${quoted(role.name)} removed.`);
};

const removePermission = (candidate: Source, key: string): StudioAccessResult => {
  const permission = permissionOf(candidate, key);
  if (permission.standard)
    refuse(`${quoted(permission.label)} comes with its record type. It goes when the record type is removed in Data.`);
  const where = studioPermissionUses(candidate, key);
  if (where.length > 0) refuse(`${quoted(permission.label)} is still in use, so it was not removed.`, where);
  if (permission.moduleKey === undefined) candidate.body.permissions = candidate.body.permissions.filter((entry) => entry.key !== key);
  else {
    const module = candidate.body.modules.find((entry) => entry.key === permission.moduleKey)!;
    module.permissions = module.permissions.filter((entry) => entry.key !== key);
  }
  return applied(candidate, `Permission ${quoted(permission.label)} removed.`);
};

/** Applies one Access edit to the draft, or refuses it with a reason and, when something uses it, where. */
export const applyStudioAccessCommand = (source: Source, command: StudioAccessCommand): StudioAccessResult => {
  try {
    const candidate = applicationSourceDocumentSchema.parse(structuredClone(source));
    const body = candidate.body;
    switch (command.kind) {
      case "add_role": return addRole(candidate, command.name);
      case "rename_role": {
        const role = requireRole(body, command.roleKey);
        const name = cleanLabel(command.name, "role");
        if (name === role.name) refuse(`The role is already named ${quoted(name)}.`);
        if (body.roles.some((entry) => entry.key !== role.key && entry.name.toLowerCase() === name.toLowerCase()))
          refuse(`There is already a role named ${quoted(name)}.`);
        (role as { name: string }).name = name;
        return applied(candidate, `Role renamed to ${quoted(name)}.`, role.key);
      }
      case "remove_role": return removeRole(candidate, command.roleKey);
      case "set_default_member": {
        const role = requireRole(body, command.roleKey);
        if (role.default_member === true) refuse(`${quoted(role.name)} is already the default member role.`);
        // Exactly one role is the default member role, so the mark moves from the previous one.
        for (const entry of body.roles) delete (entry as { default_member?: true }).default_member;
        (role as { default_member?: true }).default_member = true;
        return applied(candidate, `${quoted(role.name)} is now the default member role: a first install offers it to the installer.`, role.key);
      }
      case "set_role_home_page": {
        const role = requireRole(body, command.roleKey);
        const page = pageOf(body, command.pageKey) ?? refuse("That page is no longer in the draft.");
        if (role.home_page === page.key) refuse(`${quoted(role.name)} already starts on ${quoted(page.name)}.`);
        if (studioRoleHolds(role, page.permission) === false)
          refuse(`${quoted(role.name)} cannot open ${quoted(page.name)}. Give it ${quoted(permissionOf(candidate, page.permission).label)} first.`);
        (role as { home_page: string }).home_page = page.key;
        return applied(candidate, `${quoted(role.name)} now starts on ${quoted(page.name)}.`, role.key);
      }
      case "grant": return grant(candidate, command);
      case "list_role_permissions": {
        const role = requireRole(body, command.roleKey);
        if (!role.permissions.includes("*")) refuse(`${quoted(role.name)} already lists its permissions.`);
        if (command.permissionKeys.length === 0) refuse("The permissions this role holds are listed once your latest change is saved. Try again in a moment.");
        (role as { permissions: string[] }).permissions = [...command.permissionKeys];
        return applied(candidate, `${quoted(role.name)} now lists its ${command.permissionKeys.length} permissions one by one.`, role.key);
      }
      case "set_field_access": return setFieldAccess(candidate, command);
      case "add_permission": {
        const permission = addPermission(candidate, command.label);
        return applied(candidate, `Permission ${quoted(permission.label)} added. Give it to roles, or use it to open pages.`);
      }
      case "remove_permission": return removePermission(candidate, command.permissionKey);
      case "set_page_gate": return setPageGate(candidate, command);
      case "set_menu_gate": return setMenuGate(candidate, command);
    }
  } catch (error) {
    if (error instanceof AccessRefusal)
      return { kind: "refused", message: error.message, ...(error.where === undefined ? {} : { where: error.where }) };
    throw error;
  }
};
