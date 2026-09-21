import { describe, expect, it, vi } from "vitest";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  workflowRegistrationStateSchema,
  workflowRegistrationReadinessResultSchema,
  registeredWorkflowReadinessEvidenceSchema,
  type ApplicationRootId,
  type ArchiveDestinationReference,
  type Fingerprint,
  type OrganizationId,
  type RegisteredWorkflowReadinessEvidence,
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

const FINGERPRINT_A = ("sha256:" + "a".repeat(64)) as Fingerprint;
const FINGERPRINT_B = ("sha256:" + "b".repeat(64)) as Fingerprint;
const FINGERPRINT_FLOW = ("sha256:" + "c".repeat(64)) as Fingerprint;

const DESTINATION_A = "cold_archive_s3" as ArchiveDestinationReference;
const DESTINATION_B = "compliance-vault-1" as ArchiveDestinationReference;

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
  it("parses ready outcome shape with non-optional evidence fields", () => {
    const readyResult = {
      outcome: "ready",
      workflowId: WORKFLOW_ID_ONE,
      workflowRevision: 2,
      organizationId: ORG_ID_ONE,
      applicationRootId: APP_ROOT_ID_ONE,
      state: "active",
      definitionFingerprint: FINGERPRINT_A,
      verifiedFlowFingerprint: FINGERPRINT_FLOW,
      supportedDestinations: [DESTINATION_A, DESTINATION_B],
    };

    const parsed = workflowRegistrationReadinessResultSchema.parse(readyResult);
    expect(parsed.outcome).toBe("ready");
    if (parsed.outcome === "ready") {
      expect(parsed.state).toBe("active");
      expect(parsed.definitionFingerprint).toBe(FINGERPRINT_A);
      expect(parsed.verifiedFlowFingerprint).toBe(FINGERPRINT_FLOW);
      expect(parsed.supportedDestinations).toEqual([DESTINATION_A, DESTINATION_B]);
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

  it("rejects non-closed destination in result schema", () => {
    const invalidResult = {
      outcome: "ready",
      workflowId: WORKFLOW_ID_ONE,
      workflowRevision: 2,
      organizationId: ORG_ID_ONE,
      applicationRootId: APP_ROOT_ID_ONE,
      state: "active",
      definitionFingerprint: FINGERPRINT_A,
      verifiedFlowFingerprint: FINGERPRINT_FLOW,
      supportedDestinations: ["https://example.com/s3", "INVALID_UPPERCASE"],
    };

    expect(workflowRegistrationReadinessResultSchema.safeParse(invalidResult).success).toBe(false);
  });
});

describe("registeredWorkflowReadinessEvidenceSchema", () => {
  it("parses valid non-optional registered workflow readiness evidence", () => {
    const evidence = {
      workflowId: WORKFLOW_ID_ONE,
      workflowRevision: 3,
      organizationId: ORG_ID_ONE,
      authorizedApplicationIds: [APP_ROOT_ID_ONE],
      state: "active",
      definitionFingerprint: FINGERPRINT_A,
      verifiedFlowFingerprint: FINGERPRINT_FLOW,
      supportedDestinations: [DESTINATION_A],
    };

    const parsed = registeredWorkflowReadinessEvidenceSchema.parse(evidence);
    expect(parsed.workflowId).toBe(WORKFLOW_ID_ONE);
    expect(parsed.definitionFingerprint).toBe(FINGERPRINT_A);
    expect(parsed.verifiedFlowFingerprint).toBe(FINGERPRINT_FLOW);
    expect(parsed.supportedDestinations).toEqual([DESTINATION_A]);
  });

  it("rejects evidence missing definition or verified flow fingerprints", () => {
    const missingFp = {
      workflowId: WORKFLOW_ID_ONE,
      workflowRevision: 3,
      organizationId: ORG_ID_ONE,
      authorizedApplicationIds: [APP_ROOT_ID_ONE],
      state: "active",
      supportedDestinations: [DESTINATION_A],
    };
    expect(registeredWorkflowReadinessEvidenceSchema.safeParse(missingFp).success).toBe(false);
  });

  it("rejects evidence with non-canonical destination string", () => {
    const badDest = {
      workflowId: WORKFLOW_ID_ONE,
      workflowRevision: 3,
      organizationId: ORG_ID_ONE,
      authorizedApplicationIds: [APP_ROOT_ID_ONE],
      state: "active",
      definitionFingerprint: FINGERPRINT_A,
      verifiedFlowFingerprint: FINGERPRINT_FLOW,
      supportedDestinations: ["s3://my-bucket/archive"],
    };
    expect(registeredWorkflowReadinessEvidenceSchema.safeParse(badDest).success).toBe(false);
  });
});

describe("checkWorkflowRegistrationReadiness", () => {
  const validInput: WorkflowRegistrationReadinessInput = {
    workflowId: WORKFLOW_ID_ONE,
    expectedRevision: 3,
    organizationId: ORG_ID_ONE,
    applicationRootId: APP_ROOT_ID_ONE,
    archiveDestination: DESTINATION_A,
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
      verifiedFlowFingerprint: FINGERPRINT_FLOW,
      supportedDestinations: [DESTINATION_A],
    };

    const tx = createMockTransaction([{ result: readyPayload }]);
    const result = await checkWorkflowRegistrationReadiness(tx, validInput);

    expect(result.outcome).toBe("ready");
    if (result.outcome === "ready") {
      expect(result.workflowId).toBe(WORKFLOW_ID_ONE);
      expect(result.workflowRevision).toBe(3);
      expect(result.state).toBe("active");
      expect(result.definitionFingerprint).toBe(FINGERPRINT_A);
      expect(result.verifiedFlowFingerprint).toBe(FINGERPRINT_FLOW);
      expect(result.supportedDestinations).toEqual([DESTINATION_A]);
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
      archiveDestination: "unsupported-destination",
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
  it("returns complete RegisteredWorkflowReadinessEvidence items with non-optional proofs", async () => {
    const mockRows = [
      {
        workflow_id: WORKFLOW_ID_ONE,
        workflow_revision: 2,
        organization_id: ORG_ID_ONE,
        authorized_application_ids: [APP_ROOT_ID_ONE],
        state: "active",
        definition_fingerprint: FINGERPRINT_A,
        verified_flow_fingerprint: FINGERPRINT_FLOW,
        supported_destinations: [DESTINATION_A],
      },
      {
        workflow_id: WORKFLOW_ID_TWO,
        workflow_revision: 5,
        organization_id: ORG_ID_ONE,
        authorized_application_ids: [APP_ROOT_ID_ONE, APP_ROOT_ID_TWO],
        state: "active",
        definition_fingerprint: FINGERPRINT_B,
        verified_flow_fingerprint: FINGERPRINT_B,
        supported_destinations: [DESTINATION_A, DESTINATION_B],
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
      definitionFingerprint: FINGERPRINT_A,
      verifiedFlowFingerprint: FINGERPRINT_FLOW,
      supportedDestinations: [DESTINATION_A],
    });
    expect(result[1]).toEqual({
      workflowId: WORKFLOW_ID_TWO,
      workflowRevision: 5,
      organizationId: ORG_ID_ONE,
      authorizedApplicationIds: [APP_ROOT_ID_ONE, APP_ROOT_ID_TWO],
      state: "active",
      definitionFingerprint: FINGERPRINT_B,
      verifiedFlowFingerprint: FINGERPRINT_B,
      supportedDestinations: [DESTINATION_A, DESTINATION_B],
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
        verified_flow_fingerprint: FINGERPRINT_FLOW,
        supported_destinations: [DESTINATION_A],
      },
      {
        workflow_id: WORKFLOW_ID_ONE,
        workflow_revision: 2,
        organization_id: ORG_ID_ONE,
        authorized_application_ids: [APP_ROOT_ID_ONE],
        state: "active",
        definition_fingerprint: FINGERPRINT_A,
        verified_flow_fingerprint: FINGERPRINT_FLOW,
        supported_destinations: [DESTINATION_A],
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
        verified_flow_fingerprint: FINGERPRINT_FLOW,
        supported_destinations: [DESTINATION_A],
      },
    ];

    const tx = createMockTransaction(mockRows);
    await expect(
      readRegisteredWorkflowEvidence(tx, { organizationId: ORG_ID_ONE }),
    ).rejects.toThrow(/organization mismatch/);
  });

  it("fails closed on non-active state in row", async () => {
    const mockRows = [
      {
        workflow_id: WORKFLOW_ID_ONE,
        workflow_revision: 1,
        organization_id: ORG_ID_ONE,
        authorized_application_ids: [APP_ROOT_ID_ONE],
        state: "prepared",
        definition_fingerprint: FINGERPRINT_A,
        verified_flow_fingerprint: FINGERPRINT_FLOW,
        supported_destinations: [DESTINATION_A],
      },
    ];

    const tx = createMockTransaction(mockRows);
    await expect(
      readRegisteredWorkflowEvidence(tx, { organizationId: ORG_ID_ONE }),
    ).rejects.toThrow(/non-active workflow/);
  });
});

describe("evaluateWorkflowRegistrationReadinessLocally", () => {
  const completeActiveEvidence: readonly RegisteredWorkflowReadinessEvidence[] = [
    {
      workflowId: WORKFLOW_ID_ONE,
      workflowRevision: 3,
      organizationId: ORG_ID_ONE,
      authorizedApplicationIds: [APP_ROOT_ID_ONE],
      state: "active",
      definitionFingerprint: FINGERPRINT_A,
      verifiedFlowFingerprint: FINGERPRINT_FLOW,
      supportedDestinations: [DESTINATION_A, DESTINATION_B],
    },
  ];

  const defaultCheck: WorkflowRegistrationReadinessInput = {
    workflowId: WORKFLOW_ID_ONE,
    expectedRevision: 3,
    organizationId: ORG_ID_ONE,
    applicationRootId: APP_ROOT_ID_ONE,
    archiveDestination: DESTINATION_A,
    expectedFingerprint: FINGERPRINT_A,
  };

  it("returns ready when evidence matches completely against definition fingerprint", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      defaultCheck,
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("ready");
    if (result.outcome === "ready") {
      expect(result.workflowId).toBe(WORKFLOW_ID_ONE);
      expect(result.workflowRevision).toBe(3);
      expect(result.state).toBe("active");
      expect(result.definitionFingerprint).toBe(FINGERPRINT_A);
      expect(result.verifiedFlowFingerprint).toBe(FINGERPRINT_FLOW);
      expect(result.supportedDestinations).toEqual([DESTINATION_A, DESTINATION_B]);
    }
  });

  it("returns ready when expected fingerprint matches verified flow fingerprint (SQL parity)", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, expectedFingerprint: FINGERPRINT_FLOW },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("ready");
    if (result.outcome === "ready") {
      expect(result.definitionFingerprint).toBe(FINGERPRINT_A);
      expect(result.verifiedFlowFingerprint).toBe(FINGERPRINT_FLOW);
    }
  });

  it("refuses when workflow is not registered in evidence", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, workflowId: WORKFLOW_ID_TWO },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("archive_workflow_not_registered");
      expect(result.reasonMessage).toBe("Workflow is not registered in runtime workflows");
    }
  });

  it("refuses on organization mismatch", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, organizationId: ORG_ID_TWO },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("wrong_organization");
      expect(result.reasonMessage).toBe("Workflow belongs to a different organization");
    }
  });

  it("refuses when application root is null (organisation-shared policy)", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, applicationRootId: null },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("archive_workflow_scope_mismatch");
      expect(result.reasonMessage).toBe(
        "Organisation-shared policy cannot activate archive_workflow because registered workflows require permanent application scope",
      );
    }
  });

  it("refuses when application is not authorized for workflow", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, applicationRootId: APP_ROOT_ID_TWO },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("archive_workflow_scope_mismatch");
      expect(result.reasonMessage).toBe(
        "Registered workflow is not authorized for permanent application root",
      );
    }
  });

  it("refuses on stale revision", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, expectedRevision: 2 },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("stale_revision");
      expect(result.reasonMessage).toBe("Expected workflow revision does not exist");
    }
  });

  it("refuses on stale fingerprint when expected matches neither definition nor verified-flow", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, expectedFingerprint: FINGERPRINT_B },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("stale_fingerprint");
      expect(result.reasonMessage).toBe(
        "Expected fingerprint does not match workflow definition or verified flow fingerprint",
      );
    }
  });

  it("refuses on destination mismatch", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, archiveDestination: "unsupported-destination" },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("destination_mismatch");
      expect(result.reasonMessage).toBe(
        "Workflow revision does not support the requested archive destination",
      );
    }
  });

  it("refuses on invalid destination reference format", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, archiveDestination: "INVALID_UPPERCASE" },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("invalid_archive_destination");
    }
  });

  it("refuses on invalid fingerprint format", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, expectedFingerprint: "not-a-sha256-fingerprint" },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("stale_fingerprint");
    }
  });

  it("refuses on nil workflow ID", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, workflowId: NIL_UUID as WorkflowId },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("invalid_workflow_identity");
    }
  });

  it("refuses on nil organization ID", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, organizationId: NIL_UUID as OrganizationId },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("invalid_organization_identity");
    }
  });

  it("refuses on nil application root ID", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, applicationRootId: NIL_UUID as ApplicationRootId },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("invalid_application_identity");
    }
  });

  it("refuses on non-positive revision", () => {
    const result = evaluateWorkflowRegistrationReadinessLocally(
      { ...defaultCheck, expectedRevision: 0 as never },
      completeActiveEvidence,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("invalid_workflow_revision");
    }
  });
});
