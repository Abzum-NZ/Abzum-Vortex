import "server-only";

import type { z, ZodError } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import type {
  ProtectedQueryRefusalReasonCode,
  ProtectedQueryResult,
  ProtectedQueryCommand,
  ProtectedQuerySummaryCommand,
} from "./protected-query-contracts";
import { inputsReadSchema } from "./protected-query-read-schemas";
import {
  parseQueryInputDeclarations,
  QueryInputRefusalError,
  validateQueryInputValues,
} from "./typed-input-validation";
import type { JsonValue } from "../catalogue/common";

export type ResolvedInputs = Extract<z.infer<typeof inputsReadSchema>, { outcome: "resolved" }>;

export type ResultRow = DatabaseRow & { readonly result: unknown };

export const refusal = (
  reasonCode: ProtectedQueryRefusalReasonCode,
): Extract<ProtectedQueryResult, { outcome: "refused" }> => ({
  outcome: "refused",
  reasonCode,
});

/**
 * A refusal the engine answers with: the client sees only the neutral reason code; the part of the
 * request and the cause are logged here so a refusal never goes without one.
 */
export const refuseWithCause = (
  reasonCode: ProtectedQueryRefusalReasonCode,
  part: string,
  cause: string,
): Extract<ProtectedQueryResult, { outcome: "refused" }> => {
  console.error("[protected-query] request refused", { part, reason: reasonCode, cause });
  return refusal(reasonCode);
};

/** A command that does not parse is refused; the issues' codes and paths (never values) are logged. */
export const refuseInvalidCommand = (
  error: ZodError,
): Extract<ProtectedQueryResult, { outcome: "refused" }> => {
  console.error("[protected-query] request refused", {
    part: "command",
    reason: "request_invalid",
    issues: error.issues.map(({ code, path }) => ({ code, path })),
  });
  return refusal("request_invalid");
};

export const one = (rows: readonly ResultRow[]): unknown => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  return rows[0].result;
};

/**
 * The Postgres array literal of schema-validated identities or closed keys, bound as text and cast
 * by the statement (`::text::uuid[]`, `::text::text[]`). Never used for free text.
 */
export const sqlArray = (values: readonly string[]): string => `{${values.join(",")}}`;

/** Every field identifier a typed condition tree reads, lower-cased; a malformed node contributes none. */
export const conditionFieldIds = (condition: unknown, into: Set<string>): void => {
  if (Array.isArray(condition)) {
    for (const item of condition) conditionFieldIds(item, into);
    return;
  }
  if (condition === null || typeof condition !== "object") return;
  const record = condition as Record<string, unknown>;
  if (record.source === "field" && typeof record.fieldId === "string")
    into.add(record.fieldId.toLowerCase());
  for (const item of Object.values(record)) conditionFieldIds(item, into);
};

export const readInputs = async (
  transaction: RequestDatabaseTransaction,
  command: Pick<ProtectedQueryCommand, "moduleRootId" | "queryId">,
) => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.read_module_query_inputs(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid
    ) as result
  `;
  return inputsReadSchema.parse(one(rows));
};

export const filterInputRefusal = (
  command: Pick<ProtectedQuerySummaryCommand, "filter" | "filterableFieldIds">,
): ProtectedQueryRefusalReasonCode | undefined => {
  if (command.filter === undefined) return undefined;
  const filterable = new Set(command.filterableFieldIds.map((fieldId) => fieldId.toLowerCase()));
  const referenced = new Set<string>();
  conditionFieldIds(command.filter, referenced);
  return [...referenced].some((fieldId) => !filterable.has(fieldId)) ? "filter_invalid" : undefined;
};

export const normalizeConditionFieldIdentifiers = (condition: unknown): unknown => {
  if (Array.isArray(condition)) return condition.map(normalizeConditionFieldIdentifiers);
  if (condition === null || typeof condition !== "object") return condition;
  const record = condition as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    normalized[key] =
      key === "fieldId" && record.source === "field" && typeof value === "string"
        ? value.toLowerCase()
        : normalizeConditionFieldIdentifiers(value);
  }
  return normalized;
};

/**
 * The admission every protected query mode runs before its SQL: the query's declared inputs, the
 * continuation's release (when the request continues one), the declarations and the caller's
 * values. A refusal is logged with its cause.
 */
export const admitQueryInputs = async (
  transaction: RequestDatabaseTransaction,
  command: Pick<ProtectedQueryCommand, "moduleRootId" | "queryId" | "inputValues">,
  continuedReleaseRevision?: number,
): Promise<
  | Readonly<{
      outcome: "admitted";
      declared: ResolvedInputs;
      inputValues: Readonly<Record<string, JsonValue>>;
    }>
  | Extract<ProtectedQueryResult, { outcome: "refused" }>
> => {
  const declared = await readInputs(transaction, command);
  if (declared.outcome === "refused")
    return refuseWithCause(declared.reasonCode, "query_inputs", declared.reasonCode);
  if (
    continuedReleaseRevision !== undefined &&
    continuedReleaseRevision !== declared.moduleReleaseRevision
  )
    return refuseWithCause("cursor_stale", "continuation", "release_changed");
  const declarations = parseQueryInputDeclarations(declared.inputs);
  if (declarations === undefined)
    return refuseWithCause("descriptor_invalid", "query_inputs", "declarations_unreadable");
  try {
    return {
      outcome: "admitted",
      declared,
      inputValues: validateQueryInputValues(declarations, command.inputValues),
    };
  } catch (error) {
    if (error instanceof QueryInputRefusalError)
      return refuseWithCause("input_invalid", "query_inputs", error.message);
    throw error;
  }
};
