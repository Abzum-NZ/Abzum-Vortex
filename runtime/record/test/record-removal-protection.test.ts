import { describe, expect, it, vi } from "vitest";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  readLifecycleRemovalProtectionFacts,
  resolveRecordRecoveryEligibility,
} from "../src/record-removal-protection";

const ORGANIZATION_ID = "a0000000-0000-4000-8000-000000000001" as never;
const APPLICATION_ID = "a0000000-0000-4000-8000-000000000002" as never;
const STORAGE_ID = "a0000000-0000-4000-8000-000000000003" as never;
const RECORD_TYPE_ID = "a0000000-0000-4000-8000-000000000004" as never;
const RECORD_ID = "a0000000-0000-4000-8000-000000000005" as never;

const transactionWith = (rows: readonly DatabaseRow[]): RequestDatabaseTransaction => ({
  query: vi.fn().mockResolvedValue(rows),
});

const containedInput = {
  organizationId: ORGANIZATION_ID,
  applicationRootId: APPLICATION_ID,
  storageScope: "application_contained" as const,
  storageContractId: STORAGE_ID,
  recordTypeId: RECORD_TYPE_ID,
  recordId: RECORD_ID,
  deletedAt: "2026-09-20T00:00:00.000Z",
};

describe("resolveRecordRecoveryEligibility", () => {
  it("returns the exact content-free eligible result", async () => {
    const transaction = transactionWith([{ result: { outcome: "eligible" } }]);
    await expect(resolveRecordRecoveryEligibility(transaction, containedInput)).resolves.toEqual({
      outcome: "eligible",
    });
    expect(transaction.query).toHaveBeenCalledTimes(1);
  });

  it.each(["recovery_unavailable", "recovery_expired"] as const)(
    "returns the closed %s refusal",
    async (reasonCode) => {
      const transaction = transactionWith([{ result: { outcome: "refused", reasonCode } }]);
      await expect(resolveRecordRecoveryEligibility(transaction, containedInput)).resolves.toEqual({
        outcome: "refused",
        reasonCode,
      });
    },
  );

  it("rejects extra database result fields instead of leaking evidence", async () => {
    const transaction = transactionWith([
      { result: { outcome: "eligible", removalDueAt: "2026-10-01T00:00:00Z" } },
    ]);
    await expect(resolveRecordRecoveryEligibility(transaction, containedInput)).rejects.toThrow(
      /invalid closed result/i,
    );
  });

  it("rejects contradictory permanent application scope before querying", async () => {
    const transaction = transactionWith([]);
    await expect(
      resolveRecordRecoveryEligibility(transaction, {
        ...containedInput,
        storageScope: "organization_shared",
      }),
    ).rejects.toThrow(/contradictory storage scope/i);
    expect(transaction.query).not.toHaveBeenCalled();
  });

  it("rejects malformed deletion time before querying", async () => {
    const transaction = transactionWith([]);
    await expect(
      resolveRecordRecoveryEligibility(transaction, {
        ...containedInput,
        deletedAt: "not-a-time",
      }),
    ).rejects.toThrow(/malformed deletion timestamp/i);
    expect(transaction.query).not.toHaveBeenCalled();
  });

  it("requires exactly one database result row", async () => {
    const transaction = transactionWith([]);
    await expect(resolveRecordRecoveryEligibility(transaction, containedInput)).rejects.toThrow(
      /invalid row count/i,
    );
  });
});

