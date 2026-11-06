import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ensureLocalSigningKey } from "./ensure-local-signing-key.mjs";
import {
  killLateDescendants,
  killRecord,
  launchHidden,
  processSnapshot,
  recordListeners,
  readRecords,
  recordState,
  tcpListeners,
  withAncestors,
  writeRecords,
} from "./lane-processes.mjs";

/**
 * Local database lanes: lighter Local Supabase stacks, one per worker, each reset independently. A lane is
 * a Supabase project directory outside the repository whose config is generated from the
 * repository's config with its own project id and every port shifted by 1000 per lane. Every CLI
 * call passes `--workdir <lane>`, so no command here can reach the main stack.
 *
 * A lane has one database and one holder (the lease). `serve` starts the lane's dev servers: the
 * holder's on the lane's own port, other worktrees' as guests on ports of the guest window. Each
 * server's process ID is recorded in the lane's `servers.json` (not in the lease, because guest
 * servers outlive a lease that is cleared once its worktree is gone); `stop` and `unserve` end only
 * recorded process trees.
 */

const workspaceRoot = path.resolve(import.meta.dirname, "../..");
const cliPath = path.join(workspaceRoot, "node_modules", "supabase", "dist", "supabase.js");
const lanesRoot = path.resolve(process.env.VORTEX_LANES_ROOT ?? "A:/Apps/vortex-lanes");
// The one lane table: lane number to the lane's application port. Every other list of lanes derives
// from it (`which` serves the development-setup scripts). Lane 6 is skipped: its ports (5932x) fall
// in a TCP range Windows reserves for Hyper-V on this host. Lanes 9 and 10 sit beside the Hyper-V
// blocks of today (62669 to 63281) and lanes 9 to 11 use 62320 to 64329; whether a lane's ports
// collide with the excluded ranges is read from Windows on every run, so a lane that collides after
// a reboot is reported as blocked and never started.
const appPorts = new Map([
  [3, 3630],
  [4, 3650],
  [5, 3661],
  [7, 3653],
  [8, 3654],
  [9, 3655],
  [10, 3656],
  [11, 3657],
]);
const laneNumbers = new Set(appPorts.keys());
// Guest dev servers use one window, clear of every lane's own ports.
const guestWindow = [3670, 3699];
// Application port 3659 is blocked on this host.
const blockedAppPort = 3659;
// RAM (owner ruling): one rule for every start (lane stack, dev server, build, walk, agent): at least
// ramFloorGb free.
const ramFloorGb = 2;
const laneAppPort = (lane) => appPorts.get(lane);
const laneApiPort = (lane) => 54321 + 1000 * (lane - 1);
const laneDatabasePort = (lane) => 54322 + 1000 * (lane - 1);

// The app needs the database, Auth, the Data API, Kong, Storage and Realtime. Auth sends sign-up
// confirmation and recovery email, so the Mailpit inbox stays on. Studio, logs, the edge runtime
// and their helpers are left off to keep a lane light.
const disabledSections = new Set(["studio", "analytics", "edge_runtime"]);
const excludedContainers = "studio,postgres-meta,logflare,vector,edge-runtime,imgproxy,supavisor";
const copiedDirectories = ["migrations", "schemas", "templates"];
const copiedFiles = ["seed.sql"];
const runtimeRole = "vortex_runtime:vortex-runtime-local-only";

const laneList = [...laneNumbers]
  .map((lane) => `  ${lane}: ${laneApiPort(lane)}, ${laneDatabasePort(lane)}`)
  .join("\n");
const laneDescription = `Lanes (API and database ports; "status" shows which are blocked on this host):
${laneList}
Lanes live under VORTEX_LANES_ROOT (${lanesRoot}).`;

const usage = `Usage:
  node tooling/supabase/lane.mjs init <n>
  node tooling/supabase/lane.mjs sync <n> <worktreePath>
  node tooling/supabase/lane.mjs claim <n> <worktreePath>
  node tooling/supabase/lane.mjs start <n> [worktreePath]
  node tooling/supabase/lane.mjs stop <n> [worktreePath]
  node tooling/supabase/lane.mjs reset <n> <worktreePath>
  node tooling/supabase/lane.mjs serve <n> <worktreePath> [--port <p>]
  node tooling/supabase/lane.mjs unserve <n> <worktreePath>
  node tooling/supabase/lane.mjs which <supabaseWorkdir>
  node tooling/supabase/lane.mjs status
  node tooling/supabase/lane.mjs free
  node tooling/supabase/lane.mjs check <n> <worktreePath>
  node tooling/supabase/lane.mjs env <n>
${laneDescription}`;

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
const serversPath = (lane) => path.join(laneDirectory(lane), "servers.json");

