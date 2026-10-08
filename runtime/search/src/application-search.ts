import "server-only";

import { applicationSearchSchema, sameId, type ApplicationSearch, type JsonValue, type SelectedOrganizationScope } from "@vortex/contracts";
import { matchLiteralSearch } from "./literal-search";
import { searchPriorityWeights, type SearchDocument } from "./document-store";
import type { PermittedSearchCurrentReadRequest } from "./permitted-search";

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

/** Display current protected values, never cached index text or hidden field counts. */
const displayValue = (value: JsonValue | undefined): string | undefined => {
  if (typeof value === "string") return value.trim().slice(0, 240) || undefined;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const text = value.map(displayValue).filter(Boolean).join(", ");
    return text.slice(0, 240) || undefined;
  }
  if (value !== null && typeof value === "object") {
    if (typeof value.amount === "string" && typeof value.currency === "string") return `${value.amount} ${value.currency}`.slice(0, 240);
    if (typeof value.text === "string") return value.text.trim().slice(0, 240) || undefined;
    // Rich text exposes its readable text nodes, never link targets or attachment identifiers.
    if (Array.isArray(value.content)) return displayValue(value.content);
  }
  return undefined;
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
  candidates: readonly SearchDocument[];
  readCurrentRecord(request: PermittedSearchCurrentReadRequest): Promise<ApplicationSearchRecord | undefined>;
}>): Promise<ApplicationSearchResult> => {
  if (input.configuration === undefined || !input.configuration.enabled) return { kind: "disabled" };
  const parsed = applicationSearchSchema.safeParse(input.configuration);
  if (!parsed.success || input.scope.applicationRootId === undefined || input.candidates.length > 1_000)
    return { kind: "refused" };
  const matches: ApplicationSearchMatch[] = [];
  for (const entry of parsed.data.recordTypes) {
    if (entry.recordType.state !== "resolved") return { kind: "refused" };
    const recordTypeId = String(entry.recordType.recordTypeId);
    const current = new Map<string, ApplicationSearchRecord>();
    const result = await matchLiteralSearch({
      expression: input.expression,
      search: {
        access: input.scope,
        request: { applicationRootId: input.scope.applicationRootId, recordTypeId,
          requestedFieldIds: entry.fields.map((field) => String(field.fieldId)) },
        candidates: input.candidates.filter((candidate) => sameId(candidate.recordTypeId, recordTypeId)),
      },
    }, {
      readCurrentRecord: async (request) => {
        const record = await input.readCurrentRecord(request);
        const indexed = input.candidates.find((candidate) => sameId(candidate.recordTypeId, request.recordTypeId) && sameId(candidate.recordId, request.recordId));
        if (record === undefined || indexed === undefined || record.concurrencyNumber !== indexed.sourceRecordVersion) return { outcome: "refused" };
        current.set(request.recordId.toLowerCase(), record);
        return { outcome: "allowed", concurrencyNumber: record.concurrencyNumber, readableFieldIds: Object.keys(record.values) };
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
  matches.sort((left, right) => right.rank - left.rank || left.title.localeCompare(right.title) || left.recordId.localeCompare(right.recordId));
  return { kind: "available", matches };
};
