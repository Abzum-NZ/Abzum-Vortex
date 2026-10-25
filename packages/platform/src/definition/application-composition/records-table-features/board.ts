import { queryTotalLabel, queryTotalOperationLabels } from "../../module-query-edit";
import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalField,
  optionalNumber,
  requiredBoolean,
  requiredFieldList,
  requiredGroup,
  requiredItems,
  requiredText,
  type RecordsTableBoardFacts,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureDefinition,
  type RecordsTableFeatureState,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
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
  quickAdd: boolean;
}>;

/** The Board feature while it is on: what the board projection and its capability check read. */
export type RecordsTableBoardMode = Extract<
  RecordsTableFeatureState<RecordsTableBoardSettings>,
  { enabled: true }
>;

const refuse = (reason: string): Extract<RecordsTableFeatureCheck, { kind: "not_possible" }> =>
  featureNotPossible(featureRefusal, reason) as Extract<
    RecordsTableFeatureCheck,
    { kind: "not_possible" }
  >;
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "board",
  label: "Board",
  help: "Show the records as cards in columns, one for each stage of a pipeline",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
      card_fields: {
        kind: "list",
        items: [],
      },
      totals: {
        kind: "list",
        items: [],
      },
      quick_add: {
        kind: "boolean",
        value: false,
      },
    },
  },
  properties: [
    {
      kind: "boolean",
      key: "enabled",
      label: "On",
      help: "Show the grid as a board",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "field_reference",
      key: "column_field",
      label: "Column field",
      help: "The stage field of a pipeline: each of its stages is a column and moving a card changes its stage",
      required: false,
      fieldTypes: ["choice"],
    },
    {
      kind: "field_reference",
      key: "card_title_field",
      label: "Card title",
      help: "The field shown as each card's title",
      required: false,
    },
    {
      kind: "list",
      key: "card_fields",
      label: "Card fields",
      help: "Up to three more fields shown on each card",
      required: false,
      minimumItems: 0,
      maximumItems: 3,
      item: {
        kind: "field_reference",
        key: "field",
        label: "Field",
        help: "Field of the bound query shown on each card",
        required: true,
      },
      defaultValue: {
        kind: "list",
        items: [],
      },
    },
    {
      kind: "list",
      key: "totals",
      label: "Column totals",
      help: "Totals of the bound query shown in every column header, computed on the server",
      required: false,
      minimumItems: 0,
      maximumItems: 6,
      item: {
        kind: "group",
        key: "total",
        label: "Total",
        help: "One total of the bound query and its label",
        required: true,
        properties: [
          {
            kind: "text",
            key: "alias",
            label: "Query total",
            help: "Alias of a total declared by the bound query",
            required: true,
            minLength: 1,
            maxLength: 80,
          },
          {
            kind: "text",
            key: "label",
            presentation: true,
            label: "Label",
            help: "Label shown for this total",
            required: true,
            minLength: 1,
            maxLength: 60,
          },
        ],
      },
      defaultValue: {
        kind: "list",
        items: [],
      },
    },
    {
      kind: "number",
      key: "wip_limit",
      label: "Cards per column",
      help: "A column warns when it holds more cards than this",
      required: false,
      integer: true,
      minimum: 1,
      maximum: 1000,
    },
    {
      kind: "boolean",
      key: "quick_add",
      label: "Add from a column",
      help: "Each column offers adding a card there; the flow bound to a card being added opens the create form with the column's stage chosen",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_board",
  order: 39,
  message: "Board needs a stage field.",
  guidance:
    "Choose a query grouped by a stage field of a pipeline, and the card title and card fields it selects, or turn Board off.",
};
const boardRowActionRefusal: GridFeatureRefusal = {
  code: "definition_records_table_board_row_action",
  order: 39,
  message: "A board opens a card through one row action.",
  guidance: "Keep one row action that opens the record, or turn Board off to offer more.",
};

export const recordsTableBoardFeature: RecordsTableFeatureDefinition<
  RecordsTableBoardSettings,
  "board"
> = {
  key: "board",
  property: "board",
  settings: featureSettings,
  refusals: [featureRefusal, boardRowActionRefusal],
  onBoard: "own",
  events: { card_moved: {}, card_added: { offeredBy: "quick_add" } },
  label: "Board",
  description:
    "Show the records as cards in columns, one for each stage; move a card to change its stage",
  read: (group) => {
    if (!featureEnabled(group)) return { enabled: false };
    const totals = requiredItems(group["totals"], "totals").map((item, index) => {
      const at = `totals[${index}]`;
      const total = requiredGroup(item, at);
      return {
        alias: requiredText(total["alias"], `${at}.alias`),
        label: requiredText(total["label"], `${at}.label`),
      };
    });
    const columnField = optionalField(group["column_field"], "column_field");
    const cardTitleField = optionalField(group["card_title_field"], "card_title_field");
    const wipLimit = optionalNumber(group["wip_limit"], "wip_limit");
    return {
      enabled: true,
      ...(columnField === undefined ? {} : { columnField }),
      ...(cardTitleField === undefined ? {} : { cardTitleField }),
      cardFields: requiredFieldList(group["card_fields"], "card_fields"),
      totals,
      ...(wipLimit === undefined ? {} : { wipLimit }),
      quickAdd: requiredBoolean(group["quick_add"], "quick_add"),
    };
  },
  // A board's columns and moves come from the pipeline of its stage field, so the bound query must
  // be grouped by exactly that field. Every refusal names the part that does not fit.
  // A card opens through one row action.
  conflicts: (state, facts, { features }) =>
    state.enabled && features.rowActions.enabled && facts.table.rowActions.length !== 1
      ? featureNotPossible(boardRowActionRefusal)
      : undefined,
  check: (state, facts) => {
    const board = facts.board;
    if (board === undefined) return featureAvailable;
    if (!state.enabled)
      return board.stageFields.length > 0
        ? featureAvailable
        : featureNotPossible(
            featureRefusal,
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
        ? {
            choiceCount: options.length,
            choiceValues: options.flatMap((option) => {
              const value = record(option)?.["value"];
              return typeof value === "string" ? [value] : [];
            }),
          }
        : {}),
      ...(typeof record(field["settings"])?.["resultType"] === "string"
        ? { resultType: String(record(field["settings"])?.["resultType"]) }
        : {}),
    });
  }
  const aggregates: RecordsTableBoardFacts["aggregates"][number][] = [];
  for (const aggregate of query["aggregates"]) {
    const held = record(aggregate);
    if (
      typeof held?.["alias"] !== "string" ||
      typeof held["operation"] !== "string" ||
      !Object.hasOwn(queryTotalOperationLabels, held["operation"])
    )
      return undefined;
    const fieldId = held["fieldId"];
    aggregates.push({
      alias: held["alias"],
      operation: held["operation"],
      ...(typeof fieldId === "string" ? { field: fieldId } : {}),
      label: queryTotalLabel(
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