const canonical = (target) => {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
};
/** The same directory, whatever the spelling: junctions, substituted drives and 8.3 names included. */
const sameWorktree = (left, right) =>
  process.platform === "win32"
    ? canonical(left).toLowerCase() === canonical(right).toLowerCase()
    : canonical(left) === canonical(right);

const git = (cwd, arguments_) => {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0)
    fail(`git ${arguments_[0]} failed in ${cwd}: ${result.stderr?.trim() ?? ""}`);
  return result.stdout.trim();
};
const gitLines = (cwd, arguments_) =>
  git(cwd, arguments_)
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

/** The primary checkout: the first worktree git lists. */
const primaryWorktree = () => {
  const first = git(workspaceRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .find((line) => line.startsWith("worktree "));
  if (!first) fail("Cannot determine the primary worktree.");
  return path.resolve(first.slice(9));
};

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
const claimWindowMs = 30 * 60_000;
/** The lane's lease. A stale lease is deleted only when the caller holds the lane's lock (`prune`). */
const readLease = async (lane, prune = false) => {
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
    lease.port !== laneDatabasePort(lane)
  )
    fail(`Lane ${lane} has an invalid lease.`);
  // A lease younger than the claim window holds its lane while the stack is still starting.
  const claimed = Date.now() - Date.parse(lease.startedAt) < claimWindowMs;
  if (!existsSync(lease.worktree) || (!claimed && !databaseRunning(lane))) {
    if (prune) {
      await rm(leasePath(lane));
      log(`Cleared stale lease for lane ${lane}.`);
    }
    return undefined;
  }
  return lease;
};
const writeLease = (lane, worktree, lease) =>
  writeFile(
    leasePath(lane),
    `${JSON.stringify({ worktree, startedAt: lease?.startedAt ?? new Date().toISOString(), port: laneDatabasePort(lane) }, null, 2)}
`,
  );
const requireLeaseHolder = async (lane, worktree, required = false, prune = false) => {
  const lease = await readLease(lane, prune);
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
    if (capture && result.stderr)
      process.stderr.write(
        result.stderr
          .replace(/\b(sb_secret_|eyJ)[A-Za-z0-9_.-]+/g, "[redacted]")
          .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[redacted]@"),
      );
    fail(
      `supabase ${arguments_.join(" ")} failed for lane ${lane} (${result.status ?? "terminated"}).`,
    );
  }
  return result.stdout;
};

