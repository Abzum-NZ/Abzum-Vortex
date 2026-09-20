import { describe, expect, it, vi } from "vitest";
import type { RequestDatabaseTransaction, DatabaseRow } from "@vortex/db";
import { readLifecycleCandidateRecords } from "../src/record-lifecycle-selection";

// Stable UUID fixtures.
const STORAGE_CONTRACT_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" as never;
const RECORD_ID_ONE = "11111111-1111-4111-8111-111111111111";
const RECORD_ID_TWO = "22222222-2222-4222-8222-222222222222";
const NIL_UUID = "00000000-0000-0000-0000-000000000000" as never;

const createMockTransaction = (
  rows: readonly DatabaseRow[],
): RequestDatabaseTransaction => ({
  query: vi.fn().mockResolvedValue(rows),
});

describe("readLifecycleCandidateRecords", () => {
  it("returns validated candidate records for valid rows", async () => {
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
      isHeld: false,
      isProtected: false,
    });
    expect(result[1]).toEqual({
      recordId: RECORD_ID_TWO,
      expectedRecordRevision: 1,
      createdAt: now.toISOString(),
      isHeld: false,
      isProtected: false,
    });
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

  it("fails closed on non-JSON-safe revision (exceeds MAX_SAFE_INTEGER)", async () => {
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

  it("fails closed on malformed record identity (nil UUID in result)", async () => {
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
    ).rejects.toThrow(/malformed record identity/i);
  });

  it("handles bigint revision from database driver", async () => {
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
});
