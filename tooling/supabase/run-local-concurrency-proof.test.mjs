import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runLocalConcurrencyProofs } from "./run-local-concurrency-proof.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const fixtureProofScript = "echo fixture proof\n";

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "vortex-local-concurrency-proof-"));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(join(root, "supabase", "migrations"), { recursive: true }),
    mkdir(join(root, "supabase", "tests"), { recursive: true }),
    mkdir(join(root, "workflows", "kestra"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, "supabase", "migrations", "20990101000000_fixture.sql"),
      "create\n  schema\n  if not\n  exists\n  vortex_fixture authorization postgres;\n",
    ),
    writeFile(join(root, "supabase", "tests", "fixture-concurrency.test.sh"), fixtureProofScript),
    writeFile(
      join(root, "workflows", "kestra", "database-verification.json"),
      JSON.stringify({
        schemaVersion: 1,
        concurrencyProofs: [
          {
            migration: "supabase/migrations/20990101000000_fixture.sql",
            proof: "supabase/tests/fixture-concurrency.test.sh",
            label: "Fixture",
          },
        ],
        lintSchemas: ["public", "vortex_fixture"],
      }),
    ),
  ]);
  return root;
};

const mutedWriter = { write: () => undefined };

describe("Local concurrency proof runner", () => {
  test("execs the proof into the given container as the postgres user", async () => {
    const root = await createFixture();
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "fixture proof passed\n", stderr: "" };
    };

    const status = await runLocalConcurrencyProofs({
      root,
      containerName: "vortex-verify-abc123",
      spawn,
      stdout: mutedWriter,
      stderr: mutedWriter,
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("docker");
    expect(calls[0].args).toEqual([
      "exec",
      "--interactive",
      "--user",
      "postgres",
      "vortex-verify-abc123",
      "bash",
      "-s",
    ]);
    expect(calls[0].options.input).toBe(fixtureProofScript);
  });

  test("stops at the first failing proof and returns its exact exit status", async () => {
    const root = await createFixture();
    const spawn = () => ({ status: 7, stdout: "", stderr: "fixture proof failed\n" });

    const status = await runLocalConcurrencyProofs({
      root,
      containerName: "vortex-verify-abc123",
      spawn,
      stdout: mutedWriter,
      stderr: mutedWriter,
    });

    expect(status).toBe(7);
  });

  test("requires an explicit target container", async () => {
    const root = await createFixture();

    await expect(runLocalConcurrencyProofs({ root })).rejects.toThrow(
      /require the verification cluster's containerName/,
    );
  });

  test("propagates a launcher error", async () => {
    const root = await createFixture();
    const failure = new Error("launcher failed");

    await expect(
      runLocalConcurrencyProofs({
        root,
        containerName: "vortex-verify-abc123",
        spawn: () => ({ error: failure, status: null, stdout: "", stderr: "" }),
      }),
    ).rejects.toBe(failure);
  });
});
