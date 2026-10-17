import { builderKeySchema, namespacedKeySchema } from "../catalogue/identifiers";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";
import {
  changeableByPeople, deriveFieldKey, standardPermissionKey,
  standardPermissionKeys, standardRecordActions as standardActions,
} from "./module-field-shape";
import { applicationUses, type ApplicationUsePlace } from "./application-uses";

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];
type Field = RecordType["fields"][number];
type ModulePermission = InlineModule["permissions"][number];

/** The changes a record type edit makes to an Application source, or why it was refused. */
export type InlineRecordTypeResult =
  | Readonly<{ kind: "changed"; source: ApplicationSourceDocument; moduleKey: string; recordKey: string }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>;

const words = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** A permanent record type key from its name, unique in its module; it never changes after the first save. */
export const deriveRecordTypeKey = (name: string, taken: ReadonlySet<string>): string | undefined => {
  const base = words(name).slice(0, 40).replace(/_+$/, "");
  if (!builderKeySchema.safeParse(base).success) return undefined;
  for (let n = 1; n < 1_000; n += 1) {
    const suffix = n === 1 ? "" : `_${n}`;
    const candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return undefined;
};

/** Every Module key the Application owns or uses: a Module key is owned or used once. */
const takenModuleKeys = (source: ApplicationSourceDocument): Set<string> =>
  new Set([...source.body.modules.map((module) => module.key), ...source.body.uses.map((use) => use.module)]);

/** The key of the first Module an Application owns, made from the Application key: `team.workspace.data`. */
export const defaultOwnedModuleKey = (source: ApplicationSourceDocument): string => {
  const taken = takenModuleKeys(source);
  for (let n = 1; n < 1_000; n += 1) {
    const candidate = `${source.key}.${n === 1 ? "data" : `data_${n}`}`;
    if (!taken.has(candidate) && namespacedKeySchema.safeParse(candidate).success) return candidate;
  }
  return `${source.key}.data`;
};

const aliasPart = (key: string): string => key.replaceAll(".", "_");

const uniqueAlias = (base: string, taken: Set<string>): string => {
  const trimmed = base.slice(0, 150);
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? trimmed : `${trimmed}_${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
};

/** Every local alias a Module holds, which a new alias in it must not repeat. */
const moduleAliases = (module: InlineModule): Set<string> => new Set([
  module.id,
  ...module.record_types.flatMap((record) => [
    record.id, record.storage_contract_id, ...record.fields.map((field) => field.id),
    ...record.relationships.map((relationship) => relationship.id),
  ]),
  ...module.permissions.map((permission) => permission.id),
  ...module.actions.map((action) => action.id),
  ...module.events.map((event) => event.id),
  ...module.queries.map((query) => query.id),
]);

/**
 * Adds one empty Module the Application owns: no record types, permissions or queries yet. It is
 * the one way an owned Module is created, for a new Application and for the first record type of
 * an Application that owns none. The source is changed in place.
 */
export const addOwnedInlineModule = (
  source: ApplicationSourceDocument,
  creation: Readonly<{ key: string; name: string }>,
): Readonly<{ kind: "added"; module: InlineModule }> | Readonly<{ kind: "invalid"; issues: readonly string[] }> => {
  const key = creation.key.trim();
  const name = creation.name.trim();
  const issues: string[] = [];
  if (!namespacedKeySchema.safeParse(key).success)
    issues.push("The module key must be lowercase words separated by dots, for example team.workspace.data.");
  else if (takenModuleKeys(source).has(key)) issues.push("This application already owns or uses a module with that key.");
  if (name === "") issues.push("Enter the module's name.");
  if (issues.length > 0) return { kind: "invalid", issues };
  const module = {
    id: `mod_${aliasPart(key)}`.slice(0, 160), key, name,
    description: `The records of ${source.body.name}.`.slice(0, 1_000),
    record_types: [], permissions: [], actions: [], events: [], flows: [], extension_points: [],
    sharing_conditions: [], queries: [],
  } as unknown as InlineModule;
  source.body.modules.push(module);
  return { kind: "added", module };
};

const permissionLabel = (verb: string, name: string): string => `${verb} ${name.toLowerCase()}`.slice(0, 60);
const permissionDescription = (action: string, plural: string): string =>
  `Allows the standard ${action.replaceAll("_", " ")} operation for ${plural.toLowerCase()}.`;

const parsedResult = (source: ApplicationSourceDocument, moduleKey: string, recordKey: string): InlineRecordTypeResult => {
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  if (!parsed.success)
    return { kind: "invalid", issues: parsed.error.issues.map((issue) => `${issue.message} (${issue.path.join(" / ")})`) };
  return { kind: "changed", source: parsed.data, moduleKey, recordKey };
};

/** A new record type and, for an Application that owns no Module yet, its first Module. */
export type InlineRecordTypeCreation = Readonly<{
  /** The owned Module to add it to; absent to create the Application's first owned Module. */
  moduleKey?: string;
  /** The key and name of the first owned Module, when one is created. */
  newModule?: Readonly<{ key: string; name: string }>;
  name: string;
  pluralName: string;
  key: string;
  /** The label of the title field that names each record. */
  titleLabel: string;
}>;

/**
 * The Application source with one new record type in an owned inline Module. A record type is
 * created in its minimum valid shape: a reference number that identifies each record, a required
 * title field, every standard action with its standard permission (granted to every access group
 * of the Application), and organisation-shared storage of its own. When the Application owns no
 * Module yet, its first Module is created with it.
 */
export const createInlineRecordType = (
  current: ApplicationSourceDocument,
  creation: InlineRecordTypeCreation,
): InlineRecordTypeResult => {
  const source = structuredClone(current);
  const name = creation.name.trim();
  const pluralName = creation.pluralName.trim();
  const titleLabel = creation.titleLabel.trim();
  const key = creation.key.trim();
  const issues: string[] = [];
  if (name === "") issues.push("Enter the name of one record, for example Asset.");
  if (pluralName === "") issues.push("Enter the name of several records, for example Assets.");
  if (titleLabel === "") issues.push("Enter the label of the field that names each record, for example Name.");
  if (!builderKeySchema.safeParse(key).success)
    issues.push("The key must start with a letter and use lowercase letters, digits and single underscores, at most 40 characters.");
  let module: InlineModule | undefined;
  if (creation.moduleKey !== undefined) {
    module = source.body.modules.find((item) => item.key === creation.moduleKey);
    if (module === undefined) issues.push("The module is not owned by this application any more.");
  } else if (source.body.modules.length > 0) {
    issues.push("Choose the module this record type belongs to.");
  } else {
    const created = addOwnedInlineModule(source, creation.newModule ?? { key: "", name: "" });
    if (created.kind === "invalid") issues.push(...created.issues);
    else module = created.module;
  }
  if (module !== undefined && module.record_types.some((record) => record.key === key))
    issues.push(`This module already has a record type with the key "${key}".`);
  if (issues.length > 0 || module === undefined) return { kind: "invalid", issues };

  const taken = moduleAliases(module);
  const numberKey = key.length <= 33 ? `${key}_number` : "number";
  const titleKey = deriveFieldKey(titleLabel, new Set([numberKey])) ?? "name";
  const prefix = key.replace(/_/g, "").slice(0, 3).toUpperCase();
  const fields = [
    {
      id: uniqueAlias(`fld_${key}_${numberKey}`, taken), key: numberKey, label: `${name} number`.slice(0, 60),
      required: true, unique: true, filterable: true, sortable: true, search_priority: "normal",
      personal_data: "none", public_display: "refused", type: "reference_number",
      settings: { prefix: `${prefix}-`, digits: 6 },
    },
    {
      id: uniqueAlias(`fld_${key}_${titleKey}`, taken), key: titleKey, label: titleLabel,
      required: true, unique: false, filterable: true, sortable: true, search_priority: "first",
      personal_data: "none", public_display: "refused", type: "text", settings: { max_length: 255 },
    },
  ] as unknown as Field[];
  const record = {
    id: uniqueAlias(`rt_${key}`, taken), key, name, plural_name: pluralName, title_field: titleKey,
    storage_contract_id: uniqueAlias(`srt_${aliasPart(module.key)}_${key}`, taken),
    storage_scope: "organisation_shared", ownership_mode: "group",
    standard_actions: standardActions.map((entry) => entry.action), custom_actions: [], fields, pipelines: [], relationships: [],
  } as unknown as RecordType;
  module.record_types.push(record);
  const readable = fields.map((field) => field.key);
  const changeableFields = fields.filter(changeableByPeople).map((field) => field.key);
  for (const entry of standardActions) {
    module.permissions.push({
      id: uniqueAlias(`perm_${key}_${entry.action}`, taken),
      key: standardPermissionKey(module.key, key, entry.action),
      label: permissionLabel(entry.verb, name), description: permissionDescription(entry.action, pluralName),
      record_type: key, action_kind: entry.kind, administrative: false,
      record_scope: { routes: [{ kind: "all_records" }] },
      field_policy: {
        readable_fields: [...readable],
        changeable_fields: entry.kind === "create" || entry.kind === "update" ? [...changeableFields] : [],
      },
    } as unknown as ModulePermission);
  }
  const granted = [...standardPermissionKeys(module.key, key)];
  for (const role of source.body.roles) {
    const entries = role.permissions as string[];
    if (entries.includes("*")) continue;
    for (const permission of granted) if (!entries.includes(permission)) entries.push(permission);
  }
  return parsedResult(source, module.key, key);
};

/** Renames a record type: its names change, its key and storage stay. Derived permission names follow. */
export const renameInlineRecordType = (
  current: ApplicationSourceDocument,
  change: Readonly<{ moduleKey: string; recordKey: string; name: string; pluralName: string }>,
): InlineRecordTypeResult => {
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === change.moduleKey);
  const record = module?.record_types.find((item) => item.key === change.recordKey);
  if (module === undefined || record === undefined)
    return { kind: "invalid", issues: ["The record type is not in this application's modules any more."] };
  const name = change.name.trim();
  const pluralName = change.pluralName.trim();
  if (name === "" || pluralName === "") return { kind: "invalid", issues: ["Enter both names of the record type."] };
  const keys = standardPermissionKeys(module.key, record.key);
  for (const permission of module.permissions) {
    if (!keys.has(permission.key)) continue;
    const entry = standardActions.find((item) => standardPermissionKey(module.key, record.key, item.action) === permission.key);
    if (entry === undefined) continue;
    const target = permission as { label: string; description: string };
    if (target.label === permissionLabel(entry.verb, record.name)) target.label = permissionLabel(entry.verb, name);
    if (target.description === permissionDescription(entry.action, record.plural_name))
      target.description = permissionDescription(entry.action, pluralName);
  }
  const destination = record as { name: string; plural_name: string };
  destination.name = name;
  destination.plural_name = pluralName;
  return parsedResult(source, module.key, record.key);
};

/** Replaces every string `from` (and every string that starts with `from` and a separator) under a value. */
const replaceReferences = (value: unknown, matches: (text: string) => string | undefined): unknown => {
  if (typeof value === "string") return matches(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceReferences(item, matches));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceReferences(child, matches)]));
  return value;
};

/**
 * Changes the key of a record type that is not saved yet: once a draft holding it is saved, its key
 * is permanent. Every reference in the source follows the new key.
 */
export const rekeyUnsavedInlineRecordType = (
  current: ApplicationSourceDocument, saved: ApplicationSourceDocument,
  change: Readonly<{ moduleKey: string; recordKey: string; key: string }>,
): InlineRecordTypeResult => {
  const next = change.key.trim();
  if (saved.body.modules.some((module) => module.key === change.moduleKey &&
      module.record_types.some((record) => record.key === change.recordKey)))
    return { kind: "invalid", issues: ["This record type is saved, so its key is permanent."] };
  const module = current.body.modules.find((item) => item.key === change.moduleKey);
  if (module === undefined || !module.record_types.some((record) => record.key === change.recordKey))
    return { kind: "invalid", issues: ["The record type is not in this application's modules any more."] };
  if (!builderKeySchema.safeParse(next).success)
    return { kind: "invalid", issues: ["The key must start with a letter and use lowercase letters, digits and single underscores, at most 40 characters."] };
  if (module.record_types.some((record) => record.key === next))
    return { kind: "invalid", issues: [`This module already has a record type with the key "${next}".`] };
  const qualified = `${module.key}:${change.recordKey}`;
  const permissions = new Map([...standardPermissionKeys(module.key, change.recordKey)].map((permission) =>
    [permission, `${module.key}.${next}${permission.slice(`${module.key}.${change.recordKey}`.length)}`]));
  const source = replaceReferences(current, (text) =>
    text === qualified || text.startsWith(`${qualified}.`) ? `${module.key}:${next}${text.slice(qualified.length)}`
      : permissions.get(text),
  ) as ApplicationSourceDocument;
  const owning = source.body.modules.find((item) => item.key === module.key)!;
  for (const record of owning.record_types)
    if (record.key === change.recordKey) (record as { key: string }).key = next;
  for (const section of ["permissions", "actions", "events", "queries", "extension_points"] as const)
    for (const item of owning[section] as unknown as Record<string, unknown>[])
      if (item.record_type === change.recordKey) item.record_type = next;
  return parsedResult(source, module.key, next);
};

/** Changes the key of the owned Module while it is not saved yet; every qualified reference follows. */
export const rekeyUnsavedInlineModule = (
  current: ApplicationSourceDocument, saved: ApplicationSourceDocument,
  change: Readonly<{ moduleKey: string; key: string }>,
): InlineRecordTypeResult => {
  const next = change.key.trim();
  if (saved.body.modules.some((module) => module.key === change.moduleKey))
    return { kind: "invalid", issues: ["This module is saved, so its key is permanent."] };
  if (!current.body.modules.some((module) => module.key === change.moduleKey))
    return { kind: "invalid", issues: ["The module is not owned by this application any more."] };
  if (!namespacedKeySchema.safeParse(next).success)
    return { kind: "invalid", issues: ["The module key must be lowercase words separated by dots, for example team.workspace.data."] };
  if (next !== change.moduleKey && takenModuleKeys(current).has(next))
    return { kind: "invalid", issues: ["This application already owns or uses a module with that key."] };
  const source = replaceReferences(current, (text) =>
    text === change.moduleKey ? next
      : text.startsWith(`${change.moduleKey}:`) || text.startsWith(`${change.moduleKey}.`)
        ? `${next}${text.slice(change.moduleKey.length)}` : undefined,
  ) as ApplicationSourceDocument;
  const module = source.body.modules.find((item) => item.key === next);
  if (module !== undefined) (module as { id: string }).id = `mod_${aliasPart(next)}`.slice(0, 160);
  return parsedResult(source, next, "");
};

/** Renames an owned Module: its name changes, its key stays. */
export const renameInlineModule = (
  current: ApplicationSourceDocument, change: Readonly<{ moduleKey: string; name: string }>,
): InlineRecordTypeResult => {
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === change.moduleKey);
  if (module === undefined) return { kind: "invalid", issues: ["The module is not owned by this application any more."] };
  if (change.name.trim() === "") return { kind: "invalid", issues: ["Enter the module's name."] };
  (module as { name: string }).name = change.name.trim();
  return parsedResult(source, module.key, "");
};

/**
 * The Application source without one record type of an owned Module. It is refused while anything
 * else uses the record type. Its standard permissions go with it; its Module stays, empty when
 * this was its last record type.
 */
export const deleteInlineRecordType = (
  current: ApplicationSourceDocument, moduleKey: string, recordKey: string,
): InlineRecordTypeResult | Readonly<{ kind: "referenced"; references: readonly ApplicationUsePlace[] }> => {
  const references = applicationUses(current, { kind: "record_type", moduleKey, recordKey });
  if (references.length > 0) return { kind: "referenced", references };
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === moduleKey);
  if (module === undefined || !module.record_types.some((record) => record.key === recordKey))
    return { kind: "invalid", issues: ["The record type is not in this application's modules any more."] };
  const own = standardPermissionKeys(moduleKey, recordKey);
  module.record_types = module.record_types.filter((record) => record.key !== recordKey);
  module.permissions = module.permissions.filter((permission) => !own.has(permission.key));
  for (const role of source.body.roles)
    (role as { permissions: string[] }).permissions = (role.permissions as string[]).filter((entry) => !own.has(entry));
  return parsedResult(source, moduleKey, recordKey);
};
