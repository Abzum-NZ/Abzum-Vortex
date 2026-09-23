import "server-only";

import { z } from "zod";
import {
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  correlationIdSchema,
  flowExecutionBindingSurfaceSchema,
  flowNodeRunAsSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  protectedOperationDescriptorSchema,
  protectedOperationReferenceSchema,
  revisionSchema,
  ruleIdSchema,
  sessionContextSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
  workflowNodeIdSchema,
  type CorrelationId,
  type SessionContext,
} from "@vortex/contracts";
import {
  withResolvedRequestTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
  type ResolvedRequestContext,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";
import {
  flowExecutionBindingReadResultSchema,
  type FlowExecutionBindingReadResult,
} from "./flow-execution-bindings";

/**
 * #686 resolves one purpose-bound effective actor for a protected flow node, or refuses.
 *
 * A published Frontend Flow node declares a `runAs` choice. `current_user` always means the
 * original verified initiator, never the actor of the preceding overridden node. `specified_user`
 * and `system` additionally require one exact, currently active Access-owned execution-authority
 * binding (#685) that names this organisation, application release, flow, node, protected
 * operation and effective actor, plus who may invoke it, on which surface, with which inputs.
 *
 * Resolution happens before every protected node. It re-checks the invoker, the binding's current
 * revision, state and expiry, the exact actor and operation scope, the surface and declared input
 * bounds, and non-delegable restrictions. A revoked, expired, disabled, wrong-scope or
 * unavailable actor refuses without fallback. `system` is represented by its registered system
 * actor, never by a database service-role credential. Delegation never borrows the initiator's
 * human-only approval or recent-authentication evidence.
 *
 * `openFlowEffectiveActorTransaction` repeats every check inside the fresh short transaction from
 * the binding and actor state Access reads there, so a revocation, replacement, expiry or actor
 * lifecycle change between planning and use refuses rather than running on an earlier read.
 *
 * Viewer-safe result handoff remains #687; this module does not execute the node, project its
 * result, or create a durable authority of its own.
 */

const inputKeyListSchema = z.array(builderKeySchema).max(500);

/** The run actor of the node immediately preceding this one in the same run, before resolution. */
export const flowEffectiveActorRunActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current_user") }).strict(),
  z
    .object({
      kind: z.literal("specified_user"),
      organizationAccountId: organizationAccountIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("system"), systemActorId: actorIdSchema }).strict(),
]);

/**
 * The exact node request. `operation` is the trusted, server-resolved published declaration for
 * the node's target: its owner, identity, permission, effect and confirmation are never supplied
 * by a caller. `inputKeys` names only the declared input bindings this node supplies.
 */
export const flowEffectiveActorNodeRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    flowId: ruleIdSchema,
    nodeId: workflowNodeIdSchema,
    operation: protectedOperationDescriptorSchema,
    runAs: flowNodeRunAsSchema,
    surface: flowExecutionBindingSurfaceSchema,
    inputKeys: inputKeyListSchema.default([]),
  })
  .strict();

/**
 * The effective actor's current lifecycle at use. For a specified person it is the organisation
 * account's state; for a system actor `active` means a registered, enabled system actor. Anything
 * other than a confirmed `active` refuses.
 */
export const flowEffectiveActorStateSchema = z.enum(["active", "suspended", "closed"]);

/**
 * The trusted per-use inputs the owning flow runtime already resolved: the verified initiator
 * context, the run actor of the preceding node (absent at the flow start), the exact node request,
 * the active #685 binding read result for a delegated node, and the effective actor's current
 * lifecycle state. None of these come from the browser; the transaction path re-reads the binding
 * and actor state inside the fresh transaction rather than trusting this planning read.
 */
export const flowEffectiveActorRequestSchema = z
  .object({
    initiator: sessionContextSchema,
    currentActor: flowEffectiveActorRunActorSchema.optional(),
    node: flowEffectiveActorNodeRequestSchema,
    binding: flowExecutionBindingReadResultSchema.optional(),
    /** The revision the run already holds for this binding; a stale value refuses. */
    expectedBindingRevision: revisionSchema.optional(),
    /** The effective actor's resolved state; anything but a confirmed `active` refuses. */
    effectiveActorState: flowEffectiveActorStateSchema.optional(),
  })
  .strict();

