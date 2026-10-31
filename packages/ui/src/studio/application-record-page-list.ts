import { PLATFORM_BLOCK_RELEASE_IDENTITIES } from "@vortex/platform/schema";
import { listing, lowerFirst, type StudioRecordPageCommand } from "./application-record-page-kinds";
import { freshAlias, type Plan } from "./application-record-plan";
import {
  bindDelete,
  companions,
  ensureDetailDelete,
  ensureDetailEdit,
  ensureListEdit,
  field,
  keyColumns,
  listQuery,
  openButton,
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
  type StudioStructureContext,
} from "./application-structure-common";

export const addList = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  command: StudioRecordPageCommand,
  listName: string | undefined,
) => {
  const { record, title } = resolved;
  const wanted = keyColumns(record, title, resolved.readable);
  const query = listQuery(plan, resolved, wanted);
  const columns = wanted.filter((entry) => query.select.includes(entry.key));
  const tableAlias = freshAlias(plan, `table_${record.key}`);
  const table = blockItem(
    release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE, "records table"),
    tableAlias,
    {
      empty_message: `There are no ${record.plural_name.toLowerCase()} yet.`,
      columns: tableColumns((entry) => field(resolved, entry), columns, title.key),
    },
    {},
    { query: query.reference },
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
      query: query.reference,
    },
    pageData(context, plan.source, command.shellAlias, items, name),
    command.addToMenu,
  );
  plan.source = judged(placedPage.source);
  plan.details.unshift(
    `A page ${quoted(name)}, for people who can read ${record.plural_name.toLowerCase()}${command.addToMenu ? ", with a menu entry" : ""}.`,
  );
  plan.details.push(`A records table shows ${listing(columns.map((entry) => entry.label))}.`);
  const phoneColumns = (table.props.columns as ReturnType<typeof tableColumns>).filter(
    (entry) => entry.priority !== "medium",
  );
  if (phoneColumns.length < columns.length)
    plan.details.push(`On a phone it shows ${listing(phoneColumns.map((entry) => entry.label))}.`);
  const found = companions(plan.source, resolved.qualified);
  if (found.detail !== undefined) {
    openRows(plan, tableAlias, resolved, found.detail);
    plan.details.push(`Clicking a row opens ${quoted(found.detail.name)}.`);
  } else
    plan.details.push(
      `Rows open nothing yet: ${record.plural_name.toLowerCase()} have no detail page. Adding one makes rows open it.`,
    );
  if (record.standard_actions.includes("create") && found.create !== undefined) {
    const label = `New ${lowerFirst(record.name)}`;
    openButton(
      context,
      plan,
      label,
      resolved.permission(plan.source, "create", plan.details),
      found.create,
      undefined,
      { beside: tableAlias },
    );
    plan.details.push(`A ${quoted(label)} button opens ${quoted(found.create.name)}.`);
  } else
    plan.details.push(
      `No New button yet: ${record.plural_name.toLowerCase()} have no create form. Adding one puts the button here.`,
    );
  if (record.standard_actions.includes("soft_delete")) {
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
  ensureListEdit(context, plan, resolved);
  return placedPage.page;
};

/**
 * A table of each owned record type that links to this one, on its own query of the linked
 * records, seen only by people who can open that record type's pages. A record type whose pages
 * cannot be made (no title field, no read permission, an unreadable link field) or whose module
 * has no room for one more query is named and left out; the rest of the page is still made.
 */
