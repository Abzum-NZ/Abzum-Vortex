import "server-only";

import { z } from "zod";
import {
  activityIdSchema,
  administrationDuplicateKeySchema,
  applicationRootIdSchema,
  containedComponentIdSchema,
  correlationIdSchema,
  flowExecutionBindingActorSchema,
  flowExecutionBindingEffectiveStateSchema,
  flowExecutionBindingSchema,
  flowExecutionPermittedInputsSchema,
  flowExecutionPermittedInvokersSchema,
  flowExecutionPermittedSurfacesSchema,
  identityIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  protectedOperationReferenceSchema,
  refineFlowExecutionActorInvokers,
  revisionSchema,
  ruleIdSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
  workflowNodeIdSchema,
} from "@vortex/contracts";
import type { FlowExecutionBinding } from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

/**
 * One exact execution-authority grant for a published application flow node. A binding names the
 * organisation, application and exact release, the flow node and protected operation it applies
 * to, the actor the work runs as, who may invoke it, on which surfaces, which flow inputs are in
 * scope and an optional expiry. It is a grant, deliberately separate from an editable run-as
 * reference in a definition and from copied or installed content: registering it never happens as
 * a side effect of editing, installing, copying or delegating a role.
 *
 * Granting requires the administrator's current access-assignment permission together with
 * organisation-wide delegation authority; a bounded role-management delegation cannot create
 * execution authority.
 *
 * The binding carries no executable endpoint and performs no execution; #686 resolves the effective
 * actor from it at each protected node.
 */

/** The exact published scope a binding authorises. A binding never applies outside this tuple. */
const flowExecutionBindingScopeShape = {
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
  releaseVersion: stableDefinitionReleaseVersionSchema,
  flowId: ruleIdSchema,
  nodeId: workflowNodeIdSchema,
  operation: protectedOperationReferenceSchema,
  actor: flowExecutionBindingActorSchema,
} as const;

/**
 * Administrator authority is explicit and is re-established by the owning storage operation from
 * the protected request context; a caller cannot present an actor or organisation it does not hold.
 */
export const flowExecutionBindingAdministratorAuthoritySchema = z
  .object({
    identityId: identityIdSchema,
    organizationAccountId: organizationAccountIdSchema,
  })
  .strict();

/**
 * Without an expected revision, registers a new revision 1 binding. With one, replaces the mutable
 * bounds of that exact active binding at its next revision. The identity-defining scope
 * (organisation, application, release, flow node, operation and actor) is immutable across
 * revisions, so a replace can never re-point authority; changing the actor or target requires a
 * fresh binding identity.
 */
export const registerFlowExecutionBindingCommandSchema = z
  .object({
    executionBindingId: containedComponentIdSchema,
    ...flowExecutionBindingScopeShape,
    permittedInvokers: flowExecutionPermittedInvokersSchema,
    permittedSurfaces: flowExecutionPermittedSurfacesSchema,
    permittedInputs: flowExecutionPermittedInputsSchema,
    expiresAt: timestampSchema.optional(),
    expectedRevision: revisionSchema.optional(),
    duplicateKey: administrationDuplicateKeySchema,
    activityId: activityIdSchema,
    authority: flowExecutionBindingAdministratorAuthoritySchema,
  })
  .strict()
  .superRefine(refineFlowExecutionActorInvokers);

/**
 * Reads one exact binding by its identity and complete expected scope. Any mismatch between the
 * named scope and the stored binding returns no binding rather than a partial or fallback match.
 */
export const readFlowExecutionBindingCommandSchema = z
  .object({
    executionBindingId: containedComponentIdSchema,
    ...flowExecutionBindingScopeShape,
    authority: flowExecutionBindingAdministratorAuthoritySchema,
  })
  .strict();

/** Revokes one exact active binding at its next revision. Expiry is not required to revoke. */
export const revokeFlowExecutionBindingCommandSchema = z
  .object({
    executionBindingId: containedComponentIdSchema,
    organizationId: organizationIdSchema,
    expectedRevision: revisionSchema,
    duplicateKey: administrationDuplicateKeySchema,
    activityId: activityIdSchema,
    authority: flowExecutionBindingAdministratorAuthoritySchema,
  })
  .strict();

export const flowExecutionBindingMutationResultSchema = z
  .object({
    outcome: z.enum(["accepted", "replayed"]),
    binding: flowExecutionBindingSchema,
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict();

export const flowExecutionBindingReadResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      effectiveState: flowExecutionBindingEffectiveStateSchema,
      binding: flowExecutionBindingSchema,
    })
    .strict(),
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);

export type FlowExecutionBindingAdministratorAuthority = z.infer<
  typeof flowExecutionBindingAdministratorAuthoritySchema
>;
export type RegisterFlowExecutionBindingCommand = z.infer<
  typeof registerFlowExecutionBindingCommandSchema
