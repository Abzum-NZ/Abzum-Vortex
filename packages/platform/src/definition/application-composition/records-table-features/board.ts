import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  settingGroup,
  settingItems,
  settingText,
  fieldList,
  settingField,
  type RecordsTableBoardFacts,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureDefinition,
  type RecordsTableFeatureState,
} from "./shared";

/** A card shows its title and at most this many more fields. */
const RECORDS_TABLE_BOARD_MAXIMUM_CARD_FIELDS = 3;
/** The most columns a board shows: the options of its stage field. */
const RECORDS_TABLE_BOARD_MAXIMUM_COLUMNS = 12;
/** The largest number of cards one column may be limited to. */
const RECORDS_TABLE_BOARD_MAXIMUM_WIP_LIMIT = 1_000;

/**
 * Board: the grid shows its records as cards in columns, one column for each stage of a pipeline's
 * stage field. `columnField` is that stage field, `cardTitleField` the field shown as each card's
 * title, `cardFields` up to three more fields shown on the card, `totals` the bound query's own
 * aggregates shown in every column header, `wipLimit` the cards a column should not exceed and
 * `quickAdd` whether each column offers adding a card with its stage already chosen.
 * Each part is absent until the builder names it, which the check refuses.
 */
export type RecordsTableBoardSettings = Readonly<{
  columnField?: string;
  cardTitleField?: string;
  cardFields: readonly string[];
  totals: readonly Readonly<{ alias: string; label: string }>[];
  wipLimit?: number;
  /** Each stage column offers adding a card there, through the flow bound to a card being added. */
  quickAdd?: boolean;
}>;

/** The Board feature while it is on: what the board projection and its capability check read. */
export type RecordsTableBoardMode = Extract<
  RecordsTableFeatureState<RecordsTableBoardSettings>,
  { enabled: true }
>;

const aggregateOperationLabels: Readonly<Record<string, string>> = {
  count: "Count",
  sum: "Sum",
  minimum: "Lowest",
  maximum: "Highest",
  average: "Average",
  distinct_count: "Distinct count",
};

/** The business label a query total is offered under, such as "Sum of Value" or "Count of records". */
export const boardAggregateLabel = (operation: string, fieldLabel: string | undefined): string =>
  `${aggregateOperationLabels[operation] ?? operation} of ${fieldLabel ?? "records"}`;

const code = "definition_records_table_board" as const;
const refuse = (reason: string): Extract<RecordsTableFeatureCheck, { kind: "not_possible" }> =>
  Object.freeze({ kind: "not_possible", code, reason });
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

export const recordsTableBoardFeature: RecordsTableFeatureDefinition<RecordsTableBoardSettings> = {
  key: "board",
  label: "Board",
  description:
    "Show the records as cards in columns, one for each stage; move a card to change its stage",
  read: (group) => {
    if (featureEnabled(group) !== true) return { enabled: false };
    const totals = (settingItems(group["totals"]) ?? []).flatMap((item) => {
      const total = settingGroup(item);
      const alias = settingText(total?.["alias"]);
      const label = settingText(total?.["label"]);
      return alias === undefined || label === undefined ? [] : [{ alias, label }];
    });
    const columnField = settingField(group["column_field"]);
    const cardTitleField = settingField(group["card_title_field"]);
    const wipLimit = group["wip_limit"];
    const quickAdd = group["quick_add"];
    return {
      enabled: true,
      ...(columnField === undefined ? {} : { columnField }),
      ...(cardTitleField === undefined ? {} : { cardTitleField }),
      cardFields: fieldList(group["card_fields"]),
      totals,
      ...(wipLimit?.kind === "number" ? { wipLimit: wipLimit.value } : {}),
      ...(quickAdd?.kind === "boolean" ? { quickAdd: quickAdd.value } : {}),
    };
  },
  // A board's columns and moves come from the pipeline of its stage field, so the bound query must
  // be grouped by exactly that field. Every refusal names the part that does not fit.
  check: (state, facts) => {
    const board = facts.board;
    if (board === undefined) return featureAvailable;
    if (!state.enabled)
      return board.stageFields.length > 0
        ? featureAvailable
        : featureNotPossible(
            code,
            `Board needs a stage field: add a pipeline to a choice field of ${facts.recordTypeLabel || "the record type"} in Data.`,
          );
    return boardProblem(state, board) ?? featureAvailable;
  },
};

/**
 * Why a board cannot be read from the bound query as authored, as one business sentence, or
 * undefined when it can. Studio, publication and the server projection all call it.
 */
