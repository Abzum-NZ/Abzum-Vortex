import "server-only";

import type { RequestDatabaseTransaction } from "../db/index";
import type { JsonValue, SelectedOrganizationScope } from "../schema";
import {
  type ProtectedQuerySummaryCommand,
  protectedQuerySummaryResultSchema,
  type ProtectedQueryBoardSummaryCommand,
  type ProtectedQueryBoardSummaryResult,
  protectedQueryBoardSummaryResultSchema,
  type ProtectedQuerySummaryResult,
} from "./protected-query-contracts";
import {
  type ResultRow,
  one,
  refusal,
  filterInputRefusal,
  readInputs,
} from "./protected-query-helpers";
import {
  parseQueryInputDeclarations,
  validateQueryInputValues,
  QueryInputRefusalError,
} from "./typed-input-validation";

/**
 * A group continuation is the JSON text [rank, title, canonical group value]; its last part is the
 * key of the final group the page returned, which is how a member read names that group.
 */
const groupCursorEndsAt = (cursor: string | undefined, groupKey: string | undefined): boolean => {
  try {
    const parts: unknown = JSON.parse(cursor ?? "");
    return Array.isArray(parts) && parts.length === 3 && parts[2] === groupKey;
  } catch {
    return false;
  }
};

const readSummary = async (
  transaction: RequestDatabaseTransaction,
  command: ProtectedQuerySummaryCommand,
  releaseRevision: number,
  inputValues: Readonly<Record<string, JsonValue>>,
) => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.run_module_query_summary(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${JSON.stringify({
        filter: command.filter ?? null,
        search: command.search ?? null,
        searchableFieldIds: command.searchableFieldIds,
        ...(command.grouping === undefined ? {} : { grouping: command.grouping }),
        ...(command.pivot === undefined ? {} : { pivot: command.pivot }),
        ...(command.groupAfter === undefined ? {} : { groupAfter: command.groupAfter }),
        filterableFieldIds: command.filterableFieldIds,
      })}::text::jsonb
    ) as result
  `;
  return protectedQuerySummaryResultSchema.parse(one(rows));
};

const readBoardSummary = async (
  transaction: RequestDatabaseTransaction,
  command: ProtectedQueryBoardSummaryCommand,
  releaseRevision: number,
  inputValues: Readonly<Record<string, JsonValue>>,
): Promise<ProtectedQueryBoardSummaryResult> => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.run_module_query_summary(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${JSON.stringify({
        filter: command.filter ?? null,
        filterableFieldIds: command.filterableFieldIds,
        boardSummary: { choiceFieldId: command.choiceFieldId, columns: command.columns },
      })}::text::jsonb
    ) as result
  `;
  return protectedQueryBoardSummaryResultSchema.parse(one(rows));
};

export const summariseCommand = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: ProtectedQuerySummaryCommand,
): Promise<ProtectedQuerySummaryResult> => {
  if (scope.applicationRootId === undefined) return refusal("request_invalid");
  const userRefusal = filterInputRefusal(command);
  if (userRefusal !== undefined) return refusal(userRefusal);

  const declared = await readInputs(transaction, command);
  if (declared.outcome === "refused") return refusal(declared.reasonCode);
  const declarations = parseQueryInputDeclarations(declared.inputs);
  if (declarations === undefined) return refusal("descriptor_invalid");

  let inputValues: Readonly<Record<string, JsonValue>>;
  try {
    inputValues = validateQueryInputValues(declarations, command.inputValues);
  } catch (error) {
    if (error instanceof QueryInputRefusalError) return refusal("input_invalid");
    throw error;
  }

  const result = await readSummary(
    transaction,
    command,
    declared.moduleReleaseRevision,
    inputValues,
  );
  if (
    result.outcome === "completed" &&
    command.grouping !== undefined &&
    (result.groups.length > command.grouping.limit ||
      result.groupByFieldIds.length !== 1 ||
      result.groupByFieldIds[0]?.toLowerCase() !== command.grouping.fieldId.toLowerCase() ||
      (result.nextGroupKey !== null &&
        !groupCursorEndsAt(result.nextGroupKey, result.groups.at(-1)?.groupKey)))
  )
    throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  if (
    result.outcome === "completed" &&
    command.pivot !== undefined &&
    (result.pivot === undefined ||
      result.pivot.rows.length > command.pivot.rowLimit ||
      result.pivot.rowFieldId.toLowerCase() !== command.pivot.rowFieldId.toLowerCase() ||
      result.pivot.columnFieldId.toLowerCase() !== command.pivot.columnFieldId.toLowerCase() ||
      (result.nextGroupKey !== null &&
        result.nextGroupKey !== undefined &&
        result.nextGroupKey !== result.pivot.rows.at(-1)?.key))
  )
    throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  return result;
};

export const boardSummaryCommand = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: ProtectedQueryBoardSummaryCommand,
): Promise<ProtectedQueryBoardSummaryResult> => {
  if (scope.applicationRootId === undefined) return refusal("request_invalid");
  const userRefusal = filterInputRefusal(command);
  if (userRefusal !== undefined) return refusal(userRefusal);

  const declared = await readInputs(transaction, command);
  if (declared.outcome === "refused") return refusal(declared.reasonCode);
  const declarations = parseQueryInputDeclarations(declared.inputs);
  if (declarations === undefined) return refusal("descriptor_invalid");

  let inputValues: Readonly<Record<string, JsonValue>>;
  try {
    inputValues = validateQueryInputValues(declarations, command.inputValues);
  } catch (error) {
    if (error instanceof QueryInputRefusalError) return refusal("input_invalid");
    throw error;
  }

  return readBoardSummary(transaction, command, declared.moduleReleaseRevision, inputValues);
};