export const flowEffectiveActorRefusalReasonSchema = z.enum([
  "malformed_request",
  "initiator_unavailable",
  "current_user_unavailable",
  "binding_required",
  "binding_unavailable",
  "binding_revoked",
  "binding_expired",
  "binding_scope_mismatch",
  "binding_revision_mismatch",
  "invoker_not_permitted",
  "surface_not_permitted",
  "input_not_permitted",
  "operation_non_delegable",
  "actor_kind_mismatch",
  "actor_unavailable",
]);

/** The exact published purpose the effective actor is bound to. */
export const flowEffectiveActorPurposeSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    flowId: ruleIdSchema,
    nodeId: workflowNodeIdSchema,
    operation: protectedOperationReferenceSchema,
    surface: flowExecutionBindingSurfaceSchema,
  })
  .strict();

/**
 * The purpose-bound effective actor. `current_user` carries the initiator's own closed request
 * context. `specified_user` and `system` name only the exact identity; trusted wiring resolves its
 * complete closed context inside a fresh short transaction and never reuses the initiator's.
 */
export const flowEffectiveActorIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("current_user"), sessionContext: sessionContextSchema })
    .strict(),
  z
    .object({
      kind: z.literal("specified_user"),
      organizationId: organizationIdSchema,
      organizationAccountId: organizationAccountIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("system"),
      organizationId: organizationIdSchema,
      systemActorId: actorIdSchema,
    })
    .strict(),
]);

const flowEffectiveActorInitiatorIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("organization_account"),
      organizationAccountId: organizationAccountIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("system"), systemActorId: actorIdSchema }).strict(),
]);

/**
 * Content-free evidence of the separate execution-delegation use, recorded under the initiator's
 * account with the same correlation identifier. It carries no role, record or field data.
 */
export const flowEffectiveActorDelegationUseSchema = z
  .object({
    initiator: flowEffectiveActorInitiatorIdentitySchema,
    correlationId: correlationIdSchema,
    purpose: flowEffectiveActorPurposeSchema,
  })
  .strict();

const flowEffectiveActorBindingEvidenceSchema = z
  .object({
    executionBindingId: containedComponentIdSchema,
    revision: revisionSchema,
    recordedAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
  })
  .strict();

const flowEffectiveActorActivityAttributionSchema = z
  .object({
    actorKind: z.enum(["organization_account", "system"]),
    actorId: z.string().min(1),
  })
  .strict();

const flowEffectiveActorResolutionCommon = {
  effectiveActor: flowEffectiveActorIdentitySchema,
  purpose: flowEffectiveActorPurposeSchema,
  initiator: flowEffectiveActorInitiatorIdentitySchema,
  correlationId: correlationIdSchema,
  activity: flowEffectiveActorActivityAttributionSchema,
  requiresFreshTransaction: z.boolean(),
  permittedInputs: inputKeyListSchema,
} as const;

export const flowEffectiveActorResolutionSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("effective"),
      ...flowEffectiveActorResolutionCommon,
      executionBinding: flowEffectiveActorBindingEvidenceSchema.optional(),
      delegationUse: flowEffectiveActorDelegationUseSchema.optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reasonCode: flowEffectiveActorRefusalReasonSchema,
      correlationId: correlationIdSchema,
      purpose: flowEffectiveActorPurposeSchema.optional(),
    })
    .strict(),
]);

export type FlowEffectiveActorRunActor = z.infer<typeof flowEffectiveActorRunActorSchema>;
export type FlowEffectiveActorNodeRequest = z.infer<typeof flowEffectiveActorNodeRequestSchema>;
export type FlowEffectiveActorRequest = z.input<typeof flowEffectiveActorRequestSchema>;
export type FlowEffectiveActorState = z.infer<typeof flowEffectiveActorStateSchema>;
export type FlowEffectiveActorRefusalReason = z.infer<
  typeof flowEffectiveActorRefusalReasonSchema
>;
export type FlowEffectiveActorPurpose = z.infer<typeof flowEffectiveActorPurposeSchema>;
export type FlowEffectiveActorIdentity = z.infer<typeof flowEffectiveActorIdentitySchema>;
export type FlowEffectiveActorDelegationUse = z.infer<typeof flowEffectiveActorDelegationUseSchema>;
export type FlowEffectiveActorResolution = z.infer<typeof flowEffectiveActorResolutionSchema>;

