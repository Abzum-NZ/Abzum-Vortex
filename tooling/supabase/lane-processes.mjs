import { spawnSync } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Process and port inspection for lane dev servers, and the strict record of the servers a lane
 * started (`servers.json`). A record is trusted only while the process behind its ID still has the
 * recorded creation time, so a reused process ID is never mistaken for the server.
 */

const snapshotScript =
  '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | ForEach-Object { $c = 0; if ($_.CreationDate) { $c = $_.CreationDate.ToFileTimeUtc() }; "$($_.ProcessId) $($_.ParentProcessId) $c" }';

/** Every running process as process ID to `{ parent, created }`. Throws when it cannot be read. */
export const processSnapshot = () => {
  const result = spawnSync("powershell", ["-NoProfile", "-Command", snapshotScript], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw new Error(`Cannot list processes: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`Cannot list processes (powershell exit ${String(result.status)}).`);
  const processes = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (match) processes.set(Number(match[1]), { parent: Number(match[2]), created: match[3] });
  }
  if (processes.size < 10) throw new Error("Cannot list processes: the listing was empty.");
  return processes;
};

/** TCP listeners on this host, IPv4 and IPv6, as `{ port, pid }`. */
export const tcpListeners = () => {
  const result = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("Cannot list TCP listeners.");
  return result.stdout
    .split(/\r?\n/)
    .map((line) => /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ port: Number(match[1]), pid: Number(match[2]) }));
};

/**
 * "alive": the recorded process is running. "gone": it is not. "unverified": a process with that
 * ID runs but its creation time cannot be compared, so it is never killed and never dropped.
 */
export const recordState = (record, snapshot) => {
  const running = snapshot.get(record.pid);
  if (running === undefined) return "gone";
  if (record.processStart === null || running.created === "0") return "unverified";
  return running.created === record.processStart ? "alive" : "gone";
};

/** The process and its descendants, root first. A child counts only if it is not older than its parent. */
const processTree = (rootPid, snapshot) => {
  const tree = [rootPid];
  for (let index = 0; index < tree.length; index += 1) {
    const parent = snapshot.get(tree[index]);
    for (const [pid, child] of snapshot)
      if (
        child.parent === tree[index] &&
        !tree.includes(pid) &&
        BigInt(child.created) >= BigInt(parent.created)
      )
        tree.push(pid);
  }
  return tree;
};

/** A process and its ancestors, so the supervisor above a protected listener is protected too. */
export const withAncestors = (pid, snapshot) => {
  const chain = new Set();
  for (let current = pid; current !== undefined && !chain.has(current);) {
    chain.add(current);
    current = snapshot.get(current)?.parent;
  }
  return chain;
};

const endProcesses = (pids, port) => {
  for (const pid of pids) {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/F"], { encoding: "utf8" });
    if (result.error) throw result.error;
    // A process can exit by itself once its child is ended; it is a failure only if it still runs.
    if (result.status !== 0 && processSnapshot().has(pid))
      throw new Error(
        `taskkill could not end process ${pid} of the server on port ${port}: ${`${result.stderr}${result.stdout}`.trim()}`,
      );
  }
};

const refuseProtected = (pids, protectedPids, port) => {
  const shielded = pids.filter((pid) => protectedPids.has(pid));
  if (shielded.length > 0)
    throw new Error(
      `Not ending the server on port ${port}: its process tree holds protected process(es) ${shielded.join(", ")}.`,
    );
};

/**
 * Ends a verified recorded server and its descendants, leaves first, by process ID only. The tree is
 * read fresh, so children created since the caller's snapshot are included. Refuses when the tree,
 * root included, holds a protected process (another recorded server or the supervised demo server).
 */
export const killRecord = (record, snapshot, protectedPids) => {
  if (recordState(record, snapshot) !== "alive")
    throw new Error(
      `Process ${record.pid} cannot be verified as the server on port ${record.port}; end it yourself if it is yours.`,
    );
  const fresh = processSnapshot();
  if (!fresh.has(record.pid)) return;
  const tree = processTree(record.pid, fresh);
  refuseProtected(tree, protectedPids, record.port);
  endProcesses([...tree].reverse(), record.port);
};

/**
 * Ends children that outlived an ended root: processes whose parent chain leads to the root's
 * process ID and that were created after the root started. Returns how many it ended.
 */
export const killLateDescendants = (record, protectedPids) => {
  const snapshot = processSnapshot();
  const started = BigInt(record.processStart ?? "0");
  const found = [];
  for (const frontier = [record.pid]; frontier.length > 0;) {
    const parent = frontier.pop();
    for (const [pid, child] of snapshot)
      if (child.parent === parent && !found.includes(pid) && BigInt(child.created) >= started) {
        found.push(pid);
        frontier.push(pid);
      }
  }
  refuseProtected(found, protectedPids, record.port);
  endProcesses([...found].reverse(), record.port);
  return found.length;
};

const roles = new Set(["holder", "guest"]);
const validRecord = (record) =>
  typeof record === "object" &&
  record !== null &&
  Number.isInteger(record.pid) &&
  record.pid > 0 &&
  (record.processStart === null || /^\d+$/.test(record.processStart ?? "")) &&
  Number.isInteger(record.port) &&
  record.port > 0 &&
  roles.has(record.role) &&
  typeof record.worktree === "string" &&
  path.isAbsolute(record.worktree) &&
  typeof record.startedAt === "string" &&
  typeof record.log === "string";

/** The records of one lane, strictly validated. A corrupt file is refused, never repaired or deleted. */
export const readRecords = async (file) => {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  let records;
  try {
    records = JSON.parse(text);
  } catch {
    records = undefined;
  }
  // The log is deleted with its record, so it must be this lane's own server log.
  const ownLog = (record) =>
    path.normalize(record.log) === path.join(path.dirname(file), `server-${record.port}.log`);
  if (!Array.isArray(records) || !records.every((record) => validRecord(record) && ownLog(record)))
    throw new Error(
      `${file} is not a valid server record. Check by hand that no server of this lane is still running, then delete the file.`,
    );
  return records;
};

/** Writes the records atomically; an empty list removes the file. */
export const writeRecords = async (file, records) => {
  if (records.length === 0) {
    await rm(file, { force: true });
    return;
  }
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`);
  await rename(temporary, file);
};
