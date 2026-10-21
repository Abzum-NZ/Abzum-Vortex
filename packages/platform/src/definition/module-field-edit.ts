import { canonicalJson } from "./canonical-json";
import { fieldTypeKeys } from "../catalogue/catalogues";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";
import {
  deriveFieldAlias,
  deriveFieldKey,
  includeFieldInStandardPermissions,
  isStandardRecordPermission,
} from "./module-field-shape";
import { applicationUses, describeSourcePlace, type ApplicationUsePlace } from "./application-uses";
import { moduleFieldTypeLabels, type ModuleFieldType } from "./module-field-settings";
import {
  enablePeopleDirectoryLinks,
  linkCardinalities,
  isPersonLink,
  linkTargetModule,
  peopleDirectory,
  qualifiedLinkTarget,
  retirePeopleDirectoryLinks,
  type LinkCardinality,
  type PeopleDirectoryOwner,
} from "./module-links";
import { syncInlinePipelineStages } from "./module-pipeline-shape";
import { linkDependencyProblem, type LinkDependencyField } from "./module-link-dependencies";

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
  personalData: Field["personal_data"];
  publicDisplay: Field["public_display"];
  type: string;
  /** The complete plain settings the field contract stores for the type. */
  settings: Readonly<Record<string, unknown>>;
  /** The plain default value, or undefined for none. */
  defaultValue: unknown;
  /** How many records may link to one linked record: set for a link field, undefined otherwise. */
  cardinality: LinkCardinality | undefined;
}>;

export type InlineModuleFieldChangeResult =
  | Readonly<{
      kind: "changed";
      source: ApplicationSourceDocument;
      fieldAlias: string;
      fieldKey: string;
    }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>;

const moduleAliases = (module: InlineModule): Set<string> =>
  new Set(
    module.record_types.flatMap((item) => [
      item.id,
      ...item.fields.map((field) => field.id),
      ...item.relationships.map((relationship) => relationship.id),
    ]),
  );

const settingWords = (path: readonly PropertyKey[]): string =>
  path
    .map((segment) =>
      typeof segment === "number" ? `entry ${segment + 1}` : String(segment).replaceAll("_", " "),
    )
    .join(", ");

/**
 * The schema's refusals, each named by where it is: the field and the setting when it is about the
 * changed field, otherwise the place in the application.
 */
const locatedIssues = (
  source: ApplicationSourceDocument,
  issues: readonly { message: string; path: readonly PropertyKey[] }[],
  moduleIndex: number,
  recordIndex: number,
  fieldIndex: number,
  label: string,
): string[] => [
  ...new Set(
    issues.map((issue) => {
      const [, section, m, part, r, child, f, ...rest] = issue.path;
      if (
        section === "modules" &&
        m === moduleIndex &&
        part === "record_types" &&
        r === recordIndex &&
        child === "fields" &&
        f === fieldIndex
      )
        return rest.length === 0
          ? `${label}: ${issue.message}.`
          : `${label}, ${settingWords(rest)}: ${issue.message}.`;
      const place = describeSourcePlace(
        source,
        issue.path.filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number",
        ),
      );
      return `${place.label}: ${issue.message} (${settingWords(issue.path.slice(1))}).`;
    }),
  ),
];

/**
 * The relationship a link field declares, kept in step with the field: its target, its delete rule
 * and its cardinality. A field that is no link declares none.
 */
const syncLinkRelationship = (
  module: InlineModule,
  record: RecordType,
  field: Field,
  cardinality: LinkCardinality | undefined,
): void => {
  const relationships = record.relationships as Relationship[];
  const at = relationships.findIndex((relationship) => relationship.from_field === field.key);
  if (field.type !== "link" && field.type !== "link_to_one_of_several") {
    if (at >= 0) relationships.splice(at, 1);
    return;
  }
  const settings = field.settings as {
    target?: string;
    targets?: string[];
    on_parent_delete: Relationship["on_parent_delete"];
  };
  const target =
    field.type === "link"
      ? { to_record_type: settings.target }
      : { to_record_types: settings.targets };
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
    id: deriveFieldAlias(record.key, `${field.key}_relationship`, moduleAliases(module)),
    key,
    from_field: field.key,
    ...target,
    cardinality,
    on_parent_delete: settings.on_parent_delete,
  } as unknown as Relationship);
};

