import { fieldTypeKeys } from "../catalogue/catalogues";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";
import {
  deriveFieldAlias,
  deriveFieldKey,
  includeFieldInStandardPermissions,
  standardPermissionKeys,
} from "./module-field-shape";
import {
  describeSourcePlace,
  walkSourceStrings,
  type InlineRecordTypeReference,
  type SourcePath,
} from "./module-record-type-shape";
import { moduleFieldTypeLabels, type ModuleFieldType } from "./module-field-settings";
import {
  enablePeopleDirectoryLinks,
  linkCardinalities,
  linkTargetModule,
  peopleDirectory,
  type LinkCardinality,
  type PeopleDirectoryOwner,
} from "./module-links";

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];
type Field = RecordType["fields"][number];
type Relationship = RecordType["relationships"][number];

/**
 * What the published versions of the application hold, by qualified reference: a field
 * (`module:record.field`) or a record type (`module:record`) in a published version has stored
 * records. The stored shape of such a field (its type, settings, and its required, unique, filter
 * and sort choices) is fixed, it cannot be removed, and a field added to such a record type must be
 * optional: an upgrade refuses anything else.
 */
export type ModuleFieldPublication = Readonly<{
  fields: ReadonlySet<string>;
  recordTypes: ReadonlySet<string>;
}>;

/** What a field change is checked against besides the draft: what is published, and the people directory. */
export type InlineModuleFieldContext = Readonly<{
  publication: ModuleFieldPublication;
  /** The people directory's owner, which a first Person link adds to the Modules the application uses. */
  peopleDirectory: PeopleDirectoryOwner | null;
}>;

/** One field added to, or changed in, a record type of an owned inline Module, as a person set it. */
export type InlineModuleFieldChange = Readonly<{
  moduleKey: string;
  recordAlias: string;
  /** Absent to add a new field. */
  fieldAlias?: string;
  label: string;
  helpText: string;
  required: boolean;
  unique: boolean;
  filterable: boolean;
  sortable: boolean;
  type: string;
  /** The complete plain settings the field contract stores for the type. */
  settings: Readonly<Record<string, unknown>>;
  /** The plain default value, or undefined for none. */
  defaultValue: unknown;
  /** How many records may link to one linked record: set for a link field, undefined otherwise. */
  cardinality: LinkCardinality | undefined;
}>;

export type InlineModuleFieldChangeResult =
  | Readonly<{ kind: "changed"; source: ApplicationSourceDocument; fieldAlias: string; fieldKey: string }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>;

const moduleAliases = (module: InlineModule): Set<string> =>
  new Set(module.record_types.flatMap((item) => [item.id, ...item.fields.map((field) => field.id),
    ...item.relationships.map((relationship) => relationship.id)]));

const settingWords = (path: readonly PropertyKey[]): string =>
  path.map((segment) => typeof segment === "number" ? `entry ${segment + 1}` : String(segment).replaceAll("_", " ")).join(", ");

/**
 * The schema's refusals, each named by where it is: the field and the setting when it is about the
 * changed field, otherwise the place in the application.
 */
const locatedIssues = (source: ApplicationSourceDocument, issues: readonly { message: string; path: readonly PropertyKey[] }[],
  moduleIndex: number, recordIndex: number, fieldIndex: number, label: string): string[] =>
  [...new Set(issues.map((issue) => {
    const [, section, m, part, r, child, f, ...rest] = issue.path;
    if (section === "modules" && m === moduleIndex && part === "record_types" && r === recordIndex && child === "fields" && f === fieldIndex)
      return rest.length === 0 ? `${label}: ${issue.message}.` : `${label}, ${settingWords(rest)}: ${issue.message}.`;
    const place = describeSourcePlace(source, issue.path.filter((segment): segment is string | number =>
      typeof segment === "string" || typeof segment === "number"));
    return `${place.label}: ${issue.message} (${settingWords(issue.path.slice(1))}).`;
  }))];

/**
 * The relationship a link field declares, kept in step with the field: its target, its delete rule
 * and its cardinality. A field that is no link declares none.
 */
