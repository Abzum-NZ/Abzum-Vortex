import "server-only";

import { z } from "zod";
import {
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  correlationIdSchema,
  flowExecutionBindingReadResultSchema,
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
  type FlowExecutionBinding,
  type SessionContext,
} from "@vortex/contracts";
import {
  withResolvedRequestTransaction,
  type RequestDatabaseTransaction,
  type ResolvedRequestContext,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";

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
 * The trusted per-use inputs the owning flow runtime already resolved: the verified initiator
 * context, the run actor of the preceding node (absent at the flow start), the exact node request,
 * the active #685 binding read result for a delegated node, and the effective actor's current
 * lifecycle state where trusted wiring resolved one.
 */
export const flowEffectiveActorRequestSchema = z
  .object({
    initiator: sessionContextSchema,
    currentActor: flowEffectiveActorRunActorSchema.optional(),
    node: flowEffectiveActorNodeRequestSchema,
    binding: flowExecutionBindingReadResultSchema.optional(),
    /** The revision the run already holds for this binding; a stale value refuses. */
    expectedBindingRevision: revisionSchema.optional(),
    /** The effective actor's resolved account state; `suspended` and `closed` refuse. */
    effectiveActorState: z.enum(["active", "suspended", "closed"]).optional(),
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
export type FlowEffectiveActorRequest = z.infer<typeof flowEffectiveActorRequestSchema>;
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

/** The run actor identity a resolved node would produce, for change detection across a run. */
const resolvedRunActor = (
  node: FlowEffectiveActorNodeRequest,
  initiator: SessionContext,
  binding: FlowExecutionBinding | undefined,
): FlowEffectiveActorRunActor | undefined => {
  if (node.runAs.kind === "current_user")
    return initiator.callerKind === "human" || initiator.callerKind === "federated"
      ? { kind: "current_user" }
      : undefined;
  if (node.runAs.kind === "specified_user" && binding?.actor.kind === "specified_user")
    return { kind: "specified_user", organizationAccountId: binding.actor.organizationAccountId };
  if (node.runAs.kind === "system" && binding?.actor.kind === "system")
    return { kind: "system", systemActorId: binding.actor.systemActorId };
  return undefined;
};

const sameRunActor = (
  left: FlowEffectiveActorRunActor | undefined,
  right: FlowEffectiveActorRunActor | undefined,
): boolean => {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "specified_user" && right.kind === "specified_user")
    return sameId(left.organizationAccountId, right.organizationAccountId);
  if (left.kind === "system" && right.kind === "system")
    return sameId(left.systemActorId, right.systemActorId);
  return true;
};

/**
 * Whether the effective actor's own closed context must be established in a fresh, separately
 * Access-resolved short transaction: it does whenever the node's actor is not the actor already
 * active for this run. The first node of a run at the initiator already runs in the initiator's
 * transaction, so its `currentActor` is absent and `current_user` needs no new transaction.
 */
const actorChanged = (
  currentActor: FlowEffectiveActorRunActor | undefined,
  nextActor: FlowEffectiveActorRunActor | undefined,
): boolean => {
  if (currentActor === undefined && nextActor?.kind === "current_user") return false;
  return !sameRunActor(currentActor, nextActor);
};

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
  if (!sameId(initiator.organizationId, node.organizationId))
    return refuse("invoker_not_permitted");

  // The original initiator is always the current user; never the preceding overridden actor.
  if (node.runAs.kind === "current_user") {
    const effective = resolvedRunActor(node, initiator, undefined);
    if (initiatorIdentity.kind !== "organization_account" || effective === undefined)
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
      requiresFreshTransaction: actorChanged(currentActor, effective),
      permittedInputs: [...node.inputKeys],
    };
  }

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

  const expectedActorKind = node.runAs.kind === "specified_user" ? "specified_user" : "system";
  if (stored.actor.kind !== expectedActorKind) return refuse("actor_kind_mismatch");
  // A specified person must be confirmed active at use; the system-actor registry is still pending
  // (#685), so only an explicit non-active state refuses a system actor here.
  if (stored.actor.kind === "specified_user") {
    if (effectiveActorState !== "active") return refuse("actor_unavailable");
  } else if (effectiveActorState !== undefined && effectiveActorState !== "active") {
    return refuse("actor_unavailable");
  }

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

  const effective = resolvedRunActor(node, initiator, stored);
  if (effective === undefined) return refuse("actor_kind_mismatch");

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
    requiresFreshTransaction: actorChanged(currentActor, effective),
    permittedInputs: [...stored.permittedInputs],
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

/**
 * Trusted wiring resolves the effective actor's complete closed organisation scope inside the new
 * transaction. It must derive the identity from the actor reference and the database, never from a
 * caller-supplied context; a system actor is established as its registered system actor, never as
 * a database service role.
 */
export type FlowEffectiveActorScopeResolver<Scope> = (
  transaction: RuntimeDatabaseTransaction,
  actor: FlowEffectiveActorIdentity,
) => Promise<ResolvedRequestContext<Scope>>;

export type FlowEffectiveActorTransactionRunner = <Scope, Result>(
  resolve: (transaction: RuntimeDatabaseTransaction) => Promise<ResolvedRequestContext<Scope>>,
  operation: (transaction: RequestDatabaseTransaction, scope: Scope) => Promise<Result>,
) => Promise<Result>;

/**
 * Establishes the fresh, short Access-resolved transaction for the effective actor of one resolved
 * protected node and runs its protected operation inside it. It refuses to reuse an existing
 * transaction: a caller must pass a resolution whose `requiresFreshTransaction` is set, so an
 * identity-changing node can never mutate or upgrade the preceding human transaction.
 */
export const openFlowEffectiveActorTransaction = async <Scope, Result>(
  resolution: FlowEffectiveActorResolution,
  resolveScope: FlowEffectiveActorScopeResolver<Scope>,
  operation: (transaction: RequestDatabaseTransaction, scope: Scope) => Promise<Result>,
  dependencies: Readonly<{ runner?: FlowEffectiveActorTransactionRunner }> = {},
): Promise<Result> => {
  if (resolution.outcome !== "effective")
    throw new FlowEffectiveActorError("FLOW_EFFECTIVE_ACTOR_REFUSED");
  if (!resolution.requiresFreshTransaction)
    throw new FlowEffectiveActorError("FLOW_EFFECTIVE_ACTOR_TRANSACTION_NOT_REQUIRED");
  const runner: FlowEffectiveActorTransactionRunner =
    dependencies.runner ?? withResolvedRequestTransaction;
  return runner((transaction) => resolveScope(transaction, resolution.effectiveActor), operation);
};
