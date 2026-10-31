import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import { listing, lowerFirst, pageSize } from "./application-record-page-kinds";
import { freshAlias, type Plan } from "./application-record-plan";
import {
  companions,
  ensureDetailDelete,
  field,
  keyColumns,
  linkTablesToDetail,
  openButton,
  recordTables,
  release,
  resolveRecordType,
  tableColumns,
  type Query,
  type Resolved,
} from "./application-record-page-shared";
import type { StudioRecordPageCommand } from "./application-record-page-kinds";
import { STUDIO_ROW_ACTION_EVENT_SETTING, studioRowActionEventId } from "./contextual-palette";
import {
  blockItem,
  blockRelease,
  judged,
  pageData,
  placeNewPage,
  quoted,
  refuse,
  StructureRefusal,
  uniqueKey,
  type Source,
  type StudioStructureContext,
} from "./application-structure-common";
import type { SourceItem } from "@vortex/platform/schema";

const relatedTables = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
): SourceItem[] =>
  plan.source.body.modules.flatMap((module) =>
    module.record_types.flatMap((child) =>
      child.relationships
        .filter(
          (relationship) =>
            relationship.to_record_type === resolved.qualified &&
            relationship.cardinality === "many_to_one",
        )
        .flatMap((relationship) => {
          let childResolved: Resolved;
          try {
            childResolved = resolveRecordType(plan.source, `${module.key}:${child.key}`);
          } catch (error) {
            if (!(error instanceof StructureRefusal)) throw error;
            plan.details.push(
              `${child.plural_name} link here but are not listed: ${error.message}`,
            );
            return [];
          }
          const link = child.fields.find((entry) => entry.key === relationship.from_field);
          if (link === undefined || !childResolved.readable.has(link.key)) {
            plan.details.push(
              `${child.plural_name} link here but are not listed: their link field is not readable under their read permission.`,
            );
            return [];
          }
          // The table's query keeps the records whose link is this record, and a query can only keep
          // records by a field people can filter by.
          if (!link.filterable) {
            if (context.publishedFields.has(`${module.key}:${child.key}.${link.key}`)) {
              plan.details.push(
                `${child.plural_name} link here but are not listed: their ${quoted(link.label)} field can't be filtered by, and a published version fixed that.`,
              );
              return [];
            }
            (link as { filterable: boolean }).filterable = true;
            plan.details.push(
              `People can now filter ${child.plural_name.toLowerCase()} by ${quoted(link.label)}, so a table can list those of one ${lowerFirst(resolved.record.name)}.`,
            );
          }
          const input = resolved.record.key;
          const select = [
            ...keyColumns(child, childResolved.title, childResolved.readable)
              .map((entry) => entry.key)
              .filter((key) => key !== link.key),
            link.key,
          ];
          const existing = module.queries.find(
            (query) =>
              query.record_type === child.key &&
              query.inputs.length === 1 &&
              query.inputs[0]!.key === input &&
              JSON.stringify(query.filter) ===
                JSON.stringify({ field: link.key, operator: "equals", parameter: input }),
          );
          let query = existing;
          if (query === undefined) {
            if (module.queries.length >= 100) {
              plan.details.push(
                `${child.plural_name} link here but are not listed: ${quoted(module.name)} already holds 100 queries.`,
              );
              return [];
            }
            const key = uniqueKey(
              `${child.plural_name} of ${resolved.record.name}`,
              "",
              new Set(module.queries.map((entry) => entry.key)),
              40,
            );
            query = {
              id: freshAlias(plan, `qry_${key}`),
              key,
              label: `${child.plural_name} of one ${lowerFirst(resolved.record.name)}`,
              exposure: "private",
              record_type: child.key,
              inputs: [
                {
                  key: input,
                  label: resolved.record.name,
                  required: true,
                  type: "record_reference",
                  record_types: [resolved.qualified],
                },
              ],
              select,
              filter: { field: link.key, operator: "equals", parameter: input },
              group_by: [],
              aggregates: [],
              sort: [{ field: childResolved.title.key, direction: "ascending" }],
              page_size: pageSize,
              relationship_hops: 0,
            } as unknown as Query;
            module.queries.push(query);
          }
          const shown = child.fields.filter(
            (entry) =>
              query.select.includes(entry.key) &&
              entry.key !== link.key &&
              childResolved.readable.has(entry.key),
          );
          const viewPermission = childResolved.permission(plan.source, "read", plan.details);
          plan.details.push(
            `A table of the ${child.plural_name.toLowerCase()} whose ${link.label} is this ${lowerFirst(resolved.record.name)}, showing ${listing(shown.map((entry) => entry.label))}, seen only by people who can open ${child.plural_name.toLowerCase()}${existing === undefined ? ` (a new query ${quoted(query.label ?? query.key)})` : ""}.`,
          );
          return [
            blockItem(
              release(
                context,
                PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE,
                "records table",
              ),
              freshAlias(plan, `table_${child.key}_of_${resolved.record.key}`),
              {
                title: child.plural_name,
                empty_message: `No ${child.plural_name.toLowerCase()} link to this ${lowerFirst(resolved.record.name)} yet.`,
                columns: tableColumns(
                  (entry) => `${module.key}:${child.key}.${entry.key}`,
                  shown,
                  childResolved.title.key,
                ),
                query_parameters: [{ input, source: "page_parameter", name: "record_id" }],
              },
              {},
              { query: `${module.key}:${query.key}`, view_permission: viewPermission },
            ),
          ];
        }),
    ),
  );