// Guest servers run on other loopback ports than the lane's own, so Auth links (sign-up
// confirmation, recovery) must be accepted for any loopback origin.
const laneAuthConfig = (source, lane) => {
  const site = `http://localhost:${laneAppPort(lane)}`;
  return source
    .replace(/^(site_url\s*=).*$/m, `$1 "${site}"`)
    .replace(
      /^(additional_redirect_urls\s*=).*$/m,
      `$1 ["${site}", "${site}/auth/confirm", "${site}/auth/update-password", "http://localhost:*/**"]`,
    );
};
const updateLaneAuthConfig = async (lane) => {
  const configPath = path.join(laneSupabaseDirectory(lane), "config.toml");
  const current = await readFile(configPath, "utf8");
  const updated = laneAuthConfig(current, lane);
  if (updated !== current) await writeFile(configPath, updated);
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

/** Generates a new lane's config once. An existing lane keeps its config. */
const init = async (lane) => {
  const configPath = path.join(laneSupabaseDirectory(lane), "config.toml");
  if (existsSync(configPath))
    fail(
      `Lane ${lane} is already initialized. To regenerate it, stop it, remove ${laneDirectory(lane)} and run init again.`,
    );
  const source = await readFile(path.join(workspaceRoot, "supabase", "config.toml"), "utf8");
  await mkdir(laneSupabaseDirectory(lane), { recursive: true });
  await writeFile(configPath, laneConfig(source, lane));
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
  await updateLaneAuthConfig(lane);
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

/** The lane's environment for a dev server: the lines `env` prints, as key and value pairs. */
const laneEnvironment = async (lane) => {
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
  return [
    ["VORTEX_SESSION_COOKIE_NAME", `vortex-lane-${lane}-session`],
    ["VORTEX_SUPABASE_URL", status.API_URL],
    ["VORTEX_SUPABASE_PUBLISHABLE_KEY", status.PUBLISHABLE_KEY],
    ["VORTEX_RUNTIME_DATABASE_URL", runtimeDatabaseUrl(status)],
    ["VORTEX_DEV_SERVICE_ROLE_KEY", status.SECRET_KEY],
    ["VORTEX_QUERY_CONTINUATION_KEY", continuationKey],
    ["VORTEX_SUPABASE_WORKDIR", laneDirectory(lane).replaceAll("\\", "/")],
  ];
};

// --- ports and RAM ---

/** TCP port ranges Windows reserves on this host (Hyper-V, WSL and others), IPv4 and IPv6; they change per boot. */
const excludedPortRanges = () =>
  ["ipv4", "ipv6"].flatMap((family) => {
    const result = spawnSync(
      "netsh",
      ["int", family, "show", "excludedportrange", "protocol=tcp"],
      {
        encoding: "utf8",
      },
    );
    if (result.error || result.status !== 0) fail("Cannot read the Windows excluded port ranges.");
    // Range rows hold only two numbers (an administrator-excluded range ends in `*`); the localized
    // headings never match.
    return [...result.stdout.matchAll(/^[ \t]*(\d+)[ \t]+(\d+)[ \t]*\*?[ \t]*$/gm)].map((match) => [
      Number(match[1]),
      Number(match[2]),
    ]);
  });
const portExcluded = (port, ranges) => ranges.some(([from, to]) => port >= from && port <= to);

/** Every port a lane's stack listens on: each `*port` key of the repository config, shifted. */
const laneStackPorts = async (lane) => {
  const source = await readFile(path.join(workspaceRoot, "supabase", "config.toml"), "utf8");
  return [...source.matchAll(/^[ \t]*#?[ \t]*\w*port[ \t]*=[ \t]*(\d+)/gm)]
    .map((match) => Number(match[1]))
    .filter((port) => port >= 1024)
    .map((port) => port + 1000 * (lane - 1));
};

/** Why a lane cannot run on this host, or undefined. */
const laneBlock = async (lane, ranges) => {
  const app = laneAppPort(lane);
  if (app === blockedAppPort) return `application port ${app} is blocked`;
  const collisions = [app, ...(await laneStackPorts(lane))].filter((port) =>
    portExcluded(port, ranges),
  );
  return collisions.length > 0
    ? `ports ${collisions.join(", ")} fall in a Windows excluded port range`
    : undefined;
};
const requireNotBlocked = async (lane) => {
  const blocked = await laneBlock(lane, excludedPortRanges());
  if (blocked !== undefined) fail(`Lane ${lane} cannot run on this host: ${blocked}.`);
};

const freeRamGb = () => Math.round((os.freemem() / 1024 ** 3) * 10) / 10;
const ramLine = () => `free RAM ${freeRamGb()} GB; a start needs at least ${ramFloorGb} GB free`;
/** Print the reading, and refuse a start below the floor. */
const requireRam = (what) => {
  log(ramLine());
  if (freeRamGb() < ramFloorGb) fail(`Not enough free RAM to ${what}.`);
};

const canBind = (port, host) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (error) => resolve(error.code !== "EADDRINUSE" && error.code !== "EACCES"));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
/** Free on every address: no listener at all (a wildcard listener hides from a loopback bind) and bindable. */
const portFree = async (port) =>
  !tcpListeners().some((listener) => listener.port === port) &&
  (await canBind(port, "127.0.0.1")) &&
  (await canBind(port, "::1"));

// --- operation lock ---

const acquireLock = async (lane, worktree) => {
  const lockPath = path.join(laneDirectory(lane), "operation.lock");
  const deadline = Date.now() + 120_000;
  // A lock is this process's while the process ID has the creation time stored in it, so a reused ID is not mistaken for the holder.
  const created = processSnapshot().get(process.pid)?.created;
  for (;;) {
    try {
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, created, worktree }), {
        flag: "wx",
      });
      return () => rm(lockPath, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder;
      try {
        holder = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        holder = undefined;
      }
      if (Number.isInteger(holder?.pid) && holder.pid > 0) {
        const running = processSnapshot().get(holder.pid);
        const alive =
          running !== undefined &&
          (holder.created === undefined ||
            running.created === "0" ||
            running.created === holder.created);
        if (!alive) {
          // Only one waiter breaks a stale lock, under a second exclusive file, so a second waiter
          // cannot delete the lock the first one has just taken.
          const breakPath = `${lockPath}.break`;
          try {
            await writeFile(breakPath, String(process.pid), { flag: "wx" });
          } catch (breakError) {
            if (breakError.code !== "EEXIST") throw breakError;
            const age =
              Date.now() - (await stat(breakPath).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
            if (age > 10_000) await rm(breakPath, { force: true });
            await delay(200);
            continue;
          }
          try {
            let current;
            try {
              current = JSON.parse(await readFile(lockPath, "utf8"));
            } catch {
              current = undefined;
            }
            if (current?.pid === holder.pid && current?.created === holder.created) {
              await rm(lockPath, { force: true });
              log(`Cleared stale operation lock for lane ${lane}.`);
            }
          } finally {
            await rm(breakPath, { force: true });
          }
          continue;
        }
      }
      if (Date.now() >= deadline)
        fail(
          `Lane ${lane} operation is held by ${holder?.worktree ?? "an unknown worktree"} (process ${holder?.pid ?? "unknown"}); if that process is gone, delete ${lockPath}.`,
        );
      await delay(500);
    }
  }
};
/** Runs `work` holding the lane's operation lock. Every change to a lane's files and records runs here. */
const withLock = async (lane, worktree, work) => {
  const release = await acquireLock(lane, worktree);
  try {
    return await work();
  } finally {
    await release();
  }
};

// --- recorded dev servers ---

const describeServer = (entry) =>
  `port ${entry.port} (${entry.role}, process ${entry.pid}, ${entry.worktree})`;

/**
 * Reads the lane's records, and drops those whose process is gone and whose port is free. A record
 * whose process is gone but whose port is still served is kept: its server is running unrecorded.
 * Callers hold the lane's lock.
 */
const pruneServers = async (lane, snapshot) => {
  const records = await readRecords(serversPath(lane));
  // Orphan: the recorded process is gone but a descendant of it still serves the port.
  const orphans = records.filter(
    (record) =>
      recordState(record, snapshot) === "gone" && recordListeners(record, snapshot).length > 0,
  );
  const kept = records.filter(
    (record) => recordState(record, snapshot) !== "gone" || orphans.includes(record),
  );
  if (kept.length !== records.length) {
    await writeRecords(serversPath(lane), kept);
    for (const record of records.filter((entry) => !kept.includes(entry)))
      await rm(record.log, { force: true });
  }
  return { records: kept, orphans };
};

/** Process IDs that no kill may reach: every other recorded server's root. */
const protectedProcesses = async (snapshot, record) => {
  const protectedPids = new Set();
  for (const number of laneNumbers) {
    try {
      for (const other of await readRecords(serversPath(number)))
        if (other.pid !== record.pid) protectedPids.add(other.pid);
    } catch {
      // A corrupt record of another lane blocks only that lane's own commands.
    }
  }
  return protectedPids;
};

/** Ends one recorded server by its process IDs, checks it is gone, and removes its log. */
const endRecord = async (record, snapshot) => {
  const protectedPids = await protectedProcesses(snapshot, record);
  if (recordState(record, snapshot) !== "gone") killRecord(record, snapshot, protectedPids);
  for (let attempt = 0; ; attempt += 1) {
    if (recordState(record, processSnapshot()) === "gone") break;
    if (attempt >= 8)
      fail(
        `The server on port ${record.port} (process ${record.pid}) is still running; its record is kept.`,
      );
    await delay(400);
  }
  // Children created after the tree was read can outlive the root and keep the port.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    killLateDescendants(record, protectedPids);
    if (recordListeners(record, processSnapshot()).length === 0) break;
    await delay(400);
  }
  const finalSnapshot = processSnapshot();
  const owners = recordListeners(record, finalSnapshot);
  if (owners.length > 0)
    fail(
      `Port ${record.port} is still served by process ${owners.map((owner) => owner.pid).join(", ")}; the record is kept.`,
    );
  const others = tcpListeners().filter((listener) => listener.port === record.port);
  if (others.length > 0)
    log(
      `Port ${record.port} is now used by process ${others.map((other) => other.pid).join(", ")}, not by this record.`,
    );
  await rm(record.log, { force: true });
  log(`Ended ${describeServer(record)}.`);
};

/** Ends the lane's recorded servers that match and drops their records. Callers hold the lane's lock. */
const endServers = async (lane, matches) => {
  const snapshot = processSnapshot();
  const { records, orphans } = await pruneServers(lane, snapshot);
  const ended = [];
  try {
    for (const record of records.filter(matches)) {
      if (orphans.includes(record)) {
        const owners = recordListeners(record, snapshot).map((listener) => listener.pid);
        fail(
          `The server on port ${record.port} lost its recorded process ${record.pid} but the port is still served (process ${owners.join(", ")}); whoever started it ends it, then run the command again.`,
        );
      }
      await endRecord(record, snapshot);
      ended.push(record);
    }
  } finally {
    await writeRecords(
      serversPath(lane),
      records.filter((record) => !ended.includes(record)),
    );
  }
  return ended.length;
};

/** stop and reset end or rewrite a database that guests are using. Callers hold the lane's lock. */
const refuseWhileGuests = async (lane, what) => {
  const { records } = await pruneServers(lane, processSnapshot());
  const guests = records.filter((record) => record.role === "guest");
  if (guests.length > 0)
    fail(
      `Lane ${lane} cannot ${what} while guests run: ${guests.map(describeServer).join("; ")}. Each guest ends its server with: node tooling/supabase/lane.mjs unserve ${lane} <its worktree>`,
    );
};

// --- admission of a dev server ---

const databasePaths = ["supabase/migrations", "supabase/schemas"];

/** Database files the branch changed since it left origin/main: added, edited, renamed, deleted or untracked. */
const branchDatabaseChanges = (worktreePath) => {
  const base = git(worktreePath, ["merge-base", "origin/main", "HEAD"]);
  return [
    ...gitLines(worktreePath, [
      "diff",
      "--no-renames",
      "--name-only",
      base,
      "--",
      ...databasePaths,
    ]),
    ...gitLines(worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      ...databasePaths,
    ]),
  ];
};

