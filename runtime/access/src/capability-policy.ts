import "server-only";

import { z } from "zod";
import {
  activityIdSchema,
  administrationDuplicateKeySchema,
  builderKeySchema,
  correlationIdSchema,
  entitlementCheckRequestSchema,
  identityIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  platformIdSchema,
  revisionSchema,
  tenantIdSchema,
  timestampSchema,
  type EntitlementCheckRequest,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

/** A policy can be assigned to a whole tenant or to one exact organisation. */
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

/** Which assignment a resolved limit came from, so the narrower scope is visible. */
export const capabilityPolicyAppliedScopeSchema = z.enum(["organization", "tenant"]);

/** Authority is explicit and no authority can silently cross its target scope. */
export const capabilityPolicyAdministratorAuthoritySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tenant_administrator"),
      tenantId: tenantIdSchema,
      identityId: identityIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("organization_administrator"),
      tenantId: tenantIdSchema,
      organizationId: organizationIdSchema,
      organizationAccountId: organizationAccountIdSchema,
      identityId: identityIdSchema,
    })
    .strict(),
]);

const authorityMatchesSubject = (
  authority: z.infer<typeof capabilityPolicyAdministratorAuthoritySchema>,
  subject: z.infer<typeof capabilityPolicySubjectSchema>,
): boolean =>
  (authority.kind === "tenant_administrator" &&
    subject.kind === "tenant" &&
    authority.tenantId.toLowerCase() === subject.tenantId.toLowerCase()) ||
  (authority.kind === "organization_administrator" &&
    subject.kind === "organization" &&
    authority.tenantId.toLowerCase() === subject.tenantId.toLowerCase() &&
    authority.organizationId.toLowerCase() === subject.organizationId.toLowerCase());

/**
 * Organisation administration is Activity-evidenced. Tenant administration is
 * evidenced by its accepted-administration receipt and has no organisation
 * Activity ledger to append to, so the identifier belongs to exactly one of
 * the two authorities and is never carried unused.
 */
const activityEvidenceMatchesAuthority = (
  authority: z.infer<typeof capabilityPolicyAdministratorAuthoritySchema>,
  activityId: string | undefined,
): boolean => (authority.kind === "organization_administrator") === (activityId !== undefined);

export const capabilityPolicyDefinitionCommandSchema = z
  .object({
    policyId: platformIdSchema,
    tenantId: tenantIdSchema,
    ...capabilityPolicyScopeSchema.shape,
    quantityLimit: capabilityPolicyQuantitySchema,
    expectedRevision: revisionSchema.optional(),
    duplicateKey: administrationDuplicateKeySchema,
    authority: capabilityPolicyAdministratorAuthoritySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.authority.kind !== "tenant_administrator" ||
      value.authority.tenantId.toLowerCase() !== value.tenantId.toLowerCase()
    )
      context.addIssue({
        code: "custom",
        path: ["authority"],
        message: "Policy definitions require tenant authority for the same tenant",
      });
  });

export const capabilityPolicyAssignmentCommandSchema = z
  .object({
    assignmentId: platformIdSchema,
    policyId: platformIdSchema,
    policyRevision: revisionSchema,
    subject: capabilityPolicySubjectSchema,
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    duplicateKey: administrationDuplicateKeySchema,
    activityId: activityIdSchema.optional(),
    authority: capabilityPolicyAdministratorAuthoritySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!authorityMatchesSubject(value.authority, value.subject))
      context.addIssue({
        code: "custom",
        path: ["authority"],
        message: "Administrator authority must cover the exact assignment subject",
      });
    if (!activityEvidenceMatchesAuthority(value.authority, value.activityId))
      context.addIssue({
        code: "custom",
        path: ["activityId"],
        message: "Organisation assignments carry exactly one Activity identifier",
      });
    if (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.parse(value.startsAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Assignment expiry must be later than its start",
      });
  });

