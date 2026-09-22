import "server-only";

import { z } from "zod";
import {
  fieldIdSchema,
  jsonValueSchema,
  recordIdSchema,
  stableDefinitionReleaseVersionSchema,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  decodeQueryContinuationToken,
  encodeQueryContinuationToken,
  fingerprintQueryInputs,
  QueryContinuationTokenError,
  type QueryContinuation,
  type QueryContinuationKey,
} from "./continuation-token";
import {
  protectedQueryCommandSchema,
  protectedQueryRefusalReasonCodes,
  type ProtectedQueryCommand,
  type ProtectedQueryRefusalReasonCode,
  type ProtectedQueryResult,
} from "./protected-query-contracts";
import {
  parseQueryInputDeclarations,
  QueryInputRefusalError,
  validateQueryInputValues,
} from "./typed-input-validation";

export type ProtectedQueryServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /** Server-held AES-256-GCM key that makes continuation tokens opaque and bound. */
    continuationKey: QueryContinuationKey;
  }>;

type ResultRow = DatabaseRow & { readonly result: unknown };

const refusal = (reasonCode: ProtectedQueryRefusalReasonCode): ProtectedQueryResult => ({
  outcome: "refused",
  reasonCode,
});

const one = (rows: readonly ResultRow[]): unknown => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  return rows[0].result;
};

const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const refusedSchema = z
  .object({ outcome: z.literal("refused"), reasonCode: z.enum(protectedQueryRefusalReasonCodes) })
  .strict();
const inputsReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("resolved"),
      moduleReleaseRevision: revisionSchema,
      moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
      inputs: z.unknown(),
    })
    .strict(),
  refusedSchema,
]);
const pageReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      moduleReleaseRevision: revisionSchema,
      moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
      rows: z
        .array(
          z
            .object({
              recordId: recordIdSchema,
              values: z.record(fieldIdSchema, jsonValueSchema),
            })
            .strict(),
        )
        .max(200),
      next: z
        .object({
          sortKey: z.array(z.string().nullable()).min(1).max(20),
          recordId: recordIdSchema,
        })
        .strict()
        .nullable(),
    })
    .strict(),
  refusedSchema,
]);

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const readInputs = async (transaction: RequestDatabaseTransaction, command: ProtectedQueryCommand) => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.read_module_query_inputs(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid
    ) as result
  `;
  return inputsReadSchema.parse(one(rows));
};

const readPage = async (
  transaction: RequestDatabaseTransaction,
  command: ProtectedQueryCommand,
  releaseRevision: number,
  inputValues: Readonly<Record<string, JsonValue>>,
  after: QueryContinuation | undefined,
) => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.run_module_query(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${JSON.stringify(command.requestedFieldIds)}::text::jsonb,
      ${command.pageSize}::integer,
      ${after === undefined ? null : JSON.stringify({ sortKey: after.sortKey, recordId: after.recordId })}::text::jsonb
    ) as result
  `;
  return pageReadSchema.parse(one(rows));
};

const runCommand = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: ProtectedQueryCommand,
  continuationKey: QueryContinuationKey,
): Promise<ProtectedQueryResult> => {
  const applicationRootId = scope.applicationRootId;
  if (applicationRootId === undefined) return refusal("request_invalid");

  // A continuation is accepted only for the same actor, installation, query,
  // release and inputs it was issued for.
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
      !sameId(after.queryId, command.queryId)
    )
      return refusal("cursor_stale");
  }

  const declared = await readInputs(transaction, command);
  if (declared.outcome === "refused") return refusal(declared.reasonCode);
  if (after !== undefined && after.moduleReleaseRevision !== declared.moduleReleaseRevision)
    return refusal("cursor_stale");
  const declarations = parseQueryInputDeclarations(declared.inputs);
  if (declarations === undefined) return refusal("descriptor_invalid");

  let inputValues: Readonly<Record<string, JsonValue>>;
  try {
    inputValues = validateQueryInputValues(declarations, command.inputValues);
  } catch (error) {
    if (error instanceof QueryInputRefusalError) return refusal("input_invalid");
    throw error;
  }
  const inputFingerprint = fingerprintQueryInputs(inputValues);
  if (after !== undefined && after.inputFingerprint !== inputFingerprint) return refusal("cursor_stale");

  const page = await readPage(
    transaction,
    command,
    declared.moduleReleaseRevision,
    inputValues,
    after,
  );
  if (page.outcome === "refused") return refusal(page.reasonCode);

  return {
    outcome: "completed",
    moduleRootId: command.moduleRootId,
    moduleReleaseVersion: page.moduleReleaseVersion,
    queryId: command.queryId,
    rows: page.rows,
    ...(page.next === null
      ? {}
      : {
          nextContinuationToken: encodeQueryContinuationToken(
            {
              version: 1,
              organizationId: scope.organizationId,
              applicationRootId,
              organizationAccountId: scope.organizationAccountId,
              moduleRootId: command.moduleRootId,
              queryId: command.queryId,
              moduleReleaseRevision: page.moduleReleaseRevision,
              inputFingerprint,
              sortKey: page.next.sortKey,
              recordId: page.next.recordId,
            },
            continuationKey,
          ),
        }),
  };
};

/**
 * Protected Query execution for one published Module query. The verified
 * request supplies the organisation, Application and actor; the database
 * resolves the query from the exact installed release, reads only rows the
 * record projection admits, and returns one bounded keyset page with an opaque
 * continuation, or one neutral refusal before any row is exposed.
 */
export const createProtectedQueryService = (dependencies: ProtectedQueryServiceDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const { continuationKey } = dependencies;

  return Object.freeze({
    async run(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ProtectedQueryResult>> {
      const command = protectedQueryCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "available", value: refusal("request_invalid") };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(session, selection, (transaction, scope) =>
        runCommand(transaction, scope, command.data, continuationKey),
      );
    },
  });
};
