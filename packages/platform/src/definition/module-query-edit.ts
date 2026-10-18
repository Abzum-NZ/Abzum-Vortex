import { builderKeySchema } from "../catalogue/identifiers";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";
import {
  applicationUses,
  describeSourcePlace,
  walkSourceStrings,
  type ApplicationUsePlace,
} from "./application-uses";

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];
type Field = RecordType["fields"][number];
/** One query of an owned inline Module, in its authored form. */
export type InlineQuery = InlineModule["queries"][number];
/** The authored filter of a query: a condition tree over its record type's fields and inputs. */
export type InlineQueryFilter = NonNullable<InlineQuery["filter"]>;
/** One input a query asks for, which its filter can compare a field with. */
export type InlineQueryInput = InlineQuery["inputs"][number];
export type InlineQueryAggregate = InlineQuery["aggregates"][number];
export type InlineQuerySort = InlineQuery["sort"][number];

/** A list page holds 40 records unless its query says otherwise, and never more than 200. */
export const defaultQueryPageSize = 40;
export const maximumQueryPageSize = 200;

/** Field types a query can group by: the database groups exactly these. */
export const queryGroupFieldTypes: ReadonlySet<string> = new Set([
  "text", "whole_number", "decimal_number", "yes_no", "date", "date_time", "choice", "reference_number",
  "email_address", "phone_number", "web_address", "link", "link_to_one_of_several",
]);
/** Field types a sum or an average adds up. */
export const queryNumericTotalFieldTypes: ReadonlySet<string> = new Set(["whole_number", "decimal_number", "money"]);
/** Field types a lowest or highest value is taken of. */
export const queryExtremeTotalFieldTypes: ReadonlySet<string> = new Set([
  "text", "whole_number", "decimal_number", "yes_no", "money", "date", "date_time",
]);

/** The fields of a total's operation it can be taken of; a count takes none. */
export const queryTotalAccepts = (operation: InlineQueryAggregate["operation"], fieldType: string): boolean =>
  operation === "count" ? false
    : operation === "sum" || operation === "average" ? queryNumericTotalFieldTypes.has(fieldType)
      : queryExtremeTotalFieldTypes.has(fieldType);

export const queryTotalOperationLabels = {
  count: "Number of records", sum: "Sum", average: "Average", minimum: "Lowest", maximum: "Highest",
} as const satisfies Record<InlineQueryAggregate["operation"], string>;

/** What a query edit makes of the Application source, or why it was refused, in plain words. */
export type InlineQueryResult =
  | Readonly<{ kind: "changed"; source: ApplicationSourceDocument; moduleKey: string; queryKey: string }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>;

