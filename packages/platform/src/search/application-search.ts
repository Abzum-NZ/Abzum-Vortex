import "server-only";

import { applicationSearchSchema, moduleFieldValueSchemas, sameId, type ApplicationSearch, type JsonValue, type RecordRichTextDocument, type SelectedOrganizationScope } from "../schema";
import { matchLiteralSearch } from "./literal-search";
import { searchPriorityWeights, type SearchDocument } from "./document-store";
import type { PermittedSearchCurrentRead, PermittedSearchCurrentReadRequest } from "./permitted-search";

export type ApplicationSearchRecord = Readonly<{
  concurrencyNumber: number;
  values: Readonly<Record<string, JsonValue>>;
}>;
export type ApplicationSearchMatch = Readonly<{
  recordId: string;
  recordTypeId: string;
  targetPageId: string;
  concurrencyNumber: number;
  title: string;
  subtitle?: string;
  rank: number;
}>;
export type ApplicationSearchResult =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "available"; matches: readonly ApplicationSearchMatch[] }>;

const boundedDisplayText = (value: string): string | undefined => {
  const text = value.replace(/\p{Cs}/gu, "").normalize("NFC").replace(/[\s\p{Cc}]+/gu, " ").trim();
  const cut = text.slice(0, 240);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd() || undefined;
};

type RichTextChildren = Extract<RecordRichTextDocument["blocks"][number], { kind: "paragraph" }>["children"];

/** The existing strict value parser bounds nesting; only visible inline words are projected. */
const richInlineText = (children: RichTextChildren): string => children.map((inline) =>
  inline.kind === "text" ? inline.text : richInlineText(inline.children)).join("");

const scalarDisplayText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "boolean") return String(value);
  const money = moduleFieldValueSchemas.money.safeParse(value);
  return money.success ? `${money.data.amount} ${money.data.currency}` : undefined;
};

/** Display current typed protected values, never cached text, links, files or hidden counts. */
const displayValue = (value: JsonValue | undefined): string | undefined => {
  const scalar = scalarDisplayText(value);
  if (scalar !== undefined) return boundedDisplayText(scalar);
  if (Array.isArray(value)) {
    const choices = moduleFieldValueSchemas.several_choices.safeParse(value);
    if (choices.success) return boundedDisplayText(choices.data.join(", "));
    const table = moduleFieldValueSchemas.table.safeParse(value);
    if (!table.success) return undefined;
    // Table cells have the existing closed scalar grammar, not identity-bearing nested values.
    return boundedDisplayText(table.data.map((row) => Object.keys(row).sort()
      .map((key) => scalarDisplayText(row[key])).filter((text) => text !== undefined).join(", ")).join("; "));
  }
  const document = moduleFieldValueSchemas.formatted_text.safeParse(value);
  if (!document.success) return undefined;
  const text: string[] = [];
  for (const block of document.data.blocks) {
    if (block.kind === "file") continue;
    if (block.kind === "table") {
      for (const row of block.rows) text.push(row.cells.map((cell) => richInlineText(cell.children)).join(" "));
    } else if ("items" in block) {
      text.push(...block.items.map(richInlineText));
    } else text.push(richInlineText(block.children));
  }
  return boundedDisplayText(text.join(" "));
};

/**
 * The composition root supplies an installed release and one current human transaction.
 * Configuration is not a browser command. Matching, ranking and presentation all follow the
 * fixed Record read; a stale index revision contributes neither a match nor a page slot.
 */
export const searchConfiguredApplication = async (input: Readonly<{
  scope: SelectedOrganizationScope;
  configuration: ApplicationSearch | undefined;
  expression: string;
  /** Index documents of one record type in bounded batches; the batch size is the permitted-search candidate bound. */
  candidateBatches(recordTypeId: string): AsyncIterable<readonly SearchDocument[]>;
  /** Keyed by lower-case record identity; a record that cannot be read now is absent. */
  readCurrentRecords(request: PermittedSearchCurrentReadRequest): Promise<ReadonlyMap<string, ApplicationSearchRecord>>;
}>): Promise<ApplicationSearchResult> => {
  if (input.configuration === undefined || !input.configuration.enabled) return { kind: "disabled" };
  const parsed = applicationSearchSchema.safeParse(input.configuration);
  if (!parsed.success || input.scope.applicationRootId === undefined)
    return { kind: "refused" };
  const matches: ApplicationSearchMatch[] = [];
  for (const entry of parsed.data.recordTypes) {
    if (entry.recordType.state !== "resolved") return { kind: "refused" };
    const recordTypeId = String(entry.recordType.recordTypeId);
    for await (const batch of input.candidateBatches(recordTypeId)) {
      const current = new Map<string, ApplicationSearchRecord>();
      const indexed = new Map(batch.map((candidate) => [candidate.recordId.toLowerCase(), candidate]));
      const result = await matchLiteralSearch({
        expression: input.expression,
        search: {
          access: input.scope,
          request: { applicationRootId: input.scope.applicationRootId, recordTypeId,
            requestedFieldIds: entry.fields.map((field) => String(field.fieldId)) },
          candidates: batch,
        },
      }, {
        readCurrentRecords: async (request) => {
          const records = await input.readCurrentRecords(request);
          const reads = new Map<string, PermittedSearchCurrentRead>();
          for (const [recordId, record] of records) {
            if (record.concurrencyNumber !== indexed.get(recordId)?.sourceRecordVersion) continue;
            current.set(recordId, record);
            reads.set(recordId, { outcome: "allowed", concurrencyNumber: record.concurrencyNumber, readableFieldIds: Object.keys(record.values) });
          }
          return reads;
        },
      });
      if (result.outcome === "refused") return { kind: "refused" };
      for (const match of result.matches) {
        const record = current.get(match.candidate.recordId.toLowerCase());
        if (record === undefined) continue;
        const values = new Map(Object.entries(record.values).map(([fieldId, value]) => [fieldId.toLowerCase(), value]));
        const title = displayValue(values.get(String(entry.titleFieldId).toLowerCase()));
        if (title === undefined) continue;
        const subtitle = entry.subtitleFieldId === undefined ? undefined : displayValue(values.get(String(entry.subtitleFieldId).toLowerCase()));
        const rank = match.matchedFields.reduce((total, matched) => {
          const selected = entry.fields.find((field) => sameId(String(field.fieldId), matched.fieldId));
          return total + (selected === undefined ? 0 : searchPriorityWeights[selected.priority] * matched.termIndices.length);
        }, 0);
        matches.push({ recordId: match.candidate.recordId, recordTypeId, targetPageId: String(entry.targetPageId),
          concurrencyNumber: record.concurrencyNumber, title, ...(subtitle === undefined ? {} : { subtitle }), rank });
      }
    }
  }
  matches.sort((left, right) => right.rank - left.rank || left.title.localeCompare(right.title) || left.recordId.localeCompare(right.recordId));
  return { kind: "available", matches };
};