export type FlowEffectiveActorDependencies = Readonly<{ clock?: () => Date }>;

/** A stable, non-nil correlation identifier for a request too malformed to carry its own. */
const FALLBACK_CORRELATION_ID: CorrelationId = correlationIdSchema.parse(
  "00000000-0000-4000-8000-000000000001",
);

const correlationIdFrom = (candidate: unknown): CorrelationId => {
  const extracted = z
    .object({ initiator: z.object({ correlationId: correlationIdSchema }) })
    .safeParse(candidate);
  return extracted.success ? extracted.data.initiator.correlationId : FALLBACK_CORRELATION_ID;
};

const ownerId = (owner: FlowEffectiveActorPurpose["operation"]["owner"]): string =>
  owner.kind === "application"
    ? owner.applicationRootId
    : owner.kind === "module"
      ? owner.moduleRootId
      : owner.serviceId;

/** One canonical identity for an exact protected operation: owner kind, owner identity and id. */
const operationReferenceKey = (reference: FlowEffectiveActorPurpose["operation"]): string =>
  `${reference.owner.kind}:${ownerId(reference.owner).toLowerCase()}:${reference.operationId.toLowerCase()}`;

const sameId = (left: string | undefined, right: string | undefined): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.toLowerCase() === right.toLowerCase();

const purposeOf = (node: FlowEffectiveActorNodeRequest): FlowEffectiveActorPurpose => ({
  organizationId: node.organizationId,
  applicationRootId: node.applicationRootId,
  releaseVersion: node.releaseVersion,
  flowId: node.flowId,
  nodeId: node.nodeId,
  operation: node.operation.operation,
  surface: node.surface,
});

const initiatorIdentityOf = (
  initiator: SessionContext,
): FlowEffectiveActorDelegationUse["initiator"] | undefined => {
  if (initiator.callerKind === "system")
    return { kind: "system", systemActorId: initiator.systemActorId };
  if (initiator.callerKind === "human" || initiator.callerKind === "federated")
    return { kind: "organization_account", organizationAccountId: initiator.organizationAccountId };
  return undefined;
};

/**
 * Whether the effective actor's own closed context must be established in a fresh, separately
 * Access-resolved short transaction. Every delegated node does: each execution binding is exact to
 * one node, so its authority is never inherited from a preceding transaction, even one that ran as
 * the same actor. `current_user` needs one only when the run's preceding protected node ran under
 * another actor; the first node of a run already runs in the initiator's own transaction.
 */
const currentUserNeedsFreshTransaction = (
  currentActor: FlowEffectiveActorRunActor | undefined,
): boolean => currentActor !== undefined && currentActor.kind !== "current_user";

/**
 * Resolves one purpose-bound effective actor for a protected flow node, or a safe refusal. The
 * function is total and side-effect free: malformed input, a missing or stale binding, a
 * non-permitted invoker, surface or input, a non-delegable operation, a mismatched actor kind, or
 * an unavailable actor always returns a refusal and never a fallback actor.
 */
