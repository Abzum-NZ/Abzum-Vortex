import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  compileModulesOffline,
  createImmutableDefinitionPublicationCatalogue,
  validateApplicationsOffline,
} from "@vortex/platform/server";
import { shippedApplications, shippedModuleSources } from "@vortex/definitions";
import { describeFailure } from "@vortex/platform/schema";
import { installedReleaseCatalogue } from "../../app/_lib/definition-catalogue";
import { platformPermissionSource } from "../../app/_lib/platform-permission-source";

/**
 * Compiles every shipped Module and Application source the way publication does, without a database, and
 * prints (or, with `--json`, returns as data for `pnpm guard`) one entry per failure naming the source file, the definition, the located part and the
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

/** The file and line that declare a source: the one holding its `key` property with that exact value. */
const declaration = (definitionKey: string): { path: string; line: number } => {
  for (const file of files) {
    const match = [`"key": "${definitionKey}"`, `key: "${definitionKey}"`]
      .map((needle) => file.text.indexOf(needle))
      .find((index) => index >= 0);
    if (match !== undefined)
      return { path: file.path, line: file.text.slice(0, match).split("\n").length };
  }
  return { path: "packages/definitions/src", line: 1 };
};

const main = async (): Promise<void> => {
  const modules = compileModulesOffline(shippedModuleSources, platformPermissionSource);
  const failures = [
    ...modules.failures,
    ...(await validateApplicationsOffline(
      shippedApplications.map(({ source }) => source),
      modules.compiled,
      createImmutableDefinitionPublicationCatalogue(installedReleaseCatalogue),
      platformPermissionSource,
    )),
  ];
  const describe = (failure: (typeof failures)[number]): string =>
    `${failure.definitionKey} ${failure.stage} ${failure.code} at ${failure.location}${failure.detail === undefined ? "" : `: ${failure.detail}`}`;
  if (process.argv.includes("--json"))
    console.log(
      JSON.stringify(
        failures.map((failure) => ({
          ...declaration(failure.definitionKey),
          detail: describe(failure),
        })),
      ),
    );
  else {
    for (const failure of failures) {
      const { path, line } = declaration(failure.definitionKey);
      console.error(`${path}:${line}: blocking definition-validation: ${describe(failure)}`);
    }
    if (failures.length === 0)
      console.log(
        `Definition validation passed (${shippedModuleSources.length} Modules, ${shippedApplications.length} Applications).`,
      );
  }
  if (failures.length > 0) process.exitCode = 1;
};

main().catch((error: unknown) => {
  console.error(
    `blocking definition-validation: validation did not complete: ${describeFailure(error)}`,
  );
  process.exitCode = 1;
});
