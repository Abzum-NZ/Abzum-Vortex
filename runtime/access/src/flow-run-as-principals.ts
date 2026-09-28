import "server-only";

import { z } from "zod";
import {
  activityIdSchema,
  administrationDuplicateKeySchema,
  applicationRootIdSchema,
  containedComponentIdSchema,
  correlationIdSchema,
  databaseTimestamp,
  flowRunAsPrincipalActorSchema,
  flowRunAsPrincipalSchema,
  identityIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  ruleIdSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
} from "@vortex/contracts";
import type { FlowRunAsPrincipal } from "@vortex/contracts";
import type {
  DatabaseRow,
  RequestDatabaseTransaction,
  RuntimeDatabaseTransaction,
} from "@vortex/db";

const flowRunAsPrincipalScopeShape = {
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
  releaseVersion: stableDefinitionReleaseVersionSchema,
  flowId: ruleIdSchema,
} as const;

export const flowRunAsPrincipalAdministratorAuthoritySchema = z
  .object({
    identityId: identityIdSchema,
    organizationAccountId: organizationAccountIdSchema,
  })
  .strict();

/** Without an expected revision this registers revision 1; with one it replaces the current actor. */
export const registerFlowRunAsPrincipalCommandSchema = z
  .object({
    executionBindingId: containedComponentIdSchema,
    ...flowRunAsPrincipalScopeShape,
    actor: flowRunAsPrincipalActorSchema,
    expiresAt: timestampSchema.optional(),
    expectedRevision: revisionSchema.optional(),
    duplicateKey: administrationDuplicateKeySchema,
    activityId: activityIdSchema,
    authority: flowRunAsPrincipalAdministratorAuthoritySchema,
  })
  .strict();

/** Revokes one exact current principal at its next revision. */
export const revokeFlowRunAsPrincipalCommandSchema = z
  .object({
    executionBindingId: containedComponentIdSchema,
    organizationId: organizationIdSchema,
    expectedRevision: revisionSchema,
    duplicateKey: administrationDuplicateKeySchema,
    activityId: activityIdSchema,
    authority: flowRunAsPrincipalAdministratorAuthoritySchema,
  })
  .strict();

/** Runtime reads require the full compiled scope and never fall back to another revision or actor. */
export const readFlowRunAsPrincipalForRunCommandSchema = z
  .object({
    executionBindingId: containedComponentIdSchema,
    ...flowRunAsPrincipalScopeShape,
  })
  .strict();

export const flowRunAsPrincipalMutationResultSchema = z
  .object({
    outcome: z.enum(["accepted", "replayed"]),
    principal: flowRunAsPrincipalSchema,
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict();

export const flowRunAsPrincipalReadResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), principal: flowRunAsPrincipalSchema }).strict(),
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);

export type FlowRunAsPrincipalAdministratorAuthority = z.infer<
  typeof flowRunAsPrincipalAdministratorAuthoritySchema
>;
export type RegisterFlowRunAsPrincipalCommand = z.infer<
  typeof registerFlowRunAsPrincipalCommandSchema
>;
export type RevokeFlowRunAsPrincipalCommand = z.infer<
  typeof revokeFlowRunAsPrincipalCommandSchema
>;
export type ReadFlowRunAsPrincipalForRunCommand = z.infer<
  typeof readFlowRunAsPrincipalForRunCommandSchema
>;
export type FlowRunAsPrincipalMutationResult = z.infer<
  typeof flowRunAsPrincipalMutationResultSchema
>;
export type FlowRunAsPrincipalReadResult = z.infer<typeof flowRunAsPrincipalReadResultSchema>;

export const flowRunAsPrincipalErrorCodes = [
  "INVALID_FLOW_RUN_AS_PRINCIPAL_COMMAND",
  "INVALID_FLOW_RUN_AS_PRINCIPAL_STORAGE_RESULT",
  "FLOW_RUN_AS_PRINCIPAL_SCOPE_UNAVAILABLE",
  "FLOW_RUN_AS_PRINCIPAL_STALE_OR_UNAVAILABLE",
  "FLOW_RUN_AS_PRINCIPAL_DUPLICATE_CONFLICTS",
  "FLOW_RUN_AS_PRINCIPAL_ALREADY_EXISTS",
  "FLOW_RUN_AS_PRINCIPAL_OPERATION_FAILED",
] as const;

export type FlowRunAsPrincipalErrorCode = (typeof flowRunAsPrincipalErrorCodes)[number];

export class FlowRunAsPrincipalError extends Error {
  readonly code: FlowRunAsPrincipalErrorCode;

  constructor(code: FlowRunAsPrincipalErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "FlowRunAsPrincipalError";
    this.code = code;
  }
}

type MutationResultRow = DatabaseRow & {
  outcome: unknown;
  result: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};

type ReadResultRow = DatabaseRow & { outcome: unknown; result: unknown };

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapStorageFailure = (error: unknown): FlowRunAsPrincipalError => {
  const code = databaseCode(error);
  if (code === "22023")
    return new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_COMMAND", {
      cause: error,
    });
  if (code === "42501")
    return new FlowRunAsPrincipalError("FLOW_RUN_AS_PRINCIPAL_SCOPE_UNAVAILABLE", {
      cause: error,
    });
  if (code === "V3101" || code === "V3102" || code === "40001")
    return new FlowRunAsPrincipalError("FLOW_RUN_AS_PRINCIPAL_STALE_OR_UNAVAILABLE", {
      cause: error,
    });
  if (code === "V3001")
    return new FlowRunAsPrincipalError("FLOW_RUN_AS_PRINCIPAL_DUPLICATE_CONFLICTS", {
      cause: error,
    });
  if (code === "23505")
    return new FlowRunAsPrincipalError("FLOW_RUN_AS_PRINCIPAL_ALREADY_EXISTS", { cause: error });
  return new FlowRunAsPrincipalError("FLOW_RUN_AS_PRINCIPAL_OPERATION_FAILED", { cause: error });
};

const requireOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_STORAGE_RESULT");
  return rows[0];
};

const parsePrincipal = (value: unknown): FlowRunAsPrincipal => {
  const parsed = flowRunAsPrincipalSchema.safeParse(value);
  if (!parsed.success)
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_STORAGE_RESULT", {
      cause: parsed.error,
    });
  return parsed.data;
};

const parseMutation = (
  rows: readonly MutationResultRow[],
): FlowRunAsPrincipalMutationResult => {
  const row = requireOne(rows);
  const parsed = flowRunAsPrincipalMutationResultSchema.safeParse({
    outcome: row.outcome,
    principal: row.result,
    correlationId: row.correlation_id,
    acceptedAt: databaseTimestamp(row.accepted_at),
  });
  if (!parsed.success)
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_STORAGE_RESULT", {
      cause: parsed.error,
    });
  return parsed.data;
};

/**
 * Registers or replaces the exact compiled flow binding's Access-owned principal. Storage
 * re-establishes execution-grant administration authority and validates the target actor state.
 */
export const registerFlowRunAsPrincipal = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: RegisterFlowRunAsPrincipalCommand,
): Promise<FlowRunAsPrincipalMutationResult> => {
  const command = registerFlowRunAsPrincipalCommandSchema.safeParse(commandCandidate);
  if (!command.success)
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_COMMAND", {
      cause: command.error,
    });
  const value = command.data;
  try {
    const rows = await transaction.query<MutationResultRow>`
      select outcome, result, correlation_id, accepted_at
      from vortex_access.register_flow_run_as_principal(
        ${value.authority.identityId}::uuid,
        ${value.authority.organizationAccountId}::uuid,
        ${value.duplicateKey}::uuid,
        ${value.executionBindingId}::uuid,
        ${value.organizationId}::uuid,
        ${value.applicationRootId}::uuid,
        ${value.releaseVersion}::text,
        ${value.flowId}::uuid,
        ${value.actor.kind}::text,
        ${value.actor.kind === "specified_account" ? value.actor.organizationAccountId : null}::uuid,
        ${value.actor.kind === "system" ? value.actor.systemActorId : null}::uuid,
        ${value.expiresAt ?? null}::timestamptz,
        ${value.expectedRevision ?? null}::bigint,
        ${value.activityId}::uuid
      )
    `;
    return parseMutation(rows);
  } catch (error) {
    if (error instanceof FlowRunAsPrincipalError) throw error;
    throw mapStorageFailure(error);
  }
};

/** Revokes one exact current principal at its next revision. */
export const revokeFlowRunAsPrincipal = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: RevokeFlowRunAsPrincipalCommand,
): Promise<FlowRunAsPrincipalMutationResult> => {
  const command = revokeFlowRunAsPrincipalCommandSchema.safeParse(commandCandidate);
  if (!command.success)
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_COMMAND", {
      cause: command.error,
    });
  const value = command.data;
  try {
    const rows = await transaction.query<MutationResultRow>`
      select outcome, result, correlation_id, accepted_at
      from vortex_access.revoke_flow_run_as_principal(
        ${value.authority.identityId}::uuid,
        ${value.authority.organizationAccountId}::uuid,
        ${value.duplicateKey}::uuid,
        ${value.executionBindingId}::uuid,
        ${value.organizationId}::uuid,
        ${value.expectedRevision}::bigint,
        ${value.activityId}::uuid
      )
    `;
    return parseMutation(rows);
  } catch (error) {
    if (error instanceof FlowRunAsPrincipalError) throw error;
    throw mapStorageFailure(error);
  }
};

/**
 * Reads the active principal for one exact compiled scope. Revoked, expired or mismatched records
 * are unavailable.
 */
export const readFlowRunAsPrincipalForRun = async (
  transaction: RuntimeDatabaseTransaction,
  commandCandidate: ReadFlowRunAsPrincipalForRunCommand,
): Promise<FlowRunAsPrincipalReadResult> => {
  const command = readFlowRunAsPrincipalForRunCommandSchema.safeParse(commandCandidate);
  if (!command.success)
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_COMMAND", {
      cause: command.error,
    });
  const value = command.data;
  let rows: readonly ReadResultRow[];
  try {
    rows = await transaction.query<ReadResultRow>`
      select outcome, result
      from vortex_access.read_flow_run_as_principal_for_run(
        ${value.executionBindingId}::uuid,
        ${value.organizationId}::uuid,
        ${value.applicationRootId}::uuid,
        ${value.releaseVersion}::text,
        ${value.flowId}::uuid
      )
    `;
  } catch (error) {
    throw mapStorageFailure(error);
  }
  const row = requireOne(rows);
  if (row.outcome === "unavailable") return { outcome: "unavailable" };
  if (row.outcome !== "available")
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_STORAGE_RESULT");
  const parsed = flowRunAsPrincipalReadResultSchema.safeParse({
    outcome: "available",
    principal: parsePrincipal(row.result),
  });
  if (!parsed.success)
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_STORAGE_RESULT", {
      cause: parsed.error,
    });
  return parsed.data;
};
