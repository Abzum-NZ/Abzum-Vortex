import { createHash } from "node:crypto";
import type {
  FieldType,
  ModuleFieldV2,
  PersonalDataClass,
  RecordTypeDefinitionV2,
  SearchPriority,
} from "@vortex/contracts";

/**
 * Organisation-owned search documents (#643).
 *
 * This module turns one organisation-owned Record snapshot plus the exact
 * searchable-field configuration into a versioned search document, or a deletion
 * marker. It builds and describes documents only: index serving and event-driven
 * refresh belong to later Search work, and shared-source content is never accepted
 * into another organisation's document.
 */

/** Version of the stored document shape; bumped only by a deliberate rebuild. */
export const searchDocumentSchemaVersion = 1;

/** Field types whose stored value is plain searchable text or a plain number. */
const searchableFieldTypes = new Set<FieldType>([
  "text",
  "long_text",
  "email_address",
  "phone_number",
  "web_address",
  "choice",
  "several_choices",
  "reference_number",
  "whole_number",
  "decimal_number",
]);

/** Ranking weight per declared search priority; ranking never overrides access. */
export const searchPriorityWeights: Readonly<Record<SearchPriority, number>> = Object.freeze({
  first: 3,
  normal: 2,
  last: 1,
});

export const searchDocumentLimits = Object.freeze({
  entryTextLength: 4_000,
  documentTextLength: 20_000,
  entries: 100,
});

export type SearchableFieldConfigurationEntry = Readonly<{
  fieldId: string;
  type: FieldType;
  priority: SearchPriority;
  personalData: PersonalDataClass;
}>;

/** The exact set of fields one record type may contribute to its search document. */
export type SearchableFieldConfiguration = Readonly<{
  recordTypeId: string;
  fields: readonly SearchableFieldConfigurationEntry[];
}>;

export type SearchableFieldPolicy = Readonly<{
  /** Personal fields enter a document only when the organisation privacy policy permits it. */
  personalDataPermitted: boolean;
}>;

const isIndexableField = (
  field: Pick<ModuleFieldV2, "type" | "searchPriority" | "personalData">,
  policy: SearchableFieldPolicy,
): boolean =>
  field.searchPriority !== undefined &&
  searchableFieldTypes.has(field.type) &&
  (field.personalData === "none" || (field.personalData === "personal" && policy.personalDataPermitted));

/**
 * Derives the exact configuration from a published record type. Fields without a
 * declared search priority, sensitive fields, unpermitted personal fields and
 * non-text field types are left out, so a schema is never treated as an indexer.
 */
export const searchableFieldConfigurationFor = (
  recordType: Pick<RecordTypeDefinitionV2, "recordTypeId" | "fields">,
  policy: SearchableFieldPolicy,
): SearchableFieldConfiguration =>
  Object.freeze({
    recordTypeId: recordType.recordTypeId,
    fields: Object.freeze(
      recordType.fields
        .filter((field) => isIndexableField(field, policy))
        .map((field) =>
          Object.freeze({
            fieldId: field.fieldId,
            type: field.type,
            priority: field.searchPriority as SearchPriority,
            personalData: field.personalData,
          }),
        ),
    ),
  });

/**
 * One Record version owned by `ownerOrganisationId`, offered to the index of
 * `indexOrganisationId`. They differ only for a recipient-copied shared-source
 * record, which is refused rather than indexed.
 */
export type SearchRecordSnapshot = Readonly<{
  indexOrganisationId: string;
  ownerOrganisationId: string;
  applicationRootId?: string;
  recordTypeId: string;
  recordId: string;
  recordVersion: number;
  lifecycle: "active" | "deleted";
  fieldValues: Readonly<Record<string, unknown>>;
}>;

export type SearchDocumentEntry = Readonly<{
  fieldId: string;
  priority: SearchPriority;
  weight: number;
  text: string;
}>;

type SearchDocumentIdentity = Readonly<{
  organisationId: string;
  recordTypeId: string;
  recordId: string;
  applicationRootId?: string;
  sourceRecordVersion: number;
}>;

export type SearchDocument = SearchDocumentIdentity &
  Readonly<{
    kind: "document";
    schemaVersion: typeof searchDocumentSchemaVersion;
    entries: readonly SearchDocumentEntry[];
    contentFingerprint: string;
  }>;

export type SearchDocumentDeletion = SearchDocumentIdentity &
  Readonly<{
    kind: "deletion";
    schemaVersion: typeof searchDocumentSchemaVersion;
  }>;

export type SearchDocumentRefusalCode =
  | "invalid_snapshot"
  | "configuration_mismatch"
  | "shared_source_record";

