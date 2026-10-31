import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  sourcePageItems,
  type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import { listing, lowerFirst, pageSize } from "./application-record-page-kinds";
import { studioBoardPipelines } from "./board-source";
import { freshAlias, type Plan } from "./application-record-plan";
import {
  companions,
  ensureDetailDelete,
  ensureDetailEdit,
  field,
  keyColumns,
  linkTablesToDetail,
  release,
  resolveRecordType,
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

/** One related list card of the record detail block, in the block's own setting shape. */
type RelatedList = Readonly<{
  key: string;
  title: string;
  query: string;
  parent_input: string;
  columns: readonly Readonly<{ field: string }>[];
  add_page?: string;
  add_field?: string;
}>;

const relatedLists = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
): RelatedList[] => {
  const lists: RelatedList[] = [];
  for (const module of plan.source.body.modules)
    for (const child of module.record_types)
      for (const relationship of child.relationships.filter(
        (entry) =>
          entry.to_record_type === resolved.qualified && entry.cardinality === "many_to_one",
      )) {
        let childResolved: Resolved;
        try {
          childResolved = resolveRecordType(plan.source, `${module.key}:${child.key}`);
        } catch (error) {
          if (!(error instanceof StructureRefusal)) throw error;
          plan.details.push(`${child.plural_name} link here but are not listed: ${error.message}`);
          continue;
        }
        const link = child.fields.find((entry) => entry.key === relationship.from_field);
        if (link === undefined || !childResolved.readable.has(link.key)) {
          plan.details.push(
            `${child.plural_name} link here but are not listed: their link field is not readable under their read permission.`,
          );
          continue;
        }
        // The table's query keeps the records whose link is this record, and a query can only keep
        // records by a field people can filter by.
        if (!link.filterable) {
          if (context.publishedFields.has(`${module.key}:${child.key}.${link.key}`)) {
            plan.details.push(
              `${child.plural_name} link here but are not listed: their ${quoted(link.label)} field can't be filtered by, and a published version fixed that.`,
            );
            continue;
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
            continue;
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
        childResolved.permission(plan.source, "read", plan.details);
        plan.details.push(
          `A related list card of the ${child.plural_name.toLowerCase()} whose ${link.label} is this ${lowerFirst(resolved.record.name)}, showing ${listing(shown.map((entry) => entry.label))}, seen only by people who can open ${child.plural_name.toLowerCase()}${existing === undefined ? ` (a new query ${quoted(query.label ?? query.key)})` : ""}.`,
        );
        const create = companions(plan.source, childResolved.qualified).create;
        if (create === undefined)
          plan.details.push(
            `No Add button for ${child.plural_name.toLowerCase()}: they have no create form yet.`,
          );
        else
          plan.details.push(
            `The card's ${quoted("Add " + child.name.toLowerCase())} button opens ${quoted(create.name)} with this ${lowerFirst(resolved.record.name)}, so the new ${lowerFirst(child.name)} is linked to it.`,
          );
        lists.push({
          key: uniqueKey(child.key, "", new Set(lists.map((entry) => entry.key)), 40),
          title: child.plural_name,
          query: `${module.key}:${query.key}`,
          parent_input: input,
          columns: shown.map((entry) => ({ field: `${module.key}:${child.key}.${entry.key}` })),
          ...(create === undefined
            ? {}
            : { add_page: create.key, add_field: `${module.key}:${child.key}.${link.key}` }),
        });
      }
  return lists;
};

/**
 * The "Add <record>" action on every related list card of the application that lists this record
 * type, added when its create form is made after the parent's detail page: whichever page is made
 * second brings the action.
 */
export const ensureRelatedAdds = (plan: Plan, childResolved: Resolved): void => {
  const create = companions(plan.source, childResolved.qualified).create;
  if (create === undefined) return;
  const source = judged(plan.source);
  for (const page of source.body.pages) {
    if (page.type !== "detail") continue;
    for (const shown of sourcePageItems(page.composition)) {
      if (String(shown.type) !== "platform.renderer.record_detail") continue;
      const lists = shown.props.related_lists;
      if (!Array.isArray(lists)) continue;
      for (const list of lists as Record<string, unknown>[]) {
        if (list.add_page !== undefined || typeof list.query !== "string") continue;
        const module = source.body.modules.find((entry) =>
          entry.queries.some((query) => `${entry.key}:${query.key}` === list.query),
        );
        const query = module?.queries.find((entry) => `${module.key}:${entry.key}` === list.query);
        const filter = query?.filter as { field?: string } | undefined;
        if (module === undefined || query?.record_type !== childResolved.record.key) continue;
        if (typeof filter?.field !== "string") continue;
        list.add_page = create.key;
        list.add_field = `${module.key}:${query.record_type}.${filter.field}`;
        plan.details.push(
          `The ${quoted(String(list.title))} card on ${quoted(page.name)} has an ${quoted("Add " + childResolved.record.name.toLowerCase())} button that opens ${quoted(create.name)}.`,
        );
      }
    }
  }
  plan.source = judged(source);
};

/** The same ordinary Record detail block for a generated page and a record side sheet. */ export const studioRecordDetailItem =
  (
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
    // Key facts beside the heading: the first three money, choice or date fields people can read.
    const keyFacts = record.fields
      .filter(
        (entry) =>
          ["money", "choice", "date", "date_time"].includes(entry.type) &&
          resolved.readable.has(entry.key) &&
          entry.key !== resolved.title.key,
      )
      .slice(0, 3);
    const stage = studioBoardPipelines(source).find(
      (candidate) =>
        candidate.selectable && candidate.reference.startsWith(`${resolved.qualified}.`),
    );
    return blockItem(
      detail,
      alias,
      {
        title: record.name,
        ...(keyFacts.length === 0
          ? {}
          : { header_fields: keyFacts.map((entry) => ({ field: field(resolved, entry) })) }),
        ...(stage === undefined ? {} : { stage_field: stage.reference }),
        heading_source: "field",
        heading_field: field(resolved, resolved.title),
        [STUDIO_ROW_ACTION_EVENT_SETTING]: studioRowActionEventId(alias),
        ...(recordFrom === undefined ? {} : { record_from: recordFrom }),
        sections: [
          {
            key: "details",
            title: "Details",
            // A field shows once: the header's key facts and the stage strip are not repeated here.
            fields: record.fields
              .filter(
                (entry) =>
                  entry.type !== "attachment" &&
                  resolved.readable.has(entry.key) &&
                  !keyFacts.includes(entry) &&
                  field(resolved, entry) !== stage?.reference,
              )
              .map((entry) => ({ field: field(resolved, entry), label: entry.label })),
          },
        ],
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
  const related = relatedLists(context, plan, resolved);
  if (related.length > 0) detail.props.related_lists = related;
  const placedPage = placeNewPage(
    plan.source,
    name,
    {
      type: "detail",
      record_type: resolved.qualified,
      permission: resolved.permission(plan.source, "read", plan.details),
    },
    pageData(context, plan.source, command.shellAlias, [detail, ...attachments], name),
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
  if (record.standard_actions.includes("update") && found.edit !== undefined)
    ensureDetailEdit(context, plan, resolved);
  else
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
  return page;
};

/**
 * The fields a form of the record type asks for: those people change (not produced by the
 * platform), that the create or update permission lets them change, and that a form input draws.
 * A required field left out by either rule refuses the form, naming the field and the rule.
 */
