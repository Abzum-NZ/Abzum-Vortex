import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadDatabaseVerificationManifest } from "./database-verification-manifest.mjs";

const temporaryDirectories = [];
const firstMigration = "supabase/migrations/20990101000000_first.sql";
const secondMigration = "supabase/migrations/20990101000001_second.sql";
const firstProof = "supabase/tests/first-concurrency.test.sh";
const secondProof = "supabase/tests/second-concurrency.test.sh";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const entry = (migration, proof, label) => ({ migration, proof, label });

const createFixture = async ({
  concurrencyProofs = [
    entry(firstMigration, firstProof, "First"),
    entry(secondMigration, secondProof, "Second"),
  ],
  lintSchemas = ["public", "vortex_fixture"],
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "vortex-database-manifest-"));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(join(root, "supabase", "migrations"), { recursive: true }),
    mkdir(join(root, "supabase", "tests"), { recursive: true }),
    mkdir(join(root, "workflows", "kestra"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, ...firstMigration.split("/")),
      "create schema vortex_fixture authorization postgres;\n",
    ),
    writeFile(join(root, ...secondMigration.split("/")), "select 1;\n"),
    writeFile(join(root, ...firstProof.split("/")), "exit 0\n"),
    writeFile(join(root, ...secondProof.split("/")), "exit 0\n"),
    writeFile(
      join(root, "workflows", "kestra", "database-verification.json"),
      JSON.stringify({ schemaVersion: 1, concurrencyProofs, lintSchemas }),
    ),
  ]);
  return root;
};

describe("Database verification manifest", () => {
  test("refuses a schema created by migrations but omitted from lint", async () => {
    const root = await createFixture({ lintSchemas: ["public"] });

    await expect(loadDatabaseVerificationManifest(root)).rejects.toThrow(
      "must list every operated schema exactly once",
    );
  });

  test("refuses a lint schema that migrations do not create", async () => {
    const root = await createFixture({
      lintSchemas: ["public", "vortex_fixture", "vortex_uncreated"],
    });

    await expect(loadDatabaseVerificationManifest(root)).rejects.toThrow(
      "must list every operated schema exactly once",
    );
  });

  test("refuses duplicate lint schemas", async () => {
    const root = await createFixture({
      lintSchemas: ["public", "vortex_fixture", "vortex_fixture"],
    });

    await expect(loadDatabaseVerificationManifest(root)).rejects.toThrow("duplicate lint schema");
  });

  test("refuses duplicate migration entries", async () => {
    const root = await createFixture({
      concurrencyProofs: [
        entry(firstMigration, firstProof, "First"),
        entry(firstMigration, secondProof, "Duplicate migration"),
      ],
    });

    await expect(loadDatabaseVerificationManifest(root)).rejects.toThrow("duplicate migration");
  });

  test("refuses duplicate concurrency proof entries", async () => {
    const root = await createFixture({
      concurrencyProofs: [
        entry(firstMigration, firstProof, "First"),
        entry(secondMigration, firstProof, "Duplicate proof"),
      ],
    });

    await expect(loadDatabaseVerificationManifest(root)).rejects.toThrow(
      "duplicate concurrency proof",
    );
  });
});
