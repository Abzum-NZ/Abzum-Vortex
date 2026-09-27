import "server-only";

import { z } from "zod";
import {
  activityIdSchema,
  administrationDuplicateKeySchema,
  builderKeySchema,
  configuredTenantAdministrationOperatorContextSchema,
  correlationIdSchema,
  databaseRevision,
  databaseTimestamp,
  entitlementCheckRequestSchema,
  namespacedKeySchema,
  organizationIdSchema,
  platformIdSchema,
  revisionSchema,
  tenantIdSchema,
  timestampSchema,
  type ConfiguredTenantAdministrationOperatorContext,
  type EntitlementCheckRequest,
} from "@vortex/contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "@vortex/db";

/*
 * Entitlement limits (#1384, owner decision of 27 Sep 2026):
 *
 * - The platform operator publishes capability policies and sets each tenant's
 *   ceiling. The operator is the configured system operator: it is read from
 *   trusted server configuration here and is reachable only through the
 *   runtime role in a transaction without a request context, so it is never a
 *   customer role and never follows from a tenant or organisation role.
 * - A tenant administrator allocates or lowers a limit for the whole tenant or
 *   one organisation, and is refused above the live ceiling. The acting person
 *   comes from the bound request context, never from the command.
 * - Organisation administrators have no assignment command at all.
 * - The effective limit is the lowest of the ceiling and every allocation
 *   beneath it, and reports which limit applied.
 */

/** An allocation covers a whole tenant or one exact organisation. */
export const capabilityPolicySubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tenant"), tenantId: tenantIdSchema }).strict(),
  z
    .object({
      kind: z.literal("organization"),
      tenantId: tenantIdSchema,
      organizationId: organizationIdSchema,
    })
    .strict(),
]);

export const capabilityPolicyScopeSchema = z
  .object({ capabilityKey: namespacedKeySchema, unit: builderKeySchema })
  .strict();

export const capabilityPolicyQuantitySchema = z.number().positive().finite();

/** Which balance scope a resolved limit is counted against. */
export const capabilityPolicyAppliedScopeSchema = z.enum(["organization", "tenant"]);

/** Which limit supplied the effective quantity, so the narrower bound is visible. */
export const capabilityLimitSourceSchema = z.enum([
  "platform_ceiling",
  "tenant_allocation",
  "organization_allocation",
]);

/**
 * Organisation allocations are also written to that organisation's Activity,
 * so they carry exactly one Activity identifier; tenant-wide allocations have
 * no organisation ledger and carry none.
 */
const activityEvidenceMatchesSubject = (
  subject: z.infer<typeof capabilityPolicySubjectSchema>,
  activityId: string | undefined,
): boolean => (subject.kind === "organization") === (activityId !== undefined);

export const capabilityPolicyDefinitionCommandSchema = z
  .object({
    policyId: platformIdSchema,
    tenantId: tenantIdSchema,
    ...capabilityPolicyScopeSchema.shape,
    quantityLimit: capabilityPolicyQuantitySchema,
    expectedRevision: revisionSchema.optional(),
    duplicateKey: administrationDuplicateKeySchema,
  })
  .strict();

export const capabilityCeilingCommandSchema = z
  .object({
    ceilingId: platformIdSchema,
    tenantId: tenantIdSchema,
    policyId: platformIdSchema,
    policyRevision: revisionSchema,
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    expectedRevision: revisionSchema.optional(),
    duplicateKey: administrationDuplicateKeySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.parse(value.startsAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Ceiling expiry must be later than its start",
      });
  });

export const capabilityCeilingRevocationCommandSchema = z
  .object({
    ceilingId: platformIdSchema,
    tenantId: tenantIdSchema,
    expectedRevision: revisionSchema,
    duplicateKey: administrationDuplicateKeySchema,
  })
  .strict();

