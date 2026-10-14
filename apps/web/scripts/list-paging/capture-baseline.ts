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
 * page 1, page 50 and the last page of one CRM record type (opportunities) and one Service Desk
 * record type (cases), paged at the platform default of 40 rows.
 *
 * The read is the one the application makes: a request transaction initialised with the person's
 * own request context, `set local role vortex_request`, then `vortex_record.run_module_query` with
 * the arguments the protected query service passes for the list page's query. The context is read
 * back from a real human request so it carries the person's current access version. The plan comes
 * from `auto_explain` (nested statements, analyze, buffers), which the lane's database already
 * preloads, so it is the plan of the statement `run_module_query` builds and executes, not of the
 * function call around it. Seed the rows first with `tooling/list-paging/seed-list-records.mjs`.
 *
 * Usage: pnpm --filter @vortex/web list:baseline -- --lane 2 [--output baseline.md]
 */

const pageSize = 40;
const timedRuns = 3;

type Kind = Readonly<{ label: string; recordKey: string; queryKey: string }>;
const kinds: readonly Kind[] = [
  { label: "CRM opportunities", recordKey: "opportunity", queryKey: "crm_pipeline" },
  { label: "Service Desk cases", recordKey: "case", queryKey: "service_desk_open_cases" },
];

type Next = Readonly<{ sortKey: readonly (string | null)[]; recordId: string }>;
type Page = Readonly<{
  outcome: "completed" | "refused";
  reasonCode?: string;
  rows: readonly unknown[];
  next: Next | null;
}>;

