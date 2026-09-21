import {
  activeConnectionEvidenceSchema,
  validateRecordTypeLifecyclePolicy,
  type ArchiveDestinationReference,
  type ConnectionInstanceId,
  type ApplicationRootId,
  type OrganizationId,
  type OrganizationLifecycleLimits,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import {
  assertDestinationFingerprint,
  assertSafeIntegerRevision,
  ConnectionInstanceStateError,
  projectActiveConnectionEvidence,
  type ConnectionInstanceState,
} from "../src/connection-instance-state";
import {
  readActiveConnectionEvidence,
  resolveConnectionInstanceReadiness,
  type ConnectionReadinessQuery,
} from "../src/connection-readiness";

vi.mock("server-only", () => ({}));

const uuid = (value: number) => `c0408000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const validFingerprint = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

const createValidConnectionState = (
  overrides?: Partial<ConnectionInstanceState>,
): ConnectionInstanceState => ({
  connectionInstanceId: uuid(1) as ConnectionInstanceId,
  organizationId: uuid(10) as OrganizationId,
  connectionTypeId: uuid(20),
  connectionTypeVersion: "1.0.0",
  destinationKey: "cold_archive_s3" as ArchiveDestinationReference,
  destinationFingerprint: validFingerprint,
  state: "active",
  lastHealthOutcome: "healthy",
  revision: 1,
  authorizedApplicationIds: [uuid(30) as ApplicationRootId],
  administratorActivityId: uuid(40),
  tokenExpiresAt: "2028-01-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

describe("Connection Instance State & Projection", () => {
  it("projects valid active healthy connection into canonical ActiveConnectionEvidence", () => {
    const state = createValidConnectionState();
    const evidence = projectActiveConnectionEvidence(state);

    expect(evidence).toEqual({
      connectionInstanceId: state.connectionInstanceId,
      destinationKey: state.destinationKey,
      destinationFingerprint: state.destinationFingerprint,
      organizationId: state.organizationId,
      authorizedApplicationIds: state.authorizedApplicationIds,
      state: "active",
      revision: state.revision,
      lastHealthOutcome: "healthy",
    });

    const parsed = activeConnectionEvidenceSchema.safeParse(evidence);
    expect(parsed.success).toBe(true);
  });

  it("integrates cleanly with contracts validateRecordTypeLifecyclePolicy", () => {
    const state = createValidConnectionState();
    const evidence = projectActiveConnectionEvidence(state);

    const limits: OrganizationLifecycleLimits = {
      organizationId: state.organizationId,
      settingsRevision: 1,
      maxRetentionDays: 365,
      maxRecordCount: 10000,
      allowUnlimitedRetentionDays: false,
      allowUnlimitedRecordCount: false,
      allowedActions: ["archive_workflow"],
      allowedArchiveDestinations: [state.destinationKey],
    };

    const policy = {
      policyId: uuid(90),
      policyRevision: 1,
      organizationId: state.organizationId,
      storageContractId: uuid(91),
      applicationRootId: uuid(30),
      maxAgeDays: 30,
      maxCount: 500,
      allowUnlimitedAge: false,
      allowUnlimitedCount: false,
      action: "archive_workflow" as const,
      archiveWorkflowId: uuid(92),
      expectedWorkflowRevision: 1,
      archiveConnectionInstanceId: state.connectionInstanceId,
      archiveDestination: state.destinationKey,
      expectedConnectionRevision: state.revision,
      expectedDestinationFingerprint: state.destinationFingerprint,
      expectedConnectionHealthOutcome: "healthy" as const,
    };

    const readinessEvidence = {
      organizationId: state.organizationId,
      registeredWorkflows: [
        {
          workflowId: uuid(92),
          workflowRevision: 1,
          organizationId: state.organizationId,
          authorizedApplicationIds: [uuid(30)],
          state: "active" as const,
        },
      ],
      activeConnections: [evidence],
    };

    const validation = validateRecordTypeLifecyclePolicy(policy, limits, readinessEvidence, 1);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  describe("Rejection of non-ready states and health", () => {
    it.each(["pending", "unhealthy", "revoked"] as const)(
      "rejects connection in non-active state: %s",
      (state) => {
        const conn = createValidConnectionState({ state });
        expect(() => projectActiveConnectionEvidence(conn)).toThrow(ConnectionInstanceStateError);
        expect(() => projectActiveConnectionEvidence(conn)).toThrow(/is in state/);
      },
    );

    it.each(["unhealthy", "unknown"] as const)(
      "rejects connection with non-healthy health outcome: %s",
      (lastHealthOutcome) => {
        const conn = createValidConnectionState({ lastHealthOutcome });
        expect(() => projectActiveConnectionEvidence(conn)).toThrow(ConnectionInstanceStateError);
        expect(() => projectActiveConnectionEvidence(conn)).toThrow(/health outcome is/);
      },
    );

    it("rejects connection with expired token", () => {
      const conn = createValidConnectionState({
        tokenExpiresAt: "2026-01-01T00:00:00.000Z",
      });
      expect(() =>
        projectActiveConnectionEvidence(conn, {
          referenceTime: "2026-09-21T00:00:00.000Z",
        }),
      ).toThrow(/token expired/);
    });

    it("accepts connection with future unexpired token", () => {
      const conn = createValidConnectionState({
        tokenExpiresAt: "2027-01-01T00:00:00.000Z",
      });
      const evidence = projectActiveConnectionEvidence(conn, {
        referenceTime: "2026-09-21T00:00:00.000Z",
      });
      expect(evidence.state).toBe("active");
    });
  });

  describe("Rejection of scope, destination, revision and fingerprint mismatches", () => {
    it("rejects connection with empty authorizedApplicationIds", () => {
      const conn = createValidConnectionState({
        authorizedApplicationIds: [],
      });
      expect(() => projectActiveConnectionEvidence(conn)).toThrow(
        /has no authorized application grants/,
      );
    });

    it("rejects connection when required application is not authorized", () => {
      const conn = createValidConnectionState({
        authorizedApplicationIds: [uuid(30) as ApplicationRootId],
      });
      expect(() =>
        projectActiveConnectionEvidence(conn, {
          requiredApplicationRootId: uuid(999) as ApplicationRootId,
        }),
      ).toThrow(/is not authorized for application root/);
    });

    it("rejects connection on destination mismatch", () => {
      const conn = createValidConnectionState({
        destinationKey: "cold_archive_s3" as ArchiveDestinationReference,
      });
      expect(() =>
        projectActiveConnectionEvidence(conn, {
          expectedDestinationKey: "glacier_vault",
        }),
      ).toThrow(/does not match expected/);
    });

    it("rejects connection on stale revision", () => {
      const conn = createValidConnectionState({ revision: 2 });
      expect(() =>
        projectActiveConnectionEvidence(conn, {
          expectedRevision: 5,
        }),
      ).toThrow(/revision 2 does not match expected 5/);
    });

    it("rejects connection on stale destination fingerprint", () => {
      const conn = createValidConnectionState();
      expect(() =>
        projectActiveConnectionEvidence(conn, {
          expectedFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
        }),
      ).toThrow(/destination fingerprint does not match/);
    });
  });

  describe("Validation of destination references and fingerprints", () => {
    it.each([
      "https://example.com/api",
      "postgres://localhost:5432/db",
      "SELECT * FROM users",
      "DROP TABLE orders",
      "Invalid_Uppercase",
      "space in key",
      "",
    ])("rejects credential-shaped, URL, SQL, or malformed destination: %s", (destinationKey) => {
      const conn = createValidConnectionState({
        destinationKey: destinationKey as ArchiveDestinationReference,
      });
      expect(() => projectActiveConnectionEvidence(conn)).toThrow();
    });

    it.each([
      "not-hex",
      "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90", // uppercase
      "12345", // too short
      validFingerprint + " extra",
    ])("rejects malformed destination fingerprint: %s", (fingerprint) => {
      expect(() => assertDestinationFingerprint(fingerprint)).toThrow(
        /Invalid destination fingerprint/,
      );
    });
  });

  describe("Safe integer revision assertion", () => {
    it("accepts safe integers as number, bigint, and string", () => {
      expect(assertSafeIntegerRevision(1, "test")).toBe(1);
      expect(assertSafeIntegerRevision(100, "test")).toBe(100);
      expect(assertSafeIntegerRevision(BigInt(42), "test")).toBe(42);
      expect(assertSafeIntegerRevision("42", "test")).toBe(42);
      expect(assertSafeIntegerRevision(Number.MAX_SAFE_INTEGER, "test")).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });

    it.each([0, -1, 1.5, NaN, Infinity, null, undefined, "abc", " 1 "])(
      "rejects invalid revision value: %s",
      (val) => {
        expect(() => assertSafeIntegerRevision(val, "test")).toThrow(
          /non-JSON-safe revision|revision is missing|precision loss/,
        );
      },
    );

    it("rejects precision loss outside MAX_SAFE_INTEGER", () => {
      const largeBigInt = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(10);
      expect(() => assertSafeIntegerRevision(largeBigInt, "test")).toThrow(
        /non-JSON-safe revision|precision loss/,
      );

      const largeString = (BigInt(Number.MAX_SAFE_INTEGER) + BigInt(10)).toString();
      expect(() => assertSafeIntegerRevision(largeString, "test")).toThrow(
        /non-JSON-safe revision|precision loss/,
      );
    });
  });
});

describe("Database Readiness Resolution & Active Evidence Reader", () => {
  it("resolves connection readiness successfully when DB returns outcome: ready", async () => {
    const mockTransaction: RequestDatabaseTransaction = {
      query: vi.fn().mockResolvedValue([
        {
          readiness_result: {
            outcome: "ready",
            connectionInstanceId: uuid(1),
            organizationId: uuid(10),
            applicationRootId: uuid(30),
            destinationKey: "cold_archive_s3",
            destinationFingerprint: validFingerprint,
            revision: 1,
            healthOutcome: "healthy",
            state: "active",
            verifiedAt: "2026-09-21T01:00:00.000Z",
          },
        },
      ]),
    };

    const query: ConnectionReadinessQuery = {
      connectionInstanceId: uuid(1) as ConnectionInstanceId,
      destinationKey: "cold_archive_s3" as ArchiveDestinationReference,
      applicationRootId: uuid(30) as ApplicationRootId,
      expectedRevision: 1,
      expectedFingerprint: validFingerprint,
    };

    const result = await resolveConnectionInstanceReadiness(
      mockTransaction,
      query,
      uuid(10) as OrganizationId,
    );

    expect(result.outcome).toBe("ready");
    if (result.outcome === "ready") {
      expect(result.connectionInstanceId).toBe(uuid(1));
      expect(result.destinationKey).toBe("cold_archive_s3");
      expect(result.healthOutcome).toBe("healthy");
      expect(result.state).toBe("active");
      expect(result.revision).toBe(1);
    }
  });

  it.each([
    ["connectionInstanceId", undefined],
    ["organizationId", undefined],
    ["applicationRootId", undefined],
    ["destinationKey", undefined],
    ["destinationFingerprint", undefined],
    ["revision", undefined],
    ["healthOutcome", "unhealthy"],
    ["state", "pending"],
    ["verifiedAt", "not-a-timestamp"],
  ] as const)("fails closed on malformed SQL ready-result field %s", async (field, value) => {
    const readinessResult: Record<string, unknown> = {
      outcome: "ready",
      connectionInstanceId: uuid(1),
      organizationId: uuid(10),
      applicationRootId: uuid(30),
      destinationKey: "cold_archive_s3",
      destinationFingerprint: validFingerprint,
      revision: 1,
      healthOutcome: "healthy",
      state: "active",
      verifiedAt: "2026-09-21T01:00:00.000Z",
      [field]: value,
    };
    const mockTransaction: RequestDatabaseTransaction = {
      query: vi.fn().mockResolvedValue([{ readiness_result: readinessResult }]),
    };
    const query: ConnectionReadinessQuery = {
      connectionInstanceId: uuid(1) as ConnectionInstanceId,
      destinationKey: "cold_archive_s3" as ArchiveDestinationReference,
      applicationRootId: uuid(30) as ApplicationRootId,
      expectedRevision: 1,
      expectedFingerprint: validFingerprint,
    };

    await expect(
      resolveConnectionInstanceReadiness(mockTransaction, query, uuid(10) as OrganizationId),
    ).resolves.toMatchObject({ outcome: "refused", reasonCode: "database_error" });
  });

  it.each([
    ["connectionInstanceId", uuid(2)],
    ["organizationId", uuid(11)],
    ["applicationRootId", uuid(31)],
    ["destinationKey", "other_vault"],
    ["destinationFingerprint", "0".repeat(64)],
    ["revision", 2],
  ] as const)(
    "fails closed when SQL ready-result field %s mismatches the request",
    async (field, value) => {
      const readinessResult: Record<string, unknown> = {
        outcome: "ready",
        connectionInstanceId: uuid(1),
        organizationId: uuid(10),
        applicationRootId: uuid(30),
        destinationKey: "cold_archive_s3",
        destinationFingerprint: validFingerprint,
        revision: 1,
        healthOutcome: "healthy",
        state: "active",
        verifiedAt: "2026-09-21T01:00:00.000Z",
        [field]: value,
      };
      const mockTransaction: RequestDatabaseTransaction = {
        query: vi.fn().mockResolvedValue([{ readiness_result: readinessResult }]),
      };
      const query: ConnectionReadinessQuery = {
        connectionInstanceId: uuid(1) as ConnectionInstanceId,
        destinationKey: "cold_archive_s3" as ArchiveDestinationReference,
        applicationRootId: uuid(30) as ApplicationRootId,
        expectedRevision: 1,
        expectedFingerprint: validFingerprint,
      };

      await expect(
        resolveConnectionInstanceReadiness(mockTransaction, query, uuid(10) as OrganizationId),
      ).resolves.toMatchObject({ outcome: "refused", reasonCode: "database_error" });
    },
  );

  it("handles refusal outcome from database resolution", async () => {
    const mockTransaction: RequestDatabaseTransaction = {
      query: vi.fn().mockResolvedValue([
        {
          readiness_result: {
            outcome: "refused",
            reasonCode: "connection_unhealthy",
            currentHealthOutcome: "unhealthy",
          },
        },
      ]),
    };

    const query: ConnectionReadinessQuery = {
      connectionInstanceId: uuid(1) as ConnectionInstanceId,
      destinationKey: "cold_archive_s3" as ArchiveDestinationReference,
      applicationRootId: uuid(30) as ApplicationRootId,
      expectedRevision: 1,
      expectedFingerprint: validFingerprint,
    };

    const result = await resolveConnectionInstanceReadiness(
      mockTransaction,
      query,
      uuid(10) as OrganizationId,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("connection_unhealthy");
      expect(result.currentHealthOutcome).toBe("unhealthy");
    }
  });

  it("handles stale_revision outcome from database resolution", async () => {
    const mockTransaction: RequestDatabaseTransaction = {
      query: vi.fn().mockResolvedValue([
        {
          readiness_result: {
            outcome: "refused",
            reasonCode: "stale_revision",
            currentRevision: 5,
          },
        },
      ]),
    };

    const query: ConnectionReadinessQuery = {
      connectionInstanceId: uuid(1) as ConnectionInstanceId,
      destinationKey: "cold_archive_s3" as ArchiveDestinationReference,
      applicationRootId: uuid(30) as ApplicationRootId,
      expectedRevision: 1,
      expectedFingerprint: validFingerprint,
    };

    const result = await resolveConnectionInstanceReadiness(
      mockTransaction,
      query,
      uuid(10) as OrganizationId,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("stale_revision");
      expect(result.currentRevision).toBe(5);
    }
  });

  it("handles stale_fingerprint outcome from database resolution", async () => {
    const mockTransaction: RequestDatabaseTransaction = {
      query: vi.fn().mockResolvedValue([
        {
          readiness_result: {
            outcome: "refused",
            reasonCode: "stale_fingerprint",
          },
        },
      ]),
    };

    const query: ConnectionReadinessQuery = {
      connectionInstanceId: uuid(1) as ConnectionInstanceId,
      destinationKey: "cold_archive_s3" as ArchiveDestinationReference,
      applicationRootId: uuid(30) as ApplicationRootId,
      expectedRevision: 1,
      expectedFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    const result = await resolveConnectionInstanceReadiness(
      mockTransaction,
      query,
      uuid(10) as OrganizationId,
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reasonCode).toBe("stale_fingerprint");
    }
  });

  it("rejects non-safe integer or missing revision in query before executing SQL", async () => {
    const mockTransaction: RequestDatabaseTransaction = {
      query: vi.fn(),
    };

    const query = {
      connectionInstanceId: uuid(1) as ConnectionInstanceId,
      destinationKey: "cold_archive_s3" as ArchiveDestinationReference,
      applicationRootId: uuid(30) as ApplicationRootId,
      expectedRevision: 0,
      expectedFingerprint: validFingerprint,
    } as unknown as ConnectionReadinessQuery;

    await expect(
      resolveConnectionInstanceReadiness(mockTransaction, query, uuid(10) as OrganizationId),
    ).rejects.toThrow(ConnectionInstanceStateError);
    expect(mockTransaction.query).not.toHaveBeenCalled();
  });

  it("rejects invalid or missing destination fingerprint in query before executing SQL", async () => {
    const mockTransaction: RequestDatabaseTransaction = {
      query: vi.fn(),
    };

    const query = {
      connectionInstanceId: uuid(1) as ConnectionInstanceId,
      destinationKey: "cold_archive_s3" as ArchiveDestinationReference,
      applicationRootId: uuid(30) as ApplicationRootId,
      expectedRevision: 1,
      expectedFingerprint: "invalid-fp",
    } as unknown as ConnectionReadinessQuery;

    await expect(
      resolveConnectionInstanceReadiness(mockTransaction, query, uuid(10) as OrganizationId),
    ).rejects.toThrow(ConnectionInstanceStateError);
    expect(mockTransaction.query).not.toHaveBeenCalled();
  });

  it("reads active connection evidence from database retaining revision and fingerprint proof", async () => {
    const mockTransaction: RequestDatabaseTransaction = {
      query: vi.fn().mockResolvedValue([
        {
          connection_instance_id: uuid(1),
          destination_key: "cold_archive_s3",
          destination_fingerprint: validFingerprint,
          organization_id: uuid(10),
          authorized_application_ids: [uuid(30), uuid(31)],
          state: "active",
          revision: 3,
          last_health_outcome: "healthy",
        },
      ]),
    };

    const evidence = await readActiveConnectionEvidence(
      mockTransaction,
      uuid(1) as ConnectionInstanceId,
    );

    expect(evidence).toEqual({
      connectionInstanceId: uuid(1),
      destinationKey: "cold_archive_s3",
      destinationFingerprint: validFingerprint,
      organizationId: uuid(10),
      authorizedApplicationIds: [uuid(30), uuid(31)],
      state: "active",
      revision: 3,
      lastHealthOutcome: "healthy",
    });
  });

  it("fails closed when active connection evidence is unavailable or unhealthy in DB", async () => {
    const mockTransactionEmpty: RequestDatabaseTransaction = {
      query: vi.fn().mockResolvedValue([]),
    };

    await expect(
      readActiveConnectionEvidence(mockTransactionEmpty, uuid(1) as ConnectionInstanceId),
    ).rejects.toThrow(/is unavailable/);

    const mockTransactionUnhealthy: RequestDatabaseTransaction = {
      query: vi.fn().mockResolvedValue([
        {
          connection_instance_id: uuid(1),
          destination_key: "cold_archive_s3",
          destination_fingerprint: validFingerprint,
          organization_id: uuid(10),
          authorized_application_ids: [uuid(30)],
          state: "active",
          revision: 1,
          last_health_outcome: "unhealthy",
        },
      ]),
    };

    await expect(
      readActiveConnectionEvidence(mockTransactionUnhealthy, uuid(1) as ConnectionInstanceId),
    ).rejects.toThrow(/has health outcome "unhealthy"/);
  });
});
