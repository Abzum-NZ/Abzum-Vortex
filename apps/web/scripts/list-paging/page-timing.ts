import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { argumentValue, laneAuthEndpoint, openLane, personaEmails, type LaneFacts } from "./lane";

/**
 * Measures PAGE server time, which the query-level baseline (`capture-baseline.ts`) does not: for
 * each persona it requests a fixed list of shipped pages from a dev or production-mode server that
 * already runs against the lane, and reports the median, p95 and maximum per page and persona.
 * Time is the `Server-Timing` header when the app emits one, otherwise the wall-clock time from
 * the request to the last byte of the HTML response (the server renders and streams the page).
 *
 * Per page and persona the first request is reported as "first" (cold when the server was just
 * started and nothing else touched it), the second is a warm-up that is discarded, and the next
 * `--runs` requests are the measured sample. The budget is a p95 under 500 ms on a 50k-record
 * organisation; every p95 over it is flagged. Seed first with
 * `tooling/list-paging/seed-list-records.mjs` and run `list:personas`.
 *
 * Sessions: each persona signs in through the real sign-in form in a headless browser. The browser
 * library is not a dependency of this repository: pass `--playwright <path to playwright-core>`
 * or set PLAYWRIGHT_CORE_PATH, and `--browser <msedge|chrome|path>` (default msedge). Only the
 * session cookies are kept, in memory; nothing about the session is printed.
 *
 * Usage: pnpm --filter @vortex/web list:page-timing -- --lane 5 --base-url http://127.0.0.1:3275
 *          [--runs 20] [--persona owner|member|viewer] [--pages crm_pipeline,service_desk_case_board]
 *          [--output page-timing.md]
 */

const budgetMilliseconds = 500;
const personaNames = ["owner", "member", "viewer"] as const;
type PersonaName = (typeof personaNames)[number];

type Target = Readonly<{
  label: string;
  application: string;
  page: string;
  /** A detail page is addressed by the id of one stored record of this record type. */
  recordKey?: string;
}>;
const pipelineApplication = "vortex.app.crm";
const casesApplication = "vortex.app.service_desk";
const groupsApplication = "vortex.app.iam";
const targets: readonly Target[] = [
  {
    label: "CRM pipeline",
    application: pipelineApplication,
    page: "crm_pipeline",
  },
  {
    label: "CRM opportunity detail",
    application: pipelineApplication,
    page: "crm_opportunity_detail",
    recordKey: "opportunity",
  },
  { label: "CRM contacts list", application: pipelineApplication, page: "crm_contacts" },
  {
    label: "Service Desk case list",
    application: casesApplication,
    page: "service_desk_cases",
  },
  {
    label: "Service Desk case detail",
    application: casesApplication,
    page: "service_desk_case_detail",
    recordKey: "case",
  },
  {
    label: "Service Desk case board",
    application: casesApplication,
    page: "service_desk_case_board",
  },
  { label: "Organisation groups", application: groupsApplication, page: "iam_roles_groups" },
];

type Sample = Readonly<{
  milliseconds: number;
  status: number;
  source: "Server-Timing" | "wall clock";
}>;
type Result = Readonly<{
  persona: PersonaName;
  label: string;
  first: Sample | undefined;
  samples: readonly Sample[];
  problem: string | undefined;
}>;

const log = (message: string): void => {
  process.stderr.write(`[page-timing] ${message}\n`);
};

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
};

type BrowserPage = Readonly<{
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForURL(predicate: (url: URL) => boolean, options: { timeout: number }): Promise<void>;
}>;
type BrowserContext = Readonly<{
  newPage(): Promise<BrowserPage>;
  cookies(): Promise<readonly { name: string; value: string }[]>;
  close(): Promise<void>;
}>;
type Browser = Readonly<{ newContext(): Promise<BrowserContext>; close(): Promise<void> }>;