describe("readLifecycleRemovalProtectionFacts", () => {
  it("maps active, recoverable, expired, removal-pending, and held facts", async () => {
    const transaction = transactionWith([
      {
        record_id: "a0000000-0000-4000-8000-000000000010",
        record_revision: 1n,
        lifecycle_state: "active",
        deleted_at: null,
        removal_due_at: null,
        is_held: false,
        is_recovery_protected: false,
        protection_revision: 0n,
      },
      {
        record_id: "a0000000-0000-4000-8000-000000000011",
        record_revision: "2",
        lifecycle_state: "soft_deleted",
        deleted_at: new Date("2026-09-20T00:00:00Z"),
        removal_due_at: "2026-10-04T00:00:00Z",
        is_held: false,
        is_recovery_protected: true,
        protection_revision: "2",
      },
      {
        record_id: "a0000000-0000-4000-8000-000000000012",
        record_revision: 3,
        lifecycle_state: "soft_deleted",
        deleted_at: "2026-08-01T00:00:00Z",
        removal_due_at: "2026-08-15T00:00:00Z",
        is_held: true,
        is_recovery_protected: false,
        protection_revision: 4,
      },
      {
        record_id: "a0000000-0000-4000-8000-000000000013",
        record_revision: 4,
        lifecycle_state: "removal_pending",
        deleted_at: "2026-08-01T00:00:00Z",
        removal_due_at: "2026-08-15T00:00:00Z",
        is_held: false,
        is_recovery_protected: false,
        protection_revision: 5,
      },
    ]);

    const facts = await readLifecycleRemovalProtectionFacts(transaction, STORAGE_ID);
    expect(facts).toHaveLength(4);
    expect(
      facts.map(({ lifecycleState, isHeld, isProtected }) => ({
        lifecycleState,
        isHeld,
        isProtected,
      })),
    ).toEqual([
      { lifecycleState: "active", isHeld: false, isProtected: false },
      { lifecycleState: "soft_deleted", isHeld: false, isProtected: true },
      { lifecycleState: "soft_deleted", isHeld: true, isProtected: false },
      { lifecycleState: "removal_pending", isHeld: false, isProtected: false },
    ]);
    expect(facts[1]!.deletedAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("preserves fail-closed deleted rows with a null due time", async () => {
    const transaction = transactionWith([
      {
        record_id: RECORD_ID,
        record_revision: 2,
        lifecycle_state: "soft_deleted",
        deleted_at: "2026-09-20T00:00:00Z",
        removal_due_at: null,
        is_held: false,
        is_recovery_protected: true,
        protection_revision: 0,
      },
    ]);
    const [fact] = await readLifecycleRemovalProtectionFacts(transaction, STORAGE_ID);
    expect(fact).toMatchObject({ removalDueAt: null, isProtected: true });
  });

  it("rejects an active row presented as recovery protected", async () => {
    const transaction = transactionWith([
      {
        record_id: RECORD_ID,
        record_revision: 1,
        lifecycle_state: "active",
        deleted_at: null,
        removal_due_at: null,
        is_held: false,
        is_recovery_protected: true,
        protection_revision: 0,
      },
    ]);
    await expect(readLifecycleRemovalProtectionFacts(transaction, STORAGE_ID)).rejects.toThrow(
      /contradictory lifecycle facts/i,
    );
  });

  it("rejects duplicate record identities", async () => {
    const row = {
      record_id: RECORD_ID,
      record_revision: 1,
      lifecycle_state: "active",
      deleted_at: null,
      removal_due_at: null,
      is_held: false,
      is_recovery_protected: false,
      protection_revision: 0,
    };
    const transaction = transactionWith([row, row]);
    await expect(readLifecycleRemovalProtectionFacts(transaction, STORAGE_ID)).rejects.toThrow(
      /duplicate record identity/i,
    );
  });

  it("rejects precision-losing protection revisions", async () => {
    const transaction = transactionWith([
      {
        record_id: RECORD_ID,
        record_revision: 1,
        lifecycle_state: "active",
        deleted_at: null,
        removal_due_at: null,
        is_held: false,
        is_recovery_protected: false,
        protection_revision: "9007199254740992",
      },
    ]);
    await expect(readLifecycleRemovalProtectionFacts(transaction, STORAGE_ID)).rejects.toThrow(
      /invalid protection revision/i,
    );
  });
});