>;
export type ReadFlowExecutionBindingCommand = z.infer<typeof readFlowExecutionBindingCommandSchema>;
export type RevokeFlowExecutionBindingCommand = z.infer<
  typeof revokeFlowExecutionBindingCommandSchema
>;
export type FlowExecutionBindingMutationResult = z.infer<
  typeof flowExecutionBindingMutationResultSchema
>;
export type FlowExecutionBindingReadResult = z.infer<typeof flowExecutionBindingReadResultSchema>;

export const flowExecutionBindingErrorCodes = [
  "INVALID_FLOW_EXECUTION_BINDING_COMMAND",
  "INVALID_FLOW_EXECUTION_BINDING_STORAGE_RESULT",
  "FLOW_EXECUTION_BINDING_SCOPE_UNAVAILABLE",
  "FLOW_EXECUTION_BINDING_STALE_OR_UNAVAILABLE",
  "FLOW_EXECUTION_BINDING_DUPLICATE_CONFLICTS",
  "FLOW_EXECUTION_BINDING_ALREADY_EXISTS",
  "FLOW_EXECUTION_BINDING_OPERATION_FAILED",
] as const;

export type FlowExecutionBindingErrorCode = (typeof flowExecutionBindingErrorCodes)[number];

export class FlowExecutionBindingError extends Error {
  readonly code: FlowExecutionBindingErrorCode;

  constructor(code: FlowExecutionBindingErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "FlowExecutionBindingError";
    this.code = code;
  }
}

type MutationResultRow = DatabaseRow & {
  outcome: unknown;
  result: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};

type ReadResultRow = DatabaseRow & {
  outcome: unknown;
  effective_state: unknown;
  result: unknown;
};

const timestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapStorageFailure = (error: unknown): FlowExecutionBindingError => {
  const code = databaseCode(error);
  if (code === "22023")
    return new FlowExecutionBindingError("INVALID_FLOW_EXECUTION_BINDING_COMMAND", {
      cause: error,
    });
  if (code === "42501")
    return new FlowExecutionBindingError("FLOW_EXECUTION_BINDING_SCOPE_UNAVAILABLE", {
      cause: error,
    });
  if (code === "V3101" || code === "V3102" || code === "40001")
    return new FlowExecutionBindingError("FLOW_EXECUTION_BINDING_STALE_OR_UNAVAILABLE", {
      cause: error,
    });
  if (code === "V3001")
    return new FlowExecutionBindingError("FLOW_EXECUTION_BINDING_DUPLICATE_CONFLICTS", {
      cause: error,
    });
  if (code === "23505")
    return new FlowExecutionBindingError("FLOW_EXECUTION_BINDING_ALREADY_EXISTS", { cause: error });
  return new FlowExecutionBindingError("FLOW_EXECUTION_BINDING_OPERATION_FAILED", { cause: error });
};

const requireOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new FlowExecutionBindingError("INVALID_FLOW_EXECUTION_BINDING_STORAGE_RESULT");
  return rows[0];
};

const parseBinding = (value: unknown): FlowExecutionBinding => {
  const parsed = flowExecutionBindingSchema.safeParse(value);
  if (!parsed.success)
    throw new FlowExecutionBindingError("INVALID_FLOW_EXECUTION_BINDING_STORAGE_RESULT", {
      cause: parsed.error,
    });
  return parsed.data;
};

const parseMutation = (
  rows: readonly MutationResultRow[],
): FlowExecutionBindingMutationResult => {
  const row = requireOne(rows);
  const parsed = flowExecutionBindingMutationResultSchema.safeParse({
    outcome: row.outcome,
    binding: row.result,
    correlationId: row.correlation_id,
    acceptedAt: timestamp(row.accepted_at),
  });
  if (!parsed.success)
    throw new FlowExecutionBindingError("INVALID_FLOW_EXECUTION_BINDING_STORAGE_RESULT", {
      cause: parsed.error,
    });
  return parsed.data;
};

const ownerIdentity = (
  owner: FlowExecutionBinding["operation"]["owner"],
): Readonly<{ kind: string; id: string }> =>
  owner.kind === "application"
    ? { kind: owner.kind, id: owner.applicationRootId }
    : owner.kind === "module"
      ? { kind: owner.kind, id: owner.moduleRootId }
      : { kind: owner.kind, id: owner.serviceId };

/**
 * Registers or replaces one protected execution-authority binding. The owning storage operation
 * re-establishes the administrator's current assignment permission and organisation-wide
 * delegation authority, requires the effective person and named invokers to be active accounts of
 * the organisation, and fails closed on a stale expected revision, an already-authorised scope, or
 * an attempt to revive a revoked binding.
 */
