import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { findRepositoryRoot } from "../development-setup/state";
import { requireLocalDevelopmentEnvironment } from "../development-setup/guards";
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
  if (supabase.href !== "http://127.0.0.1:54321/")
    throw new Error("VORTEX_SUPABASE_URL must be http://127.0.0.1:54321.");
  const database = new URL(process.env.VORTEX_RUNTIME_DATABASE_URL!);
  if (database.hostname !== "127.0.0.1" || database.port !== "54322")
    throw new Error("VORTEX_RUNTIME_DATABASE_URL must use the local database on 127.0.0.1:54322.");
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
  const status = spawnSync(process.execPath, [supabaseCli, "status", "--output", "json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (status.status !== 0 || status.error !== undefined)
    throw new Error("The local Supabase stack is not running (pnpm db:start).");
  try {
    const parsed = JSON.parse(status.stdout) as Record<string, unknown>;
    if (parsed.API_URL !== "http://127.0.0.1:54321")
      throw new Error("The local Supabase API is not at http://127.0.0.1:54321.");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The local Supabase API")) throw error;
    throw new Error("The local Supabase stack status could not be read.");
  }

  log("resetting the local database");
  runPnpm(["db:reset"]);
  const identityId = await ensureLocalDemoOwner();
  runPnpm([
    "--filter",
    "@vortex/web",
    "setup:local",
    "--",
    "--local-development",
    "--first-owner-identity-id",
    identityId,
    "--seed-demo",
  ]);
  const site = new URL(process.env.VORTEX_SITE_URL!);
  log(`ready. Sign in with VORTEX_DEMO_OWNER_EMAIL at ${site.origin}/auth/sign-in.`);
  log(`CRM company list: ${site.origin}/abzum/abzum/vortex.app.crm/crm_companies`);
  log(
    `Service Desk case list: ${site.origin}/abzum/abzum/vortex.app.service_desk/service_desk_cases`,
  );
};

main().catch((error: unknown) => {
  process.stderr.write(
    `[demo setup] failed: ${error instanceof Error ? error.message : "unexpected error"}\n`,
  );
  process.exitCode = 1;
});