const syncLinkRelationship = (module: InlineModule, record: RecordType, field: Field, cardinality: LinkCardinality | undefined): void => {
  const relationships = record.relationships as Relationship[];
  const at = relationships.findIndex((relationship) => relationship.from_field === field.key);
  if (field.type !== "link" && field.type !== "link_to_one_of_several") {
    if (at >= 0) relationships.splice(at, 1);
    return;
  }
  const settings = field.settings as { target?: string; targets?: string[]; on_parent_delete: Relationship["on_parent_delete"] };
  const target = field.type === "link" ? { to_record_type: settings.target } : { to_record_types: settings.targets };
  if (at >= 0) {
    const current = relationships[at] as Record<string, unknown>;
    delete current.to_record_type;
    delete current.to_record_types;
    Object.assign(current, target, { on_parent_delete: settings.on_parent_delete, cardinality });
    return;
  }
  const keys = new Set(relationships.map((relationship) => relationship.key));
  let key = field.key;
  for (let n = 2; keys.has(key); n += 1) key = `${field.key.slice(0, 36)}_${n}`;
  relationships.push({
    id: deriveFieldAlias(record.key, `${field.key}_relationship`, moduleAliases(module)), key, from_field: field.key,
    ...target, cardinality, on_parent_delete: settings.on_parent_delete,
  } as unknown as Relationship);
};

/** Why a link field's targets and cardinality can't be kept, or undefined when they can. */
const linkProblem = (source: ApplicationSourceDocument, module: InlineModule, change: InlineModuleFieldChange,
  label: string): string | undefined => {
  if (change.type !== "link" && change.type !== "link_to_one_of_several") return undefined;
  if (change.cardinality === undefined || !linkCardinalities.includes(change.cardinality))
    return `${label}: choose how many records may link to the same record.`;
  if (change.cardinality === "one_to_one" && !change.unique)
    return `${label}: when each linked record may have one link at most, tick "Each record has a different value".`;
  const settings = change.settings as { target?: unknown; targets?: unknown };
  const targets = (change.type === "link" ? [settings.target] : Array.isArray(settings.targets) ? settings.targets : [])
    .filter((target): target is string => typeof target === "string");
  const reachable = new Set([...source.body.modules.map((item) => item.key), ...source.body.uses.map((use) => use.module),
    peopleDirectory.module]);
  for (const target of targets) {
    const owner = linkTargetModule(target);
    if (owner !== undefined && !reachable.has(owner))
      return `${label}: it links to ${target}, in a module this application neither owns nor uses. Choose one of the record types offered.`;
  }
  // Each link back from one record type must have its own name, or the two would read the same.
  const reverse = (change.settings as { reverse_key?: unknown }).reverse_key;
  const record = module.record_types.find((item) => item.id === change.recordAlias);
  const twin = record?.fields.find((field) => field.id !== change.fieldAlias && field.type === "link" &&
    (field.settings as { target?: unknown; reverse_key?: unknown }).target === settings.target &&
    (field.settings as { reverse_key?: unknown }).reverse_key === reverse);
  if (change.type === "link" && reverse !== undefined && twin !== undefined)
    return `${label}: ${twin.label} already links to the same record type with the link back "${String(reverse)}". Give this link back another name.`;
  return undefined;
};

/**
 * The Application source with one field of one owned inline Module added or changed. Every property
 * a person sets is written as given, and the result is checked by the source schema. A field that is
 * in a published version keeps its stored shape: a change to its type, settings, required, unique,
 * filter or sort choice is refused with the reason. A type may change only while the field is not
 * published; its settings are then the new type's, and no stored value is converted.
 */