/** Why a link field's targets and cardinality can't be kept, or undefined when they can. */
const linkProblem = (
  source: ApplicationSourceDocument,
  module: InlineModule,
  change: InlineModuleFieldChange,
  label: string,
): string | undefined => {
  if (change.type !== "link" && change.type !== "link_to_one_of_several") return undefined;
  if (change.cardinality === undefined || !linkCardinalities.includes(change.cardinality))
    return `${label}: choose how many records may link to the same record.`;
  if (change.cardinality === "one_to_one" && !change.unique)
    return `${label}: when each linked record may have one link at most, tick "Each record has a different value".`;
  const settings = change.settings as { target?: unknown; targets?: unknown };
  const targets = (
    change.type === "link"
      ? [settings.target]
      : Array.isArray(settings.targets)
        ? settings.targets
        : []
  ).filter((target): target is string => typeof target === "string");
  const reachable = new Set([
    ...source.body.modules.map((item) => item.key),
    ...source.body.uses.map((use) => use.module),
    peopleDirectory.module,
  ]);
  for (const target of targets) {
    const owner = linkTargetModule(target);
    if (owner !== undefined && !reachable.has(owner))
      return `${label}: it links to ${target}, in a module this application neither owns nor uses. Choose one of the record types offered.`;
  }
  // A link back is named on the linked record type, so no two links to one record type, from
  // whichever owned record type, may share that name.
  const reverse = (change.settings as { reverse_key?: unknown }).reverse_key;
  const reverseName = (change.settings as { reverse_name?: unknown }).reverse_name;
  if (change.type === "link" && typeof settings.target === "string" && reverse !== undefined) {
    const target = qualifiedLinkTarget(module.key, settings.target);
    for (const other of source.body.modules)
      for (const linking of other.record_types) {
        const twin = linking.fields.find(
          (field) =>
            field.type === "link" &&
            !(
              other.key === module.key &&
              linking.id === change.recordAlias &&
              field.id === change.fieldAlias
            ) &&
            typeof (field.settings as { target?: unknown }).target === "string" &&
            qualifiedLinkTarget(other.key, (field.settings as { target: string }).target) ===
              target &&
            ((field.settings as { reverse_key?: unknown }).reverse_key === reverse ||
              (typeof reverseName === "string" &&
                (field.settings as { reverse_name: string }).reverse_name.toLowerCase() ===
                  reverseName.toLowerCase())),
        );
        if (twin !== undefined)
          return (
            `${label}: ${linking.name}'s ${twin.label} already links to the same record type with the link back "${String(reverseName)}". ` +
            "Give this link back another name."
          );
      }
  }
  return undefined;
};

/** A link field names the filter of its target; a choice field names only its parent. */
type LinkDependencyDeclaration = Readonly<{ parent_field: string; filter_field?: string }>;

/** A source record type's fields as the one link-dependency judgement reads them, by field key. */
const linkDependencyViews = (
  moduleKey: string,
  record: RecordType,
): readonly LinkDependencyField[] =>
  record.fields.map((field) => {
    const settings = field.settings as {
      target?: unknown;
      depends_on?: LinkDependencyDeclaration;
      options?: readonly { value: string; parent_values?: readonly string[] }[];
    };
    return {
      id: field.key,
      label: field.label,
      type: field.type,
      filterable: field.filterable,
      ...(field.type === "link" && typeof settings.target === "string"
        ? { target: qualifiedLinkTarget(moduleKey, settings.target) }
        : {}),
      ...(field.type === "choice" && settings.options !== undefined
        ? {
            options: settings.options.map((option) => ({
              value: option.value,
              ...(option.parent_values === undefined ? {} : { parentValues: option.parent_values }),
            })),
          }
        : {}),
      ...(settings.depends_on === undefined
        ? {}
        : {
            dependsOn: {
              parent: settings.depends_on.parent_field,
              ...(settings.depends_on.filter_field === undefined
                ? {}
                : { filter: settings.depends_on.filter_field }),
            },
          }),
    };
  });

