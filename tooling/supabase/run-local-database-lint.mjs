import { spawnSync } from "node:child_process";
import { loadDatabaseVerificationManifest } from "./database-verification-manifest.mjs";

const root = process.cwd();
const manifest = await loadDatabaseVerificationManifest(root);
const executable = process.platform === "win32" ? "supabase.cmd" : "supabase";
const result = spawnSync(
  executable,
  [
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

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
