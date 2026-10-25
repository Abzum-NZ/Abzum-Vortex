import type { DefinitionCompilationOutput } from "../definition-compilation-contracts";
import type { Resolution } from "./resolution";
import { applicationModuleKeysOf, asObject, fail, type JsonObject } from "./shared";
import { moduleDependencies } from "../module-dependencies";

export function dependencyOrder(source: JsonObject): string[] {
  const body = asObject(source.body);
  if (source.kind === "module")
    return [...moduleDependencies(source).map((entry) => entry.module), String(source.key)];
  if (source.kind === "application")
    return [
      ...applicationModuleKeysOf(body),
      ...(body.connection_bindings as JsonObject[]).map((entry) => String(entry.connection_type)),
      String(source.key),
    ];
  return [String(source.key)];
}

export function resolvedDependencies(source: JsonObject, resolution: Resolution) {
  const body = asObject(source.body);
  const keys =
    source.kind === "module"
      ? moduleDependencies(source).map((entry) => entry.module)
      : source.kind === "application"
        ? [
            ...applicationModuleKeysOf(body),
            ...(body.connection_bindings as JsonObject[]).map((entry) =>
              String(entry.connection_type),
            ),
          ]
        : [];
  return keys.map((key) => resolution.definition(key));
}

/**
 * The limits definitionPublicationContextSchema places on dependencyOutputs, for outputs that
 * already passed its element schema. the compile entry applied them on every
 * compile, so a set whose dependency outputs repeat a subject it has just compiled is still
 * refused here, with the same code and no location.
 */
export function assertDependencyOutputLimits(
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): void {
  const subjects = dependencyOutputs.map((output) =>
    output.kind === "connection_type" ? output.canonical.key : output.canonical.envelope.key,
  );
  if (subjects.length > 10_000 || new Set(subjects).size !== subjects.length)
    fail("vortex.definition.invalid_compilation_request", "invalid_value");
}
