import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  plainSettingValue,
  type RecordsTableBoardMode,
} from "@vortex/platform/schema";
import { listing, lowerFirst, type StudioRecordPageCommand } from "./application-record-page-kinds";
import { createStudioBoardQuery, studioBoardPipelines } from "./board-source";
import { flowCreate, freshAlias, type Plan } from "./application-record-plan";
import {
  bindDelete,
  companions,
  ensureDetailDelete,
  ensureDetailEdit,
  ensureListEdit,
  field,
  keyColumns,
  listQuery,
  openRows,
  release,
  tableColumns,
  type Resolved,
} from "./application-record-page-shared";
import {
  blockItem,
  judged,
  pageData,
  placeNewPage,
  quoted,
  refuse,
  type StudioStructureContext,
} from "./application-structure-common";

export const addList = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  command: StudioRecordPageCommand,
  listName: string | undefined,
  board?: true,
) => {
  const { record, title } = resolved;
  const wanted = keyColumns(record, title, resolved.readable);
  const pipeline =
    board === true
      ? studioBoardPipelines(plan.source).find((candidate) =>
          candidate.reference.startsWith(`${resolved.qualified}.`),
        )
      : undefined;
  if (
    board === true &&
    (pipeline === undefined || !pipeline.selectable || pipeline.titleField === undefined)
  )
    return refuse(
      pipeline?.unavailableReason ??
        "Add a pipeline on a choice field in Data first: a board's columns are its stages.",
    );
  const boardMode: RecordsTableBoardMode | undefined =
    pipeline === undefined || pipeline.titleField === undefined
      ? undefined
      : {
          enabled: true,
          columnField: pipeline.reference,
          cardTitleField: pipeline.titleField,
          cardFields: [],
          totals: [],
          quickAdd: false,
        };
  const boardQuery =
    boardMode === undefined
      ? undefined
      : createStudioBoardQuery(plan.source, boardMode, new Set(), null, []);
  let queryReference: string;
  let querySelect: readonly string[];
  if (boardQuery === undefined) {
    const query = listQuery(plan, resolved, wanted);
    queryReference = query.reference;
    querySelect = query.select;
  } else {
    if ("problem" in boardQuery) return refuse(boardQuery.problem);
    queryReference = boardQuery.query;
    querySelect = [];
    plan.details.push(
      `A query groups ${record.plural_name.toLowerCase()} by ${quoted(record.fields.find((entry) => `${resolved.module.key}:${record.key}.${entry.key}` === pipeline!.reference)!.label)}, the pipeline's stage.`,
    );
  }
  const columns =
    boardQuery === undefined
      ? wanted.filter((entry) => querySelect.includes(entry.key))
      : [
          title,
          ...(record.fields.filter(
            (entry) => `${resolved.module.key}:${record.key}.${entry.key}` === pipeline!.reference,
          ) as (typeof title)[]),
        ];
  const tableAlias = freshAlias(plan, `table_${record.key}`);
  const featuresProperty = release(
    context,
    PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE,
    "records table",
  ).properties.find((property) => property.key === "features");
  const found = companions(plan.source, resolved.qualified);
  const featureDefaults =
    featuresProperty?.defaultValue === undefined
      ? undefined
      : (plainSettingValue(featuresProperty.defaultValue) as Record<string, unknown>);
  // A list's summary row: how many there are, and the total of each money column it shows.
  const measures = [
    { field: field(resolved, title), operation: "count" },
    ...columns
      .filter((entry) => entry.type === "money")
      .slice(0, 5)
      .map((entry) => ({ field: field(resolved, entry), operation: "sum" })),
  ];
  const features =
    featureDefaults === undefined
      ? undefined
      : boardMode === undefined
        ? { ...featureDefaults, totals: { enabled: true, measures } }
        : {
            ...featureDefaults,
            board: {
              enabled: true,
              column_field: boardMode.columnField,
              card_title_field: boardMode.cardTitleField,
              card_fields: [],
              totals: [],
              quick_add: false,
            },
          };
  const addFromList =
    boardMode === undefined &&
    record.standard_actions.includes("create") &&
    found.create !== undefined;
  const table = blockItem(
    release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE, "records table"),
    tableAlias,
    {
      title: record.plural_name,
      purpose: `Every ${lowerFirst(record.name)} you can see in this organisation.`,
      ...(addFromList ? { inline_create: true, create_page: found.create!.key } : {}),
      empty_message: `There are no ${record.plural_name.toLowerCase()} yet.`,
      columns: tableColumns((entry) => field(resolved, entry), columns, title.key),
      ...(features === undefined ? {} : { features }),
    },
    {},
    { query: queryReference },
  );
  const name = listName ?? record.plural_name.slice(0, 60);
  const items = [
    blockItem(
      release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.HEADING_BLOCK_RELEASE, "heading"),
      freshAlias(plan, `heading_${record.key}`),
      { text: name, level: "two" },
      { actions: [] },
    ),
    table,
  ];
  const placedPage = placeNewPage(
    plan.source,
    name,
    {
      type: "list",
      record_type: resolved.qualified,
      permission: resolved.permission(plan.source, "read", plan.details),
      query: queryReference,
    },
    pageData(context, plan.source, command.shellAlias, items, name),
    command.addToMenu,
  );
  plan.source = judged(placedPage.source);
  plan.details.unshift(
    `A page ${quoted(name)}, for people who can read ${record.plural_name.toLowerCase()}${command.addToMenu ? ", with a menu entry" : ""}.`,
  );
  plan.details.push(
    boardMode === undefined
      ? `A records table shows ${listing(columns.map((entry) => entry.label))}.`
      : `The board's columns are the stages of ${quoted(pipeline!.label)}, and each card shows ${listing(columns.map((entry) => entry.label))}.`,
  );
  const phoneColumns = (table.props.columns as ReturnType<typeof tableColumns>).filter(
    (entry) => entry.priority !== "medium",
  );
  if (phoneColumns.length < columns.length)
    plan.details.push(`On a phone it shows ${listing(phoneColumns.map((entry) => entry.label))}.`);
  if (found.detail !== undefined) {
    openRows(plan, tableAlias, resolved, found.detail);
    plan.details.push(`Clicking a row opens ${quoted(found.detail.name)}.`);
  } else
    plan.details.push(
      `Rows open nothing yet: ${record.plural_name.toLowerCase()} have no detail page. Adding one makes rows open it.`,
    );
  if (boardMode !== undefined) {
    // A card drag runs the board's one move flow: it saves the card's new stage, so the pipeline and
    // the action owning a gated stage apply, the same flow the Board setting makes in Studio.
    flowCreate(
      plan,
      {
        kind: "action",
        controlAlias: tableAlias,
        name: "Move card",
        recordType: resolved.qualified,
        event: "card_moved",
      },
      `The card move of ${quoted(name)}`,
    );
    plan.details.push(
      `Dragging a card runs ${quoted("Move card")}: the card's stage is saved through the pipeline.`,
    );
  }
  plan.details.push(
    addFromList
      ? `The list has an ${quoted("Add " + lowerFirst(record.name))} button that opens ${quoted(found.create!.name)}.`
      : boardMode === undefined
        ? `No Add button yet: ${record.plural_name.toLowerCase()} have no create form. Adding one puts the button here.`
        : `Adding a card is done from the board's quick add.`,
  );
  if (record.standard_actions.includes("soft_delete") && boardMode === undefined) {
    bindDelete(
      plan,
      resolved,
      tableAlias,
      "row_action",
      { kind: "refresh" },
      {
        rowActionLabel: "Delete",
        rowActionCapability: "delete",
      },
    );
    plan.details.push(
      `Each row has a ${quoted("Delete")} action: it asks to confirm, deletes the ${lowerFirst(record.name)} and offers Undo.`,
    );
  }
  ensureDetailDelete(context, plan, resolved);
  ensureDetailEdit(context, plan, resolved);
  // A board opens a card through its row click; its one row action is the detail page's Edit.
  if (boardMode === undefined) ensureListEdit(context, plan, resolved);
  return placedPage.page;
};

/**
 * A table of each owned record type that links to this one, on its own query of the linked
 * records, seen only by people who can open that record type's pages. A record type whose pages
 * cannot be made (no title field, no read permission, an unreadable link field) or whose module
 * has no room for one more query is named and left out; the rest of the page is still made.
 */
