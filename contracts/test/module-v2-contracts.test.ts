import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { fieldTypeKeys } from "../src/catalogues.js";
import { richTextDocumentV2Schema } from "../src/rich-text.js";
import {
  attachmentValueV2Schema,
  moduleFieldValueV2Schemas,
  moneyValueV2Schema,
  recordLinkValueV2Schema,
  recordRichTextDocumentV2Schema,
  sourceModuleFieldValueV2Schemas,
  sourceRecordLinkValueV2Schema,
} from "../src/module-field-values-v2.js";
import {
  moduleSourceDocumentV2Schema,
  moduleSourceActionInputV2Schema,
  moduleSourceFieldV2Schema,
  moduleSourceSharingConditionV2Schema,
} from "../src/module-source-contracts-v2.js";
import {
  actionInputDefinitionV2Schema,
  moduleContractVersionPairV2Schema,
  moduleFieldV2Schema,
  savedSharingConditionV2Schema,
} from "../src/module-contracts-v2.js";
import { fieldDefinitionSchema } from "../src/module-contracts.js";
import { actionInputSchema, moduleSourceFieldSchema } from "../src/module-source-contracts.js";

const id = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`;

const sourceBase = (type: string, settings: unknown, defaultValue?: unknown) => ({
  id: `field_${type}`,
  key: `field_${type}`,
  label: type,
  type,
  settings,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
  required: false,
  unique: false,
  filterable: false,
  sortable: false,
  personal_data: "none",
  public_display: "refused",
});

const canonicalBase = (type: string, settings: unknown, defaultValue?: unknown) => ({
  fieldId: id(fieldTypeKeys.indexOf(type as (typeof fieldTypeKeys)[number]) + 1),
  key: `field_${type}`,
  label: type,
  type,
  settings,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
  required: false,
  unique: false,
  filterable: false,
  sortable: false,
  personalData: "none",
  publicDisplay: "refused",
});

const sourceRichText = {
  blocks: [
    { kind: "paragraph", children: [{ kind: "text", text: "Safe text" }] },
    {
      kind: "table",
      rows: [
        {
          cells: [
            {
              children: [
                {
                  kind: "link",
                  address: "https://example.test/help",
                  children: [{ kind: "text", text: "Help" }],
                },
              ],
            },
          ],
        },
      ],
    },
    { kind: "file", fileId: id(90) },
  ],
};

const sourceTableSettings = {
  minimum_rows: 1,
  maximum_rows: 3,
  columns: [
    {
      key: "code",
      type: "text",
      required: true,
      settings: { max_length: 40, format: "uuid" },
    },
    {
      key: "quantity",
      type: "whole_number",
      required: true,
      settings: { minimum: -2, maximum: 10, step: 3 },
    },
    {
      key: "ratio",
      type: "decimal_number",
      required: true,
      settings: {
        digits_before_decimal: 30,
        decimal_places: 2,
        minimum: "-90071992547409931234567890.12",
        maximum: "90071992547409931234567890.12",
      },
    },
    {
      key: "amount",
      type: "money",
      required: true,
      settings: { currency_mode: "organisation_default", minimum: "0" },
    },
    { key: "active", type: "yes_no", required: true, settings: {} },
    { key: "day", type: "date", required: true, settings: { earliest: "2026-01-01" } },
    {
      key: "at",
      type: "date_time",
      required: true,
      settings: { display_time_zone: "organisation" },
    },
    {
      key: "state",
      type: "choice",
      required: true,
      settings: { options: [{ value: "open", label: "Open" }] },
    },
  ],
};

const sourceTableDefault = [
  {
    code: id(91),
    quantity: 1,
    ratio: "90071992547409931234567890.12",
    amount: "12.3400",
    active: true,
    day: "2026-09-08",
    at: "2026-09-08T10:00:00+12:00",
    state: "open",
  },
];

const canonicalTableSettings = {
  minimumRows: 1,
  maximumRows: 3,
  columns: [
    {
      key: "code",
      type: "text",
      required: true,
      settings: { maxLength: 40, format: "uuid" },
    },
    {
      key: "quantity",
      type: "whole_number",
      required: true,
      settings: { minimum: -2, maximum: 10, step: 3 },
    },
    {
      key: "ratio",
      type: "decimal_number",
      required: true,
      settings: {
        digitsBeforeDecimal: 30,
        decimalPlaces: 2,
        minimum: "-90071992547409931234567890.12",
        maximum: "90071992547409931234567890.12",
      },
    },
    {
      key: "amount",
      type: "money",
      required: true,
      settings: { currencyMode: "organization_default", minimum: "0" },
    },
    { key: "active", type: "yes_no", required: true, settings: {} },
    { key: "day", type: "date", required: true, settings: { earliest: "2026-01-01" } },
    {
      key: "at",
      type: "date_time",
      required: true,
      settings: { displayTimeZone: "organization" },
    },
    {
      key: "state",
      type: "choice",
      required: true,
      settings: { options: [{ value: "open", label: "Open" }] },
    },
  ],
};

const canonicalTableDefault = [
  {
    ...sourceTableDefault[0],
    amount: "12.34",
  },
];

const sourceFields = [
  sourceBase("text", { max_length: 100, format: "email_address" }, "person@example.test"),
  sourceBase("long_text", { max_length: 1_000 }, "Notes"),
  sourceBase(
    "formatted_text",
    { allowed_blocks: ["paragraph", "table", "link", "attachment"], max_length: 20 },
    sourceRichText,
  ),
  sourceBase("whole_number", { minimum: -2, maximum: 10, step: 3 }, 1),
  sourceBase(
    "decimal_number",
    {
      digits_before_decimal: 30,
      decimal_places: 2,
      minimum: "-90071992547409931234567890.12",
      maximum: "90071992547409931234567890.12",
    },
    "90071992547409931234567890.12",
  ),
  sourceBase("money", { currency_mode: "organisation_default", minimum: "0" }, "12.3400"),
  sourceBase("yes_no", {}, true),
  sourceBase("date", { earliest: "2026-01-01" }, "2026-09-08"),
  sourceBase("date_time", { display_time_zone: "organisation" }, "2026-09-08T10:00:00+12:00"),
  sourceBase("choice", { options: [{ value: "open", label: "Open" }] }, "open"),
  sourceBase(
    "several_choices",
    { options: [{ value: "open", label: "Open" }], maximum_selections: 1 },
    ["open"],
  ),
  sourceBase("reference_number", { digits: 8 }),
  sourceBase("email_address", {}, "person@example.test"),
  sourceBase("phone_number", { default_country: "NZ" }, "+6495550100"),
  sourceBase("web_address", { allowed_schemes: ["https"] }, "https://example.test"),
  sourceBase("table", sourceTableSettings, sourceTableDefault),
  sourceBase(
    "link",
    {
      target: "vortex.test:item",
      reverse_key: "parents",
      on_parent_delete: "refuse",
    },
    { record_type: "vortex.test:item", record_id: id(100) },
  ),
  sourceBase(
    "link_to_one_of_several",
    {
      targets: ["vortex.test:item", "vortex.test:other"],
      on_parent_delete: "refuse",
    },
    { record_type: "vortex.test:other", record_id: id(101) },
  ),
  sourceBase(
    "link_to_person",
    {
      audience: "organisation_accounts",
      application_root_required: false,
      on_person_deactivation: "retain_reference",
    },
    { organization_account_id: id(102) },
  ),
  sourceBase("calculation", {
    result_type: "decimal_number",
    expression: {
      operation: "numeric",
      numeric_operation: "add",
      operands: [
        { source: "field", field: "quantity" },
        { source: "literal", value: "1.2500" },
      ],
    },
  }),
  sourceBase("total", {
    relationship: "vortex.test:item.children",
    operation: "sum",
    result_type: "decimal_number",
    field: "quantity",
  }),
  sourceBase("attachment", {
    allowed_kinds: ["document"],
    max_file_size_mb: 10,
    multiple: false,
  }),
];

const resolvedTarget = (recordTypeId: string) => ({
  state: "resolved",
  moduleRootId: id(200),
  recordTypeId,
});

const canonicalFields = [
  canonicalBase("text", { maxLength: 100, format: "email_address" }, "person@example.test"),
  canonicalBase("long_text", { maxLength: 1_000 }, "Notes"),
  canonicalBase(
    "formatted_text",
    { allowedBlocks: ["paragraph", "table", "link", "attachment"], maxLength: 20 },
    sourceRichText,
  ),
  canonicalBase("whole_number", { minimum: -2, maximum: 10, step: 3 }, 1),
  canonicalBase(
    "decimal_number",
    {
      digitsBeforeDecimal: 30,
      decimalPlaces: 2,
      minimum: "-90071992547409931234567890.12",
      maximum: "90071992547409931234567890.12",
    },
    "90071992547409931234567890.12",
  ),
  canonicalBase("money", { currencyMode: "organization_default", minimum: "0" }, "12.34"),
  canonicalBase("yes_no", {}, true),
  canonicalBase("date", { earliest: "2026-01-01" }, "2026-09-08"),
  canonicalBase("date_time", { displayTimeZone: "organization" }, "2026-09-08T10:00:00+12:00"),
  canonicalBase("choice", { options: [{ value: "open", label: "Open" }] }, "open"),
  canonicalBase(
    "several_choices",
    { options: [{ value: "open", label: "Open" }], maximumSelections: 1 },
    ["open"],
  ),
  canonicalBase("reference_number", { digits: 8 }),
  canonicalBase("email_address", {}, "person@example.test"),
  canonicalBase("phone_number", { defaultCountry: "NZ" }, "+6495550100"),
  canonicalBase("web_address", { allowedSchemes: ["https"] }, "https://example.test"),
  canonicalBase("table", canonicalTableSettings, canonicalTableDefault),
  canonicalBase(
    "link",
    { target: resolvedTarget(id(201)), reverseKey: "parents", onParentDelete: "refuse" },
    { recordTypeId: id(201), recordId: id(100) },
  ),
  canonicalBase(
    "link_to_one_of_several",
    {
      targets: [resolvedTarget(id(201)), resolvedTarget(id(202))],
      onParentDelete: "refuse",
    },
    { recordTypeId: id(202), recordId: id(101) },
  ),
  canonicalBase(
    "link_to_person",
    {
      audience: "organization_accounts",
      applicationRootIdRequired: false,
      onPersonDeactivation: "retain_reference",
    },
    { organizationAccountId: id(102) },
  ),
  canonicalBase("calculation", {
    resultType: "decimal_number",
    expression: {
      kind: "numeric",
      operation: "add",
      operands: [
        { source: "field", fieldId: id(1) },
        { source: "literal", value: "1.25" },
      ],
    },
    dependencyFieldIds: [id(1)],
  }),
  canonicalBase("total", {
    relationshipId: id(210),
    operation: "sum",
    resultType: "decimal_number",
    fieldId: id(1),
  }),
  canonicalBase("attachment", {
    allowedKinds: ["document"],
    maxFileSizeMb: 10,
    multiple: false,
  }),
];

describe("Module V2 field and value contracts", () => {
  test("defines an exact source/validation version pair without enabling dispatch", () => {
    expect(
      moduleContractVersionPairV2Schema.safeParse({
        sourceContractVersion: "2.0.0",
        validationContractVersion: "2.0.0",
      }).success,
    ).toBe(true);
    expect(
      moduleContractVersionPairV2Schema.safeParse({
        sourceContractVersion: "2.0.0",
        validationContractVersion: "1.0.0",
      }).success,
    ).toBe(false);
  });

  test("covers all twenty-two authored and canonical field types", () => {
    expect(sourceFields.map((field) => field.type)).toEqual(fieldTypeKeys);
    expect(canonicalFields.map((field) => field.type)).toEqual(fieldTypeKeys);
    expect(sourceFields.every((field) => moduleSourceFieldV2Schema.safeParse(field).success)).toBe(
      true,
    );
    expect(canonicalFields.every((field) => moduleFieldV2Schema.safeParse(field).success)).toBe(
      true,
    );
    expect(Object.keys(sourceModuleFieldValueV2Schemas)).toEqual(fieldTypeKeys);
    expect(Object.keys(moduleFieldValueV2Schemas)).toEqual(fieldTypeKeys);
  });

  test("keeps V1 numeric and formatted defaults unchanged while V2 uses exact and structured values", () => {
    const v1Decimal = sourceBase(
      "decimal_number",
      { digits_before_decimal: 4, decimal_places: 2 },
      12.5,
    );
    expect(moduleSourceFieldSchema.safeParse(v1Decimal).success).toBe(true);
    expect(moduleSourceFieldSchema.safeParse({ ...v1Decimal, default: "12.5" }).success).toBe(
      false,
    );
    expect(moduleSourceFieldV2Schema.safeParse({ ...v1Decimal, default: "12.5" }).success).toBe(
      true,
    );
    expect(moduleSourceFieldV2Schema.safeParse(v1Decimal).success).toBe(false);

    const v1Formatted = sourceBase(
      "formatted_text",
      { allowed_blocks: ["paragraph"] },
      "Legacy text",
    );
    expect(moduleSourceFieldSchema.safeParse(v1Formatted).success).toBe(true);
    expect(moduleSourceFieldV2Schema.safeParse(v1Formatted).success).toBe(false);
  });

  test("validates exact decimal bounds, precision and canonical normalization beyond 2^53", () => {
    const field = sourceFields.find((candidate) => candidate.type === "decimal_number")!;
    expect(moduleSourceFieldV2Schema.safeParse(field).success).toBe(true);
    expect(moduleSourceFieldV2Schema.safeParse({ ...field, default: "1e3" }).success).toBe(false);
    expect(moduleSourceFieldV2Schema.safeParse({ ...field, default: "1.234" }).success).toBe(false);
    expect(
      moduleSourceFieldV2Schema.safeParse({
        ...field,
        settings: {
          digits_before_decimal: 30,
          decimal_places: 2,
          minimum: "90071992547409931234567890.13",
          maximum: "90071992547409931234567890.12",
        },
      }).success,
    ).toBe(false);

    const canonical = canonicalFields.find((candidate) => candidate.type === "decimal_number")!;
    expect(moduleFieldV2Schema.safeParse(canonical).success).toBe(true);
    expect(moduleFieldV2Schema.safeParse({ ...canonical, default: "12.3400" }).success).toBe(false);
  });

  test("uses the declared whole-number minimum or zero as the step origin", () => {
    const field = sourceFields.find((candidate) => candidate.type === "whole_number")!;
    expect(moduleSourceFieldV2Schema.safeParse(field).success).toBe(true);
    expect(moduleSourceFieldV2Schema.safeParse({ ...field, default: 0 }).success).toBe(false);
    expect(
      moduleSourceFieldV2Schema.safeParse({
        ...field,
        settings: { maximum: 10, step: 3 },
        default: 3,
      }).success,
    ).toBe(true);
  });

  test("supports fixed and organization-default amount defaults but persists explicit money", () => {
    const organizationDefault = sourceFields.find((candidate) => candidate.type === "money")!;
    expect(moduleSourceFieldV2Schema.safeParse(organizationDefault).success).toBe(true);
    expect(
      moduleSourceFieldV2Schema.safeParse({
        ...organizationDefault,
        settings: { currency_mode: "fixed", currency: "NZD", minimum: "0" },
      }).success,
    ).toBe(true);
    expect(moneyValueV2Schema.safeParse({ amount: "12.34", currency: "NZD" }).success).toBe(true);
    expect(moneyValueV2Schema.safeParse("12.34").success).toBe(false);
    expect(moneyValueV2Schema.safeParse({ amount: "12.3400", currency: "NZD" }).success).toBe(
      false,
    );
    expect(
      sourceModuleFieldValueV2Schemas.money.safeParse({ amount: "12.3400", currency: "NZD" })
        .success,
    ).toBe(true);
    expect(
      moduleFieldValueV2Schemas.money.safeParse({ amount: "12.3400", currency: "NZD" }).success,
    ).toBe(false);
    expect(
      moduleFieldValueV2Schemas.money.safeParse({ amount: "12.34", currency: "NZD" }).success,
    ).toBe(true);
  });

  test("keeps Record table and file blocks out of the Page rich-text whitelist", () => {
    expect(recordRichTextDocumentV2Schema.safeParse(sourceRichText).success).toBe(true);
    expect(richTextDocumentV2Schema.safeParse(sourceRichText).success).toBe(false);

    const field = sourceFields.find((candidate) => candidate.type === "formatted_text")!;
    expect(moduleSourceFieldV2Schema.safeParse(field).success).toBe(true);
    expect(
      moduleSourceFieldV2Schema.safeParse({
        ...field,
        settings: { allowed_blocks: ["paragraph", "table", "attachment"], max_length: 20 },
      }).success,
    ).toBe(false);
  });

  test("checks typed table defaults through their eight column settings", () => {
    expect(moduleSourceFieldV2Schema.safeParse(sourceFields[15]).success).toBe(true);
    expect(moduleFieldV2Schema.safeParse(canonicalFields[15]).success).toBe(true);
    expect(
      moduleSourceFieldV2Schema.safeParse({
        ...sourceFields[15],
        default: [{ ...sourceTableDefault[0], ratio: "1.234" }],
      }).success,
    ).toBe(false);
    expect(
      moduleSourceFieldV2Schema.safeParse({
        ...sourceFields[15],
        default: [{ ...sourceTableDefault[0], amount: { amount: "12.34", currency: "NZD" } }],
      }).success,
    ).toBe(false);
    expect(
      moduleFieldV2Schema.safeParse({
        ...canonicalFields[15],
        default: [{ ...canonicalTableDefault[0], extra: "not declared" }],
      }).success,
    ).toBe(false);
  });

  test("uses explicit authored and canonical record-link shapes and distinct person links", () => {
    const source = { record_type: "vortex.test:item", record_id: id(1) };
    const canonical = { recordTypeId: id(2), recordId: id(1) };
    expect(sourceRecordLinkValueV2Schema.safeParse(source).success).toBe(true);
    expect(sourceRecordLinkValueV2Schema.safeParse(canonical).success).toBe(false);
    expect(recordLinkValueV2Schema.safeParse(canonical).success).toBe(true);
    expect(recordLinkValueV2Schema.safeParse(source).success).toBe(false);

    const link = sourceFields.find((candidate) => candidate.type === "link")!;
    expect(
      moduleSourceFieldV2Schema.safeParse({
        ...link,
        default: { record_type: "vortex.test:other", record_id: id(1) },
      }).success,
    ).toBe(false);
  });

  test("preserves ordered file identifiers in the attachment value contract", () => {
    const files = [id(3), id(1), id(2)];
    expect(attachmentValueV2Schema.parse(files)).toEqual(files);
    expect(attachmentValueV2Schema.safeParse([id(1), "not-an-id"]).success).toBe(false);
  });

  test("requires exact calculation literals", () => {
    const source = sourceFields.find((candidate) => candidate.type === "calculation")!;
    expect(moduleSourceFieldV2Schema.safeParse(source).success).toBe(true);
    const numeric = structuredClone(source) as {
      settings: { expression: { operands: { value?: unknown }[] } };
    };
    const sourceLiteral = numeric.settings.expression.operands[1];
    if (sourceLiteral === undefined) throw new Error("Source literal operand required");
    sourceLiteral.value = 1.25;
    expect(moduleSourceFieldV2Schema.safeParse(numeric).success).toBe(false);

    const canonical = canonicalFields.find((candidate) => candidate.type === "calculation")!;
    const nonCanonical = structuredClone(canonical) as {
      settings: { expression: { operands: { value?: unknown }[] } };
    };
    const canonicalLiteral = nonCanonical.settings.expression.operands[1];
    if (canonicalLiteral === undefined) throw new Error("Canonical literal operand required");
    canonicalLiteral.value = "1.2500";
    expect(moduleFieldV2Schema.safeParse(nonCanonical).success).toBe(false);
  });

  test("adds exact decimal and money action inputs without reinterpreting legacy number", () => {
    const base = { key: "amount", label: "Amount", required: true };
    expect(
      moduleSourceActionInputV2Schema.safeParse({
        ...base,
        type: "number",
        validation: { minimum: 1.25 },
      }).success,
    ).toBe(true);
    expect(
      moduleSourceActionInputV2Schema.safeParse({
        ...base,
        type: "decimal_number",
        validation: { minimum: "1.2500", maximum: "90071992547409931234567890.12" },
      }).success,
    ).toBe(true);
    expect(
      moduleSourceActionInputV2Schema.safeParse({
        ...base,
        type: "money",
        validation: { minimum: 1.25 },
      }).success,
    ).toBe(false);
    expect(
      actionInputDefinitionV2Schema.safeParse({
        ...base,
        type: "decimal_number",
        validation: { minimum: "1.2500" },
      }).success,
    ).toBe(false);

    const formatted = {
      ...base,
      type: "formatted_text",
      validation: { allowed_blocks: ["paragraph", "table"] },
    };
    expect(moduleSourceActionInputV2Schema.safeParse(formatted).success).toBe(true);
    expect(actionInputSchema.safeParse(formatted).success).toBe(false);
  });

  test("adds exact sharing parameters while retaining legacy number parameters", () => {
    const source = {
      id: "condition",
      source_record_type: "item",
      key: "scope",
      parameters: [
        { key: "legacy", type: "number" },
        { key: "ratio", type: "decimal_number" },
        { key: "amount", type: "money" },
      ],
      condition: { field: "ratio", operator: "equals", parameter: "ratio" },
      declared_fields: ["ratio"],
      publication_tests: [
        {
          name: "exact values",
          parameters: {
            legacy: 1.25,
            ratio: "1.2500",
            amount: { amount: "2.5000", currency: "NZD" },
          },
          field_values: { ratio: "1.2500" },
          expected: true,
        },
      ],
    };
    expect(moduleSourceSharingConditionV2Schema.safeParse(source).success).toBe(true);
    const wrongSource = structuredClone(source);
    wrongSource.publication_tests[0]!.parameters.ratio = 1.25 as never;
    expect(moduleSourceSharingConditionV2Schema.safeParse(wrongSource).success).toBe(false);

    const canonical = {
      conditionId: id(220),
      sourceRecordTypeId: id(201),
      key: "scope",
      publishedRevision: 1,
      contractFingerprint: `sha256:${"a".repeat(64)}`,
      parameters: [
        { key: "legacy", type: "number" },
        { key: "ratio", type: "decimal_number" },
        { key: "amount", type: "money" },
      ],
      condition: {
        kind: "comparison",
        operator: "equals",
        left: { source: "field", fieldId: id(5) },
        right: { source: "parameter", key: "ratio" },
      },
      declaredFieldIds: [id(5)],
      publicationTests: [
        {
          name: "exact values",
          parameters: {
            legacy: 1.25,
            ratio: "1.25",
            amount: { amount: "2.5", currency: "NZD" },
          },
          fieldValues: { [id(5)]: "1.25" },
          expected: true,
        },
      ],
    };
    expect(savedSharingConditionV2Schema.safeParse(canonical).success).toBe(true);
    const wrongCanonical = structuredClone(canonical);
    wrongCanonical.publicationTests[0]!.parameters.ratio = "1.2500";
    expect(savedSharingConditionV2Schema.safeParse(wrongCanonical).success).toBe(false);
  });

  test("reuses unchanged V1 Module outer grammar under an explicit V2 source version", async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve(process.cwd(), "testing/fixtures/modules/service-desk.sla.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    fixture.source_contract_version = "2.0.0";
    expect(moduleSourceDocumentV2Schema.safeParse(fixture).success).toBe(true);
  });

  test("keeps canonical V1 decimal defaults numeric", () => {
    const v1 = canonicalBase("decimal_number", { digitsBeforeDecimal: 4, decimalPlaces: 2 }, 12.5);
    expect(fieldDefinitionSchema.safeParse(v1).success).toBe(true);
    expect(fieldDefinitionSchema.safeParse({ ...v1, default: "12.5" }).success).toBe(false);
  });
});
