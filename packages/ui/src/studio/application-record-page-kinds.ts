import type { Source } from "./application-structure-common";

/** The kinds of page a record type gets in one draft edit, and which of them its standard actions allow. */

export type StudioRecordPageKind =
  "list" | "board" | "detail" | "form_create" | "form_edit" | "guided";

export type StudioRecordPageCommand = Readonly<{
  kind: "add_record_page";
  /** The record type, qualified by its owned module: `module.key:record_key`. */
  recordType: string;
  type: StudioRecordPageKind;
  shellAlias: string | null;
  addToMenu: boolean;
  /**
   * A list page's own name; the record type's plural name when left out. A record type can have
   * several lists, each its own page with its own name.
   */
  name?: string | undefined;
}>;

export const studioRecordPageKinds: readonly Readonly<{
  kind: StudioRecordPageKind;
  label: string;
  hint: string;
}>[] = [
  {
    kind: "list",
    label: "List",
    hint: "A table of every record, with a New button; a row opens the record.",
  },
  {
    kind: "board",
    label: "Board",
    hint: "Cards in columns, one for each stage of a pipeline; dragging a card changes its stage.",
  },
  {
    kind: "detail",
    label: "Detail",
    hint: "One record's fields, an Edit button and the records that link to it.",
  },
  {
    kind: "form_create",
    label: "Create form",
    hint: "A form that saves a new record, then opens it.",
  },
  {
    kind: "form_edit",
    label: "Edit form",
    hint: "A form that saves changes to a record, then opens it.",
  },
  {
    kind: "guided",
    label: "Guided create form",
    hint: "The create form, a few fields per step, then a check and save step.",
  },
];

/** The record types a page can be made for: those of the modules this application owns. */
export const studioRecordPageChoices = (
  source: Source,
): readonly Readonly<{
  recordType: string;
  label: string;
  kinds: readonly StudioRecordPageKind[];
}>[] =>
  source.body.modules.flatMap((module) =>
    module.record_types.map((record) => ({
      recordType: `${module.key}:${record.key}`,
      label: `${record.plural_name} (${module.name})`,
      kinds: studioRecordPageKinds
        .filter(
          (entry) =>
            record.standard_actions.includes("read") &&
            (entry.kind === "form_create" || entry.kind === "guided"
              ? record.standard_actions.includes("create")
              : entry.kind === "form_edit"
                ? record.standard_actions.includes("update")
                : entry.kind === "board"
                  ? record.pipelines.length > 0
                  : true),
        )
        .map((entry) => entry.kind),
    })),
  );

/** Field types an automatic field input draws; any other type has no input to put in a form. */
export const inputTypes: ReadonlySet<string> = new Set([
  "text",
  "email_address",
  "phone_number",
  "web_address",
  "long_text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "choice",
  "several_choices",
  "link",
  "link_to_one_of_several",
  "table",
  "attachment",
]);
/** Field types a table column shows compactly. */
export const columnTypes: ReadonlySet<string> = new Set([
  "reference_number",
  "text",
  "email_address",
  "web_address",
  "phone_number",
  "choice",
  "link",
  "whole_number",
  "decimal_number",
  "money",
  "date",
  "date_time",
  "yes_no",
]);
export const columnLimit = 5;
export const fieldsPerStep = 3;
export const pageSize = 40;

export const lowerFirst = (name: string): string =>
  /^[A-Z][a-z]/.test(name) ? `${name[0]!.toLowerCase()}${name.slice(1)}` : name;
export const listing = (labels: readonly string[]): string =>
  labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!}`;

/** Every `id` in the source: a new block, query, step or flow alias is unique among them all. */
export const takenIds = (source: Source): Set<string> => {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string") names.add(record.id);
    Object.values(record).forEach(visit);
  };
  visit(source);
  return names;
};

export const kindWords: Readonly<Record<StudioRecordPageKind, string>> = {
  list: "list",
  board: "board",
  detail: "detail page",
  form_create: "create form",
  form_edit: "edit form",
  guided: "guided create form",
};
