import "server-only";

import { personalDataClassSchema, type PersonalDataClass } from "@vortex/contracts";

/**
 * Shared derived-data exclusion policy for the organisation search index (#95).
 *
 * The #643 document builder already leaves out a field whose published
 * classification is sensitive, whose type carries no searchable words, or whose
 * personal-data class the organisation privacy policy does not permit. That is
 * not enough for a derived value: a calculated or totalled field can be
 * published as `personal_data: none` while one of its inputs is sensitive, so
 * the field's own label would declassify a hidden input. This module decides,
 * from published field sensitivity and share metadata alone, which fields may
 * enter a search document, following each derived field's complete recursive
 * input closure.
 *
 * It fails closed. An unknown or malformed classification, a missing or
 * dangling input, an input cycle, or a recipient-copied shared-source record
 * makes the field ineligible. Access changes are handled at read time by the
 * current-field recheck (#645), not by widening what may be indexed: a field
 * withheld now is dropped from candidates even when its index entry is stale.
 *
 * Invalidation: a classification change is a published definition change, so a
 * rebuilt configuration drops or keeps the field and the document's content
 * fingerprint changes, which the #643 store classifies as a rebuild. A derived
 * total whose aggregate-source field belongs to another record type cannot have
 * its inputs proven from this record type alone, so it is treated as unknown
 * and left out until that proof is available.
 */

/**
 * The published field facts this policy reads. It is structurally compatible
 * with the current Module field model, so the document builder passes its own
 * published record type without a second conversion.
 */
export type PublishedSearchField = Readonly<{
  fieldId: string;
  type: string;
  /** The published data class; anything other than a known class is not disclosable. */
  personalData: PersonalDataClass | string;
  /** Type-specific published settings; only field references are read. */
  settings?: unknown;
}>;

/**
 * Published field sensitivity plus share metadata. `personalDataPermitted` is
 * the organisation privacy policy's permission for personal fields. A
 * recipient-copied shared-source record is not this organisation's content and
 * contributes nothing to its index.
 */
export type SearchIndexShareMetadata = Readonly<{
  /** Personal fields are indexable only when the organisation privacy policy permits it. */
  personalDataPermitted: boolean;
  /** `shared` marks a recipient copy of another organisation's shared source record. */
  sharedSourceOwnership?: "none" | "shared";
}>;

/** Field types whose value is derived from other fields of the same record type. */
const derivedFieldTypes: ReadonlySet<string> = new Set(["calculation", "total"]);

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every field identifier a derived field's published settings read, direct or
 * nested. The walk is deliberately broad: a reference it discovers only makes
 * the closure stricter, which is the fail-closed direction. It recognises the
 * published reference names `fieldId`, `*FieldId` and `*FieldIds`, which cover
 * calculation dependencies and expressions and total aggregate sources and
 * filters.
 */
export const derivedFieldInputIds = (settings: unknown): readonly string[] => {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "fieldId" || key.endsWith("FieldId")) && typeof entry === "string") {
        found.add(entry);
        continue;
      }
      if (key.endsWith("FieldIds") && Array.isArray(entry)) {
        for (const item of entry) if (typeof item === "string") found.add(item);
        continue;
      }
      visit(entry);
    }
  };
  visit(settings);
  return [...found];
};

/** The field's own published classification, independent of its inputs. */
const ownDisclosureAllowed = (
  field: PublishedSearchField,
  metadata: SearchIndexShareMetadata,
): boolean => {
  if (metadata.sharedSourceOwnership === "shared") return false;
  const classification = personalDataClassSchema.safeParse(field.personalData);
  if (!classification.success) return false;
  if (classification.data === "sensitive") return false;
  return classification.data === "none" || metadata.personalDataPermitted === true;
};

/**
 * A disclosure evaluator for one published record type. `discloses` reports
 * whether a field's value may be disclosed, which requires both its own
 * classification and every recursive input of a derived field to be allowed.
 * It memoises and detects cycles, so a self-referential or repeated dependency
 * resolves once and a cycle is ineligible rather than an infinite walk.
 */
export type SearchFieldDisclosure = Readonly<{
  /** Whether the named field, lower-cased by identity, may be disclosed. */
  discloses: (fieldId: string) => boolean;
}>;

export const searchFieldDisclosure = (
  fields: readonly PublishedSearchField[],
  metadata: SearchIndexShareMetadata,
): SearchFieldDisclosure => {
  const byId = new Map<string, PublishedSearchField>();
  for (const field of fields)
    if (typeof field.fieldId === "string") byId.set(field.fieldId.toLowerCase(), field);

  const visiting = new Set<string>();
  const decided = new Map<string, boolean>();

  const discloses = (fieldId: string): boolean => {
    const key = fieldId.toLowerCase();
    const cached = decided.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return false;
    const field = byId.get(key);
    if (field === undefined) return false;
    if (!ownDisclosureAllowed(field, metadata)) {
      decided.set(key, false);
      return false;
    }
    if (!derivedFieldTypes.has(field.type)) {
      decided.set(key, true);
      return true;
    }
    visiting.add(key);
    let allowed = true;
    for (const input of derivedFieldInputIds(field.settings)) {
      if (!discloses(input)) {
        allowed = false;
        break;
      }
    }
    visiting.delete(key);
    decided.set(key, allowed);
    return allowed;
  };

  return Object.freeze({ discloses });
};

const disclosureByFields = new WeakMap<object, Map<string, SearchFieldDisclosure>>();

const disclosureFor = (
  fields: readonly PublishedSearchField[],
  metadata: SearchIndexShareMetadata,
): SearchFieldDisclosure => {
  let byMetadata = disclosureByFields.get(fields);
  if (byMetadata === undefined) {
    byMetadata = new Map();
    disclosureByFields.set(fields, byMetadata);
  }
  const key = `${metadata.personalDataPermitted}:${metadata.sharedSourceOwnership ?? "none"}`;
  const cached = byMetadata.get(key);
  if (cached !== undefined) return cached;
  const created = searchFieldDisclosure(fields, metadata);
  byMetadata.set(key, created);
  return created;
};

/**
 * Whether one field of a published record type may be disclosed to the search
 * index, following its recursive input closure. The evaluator is memoised per
 * published field array, so the document builder can ask this once per field
 * without rebuilding the closure each time.
 */
export const searchIndexFieldDiscloses = (
  fields: readonly PublishedSearchField[],
  fieldId: string,
  metadata: SearchIndexShareMetadata,
): boolean => disclosureFor(fields, metadata).discloses(fieldId);

/**
 * The lower-cased identities of every field of the record type whose value may
 * be disclosed to a search document after following its recursive input
 * closure. The document builder intersects this with its own searchable-type
 * and search-priority rules, so an unknown or disallowed derived input removes
 * the derived field while leaving unrelated fields untouched.
 */
export const searchIndexDisclosableFieldIds = (
  fields: readonly PublishedSearchField[],
  metadata: SearchIndexShareMetadata,
): ReadonlySet<string> => {
  const { discloses } = searchFieldDisclosure(fields, metadata);
  const eligible = new Set<string>();
  for (const field of fields)
    if (typeof field.fieldId === "string" && discloses(field.fieldId))
      eligible.add(field.fieldId.toLowerCase());
  return eligible;
};
