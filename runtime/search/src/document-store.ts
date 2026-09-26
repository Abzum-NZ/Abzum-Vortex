import { createHash } from "node:crypto";
import {
  applicationRootIdSchema,
  fieldIdSchema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  type FieldType,
  type ModuleFieldV3,
  type PersonalDataClass,
  type RecordTypeDefinitionV3,
  type SearchPriority,
} from "@vortex/contracts";

/**
 * Organisation-owned search documents (#643).
 *
 * This module turns one organisation-owned Record snapshot plus the exact
 * searchable-field configuration into a versioned search document, or a deletion
 * marker, and describes the store command for it. It builds and describes
 * documents only: index serving and event-driven refresh belong to later Search
 * work, and shared-source content is never accepted into another organisation's
 * document.
 */

/** Version of the stored document shape; bumped only by a deliberate rebuild. */
export const searchDocumentSchemaVersion = 1;

/**
 * Field types whose stored value carries searchable words. Identifier-only
 * values (links to records or people) and yes/no values carry none, and
 * attachments are searched only through a separate file-search policy.
 */
const searchableFieldTypes = new Set<FieldType>([
  "text",
  "long_text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "date",
  "date_time",
  "choice",
  "several_choices",
  "reference_number",
  "email_address",
  "phone_number",
  "web_address",
  "table",
  "calculation",
  "total",
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
  /** Published option labels by stored value, for choice fields. */
  optionLabels?: Readonly<Record<string, string>>;
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
  field: Readonly<{
    type: FieldType;
    priority: SearchPriority | undefined;
    personalData: PersonalDataClass;
  }>,
  policy: SearchableFieldPolicy,
): boolean =>
  field.priority !== undefined &&
  Object.hasOwn(searchPriorityWeights, field.priority) &&
  searchableFieldTypes.has(field.type) &&
  (field.personalData === "none" ||
    (field.personalData === "personal" && policy.personalDataPermitted === true));

const optionLabelsFor = (field: ModuleFieldV3): Readonly<Record<string, string>> | undefined =>
  field.type === "choice" || field.type === "several_choices"
    ? Object.freeze(
        Object.fromEntries(
          field.settings.options.map((option) => [option.value, option.label] as const),
        ),
      )
    : undefined;

/**
 * Derives the exact configuration from a published record type. Fields without a
 * declared search priority, sensitive fields, unpermitted personal fields and
 * field types without searchable words are left out, so a schema is never
 * treated as an indexer.
 */
export const searchableFieldConfigurationFor = (
  recordType: Pick<RecordTypeDefinitionV3, "recordTypeId" | "fields">,
  policy: SearchableFieldPolicy,
): SearchableFieldConfiguration =>
  Object.freeze({
    recordTypeId: recordType.recordTypeId,
    fields: Object.freeze(
      recordType.fields.flatMap((field): SearchableFieldConfigurationEntry[] => {
        const priority = field.searchPriority;
        if (priority === undefined || !isIndexableField({ ...field, priority }, policy)) return [];
        const optionLabels = optionLabelsFor(field);
        return [
          Object.freeze({
            fieldId: field.fieldId,
            type: field.type,
            priority,
            personalData: field.personalData,
            ...(optionLabels === undefined ? {} : { optionLabels }),
          }),
        ];
      }),
    ),
  });

/**
 * One Record version owned by `ownerOrganisationId`, offered to the index of
 * `indexOrganisationId`. They differ only for a recipient-copied shared-source
 * record, which is refused rather than indexed. `recordVersion` is the Record's
 * concurrency number after the change being indexed, including a deletion.
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

const isValidSnapshot = (snapshot: SearchRecordSnapshot): boolean =>
  organizationIdSchema.safeParse(snapshot.indexOrganisationId).success &&
  organizationIdSchema.safeParse(snapshot.ownerOrganisationId).success &&
  (snapshot.applicationRootId === undefined ||
    applicationRootIdSchema.safeParse(snapshot.applicationRootId).success) &&
  recordTypeIdSchema.safeParse(snapshot.recordTypeId).success &&
  recordIdSchema.safeParse(snapshot.recordId).success &&
  Number.isSafeInteger(snapshot.recordVersion) &&
  snapshot.recordVersion >= 1 &&
  (snapshot.lifecycle === "active" || snapshot.lifecycle === "deleted") &&
  typeof snapshot.fieldValues === "object" &&
  snapshot.fieldValues !== null &&
  !Array.isArray(snapshot.fieldValues);

/**
 * One line of well-formed text: lone surrogates are dropped and control
 * characters and whitespace runs become one space, so every document is valid
 * stored JSON text.
 */
const collapse = (value: string): string =>
  value
    .replace(/\p{Cs}/gu, "")
    .normalize("NFC")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();

/** Truncates to `limit` UTF-16 units without splitting a surrogate pair. */
const bounded = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd();
};

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Text, whole numbers, exact decimals, dates and money; yes/no values carry no words. */
const scalarText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (
    isPlainObject(value) &&
    typeof value.amount === "string" &&
    typeof value.currency === "string"
  )
    return `${value.amount} ${value.currency}`;
  return undefined;
};

const richTextDepthLimit = 32;

/** Visible words of formatted text; link addresses and file blocks are not content. */
const richInlineText = (inlines: unknown, parts: string[], depth: number): void => {
  if (!Array.isArray(inlines) || depth > richTextDepthLimit) return;
  for (const inline of inlines) {
    if (!isPlainObject(inline)) continue;
    if (inline.kind === "text" && typeof inline.text === "string") parts.push(inline.text);
    else if (inline.kind === "emphasis" || inline.kind === "link")
      richInlineText(inline.children, parts, depth + 1);
  }
};

