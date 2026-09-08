import { moduleFieldV2Schema, moduleSourceFieldV2Schema } from "../src";
import { describe, expect, it } from "vitest";

const fieldId = "72000000-0000-4000-8000-000000000001";
const base = {
  id: "fld_calculated",
  key: "calculated",
  label: "Calculated",
  required: false,
  unique: false,
  filterable: true,
  sortable: true,
  personal_data: "none",
  public_display: "refused",
  type: "calculation",
} as const;
const canonicalBase = {
  fieldId,
  key: "calculated",
  label: "Calculated",
  required: false,
  unique: false,
  filterable: true,
  sortable: true,
  personalData: "none",
  publicDisplay: "refused",
  type: "calculation",
} as const;

describe("Module V2 calculation precision contracts", () => {
  it("keeps older V2 calculation and average shapes readable without precision", () => {
    expect(
      moduleSourceFieldV2Schema.safeParse({
        ...base,
        settings: {
          result_type: "decimal_number",
          expression: {
            operation: "numeric",
            numeric_operation: "divide",
            operands: [
              { source: "literal", value: "1" },
              { source: "literal", value: "3" },
            ],
          },
        },
      }).success,
    ).toBe(true);
    expect(
      moduleFieldV2Schema.safeParse({
        ...canonicalBase,
        settings: {
          resultType: "decimal_number",
          expression: {
            kind: "numeric",
            operation: "divide",
            operands: [
              { source: "literal", value: "1" },
              { source: "literal", value: "3" },
            ],
          },
          dependencyFieldIds: [fieldId],
        },
      }).success,
    ).toBe(true);
  });

  it("accepts bounded precision only on decimal or money calculations", () => {
    const settings = {
      result_type: "decimal_number",
      decimal_places: 12,
      expression: {
        operation: "numeric",
        numeric_operation: "divide",
        operands: [
          { source: "literal", value: "1" },
          { source: "literal", value: "3" },
        ],
      },
    } as const;
    expect(moduleSourceFieldV2Schema.safeParse({ ...base, settings }).success).toBe(true);
    expect(
      moduleSourceFieldV2Schema.safeParse({
        ...base,
        settings: { ...settings, decimal_places: 13 },
      }).success,
    ).toBe(false);
    expect(
      moduleSourceFieldV2Schema.safeParse({
        ...base,
        settings: {
          result_type: "text",
          decimal_places: 2,
          expression: { operation: "join_text", fields: ["title"], separator: "" },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts optional precision only on average totals", () => {
    const total = {
      ...base,
      type: "total",
      settings: {
        relationship: "vortex.example:line.parent",
        operation: "average",
        result_type: "decimal_number",
        field: "amount",
        decimal_places: 4,
      },
    } as const;
    expect(moduleSourceFieldV2Schema.safeParse(total).success).toBe(true);
    expect(
      moduleSourceFieldV2Schema.safeParse({
        ...total,
        settings: { ...total.settings, operation: "sum" },
      }).success,
    ).toBe(false);
  });
});