export const resolveFlowEffectiveActor = (
  requestCandidate: FlowEffectiveActorRequest,
  dependencies: FlowEffectiveActorDependencies = {},
): FlowEffectiveActorResolution => {
  const parsed = flowEffectiveActorRequestSchema.safeParse(requestCandidate);
  if (!parsed.success)
    return {
      outcome: "refused",
      reasonCode: "malformed_request",
      correlationId: correlationIdFrom(requestCandidate),
    };

  const { initiator, node, binding, currentActor, expectedBindingRevision, effectiveActorState } =
    parsed.data;
  const purpose = purposeOf(node);
  const refuse = (reasonCode: FlowEffectiveActorRefusalReason): FlowEffectiveActorResolution => ({
    outcome: "refused",
    reasonCode,
    correlationId: initiator.correlationId,
    purpose,
  });

  const now = (dependencies.clock ?? (() => new Date()))().valueOf();
  if (!Number.isFinite(now)) return refuse("malformed_request");
  if (Date.parse(initiator.expiresAt) <= now) return refuse("initiator_unavailable");

  const initiatorIdentity = initiatorIdentityOf(initiator);
  if (initiatorIdentity === undefined) return refuse("initiator_unavailable");
  if (
    !sameId(initiator.organizationId, node.organizationId) ||
    (initiator.applicationRootId !== undefined &&
      !sameId(initiator.applicationRootId, node.applicationRootId))
  )
    return refuse("invoker_not_permitted");
  // A node supplies only inputs its published operation declares.
  if (node.inputKeys.some((key) => !Object.hasOwn(node.operation.inputs, key)))
    return refuse("input_not_permitted");

  // The original initiator is always the current user; never the preceding overridden actor. A
  // system-started flow has no human initiator, so Current user cannot invent one.
  if (node.runAs.kind === "current_user") {
    if (initiatorIdentity.kind !== "organization_account")
      return refuse("current_user_unavailable");
    return {
      outcome: "effective",
      effectiveActor: { kind: "current_user", sessionContext: initiator },
      purpose,
      initiator: initiatorIdentity,
      correlationId: initiator.correlationId,
      activity: {
        actorKind: "organization_account",
        actorId: initiatorIdentity.organizationAccountId,
      },
      requiresFreshTransaction: currentUserNeedsFreshTransaction(currentActor),
      permittedInputs: [...node.inputKeys],
    };
  }

  // Execution delegation is invoked by the verified person or system origin itself. A context that
  // is already borrowed through role-management delegation or support access cannot stack another
  // identity's authority on top of it.
  if (
    initiator.callerKind === "human" &&
    (initiator.delegatedContext !== undefined || initiator.supportContext !== undefined)
  )
    return refuse("invoker_not_permitted");
  if (initiator.callerKind === "system" && initiator.supportContext !== undefined)
    return refuse("invoker_not_permitted");

  if (binding === undefined) return refuse("binding_required");
  if (binding.outcome !== "available") return refuse("binding_unavailable");
  if (binding.effectiveState === "revoked") return refuse("binding_revoked");
  if (binding.effectiveState === "expired") return refuse("binding_expired");
  const stored = binding.binding;
  if (stored.expiresAt !== undefined && Date.parse(stored.expiresAt) <= now)
    return refuse("binding_expired");
  if (stored.state !== "active") return refuse("binding_revoked");
  if (!sameId(stored.executionBindingId, node.runAs.executionBindingId))
    return refuse("binding_scope_mismatch");
  if (expectedBindingRevision !== undefined && stored.revision !== expectedBindingRevision)
    return refuse("binding_revision_mismatch");

  if (
    !sameId(stored.organizationId, node.organizationId) ||
    !sameId(stored.applicationRootId, node.applicationRootId) ||
    stored.releaseVersion !== node.releaseVersion ||
    !sameId(stored.flowId, node.flowId) ||
    !sameId(stored.nodeId, node.nodeId) ||
    operationReferenceKey(stored.operation) !== operationReferenceKey(node.operation.operation)
  )
    return refuse("binding_scope_mismatch");

  if (stored.actor.kind !== node.runAs.kind) return refuse("actor_kind_mismatch");
  // Both a specified person and a registered system actor must be confirmed active at use; an
  // unknown state is unavailable, never an implicit pass.
  if (effectiveActorState !== "active") return refuse("actor_unavailable");

  // A human-only approval (a required confirmation) is never satisfied by delegated execution.
  if (node.operation.confirmation === "required") return refuse("operation_non_delegable");

  if (!stored.permittedSurfaces.includes(node.surface)) return refuse("surface_not_permitted");
  if (node.inputKeys.some((key) => !stored.permittedInputs.includes(key)))
    return refuse("input_not_permitted");

  const permittedInvoker =
    initiatorIdentity.kind === "system"
      ? stored.permittedInvokers.some((invoker) => invoker.kind === "system")
      : stored.permittedInvokers.some(
          (invoker) =>
            invoker.kind === "organization_account" &&
            sameId(invoker.organizationAccountId, initiatorIdentity.organizationAccountId),
        );
  if (!permittedInvoker) return refuse("invoker_not_permitted");

  const effectiveActor: FlowEffectiveActorIdentity =
    stored.actor.kind === "specified_user"
      ? {
          kind: "specified_user",
          organizationId: stored.organizationId,
          organizationAccountId: stored.actor.organizationAccountId,
        }
      : {
          kind: "system",
          organizationId: stored.organizationId,
          systemActorId: stored.actor.systemActorId,
        };

  const activity =
    effectiveActor.kind === "specified_user"
      ? { actorKind: "organization_account" as const, actorId: effectiveActor.organizationAccountId }
      : { actorKind: "system" as const, actorId: effectiveActor.systemActorId };

  // A system-started flow has no human initiator; it needs no initiator delegation-use entry.
  const delegationUse: FlowEffectiveActorDelegationUse | undefined =
    initiatorIdentity.kind === "organization_account"
      ? { initiator: initiatorIdentity, correlationId: initiator.correlationId, purpose }
      : undefined;

  return {
    outcome: "effective",
    effectiveActor,
    purpose,
    initiator: initiatorIdentity,
    correlationId: initiator.correlationId,
    activity,
    requiresFreshTransaction: true,
    permittedInputs: [...node.inputKeys],
    executionBinding: {
      executionBindingId: stored.executionBindingId,
      revision: stored.revision,
      recordedAt: stored.recordedAt,
      ...(stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt }),
    },
    ...(delegationUse === undefined ? {} : { delegationUse }),
  };
};

