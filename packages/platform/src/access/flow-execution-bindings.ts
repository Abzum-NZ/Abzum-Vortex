import "server-only";

import { z } from "zod";
import {
  applicationRootIdSchema,
  containedComponentIdSchema,
  identityIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  ruleIdSchema,
  workflowNodeIdSchema,
} from "../catalogue/identifiers";
import {
  flowExecutionBindingActorSchema,
  flowExecutionBindingEffectiveStateSchema,
  flowExecutionBindingSchema,
  protectedOperationReferenceSchema,
} from "../definition/application-flow-bindings";
import { stableDefinitionReleaseVersionSchema } from "../definition/version-impact";
import type { FlowExecutionBinding } from "../definition/application-flow-bindings";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";

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
export type ReadFlowExecutionBindingCommand = z.infer<typeof readFlowExecutionBindingCommandSchema>;
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

type ReadResultRow = DatabaseRow & {
  outcome: unknown;
  effective_state: unknown;
  result: unknown;
};

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

const ownerIdentity = (
  owner: FlowExecutionBinding["operation"]["owner"],
): Readonly<{ kind: string; id: string }> =>
  owner.kind === "application"
    ? { kind: owner.kind, id: owner.applicationRootId }
    : owner.kind === "module"
      ? { kind: owner.kind, id: owner.moduleRootId }
      : { kind: owner.kind, id: owner.serviceId };

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
