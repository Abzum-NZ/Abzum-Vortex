import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadDatabaseVerificationManifest } from "./database-verification-manifest.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");

export const runLocalDatabaseLint = async ({
  root = workspaceRoot,
  databaseUrl,
  spawn = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) => {
  if (!databaseUrl) throw new Error("Local database lint requires the verification cluster's databaseUrl");

  const manifest = await loadDatabaseVerificationManifest(root);
  const cliPath = resolve(root, "node_modules", "supabase", "dist", "supabase.js");
  const result = spawn(
    process.execPath,
    [
      cliPath,
      "db",
      "lint",
      "--db-url",
      databaseUrl,
      "--schema",
      manifest.lintSchemas.join(","),
      "--level",
      "warning",
      "--fail-on",
      "error",
    ],
    { cwd: root, encoding: "utf8" },
  );

  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  if (result.error) throw result.error;
  return result.status ?? 1;
};

if (import.meta.main) {
  const { startVerificationDatabase, stopVerificationDatabase } = await import("./local-verification-database.mjs");
  const handle = await startVerificationDatabase({ root: workspaceRoot });
  let status = 1;
  try {
    status = await runLocalDatabaseLint({ root: workspaceRoot, databaseUrl: handle.url });
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    status = 1;
  } finally {
    stopVerificationDatabase(handle, { keep: status !== 0 });
  }
  process.exitCode = status;
}
