import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { organizationSelectionCandidateSchema } from "@vortex/platform/schema";
import { createHumanOrganizationRequestService } from "@vortex/platform/server";
import { nominatedOwnerSession } from "../development-setup/development-authority";
import { argumentValue, openLane, personaEmails, postgres, type LaneFacts, type Sql } from "./lane";

/**
 * Captures the before numbers for the list-paging slices: for the validation owner, an ordinary
 * member and a restricted viewer, the timing, buffer counts and result hash of the list read for
 * page 1, page 50 and the last page of the two seeded lists (opportunities and cases), paged at
 * the platform default of 40 rows.
 *
 * The read is the one the application makes: a request transaction initialised with the person's
 * own request context, `set local role vortex_request`, then `vortex_record.run_module_query` with
 * the arguments the protected query service passes for the list page's query. The context is read
 * back from a real human request so it carries the person's current access version. The plan comes
 * from `auto_explain` (nested statements, analyze, buffers), which the lane's database already
 * preloads, so it is the plan of the statement `run_module_query` builds and executes, not of the
 * function call around it; only statements slower than one second are logged.
 *
 * One list read costs time proportional to the number of rows, so the script does not walk to page
 * 50 or to the last page. It computes the keyset position of the first row of each page from the
 * storage table, in the query's own order and filter, and reads from that position. The position
 * comes from every stored row; a person who sees fewer rows is positioned the same way, and the
 * table reports how many rows their page returned. Seed the rows first with
 * `tooling/list-paging/seed-list-records.mjs`.
 *
 * Usage: pnpm --filter @vortex/web list:baseline -- --lane 2 [--output baseline.md]
 *          [--persona owner|member|viewer] [--kind opportunity|case]
 */

const pageSize = 40;
const timedRuns = 2;
const explainThresholdMilliseconds = 1000;

type Kind = Readonly<{ label: string; recordKey: string; queryKey: string }>;
const kinds: readonly Kind[] = [
  { label: "CRM opportunities", recordKey: "opportunity", queryKey: "crm_pipeline" },
  { label: "Service Desk cases", recordKey: "case", queryKey: "service_desk_open_cases" },
];

type Next = Readonly<{
  sort: readonly { fieldId: string; direction: "ascending" | "descending"; pushed: boolean }[];
  sortKey: readonly (string | null)[];
  phase: "null" | "value";
  recordId: string;
}>;
type Page = Readonly<{
  outcome: "completed" | "refused";
  reasonCode?: string;
  rows: readonly unknown[];
}>;

type QueryDefinition = Readonly<{
  queryId: string;
  selectedFieldIds: readonly string[];
  sort: readonly { fieldId: string; direction: "ascending" | "descending" }[];
  filter?: {
    kind: string;
    operator: string;
    left: { fieldId: string };
    right: { value: readonly string[] };
  } | null;
}>;

type Target = Readonly<{
  moduleRootId: string;
  query: QueryDefinition;
  table: string;
  organizationId: string;
  applicationRootId: string;
}>;

type Measurement = Readonly<{
  persona: string;
  kind: string;
  page: string;
  rows: number | undefined;
  refused: string | undefined;
  milliseconds: number[];
  hash: string;
  buffers: string;
  plan: string;
}>;

const log = (message: string): void => {
  process.stderr.write(`[baseline] ${message}\n`);
};

