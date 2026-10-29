import "server-only";

import type { SelectedOrganizationScope } from "../access/identity-access";
import type { JsonValue } from "../catalogue/common";
import type { ModuleField } from "../definition/module-contracts";
import {
  applicationSearchSchema,
  type ApplicationSearch,
} from "../definition/application-contracts";
import {
  moduleFieldValueSchemas,
  type RecordRichTextDocument,
} from "../records/module-field-values";
import { literalSearchTerms } from "./literal-search";
import { prepareSearchFilters, splitSearchFilters } from "./search-filters";

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
  | Readonly<{ kind: "refused"; reason?: string }>
  | Readonly<{
      kind: "available";
      matches: readonly ApplicationSearchMatch[];
      boundary?: Readonly<{ score: number; id: string }>;
    }>;

const boundedDisplayText = (value: string): string | undefined => {
  const text = value
    .replace(/\p{Cs}/gu, "")
    .normalize("NFC")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  const cut = text.slice(0, 240);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd() || undefined;
};

type RichTextChildren = Extract<
  RecordRichTextDocument["blocks"][number],
  { kind: "paragraph" }
>["children"];

/** The existing strict value parser bounds nesting; only visible inline words are projected. */
const richInlineText = (children: RichTextChildren): string =>
  children
    .map((inline) => (inline.kind === "text" ? inline.text : richInlineText(inline.children)))
    .join("");

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
    return boundedDisplayText(
      table.data
        .map((row) =>
          Object.keys(row)
            .sort()
            .map((key) => scalarDisplayText(row[key]))
            .filter((text) => text !== undefined)
            .join(", "),
        )
        .join("; "),
    );
  }
  const document = moduleFieldValueSchemas.formatted_text.safeParse(value);
  if (!document.success) return undefined;
  const text: string[] = [];
  for (const block of document.data.blocks) {
    if (block.kind === "file") continue;
    if (block.kind === "table") {
      for (const row of block.rows)
        text.push(row.cells.map((cell) => richInlineText(cell.children)).join(" "));
    } else if ("items" in block) {
      text.push(...block.items.map(richInlineText));
    } else text.push(richInlineText(block.children));
  }
  return boundedDisplayText(text.join(" "));
};

/** The database page performs matching and current record permission before ranking. */
export const searchConfiguredApplication = async (
  input: Readonly<{
    scope: SelectedOrganizationScope;
    configuration: ApplicationSearch | undefined;
    expression: string;
    fieldsByRecordType: ReadonlyMap<string, readonly ModuleField[]>;
    allowedRecordTypeIds: ReadonlySet<string>;
    after?: Readonly<{ score: number; id: string }>;
    readPage(
      request: Readonly<{
        recordTypeId: string;
        fields: ApplicationSearch["recordTypes"][number]["fields"];
        titleFieldId: string;
        terms: NonNullable<ReturnType<typeof literalSearchTerms>>;
        filters: NonNullable<ReturnType<typeof prepareSearchFilters>>;
        after?: Readonly<{ score: number; id: string }>;
        limit: number;
      }>,
    ): Promise<
      readonly Readonly<{ recordId: string; rank: number; record: ApplicationSearchRecord }>[]
    >;
  }>,
): Promise<ApplicationSearchResult> => {
  if (input.configuration === undefined || !input.configuration.enabled)
    return { kind: "disabled" };
  const parsed = applicationSearchSchema.safeParse(input.configuration);
  if (!parsed.success || input.scope.applicationRootId === undefined) {
    console.error(
      `[search] refused ${parsed.success ? "SEARCH_APPLICATION_NOT_SCOPED" : "SEARCH_CONFIGURATION_INVALID"}`,
    );
    return { kind: "refused" };
  }
  const expression = splitSearchFilters(input.expression);
  if (expression === undefined || (expression.literal === "" && expression.filters.length === 0))
    return { kind: "refused", reason: "Check the search expression." };
  const terms = literalSearchTerms(expression.literal);
  if (terms === undefined) return { kind: "refused", reason: "Check the search expression." };
  const matches: ApplicationSearchMatch[] = [];
  let boundary: Readonly<{ score: number; id: string }> | undefined;
  for (const entry of parsed.data.recordTypes) {
    if (entry.recordType.state !== "resolved") {
      console.error("[search] refused SEARCH_RECORD_TYPE_NOT_RESOLVED");
      return { kind: "refused" };
    }
    const recordTypeId = String(entry.recordType.recordTypeId);
    const fields = input.fieldsByRecordType.get(recordTypeId.toLowerCase());
    if (fields === undefined) throw new Error("SEARCH_RECORD_TYPE_FIELDS_MISSING");
    const filters = prepareSearchFilters(
      expression.filters,
      fields,
      entry.fields.map((field) => String(field.fieldId)),
    );
    if (filters === undefined)
      return { kind: "refused", reason: "A filter field or value is not valid for this search." };
    if (!input.allowedRecordTypeIds.has(recordTypeId.toLowerCase())) continue;
    let after = input.after;
    let read = 0;
    let displayed = 0;
    while (displayed < 41 && read < 200) {
      const limit = Math.min(41 - displayed, 200 - read);
      const page = await input.readPage({
        recordTypeId,
        fields: entry.fields,
        titleFieldId: String(entry.titleFieldId),
        terms,
        filters,
        ...(after === undefined ? {} : { after }),
        limit,
      });
      read += page.length;
      for (const row of page) {
        const values = new Map(
          Object.entries(row.record.values).map(([id, value]) => [id.toLowerCase(), value]),
        );
        const title = displayValue(values.get(String(entry.titleFieldId).toLowerCase()));
        if (title === undefined) continue;
        const subtitle =
          entry.subtitleFieldId === undefined
            ? undefined
            : displayValue(values.get(String(entry.subtitleFieldId).toLowerCase()));
        matches.push({
          recordId: row.recordId,
          recordTypeId,
          targetPageId: String(entry.targetPageId),
          concurrencyNumber: row.record.concurrencyNumber,
          title,
          ...(subtitle === undefined ? {} : { subtitle }),
          rank: row.rank,
        });
        displayed += 1;
      }
      const last = page[page.length - 1];
      if (page.length < limit || last === undefined) break;
      after = { score: last.rank, id: last.recordId };
      if (
        read === 200 &&
        displayed < 41 &&
        (boundary === undefined ||
          after.score > boundary.score ||
          (after.score === boundary.score && after.id.localeCompare(boundary.id) < 0))
      )
        boundary = after;
    }
  }
  matches.sort(
    (left, right) => right.rank - left.rank || left.recordId.localeCompare(right.recordId),
  );
  return { kind: "available", matches, ...(boundary === undefined ? {} : { boundary }) };
};
