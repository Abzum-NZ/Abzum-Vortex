import { describe, expect, it } from "vitest";
import {
  blockedRemovalRecordSchema,
  dueRecordHandoffItemSchema,
  evaluateRecordLifecycleHandoff,
  lifecycleCandidateRecordSchema,
  lifecycleOverLimitConditionSchema,
  organizationLifecycleLimitsSchema,
  recordLifecycleActionSchema,
  recordLifecycleHandoffSchema,
  recordLifecyclePolicyIdSchema,
  recordTypeLifecyclePolicySchema,
  selectDueRecordsForLifecycleHandoff,
  validateRecordTypeLifecyclePolicy,
  type LifecycleCandidateRecord,
  type OrganizationLifecycleLimits,
  type RecordTypeLifecyclePolicy,
} from "../src";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("record lifecycle policy contracts and organisation limits", () => {
  const validOrgLimits: OrganizationLifecycleLimits = {
    maxRetentionDays: 365,
    maxRecordCount: 10_000,
    allowUnlimitedRetentionDays: false,
    allowUnlimitedRecordCount: false,
    allowedActions: ["delete", "archive_workflow"],
    allowedArchiveDestinations: ["cold_archive_s3", "compliance_vault"],
  };

  const createValidPolicy = (
    overrides: Partial<Record<string, unknown>> = {},
  ): RecordTypeLifecyclePolicy =>
    recordTypeLifecyclePolicySchema.parse({
      policyId: uuid(1),
      organizationId: uuid(2),
      storageContractId: uuid(3),
      applicationRootId: uuid(4),
      policyRevision: 1n,
      maxAgeDays: 90,
      maxCount: 1_000,
      action: "delete",
      allowUnlimitedAge: false,
      allowUnlimitedCount: false,
      ...overrides,
    });

  describe("schema primitives and branded identifiers", () => {
    it("validates recordLifecycleActionSchema enum", () => {
      expect(recordLifecycleActionSchema.parse("delete")).toBe("delete");
      expect(recordLifecycleActionSchema.parse("archive_workflow")).toBe("archive_workflow");
      expect(recordLifecycleActionSchema.safeParse("hard_delete").success).toBe(false);
    });

    it("validates recordLifecyclePolicyIdSchema non-nil UUID", () => {
      expect(recordLifecyclePolicyIdSchema.parse(uuid(99))).toBe(uuid(99));
      expect(
        recordLifecyclePolicyIdSchema.safeParse("00000000-0000-0000-0000-000000000000").success,
      ).toBe(false);
      expect(recordLifecyclePolicyIdSchema.safeParse("not-a-uuid").success).toBe(false);
    });

    it("validates lifecycleCandidateRecordSchema", () => {
      const candidate = lifecycleCandidateRecordSchema.parse({
        recordId: uuid(1),
        createdAt: "2026-09-21T00:00:00.000Z",
        isHeld: true,
        isProtected: false,
        concurrencyNumber: 5,
      });
      expect(candidate.recordId).toBe(uuid(1));
      expect(candidate.isHeld).toBe(true);
      expect(candidate.concurrencyNumber).toBe(5);
    });

    it("validates dueRecordHandoffItemSchema and blockedRemovalRecordSchema", () => {
      const dueItem = dueRecordHandoffItemSchema.parse({
        recordId: uuid(10),
        dueReasons: ["age"],
        primaryReason: "age",
        action: "delete",
        createdAt: "2026-09-21T00:00:00.000Z",
      });
      expect(dueItem.recordId).toBe(uuid(10));

      const blockedItem = blockedRemovalRecordSchema.parse({
        recordId: uuid(20),
        dueReasons: ["count_excess"],
        primaryReason: "count_excess",
        blockReason: "legal_hold",
        createdAt: "2026-09-21T00:00:00.000Z",
      });
      expect(blockedItem.blockReason).toBe("legal_hold");
    });

    it("validates lifecycleOverLimitConditionSchema", () => {
      const condition = lifecycleOverLimitConditionSchema.parse({
        isOverLimit: true,
        excessCount: 5,
        expiredAgeCount: 2,
        blockedCount: 2,
        blockedRecordIds: [uuid(20), uuid(21)],
        description: "Over-limit condition test",
      });
      expect(condition.isOverLimit).toBe(true);
      expect(condition.blockedCount).toBe(2);
    });
  });

  describe("organizationLifecycleLimitsSchema", () => {
    it("accepts valid bounded organisation limits with all fields", () => {
      const parsed = organizationLifecycleLimitsSchema.parse(validOrgLimits);
      expect(parsed.maxRetentionDays).toBe(365);
      expect(parsed.maxRecordCount).toBe(10_000);
      expect(parsed.allowUnlimitedRetentionDays).toBe(false);
      expect(parsed.allowUnlimitedRecordCount).toBe(false);
      expect(parsed.allowedActions).toEqual(["delete", "archive_workflow"]);
      expect(parsed.allowedArchiveDestinations).toEqual(["cold_archive_s3", "compliance_vault"]);
    });

    it("applies defaults for unlimited flags and archive destinations", () => {
      const minimal = {
        allowedActions: ["delete" as const],
      };
      const parsed = organizationLifecycleLimitsSchema.parse(minimal);
      expect(parsed.allowUnlimitedRetentionDays).toBe(false);
      expect(parsed.allowUnlimitedRecordCount).toBe(false);
      expect(parsed.allowedArchiveDestinations).toEqual([]);
      expect(parsed.maxRetentionDays).toBeUndefined();
      expect(parsed.maxRecordCount).toBeUndefined();
    });

    it("allows null for maxRetentionDays and maxRecordCount", () => {
      const parsed = organizationLifecycleLimitsSchema.parse({
        maxRetentionDays: null,
        maxRecordCount: null,
        allowUnlimitedRetentionDays: true,
        allowUnlimitedRecordCount: true,
        allowedActions: ["delete"],
      });
      expect(parsed.maxRetentionDays).toBeNull();
      expect(parsed.maxRecordCount).toBeNull();
      expect(parsed.allowUnlimitedRetentionDays).toBe(true);
      expect(parsed.allowUnlimitedRecordCount).toBe(true);
    });

    it("rejects non-positive numbers for retention days and count", () => {
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          maxRetentionDays: 0,
        }).success,
      ).toBe(false);

      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          maxRetentionDays: -10,
        }).success,
      ).toBe(false);

      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          maxRecordCount: 0,
        }).success,
      ).toBe(false);

      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          maxRecordCount: 1.5,
        }).success,
      ).toBe(false);
    });

    it("rejects empty allowedActions", () => {
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          allowedActions: [],
        }).success,
      ).toBe(false);
    });

    it("rejects duplicate actions in allowedActions", () => {
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          allowedActions: ["delete", "delete"],
        }).success,
      ).toBe(false);
    });

    it("rejects unknown action types", () => {
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          allowedActions: ["hard_purge"],
        }).success,
      ).toBe(false);
    });

    it("enforces strict schema by rejecting unknown properties", () => {
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          unrecognizedField: "forbidden",
        }).success,
      ).toBe(false);
    });
  });

  describe("recordTypeLifecyclePolicySchema", () => {
    it("accepts a valid recoverable deletion policy with finite age and count", () => {
      const policy = createValidPolicy();
      expect(policy.policyId).toBe(uuid(1));
      expect(policy.organizationId).toBe(uuid(2));
      expect(policy.storageContractId).toBe(uuid(3));
      expect(policy.applicationRootId).toBe(uuid(4));
      expect(policy.policyRevision).toBe(1n);
      expect(policy.maxAgeDays).toBe(90);
      expect(policy.maxCount).toBe(1_000);
      expect(policy.action).toBe("delete");
      expect(policy.allowUnlimitedAge).toBe(false);
      expect(policy.allowUnlimitedCount).toBe(false);
    });

    it("accepts an organisation-shared policy with applicationRootId as null", () => {
      const sharedPolicy = createValidPolicy({ applicationRootId: null });
      expect(sharedPolicy.applicationRootId).toBeNull();
    });

    it("accepts archive_workflow action with valid reference and destination", () => {
      const archivePolicy = createValidPolicy({
        action: "archive_workflow",
        archiveWorkflowReference: "workflow.records.s3_archive",
        archiveDestination: "cold_archive_s3",
      });
      expect(archivePolicy.action).toBe("archive_workflow");
      expect(archivePolicy.archiveWorkflowReference).toBe("workflow.records.s3_archive");
      expect(archivePolicy.archiveDestination).toBe("cold_archive_s3");
    });

    it("rejects archive_workflow when archiveWorkflowReference is missing or empty", () => {
      expect(
        recordTypeLifecyclePolicySchema.safeParse({
          ...createValidPolicy(),
          action: "archive_workflow",
          archiveDestination: "cold_archive_s3",
        }).success,
      ).toBe(false);

      expect(
        recordTypeLifecyclePolicySchema.safeParse({
          ...createValidPolicy(),
          action: "archive_workflow",
          archiveWorkflowReference: "   ",
          archiveDestination: "cold_archive_s3",
        }).success,
      ).toBe(false);
    });

    it("rejects archive_workflow when archiveDestination is missing or empty", () => {
      expect(
        recordTypeLifecyclePolicySchema.safeParse({
          ...createValidPolicy(),
          action: "archive_workflow",
          archiveWorkflowReference: "workflow.records.s3_archive",
        }).success,
      ).toBe(false);

      expect(
        recordTypeLifecyclePolicySchema.safeParse({
          ...createValidPolicy(),
          action: "archive_workflow",
          archiveWorkflowReference: "workflow.records.s3_archive",
          archiveDestination: "",
        }).success,
      ).toBe(false);
    });

    it("accepts policy revision as bigint and coerces positive integer to bigint", () => {
      const withBigInt = createValidPolicy({
        policyRevision: 42n,
      });
      expect(withBigInt.policyRevision).toBe(42n);
      expect(typeof withBigInt.policyRevision).toBe("bigint");

      const withNumber = createValidPolicy({
        policyRevision: 5,
      });
      expect(withNumber.policyRevision).toBe(5n);
      expect(typeof withNumber.policyRevision).toBe("bigint");
    });

    it("rejects policyRevision < 1", () => {
      expect(
        recordTypeLifecyclePolicySchema.safeParse({
          ...createValidPolicy(),
          policyRevision: 0n,
        }).success,
      ).toBe(false);

      expect(
        recordTypeLifecyclePolicySchema.safeParse({
          ...createValidPolicy(),
          policyRevision: -1n,
        }).success,
      ).toBe(false);

      expect(
        recordTypeLifecyclePolicySchema.safeParse({
          ...createValidPolicy(),
          policyRevision: 0,
        }).success,
      ).toBe(false);
    });

    it("rejects nil UUID for policy identifiers", () => {
      const nil = "00000000-0000-0000-0000-000000000000";
      expect(
        recordTypeLifecyclePolicySchema.safeParse({
          ...createValidPolicy(),
          policyId: nil,
        }).success,
      ).toBe(false);

      expect(
        recordTypeLifecyclePolicySchema.safeParse({
          ...createValidPolicy(),
          organizationId: nil,
        }).success,
      ).toBe(false);

      expect(
        recordTypeLifecyclePolicySchema.safeParse({
          ...createValidPolicy(),
          storageContractId: nil,
        }).success,
      ).toBe(false);
    });

    it("rejects contradictory age specification (allowUnlimitedAge: true with maxAgeDays specified)", () => {
      const result = recordTypeLifecyclePolicySchema.safeParse({
        ...createValidPolicy(),
        allowUnlimitedAge: true,
        maxAgeDays: 90,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("maxAgeDays"))).toBe(true);
      }
    });

    it("rejects missing age specification (allowUnlimitedAge: false with maxAgeDays: null)", () => {
      const result = recordTypeLifecyclePolicySchema.safeParse({
        ...createValidPolicy(),
        allowUnlimitedAge: false,
        maxAgeDays: null,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("maxAgeDays"))).toBe(true);
      }
    });

    it("rejects contradictory count specification (allowUnlimitedCount: true with maxCount specified)", () => {
      const result = recordTypeLifecyclePolicySchema.safeParse({
        ...createValidPolicy(),
        allowUnlimitedCount: true,
        maxCount: 1_000,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("maxCount"))).toBe(true);
      }
    });

    it("rejects missing count specification (allowUnlimitedCount: false with maxCount: null)", () => {
      const result = recordTypeLifecyclePolicySchema.safeParse({
        ...createValidPolicy(),
        allowUnlimitedCount: false,
        maxCount: null,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("maxCount"))).toBe(true);
      }
    });

    it("enforces strict schema by rejecting unknown properties", () => {
      expect(
        recordTypeLifecyclePolicySchema.safeParse({
          ...createValidPolicy(),
          unauthorizedField: "test",
        }).success,
      ).toBe(false);
    });
  });

  describe("validateRecordTypeLifecyclePolicy", () => {
    it("accepts a policy within organisation ceilings and allowed actions", () => {
      const policy = createValidPolicy();
      const result = validateRecordTypeLifecyclePolicy(policy, validOrgLimits);
      expect(result.valid).toBe(true);
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.issues).toHaveLength(0);
    });

    it("refuses policy when action is not in organisation allowedActions", () => {
      const deleteOnlyOrg: OrganizationLifecycleLimits = {
        ...validOrgLimits,
        allowedActions: ["delete"],
      };
      const archivePolicy = createValidPolicy({
        action: "archive_workflow",
        archiveWorkflowReference: "workflow.s3",
        archiveDestination: "cold_archive_s3",
      });

      const result = validateRecordTypeLifecyclePolicy(archivePolicy, deleteOnlyOrg, {
        workflowRegistrationAvailable: true,
        connectionAvailable: true,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("not permitted by organisation limits"))).toBe(
        true,
      );
    });

    it("refuses policy when maxAgeDays exceeds organisation ceiling", () => {
      const exceedingPolicy = createValidPolicy({
        maxAgeDays: 400, // org limit is 365
      });

      const result = validateRecordTypeLifecyclePolicy(exceedingPolicy, validOrgLimits);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exceeds organisation limit"))).toBe(true);
    });

    it("accepts policy when maxAgeDays equals organisation ceiling", () => {
      const atCeilingPolicy = createValidPolicy({
        maxAgeDays: 365,
      });

      const result = validateRecordTypeLifecyclePolicy(atCeilingPolicy, validOrgLimits);
      expect(result.valid).toBe(true);
    });

    it("refuses policy when maxCount exceeds organisation ceiling", () => {
      const exceedingPolicy = createValidPolicy({
        maxCount: 20_000, // org limit is 10,000
      });

      const result = validateRecordTypeLifecyclePolicy(exceedingPolicy, validOrgLimits);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exceeds organisation limit"))).toBe(true);
    });

    it("accepts policy when maxCount equals organisation ceiling", () => {
      const atCeilingPolicy = createValidPolicy({
        maxCount: 10_000,
      });

      const result = validateRecordTypeLifecyclePolicy(atCeilingPolicy, validOrgLimits);
      expect(result.valid).toBe(true);
    });

    it("refuses unlimited age when organisation has allowUnlimitedRetentionDays: false", () => {
      const unlimitedAgePolicy = createValidPolicy({
        maxAgeDays: null,
        allowUnlimitedAge: true,
      });

      const result = validateRecordTypeLifecyclePolicy(unlimitedAgePolicy, validOrgLimits);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("forbid unlimited retention days"))).toBe(true);
    });

    it("refuses unlimited count when organisation has allowUnlimitedRecordCount: false", () => {
      const unlimitedCountPolicy = createValidPolicy({
        maxCount: null,
        allowUnlimitedCount: true,
      });

      const result = validateRecordTypeLifecyclePolicy(unlimitedCountPolicy, validOrgLimits);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("forbid unlimited record count"))).toBe(true);
    });

    it("accepts unlimited age and count when organisation explicitly permits both", () => {
      const permissiveOrg: OrganizationLifecycleLimits = {
        ...validOrgLimits,
        maxRetentionDays: null,
        maxRecordCount: null,
        allowUnlimitedRetentionDays: true,
        allowUnlimitedRecordCount: true,
      };

      const unlimitedPolicy = createValidPolicy({
        maxAgeDays: null,
        maxCount: null,
        allowUnlimitedAge: true,
        allowUnlimitedCount: true,
      });

      const result = validateRecordTypeLifecyclePolicy(unlimitedPolicy, permissiveOrg);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("refuses archive_workflow when destination is not in allowedArchiveDestinations", () => {
      const archivePolicy = createValidPolicy({
        action: "archive_workflow",
        archiveWorkflowReference: "workflow.s3",
        archiveDestination: "unapproved_dropbox",
      });

      const result = validateRecordTypeLifecyclePolicy(archivePolicy, validOrgLimits, {
        workflowRegistrationAvailable: true,
        connectionAvailable: true,
      });
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("not in organisation's allowed destinations")),
      ).toBe(true);
    });

    it("refuses archive_workflow when workflow registration is unavailable and never falls back to deletion", () => {
      const archivePolicy = createValidPolicy({
        action: "archive_workflow",
        archiveWorkflowReference: "workflow.s3",
        archiveDestination: "cold_archive_s3",
      });

      const result = validateRecordTypeLifecyclePolicy(archivePolicy, validOrgLimits, {
        workflowRegistrationAvailable: false,
        connectionAvailable: true,
      });
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) =>
            e.includes("Workflow registration is unavailable") &&
            e.includes("cannot silently fall back to deletion"),
        ),
      ).toBe(true);
    });

    it("refuses archive_workflow when connection is unavailable and never falls back to deletion", () => {
      const archivePolicy = createValidPolicy({
        action: "archive_workflow",
        archiveWorkflowReference: "workflow.s3",
        archiveDestination: "cold_archive_s3",
      });

      const result = validateRecordTypeLifecyclePolicy(archivePolicy, validOrgLimits, {
        workflowRegistrationAvailable: true,
        connectionAvailable: false,
      });
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) =>
            e.includes("Connection for archive destination") &&
            e.includes("cannot silently fall back to deletion"),
        ),
      ).toBe(true);
    });

    it("refuses archive_workflow when capabilities parameter is omitted", () => {
      const archivePolicy = createValidPolicy({
        action: "archive_workflow",
        archiveWorkflowReference: "workflow.s3",
        archiveDestination: "cold_archive_s3",
      });

      // When capabilities are not verified, archive_workflow cannot be enabled
      const result = validateRecordTypeLifecyclePolicy(archivePolicy, validOrgLimits);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Workflow registration is unavailable"))).toBe(
        true,
      );
      expect(result.errors.some((e) => e.includes("Connection for archive destination"))).toBe(
        true,
      );
    });

    it("accepts archive_workflow when all capabilities and destinations are verified", () => {
      const archivePolicy = createValidPolicy({
        action: "archive_workflow",
        archiveWorkflowReference: "workflow.s3",
        archiveDestination: "cold_archive_s3",
      });

      const result = validateRecordTypeLifecyclePolicy(archivePolicy, validOrgLimits, {
        workflowRegistrationAvailable: true,
        connectionAvailable: true,
        registeredWorkflows: ["workflow.s3", "workflow.other"],
        availableConnections: ["cold_archive_s3"],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("refuses archive_workflow when reference is missing from registeredWorkflows list", () => {
      const archivePolicy = createValidPolicy({
        action: "archive_workflow",
        archiveWorkflowReference: "workflow.unregistered",
        archiveDestination: "cold_archive_s3",
      });

      const result = validateRecordTypeLifecyclePolicy(archivePolicy, validOrgLimits, {
        workflowRegistrationAvailable: true,
        connectionAvailable: true,
        registeredWorkflows: ["workflow.s3"],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("is not registered in runtime workflows"))).toBe(
        true,
      );
    });
  });

  describe("selectDueRecordsForLifecycleHandoff (#117 handoff)", () => {
    const baseDate = new Date("2026-09-21T00:00:00.000Z");

    const daysAgo = (days: number): string => {
      const d = new Date(baseDate.getTime() - days * 24 * 60 * 60 * 1000);
      return d.toISOString();
    };

    const createCandidate = (
      n: number,
      days: number,
      options?: { isHeld?: boolean; isProtected?: boolean; concurrencyNumber?: number },
    ): LifecycleCandidateRecord =>
      lifecycleCandidateRecordSchema.parse({
        recordId: uuid(n),
        createdAt: daysAgo(days),
        isHeld: options?.isHeld ?? false,
        isProtected: options?.isProtected ?? false,
        concurrencyNumber: options?.concurrencyNumber,
      });

    it("selects records due by age according to UTC elapsed time since creation", () => {
      const records: LifecycleCandidateRecord[] = [
        createCandidate(10, 100),
        createCandidate(11, 95),
        createCandidate(12, 30),
        createCandidate(13, 5),
      ];

      const policy = createValidPolicy({
        maxAgeDays: 90,
        maxCount: null,
        allowUnlimitedCount: true,
      });

      const handoff = selectDueRecordsForLifecycleHandoff({
        policy,
        records,
        evaluatedAt: baseDate,
      });

      expect(handoff.policyId).toBe(policy.policyId);
      expect(handoff.policyRevision).toBe(policy.policyRevision);
      expect(handoff.totalRetainedCount).toBe(4);
      expect(handoff.dueCount).toBe(2);
      expect(handoff.dueRecords).toHaveLength(2);
      expect(handoff.dueRecords.map((r) => r.recordId)).toEqual([uuid(10), uuid(11)]);
      expect(handoff.dueRecords[0]?.primaryReason).toBe("age");
      expect(handoff.dueRecords[0]?.action).toBe("delete");
      expect(handoff.blockedRecords).toHaveLength(0);
      expect(handoff.overLimitCondition.isOverLimit).toBe(false);
    });

    it("selects excess records oldest-created first when count ceiling is exceeded", () => {
      const records: LifecycleCandidateRecord[] = [
        createCandidate(10, 50),
        createCandidate(11, 40),
        createCandidate(12, 30),
        createCandidate(13, 20),
        createCandidate(14, 10),
      ];

      const policy = createValidPolicy({
        maxAgeDays: null,
        allowUnlimitedAge: true,
        maxCount: 3,
        allowUnlimitedCount: false,
      });

      const handoff = selectDueRecordsForLifecycleHandoff({
        policy,
        records,
        evaluatedAt: baseDate,
      });

      expect(handoff.totalRetainedCount).toBe(5);
      expect(handoff.dueCount).toBe(2);
      expect(handoff.dueRecords).toHaveLength(2);
      expect(handoff.dueRecords.map((r) => r.recordId)).toEqual([uuid(10), uuid(11)]);
      expect(handoff.dueRecords[0]?.primaryReason).toBe("count_excess");
      expect(handoff.blockedRecords).toHaveLength(0);
      expect(handoff.overLimitCondition.isOverLimit).toBe(false);
    });

    it("breaks ties with permanent record ID when created timestamps are identical", () => {
      const records: LifecycleCandidateRecord[] = [
        createCandidate(50, 25),
        createCandidate(20, 25),
        createCandidate(40, 25),
        createCandidate(10, 25),
        createCandidate(30, 25),
      ];

      const policy = createValidPolicy({
        maxAgeDays: null,
        allowUnlimitedAge: true,
        maxCount: 3,
        allowUnlimitedCount: false,
      });

      const handoff = selectDueRecordsForLifecycleHandoff({
        policy,
        records,
        evaluatedAt: baseDate,
      });

      expect(handoff.dueCount).toBe(2);
      expect(handoff.dueRecords.map((r) => r.recordId)).toEqual([uuid(10), uuid(20)]);
    });

    it("identifies records due by both age and excess count as 'both'", () => {
      const records: LifecycleCandidateRecord[] = [
        createCandidate(10, 100), // due by age (>90) AND count
        createCandidate(11, 95), // due by age (>90) AND count
        createCandidate(12, 80), // due by count (oldest of remaining)
        createCandidate(13, 10), // retained
        createCandidate(14, 5), // retained
      ];

      const policy = createValidPolicy({
        maxAgeDays: 90,
        allowUnlimitedAge: false,
        maxCount: 2,
        allowUnlimitedCount: false,
      });

      const handoff = selectDueRecordsForLifecycleHandoff({
        policy,
        records,
        evaluatedAt: baseDate,
      });

      expect(handoff.dueCount).toBe(3);
      const item10 = handoff.dueRecords.find((r) => r.recordId === uuid(10));
      const item11 = handoff.dueRecords.find((r) => r.recordId === uuid(11));
      const item12 = handoff.dueRecords.find((r) => r.recordId === uuid(12));

      expect(item10?.primaryReason).toBe("both");
      expect(item10?.dueReasons).toEqual(["age", "count_excess"]);
      expect(item11?.primaryReason).toBe("both");
      expect(item12?.primaryReason).toBe("count_excess");
      expect(item12?.dueReasons).toEqual(["count_excess"]);
    });

    it("blocks removal when records are held or protected and reports over-limit condition", () => {
      const records: LifecycleCandidateRecord[] = [
        createCandidate(10, 100, { isHeld: true }),
        createCandidate(11, 95, { isProtected: true }),
        createCandidate(12, 92, { isHeld: true, isProtected: true }),
        createCandidate(13, 91),
        createCandidate(14, 10),
      ];

      const policy = createValidPolicy({
        maxAgeDays: 90,
        maxCount: null,
        allowUnlimitedCount: true,
      });

      const handoff = selectDueRecordsForLifecycleHandoff({
        policy,
        records,
        evaluatedAt: baseDate,
      });

      expect(handoff.dueCount).toBe(4);
      expect(handoff.dueRecords).toHaveLength(1);
      expect(handoff.dueRecords[0]?.recordId).toBe(uuid(13));

      expect(handoff.blockedRecords).toHaveLength(3);
      expect(handoff.blockedRecords.map((r) => r.recordId)).toEqual([uuid(10), uuid(11), uuid(12)]);

      const block10 = handoff.blockedRecords.find((r) => r.recordId === uuid(10));
      const block11 = handoff.blockedRecords.find((r) => r.recordId === uuid(11));
      const block12 = handoff.blockedRecords.find((r) => r.recordId === uuid(12));

      expect(block10?.blockReason).toBe("legal_hold");
      expect(block11?.blockReason).toBe("recovery_protection");
      expect(block12?.blockReason).toBe("held_and_protected");

      // Over-limit condition is reported visibly
      expect(handoff.overLimitCondition.isOverLimit).toBe(true);
      expect(handoff.overLimitCondition.blockedCount).toBe(3);
      expect(handoff.overLimitCondition.blockedRecordIds).toEqual([uuid(10), uuid(11), uuid(12)]);
      expect(handoff.overLimitCondition.description).toContain(
        "Record lifecycle over-limit condition",
      );
      expect(handoff.overLimitCondition.description).toContain(
        "Create operations remain permitted",
      );
      expect(handoff.overLimitCondition.description).toContain("silent deletion is prohibited");
    });

    it("hands off archive_workflow action and destination metadata for #117 durable executor", () => {
      const records: LifecycleCandidateRecord[] = [
        createCandidate(10, 100, { concurrencyNumber: 4 }),
      ];

      const archivePolicy = createValidPolicy({
        action: "archive_workflow",
        archiveWorkflowReference: "workflow.cold_storage.archive",
        archiveDestination: "cold_archive_s3",
        maxAgeDays: 90,
        maxCount: null,
        allowUnlimitedCount: true,
      });

      const handoff = selectDueRecordsForLifecycleHandoff({
        policy: archivePolicy,
        records,
        evaluatedAt: baseDate,
      });

      expect(handoff.action).toBe("archive_workflow");
      expect(handoff.archiveWorkflowReference).toBe("workflow.cold_storage.archive");
      expect(handoff.archiveDestination).toBe("cold_archive_s3");
      expect(handoff.dueRecords[0]?.action).toBe("archive_workflow");
      expect(handoff.dueRecords[0]?.archiveWorkflowReference).toBe("workflow.cold_storage.archive");
      expect(handoff.dueRecords[0]?.archiveDestination).toBe("cold_archive_s3");
      expect(handoff.dueRecords[0]?.concurrencyNumber).toBe(4);
    });

    it("preserves organisation-shared scope with applicationRootId as null in handoff", () => {
      const sharedPolicy = createValidPolicy({
        applicationRootId: null,
        maxAgeDays: 30,
      });

      const handoff = selectDueRecordsForLifecycleHandoff({
        policy: sharedPolicy,
        records: [createCandidate(1, 40)],
        evaluatedAt: baseDate,
      });

      expect(handoff.applicationRootId).toBeNull();
    });

    it("conforms strictly to recordLifecycleHandoffSchema", () => {
      const handoff = selectDueRecordsForLifecycleHandoff({
        policy: createValidPolicy(),
        records: [createCandidate(1, 100)],
        evaluatedAt: baseDate,
      });

      const parsed = recordLifecycleHandoffSchema.parse(handoff);
      expect(parsed.policyId).toBe(createValidPolicy().policyId);
      expect(parsed.dueCount).toBe(1);
    });

    it("is accessible via the evaluateRecordLifecycleHandoff alias", () => {
      expect(evaluateRecordLifecycleHandoff).toBe(selectDueRecordsForLifecycleHandoff);
    });
  });
});