export const changeInlineModuleField = (
  current: ApplicationSourceDocument,
  change: InlineModuleFieldChange,
  context: InlineModuleFieldContext,
): InlineModuleFieldChangeResult => {
  const { publication } = context;
  const source = structuredClone(current);
  const moduleIndex = source.body.modules.findIndex((item) => item.key === change.moduleKey);
  const module = source.body.modules[moduleIndex];
  const recordIndex = module?.record_types.findIndex((item) => item.id === change.recordAlias) ?? -1;
  const record = module?.record_types[recordIndex];
  if (module === undefined || record === undefined)
    return { kind: "invalid", issues: ["The record type is not in this module any more."] };
  if (!(fieldTypeKeys as readonly string[]).includes(change.type))
    return { kind: "invalid", issues: [`"${change.type}" is not a field type.`] };
  const label = change.label.trim();
  if (label === "") return { kind: "invalid", issues: ["Enter the field's label."] };
  const helpText = change.helpText.trim();
  const refusedLink = linkProblem(source, module, change, label);
  if (refusedLink !== undefined) return { kind: "invalid", issues: [refusedLink] };
  const qualifiedRecord = `${module.key}:${record.key}`;
  let fieldIndex = change.fieldAlias === undefined ? -1 : record.fields.findIndex((item) => item.id === change.fieldAlias);
  if (change.fieldAlias !== undefined && fieldIndex < 0)
    return { kind: "invalid", issues: ["The field is not in this record type any more."] };
  const shape = { type: change.type, settings: change.settings, required: change.required, unique: change.unique,
    filterable: change.filterable, sortable: change.sortable };
  let field: Field;
  if (fieldIndex < 0) {
    if (change.required && publication.recordTypes.has(qualifiedRecord))
      return { kind: "invalid", issues: [`${record.name} is in a published version, so a field added to it can't be required: ` +
        "records already stored have no value for it. Add it as optional."] };
    const key = deriveFieldKey(label, new Set(record.fields.map((item) => item.key)));
    if (key === undefined) return { kind: "invalid", issues: ["The label must start with a letter so a key can be made from it."] };
    field = {
      id: deriveFieldAlias(record.key, key, moduleAliases(module)), key, label,
      ...(helpText === "" ? {} : { help_text: helpText }), ...shape,
      personal_data: "none", public_display: "refused",
      ...(change.defaultValue === undefined ? {} : { default: change.defaultValue }),
    } as unknown as Field;
    record.fields.push(field);
    fieldIndex = record.fields.length - 1;
    // A new field is readable, and changeable where people set it, through the standard permissions.
    includeFieldInStandardPermissions(module, record, { key, type: change.type as Field["type"] });
  } else {
    field = record.fields[fieldIndex]!;
    if (publication.fields.has(`${qualifiedRecord}.${field.key}`)) {
      const fixed = [
        ...(field.type === change.type ? [] : ["type"]),
        ...(JSON.stringify(field.settings) === JSON.stringify(change.settings) || field.type !== change.type ? [] : ["settings"]),
        ...(["required", "unique", "filterable", "sortable"] as const).filter((key) => field[key] !== change[key]),
        ...(field.type === change.type && record.relationships.some((relationship) =>
          relationship.from_field === field.key && relationship.cardinality !== change.cardinality) ? ["number of links"] : []),
      ];
      if (fixed.length > 0)
        return { kind: "invalid", issues: [`${field.label} is in a published version, so its ${fixed.join(", ")} can't change: ` +
          `records already stored keep them, and values are never converted. ${field.type === change.type ? ""
            : `To hold ${moduleFieldTypeLabels[change.type as ModuleFieldType].toLowerCase()} values, add a new field. `}` +
          "Its label, help text and default can still change."] };
    }
    const destination = field as Record<string, unknown>;
    destination.label = label;
    if (helpText === "") delete destination.help_text;
    else destination.help_text = helpText;
    Object.assign(destination, shape);
    if (change.defaultValue === undefined) delete destination.default;
    else destination.default = change.defaultValue;
  }
  syncLinkRelationship(module, record, field, change.cardinality);
  const linked = field.settings as { target?: unknown; targets?: unknown };
  if ((field.type === "link" && linked.target === peopleDirectory.recordType) ||
      (field.type === "link_to_one_of_several" && Array.isArray(linked.targets) && linked.targets.includes(peopleDirectory.recordType))) {
    const refused = enablePeopleDirectoryLinks(source, module, record, context.peopleDirectory);
    if (refused !== undefined) return { kind: "invalid", issues: [refused] };
  }
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  if (!parsed.success)
    return { kind: "invalid", issues: locatedIssues(source, parsed.error.issues, moduleIndex, recordIndex, fieldIndex, label) };
  return { kind: "changed", source: parsed.data, fieldAlias: field.id, fieldKey: field.key };
};

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
const mapKeyPaths = (value: unknown, name: string, path: SourcePath = [], parent?: string): SourcePath[] => {
  if (Array.isArray(value)) return value.flatMap((item, index) => mapKeyPaths(item, name, [...path, index], parent));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...((parent === "values" || parent === "field_values") && key === name ? [[...path, key]] : []),
    ...mapKeyPaths(child, name, [...path, key], key),
  ]);
};

