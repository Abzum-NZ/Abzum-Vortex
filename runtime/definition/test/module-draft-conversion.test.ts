import {
  moduleSourceDocumentV1Schema,
  moduleSourceDocumentV2Schema,
  type ModuleSourceDocumentV1,
} from "@vortex/contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  convertModuleSourceV1ToV2,
  type ModuleDraftConversionResolution,
} from "../src/module-draft-conversion";

const fixtureNames = [
  "crm.activities.json",
  "crm.opportunities.json",
  "crm.organisations.json",
  "crm.people.json",
  "crm.tags.json",
  "service-desk.cases.json",
  "service-desk.knowledge.json",
  "service-desk.sla.json",
] as const;

const fixture = (name: (typeof fixtureNames)[number]): ModuleSourceDocumentV1 =>
  moduleSourceDocumentV1Schema.parse(
    JSON.parse(
      readFileSync(new URL(`../../../testing/fixtures/modules/${name}`, import.meta.url), "utf8"),
    ),
  );

const convertedSource = (
  source: ModuleSourceDocumentV1,
  resolutions: readonly ModuleDraftConversionResolution[] = [],
) => {
  const result = convertModuleSourceV1ToV2(source, resolutions);
  if (!result.success)
    throw new Error(
      result.diagnostics.map((item) => `${item.code}:${item.path.join(".")}`).join("\n"),
    );
  return result.source;
};

