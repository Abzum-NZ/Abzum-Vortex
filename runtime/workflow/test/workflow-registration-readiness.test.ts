import { describe, expect, it, vi } from "vitest";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  workflowRegistrationStateSchema,
  workflowRegistrationReadinessResultSchema,
  type ApplicationRootId,
  type OrganizationId,
  type RegisteredWorkflowEvidence,
  type WorkflowId,
} from "@vortex/contracts";
import {
  checkWorkflowRegistrationReadiness,
  evaluateWorkflowRegistrationReadinessLocally,
  readRegisteredWorkflowEvidence,
  type WorkflowRegistrationReadinessInput,
} from "../src/workflow-registration-readiness";

const WORKFLOW_ID_ONE = "11111111-1111-4111-8111-111111111111" as WorkflowId;
const WORKFLOW_ID_TWO = "22222222-2222-4222-8222-222222222222" as WorkflowId;
const ORG_ID_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as OrganizationId;
const ORG_ID_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as OrganizationId;
const APP_ROOT_ID_ONE = "33333333-3333-4333-8333-333333333333" as ApplicationRootId;
const APP_ROOT_ID_TWO = "44444444-4444-4444-8444-444444444444" as ApplicationRootId;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const FINGERPRINT_A = "sha256:" + "a".repeat(64);
const FINGERPRINT_B = "sha256:" + "b".repeat(64);

const createMockTransaction = (rows: readonly DatabaseRow[]): RequestDatabaseTransaction => ({
  query: vi.fn().mockResolvedValue(rows),
});

describe("workflowRegistrationStateSchema", () => {
  it("accepts canonical lifecycle states", () => {
    const validStates = [
      "registered",
      "prepared",
      "verified",
      "active",
      "inactive",
      "superseded",
    ];
    for (const s of validStates) {
      expect(workflowRegistrationStateSchema.parse(s)).toBe(s);
    }
  });

  it("rejects unknown or malformed states", () => {
    expect(workflowRegistrationStateSchema.safeParse("unknown").success).toBe(false);
    expect(workflowRegistrationStateSchema.safeParse("draft").success).toBe(false);
    expect(workflowRegistrationStateSchema.safeParse("deleted").success).toBe(false);
    expect(workflowRegistrationStateSchema.safeParse("").success).toBe(false);
  });
});

describe("workflowRegistrationReadinessResultSchema", () => {
  it("parses ready outcome shape", () => {
    const readyResult = {
      outcome: "ready",
      workflowId: WORKFLOW_ID_ONE,
      workflowRevision: 2,
      organizationId: ORG_ID_ONE,
      applicationRootId: APP_ROOT_ID_ONE,
      state: "active",
      definitionFingerprint: FINGERPRINT_A,
      verifiedFlowFingerprint: FINGERPRINT_A,
      supportedDestinations: ["cold_archive_s3", "compliance-vault-1"],
    };

    const parsed = workflowRegistrationReadinessResultSchema.parse(readyResult);
    expect(parsed.outcome).toBe("ready");
    if (parsed.outcome === "ready") {
      expect(parsed.state).toBe("active");
      expect(parsed.supportedDestinations).toContain("cold_archive_s3");
    }
  });

  it("parses refused outcome shape with reasonCode", () => {
    const refusedResult = {
      outcome: "refused",
      reasonCode: "archive_workflow_not_registered",
      reasonMessage: "Active workflow is not registered",
    };

    const parsed = workflowRegistrationReadinessResultSchema.parse(refusedResult);
    expect(parsed.outcome).toBe("refused");
    if (parsed.outcome === "refused") {
      expect(parsed.reasonCode).toBe("archive_workflow_not_registered");
    }
  });
});