/**
 * Every place in the Application source that uses one field of an owned inline Module: its
 * qualified reference or alias anywhere (pages, menus, search, flows and other modules), and its
 * local key in the components that work on its record type (other fields' settings, queries,
 * actions, rules and flows, non-standard permissions). Being the title field counts. The field
 * itself and the standard permissions' field lists (which follow it) do not.
 */
export const inlineFieldReferences = (
  source: ApplicationSourceDocument, moduleKey: string, recordKey: string, fieldKey: string,
): readonly InlineRecordTypeReference[] => {
  const moduleIndex = source.body.modules.findIndex((module) => module.key === moduleKey);
  const module = source.body.modules[moduleIndex];
  const recordIndex = module?.record_types.findIndex((record) => record.key === recordKey) ?? -1;
  const record = module?.record_types[recordIndex];
  const fieldIndex = record?.fields.findIndex((field) => field.key === fieldKey) ?? -1;
  const field = record?.fields[fieldIndex];
  if (module === undefined || record === undefined || field === undefined) return [];
  const qualifiedRecord = `${moduleKey}:${recordKey}`;
  const qualifiedNames = new Set([`${qualifiedRecord}.${fieldKey}`, field.id,
    ...record.relationships.filter((relationship) => relationship.from_field === fieldKey)
      .map((relationship) => `${qualifiedRecord}.${relationship.key}`)]);
  const ownRelationshipIndexes = new Set(record.relationships.flatMap((relationship, index) =>
    relationship.from_field === fieldKey ? [index] : []));
  const standard = standardPermissionKeys(moduleKey, recordKey);
  const found = new Map<string, InlineRecordTypeReference>();
  const add = (path: SourcePath, label?: string) => {
    const place = describeSourcePlace(source, path);
    const named = label === undefined ? place : { ...place, label };
    found.set(named.label, named);
  };
  const isSelf = (path: SourcePath): boolean =>
    path[1] === "modules" && path[2] === moduleIndex && path[3] === "record_types" && path[4] === recordIndex &&
    ((path[5] === "fields" && path[6] === fieldIndex) ||
      (path[5] === "relationships" && typeof path[6] === "number" && ownRelationshipIndexes.has(path[6])));
  const isStandardPolicy = (path: SourcePath): boolean => {
    if (path[1] !== "modules" || path[2] !== moduleIndex || path[3] !== "permissions" || typeof path[4] !== "number") return false;
    return standard.has(module.permissions[path[4]]!.key) && path[5] === "field_policy";
  };
  walkSourceStrings(source, [], (text, path) => {
    if (qualifiedNames.has(text) && !isSelf(path)) add(path);
  });
  // The local key, in the components that work on this record type.
  const scopes: Readonly<{ value: unknown; path: SourcePath }>[] = [
    { value: record, path: ["body", "modules", moduleIndex, "record_types", recordIndex] },
    ...(["permissions", "actions", "events", "flows", "extension_points", "sharing_conditions", "queries"] as const)
      .flatMap((section) => (module[section] as unknown[]).flatMap((item, index) =>
        componentScoped(item, recordKey, qualifiedRecord) ? [{ value: item, path: ["body", "modules", moduleIndex, section, index] }] : [])),
    ...(["pages", "pipelines", "flows"] as const).flatMap((section) => (source.body[section] as unknown[]).flatMap((item, index) =>
      componentScoped(item, undefined, qualifiedRecord) ? [{ value: item, path: ["body", section, index] }] : [])),
    ...(source.body.search?.record_types ?? []).flatMap((item, index) =>
      componentScoped(item, undefined, qualifiedRecord) ? [{ value: item, path: ["body", "search", "record_types", index] }] : []),
  ];
  for (const scope of scopes) {
    walkSourceStrings(scope.value, scope.path, (text, path, key) => {
      if (text !== fieldKey || !fieldProperty(key) || isSelf(path) || isStandardPolicy(path)) return;
      if (path[5] === "title_field" && path.length === 6) add(path, `${record.name} names each record by it (its title field)`);
      else add(path);
    });
    for (const path of mapKeyPaths(scope.value, fieldKey, scope.path)) add(path);
  }
  // A total of another record type adds up this field of its related records.
  source.body.modules.forEach((other, otherIndex) => other.record_types.forEach((otherRecord, otherRecordIndex) =>
    otherRecord.fields.forEach((candidate, candidateIndex) => {
      const settings = candidate.settings as { relationship?: string; field?: string };
      if (candidate.type === "total" && settings.field === fieldKey &&
          (otherIndex !== moduleIndex || otherRecordIndex !== recordIndex))
        add(["body", "modules", otherIndex, "record_types", otherRecordIndex, "fields", candidateIndex]);
    })));
  return [...found.values()];
};