export const capabilityAllocationCommandSchema = z
  .object({
    allocationId: platformIdSchema,
    subject: capabilityPolicySubjectSchema,
    ...capabilityPolicyScopeSchema.shape,
    quantityLimit: capabilityPolicyQuantitySchema,
    expiresAt: timestampSchema.optional(),
    expectedRevision: revisionSchema.optional(),
    duplicateKey: administrationDuplicateKeySchema,
    activityId: activityIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!activityEvidenceMatchesSubject(value.subject, value.activityId))
      context.addIssue({
        code: "custom",
        path: ["activityId"],
        message: "Organisation allocations carry exactly one Activity identifier",
      });
  });

export const capabilityAllocationRevocationCommandSchema = z
  .object({
    allocationId: platformIdSchema,
    subject: capabilityPolicySubjectSchema,
    expectedRevision: revisionSchema,
    duplicateKey: administrationDuplicateKeySchema,
    activityId: activityIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!activityEvidenceMatchesSubject(value.subject, value.activityId))
      context.addIssue({
        code: "custom",
        path: ["activityId"],
        message: "Organisation allocation revocations carry exactly one Activity identifier",
      });
  });

export const capabilityPolicyDefinitionSchema = z
  .object({
    policyId: platformIdSchema,
    tenantId: tenantIdSchema,
    ...capabilityPolicyScopeSchema.shape,
    quantityLimit: capabilityPolicyQuantitySchema,
    revision: revisionSchema,
    publishedAt: timestampSchema,
  })
  .strict();

export const effectiveCapabilityPolicyRequestSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema.optional(),
    ...capabilityPolicyScopeSchema.shape,
  })
  .strict();

export const effectiveCapabilityPolicySchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      ...effectiveCapabilityPolicyRequestSchema.shape,
      appliedScope: capabilityPolicyAppliedScopeSchema,
      appliedLimit: capabilityLimitSourceSchema,
      policyId: platformIdSchema,
      policyRevision: revisionSchema,
      assignmentId: platformIdSchema,
      assignmentRevision: revisionSchema,
      quantityLimit: capabilityPolicyQuantitySchema,
      ceilingQuantityLimit: capabilityPolicyQuantitySchema,
      resolvedAt: timestampSchema,
    })
    .strict()
    .refine((value) => value.quantityLimit <= value.ceilingQuantityLimit, {
      path: ["quantityLimit"],
      message: "An effective limit is never above the platform ceiling",
    }),
  z
    .object({
      outcome: z.literal("refused"),
      ...effectiveCapabilityPolicyRequestSchema.shape,
      reasonCode: z.enum(["capability_not_assigned"]),
      resolvedAt: timestampSchema,
    })
    .strict(),
]);

