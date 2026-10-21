import { compareCanonicalStrings } from "./canonical-json";
import { namespacedKeySchema } from "../catalogue/identifiers";
import { sourceContractPositions } from "./compiler/source-paths";
import { valueAtPath, type JsonObject, type Path } from "./compiler/shared";

/** One Module another Module depends on, as the compiler reads it. It is never stored. */
export type DerivedModuleDependency = Readonly<{
  dependency_key: string;
  module: string;
  version: Readonly<{ selection: "allowed_range"; expression: "*" }>;
}>;

/** Every string held at or below one source position, with its path. */
const stringsAt = (value: unknown, path: Path, into: [Path, string][]): [Path, string][] => {
  if (typeof value === "string") into.push([path, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => stringsAt(item, [...path, index], into));
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value)) stringsAt(item, [...path, key], into);
  return into;
};

/** The Module a qualified reference (`module_key:...`) names, if it names one. */
const referencedModule = (value: string): string | undefined => {
  const separator = value.indexOf(":");
  if (separator <= 0) return undefined;
  const key = value.slice(0, separator);
  return namespacedKeySchema.safeParse(key).success ? key : undefined;
};

/**
 * The source leaves of a Module that reference another Module, by that Module's key. Only the
 * positions the source contract declares as compiled into a canonical identity are read, so names,
 * labels and descriptions never create a dependency.
 */
export const moduleReferencePaths = (document: object): ReadonlyMap<string, readonly Path[]> => {
  let references = referencePathsBySource.get(document);
  if (references === undefined) {
    references = collectModuleReferencePaths(document);
    referencePathsBySource.set(document, references);
  }
  return references;
};

// A pure function of the source object, asked for by every step of one compile; computed once.
const referencePathsBySource = new WeakMap<object, ReadonlyMap<string, readonly Path[]>>();

const collectModuleReferencePaths = (document: object): ReadonlyMap<string, readonly Path[]> => {
  const source = document as JsonObject;
  const own = String(source.key);
  const references = new Map<string, Path[]>();
  for (const { sourcePath, annotation } of sourceContractPositions(source).provenanceTargets) {
    if (sourcePath[0] !== "body" || annotation.canonicalTargets.length === 0) continue;
    for (const [path, value] of stringsAt(valueAtPath(source, sourcePath), sourcePath, [])) {
      const module = referencedModule(value);
      if (module === undefined || module === own) continue;
      const paths = references.get(module) ?? [];
      if (!paths.some((existing) => existing.join("\u0000") === path.join("\u0000"))) paths.push(path);
      references.set(module, paths);
    }
  }
  return references;
};

/**
 * The Modules a Module depends on, derived every time from the qualified references it makes. A
 * Module never declares them and its stored source never holds them. Each accepts the current
 * release of its target; its local key is the target's last key segment, made unique by position.
 */
export const moduleDependencies = (source: object): readonly DerivedModuleDependency[] => {
  const modules = [...moduleReferencePaths(source).keys()].sort(compareCanonicalStrings);
  const localKeys = modules.map((module) => module.slice(module.lastIndexOf(".") + 1));
  return modules.map((module, index) => ({
    dependency_key: localKeys.indexOf(localKeys[index]!) === index ? localKeys[index]! : `${localKeys[index]}_${index}`,
    module,
    version: { selection: "allowed_range", expression: "*" },
  }));
};
