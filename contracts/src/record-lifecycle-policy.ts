import { z } from "zod";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  recordIdSchema,
  revisionSchema,
  storageContractIdSchema,
  timestampSchema,
} from "./identifiers";

const nonNilUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000", {
    message: "Identifier cannot be the nil UUID",
  });

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
 * Organisation runtime settings lifecycle ceiling schema.
 * Defines the maximum limits and allowed actions permitted within the organisation.
 */
export const organizationLifecycleLimitsSchema = z
  .object({
    maxRetentionDays: z.number().int().positive().nullable().optional(),
    maxRecordCount: z.number().int().positive().nullable().optional(),
    allowUnlimitedRetentionDays: z.boolean().default(false),
    allowUnlimitedRecordCount: z.boolean().default(false),
    allowedActions: z.array(recordLifecycleActionSchema).min(1),
    allowedArchiveDestinations: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine(
    (limits) => {
      const uniqueActions = new Set(limits.allowedActions);
      return uniqueActions.size === limits.allowedActions.length;
    },
    {
      message: "allowedActions cannot contain duplicate values",
    },
  );
export type OrganizationLifecycleLimits = z.infer<typeof organizationLifecycleLimitsSchema>;

/**
 * Monotonically increasing policy revision number (>= 1).
 */
export const policyRevisionSchema = z.union([
  z.bigint().refine((val) => val >= 1n, { message: "policyRevision must be at least 1" }),
  z
    .number()
    .int()
    .positive({ message: "policyRevision must be at least 1" })
    .transform((val) => BigInt(val)),
]);
export type PolicyRevision = bigint;

/**
 * Record-type lifecycle policy contract.
 * Scope is organisation + storage contract + permanent application root ID
 * (applicationRootId is null for organisation-shared record types).
 */
export const recordTypeLifecyclePolicySchema = z
  .object({
    policyId: recordLifecyclePolicyIdSchema,
    organizationId: organizationIdSchema,
    storageContractId: storageContractIdSchema,
    applicationRootId: applicationRootIdSchema.nullable(),
    policyRevision: policyRevisionSchema,
    maxAgeDays: z.number().int().positive().nullable(),
    maxCount: z.number().int().positive().nullable(),
    action: recordLifecycleActionSchema,
    archiveWorkflowReference: z.string().min(1).optional(),
    archiveDestination: z.string().min(1).optional(),
    allowUnlimitedAge: z.boolean(),
    allowUnlimitedCount: z.boolean(),
  })
  .strict()
  .superRefine((policy, context) => {
    // Action-specific requirement checks
    if (policy.action === "archive_workflow") {
      if (!policy.archiveWorkflowReference || policy.archiveWorkflowReference.trim().length === 0) {
        context.addIssue({
          code: "custom",
          path: ["archiveWorkflowReference"],
          message: "archiveWorkflowReference is required when action is 'archive_workflow'",
        });
      }
      if (!policy.archiveDestination || policy.archiveDestination.trim().length === 0) {
        context.addIssue({
          code: "custom",
          path: ["archiveDestination"],
          message: "archiveDestination is required when action is 'archive_workflow'",
        });
      }
    }

    // Age consistency checks
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

    // Count consistency checks
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
  });

export type RecordTypeLifecyclePolicy = {
  policyId: RecordLifecyclePolicyId;
  organizationId: z.infer<typeof organizationIdSchema>;
  storageContractId: z.infer<typeof storageContractIdSchema>;
  applicationRootId: z.infer<typeof applicationRootIdSchema> | null;
  policyRevision: bigint;
  maxAgeDays: number | null;
  maxCount: number | null;
  action: RecordLifecycleAction;
  archiveWorkflowReference?: string | undefined;
  archiveDestination?: string | undefined;
  allowUnlimitedAge: boolean;
  allowUnlimitedCount: boolean;
};

/**
 * Capability context for verifying whether required lifecycle actions can be executed.
 */
export interface LifecycleActionCapabilitiesInput {
  workflowRegistrationAvailable?: boolean;
  connectionAvailable?: boolean;
  archiveWorkflowRegistrationAvailable?: boolean;
  archiveDestinationConnectionAvailable?: boolean;
  destinationConnectionAvailable?: boolean;
  registeredWorkflows?: readonly string[] | Set<string>;
  availableConnections?: readonly string[] | Set<string>;
}

export type LifecycleCapabilities =
  LifecycleActionCapabilitiesInput | readonly string[] | Set<string> | boolean;

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
 * Validates a record-type lifecycle policy against organisation limits and execution capabilities.
 *
 * Checks:
 * 1. Policy and limits conform to their respective contracts.
 * 2. At least one of age or count is specified, or explicit absence/unlimited is declared and allowed.
 * 3. Age does not exceed organisation's maxRetentionDays ceiling.
 * 4. Count does not exceed organisation's maxRecordCount ceiling.
 * 5. Selected action is permitted by organisation's allowedActions.
 * 6. If action is archive_workflow:
 *    - Destination is in allowedArchiveDestinations.
 *    - Workflow registration and connection capabilities are verified available.
 *    - Unavailable workflow archival NEVER silently falls back to deletion.
 */
export const validateRecordTypeLifecyclePolicy = (
  policyCandidate: unknown,
  organizationLimitsCandidate: unknown,
  capabilities?: LifecycleCapabilities,
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

  // If basic schema checks failed, return immediately with collected issues
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

  // 1. Check action is in organisation's allowedActions
  if (!limits.allowedActions.includes(policy.action)) {
    issues.push({
      code: "action_not_allowed",
      path: ["action"],
      message: `Lifecycle action "${policy.action}" is not permitted by organisation limits (allowed: ${limits.allowedActions.join(", ")})`,
    });
  }

  // 2. Check age against organisation ceiling and unlimited policy
  if (policy.allowUnlimitedAge) {
    if (!limits.allowUnlimitedRetentionDays) {
      issues.push({
        code: "unlimited_retention_days_forbidden",
        path: ["allowUnlimitedAge"],
        message:
          "Organisation limits forbid unlimited retention days (allowUnlimitedRetentionDays is false)",
      });
    }
  } else if (policy.maxAgeDays !== null) {
    if (
      limits.maxRetentionDays !== null &&
      limits.maxRetentionDays !== undefined &&
      policy.maxAgeDays > limits.maxRetentionDays
    ) {
      issues.push({
        code: "max_age_exceeds_ceiling",
        path: ["maxAgeDays"],
        message: `Policy maxAgeDays (${policy.maxAgeDays}) exceeds organisation limit (${limits.maxRetentionDays})`,
      });
    }
  }

  // 3. Check count against organisation ceiling and unlimited policy
  if (policy.allowUnlimitedCount) {
    if (!limits.allowUnlimitedRecordCount) {
      issues.push({
        code: "unlimited_record_count_forbidden",
        path: ["allowUnlimitedCount"],
        message:
          "Organisation limits forbid unlimited record count (allowUnlimitedRecordCount is false)",
      });
    }
  } else if (policy.maxCount !== null) {
    if (
      limits.maxRecordCount !== null &&
      limits.maxRecordCount !== undefined &&
      policy.maxCount > limits.maxRecordCount
    ) {
      issues.push({
        code: "max_count_exceeds_ceiling",
        path: ["maxCount"],
        message: `Policy maxCount (${policy.maxCount}) exceeds organisation limit (${limits.maxRecordCount})`,
      });
    }
  }

  // 4. Check archive_workflow specific constraints and capabilities
  if (policy.action === "archive_workflow") {
    // Destination must be in organisation's allowed destinations
    const destination = policy.archiveDestination;
    if (destination && !limits.allowedArchiveDestinations.includes(destination)) {
      issues.push({
        code: "archive_destination_not_allowed",
        path: ["archiveDestination"],
        message: `Archive destination "${destination}" is not in organisation's allowed destinations (allowed: ${limits.allowedArchiveDestinations.join(", ") || "none"})`,
      });
    }

    // Required action capabilities check
    // Workflow registration and Connection must be verified ready
    let workflowRegistrationAvailable = false;
    let connectionAvailable = false;

    if (typeof capabilities === "boolean") {
      workflowRegistrationAvailable = capabilities;
      connectionAvailable = capabilities;
    } else if (Array.isArray(capabilities)) {
      const caps = new Set(capabilities);
      workflowRegistrationAvailable =
        caps.has("workflow_registration") ||
        caps.has("archive_workflow") ||
        (policy.archiveWorkflowReference ? caps.has(policy.archiveWorkflowReference) : false);
      connectionAvailable =
        caps.has("connection") ||
        caps.has("destination_connection") ||
        (destination ? caps.has(destination) : false);
    } else if (capabilities instanceof Set) {
      workflowRegistrationAvailable =
        capabilities.has("workflow_registration") ||
        capabilities.has("archive_workflow") ||
        (policy.archiveWorkflowReference
          ? capabilities.has(policy.archiveWorkflowReference)
          : false);
      connectionAvailable =
        capabilities.has("connection") ||
        capabilities.has("destination_connection") ||
        (destination ? capabilities.has(destination) : false);
    } else if (capabilities && typeof capabilities === "object") {
      const input = capabilities as LifecycleActionCapabilitiesInput;
      workflowRegistrationAvailable =
        input.workflowRegistrationAvailable ?? input.archiveWorkflowRegistrationAvailable ?? false;
      connectionAvailable =
        input.connectionAvailable ??
        input.archiveDestinationConnectionAvailable ??
        input.destinationConnectionAvailable ??
        false;

      // Optional registered workflows check
      if (input.registeredWorkflows && policy.archiveWorkflowReference) {
        const workflows =
          input.registeredWorkflows instanceof Set
            ? input.registeredWorkflows
            : new Set(input.registeredWorkflows);
        if (!workflows.has(policy.archiveWorkflowReference)) {
          workflowRegistrationAvailable = false;
          issues.push({
            code: "archive_workflow_not_registered",
            path: ["archiveWorkflowReference"],
            message: `Archive workflow "${policy.archiveWorkflowReference}" is not registered in runtime workflows`,
          });
        }
      }

      // Optional available connections check
      if (input.availableConnections && destination) {
        const conns =
          input.availableConnections instanceof Set
            ? input.availableConnections
            : new Set(input.availableConnections);
        if (!conns.has(destination)) {
          connectionAvailable = false;
          issues.push({
            code: "archive_destination_connection_not_available",
            path: ["archiveDestination"],
            message: `Connection for archive destination "${destination}" is not available`,
          });
        }
      }
    }

    if (!workflowRegistrationAvailable) {
      issues.push({
        code: "archive_workflow_capability_unavailable",
        path: ["action"],
        message:
          "Workflow registration is unavailable; archive workflow policy cannot be enabled and cannot silently fall back to deletion",
      });
    }

    if (!connectionAvailable) {
      issues.push({
        code: "archive_connection_capability_unavailable",
        path: ["archiveDestination"],
        message: `Connection for archive destination "${destination ?? "unspecified"}" is unavailable; archive workflow policy cannot be enabled and cannot silently fall back to deletion`,
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
 * Candidate record input schema for evaluating lifecycle selection.
 */
export const lifecycleCandidateRecordSchema = z
  .object({
    recordId: recordIdSchema,
    createdAt: timestampSchema,
    isHeld: z.boolean().default(false),
    isProtected: z.boolean().default(false),
    concurrencyNumber: revisionSchema.max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type LifecycleCandidateRecord = z.infer<typeof lifecycleCandidateRecordSchema>;

/**
 * The specific reason(s) why a record became due for lifecycle removal.
 */
export const recordLifecycleDueReasonSchema = z.enum(["age", "count_excess", "both"]);
export type RecordLifecycleDueReason = z.infer<typeof recordLifecycleDueReasonSchema>;

/**
 * Item in the handoff payload representing a due record ready for executor action.
 */
export const dueRecordHandoffItemSchema = z
  .object({
    recordId: recordIdSchema,
    dueReasons: z.array(z.enum(["age", "count_excess"])).min(1),
    primaryReason: recordLifecycleDueReasonSchema,
    action: recordLifecycleActionSchema,
    archiveWorkflowReference: z.string().min(1).optional(),
    archiveDestination: z.string().min(1).optional(),
    createdAt: timestampSchema,
    concurrencyNumber: revisionSchema.max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type DueRecordHandoffItem = z.infer<typeof dueRecordHandoffItemSchema>;

/**
 * Item representing a due record whose removal is blocked by legal holds or protected recovery.
 */
export const blockedRemovalRecordSchema = z
  .object({
    recordId: recordIdSchema,
    dueReasons: z.array(z.enum(["age", "count_excess"])).min(1),
    primaryReason: recordLifecycleDueReasonSchema,
    blockReason: z.enum(["legal_hold", "recovery_protection", "held_and_protected"]),
    createdAt: timestampSchema,
  })
  .strict();
export type BlockedRemovalRecord = z.infer<typeof blockedRemovalRecordSchema>;

/**
 * Visible over-limit condition reported when due records cannot be removed
 * because of legal holds or recovery protections.
 */
export const lifecycleOverLimitConditionSchema = z
  .object({
    isOverLimit: z.boolean(),
    excessCount: z.number().int().nonnegative(),
    expiredAgeCount: z.number().int().nonnegative(),
    blockedCount: z.number().int().nonnegative(),
    blockedRecordIds: z.array(recordIdSchema),
    description: z.string(),
  })
  .strict();
export type LifecycleOverLimitCondition = z.infer<typeof lifecycleOverLimitConditionSchema>;

/**
 * Complete lifecycle handoff package for #117 executor.
 */
export const recordLifecycleHandoffSchema = z
  .object({
    policyId: recordLifecyclePolicyIdSchema,
    policyRevision: policyRevisionSchema,
    organizationId: organizationIdSchema,
    storageContractId: storageContractIdSchema,
    applicationRootId: applicationRootIdSchema.nullable(),
    action: recordLifecycleActionSchema,
    archiveWorkflowReference: z.string().min(1).optional(),
    archiveDestination: z.string().min(1).optional(),
    evaluatedAt: timestampSchema,
    totalRetainedCount: z.number().int().nonnegative(),
    dueCount: z.number().int().nonnegative(),
    dueRecords: z.array(dueRecordHandoffItemSchema),
    blockedRecords: z.array(blockedRemovalRecordSchema),
    overLimitCondition: lifecycleOverLimitConditionSchema,
  })
  .strict();
export type RecordLifecycleHandoff = {
  policyId: RecordLifecyclePolicyId;
  policyRevision: bigint;
  organizationId: z.infer<typeof organizationIdSchema>;
  storageContractId: z.infer<typeof storageContractIdSchema>;
  applicationRootId: z.infer<typeof applicationRootIdSchema> | null;
  action: RecordLifecycleAction;
  archiveWorkflowReference?: string | undefined;
  archiveDestination?: string | undefined;
  evaluatedAt: string;
  totalRetainedCount: number;
  dueCount: number;
  dueRecords: DueRecordHandoffItem[];
  blockedRecords: BlockedRemovalRecord[];
  overLimitCondition: LifecycleOverLimitCondition;
};

export interface EvaluateRecordLifecycleHandoffInput {
  policy: RecordTypeLifecyclePolicy;
  records: readonly LifecycleCandidateRecord[];
  evaluatedAt?: string | Date;
}

/**
 * Selects due records and produces the exact policy/revision handoff for #117 selection/removal.
 *
 * Rules:
 * - Age is UTC elapsed time since record creation.
 * - Count includes all retained records in policy scope, including recoverable or held rows.
 * - Excess candidates are selected oldest-created first, with permanent record ID as tie-breaker.
 * - When removal is blocked (legal holds / recovery protection), an over-limit condition is reported
 *   rather than inventing create denial or silently deleting protected data.
 */
export const selectDueRecordsForLifecycleHandoff = (
  input: EvaluateRecordLifecycleHandoffInput,
): RecordLifecycleHandoff => {
  const policy = recordTypeLifecyclePolicySchema.parse(input.policy);
  const evaluationDate =
    input.evaluatedAt instanceof Date
      ? input.evaluatedAt
      : input.evaluatedAt
        ? new Date(input.evaluatedAt)
        : new Date();

  const evaluatedAtIso = evaluationDate.toISOString();
  const evaluationTime = evaluationDate.getTime();

  // Validate candidate records
  const validatedRecords = input.records.map((r) => lifecycleCandidateRecordSchema.parse(r));

  // Map to track due reasons per record
  const ageDueSet = new Set<string>();
  const countDueSet = new Set<string>();

  // Sort all records oldest-created first; tie-breaker: permanent record ID
  const sortedRecords = [...validatedRecords].sort((a, b) => {
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    if (timeA !== timeB) {
      return timeA - timeB;
    }
    return a.recordId.localeCompare(b.recordId);
  });

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

  // 2. Excess count selection (oldest first, permanent record ID tie-breaker)
  if (policy.maxCount !== null && !policy.allowUnlimitedCount) {
    const totalCount = sortedRecords.length;
    if (totalCount > policy.maxCount) {
      const excessCountNeeded = totalCount - policy.maxCount;
      const excessCandidates = sortedRecords.slice(0, excessCountNeeded);
      for (const rec of excessCandidates) {
        countDueSet.add(rec.recordId);
      }
    }
  }

  // 3. Classify due records into ready for removal vs blocked by holds/protection
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
        dueReasons,
        primaryReason,
        blockReason,
        createdAt: record.createdAt,
      });
    } else {
      const item: DueRecordHandoffItem = {
        recordId: record.recordId,
        dueReasons,
        primaryReason,
        action: policy.action,
        createdAt: record.createdAt,
      };

      if (policy.archiveWorkflowReference) {
        item.archiveWorkflowReference = policy.archiveWorkflowReference;
      }
      if (policy.archiveDestination) {
        item.archiveDestination = policy.archiveDestination;
      }
      if (record.concurrencyNumber !== undefined) {
        item.concurrencyNumber = record.concurrencyNumber;
      }

      dueRecords.push(item);
    }
  }

  // 4. Over-limit condition assessment
  const hasBlocked = blockedRecords.length > 0;
  const excessCount =
    policy.maxCount !== null && !policy.allowUnlimitedCount
      ? Math.max(0, validatedRecords.length - policy.maxCount)
      : 0;
  const expiredAgeCount = ageDueSet.size;

  const overLimitCondition: LifecycleOverLimitCondition = {
    isOverLimit: hasBlocked,
    excessCount,
    expiredAgeCount,
    blockedCount: blockedRecords.length,
    blockedRecordIds: blockedRecords.map((r) => r.recordId),
    description: hasBlocked
      ? `Record lifecycle over-limit condition: ${blockedRecords.length} due record(s) cannot be removed due to active holds or protected recovery. Create operations remain permitted; silent deletion is prohibited.`
      : "Lifecycle targets satisfied; no removal-blocking holds or recovery protections.",
  };

  return {
    policyId: policy.policyId,
    policyRevision: policy.policyRevision,
    organizationId: policy.organizationId,
    storageContractId: policy.storageContractId,
    applicationRootId: policy.applicationRootId,
    action: policy.action,
    archiveWorkflowReference: policy.archiveWorkflowReference,
    archiveDestination: policy.archiveDestination,
    evaluatedAt: evaluatedAtIso,
    totalRetainedCount: validatedRecords.length,
    dueCount: dueRecords.length + blockedRecords.length,
    dueRecords,
    blockedRecords,
    overLimitCondition,
  };
};

/**
 * Alias for selectDueRecordsForLifecycleHandoff.
 */
export const evaluateRecordLifecycleHandoff = selectDueRecordsForLifecycleHandoff;
