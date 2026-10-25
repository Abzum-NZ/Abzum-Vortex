import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";

type SearchSource = NonNullable<ApplicationSourceDocument["body"]["search"]>;
/** How one record type is found in the application's search, in its authored form. */
export type ApplicationSearchEntry = SearchSource["record_types"][number];
export type ApplicationSearchPriority = ApplicationSearchEntry["fields"][number]["priority"];

/**
 * Field types whose stored value carries searchable words, for Studio and the search index alike.
 * Links to records or people and yes/no values carry none, and attachments are searched only
 * through a separate file-search policy. Publication and runtime search check the recursive inputs
 * of calculated values and totals before disclosing them.
 */
export const searchableFieldTypes: ReadonlySet<string> = new Set([
  "text",
  "long_text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "date",
  "date_time",
  "choice",
  "several_choices",
  "reference_number",
  "email_address",
  "phone_number",
  "web_address",
  "table",
  "calculation",
  "total",
]);

/** Whether a field can be found in search: an indexed type, and not special personal data. */
export const fieldCanBeSearched = (
  field: Readonly<{ type: string; personalData: string }>,
): boolean =>
  searchableFieldTypes.has(field.type) &&
  (field.personalData === "none" || field.personalData === "personal");

export type ApplicationSearchResult =
  | Readonly<{ kind: "changed"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>;

const words = (path: readonly PropertyKey[]): string =>
  path
    .map((segment) =>
      typeof segment === "number" ? `entry ${segment + 1}` : String(segment).replaceAll("_", " "),
    )
    .join(", ");

const parsed = (source: ApplicationSourceDocument): ApplicationSearchResult => {
  const result = applicationSourceDocumentSchema.safeParse(source);
  return result.success
    ? { kind: "changed", source: result.data }
    : {
        kind: "invalid",
        issues: [
          ...new Set(
            result.error.issues.map(
              (issue) => `Search, ${words(issue.path.slice(2))}: ${issue.message}.`,
            ),
          ),
        ],
      };
};

/** The search settings of one record type, by its qualified reference (`module:record`). */
export const applicationSearchEntry = (
  source: ApplicationSourceDocument,
  recordReference: string,
): ApplicationSearchEntry | undefined =>
  source.body.search?.record_types.find((entry) => entry.record_type === recordReference);

/** Turns the application's search on or off; the record types it finds are kept. */
export const setApplicationSearchEnabled = (
  current: ApplicationSourceDocument,
  enabled: boolean,
): ApplicationSearchResult => {
  if (current.body.search === undefined)
    return {
      kind: "invalid",
      issues: ["Search: choose a record type people can find first, in its Search settings."],
    };
  const source = structuredClone(current);
  source.body.search!.enabled = enabled;
  return parsed(source);
};

/**
 * The Application source with one record type's search settings set, or removed when `entry` is
 * undefined. The search settings go when their last record type does. A field of a module this
 * application owns is marked for the search index with the priority it is found by.
 */
export const setApplicationSearchRecordType = (
  current: ApplicationSourceDocument,
  recordReference: string,
  entry: ApplicationSearchEntry | undefined,
): ApplicationSearchResult => {
  const source = structuredClone(current);
  const existing = source.body.search;
  const others = (existing?.record_types ?? []).filter(
    (item) => item.record_type !== recordReference,
  );
  if (entry === undefined) {
    if (others.length === 0) delete source.body.search;
    else source.body.search = { ...existing!, record_types: others };
    return parsed(source);
  }
  const issues: string[] = [];
  if (entry.record_type !== recordReference)
    issues.push("Search: the settings are for another record type.");
  if (entry.fields.length === 0)
    issues.push("Search: choose at least one field people can find the records by.");
  if (
    !source.body.pages.some(
      (page) =>
        page.type === "detail" &&
        page.record_type === recordReference &&
        page.key === entry.target_page,
    )
  )
    issues.push("Search, opens: choose the detail page a search result opens.");
  if (issues.length > 0) return { kind: "invalid", issues };
  const position =
    existing?.record_types.findIndex((item) => item.record_type === recordReference) ?? -1;
  const record_types = [...others];
  record_types.splice(position < 0 ? record_types.length : position, 0, structuredClone(entry));
  source.body.search = { enabled: existing?.enabled ?? true, record_types };
  // The module marks the fields it indexes: an owned field gets the priority it is found by.
  const separator = recordReference.indexOf(":");
  const module = source.body.modules.find(
    (item) => item.key === recordReference.slice(0, separator),
  );
  const record = module?.record_types.find(
    (item) => item.key === recordReference.slice(separator + 1),
  );
  if (record !== undefined) {
    const priorities = new Map(entry.fields.map((field) => [field.field, field.priority] as const));
    for (const reference of [
      entry.title_field,
      ...(entry.subtitle_field === undefined ? [] : [entry.subtitle_field]),
    ])
      if (!priorities.has(reference)) priorities.set(reference, "normal");
    for (const field of record.fields) {
      const priority = priorities.get(`${recordReference}.${field.key}`);
      if (priority === undefined) continue;
      const target = field as { search_priority?: ApplicationSearchPriority };
      if (!fieldCanBeSearched({ type: field.type, personalData: field.personal_data })) {
        issues.push(
          `Search: ${field.label} can't be found in search (its type or personal data class is not indexed).`,
        );
        continue;
      }
      target.search_priority = entry.fields.some(
        (item) => item.field === `${recordReference}.${field.key}`,
      )
        ? priority
        : (target.search_priority ?? "normal");
    }
  }
  if (issues.length > 0) return { kind: "invalid", issues };
  return parsed(source);
};
