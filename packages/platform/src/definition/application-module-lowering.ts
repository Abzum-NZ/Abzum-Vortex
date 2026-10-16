import type { ApplicationSourceDocument } from "./application-source-contracts";
import { applicationModuleKeys } from "./application-module-sources";
import {
  moduleSourceContractVersion,
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
  type SourceApplicationModule,
} from "./module-source-contracts";
import { moduleDependencies } from "./module-dependencies";
import type { JsonObject } from "./compiler/shared";

/**
 * The internal Module release unit for one inline Module: exactly the inline Module's body under
 * its alias and key, naming the Application that owns it. Its dependencies are derived from its
 * references whenever it is compiled, so they are not part of it.
 */
const moduleDocument = (
  application: ApplicationSourceDocument,
  module: SourceApplicationModule,
): JsonObject => {
  const { id, key, ...body } = module;
  return {
    source_contract_version: moduleSourceContractVersion,
    root_alias: id,
    key,
    kind: "module",
    body: { ...body, owner_application: application.key },
  };
};

/**
 * The internal Module release units an Application's inline Modules publish as, in dependency
 * order. A Module may reference only its siblings and the Modules the Application uses.
 */
export const applicationModuleSources = (
  application: ApplicationSourceDocument,
): ModuleSourceDocument[] => {
  const available = new Set(applicationModuleKeys(application));
  const sources = application.body.modules.map((module) =>
    moduleSourceDocumentSchema.parse(moduleDocument(application, module)),
  );
  const dependencies = new Map(
    sources.map((source) => [
      source.key,
      moduleDependencies(source).map((dependency) => dependency.module),
    ] as const),
  );
  for (const [key, modules] of dependencies) {
    const unknown = modules.filter((module) => !available.has(module));
    if (unknown.length > 0)
      throw new TypeError(
        `The inline Module ${key} of ${application.key} references ${unknown.join(", ")}, which the Application neither owns nor uses`,
      );
  }
  const byKey = new Map(sources.map((source) => [source.key, source]));
  const ordered: ModuleSourceDocument[] = [];
  const placed = new Set<string>();
  while (ordered.length < sources.length) {
    const next = sources.find(
      (source) =>
        !placed.has(source.key) &&
        dependencies.get(source.key)!.every((module) => placed.has(module) || !byKey.has(module)),
    );
    if (next === undefined)
      throw new TypeError(`The inline Modules of ${application.key} depend on each other in a cycle`);
    placed.add(next.key);
    ordered.push(next);
  }
  return ordered;
};
