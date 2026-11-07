import "server-only";

import type { z, ZodError } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import { markRequestFailureLogged, requestFailureLogged } from "../access/request-failure-mark";
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

type ResolvedInputs = Extract<z.infer<typeof inputsReadSchema>, { outcome: "resolved" }>;

export type ResultRow = DatabaseRow & { readonly result: unknown };

export const refusal = (
  reasonCode: ProtectedQueryRefusalReasonCode,
): Extract<ProtectedQueryResult, { outcome: "refused" }> => ({
  outcome: "refused",
  reasonCode,
});

/**
 * The one line of a refused answer, where the answer is made: the part of the request and the
 * reason code, never a value or a message. Every refusal is information (the answer is expected:
 * a stale position, an input the page cannot run, a forbidden read, an application not installed)
 * except a stored query descriptor that cannot be read, which is a platform fault. The answer is
 * marked logged, so the exit of the service logs only the answers it did not already log.
 */
const logRefused = (part: string, reasonCode: string): void => {
  const line = `[protected-query] request part=${part} refused: code=${reasonCode}`;
  if (reasonCode === "descriptor_invalid") console.error(line);
  else console.info(line);
};

/**
 * Passes an answer through the exit of a protected query: a refused answer nobody logged yet (the
 * database returned it, or it is a literal of a query mode) is logged once and marked; an answer
 * already logged, and every completed answer, pass unchanged.
 */
export const answeredOnce = <Answer extends Readonly<{ outcome: string; reasonCode?: string }>>(
  answer: Answer,
  part = "result",
): Answer => {
  if (answer.outcome !== "refused" || requestFailureLogged(answer)) return answer;
  logRefused(part, answer.reasonCode ?? "unknown");
  return markRequestFailureLogged(answer);
};

/** A refusal the engine answers with: the part of the request it refused and its reason code. */
export const refuseWithCause = (
  reasonCode: ProtectedQueryRefusalReasonCode,
  part: string,
): Extract<ProtectedQueryResult, { outcome: "refused" }> => answeredOnce(refusal(reasonCode), part);

/** A command that does not parse is refused; the issues' codes and paths (never values) are logged. */
export const refuseInvalidCommand = (
  error: ZodError,
): Extract<ProtectedQueryResult, { outcome: "refused" }> =>
  answeredOnce(
    refusal("request_invalid"),
    `command issues=${error.issues.map(({ code, path }) => `${code}@${path.join(".")}`).join(",")}`,
  );

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

const readInputs = async (
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
 * values. A refusal is logged once, with its part.
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
  if (declared.outcome === "refused") return refuseWithCause(declared.reasonCode, "query_inputs");
  if (
    continuedReleaseRevision !== undefined &&
    continuedReleaseRevision !== declared.moduleReleaseRevision
  )
    return refuseWithCause("cursor_stale", "continuation");
  const declarations = parseQueryInputDeclarations(declared.inputs);
  if (declarations === undefined) return refuseWithCause("descriptor_invalid", "query_inputs");
  try {
    return {
      outcome: "admitted",
      declared,
      inputValues: validateQueryInputValues(declarations, command.inputValues),
    };
  } catch (error) {
    if (error instanceof QueryInputRefusalError)
      return refuseWithCause("input_invalid", "query_inputs");
    throw error;
  }
};
