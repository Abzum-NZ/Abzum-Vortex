import "server-only";

import type { JsonValue } from "../catalogue/common";
import type { ModuleField } from "../definition/module-contracts";
import type { ConditionNode } from "../definition/module-foundation-contracts";
import { normalizeExactDecimal } from "../records/exact-decimal";
import { moduleFieldValueSchemas } from "../records/module-field-values";
import { evaluateTypedCondition } from "../rules/typed-condition";

type SearchFilter = Readonly<{ key: string; value: string }>;

/** Separate field selectors from the literal expression without changing its quote grammar. */
export const splitSearchFilters = (
  expression: string,
): Readonly<{ literal: string; filters: readonly SearchFilter[] }> | undefined => {
  const tokens: string[] = [];
  const filters: SearchFilter[] = [];
  let offset = 0;
  while (offset < expression.length) {
    while (offset < expression.length && /\s/u.test(expression[offset]!)) offset += 1;
    if (offset === expression.length) break;
    const start = offset;
    let quoted = false;
    while (offset < expression.length) {
      const char = expression[offset]!;
      if (char === '"') quoted = !quoted;
      if (!quoted && /\s/u.test(char)) break;
      offset += 1;
    }
    if (quoted) return undefined;
    const token = expression.slice(start, offset);
    const filter = /^([a-z][a-z0-9_]*):("[^"]+"|[^\s"]+)$/u.exec(token);
    if (filter === null) {
      if (/^[a-z][a-z0-9_]*:/u.test(token)) return undefined;
      tokens.push(token);
      continue;
    }
    const raw = filter[2]!;
    filters.push({ key: filter[1]!, value: raw.startsWith('"') ? raw.slice(1, -1) : raw });
    if (filters.length > 32) return undefined;
  }
  return { literal: tokens.join(" "), filters };
};

type PreparedFilter = Readonly<{ field: ModuleField; condition: ConditionNode }>;

/** Build the same typed conditions used by ordinary queries, over configured search fields. */
export const prepareSearchFilters = (
  filters: readonly SearchFilter[],
  fields: readonly ModuleField[],
  searchableFieldIds: readonly string[],
): readonly PreparedFilter[] | undefined => {
  const searchable = new Set(searchableFieldIds.map((id) => id.toLowerCase()));
  const prepared: PreparedFilter[] = [];
  for (const filter of filters) {
    const field = fields.find(
      (candidate) =>
        candidate.key === filter.key && searchable.has(candidate.fieldId.toLowerCase()),
    );
    if (field === undefined) return undefined;
    let value: JsonValue;
    let operator: "equals" | "contains" = "equals";
    switch (field.type) {
      case "text":
      case "long_text":
      case "reference_number":
      case "email_address":
      case "phone_number":
      case "web_address":
        value = filter.value;
        operator = "contains";
        break;
      case "whole_number": {
        if (!/^-?\d+$/u.test(filter.value)) return undefined;
        const number = Number(filter.value);
        if (!Number.isSafeInteger(number)) return undefined;
        value = number;
        break;
      }
      case "decimal_number": {
        const decimal = normalizeExactDecimal(filter.value);
        if (decimal === undefined) return undefined;
        value = decimal;
        break;
      }
      case "yes_no":
        if (filter.value !== "true" && filter.value !== "false") return undefined;
        value = filter.value === "true";
        break;
      case "date":
      case "date_time":
        if (!moduleFieldValueSchemas[field.type].safeParse(filter.value).success) return undefined;
        value = filter.value;
        break;
      case "choice":
        if (!field.settings.options.some((option) => option.value === filter.value))
          return undefined;
        value = filter.value;
        break;
      default:
        return undefined;
    }
    prepared.push({
      field,
      condition: {
        kind: "comparison",
        operator,
        left: { source: "field", fieldId: field.fieldId },
        right: { source: "value", value },
      },
    });
  }
  return prepared;
};

/** A missing field is withheld, so it cannot satisfy a filter. */
export const matchesSearchFilters = (
  filters: readonly PreparedFilter[],
  values: Readonly<Record<string, JsonValue>>,
): boolean =>
  filters.every(({ field, condition }) => {
    const key = Object.keys(values).find((id) => id.toLowerCase() === field.fieldId.toLowerCase());
    if (key === undefined) return false;
    return evaluateTypedCondition({
      condition,
      sourceRecordFields: [field],
      declaredFieldIds: [field.fieldId],
      fieldValues: { [field.fieldId]: values[key] },
      parameterDeclarations: [],
      parameterValues: {},
    });
  });
