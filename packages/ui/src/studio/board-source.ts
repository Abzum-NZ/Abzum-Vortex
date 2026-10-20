import {
  boardAggregateLabel,
  queryNumericTotalFieldTypes,
  readRecordsTableFeatures,
  type ApplicationSourceDocument,
  type RecordsTableBoardFacts,
  type RecordsTableBoardMode,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { uniqueKey } from "./application-structure-common";
import { studioBoardFacts } from "./contextual-palette";
import type { StudioSettingChoices } from "./studio-setting-controls";

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

/** Card fields come from the selected pipeline's record type, before its query is written. */
export const boardSettingChoices = (
  choices: StudioSettingChoices,
  board: RecordsTableBoardMode | undefined,
): StudioSettingChoices => {
  const column = board?.columnField;
  const prefix = column === undefined ? undefined : column.slice(0, column.lastIndexOf(".") + 1);
  return {
    ...choices,
    fields:
      prefix === undefined
        ? []
        : choices.fields.filter((field) => field.reference.startsWith(prefix)),
  };
};

/** An existing authored move flow keeps its record type when the grid changes pipeline. */
export const boardMoveRecordTypeProblem = (
  source: ApplicationSourceDocument,
  alias: string,
  board: RecordsTableBoardMode,
): string | undefined => {
  if (board.columnField === undefined) return undefined;
  const recordType = board.columnField.slice(0, board.columnField.lastIndexOf("."));
  const bindings = source.body.flow_bindings.filter(
    (binding) => binding.control === alias && binding.event === "card_moved",
  );
  return bindings.some(
    (binding) =>
      source.body.events.find((event) => event.id === binding.event_id)?.record_type !== recordType,
  )
    ? "This grid has a card-move flow for another record type. Choose a pipeline of that record type, or add a new grid."
    : undefined;
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
  controlAlias?: string,
): readonly StudioBoardPipeline[] =>
  source.body.modules.flatMap((module) =>
    module.record_types.flatMap((record) =>
      record.pipelines.map((pipeline) => {
        const stage = record.fields.find((field) => field.key === pipeline.stage_field);
        const title = record.fields.find((field) => field.key === record.title_field);
        const reference = `${module.key}:${record.key}.${pipeline.stage_field}`;
        const moveProblem =
          controlAlias === undefined
            ? undefined
            : boardMoveRecordTypeProblem(source, controlAlias, {
                enabled: true,
                columnField: reference,
                cardFields: [],
                totals: [],
                quickAdd: false,
              });
        const selectable =
          stage?.type === "choice" &&
          stage.filterable &&
          title !== undefined &&
          moveProblem === undefined;
        return {
          reference,
          label: `${record.plural_name}: ${pipeline.name}`,
          titleField: title === undefined ? undefined : `${module.key}:${record.key}.${title.key}`,
          selectable,
          ...(selectable ? {} : { unavailableReason: moveProblem ?? stageFilterError }),
        };
      }),
    ),
  );

/** The draft query a qualified query reference names, with its Module and record type. */
const draftQueryOf = (source: ApplicationSourceDocument, queryReference: string) => {
  const separator = queryReference.indexOf(":");
  const module = source.body.modules.find(
    (candidate) => candidate.key === queryReference.slice(0, separator),
  );
  const query = module?.queries.find(
    (candidate) => candidate.key === queryReference.slice(separator + 1),
  );
  const record = module?.record_types.find((candidate) => candidate.key === query?.record_type);
  return module === undefined || query === undefined || record === undefined
    ? undefined
    : { module, query, record };
};

/**
 * Whether the query already groups by exactly the board's stage field, reads no linked records and
 * selects every field the board shows, so the board keeps the query it has.
 */
export const studioBoardQueryFits = (
  source: ApplicationSourceDocument,
  board: RecordsTableBoardMode,
  queryReference: string,
): boolean => {
  const draft = draftQueryOf(source, queryReference);
  if (draft === undefined) return true;
  const facts = studioBoardFacts(draft.module.key, draft.query, draft.record);
  const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
  const shown = [board.columnField, board.cardTitleField, ...board.cardFields];
  return (
    facts.groupBy.length === 1 &&
    same(facts.groupBy[0]!, board.columnField ?? "") &&
    facts.relationshipHops === 0 &&
    shown.every((field) => field !== undefined && facts.selected.some((held) => same(held, field)))
  );
};

/** The most totals a query holds, as the query contract allows. */
const queryMaximumTotals = 20;

/**
 * The alias of the sum a board total of a number field adds to its query: `sum_` and the field key,
 * shortened with a stable suffix when that would pass the 40 characters a query key may have.
 */
const boardSumAlias = (fieldKey: string): string => {
  const alias = `sum_${fieldKey}`;
  if (alias.length <= 40) return alias;
  let hash = 0x811c9dc5;
  for (const character of fieldKey) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  const suffix = (hash >>> 0).toString(36).padStart(7, "0").slice(-6);
  return `${alias.slice(0, 33).replace(/_+$/, "")}_${suffix}`;
};

/** One total a board column can show: a total of its query, or the sum of a number field. */
export type StudioBoardTotalChoice = Readonly<{
  alias: string;
  label: string;
  /** The key of the number field whose sum is added to the query when the board is saved. */
  sumOf?: string;
}>;

/**
 * What a column total can be chosen from: the query's own totals, then the sum of every number
 * field the query does not sum yet, while the query has room for one more total and the sum's
 * column name is used by neither a field nor another total.
 */
export const studioBoardTotalChoices = (
  facts: RecordsTableBoardFacts,
): readonly StudioBoardTotalChoice[] => {
  const keyOf = (reference: string): string => reference.slice(reference.lastIndexOf(".") + 1);
  const taken = new Set([
    ...facts.fields.map((field) => keyOf(field.field)),
    ...facts.aggregates.map((aggregate) => aggregate.alias),
  ]);
  const sums =
    facts.aggregates.length >= queryMaximumTotals
      ? []
      : facts.fields.flatMap((field) => {
          const alias = boardSumAlias(keyOf(field.field));
          return queryNumericTotalFieldTypes.has(field.type) &&
            !taken.has(alias) &&
            !facts.aggregates.some(
              (aggregate) => aggregate.operation === "sum" && aggregate.field === field.field,
            )
            ? [{ alias, label: boardAggregateLabel("sum", field.label), sumOf: keyOf(field.field) }]
            : [];
        });
  return [
    ...facts.aggregates.map((aggregate) => ({ alias: aggregate.alias, label: aggregate.label })),
    ...sums,
  ];
};

/**
 * Adds to the board's query the sum of every number field a column total chose by its sum alias,
 * so a total can be chosen from a number field itself. A total that names neither a query total
 * nor an offered sum is left for the capability check to refuse.
 */
export const ensureStudioBoardTotals = (
  source: ApplicationSourceDocument,
  board: RecordsTableBoardMode,
  queryReference: string,
): void => {
  const draft = draftQueryOf(source, queryReference);
  if (draft === undefined) return;
  for (const total of board.totals) {
    const facts = studioBoardFacts(draft.module.key, draft.query, draft.record);
    const sumOf = studioBoardTotalChoices(facts).find(
      (choice) => choice.alias === total.alias,
    )?.sumOf;
    if (sumOf !== undefined)
      draft.query.aggregates.push({ operation: "sum", field: sumOf, alias: total.alias });
  }
};

/**
 * Writes an ordinary unfiltered query grouped by the board's stage field, editable in Data like any
 * other query, or reuses one that already reads exactly the board's fields. When the board already
 * reads a query of the same record type and stage, the new query keeps that query's totals,
 * filter, inputs, sort, page size and selected fields and only adds what the board now shows, so
 * changing the card never drops the totals. Returns the query's reference, or the sentence saying
 * why no such query can be made.
 */
export const createStudioBoardQuery = (
  source: ApplicationSourceDocument,
  board: RecordsTableBoardMode,
  taken: ReadonlySet<string>,
  previous: string | null,
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
  const seed =
    previous === null || !previous.startsWith(`${module.key}:`)
      ? undefined
      : module.queries.find(
          (query) =>
            `${module.key}:${query.key}` === previous &&
            query.record_type === record.key &&
            query.group_by.length === 1 &&
            query.group_by[0] === stageKey &&
            query.relationship_hops === 0,
        );
  const existing =
    seed !== undefined
      ? undefined
      : module.queries.find(
          (query) =>
            query.record_type === record.key &&
            query.filter === null &&
            query.inputs.length === 0 &&
            query.group_by.length === 1 &&
            query.group_by[0] === stageKey &&
            query.relationship_hops === 0 &&
            query.aggregates.length === 0 &&
            selectsExactly(
              query.select.length === 0
                ? record.fields.map((candidate) => candidate.key)
                : query.select,
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
    inputs: seed === undefined ? [] : structuredClone(seed.inputs),
    select:
      seed === undefined
        ? selected
        : seed.select.length === 0
          ? []
          : [...new Set([...seed.select, ...selected])],
    filter: seed === undefined ? null : structuredClone(seed.filter),
    group_by: [stageKey!],
    aggregates: seed === undefined ? [] : structuredClone(seed.aggregates),
    sort:
      seed === undefined
        ? [{ field: stageKey!, direction: "ascending" }]
        : structuredClone(seed.sort),
    page_size: seed === undefined ? 40 : seed.page_size,
    relationship_hops: 0,
  });
  return { query: `${module.key}:${key}` };
};
