import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadDatabaseVerificationManifest } from "./database-verification-manifest.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");

export const runLocalDatabaseLint = async ({
  root = workspaceRoot,
  spawn = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) => {
  const manifest = await loadDatabaseVerificationManifest(root);
  const cliPath = resolve(root, "node_modules", "supabase", "dist", "supabase.js");
  const result = spawn(
    process.execPath,
    [
      cliPath,
      "db",
      "lint",
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

if (import.meta.main) process.exitCode = await runLocalDatabaseLint();