export const boardProblem = (
  state: RecordsTableBoardMode,
  board: RecordsTableBoardFacts,
): Extract<RecordsTableFeatureCheck, { kind: "not_possible" }> | undefined => {
  const labelOf = (field: string): string =>
    board.fields.find((candidate) => same(candidate.field, field))?.label ?? "A chosen field";
  if (state.columnField === undefined)
    return refuse("Choose the stage field that makes the columns.");
  const stage = board.fields.find((candidate) => same(candidate.field, state.columnField!));
  if (stage === undefined || stage.type !== "choice")
    return refuse(`${labelOf(state.columnField)} is not a choice field of ${board.queryLabel}.`);
  if (!board.stageFields.some((field) => same(field, stage.field)))
    return refuse(
      `${stage.label} has no pipeline: create one in Data to give the columns their stages, moves and rules.`,
    );
  if (!stage.filterable)
    return refuse(
      `${stage.label} cannot make columns until it is filterable: make it filterable in Data.`,
    );
  if (
    stage.choiceCount === undefined ||
    stage.choiceCount < 1 ||
    stage.choiceCount > RECORDS_TABLE_BOARD_MAXIMUM_COLUMNS
  )
    return refuse(
      `A board shows 1 to ${RECORDS_TABLE_BOARD_MAXIMUM_COLUMNS} columns, and ${stage.label} has ${stage.choiceCount ?? 0} stages.`,
    );
  if (
    board.groupBy.length !== 1 ||
    !same(board.groupBy[0]!, stage.field) ||
    board.relationshipHops !== 0
  )
    return refuse(
      `${board.queryLabel} must be grouped by ${stage.label} and read no linked records.`,
    );
  if (board.pageSize < 1 || board.pageSize > 200)
    return refuse(`${board.queryLabel} must read 1 to 200 cards at a time.`);
  if (state.cardTitleField === undefined)
    return refuse("Choose the field shown as each card's title.");
  if (state.cardFields.length > RECORDS_TABLE_BOARD_MAXIMUM_CARD_FIELDS)
    return refuse(
      `A card shows its title and at most ${RECORDS_TABLE_BOARD_MAXIMUM_CARD_FIELDS} more fields.`,
    );
  const shown = [state.cardTitleField, ...state.cardFields];
  if (new Set(shown.map((field) => field.toLowerCase())).size !== shown.length)
    return refuse("Choose each card field once.");
  for (const field of shown)
    if (!board.selected.some((candidate) => same(candidate, field)))
      return refuse(`${labelOf(field)} is not selected by ${board.queryLabel}.`);
  if (!board.selected.some((candidate) => same(candidate, stage.field)))
    return refuse(`${stage.label} is not selected by ${board.queryLabel}.`);
  const aliases = state.totals.map((total) => total.alias);
  if (new Set(aliases).size !== aliases.length) return refuse("Show each total once.");
  for (const alias of aliases)
    if (!board.aggregates.some((aggregate) => aggregate.alias === alias))
      return refuse(`${alias} is not a total of ${board.queryLabel}.`);
  if (
    state.wipLimit !== undefined &&
    (!Number.isInteger(state.wipLimit) ||
      state.wipLimit < 1 ||
      state.wipLimit > RECORDS_TABLE_BOARD_MAXIMUM_WIP_LIMIT)
  )
    return refuse(`Limit a column to 1 to ${RECORDS_TABLE_BOARD_MAXIMUM_WIP_LIMIT} cards.`);
  if (state.quickAdd === undefined)
    return refuse("Choose whether each column offers adding a card.");
  return undefined;
};

/**
 * The board facts of a query, a record type's fields and its pipelines as they are stored (a
 * compiled release or the installed Module), or undefined when any of them is malformed. Field
 * identities are the canonical identities.
 */
export const recordsTableBoardFactsOf = (
  queryCandidate: unknown,
  fieldsCandidate: readonly unknown[],
  pipelinesCandidate: readonly unknown[],
): RecordsTableBoardFacts | undefined => {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const query = record(queryCandidate);
  if (
    query === undefined ||
    !Array.isArray(query["selectedFieldIds"]) ||
    !Array.isArray(query["groupByFieldIds"]) ||
    !Array.isArray(query["aggregates"]) ||
    typeof query["relationshipHops"] !== "number" ||
    typeof query["pageSize"] !== "number" ||
    !Array.isArray(fieldsCandidate) ||
    !Array.isArray(pipelinesCandidate)
  )
    return undefined;
  const strings = (values: readonly unknown[]): string[] | undefined =>
    values.every((value) => typeof value === "string") ? (values as string[]) : undefined;
  const selected = strings(query["selectedFieldIds"]);
  const groupBy = strings(query["groupByFieldIds"]);
  if (selected === undefined || groupBy === undefined) return undefined;
  const fields: RecordsTableBoardFacts["fields"][number][] = [];
  for (const candidate of fieldsCandidate) {
    const field = record(candidate);
    if (field === undefined || typeof field["fieldId"] !== "string") return undefined;
    const options = record(field["settings"])?.["options"];
    fields.push({
      field: field["fieldId"],
      label: typeof field["label"] === "string" ? field["label"] : field["fieldId"],
      type: String(field["type"]),
      filterable: field["filterable"] === true,
      ...(field["type"] === "choice" && Array.isArray(options)
        ? { choiceCount: options.length }
        : {}),
    });
  }
  const aggregates: RecordsTableBoardFacts["aggregates"][number][] = [];
  for (const aggregate of query["aggregates"]) {
    const held = record(aggregate);
    if (typeof held?.["alias"] !== "string" || typeof held["operation"] !== "string")
      return undefined;
    const fieldId = held["fieldId"];
    aggregates.push({
      alias: held["alias"],
      operation: held["operation"],
      ...(typeof fieldId === "string" ? { field: fieldId } : {}),
      label: boardAggregateLabel(
        held["operation"],
        typeof fieldId === "string"
          ? fields.find((field) => field.field === fieldId)?.label
          : undefined,
      ),
    });
  }
  const stageFields: string[] = [];
  for (const candidate of pipelinesCandidate) {
    const stageFieldId = record(candidate)?.["stageFieldId"];
    if (typeof stageFieldId !== "string") return undefined;
    stageFields.push(stageFieldId);
  }
  return {
    queryLabel: typeof query["label"] === "string" ? query["label"] : "The query",
    fields,
    selected,
    groupBy,
    aggregates,
    relationshipHops: query["relationshipHops"],
    pageSize: query["pageSize"],
    stageFields,
  };
};
