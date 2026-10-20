import { builderKeySchema, namespacedKeySchema } from "../catalogue/identifiers";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";
import {
  deriveFieldKey,
  isStandardRecordPermission,
  standardPermissionKey,
  standardPermissionKeys,
  standardRecordActions as standardActions,
} from "./module-field-shape";
import { applicationUses, type ApplicationUsePlace } from "./application-uses";
import {
  fullRecordAccessRoleKeys,
  standardRecordPermission,
  standardPermissionLabel as permissionLabel,
  standardPermissionDescription as permissionDescription,
} from "./module-permission-shape";
import { recordTitleFieldEligible } from "./record-title-field";
import { sourcePageItems } from "./application-composition/source-composition";
import type { RecordStorageScope } from "./module-record-type-settings";
import type { ModuleFieldPublication } from "./module-field-edit";

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];
type Field = RecordType["fields"][number];

/** The changes a record type edit makes to an Application source, or why it was refused. */
export type InlineRecordTypeResult =
  | Readonly<{
      kind: "changed";
      source: ApplicationSourceDocument;
      moduleKey: string;
      recordKey: string;
    }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>;

const words = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** A permanent record type key from its name, unique in its module; it never changes after the first save. */
export const deriveRecordTypeKey = (
  name: string,
  taken: ReadonlySet<string>,
): string | undefined => {
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
  new Set([
    ...source.body.modules.map((module) => module.key),
    ...source.body.uses.map((use) => use.module),
  ]);

/** A module key derived from its business name within the application's namespace. */
export const deriveOwnedModuleKey = (
  source: ApplicationSourceDocument,
  name: string,
): string | undefined => {
  const namespace = source.key.slice(0, 78).replace(/[._]+$/, "");
  const taken = takenModuleKeys(source);
  const segment = deriveRecordTypeKey(
    name,
    new Set(
      [...taken]
        .filter((key) => key.startsWith(`${namespace}.`))
        .map((key) => key.slice(namespace.length + 1)),
    ),
  );
  return segment === undefined ? undefined : `${namespace}.${segment}`;
};

const moduleNameIssues = (
  source: ApplicationSourceDocument,
  name: string,
  exceptKey?: string,
): string[] => {
  if (name === "") return ["Enter the module's name."];
  if (name.length > 120) return ["The module name must be at most 120 characters."];
  return source.body.modules.some(
    (module) => module.key !== exceptKey && module.name.trim().toLowerCase() === name.toLowerCase(),
  )
    ? ["This application already has a module with that name."]
    : [];
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
const moduleAliases = (module: InlineModule): Set<string> =>
  new Set([
    module.id,
    ...module.record_types.flatMap((record) => [
      record.id,
      record.storage_contract_id,
      ...record.fields.map((field) => field.id),
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
):
  | Readonly<{ kind: "added"; module: InlineModule }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }> => {
  const key = creation.key.trim();
  const name = creation.name.trim();
  const issues: string[] = [];
  if (!namespacedKeySchema.safeParse(key).success)
    issues.push(
      "The module key must be lowercase words separated by dots, for example team.workspace.data.",
    );
  else if (takenModuleKeys(source).has(key))
    issues.push("This application already owns or uses a module with that key.");
  issues.push(...moduleNameIssues(source, name));
  if (issues.length > 0) return { kind: "invalid", issues };
  const module = {
    id: uniqueAlias(
      `mod_${aliasPart(key)}`,
      new Set(source.body.modules.map((module) => module.id)),
    ),
    key,
    name,
    description: `The records of ${source.body.name}.`.slice(0, 1_000),
    record_types: [],
    permissions: [],
    actions: [],
    events: [],
    flows: [],
    extension_points: [],
    sharing_conditions: [],
    queries: [],
  } as unknown as InlineModule;
  source.body.modules.push(module);
  return { kind: "added", module };
};

/** Adds a module as one validated draft edit, leaving the original untouched on refusal. */
export const createOwnedInlineModule = (
  current: ApplicationSourceDocument,
  creation: Readonly<{ key: string; name: string }>,
):
  | Readonly<{ kind: "changed"; source: ApplicationSourceDocument; moduleKey: string }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }> => {
  const source = structuredClone(current);
  const added = addOwnedInlineModule(source, creation);
  if (added.kind === "invalid") return added;
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  if (!parsed.success)
    return {
      kind: "invalid",
      issues: parsed.error.issues.map((issue) => `${issue.message} (${issue.path.join(" / ")})`),
    };
  return { kind: "changed", source: parsed.data, moduleKey: added.module.key };
};

const parsedResult = (
  source: ApplicationSourceDocument,
  moduleKey: string,
  recordKey: string,
): InlineRecordTypeResult => {
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  if (!parsed.success)
    return {
      kind: "invalid",
      issues: parsed.error.issues.map((issue) => `${issue.message} (${issue.path.join(" / ")})`),
    };
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
  /** Where its records are kept; it is fixed once the record type is published. */
  storageScope: RecordStorageScope;
  /** Who owns each record. Inherited ownership needs a link, so it is chosen after creation. */
  ownershipMode: "none" | "organization_account" | "group";
}>;

/**
 * The Application source with one new record type in an owned inline Module. A record type is
 * created in its minimum valid shape: a reference number that identifies each record, a required
 * title field, every standard action with its standard permission (granted only to roles holding
 * every existing record permission in the Application's owned Modules), and storage of its own
 * with the storage scope and ownership the builder chose. When the Application owns no Module yet,
 * its first Module is created with it.
 */
export const createInlineRecordType = (
  current: ApplicationSourceDocument,
  creation: InlineRecordTypeCreation,
  publication: ModuleFieldPublication,
): InlineRecordTypeResult => {
  const source = structuredClone(current);
  const name = creation.name.trim();
  const pluralName = creation.pluralName.trim();
  const titleLabel = creation.titleLabel.trim();
  const key = creation.key.trim();
  const issues: string[] = [];
  if (name === "") issues.push("Enter the name of one record, for example Asset.");
  if (pluralName === "") issues.push("Enter the name of several records, for example Assets.");
  if (titleLabel === "")
    issues.push("Enter the label of the field that names each record, for example Name.");
  if (!builderKeySchema.safeParse(key).success)
    issues.push(
      "The key must start with a letter and use lowercase letters, digits and single underscores, at most 40 characters.",
    );
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
  if (module !== undefined && publication.recordTypes.has(`${module.key}:${key}`))
    issues.push(
      "That key belongs to a previously published record type. Choose a different key for a new record type.",
    );
  if (issues.length > 0 || module === undefined) return { kind: "invalid", issues };

  // Determine full access before adding the new type's permissions, across all owned Modules.
  const fullAccessRoles = fullRecordAccessRoleKeys(current);
  const taken = moduleAliases(module);
  const numberKey = key.length <= 33 ? `${key}_number` : "number";
  const titleKey = deriveFieldKey(titleLabel, new Set([numberKey])) ?? "name";
  const prefix = key.replace(/_/g, "").slice(0, 3).toUpperCase();
  const fields = [
    {
      id: uniqueAlias(`fld_${key}_${numberKey}`, taken),
      key: numberKey,
      label: `${name} number`.slice(0, 60),
      required: true,
      unique: true,
      filterable: true,
      sortable: true,
      search_priority: "normal",
      personal_data: "none",
      public_display: "refused",
      type: "reference_number",
      settings: { prefix: `${prefix}-`, digits: 6 },
    },
    {
      id: uniqueAlias(`fld_${key}_${titleKey}`, taken),
      key: titleKey,
      label: titleLabel,
      required: true,
      unique: false,
      filterable: true,
      sortable: true,
      search_priority: "first",
      personal_data: "none",
      public_display: "refused",
      type: "text",
      settings: { max_length: 255 },
    },
  ] as unknown as Field[];
  const record = {
    id: uniqueAlias(`rt_${key}`, taken),
    key,
    name,
    plural_name: pluralName,
    title_field: titleKey,
    storage_contract_id: uniqueAlias(`srt_${aliasPart(module.key)}_${key}`, taken),
    storage_scope: creation.storageScope,
    ownership_mode: creation.ownershipMode,
    standard_actions: standardActions.map((entry) => entry.action),
    custom_actions: [],
    fields,
    pipelines: [],
    relationships: [],
  } as unknown as RecordType;
  module.record_types.push(record);
  for (const entry of standardActions) {
    module.permissions.push(
      standardRecordPermission(
        module.key,
        record,
        entry.action,
        uniqueAlias(`perm_${key}_${entry.action}`, taken),
      ),
    );
  }
  const granted = [...standardPermissionKeys(module.key, key, record.standard_actions)];
  for (const role of source.body.roles) {
    const entries = role.permissions as string[];
    if (entries.includes("*")) continue;
    if (!fullAccessRoles.has(role.key)) continue;
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
    return {
      kind: "invalid",
      issues: ["The record type is not in this application's modules any more."],
    };
  const name = change.name.trim();
  const pluralName = change.pluralName.trim();
  if (name === "" || pluralName === "")
    return { kind: "invalid", issues: ["Enter both names of the record type."] };
  const keys = standardPermissionKeys(module.key, record.key, record.standard_actions);
  for (const permission of module.permissions) {
    if (!keys.has(permission.key) || !isStandardRecordPermission(module, permission)) continue;
    const entry = standardActions.find(
      (item) => standardPermissionKey(module.key, record.key, item.action) === permission.key,
    );
    if (entry === undefined) continue;
    const target = permission as { label: string; description: string };
    if (target.label === permissionLabel(entry.verb, record.name))
      target.label = permissionLabel(entry.verb, name);
    if (target.description === permissionDescription(entry.action, record.plural_name))
      target.description = permissionDescription(entry.action, pluralName);
  }
  const destination = record as { name: string; plural_name: string };
  destination.name = name;
  destination.plural_name = pluralName;
  return parsedResult(source, module.key, record.key);
};

/** Chooses an existing scalar title; publication classifies a changed title as a major version. */
export const setInlineRecordTitleField = (
  current: ApplicationSourceDocument,
  change: Readonly<{ moduleKey: string; recordKey: string; fieldKey: string }>,
): InlineRecordTypeResult => {
  const source = structuredClone(current);
  const record = source.body.modules
    .find((module) => module.key === change.moduleKey)
    ?.record_types.find((entry) => entry.key === change.recordKey);
  const field = record?.fields.find((entry) => entry.key === change.fieldKey);
  if (record === undefined || field === undefined)
    return { kind: "invalid", issues: ["Choose an existing field of this record type."] };
  if (!recordTitleFieldEligible(field))
    return {
      kind: "invalid",
      issues: [
        "Choose a text, number, choice or date field, or a stored calculation with one of those results.",
      ],
    };
  const previousTitle = record.title_field;
  (record as { title_field: string }).title_field = field.key;
  // Headings and search entries that followed the old title keep following its chosen title.
  const reference = `${change.moduleKey}:${record.key}`;
  for (const page of source.body.pages)
    for (const item of sourcePageItems(page.composition))
      if (
        item.type === "platform.renderer.record_detail" &&
        item.props.heading_source === "field" &&
        item.props.heading_field === `${reference}.${previousTitle}`
      ) {
        const queryReference = item.props.vortex.query;
        if (typeof queryReference === "string") {
          const separator = queryReference.indexOf(":");
          const owner = source.body.modules.find(
            (module) => module.key === queryReference.slice(0, separator),
          );
          const query = owner?.queries.find(
            (entry) => entry.key === queryReference.slice(separator + 1),
          );
          if (owner === undefined || query === undefined)
            return {
              kind: "invalid",
              issues: [
                `The heading on ${page.name} uses query ${queryReference}, which this application cannot edit. Change that query in its owning application before choosing this title.`,
              ],
            };
          const queryRecord = query.record_type.includes(":")
            ? query.record_type
            : `${owner.key}:${query.record_type}`;
          if (queryRecord !== reference)
            return {
              kind: "invalid",
              issues: [`The heading on ${page.name} uses a query for a different record type.`],
            };
          // An empty selection means all fields; keep that meaning rather than narrowing it.
          if (query.select.length > 0 && !(query.select as string[]).includes(field.key))
            (query.select as string[]).push(field.key);
        }
        item.props.heading_field = `${reference}.${field.key}`;
      }
  for (const entry of source.body.search?.record_types ?? [])
    if (entry.record_type === reference && entry.title_field === `${reference}.${previousTitle}`)
      entry.title_field = `${reference}.${field.key}`;
  return parsedResult(source, change.moduleKey, change.recordKey);
};

/** Renames an owned Module: its name changes, its key stays. */
export const renameInlineModule = (
  current: ApplicationSourceDocument,
  change: Readonly<{ moduleKey: string; name: string }>,
): InlineRecordTypeResult => {
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === change.moduleKey);
  if (module === undefined)
    return { kind: "invalid", issues: ["The module is not owned by this application any more."] };
  const name = change.name.trim();
  const issues = moduleNameIssues(source, name, module.key);
  if (issues.length > 0) return { kind: "invalid", issues };
  (module as { name: string }).name = name;
  return parsedResult(source, module.key, "");
};

/**
 * The Application source without one record type of an owned Module. It is refused while anything
 * else uses the record type. Its standard permissions go with it; its Module stays, empty when
 * this was its last record type.
 */
export const deleteInlineRecordType = (
  current: ApplicationSourceDocument,
  moduleKey: string,
  recordKey: string,
):
  | InlineRecordTypeResult
  | Readonly<{ kind: "referenced"; references: readonly ApplicationUsePlace[] }> => {
  const references = applicationUses(current, { kind: "record_type", moduleKey, recordKey });
  if (references.length > 0) return { kind: "referenced", references };
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === moduleKey);
  if (module === undefined || !module.record_types.some((record) => record.key === recordKey))
    return {
      kind: "invalid",
      issues: ["The record type is not in this application's modules any more."],
    };
  const own = new Set(
    module.permissions
      .filter(
        (permission) =>
          permission.record_type === recordKey && isStandardRecordPermission(module, permission),
      )
      .map((permission) => permission.key),
  );
  module.record_types = module.record_types.filter((record) => record.key !== recordKey);
  module.permissions = module.permissions.filter((permission) => !own.has(permission.key));
  for (const role of source.body.roles)
    (role as { permissions: string[] }).permissions = (role.permissions as string[]).filter(
      (entry) => !own.has(entry),
    );
  return parsedResult(source, moduleKey, recordKey);
};
