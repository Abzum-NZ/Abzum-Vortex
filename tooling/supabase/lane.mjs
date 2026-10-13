import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { ensureLocalSigningKey } from "./ensure-local-signing-key.mjs";

/**
 * Local database lanes: extra, lighter Local Supabase stacks that workers reset independently while
 * the main stack (`supabase/config.toml`, project `Abzum-Vortex`) stays the owner's demo. A lane is
 * a Supabase project directory outside the repository whose config is generated from the
 * repository's config with its own project id and every port shifted by 1000 per lane. Every CLI
 * call passes `--workdir <lane>`, so no command here can reach the main stack.
 */

const workspaceRoot = path.resolve(import.meta.dirname, "../..");
const cliPath = path.join(workspaceRoot, "node_modules", "supabase", "dist", "supabase.js");
const lanesRoot = path.resolve(process.env.VORTEX_LANES_ROOT ?? "A:/Apps/vortex-lanes");
const laneNumbers = new Set([2, 3]);

// The app needs the database, Auth, the Data API, Kong, Storage and Realtime. Auth sends sign-up
// confirmation and recovery email, so the Mailpit inbox stays on. Studio, logs, the edge runtime
// and their helpers are left off to keep a lane light.
const disabledSections = new Set(["studio", "analytics", "edge_runtime"]);
const excludedContainers = "studio,postgres-meta,logflare,vector,edge-runtime,imgproxy,supavisor";
const copiedDirectories = ["migrations", "schemas", "templates"];
const copiedFiles = ["seed.sql"];
const runtimeRole = "vortex_runtime:vortex-runtime-local-only";

const usage = `Usage:
  node tooling/supabase/lane.mjs init <n>
  node tooling/supabase/lane.mjs sync <n> <worktreePath>
  node tooling/supabase/lane.mjs start <n>
  node tooling/supabase/lane.mjs stop <n>
  node tooling/supabase/lane.mjs reset <n> <worktreePath>
  node tooling/supabase/lane.mjs status <n>
  node tooling/supabase/lane.mjs env <n>
where <n> is ${[...laneNumbers].join(" or ")}. Lanes live under VORTEX_LANES_ROOT (${lanesRoot}).`;

const fail = (message) => {
  process.stderr.write(`[lane] ${message}\n`);
  process.exit(1);
};

const log = (message) => process.stdout.write(`[lane] ${message}\n`);

const parseLane = (value) => {
  const lane = Number(value);
  if (!laneNumbers.has(lane)) fail(`Unknown lane ${String(value)}.\n${usage}`);
  return lane;
};

const laneDirectory = (lane) => path.join(lanesRoot, `db${lane}`);
const laneSupabaseDirectory = (lane) => path.join(laneDirectory(lane), "supabase");

const requireInitialized = (lane) => {
  if (!existsSync(path.join(laneSupabaseDirectory(lane), "config.toml")))
    fail(`Lane ${lane} is not initialized. Run: node tooling/supabase/lane.mjs init ${lane}`);
};

