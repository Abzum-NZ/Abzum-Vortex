import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  focusedOffboardingInventoryTestPath,
  parseFocusedOffboardingInventoryTestArgument,
  resolveFocusedOffboardingInventoryTest,
  runFocusedOffboardingInventoryTest,
  runFocusedOffboardingInventoryVerification,
} from "./run-focused-offboarding-inventory-test.mjs";

const temporaryDirectories = [];
const mutedWriter = { write: () => undefined };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const createFixtureRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "vortex-focused-offboarding-test-"));
  temporaryDirectories.push(root);
  const testFile = resolve(root, focusedOffboardingInventoryTestPath);
  await mkdir(resolve(testFile, ".."), { recursive: true });
  await writeFile(testFile, "begin;\nrollback;\n");
  return { root, testFile };
};

const createFakeSpawn = () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ args, command, options });
    if (args[0] === "run" || args[0] === "exec" || args[0] === "cp" || args[0] === "rm")
      return { status: 0, stderr: "", stdout: args.includes("pg_prove") ? "1..13\n" : "" };
    throw new Error(`Unexpected fake command: ${command} ${args.join(" ")}`);
  };
  return { calls, spawn };
};

const handle = {
  containerName: "vortex-verify-abcdef123456",
  networkName: "vortex-verify-abcdef123456-net",
  password: "throwaway-password",
};

describe("focused offboarding inventory pgTAP runner", () => {
  test("accepts only the exact focused fixture path", async () => {
    const { root, testFile } = await createFixtureRoot();

    expect(parseFocusedOffboardingInventoryTestArgument()).toBe(
      focusedOffboardingInventoryTestPath,
    );
    expect(() => parseFocusedOffboardingInventoryTestArgument(["one", "two"])).toThrow(
      /at most one test path/,
    );
    expect(resolveFocusedOffboardingInventoryTest({ root })).toEqual({
      absolutePath: testFile,
      destinationPath: "/tests/585_account_offboarding_inventory_and_deletion.test.sql",
      testPath: focusedOffboardingInventoryTestPath,
    });
    expect(() =>
      resolveFocusedOffboardingInventoryTest({
        root,
        testPath: "supabase/tests/430_exact_record_access.test.sql",
      }),
    ).toThrow(/only permits/);
  });

  test("copies and proves only the exact fixture without recursive suite selection", async () => {
    const { root, testFile } = await createFixtureRoot();
    const { calls, spawn } = createFakeSpawn();

    expect(
      runFocusedOffboardingInventoryTest({
        ...handle,
        root,
        spawn,
        stderr: mutedWriter,
        stdout: mutedWriter,
      }),
    ).toBe(0);

    const copy = calls.find((call) => call.args[0] === "cp");
    expect(copy.args).toEqual([
      "cp",
      testFile,
      "vortex-verify-abcdef123456-pgtap:/tests/585_account_offboarding_inventory_and_deletion.test.sql",
    ]);
    const prove = calls.find((call) => call.args.includes("pg_prove"));
    expect(prove.args).toEqual(
      expect.arrayContaining([
        "--host",
        handle.containerName,
        "--ext",
        ".sql",
        "/tests/585_account_offboarding_inventory_and_deletion.test.sql",
      ]),
    );
    expect(prove.args).not.toContain("--recurse");
    expect(calls.some((call) => call.args.includes(resolve(root, "supabase", "tests")))).toBe(
      false,
    );
    expect(calls.some((call) => call.args[0] === "rm")).toBe(true);
  });

  test("rejects an invalid path before it can start a verification cluster", async () => {
    const { root } = await createFixtureRoot();
    const startDatabase = async () => {
      throw new Error("startDatabase must not be called");
    };

    await expect(
      runFocusedOffboardingInventoryVerification({
        root,
        testPath: "supabase/tests/430_exact_record_access.test.sql",
        startDatabase,
      }),
    ).rejects.toThrow(/only permits/);
  });

  test("stops only the handle returned by the verification API", async () => {
    const { root } = await createFixtureRoot();
    const stopped = [];

    const status = await runFocusedOffboardingInventoryVerification({
      root,
      startDatabase: async () => handle,
      stopDatabase: (actualHandle, options) => stopped.push({ actualHandle, options }),
      runTest: () => 0,
    });

    expect(status).toBe(0);
    expect(stopped).toEqual([{ actualHandle: handle, options: { keep: false } }]);
  });
});
