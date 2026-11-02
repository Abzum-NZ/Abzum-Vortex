import {
  recordsTableColumnProblems,
  validateComponentSettings,
  queryTotalReferenceProblem,
  type ApplicationSourceDocument,
  type BlockPropertySchemaContract,
  type ComponentSettingFailure,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import {
  studioActionChoices,
  studioQueryChoices,
  studioRecordDataChoices,
  studioRelationshipChoices,
  studioSourceFields,
  studioSourceRecordTypes,
  type StudioActionChoice,
  type StudioBorrowedChoices,
  type StudioQueryChoice,
  type StudioQueryField,
  type StudioRelationshipChoice,
} from "./contextual-palette";
import type { StudioRecordReader } from "./studio-record-reference-control";

/** A typed authored setting value, or `undefined` for a setting left unset (its default applies). */
export type SettingValue = SourceBlockPropertyValueContract | undefined;
export type StudioSettingValues = Readonly<Record<string, SourceBlockPropertyValueContract>>;

/**
 * What reference settings can point at, all read from the draft being edited: the fields of the
 * block's data (or every field of its record types), its queries, pages, record types, module
 * actions and relationships. Records are not part of a draft: `records` reads them from
 * the builder's preview of the saved draft with their preview access, or is null where none can be read.
 */
export type StudioSettingChoices = Readonly<{
  fields: readonly StudioQueryField[];
  queries: readonly StudioQueryChoice[];
  recordQueries?: readonly StudioQueryChoice[];
  totals: StudioQueryChoice["totals"];
  pages: readonly Readonly<{ key: string; label: string }>[];
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  actions: readonly StudioActionChoice[];
  relationships: readonly StudioRelationshipChoice[];
  roles: readonly Readonly<{ key: string; label: string }>[];
  records: StudioRecordReader | null;
  /** The values the page of the selected block declares, which a display can show. */
  pageValues: readonly Readonly<{ key: string; label: string; currency?: string }>[];
}>;

/**
 * The one source of every reference picker: the draft being edited, never the installed release.
 * Its own Modules' queries, fields, record types, actions and relationships, its pages, and what the Modules it uses offer (read from their releases, as nothing of theirs is
 * in this draft).
 */
export const studioDraftChoices = (
  source: ApplicationSourceDocument,
  borrowed: StudioBorrowedChoices | null,
  records: StudioRecordReader | null,
  /** The business name of the application with this key, which borrowed choices are grouped by. */
  applicationName: (key: string) => string,
): StudioSettingChoices => {
  const named = <T extends Readonly<{ borrowedFrom?: string }>>(choice: T): T =>
    choice.borrowedFrom === undefined
      ? choice
      : { ...choice, borrowedFrom: applicationName(choice.borrowedFrom) };
  return {
    queries: studioQueryChoices(source, borrowed).map(named),
    recordQueries: studioRecordDataChoices(source),
    totals: [],
    fields: studioSourceFields(source),
    pages: source.body.pages.map((page) => ({ key: page.key, label: page.name })),
    recordTypes: studioSourceRecordTypes(source),
    actions: studioActionChoices(source, borrowed).map(named),
    relationships: studioRelationshipChoices(source, borrowed).map(named),
    roles: source.body.roles.map((role) => ({ key: role.key, label: role.name })),
    records,
    pageValues: [],
  };
};

/**
 * The choices of one block: a block that reads a query picks only that query's fields, and only
 * the relationships of the record type that query reads.
 */
export const studioBlockChoices = (
  draft: StudioSettingChoices,
  query: string | null,
): StudioSettingChoices => {
  const chosen =
    query === null
      ? undefined
      : [...draft.queries, ...(draft.recordQueries ?? [])].find(
          (candidate) => candidate.reference === query,
        );
  return query === null
    ? draft
    : {
        ...draft,
        fields: chosen?.fields ?? [],
        totals: chosen?.totals ?? [],
        relationships: draft.relationships.filter(
          (relationship) => relationship.recordType === chosen?.recordType,
        ),
      };
};

const familyText: Readonly<Record<ComponentSettingFailure["family"], string>> = {
  required_value: "needs a value",
  invalid_value: "is not valid",
  unsupported_choice: "has a choice this block does not offer",
  unknown_property: "is not a setting of this block",
  too_few_items: "needs more entries",
  too_many_items: "has too many entries",
  unsafe_content: "holds content that is not allowed",
};

/** The label path of a failure: each setting's label, and the entry number inside a list. */
const failurePlace = (
  properties: readonly BlockPropertySchemaContract[],
  path: readonly (string | number)[],
  family?: ComponentSettingFailure["family"],
): string => {
  const parts: string[] = [];
  let declarations: readonly BlockPropertySchemaContract[] | undefined = properties;
  let current: BlockPropertySchemaContract | undefined;
  for (const segment of path) {
    if (typeof segment === "number") {
      parts.push(`entry ${segment + 1}`);
      current = current?.kind === "list" ? current.item : undefined;
      declarations = current?.kind === "group" ? current.properties : undefined;
      continue;
    }
    current = declarations?.find((property) => property.key === segment);
    parts.push(current?.label ?? segment);
    declarations = current?.kind === "group" ? current.properties : undefined;
  }
  if (family === undefined) return parts.join(", ");
  if (family !== "required_value" || current?.showWhen === undefined)
    return `${parts.join(", ")} ${familyText[family]}.`;
  // A nested entry keeps its place, so the pre-check names which column needs the value.
  const owner = parts.slice(0, -1).join(", ");
  return owner === ""
    ? conditionalRequiredMessage(current)
    : `${owner}: ${conditionalRequiredMessage(current)}`;
};

/** A setting required by a selected choice asks for its value beside the control. */
export const conditionalRequiredMessage = (property: BlockPropertySchemaContract): string =>
  `Choose ${property.label.charAt(0).toLowerCase()}${property.label.slice(1)}.`;

/**
 * The fields a field reference may name: the block's fields, narrowed to the field types its
 * declaration allows. Publication refuses any other, so the picker never offers one.
 */
export const studioFittingFields = (
  property: BlockPropertySchemaContract,
  fields: readonly StudioQueryField[],
): readonly StudioQueryField[] =>
  property.kind === "field_reference" && property.fieldTypes !== undefined
    ? fields.filter((field) => (property.fieldTypes as readonly string[]).includes(field.type))
    : fields;

/** Why these settings would be refused, in words, one line per problem; empty when they pass. */
export const studioSettingProblems = (
  values: StudioSettingValues,
  properties: readonly BlockPropertySchemaContract[],
  choices?: Pick<StudioSettingChoices, "fields" | "totals">,
): readonly string[] => {
  const problems = validateComponentSettings(values, properties).map((failure) =>
    failurePlace(properties, failure.path, failure.family),
  );
  if (choices !== undefined) {
    const visit = (
      property: BlockPropertySchemaContract,
      value: SettingValue,
      path: readonly (string | number)[],
    ) => {
      // Binding fields belong to the page subject or parent row, and a row's related columns to
      // the related records query; their own checks judge them, not the block's data.
      if (property.key === "query_parameters" || property.key === "child_columns") return;
      if (property.kind === "total_reference" && value?.kind === "total_reference") {
        const problem = queryTotalReferenceProblem(property.label, value.value, choices.totals);
        if (problem !== undefined) problems.push(problem);
      }
      if (
        property.kind === "field_reference" &&
        value?.kind === "field_reference" &&
        !studioFittingFields(property, choices.fields).some(
          (field) => field.reference === value.field,
        )
      )
        problems.push(
          `${failurePlace(properties, path)} is not offered by the chosen data. Choose another field or remove this entry.`,
        );
      else if (property.kind === "group" && value?.kind === "group")
        for (const child of property.properties)
          visit(child, value.properties[child.key], [...path, child.key]);
      else if (property.kind === "list" && value?.kind === "list")
        value.items.forEach((item, index) => visit(property.item, item, [...path, index]));
    };
    // The shared binding check validates binding fields' scope and type in Studio and publication.
    for (const property of properties) visit(property, values[property.key], [property.key]);
  }
  // Only Records table columns declare field references and default visibility. A Table data
  // field also has a columns list, but its entries declare typed stored values instead.
  const columns = properties.find((property) => property.key === "columns");
  if (
    columns?.kind === "list" &&
    columns.item.kind === "group" &&
    columns.item.properties.some(
      (property) => property.key === "field" && property.kind === "field_reference",
    ) &&
    columns.item.properties.some(
      (property) => property.key === "visible" && property.kind === "boolean",
    )
  )
    problems.push(
      ...recordsTableColumnProblems(values["columns"]).map((problem) => problem.reason),
    );
  return [...new Set(problems)];
};

/** The value a new list entry starts with. */
export const initialValue = (
  property: BlockPropertySchemaContract,
  choices: StudioSettingChoices,
): SettingValue => {
  switch (property.kind) {
    case "total_reference":
      return choices.totals[0] === undefined
        ? undefined
        : { kind: "total_reference", value: choices.totals[0].alias };
    case "group":
      return { kind: "group", properties: {} };
    case "list":
      return { kind: "list", items: [] };
    case "text":
      return { kind: "text", value: "" };
    case "url":
      return { kind: "url", value: "" };
    case "number":
      return { kind: "number", value: property.minimum ?? 0 };
    case "boolean":
      return { kind: "boolean", value: false };
    case "choice":
      return property.options[0] === undefined
        ? undefined
        : { kind: "choice", value: property.options[0].key };
    case "field_reference": {
      const first = studioFittingFields(property, choices.fields)[0];
      return first === undefined ? undefined : { kind: "field_reference", field: first.reference };
    }
    case "query_reference":
      return choices.queries[0] === undefined
        ? undefined
        : { kind: "query_reference", query: choices.queries[0].reference };
    case "page_reference":
      return choices.pages[0] === undefined
        ? undefined
        : { kind: "page_reference", page: choices.pages[0].key };
    case "record_type_reference":
      return choices.recordTypes[0] === undefined
        ? undefined
        : { kind: "record_type_reference", record_type: choices.recordTypes[0].key };
    case "action_reference":
      return choices.actions[0] === undefined
        ? undefined
        : { kind: "action_reference", action: choices.actions[0].reference };
    case "relationship_reference":
      return choices.relationships[0] === undefined
        ? undefined
        : { kind: "relationship_reference", relationship: choices.relationships[0].reference };
    // A new entry of these starts only once the person writes its text or picks its record.
    case "rich_text":
    case "icon":
    case "record_reference":
    case "asset_reference":
      return undefined;
  }
};

export type ControlProps = Readonly<{
  id: string;
  descriptionId?: string | undefined;
  property: BlockPropertySchemaContract;
  value: SettingValue;
  onChange: (value: SettingValue) => void;
  choices: StudioSettingChoices;
  disabled: boolean;
}>;