const launchBrowser = async (): Promise<Browser> => {
  const location = argumentValue("playwright") ?? process.env.PLAYWRIGHT_CORE_PATH;
  if (location === undefined)
    throw new Error("Pass --playwright <path to playwright-core> or set PLAYWRIGHT_CORE_PATH.");
  const library = createRequire(resolve(location, "package.json"))(resolve(location)) as {
    chromium: {
      launch(options: {
        headless: boolean;
        channel?: string;
        executablePath?: string;
      }): Promise<Browser>;
    };
  };
  const choice = argumentValue("browser") ?? "msedge";
  return library.chromium.launch(
    ["msedge", "chrome"].includes(choice)
      ? { headless: true, channel: choice }
      : { headless: true, executablePath: choice },
  );
};

/** The owner's password is in the environment; the other personas get a fresh one on this lane. */
const passwordFor = async (
  facts: LaneFacts,
  persona: PersonaName,
  email: string,
): Promise<string> => {
  if (persona === "owner") {
    const owned = process.env.VORTEX_DEMO_OWNER_PASSWORD;
    if (owned === undefined) throw new Error("VORTEX_DEMO_OWNER_PASSWORD is not set.");
    return owned;
  }
  const url = laneAuthEndpoint(facts.lane);
  const key = process.env.VORTEX_DEV_SERVICE_ROLE_KEY;
  if (key === undefined)
    throw new Error("The lane Supabase URL and service key are not in the web environment.");
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const password = `${randomUUID()}-Aa1`;
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error !== null)
      throw new Error(`Local Auth user lookup failed (${error.status ?? "unknown"}).`);
    const found = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (found !== undefined) {
      const updated = await admin.auth.admin.updateUserById(found.id, { password });
      if (updated.error !== null)
        throw new Error(`Local password reset failed (${updated.error.code ?? "unknown"}).`);
      return password;
    }
    if (data.users.length < 200) break;
  }
  throw new Error(`No ${persona} account on this lane; run list:personas first.`);
};

