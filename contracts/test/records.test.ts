import { describe, expect, it } from "vitest";
import {
  recordSaveFieldCorrectionSchema,
  saveRecordCommandV2Schema,
  saveRecordResultV2Schema,
} from "../src";

const id = (value: number) => `14700000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const commandId = id(1);
const recordTypeId = id(2);
const recordId = id(3);
const fieldId = id(4);
const correlationId = id(5);

const createCommand = {
  contractVersion: "2.0.0",
  commandId,
  recordTypeId,
  operation: "create",
  submittedValues: {},
} as const;

const updateCommand = {
  contractVersion: "2.0.0",
  commandId,
  recordTypeId,
  operation: "update",
  recordId,
  expectedConcurrencyNumber: 7,
  submittedValues: {},
} as const;

const conflictError = {
  code: "conflict",
  messageKey: "errors.conflict",
  correlationId,
} as const;

describe("SaveRecord V2 contracts", () => {
  it("accepts an empty create patch and preserves missing, null and exact decimal text", () => {
    expect(saveRecordCommandV2Schema.safeParse(createCommand).success).toBe(true);
    const parsed = saveRecordCommandV2Schema.parse({
      ...createCommand,
      submittedValues: {
        [fieldId]: null,
        [id(6)]: "9007199254740993.125",
      },
    });
    expect(parsed.submittedValues).toEqual({
      [fieldId]: null,
      [id(6)]: "9007199254740993.125",
    });
    expect(parsed).not.toHaveProperty("recordId");
    expect(parsed).not.toHaveProperty("expectedConcurrencyNumber");
  });

  it.each([
    ["record identity", { recordId }],
    ["expected concurrency", { expectedConcurrencyNumber: 1 }],
    ["organization scope", { organizationId: id(7) }],
    ["Application scope", { applicationRootId: id(8) }],
    ["Module scope", { moduleRootId: id(9) }],
    ["permission claim", { permissionId: id(10) }],
    ["validation claim", { validated: true }],
  ])("refuses a caller-supplied %s on create", (_label, extra) => {
    expect(saveRecordCommandV2Schema.safeParse({ ...createCommand, ...extra }).success).toBe(false);
  });

  it("requires update identity and a positive JavaScript-safe concurrency number", () => {
    expect(saveRecordCommandV2Schema.safeParse(updateCommand).success).toBe(true);
    for (const candidate of [
      { ...updateCommand, recordId: undefined },
      { ...updateCommand, expectedConcurrencyNumber: undefined },
      { ...updateCommand, expectedConcurrencyNumber: 0 },
      { ...updateCommand, expectedConcurrencyNumber: Number.MAX_SAFE_INTEGER + 1 },
      { ...updateCommand, expectedConcurrencyNumber: 1.5 },
    ])
      expect(saveRecordCommandV2Schema.safeParse(candidate).success).toBe(false);
  });

  it("keeps update omission distinct from an explicit clear", () => {
    expect(saveRecordCommandV2Schema.parse(updateCommand).submittedValues).toEqual({});
    expect(
      saveRecordCommandV2Schema.parse({
        ...updateCommand,
        submittedValues: { [fieldId]: null },
      }).submittedValues,
    ).toEqual({ [fieldId]: null });
  });

  it("refuses invalid field identifiers and non-JSON values", () => {
    expect(
      saveRecordCommandV2Schema.safeParse({
        ...createCommand,
        submittedValues: { title: "not keyed by a permanent field id" },
      }).success,
    ).toBe(false);
    expect(
      saveRecordCommandV2Schema.safeParse({
        ...createCommand,
        submittedValues: { [fieldId]: Number.NaN },
      }).success,
    ).toBe(false);
  });

  it.each(["invalid_value", "required_value", "field_refused"] as const)(
    "accepts the safe %s correction without free text or values",
    (code) => {
      expect(
        recordSaveFieldCorrectionSchema.safeParse({
          code,
          fieldId,
          nestedPath: [0, "amount"],
        }).success,
      ).toBe(true);
    },
  );

  it("refuses empty corrections and internal or free-text diagnostic properties", () => {
    expect(
      saveRecordResultV2Schema.safeParse({
        contractVersion: "2.0.0",
        outcome: "correction_required",
        correlationId,
        corrections: [],
      }).success,
    ).toBe(false);
    for (const correction of [
      { code: "invalid_existing_value", fieldId },
      { code: "invalid_value", fieldId, message: "submitted secret" },
      { code: "invalid_value", fieldId, nestedPath: ["recordType.fields"] },
    ])
      expect(recordSaveFieldCorrectionSchema.safeParse(correction).success).toBe(false);
  });

  it.each(["none", "pending"] as const)(
    "accepts a saved readable projection with %s background delivery",
    (backgroundDelivery) => {
      expect(
        saveRecordResultV2Schema.safeParse({
          contractVersion: "2.0.0",
          outcome: "saved",
          recordId,
          concurrencyNumber: 8,
          readableValues: { [fieldId]: "visible" },
          correlationId,
          backgroundDelivery,
        }).success,
      ).toBe(true);
    },
  );

  it("allows an optional current readable projection only for conflict", () => {
    const current = { recordId, concurrencyNumber: 9, readableValues: { [fieldId]: "current" } };
    expect(
      saveRecordResultV2Schema.safeParse({
        contractVersion: "2.0.0",
        outcome: "refused",
        error: conflictError,
      }).success,
    ).toBe(true);
    expect(
      saveRecordResultV2Schema.safeParse({
        contractVersion: "2.0.0",
        outcome: "refused",
        error: conflictError,
        current,
      }).success,
    ).toBe(true);
    expect(
      saveRecordResultV2Schema.safeParse({
        contractVersion: "2.0.0",
        outcome: "refused",
        error: {
          code: "operation_refused",
          messageKey: "errors.operation_refused",
          correlationId,
        },
        current,
      }).success,
    ).toBe(false);
  });

  it("requires V2 on every result and rejects private stored-row properties", () => {
    const saved = {
      contractVersion: "2.0.0",
      outcome: "saved",
      recordId,
      concurrencyNumber: 1,
      readableValues: {},
      correlationId,
      backgroundDelivery: "none",
    } as const;
    expect(
      saveRecordResultV2Schema.safeParse({ ...saved, contractVersion: undefined }).success,
    ).toBe(false);
    expect(
      saveRecordResultV2Schema.safeParse({
        ...saved,
        organizationId: id(11),
        storageContractId: id(12),
        createdBy: id(13),
      }).success,
    ).toBe(false);
  });
});