export const flowEffectiveActorErrorCodes = [
  "FLOW_EFFECTIVE_ACTOR_REFUSED",
  "FLOW_EFFECTIVE_ACTOR_TRANSACTION_NOT_REQUIRED",
  "FLOW_EFFECTIVE_ACTOR_CONTEXT_MISMATCH",
] as const;

export type FlowEffectiveActorErrorCode = (typeof flowEffectiveActorErrorCodes)[number];

export class FlowEffectiveActorError extends Error {
  readonly code: FlowEffectiveActorErrorCode;

  constructor(code: FlowEffectiveActorErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "FlowEffectiveActorError";
    this.code = code;
  }
}

export type FlowEffectiveActorEffectiveResolution = Extract<
  FlowEffectiveActorResolution,
  { outcome: "effective" }
>;

/** The execution binding and effective-actor lifecycle Access reads inside the fresh transaction. */
export type FlowEffectiveActorCurrentAuthority = Readonly<{
  binding: FlowExecutionBindingReadResult;
  effectiveActorState: FlowEffectiveActorState;
}>;

/**
 * Trusted Access wiring reads the node's current execution binding and the effective actor's
 * current lifecycle inside the fresh transaction, from storage and never from the run's earlier
 * read. It must hold the binding row for the rest of that short transaction (a share lock), so a
 * concurrent revoke or replace either commits first and is seen here or waits for this use.
 */
export type FlowEffectiveActorAuthorityReader = (
  transaction: RuntimeDatabaseTransaction,
  resolution: FlowEffectiveActorEffectiveResolution,
) => Promise<FlowEffectiveActorCurrentAuthority>;

type CurrentAuthorityRow = DatabaseRow & {
  outcome: unknown;
  effective_state: unknown;
  actor_state: unknown;
  result: unknown;
};

/**
 * Reads the delegated node's current binding and effective-actor lifecycle from storage inside the
 * fresh transaction, for an ordinary flow invoker: it needs no administrator permission because the
 * storage function is runtime-only and matches the exact scope the planned resolution names. The
 * binding row (and the effective person's account row) is share-locked until the transaction ends,
 * so a concurrent revoke, replace or suspension commits first and is seen here, or waits for this
 * use. Anything unavailable, malformed or unconfirmed refuses; there is no fallback authority.
 */