const runCli = (lane, arguments_, capture = false) => {
  const result = spawnSync(
    process.execPath,
    [cliPath, ...arguments_, "--workdir", laneDirectory(lane)],
    {
      encoding: "utf8",
      stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    fail(
      `supabase ${arguments_.join(" ")} failed for lane ${lane} (${result.status ?? "terminated"}).`,
    );
  return result.stdout;
};

/**
 * Generates the lane config from the repository config: its own project id, every `*port` key
 * (including commented examples) shifted by 1000 per lane above the main stack, and the heavy
 * optional services disabled.
 */
const laneConfig = (source, lane) => {
  const offset = 1000 * (lane - 1);
  let section = "";
  return source
    .split(/\r?\n/)
    .map((line) => {
      const header = /^\s*\[([^\]]+)\]/.exec(line);
      if (header !== null) section = header[1].trim();
      if (/^project_id\s*=/.test(line)) return `project_id = "vortex-db${lane}"`;
      if (disabledSections.has(section) && /^enabled\s*=/.test(line)) return "enabled = false";
      // Well-known ports below 1024 belong to remote providers (hosted SMTP), not the local stack.
      return line.replace(/^(\s*#?\s*\w*port\s*=\s*)(\d+)/, (_, prefix, port) =>
        Number(port) < 1024 ? `${prefix}${port}` : `${prefix}${Number(port) + offset}`,
      );
    })
    .join("\n");
};

const init = async (lane) => {
  const source = await readFile(path.join(workspaceRoot, "supabase", "config.toml"), "utf8");
  await mkdir(laneSupabaseDirectory(lane), { recursive: true });
  await writeFile(path.join(laneSupabaseDirectory(lane), "config.toml"), laneConfig(source, lane));
  log(`lane ${lane} config written to ${laneSupabaseDirectory(lane)}.`);
};

/** Mirrors the worktree's database sources into the lane; the lane's config.toml is left alone. */
const sync = async (lane, worktreePath) => {
  requireInitialized(lane);
  const sourceDirectory = path.join(path.resolve(worktreePath), "supabase");
  if (!existsSync(path.join(sourceDirectory, "migrations")))
    fail(`${sourceDirectory} has no migrations directory.`);
  const target = laneSupabaseDirectory(lane);
  for (const name of copiedDirectories) {
    await rm(path.join(target, name), { recursive: true, force: true });
    if (existsSync(path.join(sourceDirectory, name)))
      await cp(path.join(sourceDirectory, name), path.join(target, name), { recursive: true });
  }
  for (const name of copiedFiles) {
    await rm(path.join(target, name), { force: true });
    if (existsSync(path.join(sourceDirectory, name)))
      await cp(path.join(sourceDirectory, name), path.join(target, name));
  }
  await ensureLocalSigningKey(path.join(target, ".temp", "signing-keys.json"));
  log(`lane ${lane} synced from ${sourceDirectory}.`);
};

const readStatus = (lane) => {
  requireInitialized(lane);
  const output = runCli(lane, ["status", "--output", "json"], true);
  try {
    const status = JSON.parse(output);
    if (typeof status.API_URL === "string" && typeof status.DB_URL === "string") return status;
  } catch {
    // Reported below without echoing the CLI output.
  }
  return fail(`Lane ${lane} status could not be read. Is it running? (lane.mjs start ${lane})`);
};

const runtimeDatabaseUrl = (status) => {
  const database = new URL(status.DB_URL);
  return `postgresql://${runtimeRole}@127.0.0.1:${database.port}/postgres`;
};

const [command, laneArgument, worktreeArgument] = process.argv.slice(2);
if (command === undefined || laneArgument === undefined) fail(usage);
const lane = parseLane(laneArgument);

switch (command) {
  case "init":
    await init(lane);
    break;
  case "sync":
    if (worktreeArgument === undefined) fail(usage);
    await sync(lane, worktreeArgument);
    break;
  case "start":
    requireInitialized(lane);
    await ensureLocalSigningKey(
      path.join(laneSupabaseDirectory(lane), ".temp", "signing-keys.json"),
    );
    runCli(lane, ["start", "--exclude", excludedContainers]);
    break;
  case "stop":
    requireInitialized(lane);
    runCli(lane, ["stop"]);
    break;
  case "reset":
    if (worktreeArgument === undefined) fail(usage);
    await sync(lane, worktreeArgument);
    runCli(lane, ["db", "reset"]);
    break;
  case "status": {
    const status = readStatus(lane);
    process.stdout.write(
      [
        `API URL:         ${status.API_URL}`,
        `DB URL:          ${status.DB_URL}`,
        `Runtime DB URL:  ${runtimeDatabaseUrl(status)}`,
        `Publishable key: ${status.PUBLISHABLE_KEY ?? "(unavailable)"}`,
        `Secret key:      ${status.SECRET_KEY ?? "(unavailable)"}`,
        `Inbox:           ${status.INBUCKET_URL ?? status.MAILPIT_URL ?? "(off)"}`,
        "",
      ].join("\n"),
    );
    break;
  }
  case "env": {
    const status = readStatus(lane);
    if (typeof status.PUBLISHABLE_KEY !== "string" || typeof status.SECRET_KEY !== "string")
      fail(`Lane ${lane} status has no publishable or secret key.`);
    process.stdout.write(
      [
        `VORTEX_SUPABASE_URL=${status.API_URL}`,
        `VORTEX_SUPABASE_PUBLISHABLE_KEY=${status.PUBLISHABLE_KEY}`,
        `VORTEX_RUNTIME_DATABASE_URL=${runtimeDatabaseUrl(status)}`,
        `VORTEX_DEV_SERVICE_ROLE_KEY=${status.SECRET_KEY}`,
        `VORTEX_SUPABASE_WORKDIR=${laneDirectory(lane).replaceAll("\\", "/")}`,
        "",
      ].join("\n"),
    );
    break;
  }
  default:
    fail(usage);
}