/** How the lane's mirrored migrations differ from the guest's own: files only the lane has or has differently, and files only the guest has. */
const laneMigrationDifferences = (lane, worktreePath) => {
  const own = new Map(
    gitLines(worktreePath, ["ls-tree", "HEAD", "supabase/migrations/"]).map((line) => {
      const [meta, name] = line.split("\t");
      return [path.basename(name), meta.split(" ")[2]];
    }),
  );
  const directory = path.join(laneSupabaseDirectory(lane), "migrations");
  const names = existsSync(directory) ? readdirSync(directory) : [];
  const hashes = spawnSync("git", ["hash-object", "--stdin-paths"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    input: names.map((name) => path.join(directory, name)).join("\n"),
  });
  if (hashes.error || hashes.status !== 0) fail("Cannot hash the lane's migrations.");
  const hashList = hashes.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  return {
    extra: names.filter((name, index) => own.get(name) !== hashList[index]),
    missing: [...own.keys()].filter((name) => !names.includes(name)),
  };
};

const parseGuestPort = async (lane, value, snapshot) => {
  const port = Number(value);
  const [from, to] = guestWindow;
  if (!Number.isInteger(port) || port < from || port > to)
    fail(`Guests of lane ${lane} use ports ${from} to ${to}.`);
  if (portExcluded(port, excludedPortRanges()))
    fail(`Port ${port} is in a Windows excluded port range.`);
  if (!(await portFree(port))) fail(`Port ${port} is taken.`);
  // A port another guest recorded but has not bound yet is taken too (lane locks are per lane).
  for (const number of laneNumbers) {
    let records;
    try {
      records = await readRecords(serversPath(number));
    } catch {
      continue;
    }
    const recorded = records.find(
      (record) => record.port === port && recordState(record, snapshot) !== "gone",
    );
    if (recorded) fail(`Port ${port} is recorded for lane ${number}: ${describeServer(recorded)}.`);
  }
  return port;
};

