import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// `supabase test db --db-url` runs its own containerized pg_prove attached to
// a Supabase-managed network, and passes the given --db-url through
// unmodified. Against a verify container's host-published loopback port, that
// container-local 127.0.0.1 refuses the connection (it is the pg_prove
// container's own loopback, not the host's). Running the pinned pg_prove
// image ourselves, on the same Docker network as the verify container, lets
// it reach that container by its container name instead. See docs/build-plan
// issue #384 Step 1.3.
export const pgProveImage = "public.ecr.aws/supabase/pg_prove:3.36";

const workspaceRoot = resolve(import.meta.dirname, "../..");

export const runLocalDatabaseTest = ({
  root = workspaceRoot,
  containerName,
  networkName,
  password,
  spawn = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) => {
  if (!containerName || !networkName || !password)
    throw new Error(
      "Local database test requires the verification cluster's containerName, networkName, and password",
    );

  const helperName = `${containerName}-pgtap`;

  const createResult = spawn(
    "docker",
    ["run", "-d", "--rm", "--name", helperName, "--network", networkName, pgProveImage, "/bin/sh", "-c", "sleep 3600"],
    { encoding: "utf8" },
  );
  if (createResult.error) throw createResult.error;
  if (createResult.status !== 0)
    throw new Error(`Failed to start the pgTAP harness container ${helperName}: ${createResult.stderr}`);

  try {
    const copyResult = spawn("docker", ["cp", resolve(root, "supabase", "tests"), `${helperName}:/tests`], {
      encoding: "utf8",
    });
    if (copyResult.error) throw copyResult.error;
    if (copyResult.status !== 0)
      throw new Error(`Failed to copy pgTAP tests into harness container ${helperName}: ${copyResult.stderr}`);

    const proveResult = spawn(
      "docker",
      [
        "exec",
        "-e",
        `PGPASSWORD=${password}`,
        helperName,
        "pg_prove",
        "--dbname",
        "postgres",
        "--username",
        "postgres",
        "--host",
        containerName,
        "--port",
        "5432",
        "--ext",
        ".sql",
        "--recurse",
        "/tests",
      ],
      { encoding: "utf8" },
    );
    if (proveResult.stdout) stdout.write(proveResult.stdout);
    if (proveResult.stderr) stderr.write(proveResult.stderr);
    if (proveResult.error) throw proveResult.error;
    return proveResult.status ?? 1;
  } finally {
    spawn("docker", ["rm", "--force", helperName], { encoding: "utf8" });
  }
};

if (import.meta.main) {
  const { startVerificationDatabase, stopVerificationDatabase } = await import("./local-verification-database.mjs");
  const handle = await startVerificationDatabase({ root: workspaceRoot });
  let status = 1;
  try {
    status = runLocalDatabaseTest({ root: workspaceRoot, ...handle });
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    status = 1;
  } finally {
    stopVerificationDatabase(handle, { keep: status !== 0 });
  }
  process.exitCode = status;
}
