import {
  readRecordsTableFeatures,
  type ApplicationSourceDocument,
  type RecordsTableBoardMode,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { uniqueKey } from "./application-structure-common";
import { studioBoardFacts } from "./contextual-palette";

/** Why a pipeline whose stage field people cannot filter by cannot make columns. */
const stageFilterError =
  "Make this pipeline's stage field filterable in Data to use it for board columns.";

/** The refusal when the record type has no room for the query a board reads. */
const studioBoardQueryUnavailable =
  "This record type has reached its query limit. Remove an unused query in Data before turning Board on.";

/** The Board feature of a table's authored settings while it is on; undefined otherwise. */
export const boardModeOf = (
  settings: Readonly<Record<string, SourceBlockPropertyValueContract>>,
): RecordsTableBoardMode | undefined => {
  const features = readRecordsTableFeatures(settings["features"] as never);
  return features?.board.enabled ? features.board : undefined;
};

/** A pipeline the board can take its columns from, with the fields of its record type. */
export type StudioBoardPipeline = Readonly<{
  /** The stage field, as the qualified reference a block stores. */
  reference: string;
  label: string;
  /** The record type's title field, the card title a board starts with. */
  titleField: string | undefined;
  selectable: boolean;
  unavailableReason?: string;
}>;

/** Every pipeline of the draft's own Modules; one whose stage needs attention says why. */
export const studioBoardPipelines = (
  source: ApplicationSourceDocument,
): readonly StudioBoardPipeline[] =>
  source.body.modules.flatMap((module) =>
    module.record_types.flatMap((record) =>
      record.pipelines.map((pipeline) => {
        const stage = record.fields.find((field) => field.key === pipeline.stage_field);
        const title = record.fields.find((field) => field.key === record.title_field);
        const selectable = stage?.type === "choice" && stage.filterable && title !== undefined;
        return {
          reference: `${module.key}:${record.key}.${pipeline.stage_field}`,
          label: `${record.plural_name}: ${pipeline.name}`,
          titleField: title === undefined ? undefined : `${module.key}:${record.key}.${title.key}`,
          selectable,
          ...(selectable ? {} : { unavailableReason: stageFilterError }),
        };
      }),
    ),
  );

/**
 * Whether the query already groups by exactly the board's stage field, reads no linked records and
 * selects every field the board shows, so the board keeps the query it has.
 */
export const studioBoardQueryFits = (
  source: ApplicationSourceDocument,
  board: RecordsTableBoardMode,
  queryReference: string,
): boolean => {
  const separator = queryReference.indexOf(":");
  const module = source.body.modules.find(
    (candidate) => candidate.key === queryReference.slice(0, separator),
  );
  const query = module?.queries.find(
    (candidate) => candidate.key === queryReference.slice(separator + 1),
  );
  const record = module?.record_types.find((candidate) => candidate.key === query?.record_type);
  if (module === undefined || query === undefined || record === undefined) return true;
  const facts = studioBoardFacts(module.key, query, record);
  const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
  const shown = [board.columnField, board.cardTitleField, ...board.cardFields];
  return (
    facts.groupBy.length === 1 &&
    same(facts.groupBy[0]!, board.columnField ?? "") &&
    facts.relationshipHops === 0 &&
    shown.every((field) => field !== undefined && facts.selected.some((held) => same(held, field)))
  );
};

/**
 * Writes an ordinary unfiltered query grouped by the board's stage field, editable in Data like any
 * other query, or reuses one that already reads exactly the board's fields. Returns the query's
 * reference, or the sentence saying why no such query can be made.
 */
export const createStudioBoardQuery = (
  source: ApplicationSourceDocument,
  board: RecordsTableBoardMode,
  taken: ReadonlySet<string>,
): Readonly<{ query: string }> | Readonly<{ problem: string }> => {
  const pipeline = studioBoardPipelines(source).find(
    (candidate) => candidate.reference === board.columnField,
  );
  if (
    pipeline === undefined ||
    board.columnField === undefined ||
    board.cardTitleField === undefined
  )
    return { problem: "Choose a pipeline of this application" };
  if (!pipeline.selectable) return { problem: pipeline.unavailableReason ?? stageFilterError };
  const [moduleKey, rest] = board.columnField.split(":");
  const [recordKey, stageKey] = rest!.split(".");
  const module = source.body.modules.find((candidate) => candidate.key === moduleKey)!;
  const record = module.record_types.find((candidate) => candidate.key === recordKey)!;
  const qualifiedFieldKey = (reference: string): string | undefined => {
    const prefix = `${module.key}:${record.key}.`;
    return reference.startsWith(prefix) ? reference.slice(prefix.length) : undefined;
  };
  const requestedKeys = [board.columnField, board.cardTitleField, ...board.cardFields].map(
    (reference) => qualifiedFieldKey(reference),
  );
  if (requestedKeys.some((key) => key === undefined))
    return { problem: `Choose card fields of ${record.plural_name}` };
  const selected = [...new Set(requestedKeys.filter((key): key is string => key !== undefined))];
  const selectsExactly = (candidate: readonly string[]): boolean =>
    candidate.length === selected.length && selected.every((key) => candidate.includes(key));
  const existing = module.queries.find(
    (query) =>
      query.record_type === record.key &&
      query.filter === null &&
      query.inputs.length === 0 &&
      query.group_by.length === 1 &&
      query.group_by[0] === stageKey &&
      query.relationship_hops === 0 &&
      query.aggregates.length === 0 &&
      selectsExactly(
        query.select.length === 0 ? record.fields.map((candidate) => candidate.key) : query.select,
      ),
  );
  if (existing !== undefined) return { query: `${module.key}:${existing.key}` };
  if (module.queries.length >= 100) return { problem: studioBoardQueryUnavailable };
  const key = uniqueKey(
    `${record.key}_by_${stageKey}`,
    "",
    new Set(module.queries.map((query) => query.key)),
    40,
  );
  const id = uniqueKey(`qry_${key}`, "", taken, 160);
  module.queries.push({
    id,
    key,
    label: pipeline.label,
    exposure: "private",
    record_type: record.key,
    inputs: [],
    select: selected,
    filter: null,
    group_by: [stageKey!],
    aggregates: [],
    sort: [{ field: stageKey!, direction: "ascending" }],
    page_size: 40,
    relationship_hops: 0,
  });
  return { query: `${module.key}:${key}` };
};
