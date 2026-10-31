import { z } from "zod";
import {
  applicationRootIdSchema,
  connectionInstanceIdSchema,
  organizationIdSchema,
  revisionSchema,
  storageContractIdSchema,
  timestampSchema,
  flowIdSchema,
} from "../catalogue/identifiers";

const nonNilUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000", {
    message: "Identifier cannot be the nil UUID",
  });

const jsonSafePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const recordLifecyclePolicyIdSchema = nonNilUuidSchema.brand<"RecordLifecyclePolicyId">();

/**
 * Permitted end-of-life lifecycle action.
 * - 'delete': recoverable deletion under the organisation recovery policy.
 */
const recordLifecycleActionSchema = z.literal("delete");

/**
 * Closed, typed archive destination reference identifier.
 * Must be a lowercase alphanumeric identifier using hyphen or underscore delimiters.
 * Strictly excludes URLs, connection strings, SQL escape hatches, and credential patterns.
 */
const archiveDestinationReferenceSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/,
    "Archive destination reference must be a lowercase alphanumeric identifier using hyphen or underscore delimiters",
  )
  .brand<"ArchiveDestinationReference">();

/**
 * Organisation runtime settings lifecycle ceiling schema.
 * Bound to organizationId and settingsRevision.
 * Limits must be internally closed: either a finite positive ceiling is set,
 * or allowUnlimited is explicitly true. Finite ceiling with unlimited is prohibited.
 */
export const organizationLifecycleLimitsSchema = z
  .object({
    organizationId: organizationIdSchema,
    settingsRevision: revisionSchema,
    maxRetentionDays: jsonSafePositiveIntegerSchema.nullable().optional(),
    maxRecordCount: jsonSafePositiveIntegerSchema.nullable().optional(),
    allowUnlimitedRetentionDays: z.boolean(),
    allowUnlimitedRecordCount: z.boolean(),
    allowedActions: z.array(recordLifecycleActionSchema).min(1),
    // archive leftover: removed by FIX-DB-SECURITY
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

    // 4. Unique allowed actions
    const uniqueActions = new Set(limits.allowedActions);
    if (uniqueActions.size !== limits.allowedActions.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedActions"],
        message: "allowedActions cannot contain duplicate values",
      });
    }
  });

export type OrganizationLifecycleLimits = z.infer<typeof organizationLifecycleLimitsSchema>;

/**
 * Standard JSON-safe positive integer revision schema matching repository conventions.
 */
const policyRevisionSchema = revisionSchema;

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
const maximumRecoveryWindowDays = Math.floor(Number.MAX_SAFE_INTEGER / (24 * 60 * 60 * 1000));

const recoveryWindowDaysSchema = jsonSafePositiveIntegerSchema.max(maximumRecoveryWindowDays);

/**
 * Policy contract for recoverable deletion. Carries no archive metadata; it may
 * carry the recovery window that bounds restoring a deleted record.
 */
const deleteRecordLifecyclePolicySchema = z
  .object({
    ...policyBaseFields,
    action: z.literal("delete"),
    // Absent means no recovery window is configured, so restore is refused.
    // It is never read as unlimited recovery.
    recoveryWindowDays: recoveryWindowDaysSchema.optional(),
  })
  .strict()
  .superRefine(validatePolicyLimitsConsistency);

/** Explicit setup choice for record types that do not yet have an organisation policy. */
export const initialRecordLifecyclePolicySchema = z
  .object({
    action: deleteRecordLifecyclePolicySchema.shape.action,
    maxAgeDays: policyBaseFields.maxAgeDays,
    maxCount: policyBaseFields.maxCount,
    allowUnlimitedAge: policyBaseFields.allowUnlimitedAge,
    allowUnlimitedCount: policyBaseFields.allowUnlimitedCount,
    recoveryWindowDays: recoveryWindowDaysSchema,
  })
  .strict()
  .superRefine(validatePolicyLimitsConsistency);

/**
 * The record-type lifecycle policy of a record type: recoverable deletion only.
 */
const recordTypeLifecyclePolicySchema = deleteRecordLifecyclePolicySchema;

/**
 * Evidence item for an exact active registered workflow in runtime.
 * Scope-bound to matching organizationId and authorizedApplicationIds.
 */
const registeredWorkflowEvidenceSchema = z
  .object({
    workflowId: flowIdSchema,
    workflowRevision: revisionSchema,
    organizationId: organizationIdSchema,
    authorizedApplicationIds: z.array(applicationRootIdSchema).default([]),
    state: z.literal("active"),
  })
  .strict();

/**
 * Evidence item for an exact active connection instance in runtime.
 * Scope-bound to matching organizationId, closed destinationKey, and canonical authorizedApplicationIds (min 1).
 */
const activeConnectionEvidenceSchema = z
  .object({
    connectionInstanceId: connectionInstanceIdSchema,
    destinationKey: archiveDestinationReferenceSchema,
    destinationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    organizationId: organizationIdSchema,
    authorizedApplicationIds: z.array(applicationRootIdSchema).min(1),
    state: z.literal("active"),
    revision: revisionSchema,
    lastHealthOutcome: z.literal("healthy"),
    verifiedAt: timestampSchema.optional(),
  })
  .strict();

/**
 * Scope-bound live readiness evidence contract required for activation and live policy validation.
 * Proves that exact workflows and connections are active and bound to the matching organisation.
 */
const lifecycleReadinessEvidenceSchema = z
  .object({
    organizationId: organizationIdSchema,
    // archive leftover: removed by FIX-DB-SECURITY
    registeredWorkflows: z.array(registeredWorkflowEvidenceSchema),
    // archive leftover: removed by FIX-DB-SECURITY
    activeConnections: z.array(activeConnectionEvidenceSchema),
  })
  .strict();

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
    policies: z.array(recordTypeLifecyclePolicySchema),
    organizationLimits: organizationLifecycleLimitsSchema,
    readinessEvidence: lifecycleReadinessEvidenceSchema,
  })
  .strict();

interface PolicyValidationIssue {
  code: string;
  message: string;
  path?: (string | number)[];
}

interface PolicyValidationResult {
  valid: boolean;
  success: boolean;
  issues: PolicyValidationIssue[];
  errors: string[];
}

export const validateRecordTypeLifecyclePolicy = (
  policyCandidate: unknown,
  organizationLimitsCandidate: unknown,
  // archive leftover: removed by FIX-DB-SECURITY, with the readiness evidence it was read from.
  _readinessEvidenceCandidate: unknown,
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
    const parsedExpectedRevision = revisionSchema.safeParse(rawExpectedRevision);
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

  const isValid = issues.length === 0;
  return {
    valid: isValid,
    success: isValid,
    issues,
    errors: issues.map((i) => i.message),
  };
};
