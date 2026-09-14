import { describe, expect, it } from "vitest";
import { executeNamedActionCommandV2Schema, executeNamedActionResultV2Schema } from "../src";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("named action contracts", () => {
  const command = {
    contractVersion: "2.0.0",
    commandId: id(1),
    action: {
      ownerKind: "module",
      ownerId: id(2),
      releaseRevision: 3,
      actionId: id(4),
    },
    recordTypeId: id(5),
    recordId: id(6),
    expectedConcurrencyNumber: 1,
    inputs: { reason: "approved" },
  };

  it("requires an exact owner, action and release without accepting effects", () => {
    expect(executeNamedActionCommandV2Schema.safeParse(command).success).toBe(true);
    expect(executeNamedActionCommandV2Schema.safeParse({ ...command, effects: [] }).success).toBe(
      false,
    );
    expect(
      executeNamedActionCommandV2Schema.safeParse({
        ...command,
        action: { ...command.action, releaseRevision: undefined },
      }).success,
    ).toBe(false);
  });

  it("keeps owner kinds distinct and exposes no values in refusals", () => {
    expect(
      executeNamedActionCommandV2Schema.safeParse({
        ...command,
        action: { ...command.action, ownerKind: "application" },
      }).success,
    ).toBe(true);
    expect(
      executeNamedActionResultV2Schema.safeParse({
        contractVersion: "2.0.0",
        outcome: "refused",
        error: {
          code: "operation_refused",
          messageKey: "errors.operation_refused",
          correlationId: id(7),
        },
        readableValues: { [id(8)]: "hidden" },
      }).success,
    ).toBe(false);
  });
});
