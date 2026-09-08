import { describe, expect, it } from "vitest";
import {
  ruleGraphInputDeclarationSchema,
  ruleGraphTypedValueSchema,
  ruleGraphVariableDeclarationSchema,
} from "../src/rule-graph-contracts";
import {
  sourceRuleGraphTypedValueSchema,
  sourceRuleGraphVariableDeclarationSchema,
} from "../src/rule-graph-source-contracts";

const columns = [
  { key: "amount", type: "decimal_number", required: true },
  { key: "budget", type: "money", required: true },
  { key: "description", type: "text", required: false },
] as const;
const canonical = {
  type: "table",
  columns,
  value: [
    {
      amount: "9007199254740993",
      budget: { amount: "12.34", currency: "NZD" },
      description: "0012.3400",
    },
  ],
};

describe("self-describing flow tables", () => {
  it("distinguishes exact decimal and money cells from decimal-looking text", () => {
    expect(ruleGraphTypedValueSchema.parse(canonical)).toEqual(canonical);
    const authored = {
      ...canonical,
      columns: [...columns].reverse(),
      value: [
        {
          amount: "9007199254740993.00",
          budget: { amount: "12.3400", currency: "NZD" },
          description: "0012.3400",
        },
      ],
    };
    expect(sourceRuleGraphTypedValueSchema.parse(authored)).toEqual(authored);
    expect(ruleGraphTypedValueSchema.safeParse(authored).success).toBe(false);
    expect(ruleGraphTypedValueSchema.safeParse({ ...authored, columns }).success).toBe(false);
  });

  it("requires declared column types and rejects unknown, missing required and wrong-typed cells", () => {
    expect(ruleGraphTypedValueSchema.safeParse({ type: "table", value: [] }).success).toBe(false);
    expect(
      ruleGraphTypedValueSchema.safeParse({ ...canonical, columns: [columns[0], columns[0]] })
        .success,
    ).toBe(false);
    for (const row of [
      { ...canonical.value[0], extra: "not declared" },
      { budget: canonical.value[0]!.budget },
      { ...canonical.value[0], amount: 12.34 },
      { ...canonical.value[0], budget: "12.34" },
      { ...canonical.value[0], description: null },
    ])
      expect(ruleGraphTypedValueSchema.safeParse({ ...canonical, value: [row] }).success).toBe(
        false,
      );
    expect(
      ruleGraphTypedValueSchema.safeParse({
        ...canonical,
        value: [{ amount: "1", budget: { amount: "2", currency: "NZD" } }],
      }).success,
    ).toBe(true);
  });

  it("preserves row order and accepts empty typed tables", () => {
    const rows = [canonical.value[0], { amount: "1", budget: { amount: "2", currency: "NZD" } }];
    expect(ruleGraphTypedValueSchema.parse({ ...canonical, value: rows }).value).toEqual(rows);
    expect(ruleGraphTypedValueSchema.safeParse({ ...canonical, value: [] }).success).toBe(true);
  });

  it("requires table defaults to match the variable's declared columns", () => {
    const variable = {
      variableId: "10000000-0000-4000-8000-000000000001",
      key: "rows",
      type: "table",
      columns,
      defaultValue: canonical,
    };
    const source = {
      id: "rows",
      key: "rows",
      type: "table",
      columns: [...columns].reverse(),
      default_value: canonical,
    };
    expect(sourceRuleGraphVariableDeclarationSchema.safeParse(source).success).toBe(true);
    for (const changedColumns of [
      columns.map((column) => (column.key === "amount" ? { ...column, type: "text" } : column)),
      columns.map((column) =>
        column.key === "description" ? { ...column, required: true } : column,
      ),
      columns.filter((column) => column.key !== "description"),
    ]) {
      expect(
        ruleGraphVariableDeclarationSchema.safeParse({ ...variable, columns: changedColumns })
          .success,
      ).toBe(false);
      expect(
        sourceRuleGraphVariableDeclarationSchema.safeParse({ ...source, columns: changedColumns })
          .success,
      ).toBe(false);
    }
  });

  it("uses the existing absolute table row ceiling for source and canonical literals", () => {
    for (const schema of [sourceRuleGraphTypedValueSchema, ruleGraphTypedValueSchema]) {
      expect(
        schema.safeParse({
          ...canonical,
          value: Array.from({ length: 1_000 }, () => canonical.value[0]),
        }).success,
      ).toBe(true);
      expect(
        schema.safeParse({
          ...canonical,
          value: Array.from({ length: 1_001 }, () => canonical.value[0]),
        }).success,
      ).toBe(false);
    }
  });

  it("requires table metadata on inputs and variables without imposing field storage settings", () => {
    const input = {
      inputId: "10000000-0000-4000-8000-000000000001",
      key: "rows",
      type: "table",
      required: true,
    };
    expect(ruleGraphInputDeclarationSchema.safeParse(input).success).toBe(false);
    expect(ruleGraphInputDeclarationSchema.safeParse({ ...input, columns }).success).toBe(true);
    expect(
      ruleGraphInputDeclarationSchema.safeParse({ ...input, type: "text", columns }).success,
    ).toBe(false);
    const variable = {
      variableId: input.inputId,
      key: "rows",
      type: "table",
      defaultValue: canonical,
    };
    expect(ruleGraphVariableDeclarationSchema.safeParse(variable).success).toBe(false);
    expect(ruleGraphVariableDeclarationSchema.safeParse({ ...variable, columns }).success).toBe(
      true,
    );
    expect(
      sourceRuleGraphVariableDeclarationSchema.safeParse({
        id: "rows",
        key: "rows",
        type: "table",
        columns,
        default_value: canonical,
      }).success,
    ).toBe(true);
    expect(
      ruleGraphTypedValueSchema.safeParse({ type: "text", value: "hello", columns }).success,
    ).toBe(false);
  });
});