export const readFlowEffectiveActorCurrentAuthority: FlowEffectiveActorAuthorityReader = async (
  transaction,
  resolution,
) => {
  const bindingId = resolution.executionBinding?.executionBindingId;
  const actor = resolution.effectiveActor;
  if (bindingId === undefined || actor.kind === "current_user")
    throw new FlowEffectiveActorError("FLOW_EFFECTIVE_ACTOR_REFUSED");
  const { purpose } = resolution;
  const owner = purpose.operation.owner;
  const ownerKind = owner.kind;
  const ownerIdentity = ownerId(owner);
  let rows: readonly CurrentAuthorityRow[];
  try {
    rows = await transaction.query<CurrentAuthorityRow>`
      select outcome, effective_state, actor_state, result
      from vortex_access.read_flow_execution_binding_for_run(
        ${bindingId}::uuid,
        ${purpose.organizationId}::uuid,
        ${purpose.applicationRootId}::uuid,
        ${purpose.releaseVersion}::text,
        ${purpose.flowId}::uuid,
        ${purpose.nodeId}::uuid,
        ${ownerKind}::text,
        ${ownerIdentity}::uuid,
        ${purpose.operation.operationId}::uuid,
        ${actor.kind}::text,
        ${actor.kind === "specified_user" ? actor.organizationAccountId : null}::uuid,
        ${actor.kind === "system" ? actor.systemActorId : null}::uuid
      )
    `;
  } catch (error) {
    throw new FlowEffectiveActorError("FLOW_EFFECTIVE_ACTOR_REFUSED", { cause: error });
  }
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === undefined) throw new FlowEffectiveActorError("FLOW_EFFECTIVE_ACTOR_REFUSED");
  if (row.outcome === "unavailable") {
    // No exact current binding: report it unavailable so the resolver refuses with its own reason.
    return { binding: { outcome: "unavailable" }, effectiveActorState: "closed" };
  }
  const binding = flowExecutionBindingReadResultSchema.safeParse({
    outcome: "available",
    effectiveState: row.effective_state,
    binding: row.result,
  });
  const actorState = flowEffectiveActorStateSchema.safeParse(row.actor_state);
  if (!binding.success || !actorState.success)
    throw new FlowEffectiveActorError("FLOW_EFFECTIVE_ACTOR_REFUSED");
  return { binding: binding.data, effectiveActorState: actorState.data };
};

/**
 * Trusted wiring resolves the effective actor's complete closed organisation scope inside the new
 * transaction. It must derive the identity from the actor reference and the database, never from a
 * caller-supplied context; a system actor is established as its registered system actor, never as
 * a database service role, and a specified person's context carries no authentication evidence.
 */
export type FlowEffectiveActorScopeResolver<Scope> = (
  transaction: RuntimeDatabaseTransaction,
  actor: FlowEffectiveActorIdentity,
) => Promise<ResolvedRequestContext<Scope>>;

export type FlowEffectiveActorTransactionRunner = <Scope, Result>(
  resolve: (transaction: RuntimeDatabaseTransaction) => Promise<ResolvedRequestContext<Scope>>,
  operation: (transaction: RequestDatabaseTransaction, scope: Scope) => Promise<Result>,
) => Promise<Result>;

export type FlowEffectiveActorTransactionAccess<Scope> = Readonly<{
  readCurrentAuthority: FlowEffectiveActorAuthorityReader;
  resolveScope: FlowEffectiveActorScopeResolver<Scope>;
}>;

export type FlowEffectiveActorTransactionDependencies = Readonly<{
  clock?: () => Date;
  runner?: FlowEffectiveActorTransactionRunner;
}>;

/** The planned and current resolutions name the same actor under the same binding revision. */
const sameResolvedActor = (
  planned: FlowEffectiveActorEffectiveResolution,
  current: FlowEffectiveActorEffectiveResolution,
): boolean => {
  const left = planned.effectiveActor;
  const right = current.effectiveActor;
  const sameBinding =
    sameId(
      planned.executionBinding?.executionBindingId,
      current.executionBinding?.executionBindingId,
    ) && planned.executionBinding?.revision === current.executionBinding?.revision;
  if (left.kind === "specified_user" && right.kind === "specified_user")
    return sameBinding && sameId(left.organizationAccountId, right.organizationAccountId);
  if (left.kind === "system" && right.kind === "system")
    return sameBinding && sameId(left.systemActorId, right.systemActorId);
  return left.kind === "current_user" && right.kind === "current_user";
};

/**
 * The context Access resolved for the fresh transaction must be exactly the purpose-bound
 * effective actor, in the purpose's organisation and application, carrying the run's correlation.
 * A delegated person's context never carries borrowed authentication, delegation or support
 * evidence; the current user's context is the original initiator's own account.
 */