const signedInCookie = async (
  browser: Browser,
  base: URL,
  email: string,
  password: string,
): Promise<string> => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${base.origin}/auth/sign-in`);
    await page.fill("#email", email);
    await page.fill('input[name="password"]', password);
    await page.click('form:has(input[name="password"]) button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith("/auth/"), { timeout: 60000 });
    return (await context.cookies()).map(({ name, value }) => `${name}=${value}`).join("; ");
  } finally {
    await context.close();
  }
};

const request = async (url: string, cookie: string): Promise<Sample> => {
  const started = performance.now();
  const response = await fetch(url, { headers: { cookie }, redirect: "follow" });
  await response.text();
  const elapsed = performance.now() - started;
  const header = /dur=([0-9.]+)/i.exec(response.headers.get("server-timing") ?? "");
  return {
    milliseconds: header?.[1] === undefined ? elapsed : Number(header[1]),
    status: response.status,
    source: header?.[1] === undefined ? "wall clock" : "Server-Timing",
  };
};

/** One stored record id per detail record type, read from the lane's storage tables. */
const loadRecordIds = async (facts: LaneFacts): Promise<ReadonlyMap<string, string>> => {
  const ids = new Map<string, string>();
  for (const key of targets.flatMap((target) => target.recordKey ?? [])) {
    const [contract] = await facts.administration`
      select physical_table_token from vortex_record.storage_catalogue
      where state = 'active' and record_type_definition ->> 'key' = ${key}
      order by first_compatible_release_revision desc limit 1`;
    if (contract === undefined) throw new Error(`No ${key} storage on this lane.`);
    const [row] = await facts.administration.unsafe(
      `select record_id from record_data.${contract.physical_table_token as string} limit 1`,
    );
    if (row === undefined) throw new Error(`No ${key} record on this lane.`);
    ids.set(key, row.record_id as string);
  }
  return ids;
};

const measure = async (
  facts: LaneFacts,
  base: URL,
  persona: PersonaName,
  cookie: string,
  runs: number,
  recordIds: ReadonlyMap<string, string>,
): Promise<Result[]> => {
  const results: Result[] = [];
  const root = `/${encodeURIComponent(facts.tenantShortName)}/${encodeURIComponent(facts.organizationShortName)}`;
  const pages = argumentValue("pages")?.split(",");
  for (const target of targets) {
    if (pages !== undefined && !pages.includes(target.page)) continue;
    const application = `${root}/${encodeURIComponent(target.application)}`;
    let path = `${application}/${encodeURIComponent(target.page)}`;
    if (target.recordKey !== undefined)
      path += `?${new URLSearchParams({ record_id: recordIds.get(target.recordKey) ?? "" })}`;
    const url = new URL(path, base).href;
    const first = await request(url, cookie);
    await request(url, cookie);
    const samples: Sample[] = [];
    for (let run = 0; run < runs; run += 1) samples.push(await request(url, cookie));
    const failed = [first, ...samples].find((sample) => sample.status !== 200);
    results.push({
      persona,
      label: target.label,
      first,
      samples,
      problem: failed === undefined ? undefined : `HTTP ${failed.status}`,
    });
    log(`${persona} ${target.label}: ${samples.length} runs`);
  }
  return results;
};

const render = (results: readonly Result[], runs: number, lane: number, base: URL): string => {
  const rows = results.map((result) => {
    if (result.first === undefined)
      return `| ${result.persona} | ${result.label} | | | | | | ${result.problem ?? "not measured"} |`;
    const times = result.samples.map((sample) => sample.milliseconds);
    const p95 = percentile(times, 0.95);
    const note = [result.problem, p95 > budgetMilliseconds ? `OVER ${budgetMilliseconds} ms` : ""]
      .filter((entry) => entry !== undefined && entry !== "")
      .join("; ");
    const cells = [result.first.milliseconds, percentile(times, 0.5), p95, Math.max(...times)].map(
      (value) => value.toFixed(0),
    );
    return `| ${result.persona} | ${result.label} | ${cells.join(" | ")} | ${result.first.source} | ${note} |`;
  });
  return [
    `# Page server time (lane ${lane}, ${base.origin}, ${runs} measured runs per page and persona)`,
    "",
    `Milliseconds. "First" is the first request of that page by that persona in this run (cold when the server was just started); one warm-up request is discarded, then the measured runs. Budget: p95 under ${budgetMilliseconds} ms.`,
    "",
    "| Persona | Page | First | Median | p95 | Max | Time source | Note |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...rows,
  ].join("\n");
};

const main = async (): Promise<void> => {
  const base = new URL(argumentValue("base-url") ?? "");
  if (!["127.0.0.1", "localhost"].includes(base.hostname) || ["3000", ""].includes(base.port))
    throw new Error("--base-url must be a local server of the lane (never the owner's port 3000).");
  const runs = Number(argumentValue("runs") ?? 20);
  if (!Number.isInteger(runs) || runs < 1 || runs > 500)
    throw new Error("--runs must be 1 to 500.");
  const chosen = argumentValue("persona");
  if (chosen !== undefined && !personaNames.includes(chosen as PersonaName))
    throw new Error("--persona must be owner, member or viewer.");
  const facts = openLane();
  let recordIds: Awaited<ReturnType<typeof loadRecordIds>>;
  try {
    recordIds = await loadRecordIds(facts);
  } finally {
    await facts.administration.end();
  }
  const browser = await launchBrowser();
  const results: Result[] = [];
  try {
    for (const persona of chosen === undefined ? personaNames : [chosen as PersonaName]) {
      const email = personaEmails[persona]();
      const cookie = await signedInCookie(
        browser,
        base,
        email,
        await passwordFor(facts, persona, email),
      );
      results.push(...(await measure(facts, base, persona, cookie, runs, recordIds)));
    }
  } finally {
    await browser.close();
  }
  const output = render(results, runs, facts.lane, base);
  const target = argumentValue("output");
  if (target === undefined) process.stdout.write(`${output}\n`);
  else writeFileSync(resolve(target), `${output}\n`);
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error: unknown) => {
    process.stderr.write(
      `[page-timing] failed: ${error instanceof Error ? error.message : "unexpected error"}\n`,
    );
    process.exitCode = 1;
  });
