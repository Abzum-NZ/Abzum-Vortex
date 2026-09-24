import { z } from "zod";
import {
  applicationRootIdSchema,
  connectionInstanceIdSchema,
  organizationIdSchema,
  recordTypeIdSchema,
  recordIdSchema,
  revisionSchema,
  storageContractIdSchema,
  timestampSchema,
  workflowIdSchema,
} from "./identifiers";

const nonNilUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000", {
    message: "Identifier cannot be the nil UUID",
  });

const jsonSafePositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const jsonSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

export const recordLifecyclePolicyIdSchema = nonNilUuidSchema.brand<"RecordLifecyclePolicyId">();
export type RecordLifecyclePolicyId = z.infer<typeof recordLifecyclePolicyIdSchema>;

/**
 * Permitted end-of-life lifecycle actions.
 * - 'delete': recoverable deletion under the organisation recovery policy.
 * - 'archive_workflow': registered durable backend workflow to archive followed by protected deletion.
 */
export const recordLifecycleActionSchema = z.enum(["delete", "archive_workflow"]);
export type RecordLifecycleAction = z.infer<typeof recordLifecycleActionSchema>;

/**
 * Closed, typed archive destination reference identifier.
 * Must be a lowercase alphanumeric identifier using hyphen or underscore delimiters.
 * Strictly excludes URLs, connection strings, SQL escape hatches, and credential patterns.
 */
export const archiveDestinationReferenceSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/,
    "Archive destination reference must be a lowercase alphanumeric identifier using hyphen or underscore delimiters",
  )
  .brand<"ArchiveDestinationReference">();
export type ArchiveDestinationReference = z.infer<typeof archiveDestinationReferenceSchema>;

/**
 * Organisation runtime settings lifecycle ceiling schema.
 * Bound to organizationId and settingsRevision.
 * Limits must be internally closed: either a finite positive ceiling is set,
 * or allowUnlimited is explicitly true. Finite ceiling with unlimited is prohibited.
 */
export const organizationLifecycleLimitsSchema = z
  .object({
    organizationId: organizationIdSchema,
    settingsRevision: jsonSafeRevisionSchema,
    maxRetentionDays: jsonSafePositiveIntegerSchema.nullable().optional(),
    maxRecordCount: jsonSafePositiveIntegerSchema.nullable().optional(),
    allowUnlimitedRetentionDays: z.boolean(),
    allowUnlimitedRecordCount: z.boolean(),
    allowedActions: z.array(recordLifecycleActionSchema).min(1),
    allowedArchiveDestinations: z.array(archiveDestinationReferenceSchema),
  })
  .strict()
  .superRefine((limits, context) => {
    // 1. Retention days closed representation check
    if (limits.allowUnlimitedRetentionDays) {
      if (limits.maxRetentionDays !== null && limits.maxRetentionDays !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["maxRetentionDays"],
          message:
            "maxRetentionDays must be null or omitted when allowUnlimitedRetentionDays is true",
        });
      }
    } else {
      if (limits.maxRetentionDays === null || limits.maxRetentionDays === undefined) {
        context.addIssue({
          code: "custom",
          path: ["maxRetentionDays"],
          message:
            "maxRetentionDays must be specified when allowUnlimitedRetentionDays is false; missing limit is not an unlimited fallback",
        });
      }
    }

    // 2. Record count closed representation check
    if (limits.allowUnlimitedRecordCount) {
      if (limits.maxRecordCount !== null && limits.maxRecordCount !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["maxRecordCount"],
          message: "maxRecordCount must be null or omitted when allowUnlimitedRecordCount is true",
        });
      }
    } else {
      if (limits.maxRecordCount === null || limits.maxRecordCount === undefined) {
        context.addIssue({
          code: "custom",
          path: ["maxRecordCount"],
          message:
            "maxRecordCount must be specified when allowUnlimitedRecordCount is false; missing limit is not an unlimited fallback",
        });
      }
    }

    // 3. Unique allowed actions
    const uniqueActions = new Set(limits.allowedActions);
    if (uniqueActions.size !== limits.allowedActions.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedActions"],
        message: "allowedActions cannot contain duplicate values",
      });
    }

    // 4. Archive workflow requires at least one allowed destination
    if (
      limits.allowedActions.includes("archive_workflow") &&
      limits.allowedArchiveDestinations.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedArchiveDestinations"],
        message:
          "allowedArchiveDestinations cannot be empty when 'archive_workflow' is an allowed action",
      });
    }

    // 5. No URLs or SQL in destination names
    for (let i = 0; i < limits.allowedArchiveDestinations.length; i++) {
      const dest = limits.allowedArchiveDestinations[i]!;
      if (/^https?:\/\/|postgres:\/\/|select\s|insert\s/i.test(dest)) {
        context.addIssue({
          code: "custom",
          path: ["allowedArchiveDestinations", i],
          message:
            "Archive destination cannot contain URLs, connection strings, or SQL escape hatches",
        });
      }
    }
  });

export type OrganizationLifecycleLimits = z.infer<typeof organizationLifecycleLimitsSchema>;

/**
 * Standard JSON-safe positive integer revision schema matching repository conventions.
 */
export const policyRevisionSchema = jsonSafeRevisionSchema;
export type PolicyRevision = z.infer<typeof policyRevisionSchema>;

const policyBaseFields = {
  policyId: recordLifecyclePolicyIdSchema,
  organizationId: organizationIdSchema,
  storageContractId: storageContractIdSchema,
  applicationRootId: applicationRootIdSchema.nullable(),
  policyRevision: policyRevisionSchema,
  maxAgeDays: jsonSafePositiveIntegerSchema.nullable(),
  maxCount: jsonSafePositiveIntegerSchema.nullable(),
  allowUnlimitedAge: z.boolean(),
  allowUnlimitedCount: z.boolean(),
};

const validatePolicyLimitsConsistency = (
  policy: {
    allowUnlimitedAge: boolean;
    maxAgeDays: number | null;
    allowUnlimitedCount: boolean;
    maxCount: number | null;
  },
  context: z.RefinementCtx,
) => {
  // Age consistency
  if (policy.allowUnlimitedAge && policy.maxAgeDays !== null) {
    context.addIssue({
      code: "custom",
      path: ["maxAgeDays"],
      message: "maxAgeDays must be null when allowUnlimitedAge is true",
    });
  }
  if (!policy.allowUnlimitedAge && policy.maxAgeDays === null) {
    context.addIssue({
      code: "custom",
      path: ["maxAgeDays"],
      message: "maxAgeDays must be specified when allowUnlimitedAge is false",
    });
  }

  // Count consistency
  if (policy.allowUnlimitedCount && policy.maxCount !== null) {
    context.addIssue({
      code: "custom",
      path: ["maxCount"],
      message: "maxCount must be null when allowUnlimitedCount is true",
    });
  }
  if (!policy.allowUnlimitedCount && policy.maxCount === null) {
    context.addIssue({
      code: "custom",
      path: ["maxCount"],
      message: "maxCount must be specified when allowUnlimitedCount is false",
    });
  }
};

/**
 * The maximum recovery window a policy may configure, in whole days.  Every
 * window is converted to milliseconds for the elapsed-time comparison, so the
 * ceiling is the largest day count whose millisecond value is still a
 * JSON-safe integer.  A larger configured window is a refusal, never a silent
 * unlimited-recovery fallback.
 */
export const maximumRecoveryWindowDays = Math.floor(
  Number.MAX_SAFE_INTEGER / (24 * 60 * 60 * 1000),
);

const recoveryWindowDaysSchema = jsonSafePositiveIntegerSchema.max(maximumRecoveryWindowDays);

/**
 * Policy contract for recoverable deletion. Carries no archive metadata; it may
 * carry the recovery window that bounds restoring a deleted record.
 */
export const deleteRecordLifecyclePolicySchema = z
  .object({
    ...policyBaseFields,
    action: z.literal("delete"),
    // Absent means no recovery window is configured, so restore is refused.
    // It is never read as unlimited recovery.
    recoveryWindowDays: recoveryWindowDaysSchema.optional(),
  })
  .strict()
  .superRefine(validatePolicyLimitsConsistency);

