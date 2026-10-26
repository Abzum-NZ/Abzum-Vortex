import "server-only";

import { z } from "zod";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import type { SelectedOrganizationScope } from "../access/identity-access";
import type { JsonValue } from "../catalogue/common";
import { sameId } from "../catalogue/runtime-primitives";
import {
  type QueryContinuation,
  type QueryContinuationKey,
  decodeQueryContinuationToken,
  QueryContinuationTokenError,
  fingerprintQueryInputs,
  encodeQueryContinuationToken,
} from "./continuation-token";
import {
  protectedQueryBoardMembersCommandSchema,
  protectedQueryBoardSelectorSchema,
  type ProtectedQueryBoardMembersCommand,
  type ProtectedQueryResult,
} from "./protected-query-contracts";
import {
  type ResultRow,
  one,
  refusal,
  filterInputRefusal,
  normalizeConditionFieldIdentifiers,
  sqlArray,
  admitQueryInputs,
} from "./protected-query-helpers";
import { pageReadSchema, boardColumnPagesReadSchema } from "./protected-query-read-schemas";

export const boardColumnPagesCommandSchema = protectedQueryBoardMembersCommandSchema
  .omit({ selector: true, continuationToken: true })
  .extend({
    selectors: z
      .array(protectedQueryBoardSelectorSchema)
      .min(1)
      .max(13)
      .refine(
        (selectors) =>
          selectors.every((selector) =>
            sameId(selector.choiceFieldId, selectors[0]!.choiceFieldId),
          ) &&
          new Set(selectors.map((selector) => JSON.stringify(selector.column))).size ===
            selectors.length &&
          selectors.filter((selector) => selector.column.kind === "unassigned").length <= 1,
        { message: "Board columns must be unique and name unassigned at most once" },
      ),
  })
  .strict();

const readBoardMemberPage = async (
  transaction: RequestDatabaseTransaction,
  command: ProtectedQueryBoardMembersCommand,
  releaseRevision: number,
  inputValues: Readonly<Record<string, JsonValue>>,
  after: QueryContinuation | undefined,
) => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.run_module_query_board_column(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${sqlArray(command.requestedFieldIds)}::text::uuid[],
      ${sqlArray(command.requestedSystemFieldKeys)}::text::text[],
      ${command.filter === undefined ? null : JSON.stringify(command.filter)}::text::jsonb,
      ${sqlArray(command.filterableFieldIds)}::text::uuid[],
      ${command.selector.choiceFieldId}::uuid,
      ${JSON.stringify(command.selector.column)}::text::jsonb,
      ${command.pageSize}::integer,
      ${after === undefined ? null : JSON.stringify({ sort: after.sort, sortKey: after.sortKey, phase: after.phase, recordId: after.recordId })}::text::jsonb
    ) as result
  `;
  return pageReadSchema.parse(one(rows));
};

export const boardMembersCommand = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: ProtectedQueryBoardMembersCommand,
  continuationKey: QueryContinuationKey,
): Promise<ProtectedQueryResult> => {
  const applicationRootId = scope.applicationRootId;
  if (applicationRootId === undefined) return refusal("request_invalid");
  const filterRefusal = filterInputRefusal(command);
  if (filterRefusal !== undefined) return refusal(filterRefusal);

  let after: QueryContinuation | undefined;
  if (command.continuationToken !== undefined) {
    try {
      after = decodeQueryContinuationToken(command.continuationToken, continuationKey);
    } catch (error) {
      if (error instanceof QueryContinuationTokenError) return refusal("cursor_invalid");
      throw error;
    }
    if (
      !sameId(after.organizationId, scope.organizationId) ||
      !sameId(after.applicationRootId, applicationRootId) ||
      !sameId(after.organizationAccountId, scope.organizationAccountId) ||
      !sameId(after.moduleRootId, command.moduleRootId) ||
      !sameId(after.queryId, command.queryId) ||
      after.direction !== "forward"
    )
      return refusal("cursor_stale");
    // Board pages have one fixed record-identity order. A row-query keyset can
    // never be interpreted as a member-page position.
    if (after.sortKey.length !== 0) return refusal("cursor_stale");
  }

  const admitted = await admitQueryInputs(transaction, command, after?.moduleReleaseRevision);
  if (admitted.outcome === "refused") return admitted;
  const { declared, inputValues } = admitted;

  const inputFingerprint = boardMemberFingerprint(command, inputValues);
  if (after !== undefined && after.inputFingerprint !== inputFingerprint)
    return refusal("cursor_stale");

  const page = await readBoardMemberPage(
    transaction,
    command,
    declared.moduleReleaseRevision,
    inputValues,
    after,
  );
  if (page.outcome === "refused") return refusal(page.reasonCode);
  return boardMemberResult(
    scope,
    applicationRootId,
    command,
    page,
    inputFingerprint,
    continuationKey,
  );
};

/** Binds a member page's continuation to its exact operation, selector and projection. */
const boardMemberFingerprint = (
  command: ProtectedQueryBoardMembersCommand,
  inputValues: Readonly<Record<string, JsonValue>>,
): string =>
  fingerprintQueryInputs({
    operation: "protected-board-members-v1",
    inputValues,
    selector: {
      choiceFieldId: command.selector.choiceFieldId.toLowerCase(),
      column: command.selector.column,
    },
    filter: normalizeConditionFieldIdentifiers(command.filter ?? null),
    filterableFieldIds: command.filterableFieldIds.map((fieldId) => fieldId.toLowerCase()).sort(),
    requestedFieldIds: command.requestedFieldIds.map((fieldId) => fieldId.toLowerCase()).sort(),
    requestedSystemFieldKeys: [...command.requestedSystemFieldKeys].sort(),
    pageSize: command.pageSize,
    memberOrder: "record_id_ascending",
  });

/** One column's member page with its continuation, whichever read produced it. */
const boardMemberResult = (
  scope: SelectedOrganizationScope,
  applicationRootId: NonNullable<SelectedOrganizationScope["applicationRootId"]>,
  command: ProtectedQueryBoardMembersCommand,
  page: Extract<z.infer<typeof pageReadSchema>, { outcome: "completed" }>,
  inputFingerprint: string,
  continuationKey: QueryContinuationKey,
): ProtectedQueryResult => {
  const declaredSystemKeys = new Set<string>(command.requestedSystemFieldKeys);
  for (const row of page.rows) {
    const disclosed = Object.keys(row.systemValues ?? {});
    if (
      disclosed.some((key) => !declaredSystemKeys.has(key)) ||
      declaredSystemKeys.size > 0 !== (row.systemValues !== undefined) ||
      declaredSystemKeys.size !== disclosed.length
    )
      throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  }

  return {
    outcome: "completed",
    moduleRootId: command.moduleRootId,
    moduleReleaseVersion: page.moduleReleaseVersion,
    queryId: command.queryId,
    rows: page.rows,
    fieldBounds: page.fieldBounds,
    scanLimited: page.next !== null && page.rows.length < command.pageSize,
    ...(page.next === null
      ? {}
      : {
          nextContinuationToken: encodeQueryContinuationToken(
            {
              version: 1,
              direction: "forward",
              organizationId: scope.organizationId,
              applicationRootId,
              organizationAccountId: scope.organizationAccountId,
              moduleRootId: command.moduleRootId,
              queryId: command.queryId,
              moduleReleaseRevision: page.moduleReleaseRevision,
              inputFingerprint,
              sortKey: page.next.sortKey,
              sort: page.next.sort,
              phase: page.next.phase,
              recordId: page.next.recordId,
            },
            continuationKey,
          ),
        }),
  };
};

/** Every displayed column's first member page, read in one database call. */
const readBoardColumnPages = async (
  transaction: RequestDatabaseTransaction,
  command: z.infer<typeof boardColumnPagesCommandSchema>,
  releaseRevision: number,
  inputValues: Readonly<Record<string, JsonValue>>,
) => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.run_module_query_board_columns(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${sqlArray(command.requestedFieldIds)}::text::uuid[],
      ${sqlArray(command.requestedSystemFieldKeys)}::text::text[],
      ${command.filter === undefined ? null : JSON.stringify(command.filter)}::text::jsonb,
      ${sqlArray(command.filterableFieldIds)}::text::uuid[],
      ${command.selectors[0]!.choiceFieldId}::uuid,
      ${JSON.stringify(command.selectors.map((selector) => selector.column))}::text::jsonb,
      ${command.pageSize}::integer
    ) as result
  `;
  return boardColumnPagesReadSchema.parse(one(rows));
};