export const registerFlowExecutionBinding = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: RegisterFlowExecutionBindingCommand,
): Promise<FlowExecutionBindingMutationResult> => {
  const command = registerFlowExecutionBindingCommandSchema.safeParse(commandCandidate);
  if (!command.success)
    throw new FlowExecutionBindingError("INVALID_FLOW_EXECUTION_BINDING_COMMAND", {
      cause: command.error,
    });
  const value = command.data;
  const owner = ownerIdentity(value.operation.owner);
  try {
    const rows = await transaction.query<MutationResultRow>`
      select outcome, result, correlation_id, accepted_at
      from vortex_access.register_flow_execution_binding(
        ${value.authority.identityId}::uuid,
        ${value.authority.organizationAccountId}::uuid,
        ${value.duplicateKey}::uuid,
        ${value.executionBindingId}::uuid,
        ${value.organizationId}::uuid,
        ${value.applicationRootId}::uuid,
        ${value.releaseVersion}::text,
        ${value.flowId}::uuid,
        ${value.nodeId}::uuid,
        ${owner.kind}::text,
        ${owner.id}::uuid,
        ${value.operation.operationId}::uuid,
        ${value.actor.kind}::text,
        ${value.actor.kind === "specified_user" ? value.actor.organizationAccountId : null}::uuid,
        ${value.actor.kind === "system" ? value.actor.systemActorId : null}::uuid,
        ${JSON.stringify(value.permittedInvokers)}::text::jsonb,
        ${JSON.stringify(value.permittedSurfaces)}::text::jsonb,
        ${JSON.stringify(value.permittedInputs)}::text::jsonb,
        ${value.expiresAt ?? null}::timestamptz,
        ${value.expectedRevision ?? null}::bigint,
        ${value.activityId}::uuid
      )
    `;
    return parseMutation(rows);
  } catch (error) {
    if (error instanceof FlowExecutionBindingError) throw error;
    throw mapStorageFailure(error);
  }
};

/**
 * Revokes one exact active binding at its next revision. The revoked revision remains readable so
 * audit and later consumers can see the revocation, but no active authority remains.
 */
export const revokeFlowExecutionBinding = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: RevokeFlowExecutionBindingCommand,
): Promise<FlowExecutionBindingMutationResult> => {
  const command = revokeFlowExecutionBindingCommandSchema.safeParse(commandCandidate);
  if (!command.success)
    throw new FlowExecutionBindingError("INVALID_FLOW_EXECUTION_BINDING_COMMAND", {
      cause: command.error,
    });
  const value = command.data;
  try {
    const rows = await transaction.query<MutationResultRow>`
      select outcome, result, correlation_id, accepted_at
      from vortex_access.revoke_flow_execution_binding(
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
    if (error instanceof FlowExecutionBindingError) throw error;
    throw mapStorageFailure(error);
  }
};

/**
 * Reads one exact binding only when the complete named scope matches the stored binding. A revoked
 * or expired binding is reported with its effective state; a scope mismatch or missing binding
 * reports `unavailable` and never a partial or fallback authority.
 */
export const readFlowExecutionBinding = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: ReadFlowExecutionBindingCommand,
): Promise<FlowExecutionBindingReadResult> => {
  const command = readFlowExecutionBindingCommandSchema.safeParse(commandCandidate);
  if (!command.success)
    throw new FlowExecutionBindingError("INVALID_FLOW_EXECUTION_BINDING_COMMAND", {
      cause: command.error,
    });
  const value = command.data;
  const owner = ownerIdentity(value.operation.owner);
  let rows: readonly ReadResultRow[];
  try {
    rows = await transaction.query<ReadResultRow>`
      select outcome, effective_state, result
      from vortex_access.read_flow_execution_binding(
        ${value.authority.identityId}::uuid,
        ${value.authority.organizationAccountId}::uuid,
        ${value.executionBindingId}::uuid,
        ${value.organizationId}::uuid,
        ${value.applicationRootId}::uuid,
        ${value.releaseVersion}::text,
        ${value.flowId}::uuid,
        ${value.nodeId}::uuid,
        ${owner.kind}::text,
        ${owner.id}::uuid,
        ${value.operation.operationId}::uuid,
        ${value.actor.kind}::text,
        ${value.actor.kind === "specified_user" ? value.actor.organizationAccountId : null}::uuid,
        ${value.actor.kind === "system" ? value.actor.systemActorId : null}::uuid
      )
    `;
  } catch (error) {
    if (error instanceof FlowExecutionBindingError) throw error;
    throw mapStorageFailure(error);
  }
  const row = requireOne(rows);
  if (row.outcome === "unavailable") return { outcome: "unavailable" };
  const parsed = flowExecutionBindingReadResultSchema.safeParse({
    outcome: "available",
    effectiveState: row.effective_state,
    binding: parseBinding(row.result),
  });
  if (!parsed.success)
    throw new FlowExecutionBindingError("INVALID_FLOW_EXECUTION_BINDING_STORAGE_RESULT", {
      cause: parsed.error,
    });
  return parsed.data;
};