export type DeleteRecordLifecyclePolicy = z.infer<typeof deleteRecordLifecyclePolicySchema>;

/**
 * Policy contract for durable workflow archival followed by protected deletion.
 * Carries exact typed workflow reference, expected revision, connection instance and destination.
 */
export const archiveWorkflowRecordLifecyclePolicySchema = z
  .object({
    ...policyBaseFields,
    action: z.literal("archive_workflow"),
    archiveWorkflowId: workflowIdSchema,
    expectedWorkflowRevision: jsonSafeRevisionSchema,
    archiveConnectionInstanceId: connectionInstanceIdSchema,
    archiveDestination: archiveDestinationReferenceSchema,
    expectedConnectionRevision: jsonSafeRevisionSchema,
    expectedDestinationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    expectedConnectionHealthOutcome: z.literal("healthy"),
  })
  .strict()
  .superRefine(validatePolicyLimitsConsistency)
  .superRefine((policy, context) => {
    if (/^https?:\/\/|postgres:\/\/|select\s|insert\s/i.test(policy.archiveDestination)) {
      context.addIssue({
        code: "custom",
        path: ["archiveDestination"],
        message:
          "archiveDestination cannot contain URLs, connection strings, or SQL escape hatches",
      });
    }
  });

export type ArchiveWorkflowRecordLifecyclePolicy = z.infer<
  typeof archiveWorkflowRecordLifecyclePolicySchema
>;

/**
 * Discriminated union of record-type lifecycle policies.
 */
export const recordTypeLifecyclePolicySchema = z.discriminatedUnion("action", [
  deleteRecordLifecyclePolicySchema,
  archiveWorkflowRecordLifecyclePolicySchema,
]);

export type RecordTypeLifecyclePolicy = z.infer<typeof recordTypeLifecyclePolicySchema>;

/**
 * Evidence item for an exact active registered workflow in runtime.
 * Scope-bound to matching organizationId and authorizedApplicationIds.
 */
export const registeredWorkflowEvidenceSchema = z
  .object({
    workflowId: workflowIdSchema,
    workflowRevision: jsonSafeRevisionSchema,
    organizationId: organizationIdSchema,
    authorizedApplicationIds: z.array(applicationRootIdSchema).default([]),
    state: z.literal("active"),
  })
  .strict();
export type RegisteredWorkflowEvidence = z.infer<typeof registeredWorkflowEvidenceSchema>;

/**
 * Evidence item for an exact active connection instance in runtime.
 * Scope-bound to matching organizationId, closed destinationKey, and canonical authorizedApplicationIds (min 1).
 */
export const activeConnectionEvidenceSchema = z
  .object({
    connectionInstanceId: connectionInstanceIdSchema,
    destinationKey: archiveDestinationReferenceSchema,
    destinationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    organizationId: organizationIdSchema,
    authorizedApplicationIds: z.array(applicationRootIdSchema).min(1),
    state: z.literal("active"),
    revision: jsonSafeRevisionSchema,
    lastHealthOutcome: z.literal("healthy"),
    verifiedAt: timestampSchema.optional(),
  })
  .strict();
export type ActiveConnectionEvidence = z.infer<typeof activeConnectionEvidenceSchema>;

/**
 * Scope-bound live readiness evidence contract required for activation and live policy validation.
 * Proves that exact workflows and connections are active and bound to the matching organisation.
 */
export const lifecycleReadinessEvidenceSchema = z
  .object({
    organizationId: organizationIdSchema,
    registeredWorkflows: z.array(registeredWorkflowEvidenceSchema),
    activeConnections: z.array(activeConnectionEvidenceSchema),
  })
  .strict();
export type LifecycleReadinessEvidence = z.infer<typeof lifecycleReadinessEvidenceSchema>;

/**
 * The immutable facts a caller must carry into a recovery decision.  The
 * record-type identity is intentionally paired with the stored-policy target:
 * a storage contract is not itself an authority to restore another type.
 */
export const recordRecoveryPolicySchema = z
  .object({
    recordTypeId: recordTypeIdSchema,
    policy: recordTypeLifecyclePolicySchema,
    recoveryWindowDays: recoveryWindowDaysSchema,
  })
  .strict();
export type RecordRecoveryPolicy = z.infer<typeof recordRecoveryPolicySchema>;

export const recordRecoveryEligibilityReasonSchema = z.enum([
  "malformed_input",
  "policy_unavailable",
  "policy_revision_stale",
  "scope_mismatch",
  "recovery_action_ineligible",
  "readiness_unavailable",
  "recovery_window_expired",
]);
export type RecordRecoveryEligibilityReason = z.infer<
  typeof recordRecoveryEligibilityReasonSchema
>;

/**
 * Pure, state-free recovery decision input.  The caller supplies the current
 * stored policy projection and readiness fact; this contract deliberately has
 * no record ID, mutation command, totals, effects, or receipt fields.
 *
 * `governingPolicy` is explicitly nullable so an absent stored policy is the
 * distinct `policy_unavailable` refusal rather than a malformed input, and so
 * an unavailable policy can never be read as an unrestricted recovery.
 */
export const recordRecoveryEligibilityInputSchema = z
  .object({
    organizationId: organizationIdSchema,
    storageContractId: storageContractIdSchema,
    applicationRootId: applicationRootIdSchema.nullable(),
    recordTypeId: recordTypeIdSchema,
    deletedAt: timestampSchema,
    decidedAt: timestampSchema,
    expectedPolicyRevision: jsonSafeRevisionSchema,
    readinessAvailable: z.boolean(),
    governingPolicy: recordRecoveryPolicySchema.nullable(),
  })
  .strict();
export type RecordRecoveryEligibilityInput = z.infer<typeof recordRecoveryEligibilityInputSchema>;

export const recordRecoveryEligibilityDecisionSchema = z.discriminatedUnion("allowed", [
  z
    .object({
      allowed: z.literal(true),
      reason: z.null(),
      governingPolicyRevision: jsonSafeRevisionSchema,
    })
    .strict(),
  z
    .object({
      allowed: z.literal(false),
      reason: recordRecoveryEligibilityReasonSchema,
      governingPolicyRevision: jsonSafeRevisionSchema.nullable(),
    })
    .strict(),
]);
export type RecordRecoveryEligibilityDecision = z.infer<
  typeof recordRecoveryEligibilityDecisionSchema
>;

/**
 * Protected Record-owned snapshot taken immediately after the Module
 * activation write and before that write is accepted.  It contains no mutable
 * request input: target completeness comes from the repository and every
 * policy is checked again by the Module caller.
 */
export const applicationLifecyclePolicyReadinessSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    policies: z.array(recordTypeLifecyclePolicySchema).min(1),
    organizationLimits: organizationLifecycleLimitsSchema,
    readinessEvidence: lifecycleReadinessEvidenceSchema,
  })
  .strict();
export type ApplicationLifecyclePolicyReadiness = z.infer<
  typeof applicationLifecyclePolicyReadinessSchema
>;

const refusedRecovery = (
  reason: RecordRecoveryEligibilityReason,
  governingPolicyRevision: number | null,
): RecordRecoveryEligibilityDecision => ({
  allowed: false,
  reason,
  governingPolicyRevision,
});

/**
 * Platform identifiers are compared case-insensitively, exactly like every
 * other stored-identifier comparison in this repository: a database projection
 * and a request value can differ in hexadecimal case alone, and that
 * difference is not a scope mismatch.
 */
const sameIdentifier = (left: string | null, right: string | null): boolean =>
  left === null || right === null
    ? left === right
    : left.toLowerCase() === right.toLowerCase();

const millisecondsPerDay = 24 * 60 * 60 * 1000;

/**
 * Determines recovery eligibility without observing or changing Record state.
 * Times are interpreted as UTC instants and a record is recoverable only while
 * the elapsed interval is strictly shorter than its configured window.
 *
 * Every refusal is one of the closed `recordRecoveryEligibilityReasonSchema`
 * values and carries the governing policy revision whenever one was resolved,
 * so a caller can report exactly which revision refused it.
 */
