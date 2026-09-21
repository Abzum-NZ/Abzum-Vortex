import { describe, expect, it } from "vitest";
import { sourceConditionSchema } from "../src";

describe("Groups compatibility", () => {
  it("keeps access principals out of generic authored condition operands", () => {
    expect(
      sourceConditionSchema.safeParse({
        operator: "equals",
        left: { source: "team", team: "support" },
        right: { source: "value", value: true },
      }).success,
    ).toBe(false);
    expect(
      sourceConditionSchema.safeParse({
        operator: "equals",
        left: { source: "group", group: "support" },
        right: { source: "value", value: true },
      }).success,
    ).toBe(false);
  });
});
