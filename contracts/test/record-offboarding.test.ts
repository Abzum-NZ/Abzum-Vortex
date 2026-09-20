import { describe, expect, it } from "vitest";
import {
  offboardingTransferBatchCommandSchema,
  offboardingTransferBatchEntrySchema,
  offboardingTransferBatchItemResultSchema,
  offboardingTransferBatchResultSchema,
  recordOffboardingInventoryClassificationSchema,
  recordOffboardingInventoryCommandSchema,
  recordOffboardingInventoryItemSchema,
  recordOffboardingInventoryResultSchema,
  recordOffboardingSectionSchema,
  recordOffboardingTargetSchema,
} from "../src";

const id = (value: number) => `40700000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const nilId = "00000000-0000-0000-0000-000000000000";

const inventoryCommand = {
  contractVersion: "1.0.0",
  sourceOrganizationAccountId: id(1),
  section: { kind: "application", applicationRootId: id(2) },
  target: { kind: "organization_account", targetOrganizationAccountId: id(3) },
  pageSize: 25,
} as const;

const inventoryItem = {
  recordTypeId: id(4),
  recordId: id(5),
  concurrencyNumber: 7,
  lifecycleState: "active",
  installationState: "active",
  classification: "transferable",
} as const;

describe("record offboarding inventory contracts", () => {
  it("accepts every section and target variant with the initial version", () => {
    const sections = [
      { kind: "organization_shared" as const },
      { kind: "application" as const, applicationRootId: id(6) },
    ];
    const targets = [
      { kind: "organization_account" as const, targetOrganizationAccountId: id(7) },
      { kind: "group" as const, targetGroupId: id(8) },
    ];
    for (const section of sections)
      for (const target of targets)
        expect(
          recordOffboardingInventoryCommandSchema.safeParse({
            ...inventoryCommand,
            section,
            target,
          }).success,
        ).toBe(true);

    expect(recordOffboardingSectionSchema.options).toHaveLength(2);
    expect(recordOffboardingTargetSchema.options).toHaveLength(2);
  });

  it("requires a strict 1..50 page and an all-or-nothing cursor", () => {
    const after = { storageContractId: id(9), recordId: id(10) };
    expect(
      recordOffboardingInventoryCommandSchema.parse({ ...inventoryCommand, pageSize: 1, after }),
    ).toMatchObject({ pageSize: 1, after });
    expect(
      recordOffboardingInventoryCommandSchema.parse({ ...inventoryCommand, pageSize: 50 }),
    ).toMatchObject({ pageSize: 50 });

    for (const candidate of [
      { ...inventoryCommand, pageSize: 0 },
      { ...inventoryCommand, pageSize: 51 },
      { ...inventoryCommand, pageSize: 1.5 },
      { ...inventoryCommand, after: { storageContractId: id(9) } },
      { ...inventoryCommand, after: { recordId: id(10) } },
      { ...inventoryCommand, after: { storageContractId: nilId, recordId: id(10) } },
      { ...inventoryCommand, actorOrganizationAccountId: id(11) },
    ])
      expect(recordOffboardingInventoryCommandSchema.safeParse(candidate).success).toBe(false);
  });

  it("keeps shared impact on the shared section and requires truthful completion", () => {
    const sharedResult = {
      contractVersion: "1.0.0",
      section: { kind: "organization_shared" },
      items: [inventoryItem],
      perRecordType: [{ recordTypeId: id(4), transferable: 1, refusedIncompatible: 0 }],
      sharedImpact: [{ storageContractId: id(12), applicationRootIds: [id(2), id(13)] }],
      complete: true,
      accessVersion: 3,
    } as const;
    expect(recordOffboardingInventoryResultSchema.safeParse(sharedResult).success).toBe(true);
    expect(
      recordOffboardingInventoryResultSchema.safeParse({
        ...sharedResult,
        complete: false,
        next: { storageContractId: id(12), recordId: id(5) },
      }).success,
    ).toBe(true);

    for (const candidate of [
      { ...sharedResult, sharedImpact: undefined },
      { ...sharedResult, next: { storageContractId: id(12), recordId: id(5) } },
      { ...sharedResult, complete: false },
      {
        ...sharedResult,
        section: { kind: "application", applicationRootId: id(2) },
      },
      {
        ...sharedResult,
        sharedImpact: [{ storageContractId: id(12), applicationRootIds: [] }],
      },
    ])
      expect(recordOffboardingInventoryResultSchema.safeParse(candidate).success).toBe(false);
  });

  it("accepts application results without shared impact", () => {
    expect(
      recordOffboardingInventoryResultSchema.safeParse({
        contractVersion: "1.0.0",
        section: { kind: "application", applicationRootId: id(2) },
        items: [
          {
            ...inventoryItem,
            lifecycleState: "soft_deleted",
            installationState: "detached",
            classification: "refused_incompatible",
          },
        ],
        perRecordType: [{ recordTypeId: id(4), transferable: 0, refusedIncompatible: 1 }],
        complete: true,
        accessVersion: 4,
      }).success,
    ).toBe(true);
  });

  it("rejects a transferable removal-pending standalone item", () => {
    expect(
      recordOffboardingInventoryItemSchema.safeParse({
        ...inventoryItem,
        lifecycleState: "removal_pending",
      }).success,
    ).toBe(false);
  });

  it("rejects a complete result containing a transferable removal-pending item", () => {
    expect(
      recordOffboardingInventoryResultSchema.safeParse({
        contractVersion: "1.0.0",
        section: { kind: "application", applicationRootId: id(2) },
        items: [{ ...inventoryItem, lifecycleState: "removal_pending" }],
        perRecordType: [{ recordTypeId: id(4), transferable: 1, refusedIncompatible: 0 }],
        complete: true,
        accessVersion: 4,
      }).success,
    ).toBe(false);
  });

  it("accepts removal-pending refused-incompatible items and matching result counts", () => {
    const removalPendingItem = {
      ...inventoryItem,
      lifecycleState: "removal_pending",
      classification: "refused_incompatible",
    } as const;
    expect(recordOffboardingInventoryItemSchema.safeParse(removalPendingItem).success).toBe(true);
    expect(
      recordOffboardingInventoryResultSchema.safeParse({
        contractVersion: "1.0.0",
        section: { kind: "application", applicationRootId: id(2) },
        items: [removalPendingItem],
        perRecordType: [{ recordTypeId: id(4), transferable: 0, refusedIncompatible: 1 }],
        complete: true,
        accessVersion: 4,
      }).success,
    ).toBe(true);
  });

  it("makes an access-refused record or count impossible to represent", () => {
    expect(recordOffboardingInventoryClassificationSchema.options).toEqual([
      "transferable",
      "refused_incompatible",
    ]);
    for (const leaked of [
      { classification: "access_refused" },
      { accessRefused: true },
      { refusalReason: "operator cannot read record" },
    ])
      expect(
        recordOffboardingInventoryResultSchema.safeParse({
          contractVersion: "1.0.0",
          section: { kind: "application", applicationRootId: id(2) },
          items: [{ ...inventoryItem, ...leaked }],
          perRecordType: [{ recordTypeId: id(4), transferable: 1, refusedIncompatible: 0 }],
          complete: true,
          accessVersion: 4,
        }).success,
      ).toBe(false);

    expect(
      recordOffboardingInventoryResultSchema.safeParse({
        contractVersion: "1.0.0",
        section: { kind: "application", applicationRootId: id(2) },
        items: [inventoryItem],
        perRecordType: [
          { recordTypeId: id(4), transferable: 1, refusedIncompatible: 0, accessRefused: 1 },
        ],
        complete: true,
        accessVersion: 4,
      }).success,
    ).toBe(false);
  });

  it("rejects unsupported versions and invalid inventory union vocabulary", () => {
    for (const candidate of [
      { ...inventoryCommand, contractVersion: "2.0.0" },
      { ...inventoryCommand, section: { kind: "all_applications" } },
      { ...inventoryCommand, target: { kind: "team", targetGroupId: id(8) } },
    ])
      expect(recordOffboardingInventoryCommandSchema.safeParse(candidate).success).toBe(false);
  });
});

const batchItem = {
  recordTypeId: id(20),
  recordId: id(21),
  expectedConcurrencyNumber: 8,
  entry: "public",
} as const;

const batchCommand = {
  contractVersion: "1.0.0",
  batchId: id(22),
  sourceOrganizationAccountId: id(23),
  targetOrganizationAccountId: id(24),
  items: [batchItem],
} as const;

describe("offboarding transfer batch contracts", () => {
  it("accepts both protected entries and strictly bounds batches to 1..50 items", () => {
    expect(offboardingTransferBatchCommandSchema.safeParse(batchCommand).success).toBe(true);
    expect(
      offboardingTransferBatchCommandSchema.safeParse({
        ...batchCommand,
        items: [{ ...batchItem, entry: "offboarding" }],
      }).success,
    ).toBe(true);
    expect(offboardingTransferBatchEntrySchema.options).toEqual(["public", "offboarding"]);
    expect(
      offboardingTransferBatchCommandSchema.safeParse({
        ...batchCommand,
        items: Array.from({ length: 50 }, (_, index) => ({
          ...batchItem,
          recordId: id(100 + index),
        })),
      }).success,
    ).toBe(true);
    expect(
      offboardingTransferBatchCommandSchema.safeParse({ ...batchCommand, items: [] }).success,
    ).toBe(false);
    expect(
      offboardingTransferBatchCommandSchema.safeParse({
        ...batchCommand,
        items: Array.from({ length: 51 }, (_, index) => ({
          ...batchItem,
          recordId: id(200 + index),
        })),
      }).success,
    ).toBe(false);
  });

  it("rejects invalid revisions, entries, identifiers, versions and extra authority", () => {
    for (const candidate of [
      { ...batchCommand, contractVersion: "2.0.0" },
      { ...batchCommand, batchId: nilId },
      { ...batchCommand, sourceOrganizationAccountId: nilId },
      { ...batchCommand, targetGroupId: id(25) },
      { ...batchCommand, items: [{ ...batchItem, expectedConcurrencyNumber: 0 }] },
      { ...batchCommand, items: [{ ...batchItem, expectedConcurrencyNumber: 1.5 }] },
      { ...batchCommand, items: [{ ...batchItem, entry: "private" }] },
    ])
      expect(offboardingTransferBatchCommandSchema.safeParse(candidate).success).toBe(false);
  });

  it("accepts each per-record outcome and verifies its aggregate counts", () => {
    const items = [
      {
        recordTypeId: id(20),
        recordId: id(21),
        outcome: "completed",
        concurrencyNumber: 9,
        replayed: false,
      },
      {
        recordTypeId: id(26),
        recordId: id(27),
        outcome: "conflicted",
        conflictCode: "concurrency_conflict",
      },
      {
        recordTypeId: id(28),
        recordId: id(29),
        outcome: "refused",
        refusalCode: "operation_refused",
      },
    ] as const;
    for (const item of items)
      expect(offboardingTransferBatchItemResultSchema.safeParse(item).success).toBe(true);
    expect(offboardingTransferBatchItemResultSchema.options).toHaveLength(3);

    const result = {
      contractVersion: "1.0.0",
      batchId: id(22),
      items,
      completed: 1,
      conflicted: 1,
      refused: 1,
    } as const;
    expect(offboardingTransferBatchResultSchema.safeParse(result).success).toBe(true);
    expect(
      offboardingTransferBatchResultSchema.safeParse({ ...result, completed: 2 }).success,
    ).toBe(false);
  });

  it("allows only safe, non-disclosing refusal and conflict codes", () => {
    const refused = {
      recordTypeId: id(30),
      recordId: id(31),
      outcome: "refused",
      refusalCode: "owner_unavailable",
    } as const;
    const conflicted = {
      recordTypeId: id(30),
      recordId: id(31),
      outcome: "conflicted",
      conflictCode: "command_identity_conflict",
    } as const;
    expect(offboardingTransferBatchItemResultSchema.safeParse(refused).success).toBe(true);
    expect(offboardingTransferBatchItemResultSchema.safeParse(conflicted).success).toBe(true);
    for (const candidate of [
      { ...refused, refusalCode: "access_refused" },
      { ...refused, reason: "operator lacks transfer permission" },
      { ...refused, recordValues: { secret: true } },
      { ...conflicted, currentConcurrencyNumber: 12 },
    ])
      expect(offboardingTransferBatchItemResultSchema.safeParse(candidate).success).toBe(false);
  });
});