export const decideRecordRecoveryEligibility = (
  candidate: unknown,
): RecordRecoveryEligibilityDecision => {
  const input = recordRecoveryEligibilityInputSchema.safeParse(candidate);
  if (!input.success) return refusedRecovery("malformed_input", null);

  const { governingPolicy, deletedAt, decidedAt } = input.data;
  if (governingPolicy === null) return refusedRecovery("policy_unavailable", null);

  const policy = governingPolicy.policy;
  const policyRevision = policy.policyRevision;
  if (input.data.expectedPolicyRevision !== policyRevision)
    return refusedRecovery("policy_revision_stale", policyRevision);
  if (
    !sameIdentifier(policy.organizationId, input.data.organizationId) ||
    !sameIdentifier(policy.storageContractId, input.data.storageContractId) ||
    !sameIdentifier(policy.applicationRootId, input.data.applicationRootId) ||
    !sameIdentifier(governingPolicy.recordTypeId, input.data.recordTypeId)
  )
    return refusedRecovery("scope_mismatch", policyRevision);
  // Recoverable deletion is the only end-of-life action this decision allows.
  // An archive-workflow policy removes its source through the durable archive
  // path owned by #560/#568, so it is refused here with a stable reason rather
  // than silently reinterpreted as a recoverable delete.
  if (policy.action !== "delete")
    return refusedRecovery("recovery_action_ineligible", policyRevision);
  if (!input.data.readinessAvailable)
    return refusedRecovery("readiness_unavailable", policyRevision);

  const deletedAtMs = new Date(deletedAt).getTime();
  const decidedAtMs = new Date(decidedAt).getTime();
  if (!Number.isFinite(deletedAtMs) || !Number.isFinite(decidedAtMs))
    return refusedRecovery("malformed_input", policyRevision);
  // A decision taken before the deletion it decides on is not an expired
  // window; it is an inconsistent input and is reported as one.
  if (decidedAtMs < deletedAtMs) return refusedRecovery("malformed_input", policyRevision);

  // `recoveryWindowDays` is bounded by `maximumRecoveryWindowDays`, so this
  // product is always a JSON-safe integer and can never degrade into an
  // unbounded recovery window.
  const recoveryWindowMs = governingPolicy.recoveryWindowDays * millisecondsPerDay;
  if (decidedAtMs - deletedAtMs >= recoveryWindowMs)
    return refusedRecovery("recovery_window_expired", policyRevision);

  return { allowed: true, reason: null, governingPolicyRevision: policyRevision };
};

export interface PolicyValidationIssue {
  code: string;
  message: string;
  path?: (string | number)[];
}

export interface PolicyValidationResult {
  valid: boolean;
  success: boolean;
  issues: PolicyValidationIssue[];
  errors: string[];
}

/**
 * Definition-only authoring validation: validates declared policy shape
 * without requiring live organisation limits or live runtime connection instances.
 */
export const validateRecordTypeLifecyclePolicyDefinition = (
  policyCandidate: unknown,
): PolicyValidationResult => {
  const issues: PolicyValidationIssue[] = [];
  const parsedPolicy = recordTypeLifecyclePolicySchema.safeParse(policyCandidate);
  if (!parsedPolicy.success) {
    for (const issue of parsedPolicy.error.issues) {
      issues.push({
        code: issue.code,
        message: issue.message,
        path: issue.path as (string | number)[],
      });
    }
  }
  const isValid = issues.length === 0;
  return {
    valid: isValid,
    success: isValid,
    issues,
    errors: issues.map((i) => i.message),
  };
};

/**
 * Definition-only validation against organisation limits: checks declared policy shape
 * and static ceilings/actions without requiring live concurrency (expectedSettingsRevision)
 * or live runtime readiness evidence.
 */
export const validateRecordTypeLifecyclePolicyDefinitionAgainstLimits = (
  policyCandidate: unknown,
  organizationLimitsCandidate: unknown,
): PolicyValidationResult => {
  const issues: PolicyValidationIssue[] = [];

  const parsedPolicy = recordTypeLifecyclePolicySchema.safeParse(policyCandidate);
  if (!parsedPolicy.success) {
    for (const issue of parsedPolicy.error.issues) {
      issues.push({
        code: issue.code,
        message: issue.message,
        path: issue.path as (string | number)[],
      });
    }
  }

  const parsedLimits = organizationLifecycleLimitsSchema.safeParse(organizationLimitsCandidate);
  if (!parsedLimits.success) {
    for (const issue of parsedLimits.error.issues) {
      issues.push({
        code: issue.code,
        message: issue.message,
        path: issue.path as (string | number)[],
      });
    }
  }

  if (!parsedPolicy.success || !parsedLimits.success) {
    return {
      valid: false,
      success: false,
      issues,
      errors: issues.map((i) => i.message),
    };
  }

  const policy = parsedPolicy.data;
  const limits = parsedLimits.data;

  // 1. Cross-organisation isolation check
  if (policy.organizationId !== limits.organizationId) {
    issues.push({
      code: "organization_isolation_violation",
      path: ["organizationId"],
      message: `Policy organizationId (${policy.organizationId}) does not match organisation limits organizationId (${limits.organizationId}); cross-organisation policy application is strictly forbidden`,
    });
  }

  // 2. Action permitted check
  if (!limits.allowedActions.includes(policy.action)) {
    issues.push({
      code: "action_not_allowed",
      path: ["action"],
      message: `Action "${policy.action}" is not permitted by organisation limits (allowed: ${limits.allowedActions.join(", ")})`,
    });
  }

  // 3. Age ceiling check
  if (policy.maxAgeDays !== null) {
    if (
      limits.maxRetentionDays !== null &&
      limits.maxRetentionDays !== undefined &&
      policy.maxAgeDays > limits.maxRetentionDays
    ) {
      issues.push({
        code: "max_age_exceeds_limit",
        path: ["maxAgeDays"],
        message: `Policy maxAgeDays (${policy.maxAgeDays}) exceeds organisation limit (${limits.maxRetentionDays})`,
      });
    }
  } else if (policy.allowUnlimitedAge && !limits.allowUnlimitedRetentionDays) {
    issues.push({
      code: "unlimited_age_not_allowed",
      path: ["allowUnlimitedAge"],
      message: "Policy requests unlimited age retention, but organisation limits forbid it",
    });
  }

  // 4. Count ceiling check
  if (policy.maxCount !== null) {
    if (
      limits.maxRecordCount !== null &&
      limits.maxRecordCount !== undefined &&
      policy.maxCount > limits.maxRecordCount
    ) {
      issues.push({
        code: "max_count_exceeds_limit",
        path: ["maxCount"],
        message: `Policy maxCount (${policy.maxCount}) exceeds organisation limit (${limits.maxRecordCount})`,
      });
    }
  } else if (policy.allowUnlimitedCount && !limits.allowUnlimitedRecordCount) {
    issues.push({
      code: "unlimited_count_not_allowed",
      path: ["allowUnlimitedCount"],
      message: "Policy requests unlimited record count, but organisation limits forbid it",
    });
  }

  // 5. Destination check in allowedArchiveDestinations (if archive_workflow)
  if (policy.action === "archive_workflow") {
    if (!limits.allowedArchiveDestinations.includes(policy.archiveDestination)) {
      issues.push({
        code: "archive_destination_not_allowed",
        path: ["archiveDestination"],
        message: `Archive destination "${policy.archiveDestination}" is not in organisation's allowed destinations (allowed: ${limits.allowedArchiveDestinations.join(", ") || "none"})`,
      });
    }
  }

  const isValid = issues.length === 0;
  return {
    valid: isValid,
    success: isValid,
    issues,
    errors: issues.map((i) => i.message),
  };
};

