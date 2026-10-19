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
        boardSummary: { choiceFieldId: command.choiceFieldId },
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

  return readSummary(transaction, command, declared.moduleReleaseRevision, inputValues);
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