const contextRepresents = (
  context: SessionContext,
  resolution: FlowEffectiveActorEffectiveResolution,
  initiator: SessionContext,
): boolean => {
  if (
    !sameId(context.organizationId, resolution.purpose.organizationId) ||
    (context.applicationRootId !== undefined &&
      !sameId(context.applicationRootId, resolution.purpose.applicationRootId)) ||
    !sameId(context.correlationId, resolution.correlationId)
  )
    return false;
  const actor = resolution.effectiveActor;
  if (actor.kind === "system")
    return (
      context.callerKind === "system" &&
      context.supportContext === undefined &&
      sameId(context.systemActorId, actor.systemActorId)
    );
  if (actor.kind === "specified_user")
    return (
      context.callerKind === "human" &&
      sameId(context.organizationAccountId, actor.organizationAccountId) &&
      context.authenticationStrength !== "recent_multi_factor" &&
      context.accessTokenIssuedAt === undefined &&
      context.primaryAuthenticatedAt === undefined &&
      context.multiFactorAuthenticatedAt === undefined &&
      context.delegatedContext === undefined &&
      context.supportContext === undefined
    );
  return (
    (context.callerKind === "human" || context.callerKind === "federated") &&
    (initiator.callerKind === "human" || initiator.callerKind === "federated") &&
    context.callerKind === initiator.callerKind &&
    sameId(context.identityId, initiator.identityId) &&
    sameId(context.organizationAccountId, initiator.organizationAccountId)
  );
};

/**
 * Establishes the fresh, short Access-resolved transaction for the effective actor of one
 * protected node and runs its protected operation inside it. It refuses to reuse an existing
 * transaction: the request must resolve with `requiresFreshTransaction`, so an identity-changing
 * node can never mutate or upgrade the preceding human transaction.
 *
 * Inside the new transaction, and before the operation runs, a delegated node's binding and
 * effective actor are re-read by Access and every check is repeated against that current state. A
 * binding revoked, replaced, expired or re-scoped since planning, or an actor no longer active,
 * refuses without fallback. The resolved context must then be exactly the effective actor; the
 * operation receives the resolution confirmed in its own transaction.
 */
export const openFlowEffectiveActorTransaction = async <Scope, Result>(
  request: FlowEffectiveActorRequest,
  access: FlowEffectiveActorTransactionAccess<Scope>,
  operation: (
    transaction: RequestDatabaseTransaction,
    scope: Scope,
    resolution: FlowEffectiveActorEffectiveResolution,
  ) => Promise<Result>,
  dependencies: FlowEffectiveActorTransactionDependencies = {},
): Promise<Result> => {
  const resolverDependencies: FlowEffectiveActorDependencies =
    dependencies.clock === undefined ? {} : { clock: dependencies.clock };
  const planned = resolveFlowEffectiveActor(request, resolverDependencies);
  if (planned.outcome !== "effective")
    throw new FlowEffectiveActorError("FLOW_EFFECTIVE_ACTOR_REFUSED");
  if (!planned.requiresFreshTransaction)
    throw new FlowEffectiveActorError("FLOW_EFFECTIVE_ACTOR_TRANSACTION_NOT_REQUIRED");
  const initiator = sessionContextSchema.parse(request.initiator);
  const runner: FlowEffectiveActorTransactionRunner =
    dependencies.runner ?? withResolvedRequestTransaction;

  let confirmed: FlowEffectiveActorEffectiveResolution | undefined;
  return runner(
    async (transaction) => {
      let current: FlowEffectiveActorResolution = planned;
      if (planned.effectiveActor.kind !== "current_user") {
        const authority = await access.readCurrentAuthority(transaction, planned);
        current = resolveFlowEffectiveActor(
          {
            ...request,
            binding: authority.binding,
            effectiveActorState: authority.effectiveActorState,
            ...(planned.executionBinding === undefined
              ? {}
              : { expectedBindingRevision: planned.executionBinding.revision }),
          },
          resolverDependencies,
        );
      }
      if (current.outcome !== "effective" || !sameResolvedActor(planned, current))
        throw new FlowEffectiveActorError("FLOW_EFFECTIVE_ACTOR_REFUSED");
      const resolved = await access.resolveScope(transaction, current.effectiveActor);
      if (!contextRepresents(resolved.context, current, initiator))
        throw new FlowEffectiveActorError("FLOW_EFFECTIVE_ACTOR_CONTEXT_MISMATCH");
      confirmed = current;
      return resolved;
    },
    async (transaction, scope) => {
      if (confirmed === undefined)
        throw new FlowEffectiveActorError("FLOW_EFFECTIVE_ACTOR_REFUSED");
      return operation(transaction, scope, confirmed);
    },
  );
};