/** The same ordinary Record detail block for a generated page and a record side sheet. */
export const studioRecordDetailItem = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: Source,
  reference: string,
  alias: string,
  recordFrom?: string,
): SourceItem => {
  const resolved = resolveRecordType(source, reference);
  const record = resolved.record;
  const detail = blockRelease(
    catalogue,
    PLATFORM_BLOCK_RELEASE_IDENTITIES.RECORD_DETAIL_BLOCK_RELEASE,
  );
  if (detail === undefined) return refuse("The block catalogue has no Record detail block.");
  return blockItem(
    detail,
    alias,
    {
      title: record.name,
      heading_source: "field",
      heading_field: field(resolved, resolved.title),
      [STUDIO_ROW_ACTION_EVENT_SETTING]: studioRowActionEventId(alias),
      ...(recordFrom === undefined ? {} : { record_from: recordFrom }),
      detail_fields: record.fields
        .filter((entry) => entry.type !== "attachment" && resolved.readable.has(entry.key))
        .map((entry) => ({ field: field(resolved, entry), label: entry.label })),
    },
    {},
  );
};

export const addDetail = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  command: StudioRecordPageCommand,
) => {
  const { record } = resolved;
  const shown = record.fields.filter(
    (entry) => entry.type !== "attachment" && resolved.readable.has(entry.key),
  );
  const detailAlias = freshAlias(plan, `detail_${record.key}`);
  const detail = studioRecordDetailItem(
    context.catalogue,
    plan.source,
    resolved.qualified,
    detailAlias,
  );
  const attachments = record.fields
    .filter((entry) => entry.type === "attachment" && resolved.readable.has(entry.key))
    .map((entry) =>
      blockItem(
        release(
          context,
          PLATFORM_BLOCK_RELEASE_IDENTITIES.ATTACHMENT_LIST_BLOCK_RELEASE,
          "attachment list",
        ),
        freshAlias(plan, `attachments_${record.key}_${entry.key}`),
        {
          title: entry.label.slice(0, 120),
          field: field(resolved, entry),
          empty_message: `Nothing is attached to ${entry.label} yet.`.slice(0, 200),
        },
        {},
      ),
    );
  const name = record.name.slice(0, 60);
  const related = relatedTables(context, plan, resolved);
  const placedPage = placeNewPage(
    plan.source,
    name,
    {
      type: "detail",
      record_type: resolved.qualified,
      permission: resolved.permission(plan.source, "read", plan.details),
    },
    pageData(context, plan.source, command.shellAlias, [detail, ...attachments, ...related], name),
    command.addToMenu,
  );
  plan.source = judged(placedPage.source);
  const page = placedPage.page;
  plan.details.unshift(
    `A page ${quoted(name)} that shows one ${lowerFirst(record.name)}, for people who can read ${record.plural_name.toLowerCase()}.`,
  );
  plan.details.splice(
    1,
    0,
    `A record detail shows ${listing(shown.map((entry) => entry.label))}.`,
    ...attachments.map(
      (item) => `An attachment list shows the files in ${String(item.props.title)}.`,
    ),
  );
  if (related.length === 0)
    plan.details.push(
      `No related tables: no record type of this application links to ${record.plural_name.toLowerCase()}.`,
    );
  const found = companions(plan.source, resolved.qualified);
  if (record.standard_actions.includes("update") && found.edit !== undefined) {
    openButton(
      context,
      plan,
      "Edit",
      resolved.permission(plan.source, "update", plan.details),
      found.edit,
      resolved,
      { beside: detailAlias },
    );
    plan.details.push(
      `An ${quoted("Edit")} button opens ${quoted(found.edit.name)} with this ${lowerFirst(record.name)}.`,
    );
  } else
    plan.details.push(
      `No Edit button yet: ${record.plural_name.toLowerCase()} have no edit form. Adding one puts the button here.`,
    );
  ensureDetailDelete(context, plan, resolved);
  linkTablesToDetail(
    context,
    plan,
    resolved,
    page,
    plan.source.body.pages.map((entry) => entry.id),
  );
  for (const module of plan.source.body.modules) {
    for (const target of module.record_types) {
      const qualified = `${module.key}:${target.key}`;
      const targetDetail = companions(plan.source, qualified).detail;
      if (
        targetDetail === undefined ||
        qualified === resolved.qualified ||
        recordTables(plan.source, page, { module, record: target }).length === 0
      )
        continue;
      linkTablesToDetail(context, plan, resolveRecordType(plan.source, qualified), targetDetail, [
        page.id,
      ]);
    }
  }
  return page;
};

/**
 * The fields a form of the record type asks for: those people change (not produced by the
 * platform), that the create or update permission lets them change, and that a form input draws.
 * A required field left out by either rule refuses the form, naming the field and the rule.
 */