const median = (values: readonly number[]): number =>
  [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

const loadTarget = async (facts: LaneFacts, kind: Kind): Promise<Target> => {
  const [contract] = await facts.administration`
    select module_root_id, physical_table_token
    from vortex_record.storage_catalogue
    where state = 'active' and record_type_definition ->> 'key' = ${kind.recordKey}
    order by first_compatible_release_revision desc limit 1`;
  if (contract === undefined) throw new Error(`No ${kind.recordKey} storage on this lane.`);
  const [published] = await facts.administration`
    select q.value as query
    from vortex_definition.releases as release,
      jsonb_array_elements(release.compilation_output #> '{canonical,content,queries}') as q(value)
    where release.root_id = ${contract.module_root_id as string}::uuid
      and q.value ->> 'key' = ${kind.queryKey}
    order by release.release_revision desc limit 1`;
  if (published === undefined) throw new Error(`No ${kind.queryKey} query was published.`);
  const table = contract.physical_table_token as string;
  const [scope] = await facts.administration.begin(async (transaction) => {
    await transaction`set local role vortex_owner`;
    return transaction.unsafe(`select application_root_id from record_data.${table} limit 1`);
  });
  return {
    moduleRootId: contract.module_root_id as string,
    query: published.query as QueryDefinition,
    table,
    organizationId: facts.organizationId,
    applicationRootId: scope!.application_root_id as string,
  };
};

/** The person's current request context, read inside a real human request. */
const requestContextOf = async (
  facts: LaneFacts,
  email: string,
  target: Target,
): Promise<string> => {
  const [identity] = await facts.administration`
    select id from auth.users where lower(email) = ${email.toLowerCase()}`;
  if (identity === undefined) throw new Error(`No account for ${email}; run list:personas first.`);
  const requests = createHumanOrganizationRequestService({
    identityAuthorityId: facts.identityAuthorityId as never,
  });
  const result = await requests.run(
    nominatedOwnerSession(identity.id as string),
    organizationSelectionCandidateSchema.parse({
      organizationId: target.organizationId,
      applicationRootId: target.applicationRootId,
    }),
    async (transaction) => {
      const rows = await transaction.query<{ context: unknown }>`
        select vortex_platform.current_context() as context`;
      return rows[0]?.context;
    },
  );
  if (result.kind !== "available" || result.value === undefined)
    throw new Error(`${email} cannot open the organisation (${result.kind}).`);
  return JSON.stringify(result.value);
};

type Session = Readonly<{ context: string; target: Target }>;

const buffersOf = (plan: string): string =>
  plan
    .split("\n")
    .filter((line) => line.includes("Buffers:"))
    .slice(0, 1)
    .map((line) => line.trim())
    .join("") || "n/a";

/** Runs one list read as the person, optionally capturing the plan of its scan statement. */
const read = async (
  connection: Sql,
  notices: string[],
  session: Session,
  after: Next | null,
  explain: boolean,
): Promise<{ page: Page; milliseconds: number; plan: string }> => {
  notices.length = 0;
  return connection.begin(async (transaction) => {
    await transaction`select vortex_platform.initialize(${session.context}::text::jsonb)`;
    if (explain) {
      await transaction.unsafe(
        `set local auto_explain.log_min_duration = ${explainThresholdMilliseconds}`,
      );
      await transaction`set local auto_explain.log_analyze = on`;
      await transaction`set local auto_explain.log_buffers = on`;
      await transaction`set local auto_explain.log_nested_statements = on`;
      await transaction`set local client_min_messages = log`;
    }
    await transaction`set local role vortex_request`;
    const { moduleRootId, query } = session.target;
    const [declared] = await transaction`
      select vortex_record.read_module_query_inputs(
        ${moduleRootId}::uuid, ${query.queryId}::uuid) as result`;
    const inputs = declared!.result as { outcome: string; moduleReleaseRevision?: number };
    if (inputs.outcome !== "resolved")
      return {
        page: { outcome: "refused" as const, reasonCode: "query_unavailable", rows: [] },
        milliseconds: 0,
        plan: "",
      };
    notices.length = 0;
    const started = performance.now();
    const [row] = await transaction`
      select vortex_record.run_module_query(
        ${moduleRootId}::uuid,
        ${query.queryId}::uuid,
        ${inputs.moduleReleaseRevision as number}::bigint,
        '{}'::jsonb,
        ${JSON.stringify(query.selectedFieldIds)}::text::jsonb,
        ${pageSize}::integer,
        ${after === null ? null : JSON.stringify(after)}::text::jsonb,
        '[]'::jsonb,
        ${JSON.stringify({
          sort: [],
          filter: null,
          search: null,
          sortableFieldIds: [],
          filterableFieldIds: [],
          searchableFieldIds: [],
        })}::text::jsonb
      ) as result`;
    const milliseconds = performance.now() - started;
    const result = row!.result as {
      outcome: "completed" | "refused";
      reasonCode?: string;
      rows?: unknown[];
    };
    const scan = notices
      .filter(
        (message) =>
          message.includes("plan:") &&
          message.includes(" as sort_key,") &&
          message.includes("limit $5"),
      )
      .sort((left, right) => right.length - left.length)[0];
    return {
      page: {
        outcome: result.outcome,
        ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
        rows: result.rows ?? [],
      },
      milliseconds,
      plan: scan ?? "",
    };
  });
};

type SortColumn = Readonly<{ column: string; type: string; direction: "asc" | "desc" }>;

/**
 * The keyset position `run_module_query` uses for the row at an offset of the query's list: the
 * same filter, the same order (nulls first ascending, last descending, text in the C collation,
 * record identity last) and the same sort-key text, taken from every stored row of the application.
 */
const positionsOf = async (
  facts: LaneFacts,
  target: Target,
): Promise<{ total: number; keyAfter: (offset: number) => Promise<Next | null> }> => {
  const { query, table } = target;
  const filter = query.filter;
  if (
    filter !== undefined &&
    filter !== null &&
    (filter.kind !== "comparison" || filter.operator !== "not_in")
  )
    throw new Error("The baseline positions only lists filtered by one not_in comparison.");
  const columnOf = async (fieldId: string): Promise<{ column: string; type: string }> => {
    const [mapping] = await facts.administration`
      select m.physical_column_token, c.data_type
      from vortex_record.field_storage_mappings as m
      join information_schema.columns as c
        on c.table_schema = 'record_data' and c.table_name = ${table}
          and c.column_name = m.physical_column_token
      where m.field_id = ${fieldId}::uuid and m.state = 'active'`;
    if (mapping === undefined) throw new Error(`Field ${fieldId} has no storage column.`);
    return { column: mapping.physical_column_token as string, type: mapping.data_type as string };
  };
  const sorts: SortColumn[] = [];
  for (const sort of query.sort)
    sorts.push({
      ...(await columnOf(sort.fieldId)),
      direction: sort.direction === "ascending" ? "asc" : "desc",
    });
  const keyTerm = (sort: SortColumn): string =>
    sort.type === "timestamp with time zone"
      ? `vortex_platform.format_timestamp_utc("${sort.column}")`
      : sort.type === "date"
        ? `pg_catalog.to_char("${sort.column}", 'YYYY-MM-DD')`
        : `("${sort.column}")::text`;
  const orderTerm = (sort: SortColumn): string =>
    `"${sort.column}"${sort.type === "text" ? ' collate "C"' : ""} ${sort.direction}${sort.direction === "asc" ? " nulls first" : " nulls last"}`;
  const filtered = filter === undefined || filter === null ? undefined : filter;
  const where = [
    "organisation_id = $1::uuid",
    "lifecycle_state = 'active'",
    "application_root_id = $2::uuid",
    ...(filtered === undefined
      ? []
      : [
          `not coalesce("${(await columnOf(filtered.left.fieldId)).column}" = any ($3::text[]), false)`,
        ]),
  ].join(" and ");
  const parameters = [
    target.organizationId,
    target.applicationRootId,
    ...(filtered === undefined ? [] : [`{${filtered.right.value.join(",")}}`]),
  ];
  const run = async (statement: string): Promise<readonly Record<string, unknown>[]> =>
    facts.administration.begin(async (transaction) => {
      await transaction`set local role vortex_owner`;
      return (
        transaction as unknown as {
          unsafe(
            statement: string,
            parameters: readonly string[],
          ): Promise<Record<string, unknown>[]>;
        }
      ).unsafe(statement, parameters);
    });
  const [counted] = await run(
    `select count(*)::int as total from record_data.${table} where ${where}`,
  );
  return {
    total: counted!.total as number,
    keyAfter: async (offset) => {
      if (offset === 0) return null;
      const [row] = await run(
        `select record_id, array[${sorts.map(keyTerm).join(", ")}]::text[] as sort_key
         from record_data.${table} where ${where}
         order by ${[...sorts.map(orderTerm), "record_id asc"].join(", ")}
         offset ${offset - 1} limit 1`,
      );
      return row === undefined
        ? null
        : {
            sort: query.sort.map((sort) => ({ ...sort, pushed: true })),
            sortKey: row.sort_key as (string | null)[],
            phase: (row.sort_key as (string | null)[])[0] === null ? "null" : "value",
            recordId: row.record_id as string,
          };
    },
  };
};

const measureKind = async (
  facts: LaneFacts,
  connection: Sql,
  notices: string[],
  persona: string,
  email: string,
  kind: Kind,
): Promise<Measurement[]> => {
  const target = await loadTarget(facts, kind);
  const session: Session = { context: await requestContextOf(facts, email, target), target };
  const positions = await positionsOf(facts, target);
  const lastStart = Math.floor(Math.max(positions.total - 1, 0) / pageSize) * pageSize;
  log(`${persona} ${kind.label}: ${positions.total} rows pass the list filter`);
  const pages: readonly (readonly [string, number])[] = [
    ["page 1", 0],
    ["page 50", 49 * pageSize],
    [`last page (${Math.floor(lastStart / pageSize) + 1})`, lastStart],
  ];
  const results: Measurement[] = [];
  for (const [label, start] of pages) {
    if (start > lastStart) continue;
    const after = await positions.keyAfter(start);
    const timings: number[] = [];
    let last = await read(connection, notices, session, after, false);
    if (last.page.outcome === "refused") {
      results.push({
        persona,
        kind: kind.label,
        page: label,
        rows: undefined,
        refused: last.page.reasonCode ?? "refused",
        milliseconds: [],
        hash: "-",
        buffers: "-",
        plan: "",
      });
      break;
    }
    timings.push(last.milliseconds);
    for (let run = 1; run < timedRuns; run += 1) {
      last = await read(connection, notices, session, after, false);
      timings.push(last.milliseconds);
    }
    const explained = await read(connection, notices, session, after, true);
    log(
      `${persona} ${kind.label} ${label}: ${timings.map((value) => value.toFixed(0)).join(", ")} ms`,
    );
    results.push({
      persona,
      kind: kind.label,
      page: label,
      rows: last.page.rows.length,
      refused: undefined,
      milliseconds: timings,
      hash: createHash("md5").update(JSON.stringify(last.page.rows)).digest("hex"),
      buffers: buffersOf(explained.plan),
      plan: explained.plan,
    });
  }
  return results;
};

const table = (rows: readonly Measurement[]): string =>
  [
    "| Persona | Record type | Page | Rows | Median ms (runs) | Plan buffers (top node) | md5 of result page |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) =>
      row.refused === undefined
        ? `| ${row.persona} | ${row.kind} | ${row.page} | ${row.rows} | ${median(row.milliseconds).toFixed(0)} (${row.milliseconds.map((value) => value.toFixed(0)).join(", ")}) | ${row.buffers} | ${row.hash} |`
        : `| ${row.persona} | ${row.kind} | ${row.page} | refused: ${row.refused} | - | - | - |`,
    ),
  ].join("\n");

