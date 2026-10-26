import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { findRepositoryRoot } from "../development-setup/state";
import { isLoopbackHostname } from "@vortex/platform/schema";
import {
  isLocalSupabaseApiUrl,
  requireLocalDevelopmentEnvironment,
  supabaseWorkdirArguments,
} from "../development-setup/guards";
import { ensureLocalDemoOwner, validateDemoOwnerConfiguration } from "./local-demo-owner";
import { loadLocalWebEnvironment } from "./local-environment";

const log = (message: string): void => {
  process.stdout.write(`[demo setup] ${message}\n`);
};

const runPnpm = (arguments_: readonly string[]): void => {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(executable, [...arguments_], {
    cwd: findRepositoryRoot(),
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(`pnpm ${arguments_.join(" ")} failed (${result.status ?? "terminated"}).`);
};

const validateDemoEnvironment = (): void => {
  requireLocalDevelopmentEnvironment(process.env);
  validateDemoOwnerConfiguration();
  const required = [
    "VORTEX_SITE_URL",
    "VORTEX_SUPABASE_URL",
    "VORTEX_SUPABASE_PUBLISHABLE_KEY",
    "VORTEX_QUERY_CONTINUATION_KEY",
    "VORTEX_DEMO_OWNER_EMAIL",
    "VORTEX_DEMO_OWNER_PASSWORD",
  ];
  const missing = required.filter(
    (name) => process.env[name]?.length === 0 || process.env[name] === undefined,
  );
  if (missing.length > 0)
    throw new Error(`Set these local variables before running demo setup: ${missing.join(", ")}.`);
  const site = new URL(process.env.VORTEX_SITE_URL!);
  const supabase = new URL(process.env.VORTEX_SUPABASE_URL!);
  if (
    site.protocol !== "http:" ||
    site.hostname !== "127.0.0.1" ||
    site.pathname !== "/" ||
    site.search.length > 0 ||
    site.hash.length > 0
  )
    throw new Error("VORTEX_SITE_URL must use the canonical local host, 127.0.0.1.");
  if (!isLocalSupabaseApiUrl(supabase))
    throw new Error(
      "VORTEX_SUPABASE_URL must be a loopback HTTP origin (the main stack or a database lane).",
    );
  const database = new URL(process.env.VORTEX_RUNTIME_DATABASE_URL!);
  if (!isLoopbackHostname(database.hostname) || database.port.length === 0)
    throw new Error("VORTEX_RUNTIME_DATABASE_URL must use a local database on loopback.");
  if (process.env.VERCEL !== undefined || process.env.CI === "true")
    throw new Error("Demo setup runs only on a local developer machine.");
  if (process.env.NODE_ENV === "production")
    throw new Error("Demo setup never runs with NODE_ENV=production.");
};

const main = async (): Promise<void> => {
  loadLocalWebEnvironment();
  validateDemoEnvironment();
  const root = findRepositoryRoot();
  const supabaseCli = join(root, "node_modules", "supabase", "dist", "supabase.js");
  const workdir = supabaseWorkdirArguments();
  const status = spawnSync(
    process.execPath,
    [supabaseCli, "status", "--output", "json", ...workdir],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (status.status !== 0 || status.error !== undefined)
    throw new Error("The local Supabase stack is not running (pnpm db:start).");
  const configured = new URL(process.env.VORTEX_SUPABASE_URL!).origin;
  try {
    const parsed = JSON.parse(status.stdout) as Record<string, unknown>;
    if (typeof parsed.API_URL !== "string" || new URL(parsed.API_URL).origin !== configured)
      throw new Error(`The local Supabase API is not at ${configured}.`);
    // The runtime connection must reach the same stack, or a lane reset would be followed by
    // platform writes against another database (possibly the owner's main demo).
    const runtimePort = new URL(process.env.VORTEX_RUNTIME_DATABASE_URL!).port;
    if (typeof parsed.DB_URL !== "string" || new URL(parsed.DB_URL).port !== runtimePort)
      throw new Error(
        `The local Supabase API's database is not the one VORTEX_RUNTIME_DATABASE_URL uses (port ${runtimePort}).`,
      );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The local Supabase")) throw error;
    throw new Error("The local Supabase stack status could not be read.");
  }

  if (workdir.length === 0) {
    log("resetting the local database");
    runPnpm(["db:reset"]);
  } else {
    log(`resetting the database lane at ${workdir[1]}`);
    const reset = spawnSync(process.execPath, [supabaseCli, "db", "reset", ...workdir], {
      cwd: root,
      stdio: "inherit",
    });
    if (reset.error !== undefined) throw reset.error;
    if (reset.status !== 0)
      throw new Error(`supabase db reset failed (${reset.status ?? "terminated"}).`);
  }
  const identityId = await ensureLocalDemoOwner();
  runPnpm([
    "--filter",
    "@vortex/web",
    "setup:local",
    "--",
    "--local-development",
    "--first-owner-identity-id",
    identityId,
  ]);
  const site = new URL(process.env.VORTEX_SITE_URL!);
  log(`ready. Sign in with VORTEX_DEMO_OWNER_EMAIL at ${site.origin}/auth/sign-in.`);
};

// A one-shot command: exit once the setup settles, so an idle client keep-alive socket can never
// hold the process (and the caller's setup lock) open.
main()
  .catch((error: unknown) => {
    process.stderr.write(
      `[demo setup] failed: ${error instanceof Error ? error.message : "unexpected error"}
`,
    );
    process.exitCode = 1;
  })
  // Exit only after both streams have flushed, so a failure's cause is never truncated.
  .finally(() => process.stdout.write("", () => process.stderr.write("", () => process.exit())));
