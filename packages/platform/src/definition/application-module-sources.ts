import type { ApplicationSourceDocument } from "./application-source-contracts";
import {
  moduleSourceContractVersion,
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
  type SourceApplicationModule,
} from "./module-source-contracts";
import { compareCanonicalStrings } from "./canonical-json";

/** Every Module an Application builds on: the ones it owns and the ones it uses. */
export const applicationModuleKeys = (application: ApplicationSourceDocument): string[] => [
  ...application.body.modules.map((module) => module.key),
  ...application.body.uses.map((use) => use.module),
];

/** Every string the Module holds, at any depth. */
const collectStrings = (value: unknown, into: Set<string>): Set<string> => {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value !== null && typeof value === "object")
    for (const item of Object.values(value)) collectStrings(item, into);
  return into;
};

/**
 * The Modules an inline Module depends on: every sibling or used Module it names in a qualified
 * reference (`module_key:...`). A Module never declares them; this is the only way they are set.
 */
export const inlineModuleDependencies = (
  module: SourceApplicationModule,
  available: readonly string[],
): string[] => {
  const strings = [...collectStrings(module, new Set())];
  return available
    .filter(
      (key) =>
        key !== module.key && strings.some((value) => value === key || value.startsWith(`${key}:`)),
    )
    .sort(compareCanonicalStrings);
};

/**
 * The internal Module release units an Application's inline Modules publish as, in dependency
 * order: each one carries the dependencies derived from its references to its siblings and to the
 * Modules the Application uses, and accepts the current release of each.
 */
export const applicationModuleSources = (
  application: ApplicationSourceDocument,
): ModuleSourceDocument[] => {
  const available = applicationModuleKeys(application);
  const sources = application.body.modules.map((module) => {
    const { id, key, ...body } = module;
    const dependencies = inlineModuleDependencies(module, available);
    const localKeys = dependencies.map((dependency) =>
      dependency.slice(dependency.lastIndexOf(".") + 1),
    );
    return moduleSourceDocumentSchema.parse({
      source_contract_version: moduleSourceContractVersion,
      root_alias: id,
      key,
      kind: "module",
      body: {
        ...body,
        dependencies: dependencies.map((dependency, index) => ({
          dependency_key:
            localKeys.indexOf(localKeys[index]!) === index
              ? localKeys[index]
              : `${localKeys[index]}_${index}`,
          module: dependency,
          version: { selection: "allowed_range", expression: "*" },
        })),
      },
    });
  });
  const byKey = new Map(sources.map((source) => [source.key, source]));
  const ordered: ModuleSourceDocument[] = [];
  const placed = new Set<string>();
  while (ordered.length < sources.length) {
    const next = sources.find(
      (source) =>
        !placed.has(source.key) &&
        source.body.dependencies.every(
          (dependency) => placed.has(dependency.module) || !byKey.has(dependency.module),
        ),
    );
    if (next === undefined)
      throw new TypeError(
        `The inline Modules of ${application.key} depend on each other in a cycle`,
      );
    placed.add(next.key);
    ordered.push(next);
  }
  return ordered;
};
