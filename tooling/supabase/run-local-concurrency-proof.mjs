import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadDatabaseVerificationManifest } from "./database-verification-manifest.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");

/**
 * Runs every concurrency proof, in manifest order, against the given
 * verification container. Stops at the first failing proof and returns its
 * exit status, exactly like the previous top-level script did; the caller
 * decides what to do next (this never calls `process.exit`, so a caller that
 * owns the container's lifecycle can still tear it down afterwards).
 */
export const runLocalConcurrencyProofs = async ({
  root = workspaceRoot,
  containerName,
  spawn = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) => {
  if (!containerName)
    throw new Error("Local concurrency proofs require the verification cluster's containerName");

  const manifest = await loadDatabaseVerificationManifest(root);

  for (const { proof } of manifest.concurrencyProofs) {
    const script = await readFile(resolve(root, ...proof.split("/")), "utf8");
    const result = spawn(
      "docker",
      ["exec", "--interactive", "--user", "postgres", containerName, "bash", "-s"],
      { cwd: root, encoding: "utf8", input: script },
    );

    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
};

if (import.meta.main) {
  const { startVerificationDatabase, stopVerificationDatabase } =
    await import("./local-verification-database.mjs");
  const handle = await startVerificationDatabase({ root: workspaceRoot });
  let status = 1;
  try {
    status = await runLocalConcurrencyProofs({
      root: workspaceRoot,
      containerName: handle.containerName,
    });
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    status = 1;
  } finally {
    stopVerificationDatabase(handle, { keep: status !== 0 });
  }
  process.exitCode = status;
}
