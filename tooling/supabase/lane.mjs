import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ensureLocalSigningKey } from "./ensure-local-signing-key.mjs";

/**
 * Local database lanes: lighter Local Supabase stacks, one per worker, each reset independently. A lane is
 * a Supabase project directory outside the repository whose config is generated from the
 * repository's config with its own project id and every port shifted by 1000 per lane. Every CLI
 * call passes `--workdir <lane>`, so no command here can reach the main stack.
 */

const workspaceRoot = path.resolve(import.meta.dirname, "../..");
const cliPath = path.join(workspaceRoot, "node_modules", "supabase", "dist", "supabase.js");
const lanesRoot = path.resolve(process.env.VORTEX_LANES_ROOT ?? "A:/Apps/vortex-lanes");
// Lane 6 is skipped: its ports (5932x) fall in a TCP range Windows reserves for Hyper-V on this host.
const laneNumbers = new Set([3, 4, 5, 7, 8]);
const appPorts = new Map([
  [3, 3630],
  [4, 3650],
  [5, 3661],
  [7, 3653],
  [8, 3654],
]);

// The app needs the database, Auth, the Data API, Kong, Storage and Realtime. Auth sends sign-up
// confirmation and recovery email, so the Mailpit inbox stays on. Studio, logs, the edge runtime
// and their helpers are left off to keep a lane light.
const disabledSections = new Set(["studio", "analytics", "edge_runtime"]);
const excludedContainers = "studio,postgres-meta,logflare,vector,edge-runtime,imgproxy,supavisor";
const copiedDirectories = ["migrations", "schemas", "templates"];
const copiedFiles = ["seed.sql"];
const runtimeRole = "vortex_runtime:vortex-runtime-local-only";

const laneList = [...laneNumbers]
  .map((lane) => `  ${lane}: ${54321 + 1000 * (lane - 1)}, ${54322 + 1000 * (lane - 1)}`)
  .join("\n");
const laneDescription = `Lanes on this host (API and database ports):
${laneList}
Lanes live under VORTEX_LANES_ROOT (${lanesRoot}).`;

const usage = `Usage:
  node tooling/supabase/lane.mjs init <n>
  node tooling/supabase/lane.mjs sync <n> <worktreePath>
  node tooling/supabase/lane.mjs start <n> [worktreePath]
  node tooling/supabase/lane.mjs stop <n> [worktreePath]
  node tooling/supabase/lane.mjs reset <n> <worktreePath>
  node tooling/supabase/lane.mjs status
  node tooling/supabase/lane.mjs free
  node tooling/supabase/lane.mjs check <n> <worktreePath>
  node tooling/supabase/lane.mjs env <n>
where <n> is one of these lanes (API and database ports):
${laneList}
Lanes live under VORTEX_LANES_ROOT (${lanesRoot}).`;

const fail = (message) => {
  throw new Error(message);
};

const log = (message) => process.stdout.write(`[lane] ${message}\n`);

const parseLane = (value) => {
  const lane = Number(value);
  if (!laneNumbers.has(lane)) fail(`Unknown lane ${String(value)}.\n${usage}`);
  return lane;
};

