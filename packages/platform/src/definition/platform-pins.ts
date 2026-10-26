import { canonicalJson } from "./canonical-json-definition";
import type { ExactDefinitionDependency } from "./definition-store-contracts";

/**
 * A platform pin as publication compares it. An operation pin's resolution fingerprint is the
 * Application's own, and it names the release version the Application was resolved for, so every
 * release changes it. Only the operation's identity, release and content mean a platform change.
 */
export type PlatformPin =
  | Omit<
      Extract<ExactDefinitionDependency, { kind: "protected_operation" }>,
      "resolutionFingerprint"
    >
  | Extract<ExactDefinitionDependency, { kind: "connection_type" }>;

/**
 * The platform service operations and connection types a release manifest pins, in one canonical
 * order. Module and platform block pins are compared through the content itself.
 */
export const platformPins = (manifest: readonly unknown[]): readonly PlatformPin[] =>
  (manifest as readonly ExactDefinitionDependency[])
    .flatMap((dependency): PlatformPin[] => {
      if (dependency.kind === "connection_type") return [dependency];
      if (dependency.kind !== "protected_operation") return [];
      const { resolutionFingerprint, ...operation } = dependency;
      void resolutionFingerprint;
      return [operation];
    })
    .map((value) => ({ value, key: canonicalJson(value) }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map(({ value }) => value);
