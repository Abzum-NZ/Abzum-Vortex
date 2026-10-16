import type { ApplicationSourceDocument } from "./application-source-contracts";
import { applicationModuleKeys } from "./application-module-sources";
import { compareCanonicalStrings } from "./canonical-json";
import {
  moduleSourceContractVersion,
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
  type SourceApplicationModule,
} from "./module-source-contracts";
import { valueAtPath, type JsonObject } from "./compiler/shared";
import { sourceContractPositions } from "./compiler/source-paths";

/** The internal Module release unit for one inline Module, with the given dependencies. */
const moduleDocument = (
  application: ApplicationSourceDocument,
  module: SourceApplicationModule,
  dependencies: readonly string[],
): JsonObject => {
  const { id, key, ...body } = module;
  const localKeys = dependencies.map((dependency) => dependency.slice(dependency.lastIndexOf(".") + 1));
  return {
    source_contract_version: moduleSourceContractVersion,
    root_alias: id,
    key,
    kind: "module",
    body: {
      ...body,
      owner_application: application.key,
      dependencies: dependencies.map((dependency, index) => ({
        dependency_key:
          localKeys.indexOf(localKeys[index]!) === index
            ? localKeys[index]
            : `${localKeys[index]}_${index}`,
        module: dependency,
        version: { selection: "allowed_range", expression: "*" },
      })),
    },
  };
};

/** Every string held at or below one source position. */
const stringsAt = (value: unknown, into: string[]): string[] => {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsAt(item, into);
  else if (value !== null && typeof value === "object")
    for (const item of Object.values(value)) stringsAt(item, into);
  return into;
};

/**
 * The Modules an inline Module depends on: every sibling or used Module named by one of its
 * qualified references (`module_key:...`). Only the positions the source contract declares as
 * compiled into a canonical identity are read (the provenance targets the compiler checks every
 * transformation against), so names, labels and descriptions, which compile unchanged, never
 * create a dependency. A Module never declares its dependencies.
 */
const inlineModuleDependencies = (
  application: ApplicationSourceDocument,
  module: SourceApplicationModule,
  available: readonly string[],
): string[] => {
  const document = moduleDocument(application, module, []);
  const references = sourceContractPositions(document)
    .provenanceTargets.filter(
      ({ sourcePath, annotation }) =>
        sourcePath[0] === "body" && annotation.canonicalTargets.length > 0,
    )
    .flatMap(({ sourcePath }) => stringsAt(valueAtPath(document, sourcePath), []));
  return available
    .filter(
      (key) =>
        key !== module.key &&
        references.some((value) => value === key || value.startsWith(`${key}:`)),
    )
    .sort(compareCanonicalStrings);
};

/**
 * The internal Module release units an Application's inline Modules publish as, in dependency
 * order. Each records its owning Application and the dependencies derived from its references to
 * its siblings and to the Modules the Application uses, accepting the current release of each.
 */
export const applicationModuleSources = (
  application: ApplicationSourceDocument,
): ModuleSourceDocument[] => {
  const available = applicationModuleKeys(application);
  const sources = application.body.modules.map((module) =>
    moduleSourceDocumentSchema.parse(
      moduleDocument(
        application,
        module,
        inlineModuleDependencies(application, module, available),
      ),
    ),
  );
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
      throw new TypeError(`The inline Modules of ${application.key} depend on each other in a cycle`);
    placed.add(next.key);
    ordered.push(next);
  }
  return ordered;
};