/**
 * Why a record type's declared link dependencies cannot hold, or undefined when they can. A target
 * outside the owned Modules is judged when the application is published.
 */
const linkDependencyRefusal = (
  source: ApplicationSourceDocument,
  module: InlineModule,
  record: RecordType,
): string | undefined => {
  const views = linkDependencyViews(module.key, record);
  for (const view of views) {
    if (view.dependsOn === undefined) continue;
    const [targetModule, targetRecord] = (view.target ?? "").split(":");
    const target = source.body.modules
      .find((item) => item.key === targetModule)
      ?.record_types.find((item) => item.key === targetRecord);
    if (view.target !== undefined && target === undefined) continue;
    const problem = linkDependencyProblem(
      views,
      view.id,
      target === undefined ? undefined : linkDependencyViews(targetModule!, target),
    );
    if (problem !== undefined) return problem.message;
  }
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
  const recordIndex =
    module?.record_types.findIndex((item) => item.id === change.recordAlias) ?? -1;
  const record = module?.record_types[recordIndex];
  if (module === undefined || record === undefined)
    return { kind: "invalid", issues: ["The record type is not in this module any more."] };
  if (!(fieldTypeKeys as readonly string[]).includes(change.type))
    return { kind: "invalid", issues: [`"${change.type}" is not a field type.`] };
  const label = change.label.trim();
  if (label === "") return { kind: "invalid", issues: ["Enter the field's label."] };
  const helpText = change.helpText.trim();
  const qualifiedRecord = `${module.key}:${record.key}`;
  let fieldIndex =
    change.fieldAlias === undefined
      ? -1
      : record.fields.findIndex((item) => item.id === change.fieldAlias);
  if (change.fieldAlias !== undefined && fieldIndex < 0)
    return { kind: "invalid", issues: ["The field is not in this record type any more."] };
  // Names can change; the link back's identity is assigned once through the same derivation as fields.
  let settings = change.settings;
  if (change.type === "link") {
    const name = settings.reverse_name;
    if (typeof name !== "string" || name.trim() === "")
      return {
        kind: "invalid",
        issues: [`${label}: enter the name of the link back, for example Items.`],
      };
    const previous = record.fields[fieldIndex];
    const key =
      previous?.type === "link"
        ? (previous.settings as { reverse_key: string }).reverse_key
        : deriveFieldKey(name.trim(), new Set());
    if (key === undefined)
      return { kind: "invalid", issues: [`${label}: choose another name for the link back.`] };
    settings = { ...settings, reverse_name: name.trim(), reverse_key: key };
  }
  const refusedLink = linkProblem(source, module, { ...change, settings }, label);
  if (refusedLink !== undefined) return { kind: "invalid", issues: [refusedLink] };
  const shape = {
    type: change.type,
    settings,
    required: change.required,
    unique: change.unique,
    filterable: change.filterable,
    sortable: change.sortable,
    personal_data: change.personalData,
    public_display: change.publicDisplay,
  };
  let field: Field;
  let wasPersonLink = false;
  if (fieldIndex < 0) {
    if (change.required && publication.recordTypes.has(qualifiedRecord))
      return {
        kind: "invalid",
        issues: [
          `${record.name} is in a published version, so a field added to it can't be required: ` +
            "records already stored have no value for it. Add it as optional.",
        ],
      };
    const key = deriveFieldKey(label, new Set(record.fields.map((item) => item.key)));
    if (key === undefined)
      return {
        kind: "invalid",
        issues: ["The label must start with a letter so a key can be made from it."],
      };
    field = {
      id: deriveFieldAlias(record.key, key, moduleAliases(module)),
      key,
      label,
      ...(helpText === "" ? {} : { help_text: helpText }),
      ...shape,
      ...(change.defaultValue === undefined ? {} : { default: change.defaultValue }),
    } as unknown as Field;
    record.fields.push(field);
    fieldIndex = record.fields.length - 1;
    // A new field is readable, and changeable where people set it, through the standard permissions.
    includeFieldInStandardPermissions(module, record, { key, type: change.type as Field["type"] });
  } else {
    field = record.fields[fieldIndex]!;
    wasPersonLink = isPersonLink(field);
    if (publication.fields.has(`${qualifiedRecord}.${field.key}`)) {
      // The display name is editable even after publication; stored relationship settings are fixed.
      const storedSettings = (value: Readonly<Record<string, unknown>>) =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) => change.type !== "link" || key !== "reverse_name"),
        );
      const fixed = [
        ...(field.type === change.type ? [] : ["type"]),
        ...(canonicalJson(storedSettings(field.settings as Readonly<Record<string, unknown>>)) ===
          canonicalJson(storedSettings(settings)) || field.type !== change.type
          ? []
          : ["settings"]),
        ...(["required", "unique", "filterable", "sortable"] as const).filter(
          (key) => field[key] !== change[key],
        ),
        ...(field.type === change.type &&
        record.relationships.some(
          (relationship) =>
            relationship.from_field === field.key &&
            relationship.cardinality !== change.cardinality,
        )
          ? ["number of links"]
          : []),
      ];
      if (fixed.length > 0)
        return {
          kind: "invalid",
          issues: [
            `${field.label} is in a published version, so its ${fixed.join(", ")} can't change: ` +
              `records already stored keep them, and values are never converted. ${
                field.type === change.type
                  ? ""
                  : `To hold ${moduleFieldTypeLabels[change.type as ModuleFieldType].toLowerCase()} values, add a new field. `
              }` +
              "Its label, help text and default can still change.",
          ],
        };
    }
    // An option something still uses (an action, a flow step, a condition) is not removed.
    if (field.type === "choice") {
      const before = (field.settings as { options: { value: string; label: string }[] }).options;
      const after =
        change.type === "choice"
          ? ((change.settings as { options?: { value: string }[] }).options ?? [])
          : [];
      for (const option of before.filter(
        (entry) => !after.some((kept) => kept.value === entry.value),
      )) {
        const references = applicationUses(current, {
          kind: "choice_option",
          moduleKey: module.key,
          recordKey: record.key,
          fieldKey: field.key,
          option: option.value,
        });
        if (references.length > 0)
          return {
            kind: "invalid",
            issues: [
              `${label}: the option ${option.label} is used by ${references.map((reference) => reference.label).join(", ")}. ` +
                "Remove those uses before removing it.",
            ],
          };
      }
    }
    const destination = field as Record<string, unknown>;
    destination.label = label;
    if (helpText === "") delete destination.help_text;
    else destination.help_text = helpText;
    Object.assign(destination, shape);
    if (change.defaultValue === undefined) delete destination.default;
    else destination.default = change.defaultValue;
  }
  const refusedDependency = linkDependencyRefusal(source, module, record);
  if (refusedDependency !== undefined) return { kind: "invalid", issues: [refusedDependency] };
  syncLinkRelationship(module, record, field, change.cardinality);
  syncInlinePipelineStages(record, field.key);
  if (isPersonLink(field)) {
    const refused = enablePeopleDirectoryLinks(source, context.peopleDirectory);
    if (refused !== undefined) return { kind: "invalid", issues: [refused] };
  } else if (wasPersonLink) retirePeopleDirectoryLinks(source);
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  if (!parsed.success)
    return {
      kind: "invalid",
      issues: locatedIssues(
        source,
        parsed.error.issues,
        moduleIndex,
        recordIndex,
        fieldIndex,
        label,
      ),
    };
  return { kind: "changed", source: parsed.data, fieldAlias: field.id, fieldKey: field.key };
};