/**
 * The first pages of the named board columns: one bounded member page per column, each with its own
 * continuation exactly as a member page read would return it.
 */
export const boardColumnPagesCommand = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: z.infer<typeof boardColumnPagesCommandSchema>,
  continuationKey: QueryContinuationKey,
): Promise<
  | Readonly<{ outcome: "completed"; pages: readonly ProtectedQueryResult[] }>
  | Extract<ProtectedQueryResult, { outcome: "refused" }>
> => {
  const applicationRootId = scope.applicationRootId;
  if (applicationRootId === undefined) return refusal("request_invalid");
  const memberCommands = command.selectors.map((selector): ProtectedQueryBoardMembersCommand => ({
    ...command,
    selector,
  }));
  const filterRefusal = filterInputRefusal(memberCommands[0]!);
  if (filterRefusal !== undefined) return refusal(filterRefusal);

  const admitted = await admitQueryInputs(transaction, command);
  if (admitted.outcome === "refused") return admitted;
  const { declared, inputValues } = admitted;

  const read = await readBoardColumnPages(
    transaction,
    command,
    declared.moduleReleaseRevision,
    inputValues,
  );
  if (read.outcome === "refused") return refusal(read.reasonCode);
  if (
    read.columns.length !== memberCommands.length ||
    read.columns.some(
      (page, index) =>
        JSON.stringify(page.column) !== JSON.stringify(memberCommands[index]!.selector.column),
    )
  )
    throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  return {
    outcome: "completed",
    pages: memberCommands.map((memberCommand, index) =>
      boardMemberResult(
        scope,
        applicationRootId,
        memberCommand,
        {
          outcome: "completed",
          moduleReleaseRevision: read.moduleReleaseRevision,
          moduleReleaseVersion: read.moduleReleaseVersion,
          rows: read.columns[index]!.rows,
          next: read.columns[index]!.next,
          opposite: null,
          fieldBounds: read.fieldBounds,
        },
        boardMemberFingerprint(memberCommand, inputValues),
        continuationKey,
      ),
    ),
  };
};