/**
 * Live policy and activation validation: validates a record-type policy against
 * the organisation's protected settings limits, mandatory expectedSettingsRevision,
 * and typed runtime readiness evidence.
 *
 * Enforces:
 * 1. expectedSettingsRevision is MANDATORY, validated as a JSON-safe revision, and must match limits.settingsRevision.
 * 2. Policy and limits conform to their strict contracts.
 * 3. Organisation isolation: policy.organizationId MUST match organizationLimits.organizationId.
 * 4. Ceilings: maxAgeDays <= maxRetentionDays, maxCount <= maxRecordCount.
 * 5. Unlimited permissions: allowUnlimitedAge / allowUnlimitedCount require organisation permission.
 * 6. Action permission: policy.action is in organisationLimits.allowedActions.
 * 7. For archive_workflow:
 *    - Destination is in organisationLimits.allowedArchiveDestinations.
 *    - readinessEvidence is mandatory and must match policy.organizationId.
 *    - Exact archiveWorkflowId and expectedWorkflowRevision must be in registeredWorkflows with state "active".
 *    - Exact archiveConnectionInstanceId and archiveDestination must be in activeConnections with matching organisationId.
 *    - Permanent application root scope: policy.applicationRootId must be present in authorizedApplicationIds
 *      for both workflow and connection; organisation-shared policies cannot activate archive_workflow without application scope.
 *    - Unavailable archival NEVER silently falls back to deletion.
 */
export interface ValidateRecordTypeLifecyclePolicyOptions {
  expectedSettingsRevision: number;
}

export const validateRecordTypeLifecyclePolicy = (
  policyCandidate: unknown,
  organizationLimitsCandidate: unknown,
  readinessEvidenceCandidate: unknown,
  expectedSettingsRevisionCandidate: unknown,
): PolicyValidationResult => {
  const issues: PolicyValidationIssue[] = [];

  // 1. Mandatory expected settings revision validation
  let rawExpectedRevision: unknown = expectedSettingsRevisionCandidate;
  if (
    expectedSettingsRevisionCandidate !== null &&
    typeof expectedSettingsRevisionCandidate === "object" &&
    "expectedSettingsRevision" in expectedSettingsRevisionCandidate
  ) {
    rawExpectedRevision = (expectedSettingsRevisionCandidate as Record<string, unknown>)
      .expectedSettingsRevision;
  }

  let parsedExpectedRevisionData: number | undefined;
  if (rawExpectedRevision === undefined) {
    issues.push({
      code: "missing_expected_settings_revision",
      path: ["expectedSettingsRevision"],
      message:
        "expectedSettingsRevision is mandatory for live policy validation to prevent stale or concurrent settings mutations",
    });
  } else {
    const parsedExpectedRevision = jsonSafeRevisionSchema.safeParse(rawExpectedRevision);
    if (!parsedExpectedRevision.success) {
      issues.push({
        code: "invalid_expected_settings_revision",
        path: ["expectedSettingsRevision"],
        message: "expectedSettingsRevision must be a valid positive integer revision",
      });
    } else {
      parsedExpectedRevisionData = parsedExpectedRevision.data;
    }
  }

  const parsedPolicy = recordTypeLifecyclePolicySchema.safeParse(policyCandidate);
  if (!parsedPolicy.success) {
    for (const issue of parsedPolicy.error.issues) {
      issues.push({
        code: issue.code,
        message: issue.message,
        path: issue.path as (string | number)[],
      });
    }
  }

  const parsedLimits = organizationLifecycleLimitsSchema.safeParse(organizationLimitsCandidate);
  if (!parsedLimits.success) {
    for (const issue of parsedLimits.error.issues) {
      issues.push({
        code: issue.code,
        message: issue.message,
        path: issue.path as (string | number)[],
      });
    }
  }

  if (
    parsedExpectedRevisionData !== undefined &&
    parsedLimits.success &&
    parsedLimits.data.settingsRevision !== parsedExpectedRevisionData
  ) {
    issues.push({
      code: "stale_settings_revision",
      path: ["settingsRevision"],
      message: `Organisation limits settings revision (${parsedLimits.data.settingsRevision}) does not match expected revision (${parsedExpectedRevisionData}); settings were concurrently modified or stale`,
    });
  }

  if (!parsedPolicy.success || !parsedLimits.success) {
    return {
      valid: false,
      success: false,
      issues,
      errors: issues.map((i) => i.message),
    };
  }

  const policy = parsedPolicy.data;
  const limits = parsedLimits.data;

  // Cross-organisation isolation check
  if (policy.organizationId !== limits.organizationId) {
    issues.push({
      code: "organization_isolation_violation",
      path: ["organizationId"],
      message: `Policy organizationId (${policy.organizationId}) does not match organisation limits organizationId (${limits.organizationId}); cross-organisation policy application is strictly forbidden`,
    });
  }

  // Action permitted check
  if (!limits.allowedActions.includes(policy.action)) {
    issues.push({
      code: "action_not_allowed",
      path: ["action"],
      message: `Action "${policy.action}" is not permitted by organisation limits (allowed: ${limits.allowedActions.join(", ")})`,
    });
  }

  // Age ceiling check
  if (policy.maxAgeDays !== null) {
    if (
      limits.maxRetentionDays !== null &&
      limits.maxRetentionDays !== undefined &&
      policy.maxAgeDays > limits.maxRetentionDays
    ) {
      issues.push({
        code: "max_age_exceeds_limit",
        path: ["maxAgeDays"],
        message: `Policy maxAgeDays (${policy.maxAgeDays}) exceeds organisation limit (${limits.maxRetentionDays})`,
      });
    }
  } else if (policy.allowUnlimitedAge && !limits.allowUnlimitedRetentionDays) {
    issues.push({
      code: "unlimited_age_not_allowed",
      path: ["allowUnlimitedAge"],
      message: "Policy requests unlimited age retention, but organisation limits forbid it",
    });
  }

  // Count ceiling check
  if (policy.maxCount !== null) {
    if (
      limits.maxRecordCount !== null &&
      limits.maxRecordCount !== undefined &&
      policy.maxCount > limits.maxRecordCount
    ) {
      issues.push({
        code: "max_count_exceeds_limit",
        path: ["maxCount"],
        message: `Policy maxCount (${policy.maxCount}) exceeds organisation limit (${limits.maxRecordCount})`,
      });
    }
  } else if (policy.allowUnlimitedCount && !limits.allowUnlimitedRecordCount) {
    issues.push({
      code: "unlimited_count_not_allowed",
      path: ["allowUnlimitedCount"],
      message: "Policy requests unlimited record count, but organisation limits forbid it",
    });
  }

  // Archive workflow readiness and destination checks
  if (policy.action === "archive_workflow") {
    // Destination check in allowedArchiveDestinations
    if (!limits.allowedArchiveDestinations.includes(policy.archiveDestination)) {
      issues.push({
        code: "archive_destination_not_allowed",
        path: ["archiveDestination"],
        message: `Archive destination "${policy.archiveDestination}" is not in organisation's allowed destinations (allowed: ${limits.allowedArchiveDestinations.join(", ") || "none"})`,
      });
    }

    // Typed readiness evidence check
    if (readinessEvidenceCandidate === undefined || readinessEvidenceCandidate === null) {
      issues.push({
        code: "readiness_evidence_required",
        path: ["action"],
        message:
          "Readiness evidence is required to activate archive_workflow; unavailable workflow archival cannot silently fall back to deletion",
      });
    } else {
      const parsedEvidence = lifecycleReadinessEvidenceSchema.safeParse(readinessEvidenceCandidate);
      if (!parsedEvidence.success) {
        for (const issue of parsedEvidence.error.issues) {
          issues.push({
            code: "invalid_readiness_evidence",
            path: ["readinessEvidence", ...(issue.path as (string | number)[])],
            message: `Invalid readiness evidence: ${issue.message}`,
          });
        }
      } else {
        const evidence = parsedEvidence.data;

        // Evidence organisation isolation check
        if (evidence.organizationId !== policy.organizationId) {
          issues.push({
            code: "readiness_evidence_organization_mismatch",
            path: ["readinessEvidence", "organizationId"],
            message: `Readiness evidence organizationId does not match policy organizationId (evidence: ${evidence.organizationId}, policy: ${policy.organizationId})`,
          });
        }

        // Exact workflow registration check
        const matchingWorkflow = evidence.registeredWorkflows.find(
          (w) =>
            w.workflowId === policy.archiveWorkflowId &&
            w.workflowRevision === policy.expectedWorkflowRevision &&
            w.organizationId === policy.organizationId &&
            w.state === "active",
        );
        if (!matchingWorkflow) {
          issues.push({
            code: "archive_workflow_not_registered",
            path: ["archiveWorkflowId"],
            message: `Active workflow ${policy.archiveWorkflowId} at expected revision ${policy.expectedWorkflowRevision} in organisation ${policy.organizationId} is not registered in runtime workflows; archival cannot fall back to deletion`,
          });
        } else {
          if (policy.applicationRootId === null) {
            issues.push({
              code: "archive_workflow_scope_mismatch",
              path: ["archiveWorkflowId"],
              message: `Organisation-shared policy (${policy.policyId}) cannot activate archive_workflow because registered workflows require permanent application scope`,
            });
          } else if (
            !matchingWorkflow.authorizedApplicationIds.includes(policy.applicationRootId)
          ) {
            issues.push({
              code: "archive_workflow_scope_mismatch",
              path: ["archiveWorkflowId"],
              message: `Registered workflow ${policy.archiveWorkflowId} is not authorized for permanent application root ${policy.applicationRootId}`,
            });
          }
        }

        // Exact connection instance check
        const matchingConnection = evidence.activeConnections.find(
          (c) =>
            c.connectionInstanceId === policy.archiveConnectionInstanceId &&
            c.destinationKey === policy.archiveDestination &&
            c.organizationId === policy.organizationId &&
            c.state === "active",
        );
        if (!matchingConnection) {
          issues.push({
            code: "archive_connection_not_active",
            path: ["archiveConnectionInstanceId"],
            message: `Active connection instance ${policy.archiveConnectionInstanceId} for destination "${policy.archiveDestination}" in organisation ${policy.organizationId} is unavailable; archival cannot fall back to deletion`,
          });
        } else {
          if (matchingConnection.revision !== policy.expectedConnectionRevision) {
            issues.push({
              code: "archive_connection_stale_revision",
              path: ["archiveConnectionInstanceId"],
              message: `Active connection instance ${policy.archiveConnectionInstanceId} revision (${matchingConnection.revision}) does not match expected (${policy.expectedConnectionRevision})`,
            });
          }
          if (matchingConnection.destinationFingerprint !== policy.expectedDestinationFingerprint) {
            issues.push({
              code: "archive_connection_stale_fingerprint",
              path: ["archiveConnectionInstanceId"],
              message: `Active connection instance ${policy.archiveConnectionInstanceId} destination fingerprint does not match expected`,
            });
          }
          if (matchingConnection.lastHealthOutcome !== policy.expectedConnectionHealthOutcome) {
            issues.push({
              code: "archive_connection_unhealthy",
              path: ["archiveConnectionInstanceId"],
              message: `Active connection instance ${policy.archiveConnectionInstanceId} health outcome (${matchingConnection.lastHealthOutcome}) does not match required (${policy.expectedConnectionHealthOutcome})`,
            });
          }
          if (policy.applicationRootId === null) {
            issues.push({
              code: "archive_connection_scope_mismatch",
              path: ["archiveConnectionInstanceId"],
              message: `Organisation-shared policy (${policy.policyId}) cannot activate archive_workflow because connection instances require permanent application scope`,
            });
          } else if (
            !matchingConnection.authorizedApplicationIds.includes(policy.applicationRootId)
          ) {
            issues.push({
              code: "archive_connection_scope_mismatch",
              path: ["archiveConnectionInstanceId"],
              message: `Active connection instance ${policy.archiveConnectionInstanceId} is not authorized for permanent application root ${policy.applicationRootId}`,
            });
          }
        }
      }
    }
  }

  const isValid = issues.length === 0;
  return {
    valid: isValid,
    success: isValid,
    issues,
    errors: issues.map((i) => i.message),
  };
};

