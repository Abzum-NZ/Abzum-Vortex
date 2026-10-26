import "server-only";

import type { RequestDatabaseTransaction } from "../db/request-transaction";
import type { SelectedOrganizationScope } from "../access/identity-access";
import type { JsonValue } from "../catalogue/common";
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
  refuseWithCause,
  filterInputRefusal,
  sqlArray,
  admitQueryInputs,
} from "./protected-query-helpers";

/**
 * A group continuation is the JSON text [rank, title, canonical group value]; its last part is the
 * key of the final group the page returned, which is how a member read names that group.
 */
const groupCursorEndsAt = (cursor: string | undefined, groupKey: string | undefined): boolean => {
  try {
    const parts: unknown = JSON.parse(cursor ?? "");
    return Array.isArray(parts) && parts.length === 3 && parts[2] === groupKey;
    // guard-allow: silent-catch A cursor that is not JSON does not end at the group.
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
  const rows = await (command.mode === "pivot"
    ? transaction.query<ResultRow>`
    select vortex_record.run_module_query_pivot(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${JSON.stringify(command.filter ?? null)}::text::jsonb,
      ${sqlArray(command.filterableFieldIds)}::text::uuid[],
      ${command.search ?? null}::text,
      ${sqlArray(command.searchableFieldIds)}::text::uuid[],
      ${JSON.stringify(command.pivot)}::text::jsonb,
      ${command.groupAfter ?? null}::text
    ) as result
  `
    : command.mode === "grouping"
      ? transaction.query<ResultRow>`
    select vortex_record.run_module_query_group_summary(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${JSON.stringify(command.filter ?? null)}::text::jsonb,
      ${sqlArray(command.filterableFieldIds)}::text::uuid[],
      ${command.search ?? null}::text,
      ${sqlArray(command.searchableFieldIds)}::text::uuid[],
      ${JSON.stringify(command.grouping)}::text::jsonb,
      ${command.groupAfter ?? null}::text
    ) as result
  `
      : command.mode === "totals"
        ? transaction.query<ResultRow>`
    select vortex_record.run_module_query_totals(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${JSON.stringify(command.filter ?? null)}::text::jsonb,
      ${sqlArray(command.filterableFieldIds)}::text::uuid[],
      ${command.search ?? null}::text,
      ${sqlArray(command.searchableFieldIds)}::text::uuid[],
      ${JSON.stringify(command.totals)}::text::jsonb,
      ${command.groupLimit ?? null}::integer,
      ${command.groupAfter ?? null}::text
    ) as result
  `
        : transaction.query<ResultRow>`
    select vortex_record.run_module_query_published_summary(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${JSON.stringify(command.filter ?? null)}::text::jsonb,
      ${sqlArray(command.filterableFieldIds)}::text::uuid[],
      ${command.search ?? null}::text,
      ${sqlArray(command.searchableFieldIds)}::text::uuid[],
      ${command.groupLimit ?? null}::integer,
      ${command.groupAfter ?? null}::text
    ) as result
  `);
  return protectedQuerySummaryResultSchema.parse(one(rows));
};

const readBoardSummary = async (
  transaction: RequestDatabaseTransaction,
  command: ProtectedQueryBoardSummaryCommand,
  releaseRevision: number,
  inputValues: Readonly<Record<string, JsonValue>>,
): Promise<ProtectedQueryBoardSummaryResult> => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.run_module_query_board_summary(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${JSON.stringify(command.filter ?? null)}::text::jsonb,
      ${sqlArray(command.filterableFieldIds)}::text::uuid[],
      ${command.choiceFieldId}::uuid,
      ${JSON.stringify(command.columns)}::text::jsonb
    ) as result
  `;
  return protectedQueryBoardSummaryResultSchema.parse(one(rows));
};

export const summariseCommand = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: ProtectedQuerySummaryCommand,
): Promise<ProtectedQuerySummaryResult> => {
  if (scope.applicationRootId === undefined)
    return refuseWithCause("request_invalid", "scope", "application_not_selected");
  const userRefusal = filterInputRefusal(command);
  if (userRefusal !== undefined) return refuseWithCause(userRefusal, "filter", userRefusal);

  const admitted = await admitQueryInputs(transaction, command);
  if (admitted.outcome === "refused") return admitted;
  const { declared, inputValues } = admitted;

  const result = await readSummary(
    transaction,
    command,
    declared.moduleReleaseRevision,
    inputValues,
  );
  if (
    result.outcome === "completed" &&
    command.mode === "grouping" &&
    (result.groups.length > command.grouping.limit ||
      result.groupByFieldIds.length !== 1 ||
      result.groupByFieldIds[0]?.toLowerCase() !== command.grouping.fieldId.toLowerCase() ||
      (result.nextGroupKey !== null &&
        !groupCursorEndsAt(result.nextGroupKey, result.groups.at(-1)?.groupKey)))
  )
    throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  // The query's own grouping is paged too: at most the requested page, or the default 40.
  if (
    result.outcome === "completed" &&
    (command.mode === "published" || command.mode === "totals") &&
    (result.groups.length > (command.groupLimit ?? 40) ||
      (result.nextGroupKey !== null &&
        result.nextGroupKey !== undefined &&
        !groupCursorEndsAt(result.nextGroupKey, result.groups.at(-1)?.groupKey)))
  )
    throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  if (
    result.outcome === "completed" &&
    command.mode === "pivot" &&
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
  if (scope.applicationRootId === undefined)
    return refuseWithCause("request_invalid", "scope", "application_not_selected");
  const userRefusal = filterInputRefusal(command);
  if (userRefusal !== undefined) return refuseWithCause(userRefusal, "filter", userRefusal);

  const admitted = await admitQueryInputs(transaction, command);
  if (admitted.outcome === "refused") return admitted;
  const { declared, inputValues } = admitted;

  return readBoardSummary(transaction, command, declared.moduleReleaseRevision, inputValues);
};