const words = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** A permanent query key from its name, unique in its module. */
export const deriveQueryKey = (label: string, taken: ReadonlySet<string>): string | undefined => {
  const base = words(label).replace(/^[^a-z]+/, "").slice(0, 40).replace(/_+$/, "");
  if (!builderKeySchema.safeParse(base).success) return undefined;
  for (let n = 1; n < 1_000; n += 1) {
    const suffix = n === 1 ? "" : `_${n}`;
    const candidate = `${base.slice(0, 40 - suffix.length).replace(/_+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return undefined;
};

/** A total's column name from its operation and field, unique among the query's columns. */
export const deriveQueryTotalAlias = (operation: InlineQueryAggregate["operation"], field: string | undefined,
  taken: ReadonlySet<string>): string => {
  const base = (field === undefined ? `${operation}_records` : `${operation}_${field}`).slice(0, 36).replace(/_+$/, "");
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

const aliasesOf = (module: InlineModule): Set<string> => new Set([
  module.id,
  ...module.record_types.flatMap((record) => [record.id, record.storage_contract_id, ...record.fields.map((field) => field.id),
    ...record.relationships.map((relationship) => relationship.id)]),
  ...module.permissions.map((permission) => permission.id), ...module.actions.map((action) => action.id),
  ...module.events.map((event) => event.id), ...module.queries.map((query) => query.id),
]);

/** The record type a query of an owned Module reads, when it is one of the Module's own. */
export const inlineQueryRecordType = (module: InlineModule, query: InlineQuery): RecordType | undefined => {
  const reference = query.record_type;
  const local = reference.startsWith(`${module.key}:`) ? reference.slice(module.key.length + 1) : reference;
  return local.includes(":") ? undefined : module.record_types.find((record) => record.key === local);
};

const settingWords = (path: readonly PropertyKey[]): string =>
  path.map((segment) => typeof segment === "number" ? `entry ${segment + 1}` : String(segment).replaceAll("_", " ")).join(", ");

const querySections: Readonly<Record<string, string>> = {
  label: "Name", description: "Description", inputs: "Inputs", select: "Columns", filter: "Filter",
  group_by: "Grouping", aggregates: "Totals", sort: "Sorting", page_size: "Page size",
};

/** The schema's refusals, named by the query's section when they are about this query. */
const locatedIssues = (source: ApplicationSourceDocument, issues: readonly { message: string; path: readonly PropertyKey[] }[],
  moduleIndex: number, queryIndex: number, label: string): string[] =>
  [...new Set(issues.map((issue) => {
    const [, section, m, part, q, property, ...rest] = issue.path;
    if (section === "modules" && m === moduleIndex && part === "queries" && q === queryIndex) {
      const where = typeof property === "string" ? querySections[property] ?? settingWords([property]) : undefined;
      return where === undefined ? `${label}: ${issue.message}.`
        : `${label}, ${where}${rest.length === 0 ? "" : `, ${settingWords(rest)}`}: ${issue.message}.`;
    }
    const place = describeSourcePlace(source, issue.path.filter((segment): segment is string | number =>
      typeof segment === "string" || typeof segment === "number"));
    return `${place.label}: ${issue.message} (${settingWords(issue.path.slice(1))}).`;
  }))];

const parsed = (source: ApplicationSourceDocument, moduleKey: string, queryKey: string, label: string): InlineQueryResult => {
  const result = applicationSourceDocumentSchema.safeParse(source);
  if (result.success) return { kind: "changed", source: result.data, moduleKey, queryKey };
  const moduleIndex = source.body.modules.findIndex((module) => module.key === moduleKey);
  const queryIndex = source.body.modules[moduleIndex]?.queries.findIndex((query) => query.key === queryKey) ?? -1;
  return { kind: "invalid", issues: locatedIssues(source, result.error.issues, moduleIndex, queryIndex, label) };
};

/** Every field key a filter names, as a field operand. */
const filterFields = (filter: unknown): string[] => {
  const found: string[] = [];
  walkSourceStrings(filter, [], (text, path, key) => {
    if (key === "field" && !path.includes("value")) found.push(text);
  });
  return found;
};
/** Every input key a filter compares with. */
const filterParameters = (filter: unknown): string[] => {
  const found: string[] = [];
  walkSourceStrings(filter, [], (text, path, key) => {
    if (key === "parameter" && !path.includes("value")) found.push(text);
  });
  return found;
};

/**
 * What a query must hold to be published, checked against its own record type and said in the
 * words of the query editor's sections. The schema and the compiler check the rest.
 */
export const inlineQueryProblems = (record: RecordType, query: InlineQuery): string[] => {
  const problems: string[] = [];
  const byKey = new Map(record.fields.map((field) => [field.key, field]));
  const named = (key: string): string => byKey.get(key)?.label ?? key;
  const missing = (section: string, keys: readonly string[]) => {
    for (const key of keys) if (!byKey.has(key)) problems.push(`${section}: ${key} is not a field of ${record.name} any more.`);
  };
  const repeated = (section: string, keys: readonly string[]) => {
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) problems.push(`${section}: ${named(key)} is listed more than once.`);
      seen.add(key);
    }
  };
  if (query.select.length === 0) problems.push("Columns: choose at least one field to show.");
  missing("Columns", query.select);
  repeated("Columns", query.select);
  if (query.sort.length === 0) problems.push("Sorting: choose at least one field to sort by, so the order is always the same.");
  const sortKeys = query.sort.map((sort) => sort.field);
  missing("Sorting", sortKeys);
  repeated("Sorting", sortKeys);
  for (const key of sortKeys)
    if (byKey.get(key)?.sortable === false) problems.push(`Sorting: ${named(key)} is not sortable. Turn on "People can sort by it" on the field first.`);
  const filterKeys = filterFields(query.filter);
  missing("Filter", filterKeys);
  for (const key of new Set(filterKeys))
    if (byKey.get(key)?.filterable === false) problems.push(`Filter: ${named(key)} can't be filtered by. Turn on "People can filter by it" on the field first.`);
  const inputKeys = new Set(query.inputs.map((input) => input.key));
  for (const key of new Set(filterParameters(query.filter)))
    if (!inputKeys.has(key)) problems.push(`Filter: it compares with the input "${key}", which the query does not ask for.`);
  missing("Grouping", query.group_by);
  repeated("Grouping", query.group_by);
  for (const key of query.group_by) {
    const type = byKey.get(key)?.type;
    if (type !== undefined && !queryGroupFieldTypes.has(type)) problems.push(`Grouping: records can't be grouped by ${named(key)} (its type can't be grouped).`);
  }
  if (query.group_by.length > 0)
    for (const key of sortKeys)
      if (!query.group_by.includes(key)) problems.push(`Sorting: a grouped query sorts by its groups only. Sort by a grouping field instead of ${named(key)}.`);
  const columns = new Set(query.select);
  for (const [index, total] of query.aggregates.entries()) {
    const where = `Totals, entry ${index + 1}`;
    if (total.operation === "count") {
      if (total.field !== undefined) problems.push(`${where}: a number of records counts records, not a field.`);
    } else if (total.field === undefined) problems.push(`${where}: choose the field to take the ${total.operation} of.`);
    else {
      const field = byKey.get(total.field);
      if (field === undefined) problems.push(`${where}: ${total.field} is not a field of ${record.name} any more.`);
      else if (!queryTotalAccepts(total.operation, field.type))
        problems.push(`${where}: the ${queryTotalOperationLabels[total.operation].toLowerCase()} can't be taken of ${field.label}.`);
    }
    if (columns.has(total.alias)) problems.push(`${where}: its column name "${total.alias}" is already used by another column.`);
    columns.add(total.alias);
  }
  if (query.page_size < 1 || query.page_size > maximumQueryPageSize || !Number.isInteger(query.page_size))
    problems.push(`Page size: enter a whole number from 1 to ${maximumQueryPageSize}.`);
  const inputSeen = new Set<string>();
  for (const [index, input] of query.inputs.entries()) {
    if (inputSeen.has(input.key)) problems.push(`Inputs, entry ${index + 1}: another input already has the key "${input.key}".`);
    inputSeen.add(input.key);
  }
  return problems;
};

/** A new query of a record type, as a person names it. */
export type InlineQueryCreation = Readonly<{ moduleKey: string; recordKey: string; label: string; key: string }>;

/**
 * The Application source with one new query of a record type of an owned inline Module. It starts
 * as a plain list: the title field as its one column, sorted by it (or by the first sortable
 * field), no filter, groups or totals, 40 records a page.
 */
export const createInlineQuery = (current: ApplicationSourceDocument, creation: InlineQueryCreation): InlineQueryResult => {
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === creation.moduleKey);
  const record = module?.record_types.find((item) => item.key === creation.recordKey);
  if (module === undefined || record === undefined)
    return { kind: "invalid", issues: ["The record type is not in this application's modules any more."] };
  const label = creation.label.trim();
  const key = creation.key.trim();
  const issues: string[] = [];
  if (label === "" || label.length > 60) issues.push("Enter the query's name, at most 60 characters, for example Open companies.");
  if (!builderKeySchema.safeParse(key).success)
    issues.push("The key must start with a letter and use lowercase letters, digits and single underscores, at most 40 characters.");
  else if (module.queries.some((query) => query.key === key)) issues.push(`This module already has a query with the key "${key}".`);
  const title = record.fields.find((field) => field.key === record.title_field) ?? record.fields[0];
  const sorted: Field | undefined = title?.sortable === true ? title : record.fields.find((field) => field.sortable);
  if (sorted === undefined)
    issues.push(`A query needs a field to sort by, and no field of ${record.name} is sortable. Turn on "People can sort by it" on one first.`);
  if (issues.length > 0 || title === undefined || sorted === undefined) return { kind: "invalid", issues };
  const taken = aliasesOf(module);
  let id = `qry_${key}`;
  for (let n = 2; taken.has(id); n += 1) id = `qry_${key}_${n}`;
  (module.queries as InlineQuery[]).push({
    id, key, label, record_type: record.key, inputs: [], select: [title.key], filter: null, group_by: [], aggregates: [],
    sort: [{ field: sorted.key, direction: "ascending" }], page_size: defaultQueryPageSize, relationship_hops: 0,
  } as InlineQuery);
  return parsed(source, module.key, key, label);
};