describe("checkWorkflowRegistrationReadiness", () => {
  const validInput: WorkflowRegistrationReadinessInput = {
    workflowId: WORKFLOW_ID_ONE,
    expectedRevision: 3,
    organizationId: ORG_ID_ONE,
    applicationRootId: APP_ROOT_ID_ONE,
    archiveDestination: "cold_archive_s3",
    expectedFingerprint: FINGERPRINT_A,
  };

  it("returns ready when database reports workflow is ready", async () => {
    const readyPayload = {
      outcome: "ready",
      workflowId: WORKFLOW_ID_ONE,
      workflowRevision: 3,
      organizationId: ORG_ID_ONE,
      applicationRootId: APP_ROOT_ID_ONE,
      state: "active",
      definitionFingerprint: FINGERPRINT_A,
      verifiedFlowFingerprint: FINGERPRINT_A,
      supportedDestinations: ["cold_archive_s3"],
    };

    const tx = createMockTransaction([{ result: readyPayload }]);
    const result = await checkWorkflowRegistrationReadiness(tx, validInput);

    expect(result.outcome).toBe("ready");
    if (result.outcome === "ready") {
      expect(result.workflowId).toBe(WORKFLOW_ID_ONE);
      expect(result.workflowRevision).toBe(3);
      expect(result.state).toBe("active");
      expect(result.supportedDestinations).toEqual(["cold_archive_s3"]);
    }
  });

  it("returns refused when database reports workflow is not registered", async () => {
    const refusedPayload = {
      outcome: "refused",
      reasonCode: "archive_workflow_not_registered",
      reasonMessage: "Workflow is not registered in runtime workflows",
    };

    const tx = createMockTransaction([{ result: refusedPayload }]);
    const result = await checkWorkflowRegistrationReadiness(tx, validInput);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("archive_workflow_not_registered");
    }
  });

  it("returns refused on scope mismatch", async () => {
    const refusedPayload = {
      outcome: "refused",
      reasonCode: "archive_workflow_scope_mismatch",
      reasonMessage: "Registered workflow is not authorized for permanent application root",
    };

    const tx = createMockTransaction([{ result: refusedPayload }]);
    const result = await checkWorkflowRegistrationReadiness(tx, validInput);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("archive_workflow_scope_mismatch");
    }
  });

  it("returns refused on pending, inactive, or superseded states", async () => {
    for (const code of [
      "workflow_state_pending",
      "workflow_state_inactive",
      "workflow_state_superseded",
    ] as const) {
      const tx = createMockTransaction([
        {
          result: {
            outcome: "refused",
            reasonCode: code,
            reasonMessage: `Workflow is in ${code} state`,
          },
        },
      ]);
      const result = await checkWorkflowRegistrationReadiness(tx, validInput);
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.reasonCode).toBe(code);
      }
    }
  });

  it("returns refused on destination mismatch", async () => {
    const tx = createMockTransaction([
      {
        result: {
          outcome: "refused",
          reasonCode: "destination_mismatch",
          reasonMessage: "Workflow does not support requested archive destination",
        },
      },
    ]);
    const result = await checkWorkflowRegistrationReadiness(tx, {
      ...validInput,
      archiveDestination: "unsupported_vault",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("destination_mismatch");
    }
  });

  it("rejects nil UUID input parameter", async () => {
    const tx = createMockTransaction([]);
    await expect(
      checkWorkflowRegistrationReadiness(tx, {
        ...validInput,
        workflowId: NIL_UUID as WorkflowId,
      }),
    ).rejects.toThrow();
  });

  it("rejects non-positive revision", async () => {
    const tx = createMockTransaction([]);
    await expect(
      checkWorkflowRegistrationReadiness(tx, {
        ...validInput,
        expectedRevision: 0 as never,
      }),
    ).rejects.toThrow();
  });

  it("fails closed on empty database return", async () => {
    const tx = createMockTransaction([]);
    await expect(checkWorkflowRegistrationReadiness(tx, validInput)).rejects.toThrow(
      /empty result/,
    );
  });
});

