import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  startVerificationDatabase,
  stopVerificationDatabase,
} from "./local-verification-database.mjs";
import { runLocalDatabaseTest } from "./run-local-database-test.mjs";
import { runLocalConcurrencyProofs } from "./run-local-concurrency-proof.mjs";
import { runLocalDatabaseLint } from "./run-local-database-lint.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");

const runPinSetConsumerProof = ({ root, databaseUrl }) => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "tooling/supabase/permission-pin-set-postgres.integration.test.ts",
    ],
    {
      cwd: root,
      env: { ...process.env, VORTEX_TEST_DATABASE_URL: databaseUrl },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
};

/**
 * Runs pgTAP, the concurrency proofs, and database lint against one fresh
 * verification cluster, stopping at the first failing step. The cluster is
 * removed when every step passes and left running for diagnosis when any
 * step fails or throws.
 */
export const runLocalDatabaseVerify = async ({ root = workspaceRoot } = {}) => {
  const handle = await startVerificationDatabase({ root });
  let status = 0;
  try {
    status = runLocalDatabaseTest({ root, ...handle });
    if (status === 0) status = runPinSetConsumerProof({ root, databaseUrl: handle.url });
    if (status === 0)
      status = await runLocalConcurrencyProofs({ root, containerName: handle.containerName });
    if (status === 0) status = await runLocalDatabaseLint({ root, databaseUrl: handle.url });
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    status = 1;
  } finally {
    stopVerificationDatabase(handle, { keep: status !== 0 });
  }
  return status;
};

if (import.meta.main) process.exitCode = await runLocalDatabaseVerify();
