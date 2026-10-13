import {
  type VersionImpact,
  type VersionImpactReason,
  compareExactDecimals,
  parseExactDecimal,
  versionImpactComponentKinds,
  versionImpactProperties,
  versionImpactReasonCodes,
} from "../../schema";
import { canonicalJson, compareCanonicalStrings } from "../canonical-json-definition";

export type RecordValue = Record<string, unknown>;
export type ComponentKind = VersionImpactReason["location"]["componentKind"];
type Property = VersionImpactReason["location"]["property"];
type ReasonCode = VersionImpactReason["code"];

const impactRank = { patch: 0, minor: 1, major: 2 } as const;
const componentKindRank = new Map(
  versionImpactComponentKinds.map((value, index) => [value, index]),
);
const propertyRank = new Map(versionImpactProperties.map((value, index) => [value, index]));
const reasonCodeRank = new Map(versionImpactReasonCodes.map((value, index) => [value, index]));
const compareText = compareCanonicalStrings;
export const compareUnknownText = (left: unknown, right: unknown): number =>
  compareCanonicalStrings(String(left), String(right));
export const asRecord = (value: unknown): RecordValue => value as RecordValue;
export const same = (left: unknown, right: unknown): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
};
const asComponentId = (
  value: unknown,
): VersionImpactReason["location"]["componentId"] | undefined =>
  typeof value === "string" ? (value as VersionImpactReason["location"]["componentId"]) : undefined;

export const makeReason = (
  impact: VersionImpact,
  code: ReasonCode,
  componentKind: ComponentKind,
  property: Property,
  componentId?: unknown,
): VersionImpactReason => ({
  impact,
  code,
  location: {
    componentKind,
    property,
    ...(asComponentId(componentId) === undefined
      ? {}
      : { componentId: asComponentId(componentId)! }),
  },
});

export const pushChange = (
  reasons: VersionImpactReason[],
  previous: unknown,
  candidate: unknown,
  impact: VersionImpact,
  code: ReasonCode,
  componentKind: ComponentKind,
  property: Property,
  componentId?: unknown,
): void => {
  if (!same(previous, candidate))
    reasons.push(makeReason(impact, code, componentKind, property, componentId));
};

const setDifference = (left: unknown[], right: unknown[]): unknown[] => {
  const rightKeys = new Set(right.map((value) => canonicalJson(value)));
  return left.filter((entry) => !rightKeys.has(canonicalJson(entry)));
};

export const compareSet = (
  reasons: VersionImpactReason[],
  previous: unknown[],
  candidate: unknown[],
  componentKind: ComponentKind,
  componentId: unknown,
  property: Property,
  addImpact: VersionImpact = "minor",
  removeImpact: VersionImpact = "major",
): void => {
  if (setDifference(candidate, previous).length > 0)
    reasons.push(
      makeReason(
        addImpact,
        addImpact === "minor" ? "component_added" : "existing_behavior_changed",
        componentKind,
        property,
        componentId,
      ),
    );
  if (setDifference(previous, candidate).length > 0)
    reasons.push(
      makeReason(
        removeImpact,
        removeImpact === "major" ? "component_removed" : "constraint_widened",
        componentKind,
        property,
        componentId,
      ),
    );
};

export const comparePresentationSet = (
  reasons: VersionImpactReason[],
  previous: unknown[],
  candidate: unknown[],
  componentKind: ComponentKind,
  componentId: unknown,
  property: Property,
): void => {
  compareSet(reasons, previous, candidate, componentKind, componentId, property);
  if (
    setDifference(previous, candidate).length === 0 &&
    setDifference(candidate, previous).length === 0 &&
    !same(previous, candidate)
  )
    reasons.push(makeReason("patch", "presentation_changed", componentKind, "order", componentId));
};

