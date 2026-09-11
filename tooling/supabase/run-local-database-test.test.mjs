import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { pgProveImage, runLocalDatabaseTest } from "./run-local-database-test.mjs";

const mutedWriter = { write: () => undefined };

const createFakeSpawn = ({ runStatus = 0, copyStatus = 0, proveStatus = 0 } = {}) => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "run") return { status: runStatus, stdout: "", stderr: runStatus === 0 ? "" : "run failed" };
    if (args[0] === "cp") return { status: copyStatus, stdout: "", stderr: copyStatus === 0 ? "" : "copy failed" };
    if (args[0] === "exec") return { status: proveStatus, stdout: "pg_prove output\n", stderr: "" };
    if (args[0] === "rm") return { status: 0, stdout: "", stderr: "" };
    throw new Error(`Unexpected spawn call in test fake: ${command} ${args.join(" ")}`);
  };
  return { spawn, calls };
};

describe("Local pgTAP runner", () => {
  test("copies the tests into a harness container on the given network and proves them against the target container", () => {
    const { spawn, calls } = createFakeSpawn();

    const status = runLocalDatabaseTest({
      root: "/fake/root",
      containerName: "vortex-verify-abc123",
      networkName: "vortex-verify-abc123-net",
      password: "throwaway-pw",
      spawn,
      stdout: mutedWriter,
      stderr: mutedWriter,
    });

    expect(status).toBe(0);

    const runCall = calls.find((call) => call.args[0] === "run");
    expect(runCall.args).toEqual(
      expect.arrayContaining(["--network", "vortex-verify-abc123-net", pgProveImage]),
    );
    const helperName = "vortex-verify-abc123-pgtap";
    expect(runCall.args).toEqual(expect.arrayContaining(["--name", helperName]));

    const copyCall = calls.find((call) => call.args[0] === "cp");
    expect(copyCall.args).toEqual(["cp", resolve("/fake/root", "supabase", "tests"), `${helperName}:/tests`]);

    const proveCall = calls.find((call) => call.args[0] === "exec");
    expect(proveCall.args).toEqual(
      expect.arrayContaining(["PGPASSWORD=throwaway-pw", "--host", "vortex-verify-abc123", "--ext", ".sql", "--recurse", "/tests"]),
    );

    expect(calls.filter((call) => call.args[0] === "rm")).toHaveLength(1);
  });

  test("returns the exact pg_prove exit status", () => {
    const { spawn } = createFakeSpawn({ proveStatus: 3 });

    const status = runLocalDatabaseTest({
      root: "/fake/root",
      containerName: "vortex-verify-abc123",
      networkName: "vortex-verify-abc123-net",
      password: "throwaway-pw",
      spawn,
      stdout: mutedWriter,
      stderr: mutedWriter,
    });

    expect(status).toBe(3);
  });

  test("still removes the harness container when pg_prove fails", () => {
    const { spawn, calls } = createFakeSpawn({ proveStatus: 1 });

    runLocalDatabaseTest({
      root: "/fake/root",
      containerName: "vortex-verify-abc123",
      networkName: "vortex-verify-abc123-net",
      password: "throwaway-pw",
      spawn,
      stdout: mutedWriter,
      stderr: mutedWriter,
    });

    expect(calls.some((call) => call.args[0] === "rm" && call.args.includes("vortex-verify-abc123-pgtap"))).toBe(true);
  });

  test("throws without starting a copy or pg_prove when the harness container fails to start", () => {
    const { spawn, calls } = createFakeSpawn({ runStatus: 1 });

    expect(() =>
      runLocalDatabaseTest({
        root: "/fake/root",
        containerName: "vortex-verify-abc123",
        networkName: "vortex-verify-abc123-net",
        password: "throwaway-pw",
        spawn,
        stdout: mutedWriter,
        stderr: mutedWriter,
      }),
    ).toThrow(/Failed to start the pgTAP harness container/);

    expect(calls.some((call) => call.args[0] === "cp" || call.args[0] === "exec")).toBe(false);
  });

  test("requires the container name, network name, and password", () => {
    expect(() => runLocalDatabaseTest({ root: "/fake/root" })).toThrow(
      /requires the verification cluster's containerName, networkName, and password/,
    );
  });
});