export type BuildSearchDocumentResult =
  | Readonly<{ success: true; output: SearchDocument | SearchDocumentDeletion }>
  | Readonly<{ success: false; code: SearchDocumentRefusalCode }>;

const refuse = (code: SearchDocumentRefusalCode): BuildSearchDocumentResult =>
  Object.freeze({ success: false, code });

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nilUuid = "00000000-0000-0000-0000-000000000000";
const isPlatformId = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value) && value !== nilUuid;

const isValidSnapshot = (snapshot: SearchRecordSnapshot): boolean =>
  isPlatformId(snapshot.indexOrganisationId) &&
  isPlatformId(snapshot.ownerOrganisationId) &&
  (snapshot.applicationRootId === undefined || isPlatformId(snapshot.applicationRootId)) &&
  isPlatformId(snapshot.recordTypeId) &&
  isPlatformId(snapshot.recordId) &&
  Number.isSafeInteger(snapshot.recordVersion) &&
  snapshot.recordVersion >= 1 &&
  (snapshot.lifecycle === "active" || snapshot.lifecycle === "deleted") &&
  typeof snapshot.fieldValues === "object" &&
  snapshot.fieldValues !== null;

const collapse = (value: string): string => value.normalize("NFC").replace(/\s+/gu, " ").trim();

/** Plain text for one supported field value, or undefined when it holds nothing searchable. */
const searchableText = (type: FieldType, value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (type === "several_choices") {
    if (!Array.isArray(value)) return undefined;
    const parts = value.filter((part): part is string => typeof part === "string");
    return parts.length === 0 ? undefined : collapse(parts.join(" "));
  }
  if (type === "whole_number" || type === "decimal_number")
    return typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? collapse(value)
        : undefined;
  return typeof value === "string" ? collapse(value) : undefined;
};

const fingerprint = (entries: readonly SearchDocumentEntry[]): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(entries.map((entry) => [entry.fieldId, entry.priority, entry.text])))
    .digest("hex")}`;

/**
 * Builds the document for one organisation-owned record, or its deletion marker.
 *
 * Only configured fields are read, and each configured field is checked again
 * here, so a hand-made configuration still cannot bring a sensitive, unpermitted
 * personal or non-text field into a document. A record owned by another
 * organisation is refused: shared content stays with its source.
 */
export const buildSearchDocument = (
  snapshot: SearchRecordSnapshot,
  configuration: SearchableFieldConfiguration,
  policy: SearchableFieldPolicy,
): BuildSearchDocumentResult => {
  if (!isValidSnapshot(snapshot)) return refuse("invalid_snapshot");
  if (snapshot.ownerOrganisationId !== snapshot.indexOrganisationId)
    return refuse("shared_source_record");
  if (configuration.recordTypeId !== snapshot.recordTypeId) return refuse("configuration_mismatch");

  const identity: SearchDocumentIdentity = {
    organisationId: snapshot.indexOrganisationId,
    recordTypeId: snapshot.recordTypeId,
    recordId: snapshot.recordId,
    ...(snapshot.applicationRootId === undefined
      ? {}
      : { applicationRootId: snapshot.applicationRootId }),
    sourceRecordVersion: snapshot.recordVersion,
  };

  if (snapshot.lifecycle === "deleted")
    return Object.freeze({
      success: true,
      output: Object.freeze({ kind: "deletion", schemaVersion: searchDocumentSchemaVersion, ...identity }),
    });

  const entries: SearchDocumentEntry[] = [];
  const seen = new Set<string>();
  let remaining: number = searchDocumentLimits.documentTextLength;
  for (const field of configuration.fields) {
    if (entries.length >= searchDocumentLimits.entries || remaining <= 0) break;
    if (seen.has(field.fieldId) || !isIndexableField({ ...field, searchPriority: field.priority }, policy))
      continue;
    seen.add(field.fieldId);
    if (!Object.hasOwn(snapshot.fieldValues, field.fieldId)) continue;
    const text = searchableText(field.type, snapshot.fieldValues[field.fieldId]);
    if (text === undefined || text === "") continue;
    const bounded = text.slice(0, Math.min(searchDocumentLimits.entryTextLength, remaining));
    remaining -= bounded.length;
    entries.push(
      Object.freeze({
        fieldId: field.fieldId,
        priority: field.priority,
        weight: searchPriorityWeights[field.priority],
        text: bounded,
      }),
    );
  }

  return Object.freeze({
    success: true,
    output: Object.freeze({
      kind: "document",
      schemaVersion: searchDocumentSchemaVersion,
      ...identity,
      entries: Object.freeze(entries),
      contentFingerprint: fingerprint(entries),
    }),
  });
};