describe("Module draft V1 to V2 conversion", () => {
  it.each(fixtureNames)("converts the current editable fixture %s without choices", (name) => {
    const source = fixture(name);
    const before = structuredClone(source);
    const converted = convertedSource(source);

    expect(moduleSourceDocumentV2Schema.safeParse(converted).success).toBe(true);
    expect(source).toEqual(before);
    expect(converted.source_contract_version).toBe("2.0.0");
    expect(converted.body.dependencies).toEqual(source.body.dependencies);
  });

  it("mechanically converts exact settings, defaults, table cells, calculations, and rich text", () => {
    const source = fixture("crm.opportunities.json");
    const record = source.body.record_types.find((entry) => entry.key === "opportunity")!;
    const decimal = record.fields.find((entry) => entry.key === "discount_percent")!;
    const money = record.fields.find((entry) => entry.key === "value")!;
    const table = record.fields.find((entry) => entry.key === "payment_schedule")!;
    if (decimal.type !== "decimal_number" || money.type !== "money" || table.type !== "table")
      throw new Error("Expected conversion fixture field types");

    decimal.settings.minimum = 1e-7;
    decimal.settings.digits_before_decimal = 30;
    delete decimal.settings.maximum;
    decimal.default = 1e21;
    money.settings.minimum = 1e-7;
    money.default = 12.34;
    table.default = [{ milestone: "Deposit", amount: 12.34, due_date: "2026-09-08", paid: false }];
    record.fields.push({
      id: "fld_conversion_exact",
      key: "conversion_exact",
      type: "calculation",
      label: "Conversion exact",
      required: true,
      unique: false,
      filterable: true,
      sortable: true,
      personal_data: "none",
      public_display: "refused",
      settings: {
        result_type: "decimal_number",
        expression: {
          operation: "numeric",
          numeric_operation: "add",
          operands: [
            { source: "field", field: "discount_percent" },
            { source: "literal", value: 1e-7 },
          ],
        },
      },
    });

    const converted = convertedSource(source);
    const convertedRecord = converted.body.record_types.find(
      (entry) => entry.key === "opportunity",
    )!;
    const convertedDecimal = convertedRecord.fields.find(
      (entry) => entry.key === "discount_percent",
    )!;
    const convertedMoney = convertedRecord.fields.find((entry) => entry.key === "value")!;
    const convertedTable = convertedRecord.fields.find(
      (entry) => entry.key === "payment_schedule",
    )!;
    const convertedCalculation = convertedRecord.fields.find(
      (entry) => entry.key === "conversion_exact",
    )!;
    if (
      convertedDecimal.type !== "decimal_number" ||
      convertedMoney.type !== "money" ||
      convertedTable.type !== "table" ||
      convertedCalculation.type !== "calculation" ||
      convertedCalculation.settings.expression.operation !== "numeric"
    )
      throw new Error("Expected converted field types");

    expect(convertedDecimal).toMatchObject({
      settings: { minimum: "0.0000001" },
      default: "1000000000000000000000",
    });
    expect(convertedMoney).toMatchObject({ settings: { minimum: "0.0000001" }, default: "12.34" });
    expect(convertedTable.default).toEqual([
      { milestone: "Deposit", amount: "12.34", due_date: "2026-09-08", paid: false },
    ]);
    expect(convertedCalculation.settings.expression.operands[1]).toEqual({
      source: "literal",
      value: "0.0000001",
    });

    const richSource = fixture("service-desk.cases.json");
    const richRecord = richSource.body.record_types.find((entry) => entry.key === "case")!;
    const richField = richRecord.fields.find((entry) => entry.key === "description")!;
    if (richField.type !== "formatted_text") throw new Error("Expected formatted field");
    richField.default = "Plain legacy content";
    const convertedRich = convertedSource(richSource);
    expect(
      convertedRich.body.record_types
        .find((entry) => entry.key === "case")!
        .fields.find((entry) => entry.key === "description")?.default,
    ).toEqual({
      blocks: [{ kind: "paragraph", children: [{ kind: "text", text: "Plain legacy content" }] }],
    });
  });

  it("requires explicit allowed targets and currencies only for ambiguous record values", () => {
    const activitySource = fixture("crm.activities.json");
    const activityRecord = activitySource.body.record_types.find(
      (entry) => entry.key === "activity",
    )!;
    const regardingIndex = activityRecord.fields.findIndex((entry) => entry.key === "regarding");
    const regarding = activityRecord.fields[regardingIndex]!;
    if (regarding.type !== "link_to_one_of_several")
      throw new Error("Expected polymorphic link field");
    const recordId = "30000000-0000-4000-8000-000000000001";
    regarding.default = recordId;
    const targetPath = [
      "body",
      "record_types",
      activitySource.body.record_types.indexOf(activityRecord),
      "fields",
      regardingIndex,
      "default",
    ] as const;

    const missingTarget = convertModuleSourceV1ToV2(activitySource, []);
    expect(missingTarget).toMatchObject({
      success: false,
      diagnostics: [{ code: "missing_polymorphic_record_target", path: targetPath }],
    });
    const invalidTarget = convertModuleSourceV1ToV2(activitySource, [
      {
        kind: "polymorphic_record_target",
        path: targetPath,
        recordType: "vortex.service_desk.cases:case",
      },
    ]);
    expect(invalidTarget).toMatchObject({
      success: false,
      diagnostics: [{ code: "invalid_polymorphic_record_target", path: targetPath }],
    });
    const convertedActivity = convertedSource(activitySource, [
      {
        kind: "polymorphic_record_target",
        path: targetPath,
        recordType: "vortex.crm.opportunities:opportunity",
      },
    ]);
    expect(
      convertedActivity.body.record_types
        .find((entry) => entry.key === "activity")!
        .fields.find((entry) => entry.key === "regarding")?.default,
    ).toEqual({ record_type: "vortex.crm.opportunities:opportunity", record_id: recordId });

    const moneySource = fixture("crm.opportunities.json");
    const moneyRecord = moneySource.body.record_types.find((entry) => entry.key === "opportunity")!;
    const actionIndex = moneySource.body.actions.length;
    moneySource.body.actions.push({
      ...moneySource.body.actions[0]!,
      id: "act_conversion_money",
      key: "vortex.crm.opportunities.opportunity.convert_money",
      effects: [
        {
          kind: "set_field",
          field: "value",
          value: { source: "literal", value: 12.34 },
        },
      ],
    });
    const sharingIndex = moneySource.body.sharing_conditions.length;
    moneySource.body.sharing_conditions.push({
      id: "share_conversion_money",
      source_record_type: moneyRecord.key,
      key: "conversion_money",
      parameters: [{ key: "legacy_threshold", type: "number" }],
      condition: { field: "value", operator: "greater_than", value: 10 },
      declared_fields: ["value"],
      publication_tests: [
        {
          name: "Converts record money",
          parameters: { legacy_threshold: 1.5 },
          field_values: { value: 12.34 },
          expected: true,
        },
      ],
    });
    const currencyPaths = [
      ["body", "actions", actionIndex, "effects", 0, "value", "value"],
      ["body", "sharing_conditions", sharingIndex, "condition", "value"],
      ["body", "sharing_conditions", sharingIndex, "publication_tests", 0, "field_values", "value"],
    ] as const;
    const missingCurrency = convertModuleSourceV1ToV2(moneySource, []);
    expect(missingCurrency.success).toBe(false);
    if (missingCurrency.success) throw new Error("Expected currency diagnostics");
    expect(
      missingCurrency.diagnostics.filter((item) => item.code === "missing_money_currency"),
    ).toHaveLength(3);

    const resolutions = currencyPaths.map((path): ModuleDraftConversionResolution => ({
      kind: "organisation_default_money_currency",
      path,
      currency: "NZD",
    }));
    const invalidCurrency = convertModuleSourceV1ToV2(moneySource, [
      { ...resolutions[0]!, currency: "nzd" },
      ...resolutions.slice(1),
    ]);
    expect(invalidCurrency).toMatchObject({
      success: false,
      diagnostics: [{ code: "invalid_money_currency", path: currencyPaths[0] }],
    });
    const convertedMoneySource = convertedSource(moneySource, resolutions);
    expect(convertedMoneySource.body.actions[actionIndex]?.effects[0]).toMatchObject({
      value: { source: "literal", value: { amount: "12.34", currency: "NZD" } },
    });
    expect(convertedMoneySource.body.sharing_conditions[sharingIndex]).toMatchObject({
      parameters: [{ key: "legacy_threshold", type: "number" }],
      condition: { value: { amount: "10", currency: "NZD" } },
      publication_tests: [
        {
          parameters: { legacy_threshold: 1.5 },
          field_values: { value: { amount: "12.34", currency: "NZD" } },
        },
      ],
    });
  });

  it("converts declared single-record, person, and ordered attachment values", () => {
    const source = fixture("service-desk.cases.json");
    const record = source.body.record_types.find((entry) => entry.key === "case")!;
    const recordId = "30000000-0000-4000-8000-000000000010";
    const accountId = "30000000-0000-4000-8000-000000000011";
    const fileId = "30000000-0000-4000-8000-000000000012";
    const sharingIndex = source.body.sharing_conditions.length;
    source.body.sharing_conditions.push({
      id: "share_conversion_references",
      source_record_type: record.key,
      key: "conversion_references",
      parameters: [],
      condition: { field: "customer_company", operator: "equals", value: recordId },
      declared_fields: ["customer_company", "owner", "attachments"],
      publication_tests: [
        {
          name: "Converts reference values",
          parameters: {},
          field_values: {
            customer_company: recordId,
            owner: accountId,
            attachments: fileId,
          },
          expected: true,
        },
      ],
    });

    const converted = convertedSource(source);
    expect(converted.body.sharing_conditions[sharingIndex]).toMatchObject({
      condition: {
        value: { record_type: "vortex.crm.organisations:company", record_id: recordId },
      },
      publication_tests: [
        {
          field_values: {
            customer_company: {
              record_type: "vortex.crm.organisations:company",
              record_id: recordId,
            },
            owner: { organization_account_id: accountId },
            attachments: [fileId],
          },
        },
      ],
    });
  });

  it("reports incomplete historical tables, external literal context, and unused resolutions", () => {
    const tableSource = fixture("service-desk.sla.json");
    const tableRecord = tableSource.body.record_types[0]!;
    const tableIndex = tableRecord.fields.findIndex((entry) => entry.type === "table");
    const tableField = tableRecord.fields[tableIndex]!;
    if (tableField.type !== "table") throw new Error("Expected table field");
    tableField.settings.columns[0] = {
      key: tableField.settings.columns[0]!.key,
      type: tableField.settings.columns[0]!.type,
      required: tableField.settings.columns[0]!.required,
    };
    expect(convertModuleSourceV1ToV2(tableSource, [])).toMatchObject({
      success: false,
      diagnostics: [
        {
          code: "missing_table_column_settings",
          path: ["body", "record_types", 0, "fields", tableIndex, "settings", "columns", 0],
        },
      ],
    });

    const externalSource = fixture("crm.tags.json");
    const externalRecord = externalSource.body.record_types[0]!;
    const totalIndex = externalRecord.fields.length;
    externalRecord.fields.push({
      id: "fld_external_total",
      key: "external_total",
      type: "total",
      label: "External total",
      required: true,
      unique: false,
      filterable: true,
      sortable: true,
      personal_data: "none",
      public_display: "refused",
      settings: {
        relationship: "vortex.crm.opportunities:opportunity.tags",
        operation: "sum",
        result_type: "decimal_number",
        field: "discount_percent",
        filter: { field: "discount_percent", operator: "greater_than", value: 10 },
      },
    });
    expect(convertModuleSourceV1ToV2(externalSource, [])).toMatchObject({
      success: false,
      diagnostics: [
        {
          code: "external_field_context_unavailable",
          path: ["body", "record_types", 0, "fields", totalIndex, "settings", "filter"],
        },
      ],
    });

    const unused = convertModuleSourceV1ToV2(fixture("crm.people.json"), [
      {
        kind: "organisation_default_money_currency",
        path: ["body", "record_types", 0, "fields", 0, "default"],
        currency: "NZD",
      },
    ]);
    expect(unused).toMatchObject({
      success: false,
      diagnostics: [{ code: "unrecognized_resolution" }],
    });
  });

  it("returns source-path diagnostics for invalid V1 input without mutation or writes", () => {
    const source = fixture("crm.people.json");
    const invalid = {
      ...source,
      source_contract_version: "9.0.0",
    } as unknown as ModuleSourceDocumentV1;
    const result = convertModuleSourceV1ToV2(invalid, []);
    expect(result).toMatchObject({
      success: false,
      diagnostics: [{ code: "invalid_v1_source", path: ["source_contract_version"] }],
    });
  });
});
