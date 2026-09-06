import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

const manifestRelativePath = "workflows/kestra/database-verification.json";
const migrationPattern = /^supabase\/migrations\/[0-9]{14}_[a-z0-9_]+\.sql$/;
const proofPattern = /^supabase\/tests\/[a-z0-9-]+-concurrency\.test\.sh$/;
const schemaPattern = /^(?:public|vortex_[a-z0-9_]+)$/;

const sameValues = (left, right) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const unique = (values, label) => {
  if (new Set(values).size !== values.length)
    throw new Error(`Database verification manifest contains a duplicate ${label}`);
};

const requireRegularFile = async (root, relativePath) => {
  const absolutePath = resolve(root, ...relativePath.split("/"));
  const expectedPrefix = `${resolve(root)}${sep}`;
  if (!absolutePath.startsWith(expectedPrefix))
    throw new Error("Database verification manifest path leaves the repository");
  const file = await lstat(absolutePath);
  if (!file.isFile() || file.isSymbolicLink())
    throw new Error(`Database verification file is not a regular file: ${relativePath}`);
};

export const loadDatabaseVerificationManifest = async (root) => {
  const manifestPath = resolve(root, ...manifestRelativePath.split("/"));
  const value = JSON.parse(await readFile(manifestPath, "utf8"));

  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !sameValues(Object.keys(value).sort(), ["concurrencyProofs", "lintSchemas", "schemaVersion"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.concurrencyProofs) ||
    value.concurrencyProofs.length === 0 ||
    !Array.isArray(value.lintSchemas) ||
    value.lintSchemas.length === 0
  )
    throw new Error("Database verification manifest has an invalid top-level contract");

  for (const entry of value.concurrencyProofs) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !sameValues(Object.keys(entry).sort(), ["label", "migration", "proof"]) ||
      typeof entry.migration !== "string" ||
      !migrationPattern.test(entry.migration) ||
      typeof entry.proof !== "string" ||
      !proofPattern.test(entry.proof) ||
      typeof entry.label !== "string" ||
      !/^[A-Za-z0-9 .-]{1,100}$/.test(entry.label)
    )
      throw new Error("Database verification manifest contains an invalid proof entry");
    await requireRegularFile(root, entry.migration);
    await requireRegularFile(root, entry.proof);
  }

  unique(
    value.concurrencyProofs.map(({ migration }) => migration),
    "migration",
  );
  unique(
    value.concurrencyProofs.map(({ proof }) => proof),
    "concurrency proof",
  );

  const repositoryProofs = (await readdir(resolve(root, "supabase/tests")))
    .filter((name) => /^[a-z0-9-]+-concurrency\.test\.sh$/.test(name))
    .map((name) => `supabase/tests/${name}`)
    .sort();
  const manifestProofs = value.concurrencyProofs.map(({ proof }) => proof).sort();
  if (!sameValues(manifestProofs, repositoryProofs))
    throw new Error(
      "Database verification manifest must list every concurrency proof exactly once",
    );

  if (value.lintSchemas.some((schema) => typeof schema !== "string" || !schemaPattern.test(schema)))
    throw new Error("Database verification manifest contains an invalid lint schema");
  unique(value.lintSchemas, "lint schema");

  const createdSchemas = new Set(["public"]);
  const migrationNames = (await readdir(resolve(root, "supabase/migrations"))).filter((name) =>
    /^[0-9]{14}_[a-z0-9_]+\.sql$/.test(name),
  );
  for (const migrationName of migrationNames) {
    const sql = await readFile(resolve(root, "supabase/migrations", migrationName), "utf8");
    for (const match of sql.matchAll(
      /\bcreate\s+schema\s+(?:if\s+not\s+exists\s+)?(vortex_[a-z0-9_]+)/gi,
    ))
      createdSchemas.add(match[1].toLowerCase());
  }
  if (!sameValues([...value.lintSchemas].sort(), [...createdSchemas].sort()))
    throw new Error("Database verification manifest must list every operated schema exactly once");

  return Object.freeze({
    concurrencyProofs: Object.freeze(value.concurrencyProofs.map((entry) => Object.freeze(entry))),
    lintSchemas: Object.freeze([...value.lintSchemas]),
  });
};