describe("readRegisteredWorkflowEvidence", () => {
  it("returns parsed and validated RegisteredWorkflowEvidence items", async () => {
    const mockRows = [
      {
        workflow_id: WORKFLOW_ID_ONE,
        workflow_revision: 2,
        organization_id: ORG_ID_ONE,
        authorized_application_ids: [APP_ROOT_ID_ONE],
        state: "active",
        definition_fingerprint: FINGERPRINT_A,
        verified_flow_fingerprint: FINGERPRINT_A,
        supported_destinations: ["cold_archive_s3"],
      },
      {
        workflow_id: WORKFLOW_ID_TWO,
        workflow_revision: 5,
        organization_id: ORG_ID_ONE,
        authorized_application_ids: [APP_ROOT_ID_ONE, APP_ROOT_ID_TWO],
        state: "active",
        definition_fingerprint: FINGERPRINT_B,
        verified_flow_fingerprint: FINGERPRINT_B,
        supported_destinations: ["cold_archive_s3", "compliance-vault-1"],
      },
    ];

    const tx = createMockTransaction(mockRows);
    const result = await readRegisteredWorkflowEvidence(tx, { organizationId: ORG_ID_ONE });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      workflowId: WORKFLOW_ID_ONE,
      workflowRevision: 2,
      organizationId: ORG_ID_ONE,
      authorizedApplicationIds: [APP_ROOT_ID_ONE],
      state: "active",
    });
    expect(result[1]).toEqual({
      workflowId: WORKFLOW_ID_TWO,
      workflowRevision: 5,
      organizationId: ORG_ID_ONE,
      authorizedApplicationIds: [APP_ROOT_ID_ONE, APP_ROOT_ID_TWO],
      state: "active",
    });
  });

  it("fails closed on duplicate active workflow IDs", async () => {
    const mockRows = [
      {
        workflow_id: WORKFLOW_ID_ONE,
        workflow_revision: 1,
        organization_id: ORG_ID_ONE,
        authorized_application_ids: [APP_ROOT_ID_ONE],
        state: "active",
        definition_fingerprint: FINGERPRINT_A,
        verified_flow_fingerprint: FINGERPRINT_A,
        supported_destinations: ["cold_archive_s3"],
      },
      {
        workflow_id: WORKFLOW_ID_ONE,
        workflow_revision: 2,
        organization_id: ORG_ID_ONE,
        authorized_application_ids: [APP_ROOT_ID_ONE],
        state: "active",
        definition_fingerprint: FINGERPRINT_A,
        verified_flow_fingerprint: FINGERPRINT_A,
        supported_destinations: ["cold_archive_s3"],
      },
    ];

    const tx = createMockTransaction(mockRows);
    await expect(
      readRegisteredWorkflowEvidence(tx, { organizationId: ORG_ID_ONE }),
    ).rejects.toThrow(/duplicate active workflow identity/);
  });

  it("fails closed on organization mismatch in row", async () => {
    const mockRows = [
      {
        workflow_id: WORKFLOW_ID_ONE,
        workflow_revision: 1,
        organization_id: ORG_ID_TWO,
        authorized_application_ids: [APP_ROOT_ID_ONE],
        state: "active",
        definition_fingerprint: FINGERPRINT_A,
        verified_flow_fingerprint: FINGERPRINT_A,
        supported_destinations: ["cold_archive_s3"],
      },
    ];

    const tx = createMockTransaction(mockRows);
    await expect(
      readRegisteredWorkflowEvidence(tx, { organizationId: ORG_ID_ONE }),
    ).rejects.toThrow(/organization mismatch/);
  });
});

describe("evaluateWorkflowRegistrationReadinessLocally", () => {
  const activeEvidence: RegisteredWorkflowEvidence[] = [
    {
      workflowId: WORKFLOW_ID_ONE,
      workflowRevision: 3,
      organizationId: ORG_ID_ONE,
      authorizedApplicationIds: [APP_ROOT_ID_ONE],
      state: "active",
    },
  ];

  const defaultCheck: WorkflowRegistrationReadinessInput = {
    workflowId: WORKFLOW_ID_ONE,
    expectedRevision: 3,
    organizationId: ORG_ID_ONE,
    applicationRootId: APP_ROOT_ID_ONE,
    archiveDestination: "cold_archive_s3",
    expectedFingerprint: FINGERPRINT_A,
  };

  const defaultMeta = {
    supportedDestinations: ["cold_archive_s3"],
    verifiedFlowFingerprint: FINGERPRINT_A,
  };

  it("returns ready when evidence matches completely", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      defaultCheck,
      activeEvidence,
      defaultMeta,
    );

    expect(result.outcome).toBe("ready");
    if (result.outcome === "ready") {
      expect(result.workflowId).toBe(WORKFLOW_ID_ONE);
      expect(result.workflowRevision).toBe(3);
      expect(result.state).toBe("active");
    }
  });

  it("refuses when workflow is not registered in evidence", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, workflowId: WORKFLOW_ID_TWO },
      activeEvidence,
      defaultMeta,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("archive_workflow_not_registered");
    }
  });

  it("refuses on organization mismatch", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, organizationId: ORG_ID_TWO },
      activeEvidence,
      defaultMeta,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("wrong_organization");
    }
  });

  it("refuses when application root is null (organisation-shared policy)", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, applicationRootId: null },
      activeEvidence,
      defaultMeta,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("archive_workflow_scope_mismatch");
    }
  });

  it("refuses when application is not authorized for workflow", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, applicationRootId: APP_ROOT_ID_TWO },
      activeEvidence,
      defaultMeta,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("archive_workflow_scope_mismatch");
    }
  });

  it("refuses on stale revision", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, expectedRevision: 2 },
      activeEvidence,
      defaultMeta,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("stale_revision");
    }
  });

  it("refuses on stale fingerprint", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, expectedFingerprint: FINGERPRINT_B },
      activeEvidence,
      defaultMeta,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("stale_fingerprint");
    }
  });

  it("refuses on destination mismatch", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, archiveDestination: "unsupported_storage" },
      activeEvidence,
      defaultMeta,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("destination_mismatch");
    }
  });
});
