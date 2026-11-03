import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import net from "node:net";
import os from "node:os";
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
// The one lane table: lane number to the lane's application port. Every other list of lanes derives
// from it (`which` serves the development-setup scripts). Lane 6 is skipped: its ports (5932x) fall
// in a TCP range Windows reserves for Hyper-V on this host. Lanes 9 to 11 shift their stack ports
// into 62320 to 64329; whether a lane's ports collide with the excluded ranges is read from Windows
// on every run, so a lane that collides on this host is reported as blocked and never started.
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
// Lane 3 is the shared demo lane: its own server (3630) runs under the owner's supervisor, so this
// tool never starts, stops or kills it. Other worktrees serve guests on 3631 and up.
const sharedLane = 3;
const sharedLaneGuestPortMinimum = 3631;
// Application port 3659 is blocked on this host.
const blockedAppPort = 3659;
// One lane stack costs about 2.5 GB of RAM; a stack starts only while 3 GB stay free.
const stackRamGb = 2.5;
const ramFloorGb = 3;
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
const laneDescription = `Lanes on this host (API and database ports):
${laneList}
Lanes live under VORTEX_LANES_ROOT (${lanesRoot}).`;

const usage = `Usage:
  node tooling/supabase/lane.mjs init <n>
  node tooling/supabase/lane.mjs sync <n> <worktreePath>
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
const serversPath = (lane) => path.join(laneDirectory(lane), "servers.json");
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
    return {
      worktree: path.resolve(first.slice(9)),
      startedAt: "shared",
      port: laneDatabasePort(lane),
    };
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
    lease.port !== laneDatabasePort(lane)
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

const laneAuthConfig = (source, lane) => {
  const site = `http://localhost:${laneAppPort(lane)}`;
  return source
    .replace(/^(site_url\s*=).*$/m, `$1 "${site}"`)
    .replace(
      /^(additional_redirect_urls\s*=).*$/m,
      `$1 ["${site}", "${site}/auth/confirm", "${site}/auth/update-password"]`,
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

/** TCP port ranges Windows reserves on this host (Hyper-V, WSL and others); they change per boot. */
const excludedPortRanges = () => {
  const result = spawnSync("netsh", ["int", "ipv4", "show", "excludedportrange", "protocol=tcp"], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) fail("Cannot read the Windows excluded port ranges.");
  return [...result.stdout.matchAll(/^[ \t]*(\d+)[ \t]+(\d+)/gm)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);
};
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

const freeRamGb = () => Math.round((os.freemem() / 1024 ** 3) * 10) / 10;
const ramLine = () =>
  `free RAM ${freeRamGb()} GB; a started stack costs about ${stackRamGb} GB and ${ramFloorGb} GB must stay free`;

const canListen = (port, host) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (error) => resolve(error.code !== "EADDRINUSE" && error.code !== "EACCES"));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
const portFree = async (port) =>
  (await canListen(port, "127.0.0.1")) && (await canListen(port, "::1"));

// --- recorded dev servers (servers.json: the processes this tool started for a lane) ---

/** The start time of a live process, which tells a recorded process from a reused process ID. */
const processStartTime = (pid) => {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
    ],
    { encoding: "utf8" },
  );
  return result.stdout?.trim() || undefined;
};