const main = async (): Promise<void> => {
  const facts = openLane();
  const notices: string[] = [];
  const connection = postgres(
    `postgresql://postgres:postgres@127.0.0.1:${facts.databasePort}/postgres`,
    {
      max: 1,
      onnotice: (notice) => {
        notices.push(notice.message ?? "");
      },
    },
  );
  try {
    const measurements: Measurement[] = [];
    const personas = [
      ["owner", "validation owner", personaEmails.owner()],
      ["member", "ordinary member", personaEmails.member()],
      ["viewer", "restricted viewer", personaEmails.viewer()],
    ] as const;
    const onlyPersona = argumentValue("persona");
    const onlyKind = argumentValue("kind");
    for (const [key, persona, email] of personas)
      for (const kind of kinds)
        if (
          (onlyPersona === undefined || onlyPersona === key) &&
          (onlyKind === undefined || onlyKind === kind.recordKey)
        )
          measurements.push(
            ...(await measureKind(facts, connection, notices, persona, email, kind)),
          );
    const output = [
      `# List read baseline (lane ${facts.lane}, page size ${pageSize})`,
      "",
      table(measurements),
      "",
      "## Scan plans (auto_explain, analyze, buffers; statements over 1 s)",
      ...measurements
        .filter((row) => row.plan !== "")
        .flatMap((row) => [
          "",
          `<details><summary>${row.persona}, ${row.kind}, ${row.page}</summary>`,
          "",
          "```",
          row.plan.trim(),
          "```",
          "</details>",
        ]),
    ].join("\n");
    const target = argumentValue("output");
    if (target === undefined) process.stdout.write(`${output}\n`);
    else writeFileSync(resolve(target), `${output}\n`);
  } finally {
    await connection.end();
    await facts.administration.end();
  }
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error: unknown) => {
    process.stderr.write(
      `[baseline] failed: ${error instanceof Error ? error.message : "unexpected error"}\n`,
    );
    process.exitCode = 1;
  });
