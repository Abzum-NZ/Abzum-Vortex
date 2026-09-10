import { describe, expect, it } from "vitest";
import {
  grantOrganizationDirectRecordShareCommandSchema,
  revokeOrganizationDirectRecordShareCommandSchema,
} from "../src/record-share-operations";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("protected direct-share commands", () => {
  it("accepts a meaningful read-only grant without a caller-selected share identity", () => {
    const parsed = grantOrganizationDirectRecordShareCommandSchema.parse({
      recordId: id(1),
      recipient: { kind: "organization_account", organizationAccountId: id(2) },
      readableFieldIds: [id(3)],
      changeableFieldIds: [],
      startsAt: "2026-09-08T00:00:00.000Z",
      reason: "Temporary access",
    });
    expect(parsed).not.toHaveProperty("directShareId");
  });

  it("rejects a share that grants no readable fields", () => {
    expect(
      grantOrganizationDirectRecordShareCommandSchema.safeParse({
        recordId: id(1),
        recipient: { kind: "organization_account", organizationAccountId: id(2) },
        readableFieldIds: [],
        changeableFieldIds: [],
        startsAt: "2026-09-08T00:00:00.000Z",
        reason: "Temporary access",
      }).success,
    ).toBe(false);
  });

  it("rejects noncanonical fields and change authority outside the read set", () => {
    const base = {
      recordId: id(1),
      recipient: { kind: "group" as const, groupId: id(2) },
      readableFieldIds: [id(4), id(3)],
      changeableFieldIds: [id(5)],
      startsAt: "2026-09-08T00:00:00.000Z",
      reason: "Temporary access",
    };
    expect(grantOrganizationDirectRecordShareCommandSchema.safeParse(base).success).toBe(false);
  });

  it("binds revocation to the exact share, record and expected revision", () => {
    expect(
      revokeOrganizationDirectRecordShareCommandSchema.safeParse({
        directShareId: id(1),
        recordId: id(2),
        expectedRevision: 3,
        reason: "Access no longer required",
      }).success,
    ).toBe(true);
  });
});
