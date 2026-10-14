import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { validateSourcesOffline } from "@vortex/platform/server";
import { shippedModuleSources } from "@vortex/definitions";
import { platformPermissionSource } from "../../app/_lib/platform-permission-source";

/**
 * Compiles every shipped definition source the way publication does, without a database, and
 * prints one line per failure naming the source file, the definition, the located part and the
 * reason. It exits non-zero on any failure; `pnpm guard` runs it.
 */
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const definitionsRoot = join(repositoryRoot, "packages/definitions/src");

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".json") || name.endsWith(".ts") ? [path] : [];
  });

const files = sourceFiles(definitionsRoot).map((path) => ({
  path: relative(repositoryRoot, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

/** The file that declares a source: the one holding its `key` property with that exact value. */
const fileDeclaring = (definitionKey: string): string =>
  files.find(
    (file) =>
      file.text.includes(`"key": "${definitionKey}"`) ||
      file.text.includes(`key: "${definitionKey}"`),
  )?.path ?? "packages/definitions/src";

const failures = validateSourcesOffline(shippedModuleSources, platformPermissionSource);
for (const failure of failures)
  console.error(
    `${fileDeclaring(failure.definitionKey)}:1: blocking definition-validation: ${failure.definitionKey} ${failure.stage} ${failure.code} at ${failure.location}${failure.detail === undefined ? "" : `: ${failure.detail}`}`,
  );
if (failures.length > 0) process.exitCode = 1;
else console.log(`Definition validation passed (${shippedModuleSources.length} Modules).`);