export const compareBound = (
  reasons: VersionImpactReason[],
  previous: unknown,
  candidate: unknown,
  direction: "minimum" | "maximum",
  componentKind: ComponentKind,
  componentId: unknown,
  exact = false,
): void => {
  if (same(previous, candidate)) return;
  const previousNumber = typeof previous === "number" ? previous : undefined;
  const candidateNumber = typeof candidate === "number" ? candidate : undefined;
  const previousExact = exact ? parseExactDecimal(previous) : undefined;
  const candidateExact = exact ? parseExactDecimal(candidate) : undefined;
  const exactComparison =
    previousExact !== undefined && candidateExact !== undefined
      ? compareExactDecimals(candidateExact, previousExact)
      : undefined;
  const widened =
    direction === "minimum"
      ? candidate === undefined ||
        (exactComparison !== undefined
          ? exactComparison < 0
          : previousNumber !== undefined &&
            candidateNumber !== undefined &&
            candidateNumber < previousNumber)
      : candidate === undefined ||
        (exactComparison !== undefined
          ? exactComparison > 0
          : previousNumber !== undefined &&
            candidateNumber !== undefined &&
            candidateNumber > previousNumber);
  reasons.push(
    makeReason(
      widened ? "minor" : "major",
      widened ? "constraint_widened" : "constraint_narrowed",
      componentKind,
      "constraint",
      componentId,
    ),
  );
};

export const compareKeyed = (
  reasons: VersionImpactReason[],
  previous: RecordValue[],
  candidate: RecordValue[],
  identity: string | ((item: RecordValue) => string),
  componentKind: ComponentKind,
  compareExisting: (previousItem: RecordValue, candidateItem: RecordValue) => void,
  additionImpact: (item: RecordValue) => VersionImpact = () => "minor",
  locationId: (item: RecordValue) => unknown = (item) =>
    typeof identity === "function" ? identity(item) : item[identity],
): void => {
  const identityOf = (item: RecordValue): string =>
    typeof identity === "function" ? identity(item) : String(item[identity]);
  const previousById = new Map(previous.map((item) => [identityOf(item), item]));
  const candidateById = new Map(candidate.map((item) => [identityOf(item), item]));
  for (const [key, item] of candidateById)
    if (!previousById.has(key)) {
      const impact = additionImpact(item);
      reasons.push(
        makeReason(
          impact,
          impact === "major" ? "required_component_added" : "component_added",
          componentKind,
          "definition",
          locationId(item),
        ),
      );
    }
  for (const [key, item] of previousById)
    if (!candidateById.has(key))
      reasons.push(
        makeReason("major", "component_removed", componentKind, "definition", locationId(item)),
      );
  for (const [key, previousItem] of previousById) {
    const candidateItem = candidateById.get(key);
    if (candidateItem) compareExisting(previousItem, candidateItem);
  }
};

export const finaliseReasons = (reasons: VersionImpactReason[]): VersionImpactReason[] => {
  const unique = new Map(reasons.map((reason) => [canonicalJson(reason), reason]));
  return [...unique.values()].sort((left, right) => {
    const severity = impactRank[right.impact] - impactRank[left.impact];
    if (severity !== 0) return severity;
    const leftLocation = left.location;
    const rightLocation = right.location;
    return (
      (componentKindRank.get(leftLocation.componentKind) ?? Number.MAX_SAFE_INTEGER) -
        (componentKindRank.get(rightLocation.componentKind) ?? Number.MAX_SAFE_INTEGER) ||
      compareText(leftLocation.componentId ?? "", rightLocation.componentId ?? "") ||
      (propertyRank.get(leftLocation.property) ?? Number.MAX_SAFE_INTEGER) -
        (propertyRank.get(rightLocation.property) ?? Number.MAX_SAFE_INTEGER) ||
      (reasonCodeRank.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
        (reasonCodeRank.get(right.code) ?? Number.MAX_SAFE_INTEGER)
    );
  });
};

export const sorted = (
  values: unknown[],
  identity?: string | ((item: RecordValue) => string),
): unknown[] => {
  const identityOf: ((item: RecordValue) => string) | undefined =
    typeof identity === "function"
      ? identity
      : identity === undefined
        ? undefined
        : (item) => String(item[identity]);
  return [...values].sort((left, right) => {
    if (identityOf) {
      const result = compareText(identityOf(asRecord(left)), identityOf(asRecord(right)));
      if (result !== 0) return result;
    }
    return compareText(canonicalJson(left), canonicalJson(right));
  });
};
