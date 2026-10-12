import type { DefinitionRuleFailure, DefinitionValidationLocation } from "@vortex/contracts";
import { compareCanonicalStrings } from "./canonical-json";

const safeLocationKey = (location: DefinitionValidationLocation | undefined) =>
  location
    ? JSON.stringify([
        location.documentKind,
        location.documentKey,
        location.segments.map((segment) => [segment.kind, segment.key]),
      ])
    : "";

const familyOrder: readonly DefinitionRuleFailure["family"][] = [
  "required_value",
  "invalid_value",
  "unsupported_choice",
  "unknown_property",
  "too_few_items",
  "too_many_items",
  "duplicate_key",
  "broken_reference",
  "unresolved_reference",
  "scope_conflict",
  "incompatible_version",
  "dependency_cycle",
  "unsafe_content",
  "incompatible_change",
  "more_errors",
];

/**
 * The one deterministic order for rule failures: duplicates removed, then by safe location,
 * family and rule code. Draft save and publication both report through it, so the same document
 * yields the same located results, and publication refuses with the first of them.
 */
export const settleDefinitionRuleFailures = (
  failures: readonly DefinitionRuleFailure[],
): DefinitionRuleFailure[] => {
  const unique = new Map(
    failures.map((entry) => [
      `${entry.ruleCode}\0${entry.family}\0${safeLocationKey(entry.location)}`,
      entry,
    ]),
  );
  return [...unique.values()].sort((left, right) => {
    if (left.family !== right.family) {
      if (left.family === "more_errors") return 1;
      if (right.family === "more_errors") return -1;
    }
    const locationComparison = compareCanonicalStrings(
      safeLocationKey(left.location),
      safeLocationKey(right.location),
    );
    if (locationComparison !== 0) return locationComparison;
    const familyComparison = familyOrder.indexOf(left.family) - familyOrder.indexOf(right.family);
    if (familyComparison !== 0) return familyComparison;
    return compareCanonicalStrings(left.ruleCode, right.ruleCode);
  });
};