/**
 * The Application source without one field of an owned inline Module. It is refused while anything
 * uses the field, and when the field is in a published version (its stored values stay). The
 * relationship a link field declares and its place in the standard permissions go with it.
 */
export const deleteInlineModuleField = (
  current: ApplicationSourceDocument,
  moduleKey: string,
  recordKey: string,
  fieldKey: string,
  publication: ModuleFieldPublication,
):
  | InlineModuleFieldChangeResult
  | Readonly<{ kind: "referenced"; references: readonly ApplicationUsePlace[] }> => {
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const record = module?.record_types.find((item) => item.key === recordKey);
  const field = record?.fields.find((item) => item.key === fieldKey);
  if (module === undefined || record === undefined || field === undefined)
    return { kind: "invalid", issues: ["The field is not in this record type any more."] };
  const references = applicationUses(current, { kind: "field", moduleKey, recordKey, fieldKey });
  if (references.length > 0) return { kind: "referenced", references };
  // A dependency names its parent in its own record type and its filter in the linked record type,
  // so both sides are looked for across every owned record type.
  const recordType = `${moduleKey}:${recordKey}`;
  const dependent = source.body.modules
    .flatMap((other) =>
      other.record_types.flatMap((type) =>
        type.fields.map((item) => ({ module: other, type, item })),
      ),
    )
    .find(({ module: other, type, item }) => {
      const settings = item.settings as {
        target?: unknown;
        depends_on?: LinkDependencyDeclaration;
      };
      if (settings.depends_on === undefined) return false;
      return (
        (other.key === moduleKey &&
          type.key === recordKey &&
          settings.depends_on.parent_field === fieldKey) ||
        (typeof settings.target === "string" &&
          qualifiedLinkTarget(other.key, settings.target) === recordType &&
          settings.depends_on.filter_field === fieldKey)
      );
    })?.item;
  if (dependent !== undefined)
    return {
      kind: "invalid",
      issues: [`${dependent.label} depends on ${field.label}. Remove that dependency first.`],
    };
  if (publication.fields.has(`${moduleKey}:${recordKey}.${fieldKey}`))
    return {
      kind: "invalid",
      issues: [
        `${field.label} is in a published version, so it can't be removed: ` +
          "records already stored hold its values. Take it off the pages instead.",
      ],
    };
  if (record.fields.length === 1)
    return { kind: "invalid", issues: ["A record type needs at least one field."] };
  (record as { fields: Field[] }).fields = record.fields.filter((item) => item.key !== fieldKey);
  (record as { relationships: Relationship[] }).relationships = record.relationships.filter(
    (item) => item.from_field !== fieldKey,
  );
  for (const permission of module.permissions) {
    if (
      permission.record_type !== recordKey ||
      !isStandardRecordPermission(module, permission) ||
      permission.field_policy === undefined
    )
      continue;
    const policy = permission.field_policy as {
      readable_fields: string[];
      changeable_fields: string[];
    };
    policy.readable_fields = policy.readable_fields.filter((key) => key !== fieldKey);
    policy.changeable_fields = policy.changeable_fields.filter((key) => key !== fieldKey);
  }
  if (isPersonLink(field)) retirePeopleDirectoryLinks(source);
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  if (!parsed.success)
    return {
      kind: "invalid",
      issues: parsed.error.issues.map(
        (issue) => `${issue.message} (${settingWords(issue.path.slice(1))})`,
      ),
    };
  return { kind: "changed", source: parsed.data, fieldAlias: field.id, fieldKey };
};

/** The Application source with one field moved earlier or later among its record type's fields. */
export const moveInlineModuleField = (
  current: ApplicationSourceDocument,
  moduleKey: string,
  recordKey: string,
  fieldKey: string,
  by: -1 | 1,
): InlineModuleFieldChangeResult => {
  const source = structuredClone(current);
  const record = source.body.modules
    .find((item) => item.key === moduleKey)
    ?.record_types.find((item) => item.key === recordKey);
  const fields = record?.fields as Field[] | undefined;
  const at = fields?.findIndex((item) => item.key === fieldKey) ?? -1;
  if (fields === undefined || at < 0)
    return { kind: "invalid", issues: ["The field is not in this record type any more."] };
  if (at + by < 0 || at + by >= fields.length)
    return { kind: "invalid", issues: ["The field is already at that end."] };
  const [moved] = fields.splice(at, 1);
  fields.splice(at + by, 0, moved!);
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  if (!parsed.success)
    return {
      kind: "invalid",
      issues: parsed.error.issues.map(
        (issue) => `${issue.message} (${settingWords(issue.path.slice(1))})`,
      ),
    };
  return { kind: "changed", source: parsed.data, fieldAlias: moved!.id, fieldKey };
};
