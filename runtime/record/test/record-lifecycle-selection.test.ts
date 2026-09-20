import { describe, expect, it, vi } from "vitest";
import type { RequestDatabaseTransaction, DatabaseRow } from "@vortex/db";
import {
  selectDueRecordsForLifecycleHandoff,
  type RecordTypeLifecyclePolicy,
} from "@vortex/contracts";
import {
  readLifecycleCandidateRecords,
  type RawLifecycleCandidateRecord,
} from "../src/record-lifecycle-selection";

// Stable UUID fixtures.
const STORAGE_CONTRACT_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" as never;
const RECORD_ID_ONE = "11111111-1111-4111-8111-111111111111";
const RECORD_ID_TWO = "22222222-2222-4222-8222-222222222222";
const RECORD_ID_THREE = "33333333-3333-4333-8333-333333333333";
const NIL_UUID = "00000000-0000-0000-0000-000000000000" as never;

const createMockTransaction = (
  rows: readonly DatabaseRow[],
): RequestDatabaseTransaction => ({
  query: vi.fn().mockResolvedValue(rows),
});

const samplePolicy: RecordTypeLifecyclePolicy = {
  policyId: "c1111111-1111-4111-8111-111111111111" as never,
  policyRevision: 1,
  organizationId: "c2222222-2222-4222-8222-222222222222" as never,
  storageContractId: STORAGE_CONTRACT_ID,
  applicationRootId: null,
  action: "delete",
  maxAgeDays: 30,
  allowUnlimitedAge: false,
  maxCount: 100,
  allowUnlimitedCount: false,
  recoveryPeriodDays: 14,
};

