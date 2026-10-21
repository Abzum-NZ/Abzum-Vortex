import { DefinitionCompilationError } from "./compilation-error";
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
    sources.map(
      (source) =>
        [source.key, moduleDependencies(source).map((dependency) => dependency.module)] as const,
    ),
  );
  for (const [key, modules] of dependencies) {
    const unknown = modules.filter((module) => !available.has(module));
    if (unknown.length > 0) {
      const error = new DefinitionCompilationError(
        "vortex.definition.module_dependency_resolved",
        "unresolved_reference",
        {
          documentKind: "application",
          documentKey: application.key,
          segments: [key, ...unknown].map((module) => ({ kind: "module", key: module })),
        },
      );
      error.cause = new TypeError(
        `The inline Module ${key} of ${application.key} references ${unknown.join(", ")}, which the Application neither owns nor uses`,
      );
      throw error;
    }
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
    if (next === undefined) {
      // Follow the remaining dependency edges to report the cycle itself, excluding its dependants.
      const path: string[] = [];
      const visited = new Set<string>();
      const cycleFrom = (key: string): string[] | undefined => {
        const start = path.indexOf(key);
        if (start >= 0) return path.slice(start);
        if (visited.has(key) || !byKey.has(key)) return undefined;
        path.push(key);
        for (const dependency of dependencies.get(key)!) {
          const cycle = cycleFrom(dependency);
          if (cycle !== undefined) return cycle;
        }
        path.pop();
        visited.add(key);
        return undefined;
      };
      const cycle = sources
        .map((source) => source.key)
        .reduce<string[] | undefined>((found, key) => found ?? cycleFrom(key), undefined);
      if (cycle === undefined)
        throw new Error("Module ordering stopped without a dependency cycle");
      const error = new DefinitionCompilationError(
        "vortex.definition.module_dependency_acyclic",
        "dependency_cycle",
        {
          documentKind: "application",
          documentKey: application.key,
          segments: cycle.map((key) => ({ kind: "module", key })),
        },
      );
      error.cause = new TypeError(
        `The inline Modules of ${application.key} depend on each other in a cycle: ${[...cycle, cycle[0]].join(" -> ")}`,
      );
      throw error;
    }
    placed.add(next.key);
    ordered.push(next);
  }
  return ordered;
};