/** The recorded servers whose process is still the one that was started. */
const readServers = async (lane) => {
  let recorded;
  try {
    recorded = JSON.parse(await readFile(serversPath(lane), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const alive = recorded.filter((entry) => processStartTime(entry.pid) === entry.processStart);
  if (alive.length !== recorded.length) await writeServers(lane, alive);
  return alive;
};
const writeServers = async (lane, servers) => {
  if (servers.length === 0) await rm(serversPath(lane), { force: true });
  else await writeFile(serversPath(lane), `${JSON.stringify(servers, null, 2)}\n`);
};
const describeServer = (entry) =>
  `port ${entry.port} (${entry.role}, process ${entry.pid}, ${entry.worktree})`;

/** Ends one recorded server and its child processes by process ID, never by name or pattern. */
const killServer = (entry) => {
  if (entry.port === 3630) fail("Lane tooling never touches the supervised demo server on 3630.");
  const result = spawnSync("taskkill", ["/PID", String(entry.pid), "/T", "/F"], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  log(`Ended ${describeServer(entry)}.`);
};

/** Ends the recorded servers of one lane that match, and drops them from the record. */
const endServers = async (lane, matches) => {
  const servers = await readServers(lane);
  const ended = servers.filter(matches);
  for (const entry of ended) killServer(entry);
  await writeServers(
    lane,
    servers.filter((entry) => !ended.includes(entry)),
  );
  return ended.length;
};

/** A branch that adds a migration relative to origin/main needs its own lane. */
const addsMigration = (worktreePath) => {
  const git = (arguments_) => {
    const result = spawnSync("git", arguments_, { cwd: worktreePath, encoding: "utf8" });
    if (result.error || result.status !== 0)
      fail(`git ${arguments_[0]} failed in ${worktreePath}: ${result.stderr?.trim() ?? ""}`);
    return result.stdout.trim();
  };
  const base = git(["merge-base", "origin/main", "HEAD"]);
  const added = git(["diff", "--diff-filter=A", "--name-only", base, "--", "supabase/migrations"]);
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "supabase/migrations",
  ]);
  return [added, untracked].some((names) => names.length > 0);
};

const parseServePort = async (lane, role, value) => {
  const port = value === undefined ? laneAppPort(lane) : Number(value);
  if (value === undefined && role === "guest")
    fail(`serve needs --port <p> for a guest.\n${usage}`);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    fail(`${String(value)} is not a usable port.`);
  if (role === "guest") {
    const reserved = new Set([...appPorts.values(), blockedAppPort]);
    if (reserved.has(port)) fail(`Port ${port} belongs to a lane or is blocked.`);
    if (lane === sharedLane && port < sharedLaneGuestPortMinimum)
      fail(`Guests of lane ${sharedLane} use ${sharedLaneGuestPortMinimum} and up.`);
  } else if (port !== laneAppPort(lane) && [...appPorts.values()].includes(port)) {
    fail(`Port ${port} belongs to another lane.`);
  }
  if (portExcluded(port, excludedPortRanges()))
    fail(`Port ${port} is in a Windows excluded port range.`);
  if (!(await portFree(port))) fail(`Port ${port} is taken.`);
  return port;
};

const requireNotBlocked = async (lane) => {
  const blocked = await laneBlock(lane, excludedPortRanges());
  if (blocked !== undefined) fail(`Lane ${lane} cannot run on this host: ${blocked}.`);
};

/** stop and reset end or rewrite a database that guests are using. */
const refuseWhileGuests = async (lane, what) => {
  const guests = (await readServers(lane)).filter((entry) => entry.role === "guest");
  if (guests.length > 0)
    fail(
      `Lane ${lane} cannot ${what} while guests run: ${guests.map(describeServer).join("; ")}. Each guest ends its server with: node tooling/supabase/lane.mjs unserve ${lane} <its worktree>`,
    );
};

/**
 * Starts a dev server from the calling worktree against the lane's running database. The lease
 * holder serves the lane's own application port; any other worktree is a guest and may serve
 * only while its branch adds no migration, because the lane's one database is shared.
 */
const serve = async (lane, worktreePath) => {
  requireInitialized(lane);
  await requireNotBlocked(lane);
  if (!databaseRunning(lane)) fail(`Lane ${lane} is not running.`);
  const lease = await readLease(lane);
  if (!lease) fail(`Lane ${lane} has no active lease.`);
  const holder = sameWorktree(lease.worktree, worktreePath);
  if (lane === sharedLane && holder)
    fail(
      "Lane 3's own server runs under the owner's supervisor; serve guests from another worktree.",
    );
  const role = holder ? "holder" : "guest";
  // Next.js runs one dev server per application directory.
  for (const other of laneNumbers) {
    const running = (await readServers(other)).find((entry) =>
      sameWorktree(entry.worktree, worktreePath),
    );
    if (running)
      fail(
        `${worktreePath} already serves lane ${other}: ${describeServer(running)}. Ending it: unserve ${other}.`,
      );
  }
  if (role === "guest" && addsMigration(worktreePath))
    fail("A branch with a migration needs its own lane.");
  const port = await parseServePort(lane, role, portArgument);
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
  const logPath = path.join(laneDirectory(lane), `server-${port}.log`);
  const output = openSync(logPath, "a");
  const child = spawn(process.execPath, [next, "dev", "-H", "localhost", "--port", String(port)], {
    cwd: path.join(worktreePath, "apps", "web"),
    env: environment,
    detached: true,
    stdio: ["ignore", output, output],
    windowsHide: true,
  });
  child.unref();
  closeSync(output);
  if (child.pid === undefined) fail("The dev server did not start.");
  const entry = {
    pid: child.pid,
    processStart: processStartTime(child.pid),
    port,
    role,
    worktree: worktreePath,
    startedAt: new Date().toISOString(),
  };
  if (entry.processStart === undefined) fail(`The dev server exited at once; see ${logPath}.`);
  await writeServers(lane, [...(await readServers(lane)), entry]);
  const deadline = Date.now() + 90_000;
  while (await portFree(port)) {
    if (processStartTime(entry.pid) !== entry.processStart || Date.now() >= deadline) {
      await endServers(lane, (recorded) => recorded.pid === entry.pid);
      fail(`The dev server did not come up on ${port}; see ${logPath}.`);
    }
    await delay(500);
  }
  log(
    `Lane ${lane}: ${role} server on http://localhost:${port} (process ${entry.pid}); log ${logPath}.`,
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
  const match = /^db(\d+)$/.exec(path.basename(path.resolve(laneArgument ?? "")));
  const number = match === null ? NaN : Number(match[1]);
  if (!laneNumbers.has(number)) process.exit(1);
  process.stdout.write(`${JSON.stringify({ lane: number, shared: number === sharedLane })}\n`);
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
    entries.push({
      number,
      lease,
      running,
      initialized,
      blocked,
      servers: await readServers(number),
    });
  }
  if (command === "free") {
    const roomForAnother = freeRamGb() - stackRamGb >= ramFloorGb;
    const free = entries.find(
      (entry) =>
        entry.number !== sharedLane &&
        entry.initialized &&
        !entry.running &&
        !entry.lease &&
        entry.blocked === undefined,
    );
    process.stdout.write(`${free !== undefined && roomForAnother ? free.number : "none"}\n`);
    log(ramLine());
    if (free !== undefined && !roomForAnother)
      log(
        `Lane ${free.number} is free but starting it would leave less than ${ramFloorGb} GB free.`,
      );
  } else {
    for (const { number, lease, running, initialized, blocked, servers } of entries) {
      const state =
        blocked !== undefined
          ? `blocked: ${blocked}`
          : initialized
            ? `database ${running ? "running" : "stopped"}`
            : "not initialized";
      process.stdout.write(
        `${number}: port ${laneDatabasePort(number)}, app ${laneAppPort(number)}, ${state}, holder ${lease?.worktree ?? "none"}\n`,
      );
      for (const entry of servers) process.stdout.write(`    server ${describeServer(entry)}\n`);
    }
    log(ramLine());
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
  if (["start", "stop", "reset", "serve", "unserve"].includes(command)) {
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
      await requireNotBlocked(lane);
      await init(lane);
      break;
    case "sync":
      if (worktreeArgument === undefined) fail(usage);
      await sync(lane, worktreeArgument);
      break;
    case "start": {
      requireInitialized(lane);
      await requireNotBlocked(lane);
      const lease = await requireLeaseHolder(lane, worktree);
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
      break;
    }
    case "stop": {
      requireInitialized(lane);
      await requireLeaseHolder(lane, worktree, true);
      await refuseWhileGuests(lane, "stop");
      await endServers(lane, () => true);
      runCli(lane, ["stop"]);
      await rm(leasePath(lane), { force: true });
      break;
    }
    case "serve":
      await serve(lane, worktree);
      break;
    case "unserve": {
      const ended = await endServers(lane, (entry) => sameWorktree(entry.worktree, worktree));
      log(`Lane ${lane}: ended ${ended} recorded server(s) of ${worktree}.`);
      break;
    }
    case "reset":
      if (worktreeArgument === undefined) fail(usage);
      await requireLeaseHolder(lane, worktree, true);
      await refuseWhileGuests(lane, "reset");
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
} finally {
  if (locked) await rm(lockPath, { force: true });
}