describe("readLifecycleCandidateRecords", () => {
  it("returns structurally raw candidate records without isHeld or isProtected defaults", async () => {
    const now = new Date("2026-09-10T12:00:00.000Z");
    const earlier = new Date("2026-09-01T08:30:00.000Z");
    const mockRows = [
      { record_id: RECORD_ID_ONE, created_at: earlier, record_revision: 3 },
      { record_id: RECORD_ID_TWO, created_at: now, record_revision: 1 },
    ];
    const transaction = createMockTransaction(mockRows);

    const result = await readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      recordId: RECORD_ID_ONE,
      expectedRecordRevision: 3,
      createdAt: earlier.toISOString(),
    });
    expect(result[1]).toEqual({
      recordId: RECORD_ID_TWO,
      expectedRecordRevision: 1,
      createdAt: now.toISOString(),
    });

    // Verify protection booleans are not present on raw facts.
    expect("isHeld" in result[0]!).toBe(false);
    expect("isProtected" in result[0]!).toBe(false);
    expect("isHeld" in result[1]!).toBe(false);
    expect("isProtected" in result[1]!).toBe(false);

    expect(transaction.query).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array when no rows match", async () => {
    const transaction = createMockTransaction([]);
    const result = await readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID);
    expect(result).toHaveLength(0);
  });

  it("rejects a nil UUID storage contract identity", async () => {
    const transaction = createMockTransaction([]);
    await expect(readLifecycleCandidateRecords(transaction, NIL_UUID)).rejects.toThrow();
  });

  it("fails closed on duplicate record IDs in result", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: 1,
      },
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-02T00:00:00Z"),
        record_revision: 2,
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/duplicate record identity/i);
  });

  it("fails closed on non-JSON-safe revision (zero)", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: 0,
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/non-json-safe record revision/i);
  });

  it("fails closed on non-JSON-safe revision (negative number)", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: -1,
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/non-json-safe record revision/i);
  });

  it("fails closed on non-JSON-safe revision (negative bigint)", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: -1n,
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/non-json-safe record revision/i);
  });

  it("fails closed on non-JSON-safe revision (exceeds MAX_SAFE_INTEGER number)", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: Number.MAX_SAFE_INTEGER + 1,
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/non-json-safe record revision/i);
  });

  it("fails closed on non-JSON-safe revision (bigint exceeding MAX_SAFE_INTEGER)", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: BigInt("9007199254740992"),
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/non-json-safe record revision/i);
  });

  it("fails closed on string revision precision loss (rounding outside safe integers)", async () => {
    // "9007199254740993" cannot be represented exactly as a IEEE-754 double and rounds to 9007199254740992.
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: "9007199254740993",
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/record revision/i);
  });

  it("fails closed on non-integer string revision", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: "1.5",
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/non-json-safe record revision/i);
  });

  it("fails closed on non-numeric string revision", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: "not-a-number",
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/non-json-safe record revision/i);
  });

  it("fails closed on null revision", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: null,
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/missing record revision/i);
  });

  it("fails closed on null creation timestamp", async () => {
    const mockRows = [
      { record_id: RECORD_ID_ONE, created_at: null, record_revision: 1 },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/missing creation timestamp/i);
  });

  it("fails closed on nil UUID in record identity with exact contracts schema error", async () => {
    const mockRows = [
      {
        record_id: "00000000-0000-0000-0000-000000000000",
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: 1,
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/A platform-issued identifier cannot be the nil UUID/);
  });

  it("fails closed on invalid UUID format", async () => {
    const mockRows = [
      {
        record_id: "not-a-valid-uuid",
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: 1,
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/Invalid uuid/i);
  });

  it("handles bigint revision from database driver within safe integer range", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: BigInt(42),
      },
    ];
    const transaction = createMockTransaction(mockRows);
    const result = await readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID);
    expect(result).toHaveLength(1);
    expect(result[0]!.expectedRecordRevision).toBe(42);
  });

  it("handles string revision from database driver", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: new Date("2026-09-01T00:00:00Z"),
        record_revision: "7",
      },
    ];
    const transaction = createMockTransaction(mockRows);
    const result = await readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID);
    expect(result).toHaveLength(1);
    expect(result[0]!.expectedRecordRevision).toBe(7);
  });

  it("handles ISO string timestamp from database driver", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: "2026-09-01T08:30:00.000Z",
        record_revision: 1,
      },
    ];
    const transaction = createMockTransaction(mockRows);
    const result = await readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID);
    expect(result).toHaveLength(1);
    expect(result[0]!.createdAt).toBe("2026-09-01T08:30:00.000Z");
  });

  it("fails closed on malformed timestamp string", async () => {
    const mockRows = [
      {
        record_id: RECORD_ID_ONE,
        created_at: "not-a-date",
        record_revision: 1,
      },
    ];
    const transaction = createMockTransaction(mockRows);
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/malformed creation timestamp/i);
  });

  it("propagates database errors as-is", async () => {
    const transaction: RequestDatabaseTransaction = {
      query: vi.fn().mockRejectedValue(new Error("55000: storage contract is unavailable")),
    };
    await expect(
      readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID),
    ).rejects.toThrow(/storage contract is unavailable/);
  });

  describe("lifecycle selector composition and hold/recovery protection negatives", () => {
    it("proves held and recovery-protected database candidates cannot enter dueRecords", async () => {
      // 1. Reader produces raw facts with no protection defaults.
      const mockRows = [
        {
          record_id: RECORD_ID_ONE,
          created_at: new Date("2026-01-01T00:00:00Z"),
          record_revision: 1,
        },
        {
          record_id: RECORD_ID_TWO,
          created_at: new Date("2026-01-02T00:00:00Z"),
          record_revision: 2,
        },
        {
          record_id: RECORD_ID_THREE,
          created_at: new Date("2026-01-03T00:00:00Z"),
          record_revision: 3,
        },
      ];
      const transaction = createMockTransaction(mockRows);
      const rawCandidates = await readLifecycleCandidateRecords(transaction, STORAGE_CONTRACT_ID);

      // 2. Authoritative enrichment step: join hold and recovery facts.
      // Candidate 1: legal hold
      // Candidate 2: recovery protection
      // Candidate 3: held and recovery protected
      const enrichedCandidates = [
        { ...rawCandidates[0]!, isHeld: true, isProtected: false },
        { ...rawCandidates[1]!, isHeld: false, isProtected: true },
        { ...rawCandidates[2]!, isHeld: true, isProtected: true },
      ];

      // 3. Evaluate lifecycle policy with enriched candidates.
      const handoff = selectDueRecordsForLifecycleHandoff({
        policy: samplePolicy,
        records: enrichedCandidates,
        evaluatedAt: new Date("2026-09-20T00:00:00Z"),
      });

      // Zero protected candidates may enter actionable dueRecords.
      expect(handoff.dueRecords).toHaveLength(0);

      // All 3 protected candidates must be classified as blockedRecords.
      expect(handoff.blockedRecords).toHaveLength(3);
      expect(handoff.blockedRecords.map((r) => r.recordId)).toEqual([
        RECORD_ID_ONE,
        RECORD_ID_TWO,
        RECORD_ID_THREE,
      ]);
      expect(handoff.blockedRecords[0]!.blockReason).toBe("legal_hold");
      expect(handoff.blockedRecords[1]!.blockReason).toBe("recovery_protection");
      expect(handoff.blockedRecords[2]!.blockReason).toBe("held_and_protected");

      // Truthful over-limit status report reflecting blocked removal.
      expect(handoff.statusReport.status).toBe("blocked_over_limit");
      expect(handoff.statusReport.isOverLimit).toBe(true);
      expect(handoff.statusReport.blockedRemovalCount).toBe(3);
      expect(handoff.statusReport.pendingRemovalCount).toBe(0);
    });
  });
});
