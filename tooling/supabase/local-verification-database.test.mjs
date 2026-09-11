import { describe, expect, test } from "vitest";
import {
  startVerificationDatabase,
  stopVerificationDatabase,
  verificationDatabaseImage,
  VerificationDatabaseStartupError,
} from "./local-verification-database.mjs";

const noopWait = () => Promise.resolve();

const createFakeSpawn = ({
  networkCreateStatus = 0,
  runStatus = 0,
  pgIsReadyFailures = 0,
  containerRunning = "true\n",
  hostPort = "54999",
  pushStatus = 0,
} = {}) => {
  const calls = [];
  let pgIsReadyAttempts = 0;

  const spawn = (command, args) => {
    calls.push({ command, args });
    const joined = args.join(" ");

    if (command === "docker" && args[0] === "network" && args[1] === "create")
      return { status: networkCreateStatus, stdout: "", stderr: networkCreateStatus === 0 ? "" : "network failed" };
    if (command === "docker" && args[0] === "network" && args[1] === "rm")
      return { status: 0, stdout: "", stderr: "" };
    if (command === "docker" && args[0] === "run")
      return { status: runStatus, stdout: "", stderr: runStatus === 0 ? "" : "run failed" };
    if (command === "docker" && args[0] === "exec" && args.includes("pg_isready")) {
      pgIsReadyAttempts += 1;
      if (pgIsReadyAttempts <= pgIsReadyFailures) return { status: 1, stdout: "", stderr: "" };
      return { status: 0, stdout: "accepting connections\n", stderr: "" };
    }
    if (command === "docker" && args[0] === "inspect" && joined.includes("State.Running"))
      return { status: 0, stdout: containerRunning, stderr: "" };
    if (command === "docker" && args[0] === "inspect" && joined.includes("NetworkSettings.Ports"))
      return {
        status: 0,
        stdout: JSON.stringify({ "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }] }),
        stderr: "",
      };
    if (command === "docker" && args[0] === "rm") return { status: 0, stdout: "", stderr: "" };
    if (command !== "docker")
      return { status: pushStatus, stdout: "push output\n", stderr: pushStatus === 0 ? "" : "push failed" };

    throw new Error(`Unexpected spawn call in test fake: ${command} ${joined}`);
  };

  return { spawn, calls };
};

const mutedWriter = { write: () => undefined };

describe("Local verification database lifecycle", () => {
  test("starts one fresh container and network, waits for readiness, and migrates and seeds it", async () => {
    const { spawn, calls } = createFakeSpawn({ hostPort: "58201" });

    const handle = await startVerificationDatabase({
      root: "/fake/root",
      spawn,
      wait: noopWait,
      stdout: mutedWriter,
      stderr: mutedWriter,
    });

    expect(handle.containerName).toMatch(/^vortex-verify-[0-9a-f]+$/);
    expect(handle.networkName).toBe(`${handle.containerName}-net`);
    expect(handle.hostPort).toBe("58201");
    expect(handle.url).toBe(`postgresql://postgres:${handle.password}@127.0.0.1:58201/postgres?sslmode=disable`);
    expect(handle.password.length).toBeGreaterThanOrEqual(32);

    const runCall = calls.find((call) => call.args[0] === "run");
    expect(runCall.args).toEqual(
      expect.arrayContaining([
        "--name",
        handle.containerName,
        "--network",
        handle.networkName,
        "-p",
        "127.0.0.1::5432",
        "--shm-size=64m",
        verificationDatabaseImage,
      ]),
    );

    const pushCall = calls.at(-1);
    expect(pushCall.command).not.toBe("docker");
    expect(pushCall.args).toEqual(
      expect.arrayContaining(["db", "push", "--db-url", handle.url, "--include-seed", "--yes"]),
    );
  });

  test("polls pg_isready until the container accepts connections before migrating", async () => {
    const { spawn, calls } = createFakeSpawn({ pgIsReadyFailures: 2 });

    await startVerificationDatabase({ root: "/fake/root", spawn, wait: noopWait, stdout: mutedWriter, stderr: mutedWriter });

    const readyChecks = calls.filter((call) => call.args.includes("pg_isready"));
    expect(readyChecks).toHaveLength(3);
  });

  test("removes the network and throws when the container fails to start", async () => {
    const { spawn, calls } = createFakeSpawn({ runStatus: 1 });

    await expect(
      startVerificationDatabase({ root: "/fake/root", spawn, wait: noopWait, stdout: mutedWriter, stderr: mutedWriter }),
    ).rejects.toThrow(/Failed to start the verification database container/);

    expect(calls.some((call) => call.args[0] === "network" && call.args[1] === "rm")).toBe(true);
    expect(calls.some((call) => call.args[0] === "rm")).toBe(false);
  });

  test("keeps the container and reports the handle when it never becomes ready", async () => {
    let now = 0;
    const fakeNow = () => {
      const value = now;
      now = 1_000_000; // exceed the deadline on the next comparison
      return value;
    };
    const { spawn, calls } = createFakeSpawn({ pgIsReadyFailures: Infinity });

    const failure = await startVerificationDatabase({
      root: "/fake/root",
      spawn,
      wait: noopWait,
      now: fakeNow,
      stdout: mutedWriter,
      stderr: mutedWriter,
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(VerificationDatabaseStartupError);
    expect(failure.handle.containerName).toMatch(/^vortex-verify-/);
    expect(calls.some((call) => call.args[0] === "rm" || (call.args[0] === "network" && call.args[1] === "rm"))).toBe(
      false,
    );
  });

  test("keeps the container and reports the handle when migrations fail to apply", async () => {
    const { spawn, calls } = createFakeSpawn({ pushStatus: 1 });

    const failure = await startVerificationDatabase({
      root: "/fake/root",
      spawn,
      wait: noopWait,
      stdout: mutedWriter,
      stderr: mutedWriter,
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(VerificationDatabaseStartupError);
    expect(failure.handle.url).toContain("sslmode=disable");
    expect(calls.some((call) => call.args[0] === "rm" || (call.args[0] === "network" && call.args[1] === "rm"))).toBe(
      false,
    );
  });
});

describe("Local verification database teardown", () => {
  test("removes the container and network by default", () => {
    const { spawn, calls } = createFakeSpawn();
    stopVerificationDatabase({ containerName: "vortex-verify-abc123", networkName: "vortex-verify-abc123-net" }, { spawn });

    expect(calls).toEqual([
      { command: "docker", args: ["rm", "--force", "vortex-verify-abc123"] },
      { command: "docker", args: ["network", "rm", "vortex-verify-abc123-net"] },
    ]);
  });

  test("removes nothing when the caller asks to keep the cluster", () => {
    const { spawn, calls } = createFakeSpawn();
    stopVerificationDatabase(
      { containerName: "vortex-verify-abc123", networkName: "vortex-verify-abc123-net" },
      { spawn, keep: true },
    );

    expect(calls).toHaveLength(0);
  });
});