type Target = Readonly<{
  moduleRootId: string;
  queryId: string;
  releaseRevision: number;
  fieldIds: readonly string[];
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
    select module_root_id, storage_contract_id, physical_table_token
    from vortex_record.storage_catalogue
    where state = 'active' and record_type_definition ->> 'key' = ${kind.recordKey}
    order by first_compatible_release_revision desc limit 1`;
  if (contract === undefined) throw new Error(`No ${kind.recordKey} storage on this lane.`);
  const [query] = await facts.administration`
    select q.value as query
    from vortex_definition.releases as release,
      jsonb_array_elements(release.compilation_output #> '{canonical,content,queries}') as q(value)
    where release.root_id = ${contract.module_root_id} and q.value ->> 'key' = ${kind.queryKey}
    order by release.release_revision desc limit 1`;
  if (query === undefined) throw new Error(`No ${kind.queryKey} query was published.`);
  const [scope] = await facts.administration.begin(async (transaction) => {
    await transaction`set local role vortex_owner`;
    return transaction.unsafe(
      `select application_root_id from record_data.${contract.physical_table_token as string} limit 1`,
    );
  });
  return {
    moduleRootId: contract.module_root_id as string,
    queryId: (query.query as { queryId: string }).queryId,
    releaseRevision: 0,
    fieldIds: (query.query as { selectedFieldIds: string[] }).selectedFieldIds,
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

const planLines = (notices: readonly string[]): string[] =>
  notices.filter((message) => message.includes("plan:"));

const buffersOf = (plan: string): string =>
  plan
    .split("\n")
    .filter((line) => line.includes("Buffers:"))
    .slice(0, 1)
    .map((line) => line.trim())
    .join("") || "n/a";

/** Runs one list read as the person, optionally capturing its plan. */
const read = async (
  connection: Sql,
  notices: string[],
  session: Session,
  after: Next | null,
  size: number,
  explain: boolean,
): Promise<{ page: Page; milliseconds: number; plan: string }> => {
  notices.length = 0;
  return connection.begin(async (transaction) => {
    await transaction`select vortex_platform.initialize(${session.context}::text::jsonb)`;
    if (explain) {
      await transaction`set local auto_explain.log_min_duration = 0`;
      await transaction`set local auto_explain.log_analyze = on`;
      await transaction`set local auto_explain.log_buffers = on`;
      await transaction`set local auto_explain.log_nested_statements = on`;
      await transaction`set local client_min_messages = log`;
    }
    await transaction`set local role vortex_request`;
    const [declared] = await transaction`
      select vortex_record.read_module_query_inputs(
        ${session.target.moduleRootId}::uuid, ${session.target.queryId}::uuid) as result`;
    const inputs = declared!.result as { outcome: string; moduleReleaseRevision?: number };
    if (inputs.outcome !== "resolved")
      return {
        page: { outcome: "refused", reasonCode: "query_unavailable", rows: [], next: null },
        milliseconds: 0,
        plan: "",
      };
    notices.length = 0;
    const started = performance.now();
    const [row] = await transaction`
      select vortex_record.run_module_query(
        ${session.target.moduleRootId}::uuid,
        ${session.target.queryId}::uuid,
        ${inputs.moduleReleaseRevision as number}::bigint,
        '{}'::jsonb,
        ${JSON.stringify(session.target.fieldIds)}::text::jsonb,
        ${size}::integer,
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
      next?: Next | null;
    };
    const scan = planLines(notices)
      .filter((message) => message.includes("record_data."))
      .sort((left, right) => right.length - left.length)[0];
    return {
      page: {
        outcome: result.outcome,
        ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
        rows: result.rows ?? [],
        next: result.next ?? null,
      },
      milliseconds,
      plan: scan ?? "",
    };
  });
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
  const first = await read(connection, notices, session, null, pageSize, false);
  if (first.page.outcome === "refused")
    return [
      {
        persona,
        kind: kind.label,
        page: "all",
        rows: undefined,
        refused: first.page.reasonCode ?? "refused",
        milliseconds: [],
        hash: "-",
        buffers: "-",
        plan: "",
      },
    ];

  // One pass at the list page size records the continuation of every page and the visible total.
  // (The query's own page size bounds a request, so there is no larger page to walk with.)
  const afterOffset = new Map<number, Next | null>([[0, null]]);
  let offset = 0;
  let cursor: Next | null = null;
  for (;;) {
    const walked = await read(connection, notices, session, cursor, pageSize, false);
    if (walked.page.outcome === "refused")
      throw new Error(
        `${persona} ${kind.label} was refused at row ${offset}: ${walked.page.reasonCode}`,
      );
    offset += walked.page.rows.length;
    if (walked.page.next === null) break;
    cursor = walked.page.next;
    afterOffset.set(offset, cursor);
  }
  const total = offset;
  log(`${persona} ${kind.label}: ${total} rows are visible`);
  const lastStart = Math.floor(Math.max(total - 1, 0) / pageSize) * pageSize;
  const targets: readonly (readonly [string, number])[] = [
    ["page 1", 0],
    ["page 50", 49 * pageSize],
    [`last page (${Math.floor(lastStart / pageSize) + 1})`, lastStart],
  ];
  const results: Measurement[] = [];
  for (const [label, start] of targets) {
    if (start > lastStart) continue;
    const after = afterOffset.get(start) ?? null;
    const timings: number[] = [];
    let last = await read(connection, notices, session, after, pageSize, false);
    for (let run = 0; run < timedRuns; run += 1) {
      last = await read(connection, notices, session, after, pageSize, false);
      timings.push(last.milliseconds);
    }
    const explained = await read(connection, notices, session, after, pageSize, true);
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
    "| Persona | Record type | Page | Rows | Median ms (runs) | Top scan buffers | md5 of result page |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) =>
      row.refused === undefined
        ? `| ${row.persona} | ${row.kind} | ${row.page} | ${row.rows} | ${median(row.milliseconds).toFixed(1)} (${row.milliseconds.map((value) => value.toFixed(1)).join(", ")}) | ${row.buffers} | ${row.hash} |`
        : `| ${row.persona} | ${row.kind} | all | refused: ${row.refused} | - | - | - |`,
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
      ["validation owner", personaEmails.owner()],
      ["ordinary member", personaEmails.member()],
      ["restricted viewer", personaEmails.viewer()],
    ] as const;
    for (const [persona, email] of personas)
      for (const kind of kinds)
        measurements.push(...(await measureKind(facts, connection, notices, persona, email, kind)));
    const output = [
      `# List read baseline (lane ${facts.lane}, page size ${pageSize})`,
      "",
      table(measurements),
      "",
      "## Scan plans (auto_explain, analyze, buffers)",
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