/**
 * Candidate record input schema for evaluating lifecycle selection.
 * Requires expectedRecordRevision to ensure retries do not delete a newer record.
 */
export const lifecycleCandidateRecordSchema = z
  .object({
    recordId: recordIdSchema,
    expectedRecordRevision: jsonSafeRevisionSchema,
    createdAt: timestampSchema,
    isHeld: z.boolean().default(false),
    isProtected: z.boolean().default(false),
  })
  .strict();
export type LifecycleCandidateRecord = z.infer<typeof lifecycleCandidateRecordSchema>;

/**
 * Reason(s) why a record became due for lifecycle removal.
 */
export const recordLifecycleDueReasonSchema = z.enum(["age", "count_excess", "both"]);
export type RecordLifecycleDueReason = z.infer<typeof recordLifecycleDueReasonSchema>;

const validateItemReasonsConsistency = (
  item: {
    dueReasons: ("age" | "count_excess")[];
    primaryReason: RecordLifecycleDueReason;
  },
  context: z.RefinementCtx,
) => {
  const set = new Set(item.dueReasons);
  if (set.size !== item.dueReasons.length) {
    context.addIssue({
      code: "custom",
      path: ["dueReasons"],
      message: "dueReasons cannot contain duplicates",
    });
  }
  if (item.primaryReason === "both" && (!set.has("age") || !set.has("count_excess"))) {
    context.addIssue({
      code: "custom",
      path: ["primaryReason"],
      message: "primaryReason 'both' requires both 'age' and 'count_excess' in dueReasons",
    });
  }
  if (item.primaryReason === "age" && (set.has("count_excess") || !set.has("age"))) {
    context.addIssue({
      code: "custom",
      path: ["primaryReason"],
      message: "primaryReason 'age' requires exactly ['age'] in dueReasons",
    });
  }
  if (item.primaryReason === "count_excess" && (set.has("age") || !set.has("count_excess"))) {
    context.addIssue({
      code: "custom",
      path: ["primaryReason"],
      message: "primaryReason 'count_excess' requires exactly ['count_excess'] in dueReasons",
    });
  }
};

/**
 * Actionable handoff item for recoverable deletion.
 */
