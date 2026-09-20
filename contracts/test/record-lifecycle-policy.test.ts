import { describe, expect, it } from "vitest";
import {
  activeConnectionEvidenceSchema,
  archiveWorkflowRecordLifecyclePolicySchema,
  blockedRemovalRecordSchema,
  deleteRecordLifecyclePolicySchema,
  dueArchiveRecordHandoffItemSchema,
  dueDeleteRecordHandoffItemSchema,
  dueRecordHandoffItemSchema,
  evaluateRecordLifecycleHandoff,
  lifecycleCandidateRecordSchema,
  lifecycleReadinessEvidenceSchema,
  lifecycleStatusReportSchema,
  organizationLifecycleLimitsSchema,
  recordLifecycleActionSchema,
  recordLifecycleHandoffSchema,
  recordLifecyclePolicyIdSchema,
  recordTypeLifecyclePolicySchema,
  registeredWorkflowEvidenceSchema,
  selectDueRecordsForLifecycleHandoff,
  validateRecordTypeLifecyclePolicy,
  validateRecordTypeLifecyclePolicyDefinition,
  type ArchiveWorkflowRecordLifecyclePolicy,
  type DeleteRecordLifecyclePolicy,
  type LifecycleCandidateRecord,
  type LifecycleReadinessEvidence,
  type OrganizationLifecycleLimits,
} from "../src";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("record lifecycle policy contracts and organisation limits", () => {
  const orgA = uuid(1);
  const orgB = uuid(2);

  const createValidOrgLimits = (
    overrides: Partial<Record<string, unknown>> = {},
  ): OrganizationLifecycleLimits =>
    organizationLifecycleLimitsSchema.parse({
      organizationId: orgA,
      settingsRevision: 1,
      maxRetentionDays: 365,
      maxRecordCount: 10_000,
      allowUnlimitedRetentionDays: false,
      allowUnlimitedRecordCount: false,
      allowedActions: ["delete", "archive_workflow"],
      allowedArchiveDestinations: ["cold_archive_s3", "compliance_vault"],
      ...overrides,
    });

  const validOrgLimits = createValidOrgLimits();

  const createValidDeletePolicy = (
    overrides: Partial<Record<string, unknown>> = {},
  ): DeleteRecordLifecyclePolicy =>
    deleteRecordLifecyclePolicySchema.parse({
      policyId: uuid(10),
      organizationId: orgA,
      storageContractId: uuid(20),
      applicationRootId: uuid(30),
      policyRevision: 1,
      maxAgeDays: 90,
      maxCount: 1_000,
      action: "delete",
      allowUnlimitedAge: false,
      allowUnlimitedCount: false,
      ...overrides,
    });

  const createValidArchivePolicy = (
    overrides: Partial<Record<string, unknown>> = {},
  ): ArchiveWorkflowRecordLifecyclePolicy =>
    archiveWorkflowRecordLifecyclePolicySchema.parse({
      policyId: uuid(11),
      organizationId: orgA,
      storageContractId: uuid(20),
      applicationRootId: uuid(30),
      policyRevision: 1,
      maxAgeDays: 90,
      maxCount: 1_000,
      action: "archive_workflow",
      archiveWorkflowId: uuid(40),
      expectedWorkflowRevision: 2,
      archiveConnectionInstanceId: uuid(50),
      archiveDestination: "cold_archive_s3",
      allowUnlimitedAge: false,
      allowUnlimitedCount: false,
      ...overrides,
    });

  const createValidReadinessEvidence = (
    overrides: Partial<Record<string, unknown>> = {},
  ): LifecycleReadinessEvidence =>
    lifecycleReadinessEvidenceSchema.parse({
      organizationId: orgA,
      registeredWorkflows: [
        {
          workflowId: uuid(40),
          workflowRevision: 2,
          state: "active",
        },
      ],
      activeConnections: [
        {
          connectionInstanceId: uuid(50),
          destinationKey: "cold_archive_s3",
          organizationId: orgA,
          state: "active",
        },
      ],
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

    it("validates lifecycleCandidateRecordSchema with mandatory expectedRecordRevision", () => {
      const candidate = lifecycleCandidateRecordSchema.parse({
        recordId: uuid(1),
        expectedRecordRevision: 3,
        createdAt: "2026-09-21T00:00:00.000Z",
        isHeld: true,
        isProtected: false,
      });
      expect(candidate.recordId).toBe(uuid(1));
      expect(candidate.expectedRecordRevision).toBe(3);
      expect(candidate.isHeld).toBe(true);
      expect(candidate.isProtected).toBe(false);

      // Rejects candidate missing expectedRecordRevision
      expect(
        lifecycleCandidateRecordSchema.safeParse({
          recordId: uuid(1),
          createdAt: "2026-09-21T00:00:00.000Z",
        }).success,
      ).toBe(false);
    });

    it("validates registeredWorkflowEvidenceSchema and activeConnectionEvidenceSchema", () => {
      const wf = registeredWorkflowEvidenceSchema.parse({
        workflowId: uuid(1),
        workflowRevision: 1,
        state: "active",
      });
      expect(wf.state).toBe("active");

      const conn = activeConnectionEvidenceSchema.parse({
        connectionInstanceId: uuid(2),
        destinationKey: "s3_archive",
        organizationId: orgA,
        state: "active",
      });
      expect(conn.destinationKey).toBe("s3_archive");
    });
  });

  describe("organizationLifecycleLimitsSchema", () => {
    it("accepts valid bounded organisation limits with all fields", () => {
      const parsed = organizationLifecycleLimitsSchema.parse(validOrgLimits);
      expect(parsed.organizationId).toBe(orgA);
      expect(parsed.settingsRevision).toBe(1);
      expect(parsed.maxRetentionDays).toBe(365);
      expect(parsed.maxRecordCount).toBe(10_000);
      expect(parsed.allowUnlimitedRetentionDays).toBe(false);
      expect(parsed.allowUnlimitedRecordCount).toBe(false);
      expect(parsed.allowedActions).toEqual(["delete", "archive_workflow"]);
      expect(parsed.allowedArchiveDestinations).toEqual(["cold_archive_s3", "compliance_vault"]);
    });

    it("accepts closed unlimited representation when explicitly allowed", () => {
      const parsed = organizationLifecycleLimitsSchema.parse({
        organizationId: orgA,
        settingsRevision: 2,
        maxRetentionDays: null,
        maxRecordCount: null,
        allowUnlimitedRetentionDays: true,
        allowUnlimitedRecordCount: true,
        allowedActions: ["delete"],
        allowedArchiveDestinations: [],
      });
      expect(parsed.maxRetentionDays).toBeNull();
      expect(parsed.allowUnlimitedRetentionDays).toBe(true);
      expect(parsed.maxRecordCount).toBeNull();
      expect(parsed.allowUnlimitedRecordCount).toBe(true);
    });

    it("rejects contradictory finite ceiling plus allowUnlimited: true", () => {
      // Finite days + unlimited days
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          maxRetentionDays: 365,
          allowUnlimitedRetentionDays: true,
        }).success,
      ).toBe(false);

      // Finite count + unlimited count
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          maxRecordCount: 500,
          allowUnlimitedRecordCount: true,
        }).success,
      ).toBe(false);
    });

    it("rejects missing limit when allowUnlimited is false (no implicit unlimited fallback)", () => {
      // Days missing with allowUnlimited: false
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          maxRetentionDays: null,
          allowUnlimitedRetentionDays: false,
        }).success,
      ).toBe(false);

      // Count missing with allowUnlimited: false
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          maxRecordCount: null,
          allowUnlimitedRecordCount: false,
        }).success,
      ).toBe(false);
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
    });

    it("rejects empty allowedActions and duplicate actions", () => {
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          allowedActions: [],
        }).success,
      ).toBe(false);

      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          allowedActions: ["delete", "delete"],
        }).success,
      ).toBe(false);
    });

    it("rejects archive_workflow when allowedArchiveDestinations is empty", () => {
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          allowedActions: ["archive_workflow"],
          allowedArchiveDestinations: [],
        }).success,
      ).toBe(false);
    });

    it("rejects URLs and SQL escape hatches in allowedArchiveDestinations", () => {
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          allowedArchiveDestinations: ["https://external-s3.com/archive"],
        }).success,
      ).toBe(false);

      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          allowedArchiveDestinations: ["postgres://user:pass@host/db"],
        }).success,
      ).toBe(false);

      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          allowedArchiveDestinations: ["SELECT * FROM records"],
        }).success,
      ).toBe(false);
    });

    it("enforces strict schema by rejecting unknown properties", () => {
      expect(
        organizationLifecycleLimitsSchema.safeParse({
          ...validOrgLimits,
          unauthorizedSetting: true,
        }).success,
      ).toBe(false);
    });
  });

  describe("discriminated recordTypeLifecyclePolicySchema", () => {
    it("accepts a valid recoverable deletion policy with finite age and count", () => {
      const policy = createValidDeletePolicy();
      expect(policy.action).toBe("delete");
      expect(policy.policyId).toBe(uuid(10));
      expect(policy.organizationId).toBe(orgA);
      expect(policy.storageContractId).toBe(uuid(20));
      expect(policy.applicationRootId).toBe(uuid(30));
      expect(policy.policyRevision).toBe(1);
      expect(policy.maxAgeDays).toBe(90);
      expect(policy.maxCount).toBe(1_000);
      expect(policy.allowUnlimitedAge).toBe(false);
      expect(policy.allowUnlimitedCount).toBe(false);
    });

    it("strictly forbids archive metadata on delete policies", () => {
      expect(
        deleteRecordLifecyclePolicySchema.safeParse({
          ...createValidDeletePolicy(),
          archiveWorkflowId: uuid(40),
        }).success,
      ).toBe(false);

      expect(
        deleteRecordLifecyclePolicySchema.safeParse({
          ...createValidDeletePolicy(),
          archiveDestination: "cold_archive_s3",
        }).success,
      ).toBe(false);
    });

    it("accepts an organisation-shared policy with applicationRootId as null", () => {
      const shared = createValidDeletePolicy({ applicationRootId: null });
      expect(shared.applicationRootId).toBeNull();
    });

    it("accepts archive_workflow policy with exact typed workflow, revision, connection and destination", () => {
      const archivePolicy = createValidArchivePolicy();
      expect(archivePolicy.action).toBe("archive_workflow");
      expect(archivePolicy.archiveWorkflowId).toBe(uuid(40));
      expect(archivePolicy.expectedWorkflowRevision).toBe(2);
      expect(archivePolicy.archiveConnectionInstanceId).toBe(uuid(50));
      expect(archivePolicy.archiveDestination).toBe("cold_archive_s3");
    });

    it("rejects archive_workflow missing any of the required archive fields", () => {
      expect(
        archiveWorkflowRecordLifecyclePolicySchema.safeParse({
          ...createValidArchivePolicy(),
          archiveWorkflowId: undefined,
        }).success,
      ).toBe(false);

      expect(
        archiveWorkflowRecordLifecyclePolicySchema.safeParse({
          ...createValidArchivePolicy(),
          expectedWorkflowRevision: undefined,
        }).success,
      ).toBe(false);

      expect(
        archiveWorkflowRecordLifecyclePolicySchema.safeParse({
          ...createValidArchivePolicy(),
          archiveConnectionInstanceId: undefined,
        }).success,
      ).toBe(false);

      expect(
        archiveWorkflowRecordLifecyclePolicySchema.safeParse({
          ...createValidArchivePolicy(),
          archiveDestination: "",
        }).success,
      ).toBe(false);
    });

    it("rejects URLs, connection strings and SQL escape hatches in archiveDestination", () => {
      expect(
        archiveWorkflowRecordLifecyclePolicySchema.safeParse({
          ...createValidArchivePolicy(),
          archiveDestination: "https://archive.example.com",
        }).success,
      ).toBe(false);

      expect(
        archiveWorkflowRecordLifecyclePolicySchema.safeParse({
          ...createValidArchivePolicy(),
          archiveDestination: "postgres://db.vortex.internal",
        }).success,
      ).toBe(false);

      expect(
        archiveWorkflowRecordLifecyclePolicySchema.safeParse({
          ...createValidArchivePolicy(),
          archiveDestination: "SELECT * FROM vault",
        }).success,
      ).toBe(false);
    });

    it("requires JSON-safe positive integer policyRevision", () => {
      const policy = createValidDeletePolicy({ policyRevision: 5 });
      expect(policy.policyRevision).toBe(5);
      expect(typeof policy.policyRevision).toBe("number");

      expect(
        deleteRecordLifecyclePolicySchema.safeParse({
          ...createValidDeletePolicy(),
          policyRevision: 0,
        }).success,
      ).toBe(false);

      expect(
        deleteRecordLifecyclePolicySchema.safeParse({
          ...createValidDeletePolicy(),
          policyRevision: -1,
        }).success,
      ).toBe(false);
    });

    it("rejects nil UUID for policy identifiers", () => {
      const nil = "00000000-0000-0000-0000-000000000000";
      expect(
        deleteRecordLifecyclePolicySchema.safeParse({
          ...createValidDeletePolicy(),
          policyId: nil,
        }).success,
      ).toBe(false);

      expect(
        deleteRecordLifecyclePolicySchema.safeParse({
          ...createValidDeletePolicy(),
          organizationId: nil,
        }).success,
      ).toBe(false);

      expect(
        deleteRecordLifecyclePolicySchema.safeParse({
          ...createValidDeletePolicy(),
          storageContractId: nil,
        }).success,
      ).toBe(false);
    });

    it("rejects contradictory age and count settings", () => {
      expect(
        deleteRecordLifecyclePolicySchema.safeParse({
          ...createValidDeletePolicy(),
          allowUnlimitedAge: true,
          maxAgeDays: 90,
        }).success,
      ).toBe(false);

      expect(
        deleteRecordLifecyclePolicySchema.safeParse({
          ...createValidDeletePolicy(),
          allowUnlimitedCount: true,
          maxCount: 100,
        }).success,
      ).toBe(false);
    });

    it("rejects missing age and count settings", () => {
      expect(
        deleteRecordLifecyclePolicySchema.safeParse({
          ...createValidDeletePolicy(),
          allowUnlimitedAge: false,
          maxAgeDays: null,
        }).success,
      ).toBe(false);

      expect(
        deleteRecordLifecyclePolicySchema.safeParse({
          ...createValidDeletePolicy(),
          allowUnlimitedCount: false,
          maxCount: null,
        }).success,
      ).toBe(false);
    });
  });

  describe("definition-only vs live activation validation", () => {
    it("validates declared shape independently from live activation", () => {
      const declaredDelete = createValidDeletePolicy();
      const declaredArchive = createValidArchivePolicy();

      const defResultDelete = validateRecordTypeLifecyclePolicyDefinition(declaredDelete);
      expect(defResultDelete.valid).toBe(true);

      const defResultArchive = validateRecordTypeLifecyclePolicyDefinition(declaredArchive);
      expect(defResultArchive.valid).toBe(true);

      // Rejects malformed declared shape
      const invalidShape = { ...declaredDelete, maxAgeDays: -5 };
      expect(validateRecordTypeLifecyclePolicyDefinition(invalidShape).valid).toBe(false);
    });

    it("enforces cross-organisation isolation during live activation validation", () => {
      const policyOrgB = createValidDeletePolicy({ organizationId: orgB });

      // Pass orgA limits to orgB policy -> MUST reject
      const result = validateRecordTypeLifecyclePolicy(policyOrgB, validOrgLimits);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("cross-organisation policy application"))).toBe(
        true,
      );
    });

    it("accepts a policy within organisation ceilings and allowed actions", () => {
      const policy = createValidDeletePolicy();
      const result = validateRecordTypeLifecyclePolicy(policy, validOrgLimits);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("refuses policy when action is not in organisation allowedActions", () => {
      const deleteOnlyOrg: OrganizationLifecycleLimits = {
        ...validOrgLimits,
        allowedActions: ["delete"],
        allowedArchiveDestinations: [],
      };
      const archivePolicy = createValidArchivePolicy();

      const result = validateRecordTypeLifecyclePolicy(
        archivePolicy,
        deleteOnlyOrg,
        createValidReadinessEvidence(),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("not permitted by organisation limits"))).toBe(
        true,
      );
    });

    it("refuses policy when maxAgeDays exceeds organisation ceiling", () => {
      const exceeding = createValidDeletePolicy({ maxAgeDays: 400 });
      const result = validateRecordTypeLifecyclePolicy(exceeding, validOrgLimits);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exceeds organisation limit"))).toBe(true);
    });

    it("refuses policy when maxCount exceeds organisation ceiling", () => {
      const exceeding = createValidDeletePolicy({ maxCount: 20_000 });
      const result = validateRecordTypeLifecyclePolicy(exceeding, validOrgLimits);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exceeds organisation limit"))).toBe(true);
    });

    it("refuses unlimited age or count when organisation limits forbid them", () => {
      const unlimitedAge = createValidDeletePolicy({
        maxAgeDays: null,
        allowUnlimitedAge: true,
      });
      expect(validateRecordTypeLifecyclePolicy(unlimitedAge, validOrgLimits).valid).toBe(false);

      const unlimitedCount = createValidDeletePolicy({
        maxCount: null,
        allowUnlimitedCount: true,
      });
      expect(validateRecordTypeLifecyclePolicy(unlimitedCount, validOrgLimits).valid).toBe(false);
    });

    it("accepts unlimited age and count when organisation explicitly permits both", () => {
      const permissiveOrg: OrganizationLifecycleLimits = {
        ...validOrgLimits,
        maxRetentionDays: null,
        maxRecordCount: null,
        allowUnlimitedRetentionDays: true,
        allowUnlimitedRecordCount: true,
      };
      const unlimited = createValidDeletePolicy({
        maxAgeDays: null,
        maxCount: null,
        allowUnlimitedAge: true,
        allowUnlimitedCount: true,
      });
      expect(validateRecordTypeLifecyclePolicy(unlimited, permissiveOrg).valid).toBe(true);
    });

    it("refuses archive_workflow when destination is not in allowedArchiveDestinations", () => {
      const archivePolicy = createValidArchivePolicy({
        archiveDestination: "unapproved_destination",
      });
      const result = validateRecordTypeLifecyclePolicy(
        archivePolicy,
        validOrgLimits,
        createValidReadinessEvidence(),
      );
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("not in organisation's allowed destinations")),
      ).toBe(true);
    });

    it("refuses archive_workflow when readiness evidence is missing (no silent fallback)", () => {
      const archivePolicy = createValidArchivePolicy();
      const result = validateRecordTypeLifecyclePolicy(archivePolicy, validOrgLimits);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Readiness evidence is required"))).toBe(true);
    });

    it("refuses archive_workflow when readiness evidence belongs to another organisation", () => {
      const archivePolicy = createValidArchivePolicy();
      const foreignEvidence = createValidReadinessEvidence({ organizationId: orgB });

      const result = validateRecordTypeLifecyclePolicy(
        archivePolicy,
        validOrgLimits,
        foreignEvidence,
      );
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) =>
          e.includes("Readiness evidence organizationId does not match policy organizationId"),
        ),
      ).toBe(true);
    });

    it("refuses archive_workflow when registered workflow is unavailable or revision mismatch", () => {
      const archivePolicy = createValidArchivePolicy({
        archiveWorkflowId: uuid(40),
        expectedWorkflowRevision: 5,
      });
      const evidence = createValidReadinessEvidence({
        registeredWorkflows: [
          {
            workflowId: uuid(40),
            workflowRevision: 2, // does not match expected 5
            state: "active",
          },
        ],
      });

      const result = validateRecordTypeLifecyclePolicy(archivePolicy, validOrgLimits, evidence);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("is not registered in runtime workflows"))).toBe(
        true,
      );
    });

    it("refuses archive_workflow when connection instance is unavailable", () => {
      const archivePolicy = createValidArchivePolicy({
        archiveConnectionInstanceId: uuid(99),
      });
      const evidence = createValidReadinessEvidence(); // contains uuid(50), not uuid(99)

      const result = validateRecordTypeLifecyclePolicy(archivePolicy, validOrgLimits, evidence);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("is unavailable"))).toBe(true);
    });

    it("accepts archive_workflow when exact typed registration and connection evidence are verified", () => {
      const archivePolicy = createValidArchivePolicy();
      const evidence = createValidReadinessEvidence();
      const result = validateRecordTypeLifecyclePolicy(archivePolicy, validOrgLimits, evidence);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("selectDueRecordsForLifecycleHandoff (#117 handoff)", () => {
    const baseDate = new Date("2026-09-21T00:00:00.000Z");

    const daysAgo = (days: number): string => {
      const d = new Date(baseDate.getTime() - days * 24 * 60 * 60 * 1000);
      return d.toISOString();
    };

    const candidate = (
      n: number,
      days: number,
      expectedRevision = 1,
      options?: { isHeld?: boolean; isProtected?: boolean },
    ): LifecycleCandidateRecord => ({
      recordId: uuid(n) as unknown as LifecycleCandidateRecord["recordId"],
      expectedRecordRevision: expectedRevision,
      createdAt: daysAgo(days),
      isHeld: options?.isHeld ?? false,
      isProtected: options?.isProtected ?? false,
    });

    it("rejects duplicate candidate record IDs", () => {
      const records = [candidate(1, 10), candidate(1, 10)];
      expect(() =>
        selectDueRecordsForLifecycleHandoff({
          policy: createValidDeletePolicy(),
          records,
          evaluatedAt: baseDate,
        }),
      ).toThrow("Duplicate candidate recordId detected");
    });

    it("rejects invalid evaluatedAt timestamp", () => {
      expect(() =>
        selectDueRecordsForLifecycleHandoff({
          policy: createValidDeletePolicy(),
          records: [candidate(1, 10)],
          evaluatedAt: "invalid-date",
        }),
      ).toThrow("Invalid evaluatedAt timestamp");
    });

    it("selects records due by age according to UTC elapsed time since creation", () => {
      const records = [
        candidate(10, 100, 1),
        candidate(11, 95, 2),
        candidate(12, 30, 3),
        candidate(13, 5, 4),
      ];

      const policy = createValidDeletePolicy({
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
      expect(handoff.dueRecords[0]?.expectedRecordRevision).toBe(1);
      expect(handoff.dueRecords[1]?.expectedRecordRevision).toBe(2);
      expect(handoff.dueRecords[0]?.action).toBe("delete");
      expect(handoff.blockedRecords).toHaveLength(0);

      // Truthful pending removal status
      expect(handoff.statusReport.status).toBe("pending_removal");
      expect(handoff.statusReport.isOverLimit).toBe(false);
      expect(handoff.statusReport.pendingRemovalCount).toBe(2);
      expect(handoff.statusReport.description).toContain("2 record(s) pending removal by executor");
    });

    it("selects excess records oldest-created first when count ceiling is exceeded", () => {
      const records = [
        candidate(10, 50),
        candidate(11, 40),
        candidate(12, 30),
        candidate(13, 20),
        candidate(14, 10),
      ];

      const policy = createValidDeletePolicy({
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
      expect(handoff.dueRecords.map((r) => r.recordId)).toEqual([uuid(10), uuid(11)]);
      expect(handoff.statusReport.status).toBe("pending_removal");
    });

    it("breaks ties with canonical lowercase UUID comparison when created timestamps are identical", () => {
      const sameTimestamp = daysAgo(25);
      // Mix uppercase and lowercase in input candidates to prove canonical casing tie-breaker
      const records: LifecycleCandidateRecord[] = [
        {
          recordId: uuid(50).toUpperCase() as unknown as LifecycleCandidateRecord["recordId"],
          expectedRecordRevision: 1,
          createdAt: sameTimestamp,
          isHeld: false,
          isProtected: false,
        },
        {
          recordId: uuid(20).toLowerCase() as unknown as LifecycleCandidateRecord["recordId"],
          expectedRecordRevision: 1,
          createdAt: sameTimestamp,
          isHeld: false,
          isProtected: false,
        },
        {
          recordId: uuid(40).toUpperCase() as unknown as LifecycleCandidateRecord["recordId"],
          expectedRecordRevision: 1,
          createdAt: sameTimestamp,
          isHeld: false,
          isProtected: false,
        },
        {
          recordId: uuid(10).toLowerCase() as unknown as LifecycleCandidateRecord["recordId"],
          expectedRecordRevision: 1,
          createdAt: sameTimestamp,
          isHeld: false,
          isProtected: false,
        },
        {
          recordId: uuid(30).toUpperCase() as unknown as LifecycleCandidateRecord["recordId"],
          expectedRecordRevision: 1,
          createdAt: sameTimestamp,
          isHeld: false,
          isProtected: false,
        },
      ];

      const policy = createValidDeletePolicy({
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
      expect(handoff.dueRecords.map((r) => r.recordId.toLowerCase())).toEqual([uuid(10), uuid(20)]);
    });

    it("identifies records due by both age and excess count as 'both'", () => {
      const records = [
        candidate(10, 100), // due by age (>90) AND count
        candidate(11, 95), // due by age (>90) AND count
        candidate(12, 80), // due by count (oldest remaining)
        candidate(13, 10), // retained
        candidate(14, 5), // retained
      ];

      const policy = createValidDeletePolicy({
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

    it("blocks removal when records are held or protected and reports truthful over-limit status", () => {
      const records = [
        candidate(10, 100, 1, { isHeld: true }),
        candidate(11, 95, 2, { isProtected: true }),
        candidate(12, 92, 3, { isHeld: true, isProtected: true }),
        candidate(13, 91, 4), // eligible
        candidate(14, 10, 5), // not due
      ];

      const policy = createValidDeletePolicy({
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
      expect(handoff.dueRecords[0]?.expectedRecordRevision).toBe(4);

      expect(handoff.blockedRecords).toHaveLength(3);
      expect(handoff.blockedRecords.map((r) => r.recordId)).toEqual([uuid(10), uuid(11), uuid(12)]);

      const block10 = handoff.blockedRecords.find((r) => r.recordId === uuid(10));
      const block11 = handoff.blockedRecords.find((r) => r.recordId === uuid(11));
      const block12 = handoff.blockedRecords.find((r) => r.recordId === uuid(12));

      expect(block10?.blockReason).toBe("legal_hold");
      expect(block10?.expectedRecordRevision).toBe(1);
      expect(block11?.blockReason).toBe("recovery_protection");
      expect(block11?.expectedRecordRevision).toBe(2);
      expect(block12?.blockReason).toBe("held_and_protected");
      expect(block12?.expectedRecordRevision).toBe(3);

      // Truthful pending and blocked status
      expect(handoff.statusReport.status).toBe("pending_and_blocked");
      expect(handoff.statusReport.isOverLimit).toBe(true);
      expect(handoff.statusReport.blockedRemovalCount).toBe(3);
      expect(handoff.statusReport.pendingRemovalCount).toBe(1);
      expect(handoff.statusReport.blockedRecordIds).toEqual([uuid(10), uuid(11), uuid(12)]);
      expect(handoff.statusReport.description).toContain("1 record(s) pending removal");
      expect(handoff.statusReport.description).toContain("3 due record(s) blocked");
      expect(handoff.statusReport.description).toContain("Create operations remain permitted");
      expect(handoff.statusReport.description).toContain("silent deletion is prohibited");
    });

    it("hands off archive_workflow action with exact typed metadata for #117 executor", () => {
      const records = [candidate(10, 100, 7)];

      const archivePolicy = createValidArchivePolicy({
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
      expect(handoff.archiveMetadata).toEqual({
        archiveWorkflowId: uuid(40),
        expectedWorkflowRevision: 2,
        archiveConnectionInstanceId: uuid(50),
        archiveDestination: "cold_archive_s3",
      });

      const dueItem = handoff.dueRecords[0]!;
      expect(dueItem.action).toBe("archive_workflow");
      if (dueItem.action === "archive_workflow") {
        expect(dueItem.archiveWorkflowId).toBe(uuid(40));
        expect(dueItem.expectedWorkflowRevision).toBe(2);
        expect(dueItem.archiveConnectionInstanceId).toBe(uuid(50));
        expect(dueItem.archiveDestination).toBe("cold_archive_s3");
        expect(dueItem.expectedRecordRevision).toBe(7);
      }
    });

    it("preserves organisation-shared scope with applicationRootId as null in handoff", () => {
      const sharedPolicy = createValidDeletePolicy({
        applicationRootId: null,
        maxAgeDays: 30,
      });

      const handoff = selectDueRecordsForLifecycleHandoff({
        policy: sharedPolicy,
        records: [candidate(1, 40)],
        evaluatedAt: baseDate,
      });

      expect(handoff.applicationRootId).toBeNull();
    });

    it("guarantees JSON round-trip serialization without throwing or loss", () => {
      const records = [candidate(10, 100, 1, { isHeld: true }), candidate(11, 95, 2)];

      const handoff = selectDueRecordsForLifecycleHandoff({
        policy: createValidArchivePolicy({ maxAgeDays: 90 }),
        records,
        evaluatedAt: baseDate,
      });

      // JSON.stringify must not throw on any BigInt or non-serializable property
      const jsonString = JSON.stringify(handoff);
      expect(typeof jsonString).toBe("string");

      // JSON.parse must round trip through the strict aggregate handoff schema
      const parsedJson = JSON.parse(jsonString);
      const parsedHandoff = recordLifecycleHandoffSchema.parse(parsedJson);

      expect(parsedHandoff.policyId).toBe(handoff.policyId);
      expect(parsedHandoff.policyRevision).toBe(handoff.policyRevision);
      expect(parsedHandoff.dueCount).toBe(2);
      expect(parsedHandoff.dueRecords[0]?.expectedRecordRevision).toBe(2);
      expect(parsedHandoff.blockedRecords[0]?.expectedRecordRevision).toBe(1);
    });

    it("is accessible via the evaluateRecordLifecycleHandoff alias", () => {
      expect(evaluateRecordLifecycleHandoff).toBe(selectDueRecordsForLifecycleHandoff);
    });
  });

  describe("malformed aggregate handoff negative tests", () => {
    const validHandoffPayload = () => ({
      policyId: uuid(1),
      policyRevision: 1,
      organizationId: orgA,
      storageContractId: uuid(2),
      applicationRootId: uuid(3),
      action: "delete" as const,
      evaluatedAt: "2026-09-21T00:00:00.000Z",
      totalRetainedCount: 2,
      dueCount: 2,
      dueRecords: [
        {
          recordId: uuid(10),
          expectedRecordRevision: 1,
          dueReasons: ["age" as "age" | "count_excess"],
          primaryReason: "age" as "age" | "count_excess" | "both",
          action: "delete" as const,
          createdAt: "2026-09-20T00:00:00.000Z",
        },
      ],
      blockedRecords: [
        {
          recordId: uuid(11),
          expectedRecordRevision: 1,
          dueReasons: ["count_excess" as const],
          primaryReason: "count_excess" as const,
          blockReason: "legal_hold" as const,
          createdAt: "2026-09-19T00:00:00.000Z",
        },
      ],
      statusReport: {
        status: "pending_and_blocked" as const,
        isOverLimit: true,
        pendingRemovalCount: 1,
        blockedRemovalCount: 1,
        excessCount: 1,
        expiredAgeCount: 1,
        blockedRecordIds: [uuid(11)],
        description: "Test description",
      },
    });

    it("rejects handoff when dueCount disagrees with sum of arrays", () => {
      expect(
        recordLifecycleHandoffSchema.safeParse({
          ...validHandoffPayload(),
          dueCount: 99, // actual is 2
        }).success,
      ).toBe(false);
    });

    it("rejects handoff when statusReport counts disagree with arrays", () => {
      expect(
        recordLifecycleHandoffSchema.safeParse({
          ...validHandoffPayload(),
          statusReport: {
            ...validHandoffPayload().statusReport,
            pendingRemovalCount: 0, // actual is 1
          },
        }).success,
      ).toBe(false);

      expect(
        recordLifecycleHandoffSchema.safeParse({
          ...validHandoffPayload(),
          statusReport: {
            ...validHandoffPayload().statusReport,
            blockedRemovalCount: 0, // actual is 1
          },
        }).success,
      ).toBe(false);
    });

    it("rejects duplicate record IDs within dueRecords or blockedRecords", () => {
      // Duplicate in dueRecords
      const dupDue = validHandoffPayload();
      dupDue.dueRecords.push({ ...dupDue.dueRecords[0]! });
      dupDue.dueCount = 3;
      dupDue.statusReport.pendingRemovalCount = 2;
      expect(recordLifecycleHandoffSchema.safeParse(dupDue).success).toBe(false);

      // Duplicate in blockedRecords
      const dupBlocked = validHandoffPayload();
      dupBlocked.blockedRecords.push({ ...dupBlocked.blockedRecords[0]! });
      dupBlocked.dueCount = 3;
      dupBlocked.statusReport.blockedRemovalCount = 2;
      expect(recordLifecycleHandoffSchema.safeParse(dupBlocked).success).toBe(false);
    });

    it("rejects the same recordId present in both dueRecords and blockedRecords", () => {
      const overlap = validHandoffPayload();
      overlap.blockedRecords[0]!.recordId = overlap.dueRecords[0]!.recordId;
      expect(recordLifecycleHandoffSchema.safeParse(overlap).success).toBe(false);
    });

    it("rejects contradictory primaryReason vs dueReasons in handoff items", () => {
      const contradictory = validHandoffPayload();
      contradictory.dueRecords[0]!.primaryReason = "both";
      contradictory.dueRecords[0]!.dueReasons = ["age"]; // missing count_excess for "both"
      expect(recordLifecycleHandoffSchema.safeParse(contradictory).success).toBe(false);

      const dupReasons = validHandoffPayload();
      dupReasons.dueRecords[0]!.dueReasons = ["age", "age"];
      expect(recordLifecycleHandoffSchema.safeParse(dupReasons).success).toBe(false);
    });

    it("rejects delete action carrying archiveMetadata and archive_workflow missing archiveMetadata", () => {
      // Delete with archiveMetadata
      expect(
        recordLifecycleHandoffSchema.safeParse({
          ...validHandoffPayload(),
          archiveMetadata: {
            archiveWorkflowId: uuid(40),
            expectedWorkflowRevision: 1,
            archiveConnectionInstanceId: uuid(50),
            archiveDestination: "cold_archive_s3",
          },
        }).success,
      ).toBe(false);

      // Archive workflow without archiveMetadata
      expect(
        recordLifecycleHandoffSchema.safeParse({
          ...validHandoffPayload(),
          action: "archive_workflow",
          archiveMetadata: undefined,
        }).success,
      ).toBe(false);
    });

    it("validates individual subschemas directly", () => {
      expect(
        dueDeleteRecordHandoffItemSchema.parse(validHandoffPayload().dueRecords[0]!),
      ).toBeDefined();
      expect(dueRecordHandoffItemSchema.parse(validHandoffPayload().dueRecords[0]!)).toBeDefined();
      expect(
        blockedRemovalRecordSchema.parse(validHandoffPayload().blockedRecords[0]!),
      ).toBeDefined();
      expect(lifecycleStatusReportSchema.parse(validHandoffPayload().statusReport)).toBeDefined();
      expect(recordTypeLifecyclePolicySchema.parse(createValidDeletePolicy())).toBeDefined();
      expect(
        dueArchiveRecordHandoffItemSchema.safeParse({
          ...validHandoffPayload().dueRecords[0]!,
          action: "archive_workflow",
        }).success,
      ).toBe(false); // missing archive fields
    });
  });
});
