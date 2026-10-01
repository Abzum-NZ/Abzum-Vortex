import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(repositoryRoot, "contracts/src/identity-access.ts");
const initialMigrationPath = path.join(
  repositoryRoot,
  "supabase/migrations/20261001193000_organization_settings_cleanup.sql",
);
const beginMarker = "-- BEGIN GENERATED: organization settings reference seed";
const endMarker = "-- END GENERATED: organization settings reference seed";

// These versioned arrays are immutable inputs to the initial migration. Current
// contract aliases may advance only with a forward migration for the new values.
const lists = [
  {
    exportName: "currentIso4217Alpha3CodesV2026_01_01",
    referenceName: "organization_runtime_settings_currency",
    validate: (value) => /^[A-Z]{3}$/.test(value),
  },
  {
    exportName: "organizationRuntimeSettingsDateFormatsV2026_09_29",
    referenceName: "organization_runtime_settings_date_format",
    validate: (value) => /^[a-z]+$/.test(value),
  },
  {
    exportName: "organizationRuntimeSettingsNumberFormatsV2026_09_29",
    referenceName: "organization_runtime_settings_number_format",
    validate: (value) => /^[a-z0-9]+$/.test(value),
  },
];

function readStringArray(source, exportName) {
  const declaration = new RegExp(
    `^export const ${exportName} = \\[\\r?\\n([\\s\\S]*?)\\r?\\n\\] as const;`,
    "m",
  );
  const match = source.match(declaration);
  if (!match) {
    throw new Error(`Could not find the literal exported array ${exportName}.`);
  }

  const values = match[1]
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const entry = line.match(/^\s*"([^"\\]+)",?\s*$/);
      if (!entry) {
        throw new Error(`Unexpected non-literal entry in ${exportName}: ${line}`);
      }
      return entry[1];
    });

  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`${exportName} must be non-empty and contain unique values.`);
  }
  return values;
}

function renderSeed(source) {
  const rows = lists.flatMap(({ exportName, referenceName, validate }) => {
    const values = readStringArray(source, exportName);
    return values.map((value, index) => {
      if (!validate(value)) {
        throw new Error(`Invalid value in ${exportName}: ${value}`);
      }
      return `  ('${referenceName}', '${value}', ${index + 1})`;
    });
  });

  return {
    rowCount: rows.length,
    sql: [
      beginMarker,
      "insert into vortex_access.validation_reference_values (",
      "  reference_list, reference_value, reference_ordinal",
      ") values",
      `${rows.join(",\n")}\n;`,
      endMarker,
    ].join("\n"),
  };
}

function replaceSeedBlock(migration, generatedSeed) {
  const beginCount = migration.split(beginMarker).length - 1;
  const endCount = migration.split(endMarker).length - 1;
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error("Expected exactly one generated settings-seed marker pair in the migration.");
  }

  const start = migration.indexOf(beginMarker);
  const end = migration.indexOf(endMarker);
  if (end <= start) {
    throw new Error("Generated settings-seed markers are out of order.");
  }

  const afterEnd = end + endMarker.length;
  return `${migration.slice(0, start)}${generatedSeed}${migration.slice(afterEnd)}`;
}

if (process.argv.length !== 3 || process.argv[2] !== "--check") {
  process.stderr.write(
    "Usage: node tooling/generate-organization-runtime-settings-reference-seed.mjs --check\n" +
      "The versioned contract arrays in contracts/src/identity-access.ts are the source of the initial seed. " +
      "This command is read-only; later list versions require a forward migration.\n",
  );
  process.exitCode = 2;
} else {
  const [contract, migration] = await Promise.all([
    readFile(contractPath, "utf8"),
    readFile(initialMigrationPath, "utf8"),
  ]);
  const { sql: generatedSeed, rowCount } = renderSeed(contract);
  const expectedMigration = replaceSeedBlock(migration, generatedSeed);

  if (migration !== expectedMigration) {
    process.stderr.write(
      "The initial migration seed differs from its immutable versioned contract arrays. Preserve applied migrations and use a forward migration for later versions.\n",
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Initial organization runtime settings seed matches its versioned contract arrays (${rowCount} rows).\n`,
    );
  }
}
