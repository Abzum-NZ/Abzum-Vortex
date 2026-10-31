import { PLATFORM_BLOCK_RELEASE_IDENTITIES, type SourceItem } from "@vortex/platform/schema";
import { takenIds } from "./application-record-page-kinds";
import {
  field,
  keyColumns,
  release,
  resolveRecordType,
  tableColumns,
  type Resolved,
} from "./application-record-page-shared";
import { freshAlias, type Plan } from "./application-record-plan";
import {
  blockItem,
  judged,
  quoted,
  refuse,
  StructureRefusal,
  uniqueKey,
  type Page,
  type StudioStructureContext,
} from "./application-structure-common";

/**
 * A generated home dashboard keeps one card count, one recent-records table and, where the record
 * type has a pipeline with a money field, one open-amount-by-stage chart per record type. Every
 * block is an ordinary block reading an ordinary query, so the builder can edit or remove it.
 */
const homeBlockQueries = (page: Page): ReadonlySet<string> =>
  new Set(
    (page.composition as { content?: SourceItem[] }).content?.flatMap((item) =>
      typeof item.props.vortex.query === "string" ? [item.props.vortex.query] : [],
    ) ?? [],
  );

const countQuery = (plan: Plan, resolved: Resolved): string => {
  const { module, record, title } = resolved;
  const key = uniqueKey(`${record.key}_count`, "", new Set(module.queries.map((q) => q.key)), 40);
  const existing = module.queries.find((query) => query.key === key);
  if (existing !== undefined) return `${module.key}:${existing.key}`;
  if (module.queries.length >= 100)
    refuse(
      `The home page needs a count of ${record.plural_name}, but ${quoted(module.name)} is full of queries.`,
    );
  module.queries.push({
    id: uniqueKey(`qry_${key}`, "", takenIds(plan.source), 160),
    key,
    label: `Count ${record.plural_name}`.slice(0, 60),
    exposure: "private",
    record_type: record.key,
    inputs: [],
    select: [title.key],
    filter: null,
    group_by: [],
    aggregates: [{ operation: "count", alias: "count" }],
    sort: [{ field: title.key, direction: "ascending" }],
    page_size: 1,
    relationship_hops: 0,
  });
  plan.details.push(`A query counts ${record.plural_name.toLowerCase()} for the home page.`);
  return `${module.key}:${key}`;
};

const recentQuery = (plan: Plan, resolved: Resolved): string => {
  const { module, record, title } = resolved;
  const key = uniqueKey(
    `${record.key}_recent`,
    "",
    new Set(module.queries.map((query) => query.key)),
    40,
  );
  const existing = module.queries.find((query) => query.key === key);
  if (existing !== undefined) return `${module.key}:${existing.key}`;
  if (module.queries.length >= 100)
    refuse(
      `The home page needs recent ${record.plural_name}, but ${quoted(module.name)} is full of queries.`,
    );
  const date = record.fields.find((entry) => entry.type === "date" || entry.type === "date_time");
  const columns = keyColumns(record, title, resolved.readable);
  module.queries.push({
    id: uniqueKey(`qry_${key}`, "", takenIds(plan.source), 160),
    key,
    label: `Recent ${record.plural_name}`.slice(0, 60),
    exposure: "private",
    record_type: record.key,
    inputs: [],
    select: columns.map((entry) => entry.key),
    filter: null,
    group_by: [],
    aggregates: [],
    sort: [{ field: (date ?? title).key, direction: "descending" }],
    page_size: 5,
    relationship_hops: 0,
  });
  plan.details.push(`A query returns the five most recent ${record.plural_name.toLowerCase()}.`);
  return `${module.key}:${key}`;
};

