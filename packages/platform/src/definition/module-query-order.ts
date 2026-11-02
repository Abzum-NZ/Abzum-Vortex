import type { ApplicationSourceDocument } from "./application-source-contracts";

type Module = ApplicationSourceDocument["body"]["modules"][number];
type Query = Module["queries"][number];

/** One query that sorts by a field its record type does not allow sorting by. */
export type QuerySortProblem = Readonly<{
  moduleKey: string;
  queryKey: string;
  queryLabel: string;
  fieldKey: string;
  fieldLabel: string;
}>;

const queryName = (query: Query): string => query.label ?? query.key;

/**
 * The queries of one module that sort by `fieldKey` of a record type, other than through their own
 * grouping (a grouped query sorts by its groups). Writing is where this is enforced: reading never
 * refuses a stored draft or release, so a draft saved before the rule opens and shows the problem.
 */
export const queriesSortingBy = (
  module: Module,
  recordKey: string,
  fieldKey: string,
): readonly Query[] =>
  module.queries.filter(
    (query) =>
      query.record_type === recordKey &&
      !query.group_by.includes(fieldKey) &&
      query.sort.some((sort) => sort.field === fieldKey),
  );

/** Every query of the application that sorts by a field that does not allow sorting. */
export const querySortProblems = (source: ApplicationSourceDocument): readonly QuerySortProblem[] =>
  source.body.modules.flatMap((module) =>
    module.queries.flatMap((query) => {
      const fields = module.record_types.find((record) => record.key === query.record_type)?.fields;
      if (fields === undefined) return [];
      return query.sort.flatMap((sort) => {
        const field = fields.find((candidate) => candidate.key === sort.field);
        return field === undefined || field.sortable || query.group_by.includes(sort.field)
          ? []
          : [
              {
                moduleKey: module.key,
                queryKey: query.key,
                queryLabel: queryName(query),
                fieldKey: field.key,
                fieldLabel: field.label,
              },
            ];
      });
    }),
  );

/** The sentence for a query that sorts by a field that does not allow sorting. */
export const querySortProblemSentence = (problem: QuerySortProblem): string =>
  `${problem.queryLabel} sorts by ${problem.fieldLabel}, which does not allow sorting. Turn sorting on for ${problem.fieldLabel}, or change the sorting of ${problem.queryLabel}.`;

/** The refusal for turning sorting off on a field some queries still sort by. */
export const sortingOffRefusal = (queries: readonly Query[], fieldLabel: string): string => {
  const names = queries.map(queryName);
  const list =
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? "sorts" : "sort"} by ${fieldLabel}, so its sorting can't be turned off. Change the sorting of ${names.length === 1 ? "that query" : "those queries"} first.`;
};