/**
 * Admits and starts a dev server from the calling worktree against the lane's running database,
 * and records it. The lease holder serves the lane's own application port; any other worktree is a
 * guest on a port of the lane's guest window, and only while neither its branch nor the lane's
 * mirrored sources change the database relative to origin/main, because the one database is shared.
 * The caller holds the lane's lock.
 */
const startServer = async (lane, worktreePath, requestedPort) => {
  requireInitialized(lane);
  await requireNotBlocked(lane);
  if (!databaseRunning(lane)) fail(`Lane ${lane} is not running.`);
  const lease = await readLease(lane, true);
  if (!lease) fail(`Lane ${lane} has no active lease.`);
  if (sameWorktree(primaryWorktree(), worktreePath))
    fail("The primary checkout does not serve lanes; serve from another worktree.");
  const role = sameWorktree(lease.worktree, worktreePath) ? "holder" : "guest";
  if (role === "holder" && requestedPort !== undefined)
    fail("The holder serves the lane's own port; --port is for guests.");
  if (role === "guest" && requestedPort === undefined)
    fail(`serve needs --port <p> for a guest.\n${usage}`);
  if (role === "guest") {
    const changes = branchDatabaseChanges(worktreePath);
    if (changes.length > 0)
      fail(`A branch with a migration needs its own lane. Changed: ${changes.join(", ")}.`);
    const { extra, missing } = laneMigrationDifferences(lane, worktreePath);
    if (extra.length > 0)
      fail(
        `A branch with a migration needs its own lane: lane ${lane}'s database carries migrations this branch lacks or has differently: ${extra.join(", ")}.`,
      );
    if (missing.length > 0)
      fail(
        `Lane ${lane} is behind this branch: its migrations lack ${missing.join(", ")}. Its holder runs reset or sync with a current checkout first.`,
      );
  }
  const snapshot = processSnapshot();
  // Next.js runs one dev server per application directory.
  for (const other of laneNumbers) {
    let records;
    try {
      records = (await readRecords(serversPath(other))).filter(
        (record) => recordState(record, snapshot) !== "gone",
      );
    } catch (error) {
      if (other === lane) throw error;
      log(`Skipping lane ${other}'s server records: ${error.message}`);
      continue;
    }
    const running = records.find((record) => sameWorktree(record.worktree, worktreePath));
    if (running)
      fail(
        `${worktreePath} already serves lane ${other}: ${describeServer(running)}. End it first: unserve ${other}.`,
      );
  }
  const port =
    role === "holder" ? laneAppPort(lane) : await parseGuestPort(lane, requestedPort, snapshot);
  if (role === "holder" && !(await portFree(port))) fail(`Port ${port} is taken.`);
  requireRam("start a dev server");
  const next = path.join(
    worktreePath,
    "apps",
    "web",
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  if (!existsSync(next)) fail(`${worktreePath} has no installed dependencies; run pnpm install.`);
  // The identity authority is pinned per database, so every server of the lane takes the holder's.
  const holderEnvironment = path.join(lease.worktree, "apps", "web", ".env.development.local");
  const authority = existsSync(holderEnvironment)
    ? /^VORTEX_IDENTITY_AUTHORITY_ID=(\S+)$/m.exec(await readFile(holderEnvironment, "utf8"))?.[1]
    : undefined;
  if (authority === undefined)
    fail(`${holderEnvironment} does not set VORTEX_IDENTITY_AUTHORITY_ID.`);
  const environment = {
    ...process.env,
    ...Object.fromEntries(await laneEnvironment(lane)),
    VORTEX_ENVIRONMENT: "local",
    VORTEX_IDENTITY_AUTHORITY_ID: authority,
    VORTEX_SITE_URL: `http://localhost:${port}`,
  };
  // Cookies ignore ports, so each guest has its own session cookie, apart from the lane's holder.
  if (role === "guest")
    environment.VORTEX_SESSION_COOKIE_NAME = `vortex-lane-${lane}-${port}-session`;
  const { records: existing } = await pruneServers(lane, snapshot);
  const logPath = path.join(laneDirectory(lane), `server-${port}.log`);
  const pid = launchHidden({
    command: process.execPath,
    args: [next, "dev", "-H", "localhost", "--port", String(port)],
    cwd: path.join(worktreePath, "apps", "web"),
    env: environment,
    logPath,
  });
  if (pid === undefined) fail("The dev server did not start.");
  // Record the process at once, then fill in its creation time, so a crash between never leaves it unrecorded.
  const record = {
    pid,
    processStart: null,
    port,
    role,
    worktree: worktreePath,
    startedAt: new Date().toISOString(),
    log: logPath,
  };
  await writeRecords(serversPath(lane), [...existing, record]);
  const started = processSnapshot().get(record.pid);
  if (started === undefined) {
    await writeRecords(serversPath(lane), existing);
    // No record points at the log any more: show its end, then remove it.
    const lines = existsSync(logPath) ? (await readFile(logPath, "utf8")).split(/\r?\n/) : [];
    process.stderr.write(`${lines.slice(-40).join("\n")}\n`);
    await rm(logPath, { force: true });
    fail("The dev server exited at once.");
  }
  record.processStart = started.created === "0" ? null : started.created;
  await writeRecords(serversPath(lane), [...existing, record]);
  return record;
};

/** Waits, without the lane's lock, until the recorded server itself listens; ends it if it does not. */
const awaitServer = async (lane, worktreePath, record) => {
  const deadline = Date.now() + 90_000;
  let problem;
  for (;;) {
    const onPort = tcpListeners().filter((listener) => listener.port === record.port);
    if (onPort.length > 0) {
      const snapshot = processSnapshot();
      if (onPort.some((listener) => withAncestors(listener.pid, snapshot).has(record.pid))) break;
      problem = `port ${record.port} is served by another process (${onPort.map((listener) => listener.pid).join(", ")})`;
    }
    let running = true;
    try {
      process.kill(record.pid, 0);
    } catch (cause) {
      if (cause.code === "ESRCH") running = false;
    }
    if (problem !== undefined || !running || Date.now() >= deadline) {
      // The log goes with the record, so show its end first.
      const lines = existsSync(record.log)
        ? (await readFile(record.log, "utf8")).split(/\r?\n/)
        : [];
      process.stderr.write(`${lines.slice(-40).join("\n")}\n`);
      await withLock(lane, worktreePath, () =>
        endServers(lane, (entry) => entry.pid === record.pid),
      );
      fail(`The dev server did not come up on ${record.port}${problem ? `: ${problem}` : ""}.`);
    }
    await delay(500);
  }
  log(
    `Lane ${lane}: ${record.role} server on http://localhost:${record.port} (process ${record.pid}); log ${record.log}.`,
  );
};

const rawArguments = process.argv.slice(2);
const portFlag = rawArguments.indexOf("--port");
const portArgument = portFlag === -1 ? undefined : rawArguments[portFlag + 1];
if (portFlag !== -1) rawArguments.splice(portFlag, 2);
const [command, laneArgument, worktreeArgument] = rawArguments;
if (command === undefined) {
  process.stdout.write(`${laneDescription}\n`);
  process.exit(0);
}
if (command === "which") {
  const number = [...laneNumbers].find((candidate) =>
    sameWorktree(laneDirectory(candidate), laneArgument ?? ""),
  );
  process.stdout.write(`${JSON.stringify(number === undefined ? null : { lane: number })}\n`);
  process.exit(0);
}
if (command === "status" || command === "free") {
  const ranges = excludedPortRanges();
  const entries = [];
  for (const number of laneNumbers) {
    const lease = await readLease(number);
    const running = databaseRunning(number);
    const initialized = existsSync(path.join(laneSupabaseDirectory(number), "config.toml"));
    const blocked = await laneBlock(number, ranges);
    let records = [];
    let recordProblem;
    try {
      records = await readRecords(serversPath(number));
    } catch (error) {
      recordProblem = error.message;
    }
    entries.push({ number, lease, running, initialized, blocked, records, recordProblem });
  }
  if (command === "free") {
    const roomForAnother = freeRamGb() >= ramFloorGb;
    const free = entries.find(
      (entry) =>
        entry.initialized &&
        !entry.running &&
        !entry.lease &&
        !existsSync(path.join(laneDirectory(entry.number), "operation.lock")) &&
        entry.blocked === undefined,
    );
    process.stdout.write(`${free !== undefined && roomForAnother ? free.number : "none"}\n`);
    log(ramLine());
    if (free !== undefined && !roomForAnother)
      log(`Lane ${free.number} is free but there is not enough RAM to start it.`);
  } else {
    const snapshot = entries.some((entry) => entry.records.length > 0)
      ? processSnapshot()
      : undefined;
    for (const {
      number,
      lease,
      running,
      initialized,
      blocked,
      records,
      recordProblem,
    } of entries) {
      const state =
        blocked !== undefined
          ? `blocked: ${blocked}`
          : initialized
            ? `database ${running ? "running" : "stopped"}`
            : "not initialized";
      const unleased =
        running && !lease
          ? " (running without a lease: started by an older lane.mjs; its worktree merges origin/main and runs start)"
          : "";
      process.stdout.write(
        `${number}: port ${laneDatabasePort(number)}, app ${laneAppPort(number)}, ${state}, holder ${lease?.worktree ?? "none"}${unleased}\n`,
      );
      if (recordProblem !== undefined) process.stdout.write(`    ${recordProblem}\n`);
      for (const record of records) {
        const recorded = recordState(record, snapshot);
        const others = tcpListeners().filter((listener) => listener.port === record.port);
        const note =
          recorded === "gone"
            ? recordListeners(record, snapshot).length > 0
              ? ", recorded process gone but its child still serves the port: unrecorded listener, its starter ends it"
              : others.length > 0
                ? `, recorded process gone; the port is now used by process ${others.map((other) => other.pid).join(", ")}`
                : ", recorded process gone"
            : recorded === "unverified"
              ? ", process not verifiable"
              : "";
        process.stdout.write(`    server ${describeServer(record)}${note}\n`);
      }
    }
    const recordedPorts = new Set(
      entries.flatMap((entry) => entry.records.map((record) => record.port)),
    );
    const dev = [...laneNumbers].map((number) => [laneAppPort(number), number]);
    const inWindow = (port) => port >= guestWindow[0] && port <= guestWindow[1];
    const unrecorded = tcpListeners().filter(
      (listener) =>
        !recordedPorts.has(listener.port) &&
        (dev.some(([port]) => port === listener.port) || inWindow(listener.port)),
    );
    for (const listener of unrecorded)
      process.stdout.write(
        `unrecorded dev server on port ${listener.port} (process ${listener.pid}): its owner ends it and restarts it with: node tooling/supabase/lane.mjs serve <n> .\n`,
      );
    log(ramLine());
  }
  process.exit(0);
}
if (laneArgument === undefined) fail(usage);
const lane = parseLane(laneArgument);
const worktree = path.resolve(worktreeArgument ?? process.cwd());

try {
  const locked = (work) => withLock(lane, worktree, work);
  switch (command) {
    case "init":
      await mkdir(laneDirectory(lane), { recursive: true });
      await locked(async () => {
        await requireNotBlocked(lane);
        await init(lane);
      });
      break;
    case "sync":
      if (worktreeArgument === undefined) fail(usage);
      requireInitialized(lane);
      await locked(async () => {
        const lease = await requireLeaseHolder(lane, worktree, false, true);
        if (!lease && databaseRunning(lane))
          fail(
            `Lane ${lane} is running without a lease; its worktree runs start to claim it before anyone syncs it.`,
          );
        await sync(lane, worktree);
      });
      break;
    case "claim":
      if (worktreeArgument === undefined) fail(usage);
      requireInitialized(lane);
      await locked(async () => {
        await requireNotBlocked(lane);
        const lease = await requireLeaseHolder(lane, worktree, false, true);
        if (!lease && databaseRunning(lane))
          fail(`Lane ${lane} is running without a lease; its worktree runs start to claim it.`);
        await writeLease(lane, worktree, lease);
        log(`Lane ${lane} claimed by ${worktree}.`);
      });
      break;
    case "start":
      requireInitialized(lane);
      await locked(async () => {
        await requireNotBlocked(lane);
        const lease = await requireLeaseHolder(lane, worktree, false, true);
        if (!databaseRunning(lane)) requireRam("start the lane stack");
        else log(ramLine());
        await updateLaneAuthConfig(lane);
        await ensureLocalSigningKey(
          path.join(laneSupabaseDirectory(lane), ".temp", "signing-keys.json"),
        );
        runCli(lane, ["start", "--exclude", excludedContainers], true);
        log(`Lane ${lane} started.`);
        await writeFile(
          leasePath(lane),
          `${JSON.stringify({ worktree, startedAt: lease?.startedAt ?? new Date().toISOString(), port: laneDatabasePort(lane) }, null, 2)}\n`,
        );
      });
      break;
    case "stop":
      requireInitialized(lane);
      await locked(async () => {
        await requireLeaseHolder(lane, worktree, true);
        await refuseWhileGuests(lane, "stop");
        await endServers(lane, () => true);
        runCli(lane, ["stop"]);
        await rm(leasePath(lane), { force: true });
      });
      break;
    case "serve": {
      requireInitialized(lane);
      const record = await locked(() => startServer(lane, worktree, portArgument));
      await awaitServer(lane, worktree, record);
      break;
    }
    case "unserve":
      requireInitialized(lane);
      await locked(async () => {
        const ended = await endServers(lane, (entry) => sameWorktree(entry.worktree, worktree));
        log(`Lane ${lane}: ended ${ended} recorded server(s) of ${worktree}.`);
      });
      break;
    case "reset":
      if (worktreeArgument === undefined) fail(usage);
      requireInitialized(lane);
      await locked(async () => {
        await requireLeaseHolder(lane, worktree, true);
        await refuseWhileGuests(lane, "reset");
        await sync(lane, worktree);
        runCli(lane, ["db", "reset"]);
        await rm(path.join(laneSupabaseDirectory(lane), ".temp", "development-setup-state.json"), {
          force: true,
        });
      });
      break;
    case "check":
      if (worktreeArgument === undefined) fail(usage);
      await requireLeaseHolder(lane, worktree, true);
      break;
    case "env": {
      const lines = (await laneEnvironment(lane)).map(([key, value]) => `${key}=${value}`);
      process.stdout.write(`${[...lines, ""].join("\n")}`);
      break;
    }
    default:
      fail(usage);
  }
} catch (error) {
  process.stderr.write(`[lane] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