const stageAmountQuery = (plan: Plan, resolved: Resolved): string | undefined => {
  const { module, record, title } = resolved;
  const pipeline = record.pipelines[0];
  if (pipeline === undefined) return undefined;
  const stage = record.fields.find((entry) => entry.key === pipeline.stage_field);
  const amount = record.fields.find((entry) => entry.type === "money");
  if (stage === undefined || stage.type !== "choice" || amount === undefined) return undefined;
  const key = uniqueKey(
    `${record.key}_by_stage`,
    "",
    new Set(module.queries.map((query) => query.key)),
    40,
  );
  const existing = module.queries.find((query) => query.key === key);
  if (existing !== undefined) return `${module.key}:${existing.key}`;
  if (module.queries.length >= 100) return undefined;
  module.queries.push({
    id: uniqueKey(`qry_${key}`, "", takenIds(plan.source), 160),
    key,
    label: `${record.plural_name} by ${stage.label}`.slice(0, 60),
    exposure: "private",
    record_type: record.key,
    inputs: [],
    select: [stage.key, amount.key, title.key],
    filter: null,
    group_by: [stage.key],
    aggregates: [{ operation: "sum", field: amount.key, alias: "total" }],
    sort: [{ field: stage.key, direction: "ascending" }],
    page_size: 40,
    relationship_hops: 0,
  });
  plan.details.push(`A query adds ${amount.label} by ${stage.label} for the home page's chart.`);
  return `${module.key}:${key}`;
};

export const ensureHomeDashboard = (
  context: StudioStructureContext,
  plan: Plan,
  recordType?: string,
): boolean => {
  const home = plan.source.body.pages.find((page) => page.key === plan.source.body.home_page);
  if (home === undefined || home.type !== "dashboard") return false;
  const composition = home.composition as { content?: SourceItem[] };
  const items = composition.content ?? [];
  const existing = homeBlockQueries(home);
  let changed = false;
  if (items.length === 0)
    items.push(
      blockItem(
        release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.HEADING_BLOCK_RELEASE, "heading"),
        freshAlias(plan, "heading_home"),
        { text: "Overview", level: "one" },
        {},
      ),
    );
  for (const module of plan.source.body.modules)
    for (const record of module.record_types) {
      const qualified = `${module.key}:${record.key}`;
      if (recordType !== undefined && recordType !== qualified) continue;
      let resolved: Resolved;
      try {
        resolved = resolveRecordType(plan.source, qualified);
      } catch (error) {
        if (!(error instanceof StructureRefusal)) throw error;
        continue;
      }
      const count = countQuery(plan, resolved);
      if (!existing.has(count)) {
        items.push(
          blockItem(
            release(
              context,
              PLATFORM_BLOCK_RELEASE_IDENTITIES.SUMMARY_VALUES_BLOCK_RELEASE,
              "summary values",
            ),
            freshAlias(plan, `summary_${record.key}`),
            {
              title: record.plural_name,
              value_sources: [
                {
                  key: "count",
                  label: record.plural_name,
                  value_source: {
                    source: "projection",
                    projection_key: "count",
                    format: "plain",
                    thresholds: [],
                  },
                },
              ],
            },
            {},
            { query: count },
          ),
        );
        changed = true;
      }
      const recent = recentQuery(plan, resolved);
      if (!existing.has(recent)) {
        const columns = keyColumns(record, resolved.title, resolved.readable);
        items.push(
          blockItem(
            release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.HEADING_BLOCK_RELEASE, "heading"),
            freshAlias(plan, `heading_recent_${record.key}`),
            { text: `Recent ${record.plural_name}`, level: "two" },
            {},
          ),
          blockItem(
            release(
              context,
              PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE,
              "records table",
            ),
            freshAlias(plan, `recent_${record.key}`),
            {
              empty_message: `There are no ${record.plural_name.toLowerCase()} yet.`,
              columns: tableColumns((entry) => field(resolved, entry), columns, record.title_field),
              page_size: 5,
            },
            {},
            { query: recent },
          ),
        );
        changed = true;
      }
      const staged = stageAmountQuery(plan, resolved);
      if (staged !== undefined && !existing.has(staged)) {
        const stage = record.fields.find(
          (entry) => entry.key === record.pipelines[0]!.stage_field,
        )!;
        items.push(
          blockItem(
            release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.CHART_BLOCK_RELEASE, "chart"),
            freshAlias(plan, `chart_${record.key}`),
            {
              title: `${record.plural_name} by ${stage.label}`,
              category_field: `${module.key}:${record.key}.${stage.key}`,
              measure: "total",
            },
            {},
            { query: staged },
          ),
        );
        changed = true;
      }
    }
  if (!changed) return false;
  composition.content = items;
  plan.source = judged(plan.source);
  return true;
};
