import { fieldDefinitionSchema, type ConditionNode, type FieldDefinition } from "@vortex/contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateTypedCondition,
  TypedConditionEvaluationError,
  type TypedConditionEvaluationInput,
} from "../src/typed-condition";

const id = (value: number) => `10000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

const field = (fieldId: string, key: string, type: string, settings: unknown): FieldDefinition =>
  fieldDefinitionSchema.parse({
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
  number: field(id(2), "number_value", "decimal_number", {
    digitsBeforeDecimal: 10,
    decimalPlaces: 2,
  }),
  boolean: field(id(3), "boolean_value", "yes_no", {}),
  date: field(id(4), "date_value", "date", {}),
  dateTime: field(id(5), "date_time_value", "date_time", {}),
  choices: field(id(6), "choice_values", "several_choices", {
    options: [
      { value: "high", label: "High" },
      { value: "low", label: "Low" },
    ],
  }),
  json: field(id(7), "json_value", "table", {
    columns: [{ key: "name", type: "text", required: true }],
    minimumRows: 0,
    maximumRows: 10,
  }),
  record: field(id(8), "record_value", "link", {
    target: { state: "resolved", moduleRootId: id(80), recordTypeId: id(81) },
    reverseKey: "source_records",
    onParentDelete: "refuse",
  }),
  account: field(id(9), "account_value", "link_to_person", {
    audience: "organization_accounts",
    applicationRootIdRequired: false,
    onPersonDeactivation: "retain_reference",
  }),
  calculatedNumber: field(id(10), "calculated_number", "calculation", {
    resultType: "decimal_number",
    expression: {
      kind: "numeric",
      operation: "add",
      operands: [
        { source: "field", fieldId: id(2) },
        { source: "literal", value: 1 },
      ],
    },
    dependencyFieldIds: [id(2)],
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
  selectedFields: readonly FieldDefinition[],
  fieldValues: Readonly<Record<string, unknown>>,
  options: Partial<
    Pick<
      TypedConditionEvaluationInput,
      "declaredFieldIds" | "parameterDeclarations" | "parameterValues"
    >
  > = {},
) =>
  evaluateTypedCondition({
    condition,
    sourceRecordFields: selectedFields,
    declaredFieldIds: options.declaredFieldIds ?? selectedFields.map((entry) => entry.fieldId),
    parameterDeclarations: options.parameterDeclarations ?? [],
    fieldValues,
    parameterValues: options.parameterValues ?? {},
  });

describe("typed conditions", () => {
  it("executes the exact PostgreSQL parity corpus through the shared Rule evaluator", () => {
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

    type ParityField = Readonly<{ fieldId: string; type: string }>;
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
      fields: ParityField[];
      vectors: ParityVector[];
    };
    expect(corpus.vectors).toHaveLength(43);

    const parityField = (entry: ParityField, index: number): FieldDefinition => {
      const settings = (() => {
        switch (entry.type) {
          case "text":
            return { maxLength: 100 };
          case "decimal_number":
            return { digitsBeforeDecimal: 10, decimalPlaces: 6 };
          case "yes_no":
          case "date":
          case "date_time":
            return {};
          case "several_choices":
            return {
              options: [
                { value: "high", label: "High" },
                { value: "low", label: "Low" },
              ],
            };
          case "table":
            return {
              columns: [{ key: "name", type: "text", required: true }],
              minimumRows: 0,
              maximumRows: 10,
            };
          case "link":
            return {
              target: { state: "resolved", moduleRootId: id(80), recordTypeId: id(81) },
              reverseKey: "source_records",
              onParentDelete: "refuse",
            };
          case "link_to_person":
            return {
              audience: "organization_accounts",
              applicationRootIdRequired: false,
              onPersonDeactivation: "retain_reference",
            };
          default:
            throw new Error(`Unsupported parity field type ${entry.type}`);
        }
      })();
      return field(entry.fieldId, `parity_${index}`, entry.type, settings);
    };
    const parityFields = corpus.fields.map(parityField);

    for (const vector of corpus.vectors) {
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
          vector.parameters as TypedConditionEvaluationInput["parameterDeclarations"],
        fieldValues: vector.fieldValues,
        parameterValues,
      } satisfies TypedConditionEvaluationInput;

      if (vector.expected === "error:22023") {
        expect(() => evaluateTypedCondition(input), vector.name).toThrowError(
          TypedConditionEvaluationError,
        );
      } else {
        let actual: boolean;
        try {
          actual = evaluateTypedCondition(input);
        } catch (error) {
          throw new Error(`Shared parity vector ${vector.name} unexpectedly refused`, {
            cause: error,
          });
        }
        expect(actual, vector.name).toBe(vector.expected === "true");
      }
    }
  });

  it("evaluates all twelve operators without coercion", () => {
    const cases = [
      ["equals", fields.text, "alpha", literal("alpha"), true],
      ["not_equals", fields.boolean, true, literal(false), true],
      ["contains", fields.text, "alphabet", literal("pha"), true],
      ["not_contains", fields.text, "alphabet", literal("omega"), true],
      ["contains", fields.choices, ["high", "low"], literal("high"), true],
      ["in", fields.text, "high", literal(["high", "low"]), true],
      ["not_in", fields.text, "medium", literal(["high", "low"]), true],
      ["greater_than", fields.number, 10, literal(2), true],
      ["greater_than_or_equal", fields.number, 10, literal(10), true],
      ["less_than", fields.number, 2, literal(10), true],
      ["less_than_or_equal", fields.number, 10, literal(10), true],
      ["is_empty", fields.text, "", undefined, true],
      ["is_not_empty", fields.text, "value", undefined, true],
    ] as const;
    for (const [operator, selectedField, value, right, expected] of cases)
      expect(
        evaluate(
          comparison(operator, fieldOperand(selectedField.fieldId), right),
          [selectedField],
          { [selectedField.fieldId]: value },
        ),
        operator,
      ).toBe(expected);
  });

  it("uses explicit null and empty semantics", () => {
    const binary = (operator: string, right: unknown) =>
      evaluate(
        comparison(operator, fieldOperand(fields.text.fieldId), literal(right)),
        [fields.text],
        { [fields.text.fieldId]: null },
      );
    expect(binary("equals", null)).toBe(true);
    expect(binary("equals", "")).toBe(false);
    expect(binary("not_equals", "")).toBe(true);
    expect(binary("contains", "a")).toBe(false);
    expect(binary("not_contains", "a")).toBe(true);
    expect(binary("greater_than", "a")).toBe(false);
    expect(
      evaluate(comparison("is_empty", fieldOperand(fields.choices.fieldId)), [fields.choices], {
        [fields.choices.fieldId]: [],
      }),
    ).toBe(false);
  });

  it("compares text, calendar dates and offset date-times deterministically", () => {
    expect(
      evaluate(
        comparison("less_than", fieldOperand(fields.text.fieldId), literal("é")),
        [fields.text],
        { [fields.text.fieldId]: "z" },
      ),
    ).toBe(true);
    expect(
      evaluate(
        comparison("in", fieldOperand(fields.text.fieldId), literal(["2026-09-06"])),
        [fields.text],
        { [fields.text.fieldId]: "2026-09-06" },
      ),
    ).toBe(true);
    expect(
      evaluate(
        comparison("in", fieldOperand(fields.dateTime.fieldId), literal(["2026-09-06T00:00:00Z"])),
        [fields.dateTime],
        { [fields.dateTime.fieldId]: "2026-09-06T12:00:00+12:00" },
      ),
    ).toBe(true);
    expect(
      evaluate(
        comparison("less_than", fieldOperand(fields.date.fieldId), literal("2026-10-01")),
        [fields.date],
        { [fields.date.fieldId]: "2026-09-30" },
      ),
    ).toBe(true);
    expect(
      evaluate(
        comparison(
          "equals",
          fieldOperand(fields.dateTime.fieldId),
          literal("2026-09-06T00:00:00Z"),
        ),
        [fields.dateTime],
        { [fields.dateTime.fieldId]: "2026-09-06T12:00:00+12:00" },
      ),
    ).toBe(true);
    expect(() =>
      evaluate(
        comparison("equals", fieldOperand(fields.date.fieldId), literal("2026-02-30")),
        [fields.date],
        { [fields.date.fieldId]: "2026-02-28" },
      ),
    ).toThrowError("vortex.rule.typed_condition_operator_refused");
  });

  it("uses structural JSON equality and normalized reference identity", () => {
    expect(
      evaluate(
        comparison("equals", fieldOperand(fields.json.fieldId), literal([{ a: 1, b: 2 }])),
        [fields.json],
        { [fields.json.fieldId]: [{ b: 2, a: 1 }] },
      ),
    ).toBe(true);
    expect(
      evaluate(
        comparison("equals", fieldOperand(fields.json.fieldId), literal([2, 1])),
        [fields.json],
        { [fields.json.fieldId]: [1, 2] },
      ),
    ).toBe(false);
    const referenceId = "a0000000-0000-4000-8000-0000000000af";
    const upper = referenceId.toUpperCase();
    expect(upper).not.toBe(referenceId);
    expect(
      evaluate(
        comparison("equals", fieldOperand(fields.account.fieldId), literal(upper)),
        [fields.account],
        { [fields.account.fieldId]: referenceId },
      ),
    ).toBe(true);
  });

  it("normalizes representative field classes from trusted definitions", () => {
    expect(
      evaluate(
        comparison("greater_than", fieldOperand(fields.calculatedNumber.fieldId), literal(9)),
        [fields.calculatedNumber],
        { [fields.calculatedNumber.fieldId]: 10 },
      ),
    ).toBe(true);
    expect(() =>
      evaluate(
        comparison("contains", fieldOperand(fields.json.fieldId), literal("name")),
        [fields.json],
        { [fields.json.fieldId]: [{ name: "A" }] },
      ),
    ).toThrowError("vortex.rule.typed_condition_operator_refused");
    expect(() =>
      evaluate(comparison("in", fieldOperand(fields.json.fieldId), literal([])), [fields.json], {
        [fields.json.fieldId]: [{ name: "A" }],
      }),
    ).toThrowError("vortex.rule.typed_condition_operator_refused");
    expect(() =>
      evaluate(
        comparison("equals", fieldOperand(fields.record.fieldId), literal("not-a-uuid")),
        [fields.record],
        { [fields.record.fieldId]: id(91) },
      ),
    ).toThrowError("vortex.rule.typed_condition_operator_refused");
    expect(() =>
      evaluate(
        comparison("contains", fieldOperand(fields.choices.fieldId), literal("high")),
        [fields.choices],
        { [fields.choices.fieldId]: ["high\0"] },
      ),
    ).toThrowError("vortex.rule.typed_condition_input_refused");
  });

  it("validates the complete tree before applying boolean or negation", () => {
    const valid = comparison("equals", fieldOperand(fields.boolean.fieldId), literal(true));
    const hiddenInvalid = comparison("equals", fieldOperand(id(99)), literal("private"));
    expect(
      evaluate(
        {
          kind: "all",
          conditions: [
            valid,
            {
              kind: "not",
              condition: {
                kind: "any",
                conditions: [comparison("equals", literal(false), literal(true))],
              },
            },
          ],
        },
        [fields.boolean],
        { [fields.boolean.fieldId]: true },
      ),
    ).toBe(true);
    for (const condition of [
      { kind: "any", conditions: [valid, hiddenInvalid] },
      {
        kind: "all",
        conditions: [comparison("equals", literal(false), literal(true)), hiddenInvalid],
      },
      { kind: "not", condition: hiddenInvalid },
    ] as ConditionNode[])
      expect(() =>
        evaluate(condition, [fields.boolean], { [fields.boolean.fieldId]: true }),
      ).toThrowError("vortex.rule.typed_condition_field_refused");
  });

  it("requires exact unique declarations and values", () => {
    const condition = comparison("equals", fieldOperand(fields.text.fieldId), parameter("value"));
    const options = {
      parameterDeclarations: [{ key: "value", type: "text" as const }],
      parameterValues: { value: "alpha" },
    };
    expect(evaluate(condition, [fields.text], { [fields.text.fieldId]: "alpha" }, options)).toBe(
      true,
    );
    expect(() => evaluate(condition, [fields.text], {}, options)).toThrowError(
      "vortex.rule.typed_condition_input_refused",
    );
    expect(() =>
      evaluate(
        condition,
        [fields.text],
        { [fields.text.fieldId]: "alpha", [id(98)]: "extra" },
        options,
      ),
    ).toThrowError("vortex.rule.typed_condition_input_refused");
    expect(() =>
      evaluate(
        condition,
        [fields.text],
        { [fields.text.fieldId]: "alpha" },
        {
          ...options,
          declaredFieldIds: [fields.text.fieldId, fields.text.fieldId],
        },
      ),
    ).toThrowError("vortex.rule.typed_condition_field_refused");
    expect(() =>
      evaluate(
        condition,
        [fields.text],
        { [fields.text.fieldId]: "alpha" },
        {
          parameterDeclarations: [
            { key: "value", type: "text" },
            { key: "value", type: "text" },
          ],
          parameterValues: { value: "alpha" },
        },
      ),
    ).toThrowError("vortex.rule.typed_condition_parameter_refused");
    expect(() =>
      evaluate(
        condition,
        [fields.text],
        { [fields.text.fieldId]: "alpha" },
        {
          ...options,
          parameterValues: { value: 1 },
        },
      ),
    ).toThrowError("vortex.rule.typed_condition_input_refused");
    expect(() =>
      evaluate(
        condition,
        [fields.text],
        { [fields.text.fieldId]: "alpha" },
        {
          ...options,
          parameterValues: {},
        },
      ),
    ).toThrowError("vortex.rule.typed_condition_input_refused");
  });

  it("contains unsupported operators inside a closed Rule error", () => {
    const unsupported = {
      ...comparison("equals", literal(true), literal(true)),
      operator: "execute",
    } as ConditionNode;
    expect(() => evaluate(unsupported, [], {})).toThrowError(TypedConditionEvaluationError);
    expect(() => evaluate(unsupported, [], {})).toThrowError(
      "vortex.rule.typed_condition_operator_refused",
    );
  });

  it("contains malformed input and declaration members inside closed Rule errors", () => {
    expect(() =>
      evaluateTypedCondition(null as unknown as TypedConditionEvaluationInput),
    ).toThrowError("vortex.rule.typed_condition_input_refused");
    expect(() =>
      evaluateTypedCondition({
        sourceRecordFields: [],
      } as unknown as TypedConditionEvaluationInput),
    ).toThrowError("vortex.rule.typed_condition_input_refused");
    expect(() =>
      evaluateTypedCondition({
        condition: comparison("equals", literal(true), literal(true)),
        sourceRecordFields: [],
        declaredFieldIds: [],
        parameterDeclarations: [null],
        fieldValues: {},
        parameterValues: {},
      } as unknown as TypedConditionEvaluationInput),
    ).toThrowError("vortex.rule.typed_condition_parameter_refused");
  });
});
