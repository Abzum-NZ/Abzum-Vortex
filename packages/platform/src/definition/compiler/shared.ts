import type { DefinitionValidationLocation } from "../../schema";
import {
  DefinitionCompilationError,
  type DefinitionCompilerRefusalCode,
} from "../compilation-error";

export type Path = (string | number)[];
export type JsonObject = Record<string, unknown>;

export const ID_FIELDS = new Set([
  "root_alias",
  "id",
  "storage_contract_id",
  "title_field",
  "ownership_relationship",
  "organization_field",
  "revision_field",
  "from_field",
  "record_type",
  "source_record_type",
  "declared_fields",
  "page",
  "query",
  "block",
  "home_page",
  "connection",
]);

export const DEFAULT_RULE = "vortex.definition.fixed_execution_default";
export const SYSTEM_RULE = "vortex.definition.system_metadata";
export const RESOLUTION_RULE = "vortex.definition.immutable_resolution";
export const TRANSFORM_RULE = "vortex.definition.semantic_transform";

export function fail(
  ruleCode: DefinitionCompilerRefusalCode,
  family: ConstructorParameters<typeof DefinitionCompilationError>[1],
  location?: DefinitionValidationLocation,
): never {
  throw new DefinitionCompilationError(ruleCode, family, location);
}

export function compilerRootLocation(source: JsonObject): DefinitionValidationLocation {
  const documentKind = source.kind as "module" | "application" | "connection_type";
  const documentKey = String(source.key);
  return {
    documentKind,
    documentKey,
    segments: [
      {
        kind:
          documentKind === "module"
            ? "module"
            : documentKind === "application"
              ? "application"
              : "connection",
        key: documentKey,
      },
    ],
  };
}

export function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("vortex.definition.invalid_object", "invalid_value");
  return value as JsonObject;
}

export function objectFromUniqueEntries(
  entries: Iterable<readonly [string, unknown]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (Object.prototype.hasOwnProperty.call(result, key))
      fail("vortex.definition.invalid_compilation_output", "duplicate_key");
    result[key] = value;
  }
  return result;
}

export function leafPaths(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value))
    return value.flatMap((entry, index) => leafPaths(entry, [...path, index]));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, entry]) => leafPaths(entry, [...path, key]));
  return [path];
}

export const camelCase = (value: string) =>
  value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

export function pathExists(value: unknown, path: Path): boolean {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      if (!(segment in current)) return false;
      current = current[segment];
      continue;
    }
    if (
      current === null ||
      typeof current !== "object" ||
      typeof segment !== "string" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    )
      return false;
    current = (current as JsonObject)[segment];
  }
  return true;
}

export function valueAtPath(value: unknown, path: Path): unknown {
  let current = value;
  for (const segment of path) {
    current = Array.isArray(current)
      ? current[Number(segment)]
      : (current as JsonObject)[String(segment)];
  }
  return current;
}

export const pathStartsWith = (path: Path, prefix: Path) =>
  prefix.every((segment, index) => path[index] === segment);

export function pathKey(path: Path): string {
  return JSON.stringify(path);
}
