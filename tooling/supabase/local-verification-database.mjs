import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Pinned Supabase Postgres image: the same image used by the shared development
// stack (`supabase start`) and by hosted Testing/Production delivery. A fresh
// container from this image always takes the `create role` branch of
// `20260903115546_database_scope_request_role.sql`, because `vortex_request`
// and `vortex_runtime` never already exist. See docs/build-plan issue #384.
export const verificationDatabaseImage = "public.ecr.aws/supabase/postgres:17.6.1.165";

const readyTimeoutMs = 60_000;
const readyPollIntervalMs = 200;

const defaultWait = (ms) => delay(ms);
const defaultNow = () => Date.now();

const randomId = () => randomBytes(6).toString("hex");
const randomSecret = (bytes) => randomBytes(bytes).toString("hex");

// Ownership labels recorded on every container and network this tool creates.
// `pnpm db:clean` (see `cleanVerificationDatabases` below) selects exclusively
// by the worktree label; it must never fall back to matching a name prefix,
// because a name never proves who created a cluster. See docs/build-plan
// issue #393.
const verificationWorktreeLabelKey = "vortex.verify.worktree";
const verificationRunLabelKey = "vortex.verify.run";

export class VerificationDatabaseStartupError extends Error {
  constructor(message, { handle, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "VerificationDatabaseStartupError";
    this.handle = handle;
  }
}

const removeNetwork = (networkName, spawn) =>
  spawn("docker", ["network", "rm", networkName], { encoding: "utf8" });
const removeContainer = (containerName, spawn) =>
  spawn("docker", ["rm", "--force", containerName], { encoding: "utf8" });

/**
 * Starts one fresh, database-only Postgres cluster for a single verification
 * run: a dedicated container plus a dedicated Docker network, migrated and
 * seeded from this working tree. The caller must always pair a successful
 * call with `stopVerificationDatabase`.
 *
 * On failure before the container exists, any partial resource (for example a
 * created network) is removed immediately, because it holds no diagnostic
 * value. On failure after the container exists (it never became ready, or
 * migrations/seed failed to apply), the container and network are left
 * running and the thrown `VerificationDatabaseStartupError` carries the
 * partial `handle` so the caller can report it and leave it for diagnosis.
 */
export const startVerificationDatabase = async ({
  root,
  spawn = spawnSync,
  wait = defaultWait,
  now = defaultNow,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) => {
  const id = `vortex-verify-${randomId()}`;
  const containerName = id;
  const networkName = `${id}-net`;
  const password = randomSecret(18);
  const jwtSecret = randomSecret(24);
  // The invoking worktree's own repository root, recorded so a later
  // `pnpm db:clean` run from this same worktree can find exactly the
  // clusters it owns, never anyone else's.
  const worktree = resolve(root);
  const ownerLabels = [
    "--label",
    `${verificationWorktreeLabelKey}=${worktree}`,
    "--label",
    `${verificationRunLabelKey}=${id}`,
  ];

  const networkResult = spawn("docker", ["network", "create", ...ownerLabels, networkName], {
    encoding: "utf8",
  });
  if (networkResult.error) throw networkResult.error;
  if (networkResult.status !== 0)
    throw new Error(
      `Failed to create the verification network ${networkName}: ${networkResult.stderr || networkResult.status}`,
    );

  const runResult = spawn(
    "docker",
    [
      "run",
      "-d",
      "--name",
      containerName,
      "--network",
      networkName,
      ...ownerLabels,
      "-e",
      "POSTGRES_USER=supabase_admin",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      "POSTGRES_DB=postgres",
      "-e",
      "POSTGRES_HOST=/var/run/postgresql",
      "-e",
      "PGDATA=/var/lib/postgresql/data",
      "-e",
      `JWT_SECRET=${jwtSecret}`,
      "-e",
      "JWT_EXP=3600",
      "-e",
      "POSTGRES_INITDB_ARGS=--allow-group-access --locale-provider=icu --encoding=UTF-8 --icu-locale=en_US.UTF-8",
      "--shm-size=64m",
      "-p",
      "127.0.0.1::5432",
      verificationDatabaseImage,
      "postgres",
      "-D",
      "/etc/postgresql",
    ],
    { encoding: "utf8" },
  );
  if (runResult.error) {
    removeNetwork(networkName, spawn);
    throw runResult.error;
  }
  if (runResult.status !== 0) {
    removeNetwork(networkName, spawn);
    throw new Error(
      `Failed to start the verification database container ${containerName}: ${runResult.stderr}`,
    );
  }

  // Printed as soon as the cluster exists, so whoever is watching this run's
  // output (including its own agent, later) can identify exactly which
  // container and network belong to it without guessing from timing.
  stdout.write(`verification cluster: ${containerName} (network ${networkName})\n`);

  const partialHandle = Object.freeze({ id, containerName, networkName, worktree });

  const deadline = now() + readyTimeoutMs;
  for (;;) {
    const check = spawn(
      "docker",
      ["exec", containerName, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"],
      {
        encoding: "utf8",
      },
    );
    if (check.status === 0) break;

    const inspect = spawn("docker", ["inspect", containerName, "--format", "{{.State.Running}}"], {
      encoding: "utf8",
    });
    if (inspect.status !== 0 || inspect.stdout.trim() !== "true")
      throw new VerificationDatabaseStartupError(
        `Verification database container ${containerName} exited before becoming ready`,
        { handle: partialHandle },
      );

    if (now() > deadline)
      throw new VerificationDatabaseStartupError(
        `Verification database container ${containerName} did not accept connections within ${readyTimeoutMs}ms`,
        { handle: partialHandle },
      );

    await wait(readyPollIntervalMs);
  }

  const portResult = spawn(
    "docker",
    ["inspect", containerName, "--format", "{{json .NetworkSettings.Ports}}"],
    {
      encoding: "utf8",
    },
  );
  if (portResult.status !== 0)
    throw new VerificationDatabaseStartupError(
      `Failed to read the published port of verification database container ${containerName}`,
      { handle: partialHandle },
    );

  let hostPort;
  try {
    hostPort = JSON.parse(portResult.stdout)["5432/tcp"]?.[0]?.HostPort;
  } catch (cause) {
    throw new VerificationDatabaseStartupError(
      `Verification database container ${containerName} returned an invalid port mapping`,
      { handle: partialHandle, cause },
    );
  }
  if (!hostPort)
    throw new VerificationDatabaseStartupError(
      `Verification database container ${containerName} did not publish a host port`,
      { handle: partialHandle },
    );

  const url = `postgresql://postgres:${password}@127.0.0.1:${hostPort}/postgres?sslmode=disable`;
  const handle = Object.freeze({
    id,
    containerName,
    networkName,
    hostPort,
    url,
    password,
    worktree,
  });

  const cliPath = resolve(root, "node_modules", "supabase", "dist", "supabase.js");
  const pushResult = spawn(
    process.execPath,
    [cliPath, "db", "push", "--db-url", url, "--include-seed", "--yes"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (pushResult.stdout) stdout.write(pushResult.stdout);
  if (pushResult.stderr) stderr.write(pushResult.stderr);
  if (pushResult.error)
    throw new VerificationDatabaseStartupError(pushResult.error.message, {
      handle,
      cause: pushResult.error,
    });
  if (pushResult.status !== 0)
    throw new VerificationDatabaseStartupError(
      `Applying migrations and seed to verification database container ${containerName} failed (exit ${pushResult.status})`,
      { handle },
    );

  return handle;
};

/**
 * Removes the container and network created by `startVerificationDatabase`,
 * unless `keep` is set (the run failed and the cluster is being left for
 * diagnosis, per the caller's own success/failure determination). When kept,
 * this prints the cluster's name and owner label instead of removing it, so
 * whoever finds it later does not have to guess whether it is theirs.
 */
export const stopVerificationDatabase = (
  handle,
  { spawn = spawnSync, keep = false, stdout = process.stdout } = {},
) => {
  if (!handle) return;
  if (keep) {
    stdout.write(
      `verification cluster kept for diagnosis: ${handle.containerName} ` +
        `(network ${handle.networkName}), owner ${verificationWorktreeLabelKey}=${handle.worktree}\n`,
    );
    return;
  }
  removeContainer(handle.containerName, spawn);
  removeNetwork(handle.networkName, spawn);
};

// Lists the names of docker resources (containers via `listArgs: ["ps", "-a"]`
// with format `{{.Names}}`, networks via `["network", "ls"]` with format
// `{{.Name}}`) that carry the given worktree's exact ownership label. This is
// the only selection this module ever performs when removing a kept cluster
// on the caller's behalf: by label, never by name prefix, because a name
// never proves who created a container.
const listOwnedResourceNames = (spawn, listArgs, nameFormat, worktree) => {
  const result = spawn(
    "docker",
    [
      ...listArgs,
      "--filter",
      `label=${verificationWorktreeLabelKey}=${worktree}`,
      "--format",
      nameFormat,
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Failed to list docker ${listArgs.join(" ")} owned by ${worktree}: ${result.stderr}`,
    );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

/**
 * Removes every verification container and network labelled with the given
 * worktree's own path — the exact set `startVerificationDatabase` created
 * from this worktree and left behind (`pnpm db:clean`, issue #393). Never
 * selects by name: two clusters could share a name-prefix by coincidence,
 * but never this label. Prints each resource it removes, and says plainly
 * when there is nothing to remove.
 */
export const cleanVerificationDatabases = ({
  root,
  spawn = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) => {
  const worktree = resolve(root);

  const containerNames = listOwnedResourceNames(spawn, ["ps", "-a"], "{{.Names}}", worktree);
  const networkNames = listOwnedResourceNames(spawn, ["network", "ls"], "{{.Name}}", worktree);

  if (containerNames.length === 0 && networkNames.length === 0) {
    stdout.write(`No verification clusters owned by ${worktree}. Nothing to remove.\n`);
    return { containerNames, networkNames };
  }

  for (const containerName of containerNames) {
    const result = removeContainer(containerName, spawn);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      stderr.write(`Failed to remove verification container ${containerName}: ${result.stderr}\n`);
      continue;
    }
    stdout.write(`Removed verification container: ${containerName}\n`);
  }

  for (const networkName of networkNames) {
    const result = removeNetwork(networkName, spawn);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      stderr.write(`Failed to remove verification network ${networkName}: ${result.stderr}\n`);
      continue;
    }
    stdout.write(`Removed verification network: ${networkName}\n`);
  }

  return { containerNames, networkNames };
};