const formattedText = (value: unknown): string[] => {
  const parts: string[] = [];
  if (!isPlainObject(value) || !Array.isArray(value.blocks)) return parts;
  for (const block of value.blocks) {
    if (!isPlainObject(block)) continue;
    if (block.kind === "paragraph" || block.kind === "heading")
      richInlineText(block.children, parts, 0);
    else if (
      (block.kind === "bulleted_list" || block.kind === "numbered_list") &&
      Array.isArray(block.items)
    )
      for (const item of block.items) richInlineText(item, parts, 0);
    else if (block.kind === "table" && Array.isArray(block.rows))
      for (const row of block.rows)
        if (isPlainObject(row) && Array.isArray(row.cells))
          for (const cell of row.cells)
            if (isPlainObject(cell)) richInlineText(cell.children, parts, 0);
  }
  return parts;
};

const choiceText = (
  value: unknown,
  labels: Readonly<Record<string, string>> | undefined,
): string | undefined =>
  typeof value !== "string"
    ? undefined
    : labels !== undefined && Object.hasOwn(labels, value)
      ? labels[value]
      : value;

/** Searchable words of one configured field value, in a stable order. */
const valueParts = (field: SearchableFieldConfigurationEntry, value: unknown): string[] => {
  switch (field.type) {
    case "formatted_text":
      return formattedText(value);
    case "choice": {
      const text = choiceText(value, field.optionLabels);
      return text === undefined ? [] : [text];
    }
    case "several_choices":
      return Array.isArray(value)
        ? value.flatMap((part) => {
            const text = choiceText(part, field.optionLabels);
            return text === undefined ? [] : [text];
          })
        : [];
    case "table":
      return Array.isArray(value)
        ? value.flatMap((row) =>
            isPlainObject(row)
              ? Object.keys(row)
                  .sort()
                  .flatMap((key) => {
                    const text = scalarText(row[key]);
                    return text === undefined ? [] : [text];
                  })
              : [],
          )
        : [];
    default: {
      const text = scalarText(value);
      return text === undefined ? [] : [text];
    }
  }
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
 * personal or wordless field into a document. Higher-priority fields fill the
 * bounded document first. A record owned by another organisation is refused:
 * shared content stays with its source.
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
      output: Object.freeze({
        kind: "deletion",
        schemaVersion: searchDocumentSchemaVersion,
        ...identity,
      }),
    });

  // Stable sort: configuration order is kept within one priority.
  const fields = [...configuration.fields].sort(
    (left, right) =>
      (searchPriorityWeights[right.priority] ?? 0) - (searchPriorityWeights[left.priority] ?? 0),
  );
  const entries: SearchDocumentEntry[] = [];
  const seen = new Set<string>();
  let remaining: number = searchDocumentLimits.documentTextLength;
  for (const field of fields) {
    if (entries.length >= searchDocumentLimits.entries || remaining <= 0) break;
    if (
      seen.has(field.fieldId) ||
      !fieldIdSchema.safeParse(field.fieldId).success ||
      !isIndexableField(field, policy)
    )
      continue;
    seen.add(field.fieldId);
    if (!Object.hasOwn(snapshot.fieldValues, field.fieldId)) continue;
    const text = bounded(
      collapse(valueParts(field, snapshot.fieldValues[field.fieldId]).join(" ")),
      Math.min(searchDocumentLimits.entryTextLength, remaining),
    );
    if (text === "") continue;
    remaining -= text.length;
    entries.push(
      Object.freeze({
        fieldId: field.fieldId,
        priority: field.priority,
        weight: searchPriorityWeights[field.priority],
        text,
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

/**
 * Arguments of `vortex_search.put_document`, in its parameter order. The
 * organisation must be the established request organisation; a deletion marker
 * carries no entries or fingerprint.
 */
export type SearchDocumentStoreCommand = Readonly<{
  organizationId: string;
  recordTypeId: string;
  recordId: string;
  applicationRootId: string | null;
  sourceRecordVersion: number;
  deleted: boolean;
  entriesJson: string;
  contentFingerprint: string | null;
}>;

/**
 * Stored outcome: `stored` (first row), `replaced` (newer source version),
 * `rebuilt` (same version, changed content after a configuration or policy
 * change), `replayed` (same content), `ignored_older` (an older version never
 * overwrites a newer one) or `ignored_deleted` (a deletion marker is final for
 * its version).
 */
export type SearchDocumentStoreOutcome =
  | "stored"
  | "replaced"
  | "rebuilt"
  | "replayed"
  | "ignored_older"
  | "ignored_deleted";

export const searchDocumentStoreCommand = (
  output: SearchDocument | SearchDocumentDeletion,
): SearchDocumentStoreCommand =>
  Object.freeze({
    organizationId: output.organisationId,
    recordTypeId: output.recordTypeId,
    recordId: output.recordId,
    applicationRootId: output.applicationRootId ?? null,
    sourceRecordVersion: output.sourceRecordVersion,
    deleted: output.kind === "deletion",
    entriesJson: JSON.stringify(
      output.kind === "deletion"
        ? []
        : output.entries.map((entry) => ({
            fieldId: entry.fieldId,
            priority: entry.priority,
            weight: entry.weight,
            text: entry.text,
          })),
    ),
    contentFingerprint: output.kind === "deletion" ? null : output.contentFingerprint,
  });
