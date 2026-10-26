import { canonicalJson } from "./canonical-json-definition";
import type { ExactDefinitionDependency } from "./definition-store-contracts";

/**
 * The platform service operations and connection types a release manifest pins, in one canonical
 * order. Module and platform block pins are compared through the content itself.
 */
export const platformPins = (manifest: readonly unknown[]): readonly ExactDefinitionDependency[] =>
  (manifest as readonly ExactDefinitionDependency[])
    .filter(
      (dependency) =>
        dependency.kind === "protected_operation" || dependency.kind === "connection_type",
    )
    .map((dependency) => ({ value: dependency, key: canonicalJson(dependency) }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map(({ value }) => value);
