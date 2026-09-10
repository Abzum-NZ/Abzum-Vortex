import {
  moduleFieldV2Schema,
  recordTypeDefinitionV2Schema,
  type ModuleFieldV2,
  type RecordTypeDefinitionV2,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { evaluateRecordCalculationsV2 } from "../src";

const id = (value: number) => `71000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

const field = (
  fieldId: string,
  key: string,
  type: ModuleFieldV2["type"],
  settings: unknown,
  required = false,
): ModuleFieldV2 =>
  moduleFieldV2Schema.parse({
    fieldId,
    key,
    label: key,
    required,
    unique: false,
    filterable: true,
    sortable: true,
    personalData: "none",
    publicDisplay: "refused",
    type,
    settings,
  });

const ids = {
  title: id(1),
  surname: id(2),
  exact: id(3),
  percentage: id(4),
  whole: id(5),
  money: id(6),
  otherMoney: id(7),
  date: id(8),
  instant: id(9),
  status: id(10),
  total: id(11),
  joined: id(20),
  divided: id(21),
  chained: id(22),
  discounted: id(23),
  condition: id(24),
  shiftedDate: id(25),
  shiftedInstant: id(26),
  deadline: id(27),
} as const;

const calculation = (
  fieldId: string,
  key: string,
  resultType:
    "text" | "whole_number" | "decimal_number" | "money" | "yes_no" | "date" | "date_time",
  expression: unknown,
  dependencyFieldIds: readonly string[],
  options: { decimalPlaces?: number; required?: boolean } = {},
): ModuleFieldV2 =>
  field(
    fieldId,
    key,
    "calculation",
    {
      resultType,
      ...(options.decimalPlaces === undefined ? {} : { decimalPlaces: options.decimalPlaces }),
      expression,
      dependencyFieldIds,
    },
    options.required,
  );

const baseFields = (): ModuleFieldV2[] => [
  field(ids.title, "title", "text", { maxLength: 100 }, true),
  field(ids.surname, "surname", "text", { maxLength: 100 }),
  field(ids.exact, "exact", "decimal_number", { digitsBeforeDecimal: 30, decimalPlaces: 12 }),
  field(ids.percentage, "percentage", "decimal_number", {
    digitsBeforeDecimal: 3,
    decimalPlaces: 4,
    minimum: "0",
    maximum: "100",
  }),
  field(ids.whole, "whole", "whole_number", {}),
  field(ids.money, "money", "money", { currencyMode: "fixed", currency: "NZD" }),
  field(ids.otherMoney, "other_money", "money", { currencyMode: "organization_default" }),
  field(ids.date, "date", "date", {}),
  field(ids.instant, "instant", "date_time", { displayTimeZone: "organization" }),
  field(ids.status, "status", "choice", {
    options: [
      { value: "open", label: "Open" },
      { value: "closed", label: "Closed" },
    ],
  }),
  field(ids.total, "total", "total", {
    relationshipId: id(100),
    operation: "sum",
    resultType: "decimal_number",
    fieldId: ids.exact,
  }),
];

const allCalculationFields = (): ModuleFieldV2[] => [
  calculation(
    ids.joined,
    "joined",
    "text",
    { kind: "join_text", fieldIds: [ids.title, ids.surname], separator: " " },
    [ids.title, ids.surname],
  ),
  calculation(
    ids.divided,
    "divided",
    "decimal_number",
    {
      kind: "numeric",
      operation: "divide",
      operands: [
        { source: "field", fieldId: ids.exact },
        { source: "literal", value: "3" },
      ],
    },
    [ids.exact],
    { decimalPlaces: 2 },
  ),
  calculation(
    ids.chained,
    "chained",
    "decimal_number",
    {
      kind: "numeric",
      operation: "add",
      operands: [
        { source: "field", fieldId: ids.divided },
        { source: "field", fieldId: ids.total },
        { source: "literal", value: "0.005" },
      ],
    },
    [ids.divided, ids.total],
    { decimalPlaces: 2 },
  ),
  calculation(
    ids.discounted,
    "discounted",
    "money",
    {
      kind: "subtract_percentage",
      amountFieldId: ids.money,
      percentageFieldId: ids.percentage,
    },
    [ids.money, ids.percentage],
    { decimalPlaces: 2 },
  ),
  calculation(
    ids.condition,
    "condition",
    "yes_no",
    {
      kind: "condition",
      condition: {
        kind: "comparison",
        operator: "greater_than",
        left: { source: "field", fieldId: ids.exact },
        right: { source: "value", value: "1" },
      },
    },
    [ids.exact],
  ),
  calculation(
    ids.shiftedDate,
    "shifted_date",
    "date",
    {
      kind: "date_offset",
      dateFieldId: ids.date,
      amount: { source: "field", fieldId: ids.whole },
      unit: "months",
    },
    [ids.date, ids.whole],
  ),
  calculation(
    ids.shiftedInstant,
    "shifted_instant",
    "date_time",
    {
      kind: "date_offset",
      dateFieldId: ids.instant,
      amount: { source: "literal", value: "1" },
      unit: "years",
    },
    [ids.instant],
  ),
  calculation(
    ids.deadline,
    "deadline",
    "yes_no",
    {
      kind: "deadline_passed",
      dueFieldId: ids.date,
      statusFieldId: ids.status,
      terminalStatusValues: ["closed"],
    },
    [ids.date, ids.status],
  ),
];

const recordType = (fields: readonly ModuleFieldV2[]): RecordTypeDefinitionV2 =>
  recordTypeDefinitionV2Schema.parse({
    recordTypeId: id(900),
    key: "calculation_record",
    singularLabel: "Calculation record",
    pluralLabel: "Calculation records",
    titleFieldId: ids.title,
    storageContractId: id(901),
    storageScope: "organization_shared",
    ownershipMode: "none",
    fields,
    relationships: [],
    standardActions: ["create", "read", "update"],
    customActionIds: [],
  });

const clock = {
  instant: "2026-02-28T12:00:00.123456Z",
  organizationLocalDate: "2026-02-28",
} as const;

describe("Module V2 record calculations", () => {
  it("evaluates all six forms in dependency order with exact rounding and explicit time", () => {
    const result = evaluateRecordCalculationsV2({
      recordType: recordType([...baseFields(), ...allCalculationFields()]),
      authoritativeFieldValues: {
        [ids.title]: "Ada",
        [ids.surname]: "Lovelace",
        [ids.exact]: "10",
        [ids.percentage]: "12.5",
        [ids.whole]: 1,
        [ids.money]: { amount: "100", currency: "NZD" },
        [ids.date]: "2024-01-31",
        [ids.instant]: "2024-02-29T01:02:03.123456Z",
        [ids.status]: "open",
        [ids.total]: "0.005",
        [ids.divided]: "999",
      },
      clock,
    });

    expect(result).toEqual({
      success: true,
      setValues: {
        [ids.joined]: "Ada Lovelace",
        [ids.divided]: "3.33",
        [ids.chained]: "3.34",
        [ids.discounted]: { amount: "87.5", currency: "NZD" },
        [ids.condition]: true,
        [ids.shiftedDate]: "2024-02-29",
        [ids.shiftedInstant]: "2025-02-28T01:02:03.123456Z",
        [ids.deadline]: true,
      },
      clearFieldIds: [],
    });
  });

  it("rounds half-even once, including negative ties and exact values beyond binary64", () => {
    const fields = [
      ...baseFields(),
      calculation(
        ids.divided,
        "rounded",
        "decimal_number",
        {
          kind: "numeric",
          operation: "add",
          operands: [
            { source: "field", fieldId: ids.exact },
            { source: "literal", value: "0" },
          ],
        },
        [ids.exact],
        { decimalPlaces: 2 },
      ),
    ];
    const run = (exact: string) =>
      evaluateRecordCalculationsV2({
        recordType: recordType(fields),
        authoritativeFieldValues: { [ids.title]: "Exact", [ids.exact]: exact },
        clock,
      });

    expect(run("1.245")).toMatchObject({ success: true, setValues: { [ids.divided]: "1.24" } });
    expect(run("1.255")).toMatchObject({ success: true, setValues: { [ids.divided]: "1.26" } });
    expect(run("-1.245")).toMatchObject({ success: true, setValues: { [ids.divided]: "-1.24" } });
    expect(run("90071992547409931234567890.125")).toMatchObject({
      success: true,
      setValues: { [ids.divided]: "90071992547409931234567890.12" },
    });
  });

  it("preserves money only across the supported dimensions and refuses mixed currencies", () => {
    const added = calculation(
      ids.discounted,
      "money_total",
      "money",
      {
        kind: "numeric",
        operation: "add",
        operands: [
          { source: "field", fieldId: ids.money },
          { source: "field", fieldId: ids.otherMoney },
        ],
      },
      [ids.money, ids.otherMoney],
      { decimalPlaces: 2 },
    );
    const result = evaluateRecordCalculationsV2({
      recordType: recordType([...baseFields(), added]),
      authoritativeFieldValues: {
        [ids.title]: "Currencies",
        [ids.money]: { amount: "10", currency: "NZD" },
        [ids.otherMoney]: { amount: "5", currency: "AUD" },
      },
      clock,
    });
    expect(result).toEqual({
      success: false,
      issues: [
        expect.objectContaining({ code: "money_dimension_mismatch", fieldId: ids.discounted }),
      ],
    });

    const multiplied = calculation(
      ids.discounted,
      "money_product",
      "money",
      {
        kind: "numeric",
        operation: "multiply",
        operands: [
          { source: "field", fieldId: ids.exact },
          { source: "field", fieldId: ids.money },
        ],
      },
      [ids.exact, ids.money],
      { decimalPlaces: 2 },
    );
    expect(
      evaluateRecordCalculationsV2({
        recordType: recordType([...baseFields(), multiplied]),
        authoritativeFieldValues: {
          [ids.title]: "Product",
          [ids.exact]: "2",
          [ids.money]: { amount: "10", currency: "NZD" },
        },
        clock,
      }),
    ).toMatchObject({
      success: true,
      setValues: { [ids.discounted]: { amount: "20", currency: "NZD" } },
    });

    const invalidDivision = calculation(
      ids.divided,
      "invalid_money_division",
      "decimal_number",
      {
        kind: "numeric",
        operation: "divide",
        operands: [
          { source: "field", fieldId: ids.exact },
          { source: "field", fieldId: ids.money },
        ],
      },
      [ids.exact, ids.money],
      { decimalPlaces: 2 },
    );
    expect(
      evaluateRecordCalculationsV2({
        recordType: recordType([...baseFields(), invalidDivision]),
        authoritativeFieldValues: {
          [ids.title]: "Invalid quotient",
          [ids.exact]: "2",
          [ids.money]: { amount: "10", currency: "NZD" },
        },
        clock,
      }),
    ).toMatchObject({
      success: false,
      issues: [{ code: "money_dimension_mismatch" }],
    });
  });

  it("returns deterministic absence for optional results and refuses missing required results", () => {
    const optional = calculation(
      ids.joined,
      "optional_join",
      "text",
      { kind: "join_text", fieldIds: [ids.title, ids.surname], separator: " " },
      [ids.title, ids.surname],
    );
    const optionalResult = evaluateRecordCalculationsV2({
      recordType: recordType([...baseFields(), optional]),
      authoritativeFieldValues: { [ids.title]: "Ada" },
      clock,
    });
    expect(optionalResult).toEqual({ success: true, setValues: {}, clearFieldIds: [ids.joined] });

    const optionalNumeric = allCalculationFields().find(
      (candidate) => candidate.fieldId === ids.divided,
    )!;
    expect(
      evaluateRecordCalculationsV2({
        recordType: recordType([...baseFields(), optionalNumeric]),
        authoritativeFieldValues: { [ids.title]: "Missing exact" },
        clock,
      }),
    ).toEqual({ success: true, setValues: {}, clearFieldIds: [ids.divided] });

    const required = moduleFieldV2Schema.parse({ ...optional, required: true });
    expect(
      evaluateRecordCalculationsV2({
        recordType: recordType([...baseFields(), required]),
        authoritativeFieldValues: { [ids.title]: "Ada" },
        clock,
      }),
    ).toEqual({
      success: false,
      issues: [expect.objectContaining({ code: "required_result_missing", fieldId: ids.joined })],
    });
  });

  it("refuses division by zero, fractional whole results and missing precision", () => {
    const divided = (resultType: "whole_number" | "decimal_number", decimalPlaces?: number) =>
      calculation(
        ids.divided,
        "divided",
        resultType,
        {
          kind: "numeric",
          operation: "divide",
          operands: [
            { source: "field", fieldId: ids.whole },
            { source: "literal", value: decimalPlaces === 1 ? "0" : "3" },
          ],
        },
        [ids.whole],
        { ...(decimalPlaces === undefined ? {} : { decimalPlaces }) },
      );
    const run = (candidate: ModuleFieldV2) =>
      evaluateRecordCalculationsV2({
        recordType: recordType([...baseFields(), candidate]),
        authoritativeFieldValues: { [ids.title]: "Division", [ids.whole]: 1 },
        clock,
      });
    expect(run(divided("whole_number"))).toMatchObject({
      success: false,
      issues: [{ code: "non_integral_whole_number" }],
    });
    expect(run(divided("decimal_number", 1))).toMatchObject({
      success: false,
      issues: [{ code: "division_by_zero" }],
    });
    expect(run(divided("decimal_number"))).toMatchObject({
      success: false,
      issues: [{ code: "execution_ineligible" }],
    });
  });

  it("keeps a date deadline usable through its local due day and terminal status false", () => {
    const deadline = allCalculationFields().find(
      (candidate) => candidate.fieldId === ids.deadline,
    )!;
    const configured = recordType([...baseFields(), deadline]);
    const run = (organizationLocalDate: string, status = "open") =>
      evaluateRecordCalculationsV2({
        recordType: configured,
        authoritativeFieldValues: {
          [ids.title]: "Deadline",
          [ids.date]: "2026-02-28",
          [ids.status]: status,
        },
        clock: { ...clock, organizationLocalDate },
      });
    expect(run("2026-02-28")).toMatchObject({
      success: true,
      setValues: { [ids.deadline]: false },
    });
    expect(run("2026-03-01")).toMatchObject({
      success: true,
      setValues: { [ids.deadline]: true },
    });
    expect(run("2026-03-01", "closed")).toMatchObject({
      success: true,
      setValues: { [ids.deadline]: false },
    });

    const instantDeadline = calculation(
      ids.deadline,
      "instant_deadline",
      "yes_no",
      {
        kind: "deadline_passed",
        dueFieldId: ids.instant,
        terminalStatusValues: [],
      },
      [ids.instant],
    );
    const instantRecord = recordType([...baseFields(), instantDeadline]);
    const instantRun = (instant: string) =>
      evaluateRecordCalculationsV2({
        recordType: instantRecord,
        authoritativeFieldValues: {
          [ids.title]: "Instant deadline",
          [ids.instant]: "2026-02-28T12:00:00.123456Z",
        },
        clock: { instant, organizationLocalDate: "2026-02-28" },
      });
    expect(instantRun("2026-02-28T12:00:00.123455Z")).toMatchObject({
      success: true,
      setValues: { [ids.deadline]: false },
    });
    expect(instantRun("2026-02-28T12:00:00.123456Z")).toMatchObject({
      success: true,
      setValues: { [ids.deadline]: true },
    });
  });
});
