import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const config = await readFile(resolve(root, "supabase/config.toml"), "utf8");
const projectId = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m)?.[1];

if (!projectId) throw new Error("Local Supabase project_id is missing or invalid");

const scripts = [
  "tenant-organization-concurrency.test.sh",
  "identity-invitation-concurrency.test.sh",
  "access-version-concurrency.test.sh",
  "organization-request-context-concurrency.test.sh",
  "definition-publication-concurrency.test.sh",
  "definition-consumer-read-concurrency.test.sh",
  "definition-history-restore-concurrency.test.sh",
  "permission-registry-concurrency.test.sh",
  "organization-role-seal-concurrency.test.sh",
  "application-access-coordination-concurrency.test.sh",
];

for (const filename of scripts) {
  const script = await readFile(resolve(root, "supabase/tests", filename), "utf8");
  const result = spawnSync(
    "docker",
    ["exec", "--interactive", "--user", "postgres", `supabase_db_${projectId}`, "bash", "-s"],
    { cwd: root, encoding: "utf8", input: script },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
