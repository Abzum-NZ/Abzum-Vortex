import {
  type VersionImpact,
  type VersionImpactReason,
  compareExactDecimals,
  parseExactDecimal,
  versionImpactComponentKinds,
  versionImpactProperties,
  versionImpactReasonCodes,
} from "../../schema";
import {
  canonicalJson,
  compareCanonicalStrings,
  sameCanonicalValue,
} from "../canonical-json-definition";
import type { BlockPropertySchemaContract } from "../application-composition/block-property-schema";

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
  return sameCanonicalValue(left, right);
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

const compareSetChanges = (
  reasons: VersionImpactReason[],
  previous: unknown[],
  candidate: unknown[],
  componentKind: ComponentKind,
  componentId: unknown,
  property: Property,
  addImpact: VersionImpact = "minor",
  removeImpact: VersionImpact = "major",
): Readonly<{ added: boolean; removed: boolean }> => {
  const previousKeys = new Set(previous.map((value) => canonicalJson(value)));
  const candidateKeys = new Set(candidate.map((value) => canonicalJson(value)));
  const added = [...candidateKeys].some((key) => !previousKeys.has(key));
  const removed = [...previousKeys].some((key) => !candidateKeys.has(key));
  if (added)
    reasons.push(
      makeReason(
        addImpact,
        addImpact === "minor" ? "component_added" : "existing_behavior_changed",
        componentKind,
        property,
        componentId,
      ),
    );
  if (removed)
    reasons.push(
      makeReason(
        removeImpact,
        removeImpact === "major" ? "component_removed" : "constraint_widened",
        componentKind,
        property,
        componentId,
      ),
    );
  return { added, removed };
};

export const compareSet = (...parameters: Parameters<typeof compareSetChanges>): void => {
  compareSetChanges(...parameters);
};

export const comparePresentationSet = (
  reasons: VersionImpactReason[],
  previous: unknown[],
  candidate: unknown[],
  componentKind: ComponentKind,
  componentId: unknown,
  property: Property,
): void => {
  const changes = compareSetChanges(
    reasons,
    previous,
    candidate,
    componentKind,
    componentId,
    property,
  );
  if (!changes.added && !changes.removed && !same(previous, candidate))
    reasons.push(makeReason("patch", "presentation_changed", componentKind, "order", componentId));
};

/** Safe value kinds within a declared presentation list entry; references to behaviour are excluded. */
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

/** A new entry may carry only safe display values declared by its presentation list. */
const presentationEntryValue = (
  value: unknown,
  declaration: BlockPropertySchemaContract,
): boolean => {
  if (value === undefined || value === null) return false;
  const property = asRecord(value);
  if (property.kind !== declaration.kind) return false;
  if (property.kind === "group") {
    if (declaration.kind !== "group") return false;
    const properties = asRecord(property.properties);
    return Object.entries(properties).every(([key, entry]) => {
      const child = declaration.properties.find((candidate) => candidate.key === key);
      return child !== undefined && presentationEntryValue(entry, child);
    });
  }
  if (property.kind === "list") {
    return (
      declaration.kind === "list" &&
      (property.items as unknown[]).every(
        (entry) =>
          presentationEntryValue(entry, declaration.item) &&
          (declaration.presentationIdentity === undefined ||
            presentationEntryIdentity(entry, declaration.presentationIdentity) !== undefined),
      )
    );
  }
  return presentationKinds.has(property.kind);
};

export const presentationListEntry = (
  value: unknown,
  declaration: BlockPropertySchemaContract,
): boolean =>
  declaration.kind === "list" &&
  declaration.presentation === true &&
  presentationEntryValue(value, declaration.item) &&
  (declaration.presentationIdentity === undefined ||
    presentationEntryIdentity(value, declaration.presentationIdentity) !== undefined);

/** Whether a declared display setting changes only its presentation values. */
export const presentationOnlyValue = (
  value: unknown,
  declaration: BlockPropertySchemaContract,
  previous?: unknown,
): boolean => {
  if (declaration.presentation !== true || !presentationEntryValue(value, declaration))
    return false;
  if (previous === undefined) return true;
  const property = asRecord(value);
  const old = asRecord(previous);
  if (old.kind !== property.kind) return false;
  if (declaration.kind === "group") return presentationEntryEdit(value, previous, declaration);
  if (declaration.kind === "list") return false;
  if (property.kind === "field_reference") return same(value, previous);
  return true;
};

const presentationEntryEdit = (
  value: unknown,
  previous: unknown,
  declaration: BlockPropertySchemaContract,
): boolean => {
  if (declaration.kind !== "group" || !presentationEntryValue(value, declaration)) return false;
  const old = asRecord(previous);
  if (old.kind !== "group") return false;
  const properties = asRecord(asRecord(value).properties);
  const oldProperties = asRecord(old.properties);
  return [...new Set([...Object.keys(properties), ...Object.keys(oldProperties)])].every((key) => {
    if (same(properties[key], oldProperties[key])) return true;
    const child = declaration.properties.find((candidate) => candidate.key === key);
    return child !== undefined && presentationOnlyValue(properties[key], child, oldProperties[key]);
  });
};

const presentationEntryIdentity = (value: unknown, identityKey: string): string | undefined => {
  const properties = asRecord(asRecord(value).properties);
  return properties[identityKey] === undefined ? undefined : canonicalJson(properties[identityKey]);
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
  presentationDeclaration?: BlockPropertySchemaContract,
): void => {
  if (same(previous, candidate)) return;
  const remaining = candidate.map((entry) => canonicalJson(entry));
  const kept: number[] = [];
  let presentationEdited = false;
  for (const [index, entry] of previous.entries()) {
    let at = remaining.indexOf(canonicalJson(entry));
    if (
      at < 0 &&
      presentationDeclaration?.kind === "list" &&
      presentationDeclaration.presentation === true
    ) {
      const identityKey = presentationDeclaration.presentationIdentity;
      const identity =
        identityKey === undefined ? undefined : presentationEntryIdentity(entry, identityKey);
      at = candidate.findIndex(
        (next, nextIndex) =>
          remaining[nextIndex] !== "" &&
          (identity === undefined
            ? nextIndex === index
            : presentationEntryIdentity(next, identityKey!) === identity) &&
          presentationEntryEdit(next, entry, presentationDeclaration.item),
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
  const canonicalKeys = new Map<unknown, string>();
  const keyOf = (value: unknown): string => {
    const known = canonicalKeys.get(value);
    if (known !== undefined) return known;
    const key = canonicalJson(value);
    canonicalKeys.set(value, key);
    return key;
  };
  return [...values].sort((left, right) => {
    if (identityOf) {
      const result = compareText(identityOf(asRecord(left)), identityOf(asRecord(right)));
      if (result !== 0) return result;
    }
    return compareText(keyOf(left), keyOf(right));
  });
};
