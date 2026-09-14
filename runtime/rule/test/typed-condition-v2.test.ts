import { moduleFieldV2Schema, type ConditionNode, type ModuleFieldV2 } from "@vortex/contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateTypedConditionV2,
  TypedConditionEvaluationError,
  type TypedConditionEvaluationInputV2,
  type TypedConditionParameterDeclarationV2,
} from "../src";

const id = (value: number) => `20000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

const field = (fieldId: string, key: string, type: string, settings: unknown): ModuleFieldV2 =>
  moduleFieldV2Schema.parse({
    fieldId,
    key,
    label: key,
    required: false,
    unique: false,
    filterable: true,
    sortable: true,
    personalData: "none",
    publicDisplay: "allowed",
    type,
    settings,
  });

const fields = {
  text: field(id(1), "text_value", "text", { maxLength: 100 }),
  whole: field(id(2), "whole_value", "whole_number", {}),
  decimal: field(id(3), "decimal_value", "decimal_number", {
    digitsBeforeDecimal: 30,
    decimalPlaces: 12,
  }),
  money: field(id(4), "money_value", "money", {
    currencyMode: "organization_default",
  }),
  date: field(id(5), "date_value", "date", {}),
  dateTime: field(id(6), "date_time_value", "date_time", {}),
  choices: field(id(7), "choice_values", "several_choices", {
    options: [
      { value: "high", label: "High" },
      { value: "low", label: "Low" },
    ],
  }),
  record: field(id(8), "record_value", "link", {
    target: { state: "resolved", moduleRootId: id(80), recordTypeId: id(81) },
    reverseKey: "source_records",
    onParentDelete: "refuse",
  }),
  person: field(id(9), "person_value", "link_to_person", {
    audience: "organization_accounts",
    applicationRootIdRequired: false,
    onPersonDeactivation: "retain_reference",
  }),
  calculatedDecimal: field(id(10), "calculated_decimal", "calculation", {
    resultType: "decimal_number",
    expression: {
      kind: "numeric",
      operation: "add",
      operands: [
        { source: "field", fieldId: id(3) },
        { source: "literal", value: "1" },
      ],
    },
    dependencyFieldIds: [id(3)],
  }),
  totalMoney: field(id(11), "total_money", "total", {
    relationshipId: id(90),
    operation: "sum",
    resultType: "money",
    fieldId: id(4),
  }),
} as const;

const literal = (value: unknown) => ({ source: "value" as const, value });
const fieldOperand = (fieldId: string) => ({ source: "field" as const, fieldId });
const parameter = (key: string) => ({ source: "parameter" as const, key });
const comparison = (
  operator: string,
  left: ReturnType<typeof literal> | ReturnType<typeof fieldOperand> | ReturnType<typeof parameter>,
  right?:
    ReturnType<typeof literal> | ReturnType<typeof fieldOperand> | ReturnType<typeof parameter>,
) =>
  ({
    kind: "comparison",
    operator,
    left,
    ...(right === undefined ? {} : { right }),
  }) as ConditionNode;

const evaluate = (
  condition: ConditionNode,
  selectedFields: readonly ModuleFieldV2[],
  fieldValues: Readonly<Record<string, unknown>>,
  options: Partial<
    Pick<
      TypedConditionEvaluationInputV2,
      "declaredFieldIds" | "parameterDeclarations" | "parameterValues"
    >
  > = {},
) =>
  evaluateTypedConditionV2({
    condition,
    sourceRecordFields: selectedFields,
    declaredFieldIds: options.declaredFieldIds ?? selectedFields.map((entry) => entry.fieldId),
    parameterDeclarations: options.parameterDeclarations ?? [],
    fieldValues,
    parameterValues: options.parameterValues ?? {},
  });

const parameterOptions = (
  declarations: readonly TypedConditionParameterDeclarationV2[],
  values: Readonly<Record<string, unknown>>,
) => ({ parameterDeclarations: declarations, parameterValues: values });

describe("typed conditions V2", () => {
  it("executes the shared PostgreSQL V2 exact-value parity corpus", () => {
    const sql = readFileSync(
      new URL(
        "../../../supabase/tests/365_permission_saved_condition_parity.test.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const matches = [
      ...sql.matchAll(/\$typed_condition_vectors\$([\s\S]*?)\$typed_condition_vectors\$/g),
    ];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.[1]).toBeDefined();

    type ParityField = Readonly<{ fieldId: string; type: string; settings?: unknown }>;
    type ParityBinding = Readonly<{
      key: string;
      source: "current_organization_account_id" | "literal";
      value?: unknown;
    }>;
    type ParityVector = Readonly<{
      name: string;
      condition: unknown;
      declaredFieldIds: string[];
      fieldValues: Record<string, unknown>;
      parameters: { key: string; type: string }[];
      bindings: ParityBinding[];
      actorId?: string;
      expected: "true" | "false" | "error:22023";
    }>;
    const corpus = JSON.parse(matches[0]![1]!) as {
      v2: {
        sourceContractVersion: string;
        fields: ParityField[];
        vectors: ParityVector[];
      };
    };
    expect(corpus.v2.sourceContractVersion).toBe("2.0.0");
    expect(corpus.v2.vectors).toHaveLength(19);

    const parityField = (entry: ParityField, index: number): ModuleFieldV2 => {
      const settings = (() => {
        switch (entry.type) {
          case "whole_number":
            return {};
          case "decimal_number":
            return { digitsBeforeDecimal: 30, decimalPlaces: 12 };
          case "money":
            return { currencyMode: "organization_default" };
          case "calculation":
            return {
              resultType: "decimal_number",
              expression: {
                kind: "numeric",
                operation: "add",
                operands: [
                  { source: "field", fieldId: "f3650000-0000-4000-8000-000000000012" },
                  { source: "literal", value: "1" },
                ],
              },
              dependencyFieldIds: ["f3650000-0000-4000-8000-000000000012"],
            };
          case "total":
            return {
              relationshipId: "a3650000-0000-4000-8000-000000000001",
              operation: "sum",
              resultType: "money",
              fieldId: "f3650000-0000-4000-8000-000000000013",
            };
          default:
            throw new Error(`Unsupported V2 parity field type ${entry.type}`);
        }
      })();
      return field(entry.fieldId, `v2_parity_${index}`, entry.type, settings);
    };
    const parityFields = corpus.v2.fields.map(parityField);

    for (const vector of corpus.v2.vectors) {
      const parameterValues = Object.fromEntries(
        vector.bindings.map((binding) => [
          binding.key,
          binding.source === "current_organization_account_id"
            ? (vector.actorId ?? "53650000-0000-4000-8000-000000000001")
            : binding.value,
        ]),
      );
      const input = {
        condition: vector.condition as ConditionNode,
        sourceRecordFields: parityFields,
        declaredFieldIds: vector.declaredFieldIds,
        parameterDeclarations:
          vector.parameters as TypedConditionEvaluationInputV2["parameterDeclarations"],
        fieldValues: vector.fieldValues,
        parameterValues,
      } satisfies TypedConditionEvaluationInputV2;

      if (vector.expected === "error:22023") {
        expect(() => evaluateTypedConditionV2(input), vector.name).toThrowError(
          TypedConditionEvaluationError,
        );
      } else {
        expect(evaluateTypedConditionV2(input), vector.name).toBe(vector.expected === "true");
      }
    }
  });

  it("compares exact decimals above the safe-integer limit across signs and scales", () => {
    const value = "90071992547409931234567890.12";
    expect(
      evaluate(
        comparison(
          "greater_than",
          fieldOperand(fields.decimal.fieldId),
          literal("90071992547409931234567890.119"),
        ),
        [fields.decimal],
        { [fields.decimal.fieldId]: value },
      ),
    ).toBe(true);
    expect(
      evaluate(
        comparison("less_than", fieldOperand(fields.decimal.fieldId), literal("0")),
        [fields.decimal],
        { [fields.decimal.fieldId]: "-0.000000000001" },
      ),
    ).toBe(true);
    expect(
      evaluate(
        comparison(
          "equals",
          fieldOperand(fields.decimal.fieldId),
          fieldOperand(fields.whole.fieldId),
        ),
        [fields.decimal, fields.whole],
        { [fields.decimal.fieldId]: "0", [fields.whole.fieldId]: 0 },
      ),
    ).toBe(true);
  });

  it("keeps numeric-looking text textual", () => {
    expect(
      evaluate(
        comparison("less_than", fieldOperand(fields.text.fieldId), literal("2")),
        [fields.text],
        { [fields.text.fieldId]: "10" },
      ),
    ).toBe(true);
    expect(
      evaluate(
        comparison("equals", fieldOperand(fields.text.fieldId), literal("1.00")),
        [fields.text],
        { [fields.text.fieldId]: "1.00" },
      ),
    ).toBe(true);
  });

  it("lifts whole integers exactly but refuses fractional legacy number parameters", () => {
    const condition = comparison(
      "greater_than",
      fieldOperand(fields.decimal.fieldId),
      parameter("threshold"),
    );
    expect(
      evaluate(
        condition,
        [fields.decimal],
        { [fields.decimal.fieldId]: "2.5" },
        parameterOptions([{ key: "threshold", type: "number" }], { threshold: 2 }),
      ),
    ).toBe(true);
    expect(() =>
      evaluate(
        condition,
        [fields.decimal],
        { [fields.decimal.fieldId]: "2.5" },
        parameterOptions([{ key: "threshold", type: "number" }], { threshold: 1.5 }),
      ),
    ).toThrowError("vortex.rule.typed_condition_operator_refused");
  });

  it("accepts explicit exact-decimal and money parameter declarations", () => {
    const decimal = "90071992547409931234567890.12";
    const money = { amount: "12.34", currency: "NZD" };
    expect(
      evaluate(
        {
          kind: "all",
          conditions: [
            comparison("equals", fieldOperand(fields.decimal.fieldId), parameter("threshold")),
            comparison("equals", fieldOperand(fields.money.fieldId), parameter("budget")),
          ],
        },
        [fields.decimal, fields.money],
        { [fields.decimal.fieldId]: decimal, [fields.money.fieldId]: money },
        parameterOptions(
          [
            { key: "threshold", type: "decimal_number" },
            { key: "budget", type: "money" },
          ],
          { threshold: decimal, budget: money },
        ),
      ),
    ).toBe(true);
  });

  it("interprets literal lists from the typed scalar operand", () => {
    expect(
      evaluate(
        comparison(
          "in",
          fieldOperand(fields.decimal.fieldId),
          literal(["2", "90071992547409931234567890.12"]),
        ),
        [fields.decimal],
        { [fields.decimal.fieldId]: "90071992547409931234567890.12" },
      ),
    ).toBe(true);
    expect(
      evaluate(
        comparison(
          "in",
          fieldOperand(fields.money.fieldId),
          literal([
            { amount: "1", currency: "NZD" },
            { amount: "12.34", currency: "NZD" },
          ]),
        ),
        [fields.money],
        { [fields.money.fieldId]: { amount: "12.34", currency: "NZD" } },
      ),
    ).toBe(true);
  });

  it("compares money amounts only within their explicit currency", () => {
    const money = { amount: "12.34", currency: "NZD" };
    expect(
      evaluate(
        comparison("equals", fieldOperand(fields.money.fieldId), literal(money)),
        [fields.money],
        { [fields.money.fieldId]: money },
      ),
    ).toBe(true);
    expect(
      evaluate(
        comparison(
          "equals",
          fieldOperand(fields.money.fieldId),
          literal({ amount: "12.34", currency: "AUD" }),
        ),
        [fields.money],
        { [fields.money.fieldId]: money },
      ),
    ).toBe(false);

    const crossCurrency = comparison(
      "greater_than",
      fieldOperand(fields.money.fieldId),
      literal({ amount: "1", currency: "AUD" }),
    );
    for (const condition of [
      crossCurrency,
      { kind: "not", condition: crossCurrency } as ConditionNode,
    ])
      expect(() =>
        evaluate(condition, [fields.money], { [fields.money.fieldId]: money }),
      ).toThrowError("vortex.rule.typed_condition_operator_refused");
  });

  it("refuses malformed or non-normalized canonical exact values", () => {
    for (const value of ["1.00", "1e2", "+1", " 1"])
      expect(() =>
        evaluate(
          comparison("equals", fieldOperand(fields.decimal.fieldId), literal("1")),
          [fields.decimal],
          { [fields.decimal.fieldId]: value },
        ),
      ).toThrowError("vortex.rule.typed_condition_input_refused");
    expect(() =>
      evaluate(
        comparison(
          "equals",
          fieldOperand(fields.money.fieldId),
          literal({ amount: "1", currency: "NZD" }),
        ),
        [fields.money],
        { [fields.money.fieldId]: { amount: "1.00", currency: "NZD" } },
      ),
    ).toThrowError("vortex.rule.typed_condition_input_refused");
    expect(() =>
      evaluate(
        comparison("equals", fieldOperand(fields.decimal.fieldId), parameter("value")),
        [fields.decimal],
        { [fields.decimal.fieldId]: "1" },
        parameterOptions([{ key: "value", type: "decimal_number" }], { value: "1.00" }),
      ),
    ).toThrowError("vortex.rule.typed_condition_input_refused");
  });

  it("uses calculation and total result types for exact comparison", () => {
    expect(
      evaluate(
        comparison("greater_than", fieldOperand(fields.calculatedDecimal.fieldId), literal("9.9")),
        [fields.calculatedDecimal],
        { [fields.calculatedDecimal.fieldId]: "10" },
      ),
    ).toBe(true);
    expect(
      evaluate(
        comparison(
          "less_than_or_equal",
          fieldOperand(fields.totalMoney.fieldId),
          literal({ amount: "10", currency: "NZD" }),
        ),
        [fields.totalMoney],
        { [fields.totalMoney.fieldId]: { amount: "9.99", currency: "NZD" } },
      ),
    ).toBe(true);
  });

  it("preserves null, collection, date-time, and typed reference behavior", () => {
    expect(
      evaluate(comparison("is_empty", fieldOperand(fields.decimal.fieldId)), [fields.decimal], {
        [fields.decimal.fieldId]: null,
      }),
    ).toBe(true);
    expect(
      evaluate(
        comparison("contains", fieldOperand(fields.choices.fieldId), literal("high")),
        [fields.choices],
        { [fields.choices.fieldId]: ["high", "low"] },
      ),
    ).toBe(true);
    expect(
      evaluate(
        comparison(
          "equals",
          fieldOperand(fields.dateTime.fieldId),
          literal("2026-09-08T00:00:00Z"),
        ),
        [fields.dateTime],
        { [fields.dateTime.fieldId]: "2026-09-08T12:00:00+12:00" },
      ),
    ).toBe(true);

    const recordId = id(101);
    expect(
      evaluate(
        comparison(
          "equals",
          fieldOperand(fields.record.fieldId),
          literal({ recordTypeId: id(81).toUpperCase(), recordId: recordId.toUpperCase() }),
        ),
        [fields.record],
        { [fields.record.fieldId]: { recordTypeId: id(81), recordId } },
      ),
    ).toBe(true);

    const organizationAccountId = id(102);
    expect(
      evaluate(
        comparison("equals", fieldOperand(fields.person.fieldId), parameter("current_person")),
        [fields.person],
        { [fields.person.fieldId]: { organizationAccountId } },
        parameterOptions([{ key: "current_person", type: "organization_account_reference" }], {
          current_person: organizationAccountId.toUpperCase(),
        }),
      ),
    ).toBe(true);
    expect(() =>
      evaluate(
        comparison("equals", fieldOperand(fields.person.fieldId), parameter("current_person")),
        [fields.person],
        { [fields.person.fieldId]: { organizationAccountId } },
        parameterOptions([{ key: "current_person", type: "organization_account_reference" }], {
          current_person: { organizationAccountId },
        }),
      ),
    ).toThrowError("vortex.rule.typed_condition_input_refused");
  });

  it("validates the full tree before boolean negation or short-circuiting", () => {
    const valid = comparison("equals", fieldOperand(fields.text.fieldId), literal("ok"));
    const invalidMoneyOrder = comparison(
      "less_than",
      fieldOperand(fields.money.fieldId),
      literal({ amount: "2", currency: "AUD" }),
    );
    const condition = {
      kind: "any",
      conditions: [valid, { kind: "not", condition: invalidMoneyOrder }],
    } as ConditionNode;
    expect(() =>
      evaluate(condition, [fields.text, fields.money], {
        [fields.text.fieldId]: "ok",
        [fields.money.fieldId]: { amount: "1", currency: "NZD" },
      }),
    ).toThrowError(TypedConditionEvaluationError);
  });
});