/** What the query editor sets; the key, the record type and the relationship hops stay. */
export type InlineQueryChange = Pick<InlineQuery, "inputs" | "select" | "filter" | "group_by" | "aggregates" | "sort" | "page_size">
  & Readonly<{ label: string; description: string }>;

/** The Application source with one query of an owned inline Module changed as the query editor set it. */
export const changeInlineQuery = (
  current: ApplicationSourceDocument, moduleKey: string, queryKey: string, change: InlineQueryChange,
): InlineQueryResult => {
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const index = module?.queries.findIndex((query) => query.key === queryKey) ?? -1;
  const existing = module?.queries[index];
  if (module === undefined || existing === undefined)
    return { kind: "invalid", issues: ["The query is not in this application's modules any more."] };
  const label = change.label.trim();
  if (label === "" || label.length > 60) return { kind: "invalid", issues: ["Name: enter the query's name, at most 60 characters."] };
  const description = change.description.trim();
  const kept: Record<string, unknown> = { ...existing };
  delete kept.description;
  const next = {
    ...kept, label, ...(description === "" ? {} : { description }),
    inputs: structuredClone(change.inputs), select: [...change.select], filter: structuredClone(change.filter),
    group_by: [...change.group_by], aggregates: structuredClone(change.aggregates), sort: structuredClone(change.sort),
    page_size: change.page_size,
  } as InlineQuery;
  const record = inlineQueryRecordType(module, next);
  if (record !== undefined) {
    const problems = inlineQueryProblems(record, next);
    if (problems.length > 0) return { kind: "invalid", issues: problems };
  }
  (module.queries as InlineQuery[])[index] = next;
  return parsed(source, moduleKey, queryKey, label);
};

/** The Application source without one query of an owned Module; refused while anything uses it. */
export const deleteInlineQuery = (
  current: ApplicationSourceDocument, moduleKey: string, queryKey: string,
): InlineQueryResult | Readonly<{ kind: "referenced"; references: readonly ApplicationUsePlace[] }> => {
  const references = applicationUses(current, { kind: "query", moduleKey, queryKey });
  if (references.length > 0) return { kind: "referenced", references };
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const query = module?.queries.find((item) => item.key === queryKey);
  if (module === undefined || query === undefined)
    return { kind: "invalid", issues: ["The query is not in this application's modules any more."] };
  (module as { queries: InlineQuery[] }).queries = module.queries.filter((item) => item.key !== queryKey);
  return parsed(source, moduleKey, queryKey, query.label ?? queryKey);
};