export const capabilityPolicyMutationResultSchema = z
  .object({
    outcome: z.enum(["accepted", "replayed"]),
    policyId: platformIdSchema,
    tenantId: tenantIdSchema,
    capabilityKey: namespacedKeySchema,
    unit: builderKeySchema,
    quantityLimit: capabilityPolicyQuantitySchema,
    revision: revisionSchema,
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict();

export const capabilityCeilingResultSchema = z
  .object({
    outcome: z.enum(["accepted", "replayed"]),
    ceilingId: platformIdSchema,
    tenantId: tenantIdSchema,
    policyId: platformIdSchema,
    policyRevision: revisionSchema,
    ...capabilityPolicyScopeSchema.shape,
    quantityLimit: capabilityPolicyQuantitySchema,
    revision: revisionSchema,
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict();

export const capabilityCeilingRevocationResultSchema = z
  .object({
    outcome: z.enum(["accepted", "replayed"]),
    ceilingId: platformIdSchema,
    tenantId: tenantIdSchema,
    revision: revisionSchema,
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict();

export const capabilityAllocationResultSchema = z
  .object({
    outcome: z.enum(["accepted", "replayed"]),
    allocationId: platformIdSchema,
    subject: capabilityPolicySubjectSchema,
    ...capabilityPolicyScopeSchema.shape,
    quantityLimit: capabilityPolicyQuantitySchema,
    ceilingPolicyId: platformIdSchema,
    ceilingPolicyRevision: revisionSchema,
    revision: revisionSchema,
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict();

export const capabilityAllocationRevocationResultSchema = z
  .object({
    outcome: z.enum(["accepted", "replayed"]),
    allocationId: platformIdSchema,
    subject: capabilityPolicySubjectSchema,
    revision: revisionSchema,
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict();

export type CapabilityPolicySubject = z.infer<typeof capabilityPolicySubjectSchema>;
export type CapabilityPolicyAppliedScope = z.infer<typeof capabilityPolicyAppliedScopeSchema>;
export type CapabilityLimitSource = z.infer<typeof capabilityLimitSourceSchema>;
export type CapabilityPolicyDefinitionCommand = z.infer<
  typeof capabilityPolicyDefinitionCommandSchema
>;
export type CapabilityCeilingCommand = z.infer<typeof capabilityCeilingCommandSchema>;
export type CapabilityCeilingRevocationCommand = z.infer<
  typeof capabilityCeilingRevocationCommandSchema
>;
export type CapabilityAllocationCommand = z.infer<typeof capabilityAllocationCommandSchema>;
export type CapabilityAllocationRevocationCommand = z.infer<
  typeof capabilityAllocationRevocationCommandSchema
>;
export type CapabilityPolicyDefinition = z.infer<typeof capabilityPolicyDefinitionSchema>;
export type CapabilityPolicyMutationResult = z.infer<typeof capabilityPolicyMutationResultSchema>;
export type CapabilityCeilingResult = z.infer<typeof capabilityCeilingResultSchema>;
export type CapabilityCeilingRevocationResult = z.infer<
  typeof capabilityCeilingRevocationResultSchema
>;
export type CapabilityAllocationResult = z.infer<typeof capabilityAllocationResultSchema>;
export type CapabilityAllocationRevocationResult = z.infer<
  typeof capabilityAllocationRevocationResultSchema
>;
export type EffectiveCapabilityPolicyRequest = z.infer<
  typeof effectiveCapabilityPolicyRequestSchema
>;
export type EffectiveCapabilityPolicy = z.infer<typeof effectiveCapabilityPolicySchema>;

type EffectivePolicyRow = DatabaseRow & {
  outcome: unknown;
  tenant_id: unknown;
  organization_id: unknown;
  capability_key: unknown;
  unit: unknown;
  applied_scope: unknown;
  applied_limit: unknown;
  policy_id: unknown;
  policy_revision: unknown;
  assignment_id: unknown;
  assignment_revision: unknown;
  quantity_limit: unknown;
  ceiling_quantity_limit: unknown;
  resolved_at: unknown;
  reason_code: unknown;
};

type DefinitionMutationRow = DatabaseRow & {
  outcome: unknown;
  policy_id: unknown;
  tenant_id: unknown;
  capability_key: unknown;
  unit: unknown;
  quantity_limit: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};

type CeilingMutationRow = DatabaseRow & {
  outcome: unknown;
  assignment_id: unknown;
  tenant_id: unknown;
  policy_id: unknown;
  policy_revision: unknown;
  capability_key: unknown;
  unit: unknown;
  quantity_limit: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};

type CeilingRevocationRow = DatabaseRow & {
  outcome: unknown;
  assignment_id: unknown;
  tenant_id: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};

type AllocationMutationRow = DatabaseRow & {
  outcome: unknown;
  assignment_id: unknown;
  tenant_id: unknown;
  organization_id: unknown;
  capability_key: unknown;
  unit: unknown;
  quantity_limit: unknown;
  ceiling_policy_id: unknown;
  ceiling_policy_revision: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};

type AllocationRevocationRow = DatabaseRow & {
  outcome: unknown;
  assignment_id: unknown;
  tenant_id: unknown;
  organization_id: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};

const decimalPattern = /^[+-]?\d+(?:\.\d*)?$/;

/** Plain decimal text without its leading, trailing or negative-zero noise. */
const canonicalDecimal = (text: string): string | undefined => {
  if (!decimalPattern.test(text)) return undefined;
  const digits = text.replace(/^[+-]/, "");
  const [whole = "", fraction = ""] = digits.split(".");
  const significantWhole = whole.replace(/^0+(?=\d)/, "");
  const significantFraction = fraction.replace(/0+$/, "");
  const magnitude =
    significantFraction === "" ? significantWhole : `${significantWhole}.${significantFraction}`;
  return `${text.startsWith("-") && /[1-9]/.test(digits) ? "-" : ""}${magnitude}`;
};

/**
 * A stored limit is numeric, so it is only accepted when the contract's
 * double-precision quantity reproduces it exactly. A value that would need
 * rounding is returned unchanged and refused by the contract parse rather
 * than silently coerced into a different limit.
 */
const quantity = (value: unknown): unknown => {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const canonical = canonicalDecimal(value.trim());
  if (canonical === undefined) return value;
  const parsed = Number(canonical);
  if (!Number.isFinite(parsed)) return value;
  return canonicalDecimal(String(parsed)) === canonical ? parsed : value;
};

const parseOne = <Row>(rows: readonly Row[], error: string): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(error);
  return rows[0];
};

const subjectOf = (tenantId: unknown, organizationId: unknown) =>
  organizationId == null
    ? { kind: "tenant", tenantId }
    : { kind: "organization", tenantId, organizationId };

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

/** Stable refusal codes for the administration commands. */
export const capabilityPolicyRefusalCodes = [
  "CAPABILITY_POLICY_COMMAND_INVALID",
  "CAPABILITY_POLICY_DUPLICATE_CONFLICT",
  "CAPABILITY_POLICY_STALE",
  "CAPABILITY_ALLOCATION_ABOVE_CEILING",
  "CAPABILITY_POLICY_SCOPE_UNAVAILABLE",
  "CAPABILITY_POLICY_OPERATOR_NOT_CONFIGURED",
] as const;
export type CapabilityPolicyRefusalCode = (typeof capabilityPolicyRefusalCodes)[number];

const refusal = (error: unknown): Error => {
  switch (databaseCode(error)) {
    case "22023":
      return new Error("CAPABILITY_POLICY_COMMAND_INVALID");
    case "V3001":
      return new Error("CAPABILITY_POLICY_DUPLICATE_CONFLICT");
    case "V3102":
      return new Error("CAPABILITY_POLICY_STALE");
    case "V3104":
      return new Error("CAPABILITY_ALLOCATION_ABOVE_CEILING");
    case "V3101":
    case "42501":
    case "23503":
    case "23505":
    case "23514":
      return new Error("CAPABILITY_POLICY_SCOPE_UNAVAILABLE");
    default:
      return error instanceof Error ? error : new Error("CAPABILITY_POLICY_UNAVAILABLE");
  }
};

const run = async <Row>(operation: () => Promise<readonly Row[]>): Promise<readonly Row[]> => {
  try {
    return await operation();
  } catch (error) {
    throw refusal(error);
  }
};

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

export interface CapabilityPolicyPlatformOperatorDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runtimeTransaction?: RuntimeTransactionRunner;
}

/**
 * The platform operator is the configured system operator, read only from
 * trusted server configuration. No command, session or role supplies it.
 */
const configuredPlatformOperator = (
  environment: Readonly<Record<string, string | undefined>>,
): ConfiguredTenantAdministrationOperatorContext | undefined => {
  const parsed = configuredTenantAdministrationOperatorContextSchema.safeParse({
    kind: "configured_system_operator",
    clusterId: environment.VORTEX_CLUSTER_ID,
    systemActorId: environment.VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID,
  });
  return parsed.success ? parsed.data : undefined;
};

/**
 * Platform-operator commands: policy publication and tenant ceilings. Each
 * runs in its own runtime transaction with no request context, which the
 * database requires before it accepts the operator.
 */
export const createCapabilityPolicyPlatformOperatorService = (
  dependencies: CapabilityPolicyPlatformOperatorDependencies = {},
) => {
  const operator = configuredPlatformOperator(dependencies.environment ?? process.env);
  const runtimeTransaction = dependencies.runtimeTransaction ?? withRuntimeTransaction;
  const requireOperator = (): ConfiguredTenantAdministrationOperatorContext => {
    if (!operator) throw new Error("CAPABILITY_POLICY_OPERATOR_NOT_CONFIGURED");
    return operator;
  };

  return Object.freeze({
    async publishDefinition(
      commandCandidate: CapabilityPolicyDefinitionCommand,
    ): Promise<CapabilityPolicyMutationResult> {
      const command = capabilityPolicyDefinitionCommandSchema.safeParse(commandCandidate);
      if (!command.success) throw new Error("CAPABILITY_POLICY_COMMAND_INVALID");
      const actor = requireOperator();
      const value = command.data;
      const rows = await runtimeTransaction((transaction) =>
        run(
          () => transaction.query<DefinitionMutationRow>`
            select * from vortex_access.publish_capability_policy_definition(
              ${actor.systemActorId}::uuid, ${value.duplicateKey}::uuid,
              ${value.tenantId}::uuid, ${value.policyId}::uuid,
              ${value.capabilityKey}::text, ${value.unit}::text,
              ${value.quantityLimit}::numeric, ${value.expectedRevision ?? null}::bigint
            )
          `,
        ),
      );
      const row = parseOne(rows, "CAPABILITY_POLICY_MUTATION_UNAVAILABLE");
      const parsed = capabilityPolicyMutationResultSchema.safeParse({
        outcome: row.outcome,
        policyId: row.policy_id,
        tenantId: row.tenant_id,
        capabilityKey: row.capability_key,
        unit: row.unit,
        quantityLimit: quantity(row.quantity_limit),
        revision: databaseRevision(row.revision),
        correlationId: row.correlation_id,
        acceptedAt: databaseTimestamp(row.accepted_at),
      });
      if (!parsed.success) throw new Error("CAPABILITY_POLICY_MUTATION_UNAVAILABLE");
      return parsed.data;
    },

    async setCeiling(commandCandidate: CapabilityCeilingCommand): Promise<CapabilityCeilingResult> {
      const command = capabilityCeilingCommandSchema.safeParse(commandCandidate);
      if (!command.success) throw new Error("CAPABILITY_POLICY_COMMAND_INVALID");
      const actor = requireOperator();
      const value = command.data;
      const rows = await runtimeTransaction((transaction) =>
        run(
          () => transaction.query<CeilingMutationRow>`
            select * from vortex_access.set_capability_policy_ceiling(
              ${actor.systemActorId}::uuid, ${value.duplicateKey}::uuid,
              ${value.tenantId}::uuid, ${value.ceilingId}::uuid,
              ${value.policyId}::uuid, ${value.policyRevision}::bigint,
              ${value.startsAt}::timestamptz, ${value.expiresAt ?? null}::timestamptz,
              ${value.expectedRevision ?? null}::bigint
            )
          `,
        ),
      );
      const row = parseOne(rows, "CAPABILITY_CEILING_UNAVAILABLE");
      const parsed = capabilityCeilingResultSchema.safeParse({
        outcome: row.outcome,
        ceilingId: row.assignment_id,
        tenantId: row.tenant_id,
        policyId: row.policy_id,
        policyRevision: databaseRevision(row.policy_revision),
        capabilityKey: row.capability_key,
        unit: row.unit,
        quantityLimit: quantity(row.quantity_limit),
        revision: databaseRevision(row.revision),
        correlationId: row.correlation_id,
        acceptedAt: databaseTimestamp(row.accepted_at),
      });
      if (!parsed.success) throw new Error("CAPABILITY_CEILING_UNAVAILABLE");
      return parsed.data;
    },

    async revokeCeiling(
      commandCandidate: CapabilityCeilingRevocationCommand,
    ): Promise<CapabilityCeilingRevocationResult> {
      const command = capabilityCeilingRevocationCommandSchema.safeParse(commandCandidate);
      if (!command.success) throw new Error("CAPABILITY_POLICY_COMMAND_INVALID");
      const actor = requireOperator();
      const value = command.data;
      const rows = await runtimeTransaction((transaction) =>
        run(
          () => transaction.query<CeilingRevocationRow>`
            select * from vortex_access.revoke_capability_policy_ceiling(
              ${actor.systemActorId}::uuid, ${value.duplicateKey}::uuid,
              ${value.tenantId}::uuid, ${value.ceilingId}::uuid,
              ${value.expectedRevision}::bigint
            )
          `,
        ),
      );
      const row = parseOne(rows, "CAPABILITY_CEILING_UNAVAILABLE");
      const parsed = capabilityCeilingRevocationResultSchema.safeParse({
        outcome: row.outcome,
        ceilingId: row.assignment_id,
        tenantId: row.tenant_id,
        revision: databaseRevision(row.revision),
        correlationId: row.correlation_id,
        acceptedAt: databaseTimestamp(row.accepted_at),
      });
      if (!parsed.success) throw new Error("CAPABILITY_CEILING_UNAVAILABLE");
      return parsed.data;
    },
  });
};

export type CapabilityPolicyPlatformOperatorService = ReturnType<
  typeof createCapabilityPolicyPlatformOperatorService
>;

/**
 * Tenant-administrator allocation for the whole tenant or one organisation,
 * refused above the live platform ceiling. The acting person and their tenant
 * administration authority come from the transaction's bound request context.
 */
export const setCapabilityLimitAllocation = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: CapabilityAllocationCommand,
): Promise<CapabilityAllocationResult> => {
  const command = capabilityAllocationCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("CAPABILITY_POLICY_COMMAND_INVALID");
  const value = command.data;
  const organizationId =
    value.subject.kind === "organization" ? value.subject.organizationId : null;
  const rows = await run(
    () => transaction.query<AllocationMutationRow>`
      select * from vortex_access.set_capability_limit_allocation(
        ${value.duplicateKey}::uuid, ${value.subject.tenantId}::uuid,
        ${organizationId}::uuid, ${value.allocationId}::uuid,
        ${value.capabilityKey}::text, ${value.unit}::text,
        ${value.quantityLimit}::numeric, ${value.expiresAt ?? null}::timestamptz,
        ${value.expectedRevision ?? null}::bigint, ${value.activityId ?? null}::uuid
      )
    `,
  );
  const row = parseOne(rows, "CAPABILITY_ALLOCATION_UNAVAILABLE");
  const parsed = capabilityAllocationResultSchema.safeParse({
    outcome: row.outcome,
    allocationId: row.assignment_id,
    subject: subjectOf(row.tenant_id, row.organization_id),
    capabilityKey: row.capability_key,
    unit: row.unit,
    quantityLimit: quantity(row.quantity_limit),
    ceilingPolicyId: row.ceiling_policy_id,
    ceilingPolicyRevision: databaseRevision(row.ceiling_policy_revision),
    revision: databaseRevision(row.revision),
    correlationId: row.correlation_id,
    acceptedAt: databaseTimestamp(row.accepted_at),
  });
  if (!parsed.success) throw new Error("CAPABILITY_ALLOCATION_UNAVAILABLE");
  return parsed.data;
};

export const revokeCapabilityLimitAllocation = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: CapabilityAllocationRevocationCommand,
): Promise<CapabilityAllocationRevocationResult> => {
  const command = capabilityAllocationRevocationCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("CAPABILITY_POLICY_COMMAND_INVALID");
  const value = command.data;
  const organizationId =
    value.subject.kind === "organization" ? value.subject.organizationId : null;
  const rows = await run(
    () => transaction.query<AllocationRevocationRow>`
      select * from vortex_access.revoke_capability_limit_allocation(
        ${value.duplicateKey}::uuid, ${value.subject.tenantId}::uuid,
        ${organizationId}::uuid, ${value.allocationId}::uuid,
        ${value.expectedRevision}::bigint, ${value.activityId ?? null}::uuid
      )
    `,
  );
  const row = parseOne(rows, "CAPABILITY_ALLOCATION_UNAVAILABLE");
  const parsed = capabilityAllocationRevocationResultSchema.safeParse({
    outcome: row.outcome,
    allocationId: row.assignment_id,
    subject: subjectOf(row.tenant_id, row.organization_id),
    revision: databaseRevision(row.revision),
    correlationId: row.correlation_id,
    acceptedAt: databaseTimestamp(row.accepted_at),
  });
  if (!parsed.success) throw new Error("CAPABILITY_ALLOCATION_UNAVAILABLE");
  return parsed.data;
};

/**
 * Resolves only the tenant and organisation the request context already
 * established. The limit is the lowest of the platform ceiling and the tenant
 * and organisation allocations beneath it; the result names which one applied
 * and carries the ceiling. #650 owns admission.
 */
export const resolveEffectiveCapabilityPolicy = async (
  transaction: RequestDatabaseTransaction,
  requestCandidate: EffectiveCapabilityPolicyRequest,
): Promise<EffectiveCapabilityPolicy> => {
  const request = effectiveCapabilityPolicyRequestSchema.safeParse(requestCandidate);
  if (!request.success) throw new Error("CAPABILITY_POLICY_REQUEST_INVALID");
  let rows: readonly EffectivePolicyRow[];
  try {
    rows = await transaction.query<EffectivePolicyRow>`
      select outcome, tenant_id, organization_id, capability_key, unit, applied_scope,
        applied_limit, policy_id, policy_revision, assignment_id, assignment_revision,
        quantity_limit, ceiling_quantity_limit, resolved_at, reason_code
      from vortex_access.resolve_effective_capability_policy(
        ${request.data.tenantId}::uuid,
        ${request.data.organizationId ?? null}::uuid,
        ${request.data.capabilityKey}::text,
        ${request.data.unit}::text
      )
    `;
  } catch {
    throw new Error("CAPABILITY_POLICY_UNAVAILABLE");
  }
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("CAPABILITY_POLICY_UNAVAILABLE");
  const row = rows[0];
  const candidate = {
    outcome: row.outcome,
    tenantId: row.tenant_id,
    ...(row.organization_id == null ? {} : { organizationId: row.organization_id }),
    capabilityKey: row.capability_key,
    unit: row.unit,
    ...(row.outcome === "available"
      ? {
          appliedScope: row.applied_scope,
          appliedLimit: row.applied_limit,
          policyId: row.policy_id,
          policyRevision: databaseRevision(row.policy_revision),
          assignmentId: row.assignment_id,
          assignmentRevision: databaseRevision(row.assignment_revision),
          quantityLimit: quantity(row.quantity_limit),
          ceilingQuantityLimit: quantity(row.ceiling_quantity_limit),
        }
      : { reasonCode: row.reason_code }),
    resolvedAt: databaseTimestamp(row.resolved_at),
  };
  const parsed = effectiveCapabilityPolicySchema.safeParse(candidate);
  if (!parsed.success) throw new Error("CAPABILITY_POLICY_UNAVAILABLE");
  return parsed.data;
};

/** Preserve the shared entitlement request shape while keeping admission in #650. */
export const resolveEffectiveCapabilityPolicyForEntitlement = async (
  transaction: RequestDatabaseTransaction,
  requestCandidate: EntitlementCheckRequest,
): Promise<EffectiveCapabilityPolicy> => {
  const request = entitlementCheckRequestSchema.safeParse(requestCandidate);
  if (!request.success) throw new Error("CAPABILITY_POLICY_REQUEST_INVALID");
  return resolveEffectiveCapabilityPolicy(transaction, {
    tenantId: request.data.tenantId,
    ...(request.data.organizationId === undefined
      ? {}
      : { organizationId: request.data.organizationId }),
    capabilityKey: request.data.capabilityKey,
    unit: request.data.unit,
  });
};
