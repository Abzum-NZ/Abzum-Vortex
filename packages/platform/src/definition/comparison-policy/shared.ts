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

/**
 * The one allowlist for presentation settings, by setting name. Settings outside it (actions,
 * parameters, references) are major, and a new interactive placement is major through its flow
 * bindings, so nobody should rely on this value check alone.
 */
const presentationKinds: ReadonlySet<unknown> = new Set([
  "text",
  "number",
  "boolean",
  "choice",
  "rich_text",
  "url",
  "asset_reference",
  "icon",
  "field_reference",
]);
const presentationSettings: ReadonlyMap<string, "text" | "list"> = new Map([
  ["title", "text"],
  ["label", "text"],
  ["placeholder", "text"],
  ["help_text", "text"],
  ["description", "text"],
  ["empty_message", "text"],
  ["refused_message", "text"],
  ["error_message", "text"],
  ["document", "text"],
  ["value", "text"],
  ["href", "text"],
  ["content", "list"],
  ["columns", "list"],
  ["detail_fields", "list"],
  ["options", "list"],
  ["items", "list"],
  ["aggregates", "list"],
]);

/** Whether a setting contains only display values, and an existing value changes only display text. */
export const presentationOnlyValue = (
  value: unknown,
  previous?: unknown,
  settingKey?: string,
): boolean => {
  if (settingKey !== undefined && !presentationSettings.has(settingKey)) return false;
  if (value === undefined || value === null) return false;
  const property = asRecord(value);
  if (property.kind === "group") {
    const properties = asRecord(property.properties);
    if (previous !== undefined) {
      const old = asRecord(previous);
      if (old.kind !== "group") return false;
      const oldProperties = asRecord(old.properties);
      return [...new Set([...Object.keys(properties), ...Object.keys(oldProperties)])].every(
        (key) => {
          if (same(properties[key], oldProperties[key])) return true;
          return (
            presentationSettings.get(key) === "text" &&
            properties[key] !== undefined &&
            presentationOnlyValue(properties[key], oldProperties[key], key)
          );
        },
      );
    }
    return (
      Object.values(properties).every((entry) => presentationOnlyValue(entry)) &&
      ((settingKey !== "columns" && settingKey !== "detail_fields") || holdsFieldReference(value))
    );
  }
  if (property.kind === "list") {
    if (
      previous !== undefined ||
      (settingKey !== undefined && presentationSettings.get(settingKey) !== "list")
    )
      return false;
    return (property.items as unknown[]).every((entry) => presentationOnlyValue(entry));
  }
  if (!presentationKinds.has(property.kind)) return false;
  if (previous === undefined) return true;
  const old = asRecord(previous);
  if (old.kind !== property.kind) return false;
  if (property.kind === "field_reference") return same(value, previous);
  return settingKey === undefined || presentationSettings.get(settingKey) === "text";
};

const holdsFieldReference = (value: unknown): boolean => {
  const property = asRecord(value);
  if (property.kind === "group")
    return Object.values(asRecord(property.properties)).some(holdsFieldReference);
  return property.kind === "field_reference";
};

const presentationEntryIdentity = (value: unknown, settingKey: string): string | undefined => {
  const properties = asRecord(asRecord(value).properties);
  const identityKey =
    settingKey === "columns" || settingKey === "detail_fields"
      ? "field"
      : settingKey === "aggregates"
        ? "alias"
        : settingKey === "items" || settingKey === "options"
          ? "key"
          : undefined;
  return identityKey === undefined || properties[identityKey] === undefined
    ? undefined
    : canonicalJson(properties[identityKey]);
};

/**
 * An ordered list of entries (a block's fields or columns, a query's selected fields). Appending
 * entries that `additive` accepts is minor, and reordering keeps every entry, so it is minor too.
 * Appending any other entry, or removing or replacing an entry, changes what existing consumers
 * get, so it is major.
 */
export const compareOrderedEntries = (
  reasons: VersionImpactReason[],
  previous: readonly unknown[],
  candidate: readonly unknown[],
  componentKind: ComponentKind,
  componentId: unknown,
  property: Property,
  additive: (entry: unknown) => boolean,
  presentationSettingKey?: string,
): void => {
  if (same(previous, candidate)) return;
  const remaining = candidate.map((entry) => canonicalJson(entry));
  const kept: number[] = [];
  let presentationEdited = false;
  for (const [index, entry] of previous.entries()) {
    let at = remaining.indexOf(canonicalJson(entry));
    if (at < 0 && presentationSettingKey !== undefined) {
      const identity = presentationEntryIdentity(entry, presentationSettingKey);
      at = candidate.findIndex(
        (next, nextIndex) =>
          remaining[nextIndex] !== "" &&
          (identity === undefined
            ? nextIndex === index
            : presentationEntryIdentity(next, presentationSettingKey) === identity) &&
          presentationOnlyValue(next, entry, presentationSettingKey),
      );
      if (at >= 0) presentationEdited = true;
    }
    if (at < 0) {
      reasons.push(
        makeReason("major", "existing_behavior_changed", componentKind, property, componentId),
      );
      return;
    }
    kept.push(at);
    remaining[at] = "";
  }
  const appended = candidate.filter((_, index) => !kept.includes(index));
  if (appended.some((entry) => !additive(entry)))
    reasons.push(
      makeReason("major", "existing_behavior_changed", componentKind, property, componentId),
    );
  else if (appended.length > 0)
    reasons.push(makeReason("minor", "component_added", componentKind, property, componentId));
  if (presentationEdited)
    reasons.push(
      makeReason("patch", "presentation_changed", componentKind, "configuration", componentId),
    );
  if (kept.some((position, index) => index > 0 && position < kept[index - 1]!))
    reasons.push(
      makeReason("minor", "meaningful_order_changed", componentKind, "order", componentId),
    );
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