export const capabilityPolicyRevocationCommandSchema = z
  .object({
    assignmentId: platformIdSchema,
    expectedRevision: revisionSchema,
    duplicateKey: administrationDuplicateKeySchema,
    activityId: activityIdSchema.optional(),
    authority: capabilityPolicyAdministratorAuthoritySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!activityEvidenceMatchesAuthority(value.authority, value.activityId))
      context.addIssue({
        code: "custom",
        path: ["activityId"],
        message: "Organisation revocations carry exactly one Activity identifier",
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

export const capabilityPolicyAssignmentSchema = z
  .object({
    assignmentId: platformIdSchema,
    policyId: platformIdSchema,
    policyRevision: revisionSchema,
    subject: capabilityPolicySubjectSchema,
    revision: revisionSchema,
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    assignedAt: timestampSchema,
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
      policyId: platformIdSchema,
      policyRevision: revisionSchema,
      assignmentId: platformIdSchema,
      assignmentRevision: revisionSchema,
      quantityLimit: capabilityPolicyQuantitySchema,
      resolvedAt: timestampSchema,
    })
    .strict(),
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

export const capabilityPolicyAssignmentResultSchema = z
  .object({
    outcome: z.enum(["accepted", "replayed"]),
    assignmentId: platformIdSchema,
    policyId: platformIdSchema,
    policyRevision: revisionSchema,
    subject: capabilityPolicySubjectSchema,
    revision: revisionSchema,
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict();

export const capabilityPolicyRevocationResultSchema = z
  .object({
    outcome: z.enum(["accepted", "replayed"]),
    assignmentId: platformIdSchema,
    revision: revisionSchema,
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict();

export type CapabilityPolicySubject = z.infer<typeof capabilityPolicySubjectSchema>;
export type CapabilityPolicyAppliedScope = z.infer<typeof capabilityPolicyAppliedScopeSchema>;
export type CapabilityPolicyAdministratorAuthority = z.infer<
  typeof capabilityPolicyAdministratorAuthoritySchema
>;
export type CapabilityPolicyDefinitionCommand = z.infer<
  typeof capabilityPolicyDefinitionCommandSchema
>;
export type CapabilityPolicyAssignmentCommand = z.infer<
  typeof capabilityPolicyAssignmentCommandSchema
>;
export type CapabilityPolicyRevocationCommand = z.infer<
  typeof capabilityPolicyRevocationCommandSchema
>;
export type CapabilityPolicyDefinition = z.infer<typeof capabilityPolicyDefinitionSchema>;
export type CapabilityPolicyAssignment = z.infer<typeof capabilityPolicyAssignmentSchema>;
export type CapabilityPolicyMutationResult = z.infer<typeof capabilityPolicyMutationResultSchema>;
export type CapabilityPolicyAssignmentResult = z.infer<
  typeof capabilityPolicyAssignmentResultSchema
>;
export type CapabilityPolicyRevocationResult = z.infer<
  typeof capabilityPolicyRevocationResultSchema
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
  policy_id: unknown;
  policy_revision: unknown;
  assignment_id: unknown;
  assignment_revision: unknown;
  quantity_limit: unknown;
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

type AssignmentMutationRow = DatabaseRow & {
  outcome: unknown;
  assignment_id: unknown;
  policy_id: unknown;
  policy_revision: unknown;
  tenant_id: unknown;
  organization_id: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};

type RevocationMutationRow = DatabaseRow & {
  outcome: unknown;
  assignment_id: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};

/**
 * A revision is only converted when the exact whole number survives; anything
 * wider than a safe integer is returned unchanged so the contract parse
 * refuses it instead of accepting a rounded revision.
 */
const revision = (value: unknown): unknown => {
  if (typeof value === "bigint")
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : value;
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

const timestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;

const parseOne = <Row>(rows: readonly Row[], error: string): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(error);
  return rows[0];
};

export const publishCapabilityPolicyDefinition = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: CapabilityPolicyDefinitionCommand,
): Promise<CapabilityPolicyMutationResult> => {
  const command = capabilityPolicyDefinitionCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("CAPABILITY_POLICY_COMMAND_INVALID");
  if (command.data.authority.kind !== "tenant_administrator")
    throw new Error("CAPABILITY_POLICY_AUTHORITY_INVALID");
  const value = command.data;
  const rows = await transaction.query<DefinitionMutationRow>`
    select * from vortex_access.publish_capability_policy_definition(
      ${value.authority.identityId}::uuid, ${value.duplicateKey}::uuid,
      ${value.tenantId}::uuid, ${value.policyId}::uuid,
      ${value.capabilityKey}::text, ${value.unit}::text,
      ${value.quantityLimit}::numeric, ${value.expectedRevision ?? null}::bigint
    )
  `;
  const row = parseOne(rows, "CAPABILITY_POLICY_MUTATION_UNAVAILABLE");
  const parsed = capabilityPolicyMutationResultSchema.safeParse({
    outcome: row.outcome,
    policyId: row.policy_id,
    tenantId: row.tenant_id,
    capabilityKey: row.capability_key,
    unit: row.unit,
    quantityLimit: quantity(row.quantity_limit),
    revision: revision(row.revision),
    correlationId: row.correlation_id,
    acceptedAt: timestamp(row.accepted_at),
  });
  if (!parsed.success) throw new Error("CAPABILITY_POLICY_MUTATION_UNAVAILABLE");
  return parsed.data;
};

export const assignCapabilityPolicy = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: CapabilityPolicyAssignmentCommand,
): Promise<CapabilityPolicyAssignmentResult> => {
  const command = capabilityPolicyAssignmentCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("CAPABILITY_POLICY_COMMAND_INVALID");
  const value = command.data;
  const rows = await transaction.query<AssignmentMutationRow>`
    select * from vortex_access.assign_capability_policy(
      ${value.authority.identityId}::uuid,
      ${value.authority.kind === "organization_administrator"
        ? value.authority.organizationAccountId
        : null}::uuid,
      ${value.duplicateKey}::uuid, ${value.subject.tenantId}::uuid,
      ${value.subject.kind === "organization" ? value.subject.organizationId : null}::uuid,
      ${value.assignmentId}::uuid, ${value.policyId}::uuid,
      ${value.policyRevision}::bigint, ${value.startsAt}::timestamptz,
      ${value.expiresAt ?? null}::timestamptz, ${value.activityId ?? null}::uuid
    )
  `;
  const row = parseOne(rows, "CAPABILITY_POLICY_ASSIGNMENT_UNAVAILABLE");
  const parsed = capabilityPolicyAssignmentResultSchema.safeParse({
    outcome: row.outcome,
    assignmentId: row.assignment_id,
    policyId: row.policy_id,
    policyRevision: revision(row.policy_revision),
    subject:
      row.organization_id == null
        ? { kind: "tenant", tenantId: row.tenant_id }
        : { kind: "organization", tenantId: row.tenant_id, organizationId: row.organization_id },
    revision: revision(row.revision),
    correlationId: row.correlation_id,
    acceptedAt: timestamp(row.accepted_at),
  });
  if (!parsed.success) throw new Error("CAPABILITY_POLICY_ASSIGNMENT_UNAVAILABLE");
  return parsed.data;
};

export const revokeCapabilityPolicyAssignment = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: CapabilityPolicyRevocationCommand,
): Promise<CapabilityPolicyRevocationResult> => {
  const command = capabilityPolicyRevocationCommandSchema.safeParse(commandCandidate);
  if (!command.success) throw new Error("CAPABILITY_POLICY_COMMAND_INVALID");
  const value = command.data;
  const rows = await transaction.query<RevocationMutationRow>`
    select * from vortex_access.revoke_capability_policy_assignment(
      ${value.authority.identityId}::uuid,
      ${value.authority.kind === "organization_administrator"
        ? value.authority.organizationAccountId
        : null}::uuid,
      ${value.duplicateKey}::uuid, ${value.authority.tenantId}::uuid,
      ${value.authority.kind === "organization_administrator"
        ? value.authority.organizationId
        : null}::uuid,
      ${value.assignmentId}::uuid, ${value.expectedRevision}::bigint,
      ${value.activityId ?? null}::uuid
    )
  `;
  const row = parseOne(rows, "CAPABILITY_POLICY_REVOCATION_UNAVAILABLE");
  const parsed = capabilityPolicyRevocationResultSchema.safeParse({
    outcome: row.outcome,
    assignmentId: row.assignment_id,
    revision: revision(row.revision),
    correlationId: row.correlation_id,
    acceptedAt: timestamp(row.accepted_at),
  });
  if (!parsed.success) throw new Error("CAPABILITY_POLICY_REVOCATION_UNAVAILABLE");
  return parsed.data;
};

/**
 * Resolves only the tenant and organisation the request context already
 * established, and reports which assignment scope supplied the limit so the
 * organisation-over-tenant choice stays visible. #650 owns admission.
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
        policy_id, policy_revision, assignment_id, assignment_revision,
        quantity_limit, resolved_at, reason_code
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
          policyId: row.policy_id,
          policyRevision: revision(row.policy_revision),
          assignmentId: row.assignment_id,
          assignmentRevision: revision(row.assignment_revision),
          quantityLimit: quantity(row.quantity_limit),
        }
      : { reasonCode: row.reason_code }),
    resolvedAt: timestamp(row.resolved_at),
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
