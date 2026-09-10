import {
  moduleFieldV2Schema,
  recordTypeDefinitionV2Schema,
  type ModuleFieldV2,
  type RecordTypeDefinitionV2,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { evaluateRecordTotalsV2 } from "../src";

const id = (value: number) => `72000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

const ids = {
  module: id(1),
  sourceRecord: id(2),
  sourceStorage: id(3),
  targetRecord: id(4),
  targetStorage: id(5),
  relationship: id(6),
  sourceTitle: id(7),
  link: id(8),
  targetTitle: id(9),
  decimal: id(10),
  whole: id(11),
  money: id(12),
  text: id(13),
  date: id(14),
  dateTime: id(15),
  yesNo: id(16),
  category: id(17),
} as const;

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

const sourceFields = (): ModuleFieldV2[] => [
  field(ids.sourceTitle, "source_title", "text", { maxLength: 100 }, true),
  field(ids.link, "parent", "link", {
    target: { state: "resolved", moduleRootId: ids.module, recordTypeId: ids.targetRecord },
    reverseKey: "children",
    onParentDelete: "refuse",
  }),
  field(ids.decimal, "exact", "decimal_number", {
    digitsBeforeDecimal: 30,
    decimalPlaces: 12,
  }),
  field(ids.whole, "whole", "whole_number", {}),
  field(ids.money, "money", "money", { currencyMode: "organization_default" }),
  field(ids.text, "text", "text", { maxLength: 100 }),
  field(ids.date, "date", "date", {}),
  field(ids.dateTime, "date_time", "date_time", { displayTimeZone: "organization" }),
  field(ids.yesNo, "yes_no", "yes_no", {}),
  field(ids.category, "category", "text", { maxLength: 20 }),
];

const sourceRecordType = (): RecordTypeDefinitionV2 =>
  recordTypeDefinitionV2Schema.parse({
    recordTypeId: ids.sourceRecord,
    key: "source_record",
    singularLabel: "Source record",
    pluralLabel: "Source records",
    titleFieldId: ids.sourceTitle,
    storageContractId: ids.sourceStorage,
    storageScope: "organization_shared",
    ownershipMode: "none",
    fields: sourceFields(),
    relationships: [
      {
        relationshipId: ids.relationship,
        key: "parent",
        fromRecordTypeId: ids.sourceRecord,
        fromFieldId: ids.link,
        toRecordType: {
          state: "resolved",
          moduleRootId: ids.module,
          recordTypeId: ids.targetRecord,
        },
        cardinality: "many_to_one",
        onParentDelete: "refuse",
      },
    ],
    standardActions: ["create", "read", "update"],
    customActionIds: [],
  });

const total = (
  value: number,
  operation: "count" | "sum" | "minimum" | "maximum" | "average",
  resultType:
    "text" | "whole_number" | "decimal_number" | "money" | "yes_no" | "date" | "date_time",
  sourceFieldId?: string,
  options: Readonly<{
    required?: boolean;
    currency?: string;
    decimalPlaces?: number;
    filter?: unknown;
  }> = {},
): ModuleFieldV2 =>
  field(
    id(100 + value),
    `total_${value}`,
    "total",
    {
      relationshipId: ids.relationship,
      operation,
      resultType,
      ...(sourceFieldId === undefined ? {} : { fieldId: sourceFieldId }),
      ...(options.currency === undefined ? {} : { currency: options.currency }),
      ...(options.decimalPlaces === undefined ? {} : { decimalPlaces: options.decimalPlaces }),
      ...(options.filter === undefined ? {} : { filter: options.filter }),
    },
    options.required,
  );

const targetRecordType = (totals: readonly ModuleFieldV2[]): RecordTypeDefinitionV2 =>
  recordTypeDefinitionV2Schema.parse({
    recordTypeId: ids.targetRecord,
    key: "target_record",
    singularLabel: "Target record",
    pluralLabel: "Target records",
    titleFieldId: ids.targetTitle,
    storageContractId: ids.targetStorage,
    storageScope: "organization_shared",
    ownershipMode: "none",
    fields: [field(ids.targetTitle, "target_title", "text", { maxLength: 100 }, true), ...totals],
    relationships: [],
    standardActions: ["create", "read", "update"],
    customActionIds: [],
  });

const evaluate = (
  totals: readonly ModuleFieldV2[],
  records: readonly Readonly<{ fieldValues: Readonly<Record<string, unknown>> }>[],
) =>
  evaluateRecordTotalsV2({
    recordType: targetRecordType(totals),
    relationshipSources: [
      { relationshipId: ids.relationship, sourceRecordType: sourceRecordType(), records },
    ],
  });

describe("Module V2 relationship totals", () => {
  it("counts filtered related records with Rule V2 null semantics", () => {
    const filter = {
      kind: "comparison",
      operator: "equals",
      left: { source: "field", fieldId: ids.category },
      right: { source: "value", value: "keep" },
    } as const;
    const count = total(1, "count", "whole_number", undefined, {
      filter,
    });
    expect(
      evaluate(
        [count],
        [
          { fieldValues: { [ids.category]: "keep" } },
          { fieldValues: { [ids.category]: "skip" } },
          { fieldValues: {} },
        ],
      ),
    ).toEqual({ success: true, setValues: { [count.fieldId]: 1 }, clearFieldIds: [] });

    const sum = total(25, "sum", "decimal_number", ids.decimal, {
      filter,
    });
    expect(
      evaluate(
        [sum],
        [
          { fieldValues: { [ids.category]: "keep", [ids.decimal]: "1" } },
          { fieldValues: { [ids.category]: "skip", [ids.decimal]: "not-a-decimal" } },
        ],
      ),
    ).toEqual({ success: true, setValues: { [sum.fieldId]: "1" }, clearFieldIds: [] });
  });

  it("sums exact values and rounds a non-terminating average once", () => {
    const sum = total(2, "sum", "decimal_number", ids.decimal);
    const average = total(3, "average", "decimal_number", ids.decimal, { decimalPlaces: 4 });
    const result = evaluate(
      [sum, average],
      [
        { fieldValues: { [ids.decimal]: "900719925474099312345.12" } },
        { fieldValues: { [ids.decimal]: "0.88" } },
        { fieldValues: { [ids.decimal]: "1" } },
      ],
    );
    expect(result).toEqual({
      success: true,
      setValues: {
        [sum.fieldId]: "900719925474099312347",
        [average.fieldId]: "300239975158033104115.6667",
      },
      clearFieldIds: [],
    });

    const third = total(4, "average", "decimal_number", ids.decimal, { decimalPlaces: 4 });
    expect(
      evaluate(
        [third],
        [
          { fieldValues: { [ids.decimal]: "1" } },
          { fieldValues: { [ids.decimal]: "0" } },
          { fieldValues: { [ids.decimal]: "0" } },
        ],
      ),
    ).toEqual({
      success: true,
      setValues: { [third.fieldId]: "0.3333" },
      clearFieldIds: [],
    });

    const tie = total(24, "average", "decimal_number", ids.decimal, { decimalPlaces: 0 });
    expect(
      evaluate(
        [tie],
        [{ fieldValues: { [ids.decimal]: "1" } }, { fieldValues: { [ids.decimal]: "0" } }],
      ),
    ).toEqual({ success: true, setValues: { [tie.fieldId]: "0" }, clearFieldIds: [] });
  });

  it("orders text by code points and dates, instants and yes/no deterministically", () => {
    const textMinimum = total(5, "minimum", "text", ids.text);
    const textMaximum = total(6, "maximum", "text", ids.text);
    const dateMaximum = total(7, "maximum", "date", ids.date);
    const instantMinimum = total(8, "minimum", "date_time", ids.dateTime);
    const booleanMinimum = total(9, "minimum", "yes_no", ids.yesNo);
    const booleanMaximum = total(10, "maximum", "yes_no", ids.yesNo);
    expect(
      evaluate(
        [textMinimum, textMaximum, dateMaximum, instantMinimum, booleanMinimum, booleanMaximum],
        [
          {
            fieldValues: {
              [ids.text]: "\u{1f600}",
              [ids.date]: "2026-01-01",
              [ids.dateTime]: "2026-01-01T00:30:00+01:00",
              [ids.yesNo]: true,
            },
          },
          {
            fieldValues: {
              [ids.text]: "\ue000",
              [ids.date]: "2026-12-31",
              [ids.dateTime]: "2026-01-01T00:00:00Z",
              [ids.yesNo]: false,
            },
          },
        ],
      ),
    ).toEqual({
      success: true,
      setValues: {
        [textMinimum.fieldId]: "\ue000",
        [textMaximum.fieldId]: "\u{1f600}",
        [dateMaximum.fieldId]: "2026-12-31",
        [instantMinimum.fieldId]: "2026-01-01T00:30:00+01:00",
        [booleanMinimum.fieldId]: false,
        [booleanMaximum.fieldId]: true,
      },
      clearFieldIds: [],
    });

    const equivalentInstantMaximum = total(26, "maximum", "date_time", ids.dateTime);
    const equivalentInstantRows = [
      { fieldValues: { [ids.dateTime]: "2026-01-01T01:00:00+01:00" } },
      { fieldValues: { [ids.dateTime]: "2026-01-01T00:00:00Z" } },
    ];
    const expectedEquivalentInstant = {
      success: true,
      setValues: { [equivalentInstantMaximum.fieldId]: "2026-01-01T01:00:00+01:00" },
      clearFieldIds: [],
    };
    expect(evaluate([equivalentInstantMaximum], equivalentInstantRows)).toEqual(
      expectedEquivalentInstant,
    );
    expect(evaluate([equivalentInstantMaximum], equivalentInstantRows.toReversed())).toEqual(
      expectedEquivalentInstant,
    );
  });

  it("preserves accepted datetime precision beyond microseconds", () => {
    const minimum = total(27, "minimum", "date_time", ids.dateTime);
    const maximum = total(28, "maximum", "date_time", ids.dateTime);
    const earlier = "2026-01-01T01:00:00.1234567+01:00";
    const later = "2026-01-01T00:00:00.1234568Z";
    const rows = [earlier, later].map((value) => ({ fieldValues: { [ids.dateTime]: value } }));
    const expected = {
      success: true,
      setValues: { [minimum.fieldId]: earlier, [maximum.fieldId]: later },
      clearFieldIds: [],
    };
    expect(evaluate([minimum, maximum], rows)).toEqual(expected);
    expect(evaluate([minimum, maximum], rows.toReversed())).toEqual(expected);
  });

  it("preserves one money currency and reports mixed currency only as internal metadata", () => {
    const sum = total(11, "sum", "money", ids.money, { currency: "NZD" });
    const average = total(12, "average", "money", ids.money, { decimalPlaces: 2 });
    const minimum = total(21, "minimum", "money", ids.money);
    expect(
      evaluate(
        [sum, average, minimum],
        [
          { fieldValues: { [ids.money]: { amount: "1.2", currency: "NZD" } } },
          { fieldValues: { [ids.money]: { amount: "2.3", currency: "NZD" } } },
        ],
      ),
    ).toEqual({
      success: true,
      setValues: {
        [sum.fieldId]: { amount: "3.5", currency: "NZD" },
        [average.fieldId]: { amount: "1.75", currency: "NZD" },
        [minimum.fieldId]: { amount: "1.2", currency: "NZD" },
      },
      clearFieldIds: [],
    });

    const mixed = total(13, "sum", "money", ids.money);
    expect(
      evaluate(
        [mixed],
        [
          { fieldValues: { [ids.money]: { amount: "1", currency: "NZD" } } },
          { fieldValues: { [ids.money]: { amount: "2", currency: "AUD" } } },
        ],
      ),
    ).toEqual({
      success: false,
      issues: [
        expect.objectContaining({
          code: "mixed_currency",
          fieldId: mixed.fieldId,
          currencyCodes: ["AUD", "NZD"],
        }),
      ],
    });
  });

  it("uses the specified empty and missing-value meanings", () => {
    const count = total(14, "count", "whole_number");
    const decimalSum = total(15, "sum", "decimal_number", ids.decimal);
    const moneySum = total(16, "sum", "money", ids.money, { currency: "NZD" });
    const minimum = total(17, "minimum", "decimal_number", ids.decimal);
    const implicitMoneySum = total(22, "sum", "money", ids.money);
    expect(evaluate([count], [])).toEqual({
      success: true,
      setValues: { [count.fieldId]: 0 },
      clearFieldIds: [],
    });
    expect(
      evaluate([count, decimalSum, moneySum, minimum, implicitMoneySum], [{ fieldValues: {} }]),
    ).toEqual({
      success: true,
      setValues: {
        [count.fieldId]: 1,
        [decimalSum.fieldId]: "0",
        [moneySum.fieldId]: { amount: "0", currency: "NZD" },
      },
      clearFieldIds: [minimum.fieldId, implicitMoneySum.fieldId],
    });

    const requiredAverage = total(18, "average", "decimal_number", ids.decimal, {
      decimalPlaces: 2,
      required: true,
    });
    expect(evaluate([requiredAverage], [{ fieldValues: { [ids.decimal]: null } }])).toEqual({
      success: false,
      issues: [
        expect.objectContaining({
          code: "required_result_missing",
          fieldId: requiredAverage.fieldId,
        }),
      ],
    });
  });

  it("refuses invalid present values, incompatible currency and unrelated source evidence", () => {
    const sum = total(19, "sum", "decimal_number", ids.decimal);
    expect(evaluate([sum], [{ fieldValues: { [ids.decimal]: "not-a-decimal" } }])).toEqual({
      success: false,
      issues: [expect.objectContaining({ code: "invalid_source_value", fieldId: sum.fieldId })],
    });

    const money = total(20, "sum", "money", ids.money, { currency: "NZD" });
    expect(
      evaluate([money], [{ fieldValues: { [ids.money]: { amount: "1", currency: "AUD" } } }]),
    ).toEqual({
      success: false,
      issues: [
        expect.objectContaining({ code: "money_dimension_mismatch", fieldId: money.fieldId }),
      ],
    });

    const whole = total(23, "sum", "whole_number", ids.whole);
    expect(
      evaluate(
        [whole],
        [
          { fieldValues: { [ids.whole]: Number.MAX_SAFE_INTEGER } },
          { fieldValues: { [ids.whole]: 1 } },
        ],
      ),
    ).toEqual({
      success: false,
      issues: [
        expect.objectContaining({ code: "non_integral_whole_number", fieldId: whole.fieldId }),
      ],
    });

    expect(
      evaluateRecordTotalsV2({
        recordType: targetRecordType([sum]),
        relationshipSources: [],
      }),
    ).toEqual({
      success: false,
      issues: [expect.objectContaining({ code: "invalid_input", path: ["relationshipSources"] })],
    });
  });
});