/**
 * The Application source without one field of an owned inline Module. It is refused while anything
 * uses the field, and when the field is in a published version (its stored values stay). The
 * relationship a link field declares and its place in the standard permissions go with it.
 */
export const deleteInlineModuleField = (
  current: ApplicationSourceDocument, moduleKey: string, recordKey: string, fieldKey: string,
  publication: ModuleFieldPublication,
): InlineModuleFieldChangeResult | Readonly<{ kind: "referenced"; references: readonly InlineRecordTypeReference[] }> => {
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const record = module?.record_types.find((item) => item.key === recordKey);
  const field = record?.fields.find((item) => item.key === fieldKey);
  if (module === undefined || record === undefined || field === undefined)
    return { kind: "invalid", issues: ["The field is not in this record type any more."] };
  const references = inlineFieldReferences(current, moduleKey, recordKey, fieldKey);
  if (references.length > 0) return { kind: "referenced", references };
  if (publication.fields.has(`${moduleKey}:${recordKey}.${fieldKey}`))
    return { kind: "invalid", issues: [`${field.label} is in a published version, so it can't be removed: ` +
      "records already stored hold its values. Take it off the pages instead."] };
  if (record.fields.length === 1) return { kind: "invalid", issues: ["A record type needs at least one field."] };
  (record as { fields: Field[] }).fields = record.fields.filter((item) => item.key !== fieldKey);
  (record as { relationships: Relationship[] }).relationships = record.relationships.filter((item) => item.from_field !== fieldKey);
  const standard = standardPermissionKeys(moduleKey, recordKey);
  for (const permission of module.permissions) {
    if (!standard.has(permission.key) || permission.field_policy === undefined) continue;
    const policy = permission.field_policy as { readable_fields: string[]; changeable_fields: string[] };
    policy.readable_fields = policy.readable_fields.filter((key) => key !== fieldKey);
    policy.changeable_fields = policy.changeable_fields.filter((key) => key !== fieldKey);
  }
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  if (!parsed.success)
    return { kind: "invalid", issues: parsed.error.issues.map((issue) => `${issue.message} (${settingWords(issue.path.slice(1))})`) };
  return { kind: "changed", source: parsed.data, fieldAlias: field.id, fieldKey };
};

/** The Application source with one field moved earlier or later among its record type's fields. */
export const moveInlineModuleField = (
  current: ApplicationSourceDocument, moduleKey: string, recordKey: string, fieldKey: string, by: -1 | 1,
): InlineModuleFieldChangeResult => {
  const source = structuredClone(current);
  const record = source.body.modules.find((item) => item.key === moduleKey)?.record_types.find((item) => item.key === recordKey);
  const fields = record?.fields as Field[] | undefined;
  const at = fields?.findIndex((item) => item.key === fieldKey) ?? -1;
  if (fields === undefined || at < 0) return { kind: "invalid", issues: ["The field is not in this record type any more."] };
  if (at + by < 0 || at + by >= fields.length) return { kind: "invalid", issues: ["The field is already at that end."] };
  const [moved] = fields.splice(at, 1);
  fields.splice(at + by, 0, moved!);
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  if (!parsed.success)
    return { kind: "invalid", issues: parsed.error.issues.map((issue) => `${issue.message} (${settingWords(issue.path.slice(1))})`) };
  return { kind: "changed", source: parsed.data, fieldAlias: moved!.id, fieldKey };
};