const laneDirectory = (lane) => path.join(lanesRoot, `db${lane}`);
const laneSupabaseDirectory = (lane) => path.join(laneDirectory(lane), "supabase");
const leasePath = (lane) => path.join(laneDirectory(lane), "lease.json");
const databaseRunning = (lane) => {
  const result = spawnSync(
    "docker",
    ["container", "inspect", "--format", "{{.State.Running}}", `supabase_db_vortex-db${lane}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && !result.stderr.includes("No such container"))
    fail(`Cannot inspect lane ${lane} database: ${result.stderr.trim()}`);
  return result.status === 0 && result.stdout.trim() === "true";
};
const readLease = async (lane) => {
  if (lane === 3 && databaseRunning(lane)) {
    const git = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    const first = git.stdout?.split(/\r?\n/).find((line) => line.startsWith("worktree "));
    if (git.status !== 0 || !first) fail("Cannot determine the primary worktree for lane 3.");
    return { worktree: path.resolve(first.slice(9)), startedAt: "shared", port: 56322 };
  }
  let lease;
  try {
    lease = JSON.parse(await readFile(leasePath(lane), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    typeof lease.worktree !== "string" ||
    !path.isAbsolute(lease.worktree) ||
    typeof lease.startedAt !== "string" ||
    lease.port !== 54322 + 1000 * (lane - 1)
  )
    fail(`Lane ${lane} has an invalid lease.`);
  if (!existsSync(lease.worktree) || !databaseRunning(lane)) {
    await rm(leasePath(lane));
    log(`Cleared stale lease for lane ${lane}.`);
    return undefined;
  }
  return lease;
};
const sameWorktree = (left, right) =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const requireLeaseHolder = async (lane, worktree, required = false) => {
  const lease = await readLease(lane);
  if (lease && !sameWorktree(lease.worktree, worktree))
    fail(`Lane ${lane} is held by ${lease.worktree}.`);
  if (required && !lease)
    fail(`Lane ${lane} has no active lease; start it from ${worktree} first.`);
  return lease;
};

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
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    fail(
      `supabase ${arguments_.join(" ")} failed for lane ${lane} (${result.status ?? "terminated"}).`,
    );
  }
  return result.stdout;
};

const laneAuthConfig = (source, lane) => {
  const site = `http://localhost:${appPorts.get(lane)}`;
  return source
    .replace(/^(site_url\s*=).*$/m, `$1 "${site}"`)
    .replace(
      /^(additional_redirect_urls\s*=).*$/m,
      `$1 ["${site}", "${site}/auth/confirm", "${site}/auth/update-password"]`,
    );
};

/**
 * Generates the lane config from the repository config: its own project id, every `*port` key
 * (including commented examples) shifted by 1000 per lane above the main stack, and the heavy
 * optional services disabled.
 */
const laneConfig = (source, lane) => {
  const offset = 1000 * (lane - 1);
  let section = "";
  return laneAuthConfig(source, lane)
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
  // The config names the seed and email templates, and start applies migrations, so a new lane
  // starts from this checkout's database sources; reset later re-syncs from the worker's worktree.
  await sync(lane, workspaceRoot);
};

/** Mirrors the worktree's database sources and refreshes the lane's auth redirect origin. */
const sync = async (lane, worktreePath) => {
  requireInitialized(lane);
  const sourceDirectory = path.join(path.resolve(worktreePath), "supabase");
  if (!existsSync(path.join(sourceDirectory, "migrations")))
    fail(`${sourceDirectory} has no migrations directory.`);
  const configPath = path.join(laneSupabaseDirectory(lane), "config.toml");
  const current = await readFile(configPath, "utf8");
  await writeFile(configPath, laneAuthConfig(current, lane));
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
if (command === undefined) {
  process.stdout.write(`${laneDescription}\n`);
  process.exit(0);
}
if (command === "status" || command === "free") {
  const entries = [];
  for (const number of laneNumbers) {
    const lease = await readLease(number);
    const running = databaseRunning(number);
    const initialized = existsSync(path.join(laneSupabaseDirectory(number), "config.toml"));
    entries.push({ number, lease, running, initialized });
  }
  if (command === "free") {
    const free = entries.find(
      (entry) => entry.number !== 3 && entry.initialized && !entry.running && !entry.lease,
    );
    process.stdout.write(`${free?.number ?? "none"}\n`);
  } else {
    for (const { number, lease, running } of entries)
      process.stdout.write(
        `${number}: port ${54322 + 1000 * (number - 1)}, database ${running ? "running" : "stopped"}, holder ${lease?.worktree ?? "none"}\n`,
      );
  }
  process.exit(0);
}
if (laneArgument === undefined) fail(usage);
const lane = parseLane(laneArgument);
const worktree = path.resolve(worktreeArgument ?? process.cwd());

const lockPath = path.join(laneDirectory(lane), "operation.lock");
let locked = false;
try {
  if (command === "reset" && lane === 3)
    fail("Lane 3 is the shared demo lane and cannot be reset.");
  if (lane === 3 && ["start", "stop"].includes(command)) {
    const git = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    const first = git.stdout?.split(/\r?\n/).find((line) => line.startsWith("worktree "));
    if (git.status !== 0 || !first || !sameWorktree(path.resolve(first.slice(9)), worktree))
      fail("Lane 3 belongs to the primary worktree.");
  }
  if (["start", "stop", "reset"].includes(command)) {
    requireInitialized(lane);
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, worktree }), { flag: "wx" });
        locked = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let holder;
        try {
          holder = JSON.parse(await readFile(lockPath, "utf8"));
        } catch {
          holder = undefined;
        }
        if (Number.isInteger(holder?.pid) && holder.pid > 0) {
          let alive = true;
          try {
            process.kill(holder.pid, 0);
          } catch (cause) {
            if (cause.code === "ESRCH") alive = false;
          }
          if (!alive) {
            await rm(lockPath, { force: true });
            log(`Cleared stale operation lock for lane ${lane}.`);
            continue;
          }
        }
        if (Date.now() >= deadline)
          fail(`Lane ${lane} operation is held by ${holder?.worktree ?? "an unknown worktree"}.`);
        await delay(500);
      }
    }
  }
  switch (command) {
    case "init":
      await init(lane);
      break;
    case "sync":
      if (worktreeArgument === undefined) fail(usage);
      await sync(lane, worktreeArgument);
      break;
    case "start": {
      requireInitialized(lane);
      const lease = await requireLeaseHolder(lane, worktree);
      await ensureLocalSigningKey(
        path.join(laneSupabaseDirectory(lane), ".temp", "signing-keys.json"),
      );
      runCli(lane, ["start", "--exclude", excludedContainers], true);
      log(`Lane ${lane} started.`);
      await writeFile(
        leasePath(lane),
        `${JSON.stringify({ worktree, startedAt: lease?.startedAt ?? new Date().toISOString(), port: 54322 + 1000 * (lane - 1) }, null, 2)}\n`,
      );
      break;
    }
    case "stop":
      requireInitialized(lane);
      await requireLeaseHolder(lane, worktree, true);
      runCli(lane, ["stop"]);
      await rm(leasePath(lane), { force: true });
      break;
    case "reset":
      if (worktreeArgument === undefined) fail(usage);
      await requireLeaseHolder(lane, worktree, true);
      await sync(lane, worktreeArgument);
      runCli(lane, ["db", "reset"]);
      await rm(path.join(laneSupabaseDirectory(lane), ".temp", "development-setup-state.json"), {
        force: true,
      });
      break;
    case "check": {
      if (worktreeArgument === undefined) fail(usage);
      await requireLeaseHolder(lane, worktree, true);
      break;
    }
    case "env": {
      const status = readStatus(lane);
      if (typeof status.PUBLISHABLE_KEY !== "string" || typeof status.SECRET_KEY !== "string")
        fail(`Lane ${lane} status has no publishable or secret key.`);
      const keyPath = path.join(laneSupabaseDirectory(lane), ".temp", "query-continuation-key");
      await mkdir(path.dirname(keyPath), { recursive: true });
      try {
        await writeFile(keyPath, randomBytes(32).toString("base64"), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const continuationKey = (await readFile(keyPath, "utf8")).trim();
      if (
        !/^[A-Za-z0-9+/]{43}=$/.test(continuationKey) ||
        Buffer.from(continuationKey, "base64").length !== 32
      )
        fail(`Lane ${lane} has an invalid query continuation key.`);
      process.stdout.write(
        [
          `VORTEX_SESSION_COOKIE_NAME=vortex-lane-${lane}-session`,
          `VORTEX_SUPABASE_URL=${status.API_URL}`,
          `VORTEX_SUPABASE_PUBLISHABLE_KEY=${status.PUBLISHABLE_KEY}`,
          `VORTEX_RUNTIME_DATABASE_URL=${runtimeDatabaseUrl(status)}`,
          `VORTEX_DEV_SERVICE_ROLE_KEY=${status.SECRET_KEY}`,
          `VORTEX_QUERY_CONTINUATION_KEY=${continuationKey}`,
          `VORTEX_SUPABASE_WORKDIR=${laneDirectory(lane).replaceAll("\\", "/")}`,
          "",
        ].join("\n"),
      );
      break;
    }
    default:
      fail(usage);
  }
} catch (error) {
  process.stderr.write(`[lane] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (locked) await rm(lockPath, { force: true });
}