export const dueDeleteRecordHandoffItemSchema = z
  .object({
    recordId: recordIdSchema,
    expectedRecordRevision: jsonSafeRevisionSchema,
    dueReasons: z.array(z.enum(["age", "count_excess"])).min(1),
    primaryReason: recordLifecycleDueReasonSchema,
    action: z.literal("delete"),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine(validateItemReasonsConsistency);

/**
 * Actionable handoff item for durable workflow archival.
 */
export const dueArchiveRecordHandoffItemSchema = z
  .object({
    recordId: recordIdSchema,
    expectedRecordRevision: jsonSafeRevisionSchema,
    dueReasons: z.array(z.enum(["age", "count_excess"])).min(1),
    primaryReason: recordLifecycleDueReasonSchema,
    action: z.literal("archive_workflow"),
    archiveWorkflowId: workflowIdSchema,
    expectedWorkflowRevision: jsonSafeRevisionSchema,
    archiveConnectionInstanceId: connectionInstanceIdSchema,
    archiveDestination: archiveDestinationReferenceSchema,
    expectedConnectionRevision: jsonSafeRevisionSchema,
    expectedDestinationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    expectedConnectionHealthOutcome: z.literal("healthy"),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine(validateItemReasonsConsistency);

/**
 * Discriminated union of due record items for executor #117.
 */
export const dueRecordHandoffItemSchema = z.discriminatedUnion("action", [
  dueDeleteRecordHandoffItemSchema,
  dueArchiveRecordHandoffItemSchema,
]);
export type DueRecordHandoffItem = z.infer<typeof dueRecordHandoffItemSchema>;

/**
 * Due record whose removal is blocked by active legal holds or recovery protections.
 */
export const blockedRemovalRecordSchema = z
  .object({
    recordId: recordIdSchema,
    expectedRecordRevision: jsonSafeRevisionSchema,
    dueReasons: z.array(z.enum(["age", "count_excess"])).min(1),
    primaryReason: recordLifecycleDueReasonSchema,
    blockReason: z.enum(["legal_hold", "recovery_protection", "held_and_protected"]),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine(validateItemReasonsConsistency);
export type BlockedRemovalRecord = z.infer<typeof blockedRemovalRecordSchema>;

/**
 * Lifecycle evaluation status reporting truthful system state.
 */
export const lifecycleEvaluationStatusSchema = z.enum([
  "compliant",
  "pending_removal",
  "blocked_over_limit",
  "pending_and_blocked",
]);
export type LifecycleEvaluationStatus = z.infer<typeof lifecycleEvaluationStatusSchema>;

/**
 * Truthful status report reflecting both pending due work and blocked-removal conditions.
 */
export const lifecycleStatusReportSchema = z
  .object({
    status: lifecycleEvaluationStatusSchema,
    isOverLimit: z.boolean(),
    pendingRemovalCount: z.number().int().nonnegative(),
    blockedRemovalCount: z.number().int().nonnegative(),
    excessCount: z.number().int().nonnegative(),
    expiredAgeCount: z.number().int().nonnegative(),
    blockedRecordIds: z.array(recordIdSchema),
    description: z.string(),
  })
  .strict();
export type LifecycleStatusReport = z.infer<typeof lifecycleStatusReportSchema>;

/**
 * Complete, JSON-transportable lifecycle handoff package for #117 executor.
 * Strict invariants guarantee semantic consistency: counts match arrays,
 * record IDs are unique and disjoint, and reasons match throughout.
 */
export const recordLifecycleHandoffSchema = z
  .object({
    policyId: recordLifecyclePolicyIdSchema,
    policyRevision: jsonSafeRevisionSchema,
    organizationId: organizationIdSchema,
    storageContractId: storageContractIdSchema,
    applicationRootId: applicationRootIdSchema.nullable(),
    action: recordLifecycleActionSchema,
    archiveMetadata: z
      .object({
        archiveWorkflowId: workflowIdSchema,
        expectedWorkflowRevision: jsonSafeRevisionSchema,
        archiveConnectionInstanceId: connectionInstanceIdSchema,
        archiveDestination: archiveDestinationReferenceSchema,
        expectedConnectionRevision: jsonSafeRevisionSchema,
        expectedDestinationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        expectedConnectionHealthOutcome: z.literal("healthy"),
      })
      .strict()
      .optional(),
    evaluatedAt: timestampSchema,
    totalRetainedCount: z.number().int().nonnegative(),
    dueCount: z.number().int().nonnegative(),
    dueRecords: z.array(dueRecordHandoffItemSchema),
    blockedRecords: z.array(blockedRemovalRecordSchema),
    statusReport: lifecycleStatusReportSchema,
  })
  .strict()
  .superRefine((handoff, context) => {
    // 1. Action and archive metadata correspondence between aggregate and items
    if (handoff.action === "archive_workflow" && !handoff.archiveMetadata) {
      context.addIssue({
        code: "custom",
        path: ["archiveMetadata"],
        message: "archiveMetadata is required when action is 'archive_workflow'",
      });
    }
    if (handoff.action === "delete" && handoff.archiveMetadata !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["archiveMetadata"],
        message: "archiveMetadata cannot be present when action is 'delete'",
      });
    }

    for (let i = 0; i < handoff.dueRecords.length; i++) {
      const item = handoff.dueRecords[i]!;
      if (item.action !== handoff.action) {
        context.addIssue({
          code: "custom",
          path: ["dueRecords", i, "action"],
          message: `Due record action (${item.action}) must match handoff action (${handoff.action})`,
        });
      }
      if (handoff.action === "archive_workflow" && handoff.archiveMetadata) {
        if (item.action === "archive_workflow") {
          if (item.archiveWorkflowId !== handoff.archiveMetadata.archiveWorkflowId) {
            context.addIssue({
              code: "custom",
              path: ["dueRecords", i, "archiveWorkflowId"],
              message: `Due record archiveWorkflowId (${item.archiveWorkflowId}) does not match handoff archiveMetadata.archiveWorkflowId (${handoff.archiveMetadata.archiveWorkflowId})`,
            });
          }
          if (item.expectedWorkflowRevision !== handoff.archiveMetadata.expectedWorkflowRevision) {
            context.addIssue({
              code: "custom",
              path: ["dueRecords", i, "expectedWorkflowRevision"],
              message: `Due record expectedWorkflowRevision (${item.expectedWorkflowRevision}) does not match handoff archiveMetadata.expectedWorkflowRevision (${handoff.archiveMetadata.expectedWorkflowRevision})`,
            });
          }
          if (
            item.archiveConnectionInstanceId !== handoff.archiveMetadata.archiveConnectionInstanceId
          ) {
            context.addIssue({
              code: "custom",
              path: ["dueRecords", i, "archiveConnectionInstanceId"],
              message: `Due record archiveConnectionInstanceId (${item.archiveConnectionInstanceId}) does not match handoff archiveMetadata.archiveConnectionInstanceId (${handoff.archiveMetadata.archiveConnectionInstanceId})`,
            });
          }
          if (item.archiveDestination !== handoff.archiveMetadata.archiveDestination) {
            context.addIssue({
              code: "custom",
              path: ["dueRecords", i, "archiveDestination"],
              message: `Due record archiveDestination (${item.archiveDestination}) does not match handoff archiveMetadata.archiveDestination (${handoff.archiveMetadata.archiveDestination})`,
            });
          }
          if (
            item.expectedConnectionRevision !== handoff.archiveMetadata.expectedConnectionRevision
          ) {
            context.addIssue({
              code: "custom",
              path: ["dueRecords", i, "expectedConnectionRevision"],
              message: `Due record expectedConnectionRevision (${item.expectedConnectionRevision}) does not match handoff archiveMetadata.expectedConnectionRevision (${handoff.archiveMetadata.expectedConnectionRevision})`,
            });
          }
          if (
            item.expectedDestinationFingerprint !==
            handoff.archiveMetadata.expectedDestinationFingerprint
          ) {
            context.addIssue({
              code: "custom",
              path: ["dueRecords", i, "expectedDestinationFingerprint"],
              message: `Due record expectedDestinationFingerprint (${item.expectedDestinationFingerprint}) does not match handoff archiveMetadata.expectedDestinationFingerprint (${handoff.archiveMetadata.expectedDestinationFingerprint})`,
            });
          }
          if (
            item.expectedConnectionHealthOutcome !==
            handoff.archiveMetadata.expectedConnectionHealthOutcome
          ) {
            context.addIssue({
              code: "custom",
              path: ["dueRecords", i, "expectedConnectionHealthOutcome"],
              message: `Due record expectedConnectionHealthOutcome (${item.expectedConnectionHealthOutcome}) does not match handoff archiveMetadata.expectedConnectionHealthOutcome (${handoff.archiveMetadata.expectedConnectionHealthOutcome})`,
            });
          }
        }
      }
    }

    // 2. Sane totalRetainedCount
    if (handoff.totalRetainedCount < handoff.dueCount) {
      context.addIssue({
        code: "custom",
        path: ["totalRetainedCount"],
        message: `totalRetainedCount (${handoff.totalRetainedCount}) cannot be less than dueCount (${handoff.dueCount})`,
      });
    }

    // 3. Counts matching array lengths and truthful statusReport derivation
    if (handoff.dueCount !== handoff.dueRecords.length + handoff.blockedRecords.length) {
      context.addIssue({
        code: "custom",
        path: ["dueCount"],
        message: `dueCount (${handoff.dueCount}) does not match sum of dueRecords (${handoff.dueRecords.length}) and blockedRecords (${handoff.blockedRecords.length})`,
      });
    }
    if (handoff.statusReport.pendingRemovalCount !== handoff.dueRecords.length) {
      context.addIssue({
        code: "custom",
        path: ["statusReport", "pendingRemovalCount"],
        message: "statusReport.pendingRemovalCount does not match dueRecords.length",
      });
    }
    if (handoff.statusReport.blockedRemovalCount !== handoff.blockedRecords.length) {
      context.addIssue({
        code: "custom",
        path: ["statusReport", "blockedRemovalCount"],
        message: "statusReport.blockedRemovalCount does not match blockedRecords.length",
      });
    }

    const expectedStatus: LifecycleEvaluationStatus =
      handoff.dueRecords.length === 0 && handoff.blockedRecords.length === 0
        ? "compliant"
        : handoff.dueRecords.length > 0 && handoff.blockedRecords.length === 0
          ? "pending_removal"
          : handoff.dueRecords.length === 0 && handoff.blockedRecords.length > 0
            ? "blocked_over_limit"
            : "pending_and_blocked";

    if (handoff.statusReport.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["statusReport", "status"],
        message: `statusReport.status (${handoff.statusReport.status}) does not match expected status (${expectedStatus}) derived from pending and blocked counts`,
      });
    }

    const expectedIsOverLimit = handoff.blockedRecords.length > 0;
    if (handoff.statusReport.isOverLimit !== expectedIsOverLimit) {
      context.addIssue({
        code: "custom",
        path: ["statusReport", "isOverLimit"],
        message: `statusReport.isOverLimit (${handoff.statusReport.isOverLimit}) must be ${expectedIsOverLimit} based on blocked records`,
      });
    }

    // Derived excessCount and expiredAgeCount from canonical due/blocked item reasons
    let derivedExcessCount = 0;
    let derivedExpiredAgeCount = 0;
    for (const item of handoff.dueRecords) {
      if (item.dueReasons.includes("count_excess")) {
        derivedExcessCount++;
      }
      if (item.dueReasons.includes("age")) {
        derivedExpiredAgeCount++;
      }
    }
    for (const item of handoff.blockedRecords) {
      if (item.dueReasons.includes("count_excess")) {
        derivedExcessCount++;
      }
      if (item.dueReasons.includes("age")) {
        derivedExpiredAgeCount++;
      }
    }

    if (handoff.statusReport.excessCount !== derivedExcessCount) {
      context.addIssue({
        code: "custom",
        path: ["statusReport", "excessCount"],
        message: `statusReport.excessCount (${handoff.statusReport.excessCount}) does not match the count of due and blocked records with count_excess reason (${derivedExcessCount})`,
      });
    }

    if (handoff.statusReport.expiredAgeCount !== derivedExpiredAgeCount) {
      context.addIssue({
        code: "custom",
        path: ["statusReport", "expiredAgeCount"],
        message: `statusReport.expiredAgeCount (${handoff.statusReport.expiredAgeCount}) does not match the count of due and blocked records with age reason (${derivedExpiredAgeCount})`,
      });
    }

    // 4. Unique records within arrays and disjoint across due/blocked (canonical lowercase UUIDs)
    const dueCanonicalIds = new Set<string>();
    for (let i = 0; i < handoff.dueRecords.length; i++) {
      const canonicalId = handoff.dueRecords[i]!.recordId.toLowerCase();
      if (dueCanonicalIds.has(canonicalId)) {
        context.addIssue({
          code: "custom",
          path: ["dueRecords", i, "recordId"],
          message: `Duplicate recordId ${handoff.dueRecords[i]!.recordId} in dueRecords`,
        });
      }
      dueCanonicalIds.add(canonicalId);
    }

    const blockedCanonicalIds = new Set<string>();
    for (let i = 0; i < handoff.blockedRecords.length; i++) {
      const canonicalId = handoff.blockedRecords[i]!.recordId.toLowerCase();
      if (blockedCanonicalIds.has(canonicalId)) {
        context.addIssue({
          code: "custom",
          path: ["blockedRecords", i, "recordId"],
          message: `Duplicate recordId ${handoff.blockedRecords[i]!.recordId} in blockedRecords`,
        });
      }
      if (dueCanonicalIds.has(canonicalId)) {
        context.addIssue({
          code: "custom",
          path: ["blockedRecords", i, "recordId"],
          message: `Record ${handoff.blockedRecords[i]!.recordId} is present in both dueRecords and blockedRecords`,
        });
      }
      blockedCanonicalIds.add(canonicalId);
    }

    // Exact blockedRecordIds matching
    if (handoff.statusReport.blockedRecordIds.length !== handoff.blockedRecords.length) {
      context.addIssue({
        code: "custom",
        path: ["statusReport", "blockedRecordIds"],
        message: `statusReport.blockedRecordIds length (${handoff.statusReport.blockedRecordIds.length}) does not match blockedRecords length (${handoff.blockedRecords.length})`,
      });
    } else {
      const seenBlockedReportIds = new Set<string>();
      for (let i = 0; i < handoff.statusReport.blockedRecordIds.length; i++) {
        const cId = handoff.statusReport.blockedRecordIds[i]!.toLowerCase();
        if (seenBlockedReportIds.has(cId)) {
          context.addIssue({
            code: "custom",
            path: ["statusReport", "blockedRecordIds", i],
            message: `Duplicate recordId in statusReport.blockedRecordIds: ${handoff.statusReport.blockedRecordIds[i]}`,
          });
        }
        seenBlockedReportIds.add(cId);
        if (!blockedCanonicalIds.has(cId)) {
          context.addIssue({
            code: "custom",
            path: ["statusReport", "blockedRecordIds", i],
            message: `statusReport.blockedRecordIds contains ${handoff.statusReport.blockedRecordIds[i]} which is not in blockedRecords`,
          });
        }
      }
    }

    // 4. Primary reason and dueReasons consistency
    const checkReasonConsistency = (
      item: {
        dueReasons: ("age" | "count_excess")[];
        primaryReason: RecordLifecycleDueReason;
      },
      pathPrefix: (string | number)[],
    ) => {
      const set = new Set(item.dueReasons);
      if (set.size !== item.dueReasons.length) {
        context.addIssue({
          code: "custom",
          path: [...pathPrefix, "dueReasons"],
          message: "dueReasons cannot contain duplicates",
        });
      }
      if (item.primaryReason === "both" && (!set.has("age") || !set.has("count_excess"))) {
        context.addIssue({
          code: "custom",
          path: [...pathPrefix, "primaryReason"],
          message: "primaryReason 'both' requires both 'age' and 'count_excess' in dueReasons",
        });
      }
      if (item.primaryReason === "age" && (set.has("count_excess") || !set.has("age"))) {
        context.addIssue({
          code: "custom",
          path: [...pathPrefix, "primaryReason"],
          message: "primaryReason 'age' requires exactly ['age'] in dueReasons",
        });
      }
      if (item.primaryReason === "count_excess" && (set.has("age") || !set.has("count_excess"))) {
        context.addIssue({
          code: "custom",
          path: [...pathPrefix, "primaryReason"],
          message: "primaryReason 'count_excess' requires exactly ['count_excess'] in dueReasons",
        });
      }
    };

    for (let i = 0; i < handoff.dueRecords.length; i++) {
      checkReasonConsistency(handoff.dueRecords[i]!, ["dueRecords", i]);
    }
    for (let i = 0; i < handoff.blockedRecords.length; i++) {
      checkReasonConsistency(handoff.blockedRecords[i]!, ["blockedRecords", i]);
    }
  });

export type RecordLifecycleHandoff = z.infer<typeof recordLifecycleHandoffSchema>;

export interface EvaluateRecordLifecycleHandoffInput {
  policy: RecordTypeLifecyclePolicy;
  records: readonly LifecycleCandidateRecord[];
  evaluatedAt?: string | Date;
  /**
   * Total retained records in the exact policy scope. Bounded callers that
   * evaluate one deterministic page must supply this together with
   * `recordOffset`; whole-scope callers may omit both.
   */
  totalRetainedCount?: number;
  /** Zero-based global position of the first supplied record. */
  recordOffset?: number;
}

const compareCanonicalUuids = (a: string, b: string): number => {
  const normA = a.toLowerCase();
  const normB = b.toLowerCase();
  return normA < normB ? -1 : normA > normB ? 1 : 0;
};

/**
 * Selects due records and produces the exact policy/revision handoff for #117 selection/removal.
 *
 * Enforces:
 * - Duplicate candidate record IDs are rejected immediately.
 * - Age is UTC elapsed time since record creation.
 * - Excess candidates are selected oldest-created first, with canonical UUID tie-breaker.
 * - Partitions due records into dueRecords versus blockedRecords.
 * - Reports truthful status and visible over-limit condition when removal is blocked.
 * - Output payload is strictly validated and JSON-transportable.
 */
export const selectDueRecordsForLifecycleHandoff = (
  input: EvaluateRecordLifecycleHandoffInput,
): RecordLifecycleHandoff => {
  if (
    (input.totalRetainedCount === undefined) !==
    (input.recordOffset === undefined)
  ) {
    throw new Error("Bounded lifecycle count and offset must be supplied together");
  }
  const policy = recordTypeLifecyclePolicySchema.parse(input.policy);
  const evaluationDate =
    input.evaluatedAt instanceof Date
      ? input.evaluatedAt
      : input.evaluatedAt
        ? new Date(input.evaluatedAt)
        : new Date();

  if (Number.isNaN(evaluationDate.getTime())) {
    throw new Error(`Invalid evaluatedAt timestamp: ${String(input.evaluatedAt)}`);
  }

  const evaluatedAtIso = evaluationDate.toISOString();
  const evaluationTime = evaluationDate.getTime();

  // Validate candidates and reject duplicate IDs (canonical lowercase UUID comparison)
  const seenCanonicalIds = new Set<string>();
  const validatedRecords: LifecycleCandidateRecord[] = [];
  for (const candidate of input.records) {
    const parsed = lifecycleCandidateRecordSchema.parse(candidate);
    const canonicalId = parsed.recordId.toLowerCase();
    if (seenCanonicalIds.has(canonicalId)) {
      throw new Error(`Duplicate candidate recordId detected: ${parsed.recordId}`);
    }
    seenCanonicalIds.add(canonicalId);
    validatedRecords.push(parsed);
  }

  // Sort candidates oldest-created first; tie-breaker: canonical lowercase UUID comparison
  const sortedRecords = [...validatedRecords].sort((a, b) => {
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    if (timeA !== timeB) {
      return timeA - timeB;
    }
    return compareCanonicalUuids(a.recordId, b.recordId);
  });

  const totalRetainedCount = input.totalRetainedCount ?? sortedRecords.length;
  const recordOffset = input.recordOffset ?? 0;
  if (
    !Number.isSafeInteger(totalRetainedCount) ||
    totalRetainedCount < 0 ||
    !Number.isSafeInteger(recordOffset) ||
    recordOffset < 0 ||
    recordOffset + sortedRecords.length > totalRetainedCount
  ) {
    throw new Error("Invalid bounded lifecycle candidate position");
  }

  const ageDueSet = new Set<string>();
  const countDueSet = new Set<string>();

  // 1. Age selection (UTC elapsed since creation >= maxAgeDays)
  if (policy.maxAgeDays !== null && !policy.allowUnlimitedAge) {
    const maxAgeMs = policy.maxAgeDays * 24 * 60 * 60 * 1000;
    for (const record of sortedRecords) {
      const createdTime = new Date(record.createdAt).getTime();
      const elapsedMs = evaluationTime - createdTime;
      if (elapsedMs >= maxAgeMs) {
        ageDueSet.add(record.recordId);
      }
    }
  }

  // 2. Excess count selection (oldest first, canonical tie-breaker)
  if (policy.maxCount !== null && !policy.allowUnlimitedCount) {
    if (totalRetainedCount > policy.maxCount) {
      const excessCountNeeded = totalRetainedCount - policy.maxCount;
      for (let index = 0; index < sortedRecords.length; index++) {
        if (recordOffset + index < excessCountNeeded) {
          countDueSet.add(sortedRecords[index]!.recordId);
        }
      }
    }
  }

  // 3. Classify due records into ready for removal vs blocked
  const dueRecords: DueRecordHandoffItem[] = [];
  const blockedRecords: BlockedRemovalRecord[] = [];

  for (const record of sortedRecords) {
    const dueByAge = ageDueSet.has(record.recordId);
    const dueByCount = countDueSet.has(record.recordId);

    if (!dueByAge && !dueByCount) {
      continue;
    }

    const dueReasons: ("age" | "count_excess")[] = [];
    if (dueByAge) dueReasons.push("age");
    if (dueByCount) dueReasons.push("count_excess");

    const primaryReason: RecordLifecycleDueReason =
      dueByAge && dueByCount ? "both" : dueByAge ? "age" : "count_excess";

    const isBlocked = record.isHeld || record.isProtected;

    if (isBlocked) {
      const blockReason =
        record.isHeld && record.isProtected
          ? "held_and_protected"
          : record.isHeld
            ? "legal_hold"
            : "recovery_protection";

      blockedRecords.push({
        recordId: record.recordId,
        expectedRecordRevision: record.expectedRecordRevision,
        dueReasons,
        primaryReason,
        blockReason,
        createdAt: record.createdAt,
      });
    } else {
      if (policy.action === "archive_workflow") {
        dueRecords.push({
          recordId: record.recordId,
          expectedRecordRevision: record.expectedRecordRevision,
          dueReasons,
          primaryReason,
          action: "archive_workflow",
          archiveWorkflowId: policy.archiveWorkflowId,
          expectedWorkflowRevision: policy.expectedWorkflowRevision,
          archiveConnectionInstanceId: policy.archiveConnectionInstanceId,
          archiveDestination: policy.archiveDestination,
          expectedConnectionRevision: policy.expectedConnectionRevision,
          expectedDestinationFingerprint: policy.expectedDestinationFingerprint,
          expectedConnectionHealthOutcome: policy.expectedConnectionHealthOutcome,
          createdAt: record.createdAt,
        });
      } else {
        dueRecords.push({
          recordId: record.recordId,
          expectedRecordRevision: record.expectedRecordRevision,
          dueReasons,
          primaryReason,
          action: "delete",
          createdAt: record.createdAt,
        });
      }
    }
  }

  // 4. Truthful status assessment
  const hasBlocked = blockedRecords.length > 0;
  const hasDue = dueRecords.length > 0;
  const excessCount =
    policy.maxCount !== null && !policy.allowUnlimitedCount
      ? countDueSet.size
      : 0;
  const expiredAgeCount = ageDueSet.size;

  const evaluationStatus: LifecycleEvaluationStatus =
    hasBlocked && hasDue
      ? "pending_and_blocked"
      : hasBlocked
        ? "blocked_over_limit"
        : hasDue
          ? "pending_removal"
          : "compliant";

  let description =
    "Lifecycle targets satisfied; no pending due records and no removal-blocking holds.";
  if (evaluationStatus === "pending_removal") {
    description = `${dueRecords.length} record(s) pending removal by executor #117; no removal-blocking holds.`;
  } else if (evaluationStatus === "blocked_over_limit") {
    description = `Record lifecycle over-limit condition: ${blockedRecords.length} due record(s) cannot be removed due to active holds or protected recovery. Create operations remain permitted; silent deletion is prohibited.`;
  } else if (evaluationStatus === "pending_and_blocked") {
    description = `${dueRecords.length} record(s) pending removal by executor #117; ${blockedRecords.length} due record(s) blocked by active holds or protected recovery. Create operations remain permitted; silent deletion is prohibited.`;
  }

  const statusReport: LifecycleStatusReport = {
    status: evaluationStatus,
    isOverLimit: hasBlocked,
    pendingRemovalCount: dueRecords.length,
    blockedRemovalCount: blockedRecords.length,
    excessCount,
    expiredAgeCount,
    blockedRecordIds: blockedRecords.map((r) => r.recordId),
    description,
  };

  const handoffPayload = {
    policyId: policy.policyId,
    policyRevision: policy.policyRevision,
    organizationId: policy.organizationId,
    storageContractId: policy.storageContractId,
    applicationRootId: policy.applicationRootId,
    action: policy.action,
    ...(policy.action === "archive_workflow"
      ? {
          archiveMetadata: {
            archiveWorkflowId: policy.archiveWorkflowId,
            expectedWorkflowRevision: policy.expectedWorkflowRevision,
            archiveConnectionInstanceId: policy.archiveConnectionInstanceId,
            archiveDestination: policy.archiveDestination,
            expectedConnectionRevision: policy.expectedConnectionRevision,
            expectedDestinationFingerprint: policy.expectedDestinationFingerprint,
            expectedConnectionHealthOutcome: policy.expectedConnectionHealthOutcome,
          },
        }
      : {}),
    evaluatedAt: evaluatedAtIso,
    totalRetainedCount,
    dueCount: dueRecords.length + blockedRecords.length,
    dueRecords,
    blockedRecords,
    statusReport,
  };

  // Validate the aggregate handoff contract before returning to guarantee semantic consistency
  return recordLifecycleHandoffSchema.parse(handoffPayload);
};

/**
 * Alias for selectDueRecordsForLifecycleHandoff.
 */
export const evaluateRecordLifecycleHandoff = selectDueRecordsForLifecycleHandoff;
