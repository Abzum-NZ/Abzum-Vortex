import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  startVerificationDatabase,
  stopVerificationDatabase,
} from "./local-verification-database.mjs";
import { pgProveImage } from "./run-local-database-test.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");

export const focusedOffboardingInventoryTestPath =
  "supabase/tests/585_account_offboarding_inventory_and_deletion.test.sql";

export const parseFocusedOffboardingInventoryTestArgument = (argumentsList = []) => {
  if (argumentsList.length > 1)
    throw new Error("Focused offboarding inventory runner accepts at most one test path");

  return argumentsList[0] ?? focusedOffboardingInventoryTestPath;
};

export const resolveFocusedOffboardingInventoryTest = ({
  root = workspaceRoot,
  testPath = focusedOffboardingInventoryTestPath,
} = {}) => {
  if (testPath !== focusedOffboardingInventoryTestPath)
    throw new Error(
      `Focused offboarding inventory runner only permits ${focusedOffboardingInventoryTestPath}`,
    );

  const absolutePath = resolve(root, testPath);
  if (!existsSync(absolutePath))
    throw new Error(`Focused offboarding inventory test is missing: ${testPath}`);

  return Object.freeze({
    absolutePath,
    destinationPath: `/tests/${basename(testPath)}`,
    testPath,
  });
};

const requireString = (value, name) => {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Focused offboarding inventory test requires ${name}`);
};

const assertVerificationTarget = ({ containerName, networkName, password }) => {
  requireString(containerName, "the verification cluster containerName");
  requireString(networkName, "the verification cluster networkName");
  requireString(password, "the verification cluster password");
  if (!/^vortex-verify-[a-f0-9]{12}$/.test(containerName))
    throw new Error(
      "Focused offboarding inventory test requires a verification cluster container name",
    );
  if (networkName !== `${containerName}-net`)
    throw new Error(
      "Focused offboarding inventory test requires the matching verification network name",
    );
};

const requireSuccess = (result, operation) => {
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${operation} failed (exit ${result.status}): ${result.stderr || ""}`);
};

/**
 * Runs exactly the account-offboarding inventory pgTAP file against one
 * already-started, labelled verification cluster. It never copies the tests
 * directory or calls pg_prove recursively.
 */
export const runFocusedOffboardingInventoryTest = ({
  root = workspaceRoot,
  containerName,
  networkName,
  password,
  testPath = focusedOffboardingInventoryTestPath,
  spawn = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) => {
  const selectedTest = resolveFocusedOffboardingInventoryTest({ root, testPath });
  assertVerificationTarget({ containerName, networkName, password });

  const helperName = `${containerName}-pgtap`;
  let helperCreated = false;
  try {
    const startHelper = spawn(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        helperName,
        "--network",
        networkName,
        pgProveImage,
        "/bin/sh",
        "-c",
        "sleep 3600",
      ],
      { encoding: "utf8" },
    );
    requireSuccess(startHelper, `Failed to start focused pgTAP helper ${helperName}`);
    helperCreated = true;

    requireSuccess(
      spawn("docker", ["exec", helperName, "mkdir", "-p", "/tests"], { encoding: "utf8" }),
      `Failed to prepare focused pgTAP test directory in ${helperName}`,
    );
    requireSuccess(
      spawn(
        "docker",
        ["cp", selectedTest.absolutePath, `${helperName}:${selectedTest.destinationPath}`],
        {
          encoding: "utf8",
        },
      ),
      `Failed to copy focused pgTAP test into ${helperName}`,
    );

    const prove = spawn(
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
        selectedTest.destinationPath,
      ],
      { encoding: "utf8" },
    );
    if (prove.stdout) stdout.write(prove.stdout);
    if (prove.stderr) stderr.write(prove.stderr);
    if (prove.error) throw prove.error;
    return prove.status ?? 1;
  } finally {
    if (helperCreated) spawn("docker", ["rm", "--force", helperName], { encoding: "utf8" });
  }
};

/**
 * Starts and stops only the cluster handle returned by the repository's local
 * verification API. A failing pgTAP run leaves that same owned handle for the
 * caller's normal label-scoped db:clean workflow.
 */
export const runFocusedOffboardingInventoryVerification = async ({
  root = workspaceRoot,
  testPath = focusedOffboardingInventoryTestPath,
  startDatabase = startVerificationDatabase,
  stopDatabase = stopVerificationDatabase,
  runTest = runFocusedOffboardingInventoryTest,
} = {}) => {
  const selectedTest = resolveFocusedOffboardingInventoryTest({ root, testPath });
  const handle = await startDatabase({ root });
  let status = 1;
  try {
    status = runTest({ root, testPath: selectedTest.testPath, ...handle });
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
  } finally {
    stopDatabase(handle, { keep: status !== 0 });
  }
  return status;
};

if (import.meta.main) {
  try {
    const testPath = parseFocusedOffboardingInventoryTestArgument(process.argv.slice(2));
    process.exitCode = await runFocusedOffboardingInventoryVerification({
      root: workspaceRoot,
      testPath,
    });
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
