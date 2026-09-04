import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runLocalDatabaseLint } from "./run-local-database-lint.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const createFixture = async (cliSource) => {
  const root = await mkdtemp(join(tmpdir(), "vortex-local-database-lint-"));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(join(root, "node_modules", "supabase", "dist"), { recursive: true }),
    mkdir(join(root, "supabase", "migrations"), { recursive: true }),
    mkdir(join(root, "supabase", "tests"), { recursive: true }),
    mkdir(join(root, "workflows", "kestra"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "node_modules", "supabase", "dist", "supabase.js"), cliSource),
    writeFile(
      join(root, "supabase", "migrations", "20990101000000_fixture.sql"),
      "create\n  schema\n  if not\n  exists\n  vortex_fixture authorization postgres;\n",
    ),
    writeFile(join(root, "supabase", "tests", "fixture-concurrency.test.sh"), "exit 0\n"),
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

describe("Local database lint launcher", () => {
  test("launches the pinned package entry through Node with the complete manifest schemas", async () => {
    const root = await createFixture(
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    let output = "";

    const status = await runLocalDatabaseLint({
      root,
      stdout: { write: (value) => (output += value) },
      stderr: { write: () => undefined },
    });

    expect(status).toBe(0);
    expect(JSON.parse(output)).toEqual([
      "db",
      "lint",
      "--schema",
      "public,vortex_fixture",
      "--level",
      "warning",
      "--fail-on",
      "error",
    ]);
  });

  test("returns the exact child failure status", async () => {
    const root = await createFixture("process.exit(23);\n");

    await expect(runLocalDatabaseLint({ root })).resolves.toBe(23);
  });

  test("propagates a launcher error", async () => {
    const root = await createFixture("process.exit(0);\n");
    const failure = new Error("launcher failed");

    await expect(
      runLocalDatabaseLint({
        root,
        spawn: () => ({ error: failure, status: null, stderr: "", stdout: "" }),
      }),
    ).rejects.toBe(failure);
  });
});
