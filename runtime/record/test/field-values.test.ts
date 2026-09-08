import {
  fieldDefinitionSchema,
  moduleFieldV2Schema,
  recordTypeDefinitionV2Schema,
  type ModuleFieldV2,
  type RecordTypeDefinitionV2,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { persistedRecordFieldValueMatches, prepareRecordFieldValuesV2 } from "../src";

const id = (value: number) => `70000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

const field = (
  fieldId: string,
  key: string,
  type: ModuleFieldV2["type"],
  settings: unknown,
  options: { required?: boolean; default?: unknown } = {},
): ModuleFieldV2 =>
  moduleFieldV2Schema.parse({
    fieldId,
    key,
    label: key,
    required: options.required ?? false,
    unique: false,
    filterable: true,
    sortable: true,
    personalData: "none",
    publicDisplay: "allowed",
    type,
    settings,
    ...(Object.prototype.hasOwnProperty.call(options, "default")
      ? { default: options.default }
      : {}),
  });

const fieldIds = {
  text: id(1),
  longText: id(2),
  formatted: id(3),
  whole: id(4),
  decimal: id(5),
  money: id(6),
  yesNo: id(7),
  date: id(8),
  dateTime: id(9),
  choice: id(10),
  several: id(11),
  reference: id(12),
  email: id(13),
  phone: id(14),
  web: id(15),
  table: id(16),
  link: id(17),
  multiLink: id(18),
  person: id(19),
  calculation: id(20),
  total: id(21),
  attachment: id(22),
} as const;

const permissionId = id(101);
const targetRecordTypeId = id(102);
const otherRecordTypeId = id(103);
const moduleRootId = id(104);
const fileId = id(105);
const richFileId = id(106);
const organizationAccountId = id(107);
const generatedFieldTypesForTest = new Set<ModuleFieldV2["type"]>([
  "reference_number",
  "calculation",
  "total",
]);

const fields = (): ModuleFieldV2[] => [
  field(fieldIds.text, "title", "text", { maxLength: 40 }, { required: true, default: "Untitled" }),
  field(fieldIds.longText, "notes", "long_text", { maxLength: 200 }),
  field(fieldIds.formatted, "formatted", "formatted_text", {
    allowedBlocks: ["paragraph", "heading", "list", "table", "link", "attachment"],
    maxLength: 200,
  }),
  field(fieldIds.whole, "quantity", "whole_number", { minimum: 1, maximum: 21, step: 5 }),
  field(fieldIds.decimal, "exact", "decimal_number", {
    digitsBeforeDecimal: 30,
    decimalPlaces: 4,
    minimum: "-100000000000000000000000000000",
    maximum: "999999999999999999999999999999.9999",
  }),
  field(
    fieldIds.money,
    "price",
    "money",
    {
      currencyMode: "fixed",
      currency: "NZD",
      minimum: "0",
      maximum: "1000",
    },
    { default: "12.34" },
  ),
  field(fieldIds.yesNo, "active", "yes_no", {}),
  field(fieldIds.date, "due_date", "date", { earliest: "2026-01-01", latest: "2026-12-31" }),
  field(fieldIds.dateTime, "due_at", "date_time", { displayTimeZone: "organization" }),
  field(fieldIds.choice, "state", "choice", {
    options: [
      { value: "open", label: "Open" },
      { value: "closed", label: "Closed", requiredPermissionId: permissionId },
    ],
  }),
  field(fieldIds.several, "tags", "several_choices", {
    options: [
      { value: "ordinary", label: "Ordinary" },
      { value: "restricted", label: "Restricted", requiredPermissionId: permissionId },
    ],
    maximumSelections: 2,
  }),
  field(fieldIds.reference, "number", "reference_number", { digits: 8 }),
  field(fieldIds.email, "email", "email_address", {}),
  field(fieldIds.phone, "phone", "phone_number", { defaultCountry: "NZ" }),
  field(fieldIds.web, "website", "web_address", { allowedSchemes: ["https"] }),
  field(fieldIds.table, "lines", "table", {
    minimumRows: 0,
    maximumRows: 3,
    columns: [
      { key: "description", required: true, type: "text", settings: { maxLength: 30 } },
      { key: "units", required: true, type: "whole_number", settings: { minimum: 0, step: 2 } },
      {
        key: "ratio",
        required: false,
        type: "decimal_number",
        settings: { digitsBeforeDecimal: 20, decimalPlaces: 3 },
      },
      {
        key: "amount",
        required: true,
        type: "money",
        settings: { currencyMode: "fixed", currency: "NZD", minimum: "0" },
      },
      { key: "approved", required: false, type: "yes_no", settings: {} },
      { key: "date", required: false, type: "date", settings: { earliest: "2026-01-01" } },
      { key: "at", required: false, type: "date_time", settings: {} },
      {
        key: "kind",
        required: true,
        type: "choice",
        settings: {
          options: [
            { value: "standard", label: "Standard" },
            { value: "special", label: "Special", requiredPermissionId: permissionId },
          ],
        },
      },
    ],
  }),
  field(fieldIds.link, "parent", "link", {
    target: { state: "resolved", moduleRootId, recordTypeId: targetRecordTypeId },
    reverseKey: "children",
    onParentDelete: "refuse",
  }),
  field(fieldIds.multiLink, "related", "link_to_one_of_several", {
    targets: [
      { state: "resolved", moduleRootId, recordTypeId: targetRecordTypeId },
      { state: "resolved", moduleRootId, recordTypeId: otherRecordTypeId },
    ],
    onParentDelete: "empty_optional",
  }),
  field(fieldIds.person, "owner", "link_to_person", {
    audience: "application_accounts",
    applicationRootIdRequired: true,
    onPersonDeactivation: "retain_reference",
  }),
  field(fieldIds.calculation, "calculated", "calculation", {
    resultType: "decimal_number",
    expression: {
      kind: "numeric",
      operation: "add",
      operands: [
        { source: "field", fieldId: fieldIds.decimal },
        { source: "literal", value: "1" },
      ],
    },
    dependencyFieldIds: [fieldIds.decimal],
  }),
  field(fieldIds.total, "total", "total", {
    relationshipId: id(108),
    operation: "sum",
    resultType: "money",
    fieldId: fieldIds.money,
    currency: "NZD",
  }),
  field(fieldIds.attachment, "files", "attachment", {
    allowedKinds: ["document"],
    maxFileSizeMb: 20,
    multiple: true,
    maxFiles: 3,
  }),
];

const recordType = (overrides: Partial<RecordTypeDefinitionV2> = {}): RecordTypeDefinitionV2 =>
  recordTypeDefinitionV2Schema.parse({
    recordTypeId: id(900),
    key: "test_record",
    singularLabel: "Test record",
    pluralLabel: "Test records",
    titleFieldId: fieldIds.text,
    storageContractId: id(901),
    storageScope: "organization_shared",
    ownershipMode: "none",
    fields: fields(),
    relationships: [],
    standardActions: ["create", "read", "update"],
    customActionIds: [],
    ...overrides,
  });

const validSubmittedValues = () => ({
  [fieldIds.text]: "Exact values",
  [fieldIds.longText]: "Notes",
  [fieldIds.formatted]: {
    blocks: [
      { kind: "paragraph", children: [{ kind: "text", text: "A description" }] },
      { kind: "file", fileId: richFileId },
    ],
  },
  [fieldIds.whole]: 11,
  [fieldIds.decimal]: "900719925474099312345.1200",
  [fieldIds.money]: { amount: "15.5000", currency: "NZD" },
  [fieldIds.yesNo]: true,
  [fieldIds.date]: "2026-08-01",
  [fieldIds.dateTime]: "2026-08-01T12:00:00+12:00",
  [fieldIds.choice]: "closed",
  [fieldIds.several]: ["ordinary", "restricted"],
  [fieldIds.email]: "person@example.test",
  [fieldIds.phone]: "+64 21 555 0100",
  [fieldIds.web]: "https://example.test/path",
  [fieldIds.table]: [
    {
      description: "Line one",
      units: 4,
      ratio: "1.2500",
      amount: { amount: "20.5000", currency: "NZD" },
      approved: false,
      date: "2026-08-02",
      at: "2026-08-02T09:00:00+12:00",
      kind: "special",
    },
  ],
  [fieldIds.link]: { recordTypeId: targetRecordTypeId, recordId: id(201) },
  [fieldIds.multiLink]: { recordTypeId: otherRecordTypeId, recordId: id(202) },
  [fieldIds.person]: { organizationAccountId },
  [fieldIds.attachment]: [fileId],
});

const update = (submittedValues: Readonly<Record<string, unknown>>, existingValues = {}) =>
  prepareRecordFieldValuesV2({
    operation: "update",
    recordType: recordType(),
    submittedValues,
    existingValues: { [fieldIds.text]: "Existing", ...existingValues },
  });

describe("prepareRecordFieldValuesV2", () => {
  it("prepares every writable V2 field, normalizes exact amounts and emits closed pending checks", () => {
    const result = prepareRecordFieldValuesV2({
      operation: "create",
      recordType: recordType(),
      submittedValues: validSubmittedValues(),
    });
    expect(result).toMatchObject({
      success: true,
      clearFieldIds: [],
      setValues: {
        [fieldIds.decimal]: "900719925474099312345.12",
        [fieldIds.money]: { amount: "15.5", currency: "NZD" },
        [fieldIds.table]: [
          expect.objectContaining({ ratio: "1.25", amount: { amount: "20.5", currency: "NZD" } }),
        ],
      },
    });
    if (!result.success) return;
    expect(Object.keys(result.setValues)).toHaveLength(19);
    expect(result.pendingChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "choice_permission", permissionId }),
        expect.objectContaining({
          kind: "record_reference",
          recordTypeId: targetRecordTypeId,
          recordId: id(201),
        }),
        expect.objectContaining({
          kind: "person_reference",
          organizationAccountId,
          audience: "application_accounts",
          applicationRootIdRequired: true,
        }),
        expect.objectContaining({ kind: "file_reference", fileId }),
        expect.objectContaining({
          kind: "file_reference",
          fileId: richFileId,
          path: ["submittedValues", fieldIds.formatted, "blocks", 1, "fileId"],
        }),
      ]),
    );
    expect(result.pendingChecks.filter((check) => check.kind === "choice_permission")).toHaveLength(
      3,
    );
    expect(result.pendingChecks.filter((check) => check.kind === "record_reference")).toHaveLength(
      2,
    );
  });

  it("applies defaults only on create and expands fixed money and table money defaults", () => {
    const configured = recordType({
      fields: fields().map((candidate) =>
        candidate.fieldId === fieldIds.table
          ? moduleFieldV2Schema.parse({
              ...candidate,
              default: [
                {
                  description: "Default line",
                  units: 2,
                  amount: "9.5",
                  kind: "standard",
                },
              ],
            })
          : candidate,
      ),
    });
    const created = prepareRecordFieldValuesV2({
      operation: "create",
      recordType: configured,
      submittedValues: {},
    });
    expect(created).toMatchObject({
      success: true,
      setValues: {
        [fieldIds.text]: "Untitled",
        [fieldIds.money]: { amount: "12.34", currency: "NZD" },
        [fieldIds.table]: [
          {
            description: "Default line",
            units: 2,
            amount: { amount: "9.5", currency: "NZD" },
            kind: "standard",
          },
        ],
      },
    });
    const updated = prepareRecordFieldValuesV2({
      operation: "update",
      recordType: configured,
      submittedValues: {},
      existingValues: { [fieldIds.text]: "Existing" },
    });
    expect(updated).toEqual({ success: true, setValues: {}, clearFieldIds: [], pendingChecks: [] });
  });

  it("uses organization currency only for omitted create defaults, including table cells", () => {
    const configured = recordType({
      fields: fields().map((candidate) => {
        if (candidate.fieldId === fieldIds.money)
          return moduleFieldV2Schema.parse({
            ...candidate,
            settings: { currencyMode: "organization_default", minimum: "0" },
            default: "12.34",
          });
        if (candidate.fieldId === fieldIds.table) {
          const table = candidate as Extract<ModuleFieldV2, { type: "table" }>;
          return moduleFieldV2Schema.parse({
            ...table,
            settings: {
              ...table.settings,
              columns: table.settings.columns.map((column) =>
                column.key === "amount"
                  ? { ...column, settings: { currencyMode: "organization_default", minimum: "0" } }
                  : column,
              ),
            },
            default: [{ description: "Default", units: 2, amount: "7", kind: "standard" }],
          });
        }
        return candidate;
      }),
    });
    expect(
      prepareRecordFieldValuesV2({
        operation: "create",
        recordType: configured,
        submittedValues: {},
      }),
    ).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "organization_currency_required" }),
      ]),
    });
    expect(
      prepareRecordFieldValuesV2({
        operation: "create",
        recordType: configured,
        submittedValues: {},
        organizationCurrency: "AUD",
      }),
    ).toMatchObject({
      success: true,
      setValues: {
        [fieldIds.money]: { amount: "12.34", currency: "AUD" },
        [fieldIds.table]: [expect.objectContaining({ amount: { amount: "7", currency: "AUD" } })],
      },
    });
    expect(
      prepareRecordFieldValuesV2({
        operation: "create",
        recordType: configured,
        submittedValues: {
          [fieldIds.money]: { amount: "3.00", currency: "USD" },
          [fieldIds.table]: [
            {
              description: "Explicit",
              units: 2,
              amount: { amount: "4.00", currency: "CAD" },
              kind: "standard",
            },
          ],
        },
      }),
    ).toMatchObject({
      success: true,
      setValues: {
        [fieldIds.money]: { amount: "3", currency: "USD" },
        [fieldIds.table]: [expect.objectContaining({ amount: { amount: "4", currency: "CAD" } })],
      },
    });
  });

  it("preserves update omission, emits optional clears and refuses required clears", () => {
    expect(update({ [fieldIds.longText]: null })).toEqual({
      success: true,
      setValues: {},
      clearFieldIds: [fieldIds.longText],
      pendingChecks: [],
    });
    expect(update({ [fieldIds.text]: null })).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "required_field_clear", fieldId: fieldIds.text }),
      ]),
    });
    expect(
      prepareRecordFieldValuesV2({
        operation: "update",
        recordType: recordType(),
        submittedValues: {},
      }),
    ).toEqual({ success: false, issues: [{ code: "invalid_input", path: ["existingValues"] }] });
  });

  it("treats an optional create null as intentional absence instead of reapplying its default", () => {
    const result = prepareRecordFieldValuesV2({
      operation: "create",
      recordType: recordType(),
      submittedValues: { [fieldIds.money]: null },
    });
    expect(result).toMatchObject({ success: true, setValues: { [fieldIds.text]: "Untitled" } });
    if (result.success) expect(result.setValues).not.toHaveProperty(fieldIds.money);
  });

  it("does not reinterpret schema-valid empty values as clears", () => {
    expect(
      update({
        [fieldIds.longText]: "",
        [fieldIds.formatted]: { blocks: [] },
        [fieldIds.table]: [],
        [fieldIds.attachment]: [],
      }),
    ).toMatchObject({
      success: true,
      clearFieldIds: [],
      setValues: {
        [fieldIds.longText]: "",
        [fieldIds.formatted]: { blocks: [] },
        [fieldIds.table]: [],
        [fieldIds.attachment]: [],
      },
    });
  });

  it("refuses supplied values and nulls for all generated fields", () => {
    for (const [fieldId, value] of [
      [fieldIds.reference, "R-1"],
      [fieldIds.calculation, "2"],
      [fieldIds.total, null],
    ] as const)
      expect(update({ [fieldId]: value })).toMatchObject({
        success: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "generated_field_input", fieldId }),
        ]),
      });
    const generatedRequired = recordType({
      fields: fields().map((candidate) =>
        generatedFieldTypesForTest.has(candidate.type)
          ? moduleFieldV2Schema.parse({ ...candidate, required: true })
          : candidate,
      ),
    });
    expect(
      prepareRecordFieldValuesV2({
        operation: "create",
        recordType: generatedRequired,
        submittedValues: {},
      }),
    ).toMatchObject({ success: true });
  });

  it("uses field IDs as identity and reports unknown keys without echoing values", () => {
    const result = update({ title: "secret-personal-value", [id(999)]: "another-secret" });
    expect(result).toMatchObject({
      success: false,
      issues: [
        { code: "unknown_field", fieldId: "title", path: ["submittedValues", "title"] },
        { code: "unknown_field", fieldId: id(999), path: ["submittedValues", id(999)] },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret-personal-value");
    expect(JSON.stringify(result)).not.toContain("another-secret");
  });

  it.each([
    [fieldIds.text, "x".repeat(41)],
    [fieldIds.longText, 12],
    [fieldIds.formatted, { blocks: [{ kind: "heading", level: "1", children: [] }] }],
    [fieldIds.whole, 12],
    [fieldIds.decimal, "1000000000000000000000000000000"],
    [fieldIds.decimal, "1e3"],
    [fieldIds.money, { amount: "1.00", currency: "USD" }],
    [fieldIds.yesNo, "yes"],
    [fieldIds.date, "2025-12-31"],
    [fieldIds.dateTime, "2026-01-01"],
    [fieldIds.choice, "missing"],
    [fieldIds.several, ["ordinary", "restricted", "ordinary"]],
    [fieldIds.email, "not-an-email"],
    [fieldIds.phone, 123],
    [fieldIds.web, "http://example.test"],
    [fieldIds.link, { recordTypeId: otherRecordTypeId, recordId: id(301) }],
    [fieldIds.multiLink, { recordTypeId: id(302), recordId: id(303) }],
    [fieldIds.person, { organizationAccountId: "not-an-id" }],
    [fieldIds.attachment, [id(401), id(402), id(403), id(404)]],
  ])("refuses values outside the owning settings for %s", (fieldId, value) => {
    expect(update({ [fieldId]: value })).toMatchObject({
      success: false,
      issues: expect.arrayContaining([expect.objectContaining({ fieldId })]),
    });
  });

  it("reuses closed text-format and formatted-block settings", () => {
    const configured = recordType({
      fields: fields().map((candidate) => {
        if (candidate.fieldId === fieldIds.text)
          return moduleFieldV2Schema.parse({
            ...candidate,
            required: false,
            default: undefined,
            settings: { maxLength: 40, format: "uuid" },
          });
        if (candidate.fieldId === fieldIds.formatted)
          return moduleFieldV2Schema.parse({
            ...candidate,
            settings: { allowedBlocks: ["paragraph"], maxLength: 20 },
          });
        return candidate;
      }),
    });
    expect(
      prepareRecordFieldValuesV2({
        operation: "create",
        recordType: configured,
        submittedValues: {
          [fieldIds.text]: id(501),
          [fieldIds.formatted]: {
            blocks: [{ kind: "paragraph", children: [{ kind: "text", text: "Short" }] }],
          },
        },
      }),
    ).toMatchObject({ success: true });
    expect(
      prepareRecordFieldValuesV2({
        operation: "create",
        recordType: configured,
        submittedValues: {
          [fieldIds.text]: "not-a-uuid",
          [fieldIds.formatted]: { blocks: [{ kind: "file", fileId }] },
        },
      }),
    ).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ fieldId: fieldIds.text }),
        expect.objectContaining({ fieldId: fieldIds.formatted }),
      ]),
    });
  });

  it("reports exact table cell paths and treats submitted tables as whole replacements", () => {
    expect(
      update({
        [fieldIds.table]: [
          {
            description: "Line",
            units: 3,
            amount: { amount: "1", currency: "NZD" },
            kind: "standard",
            unknown: true,
          },
        ],
      }),
    ).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["submittedValues", fieldIds.table, 0, "unknown"] }),
        expect.objectContaining({ path: ["submittedValues", fieldIds.table, 0, "units"] }),
      ]),
    });
    expect(
      update(
        {
          [fieldIds.table]: [
            {
              description: "New",
              units: 2,
              amount: { amount: "1", currency: "NZD" },
              kind: "standard",
            },
          ],
        },
        {
          [fieldIds.table]: [
            {
              description: "Old",
              units: 4,
              amount: { amount: "2", currency: "NZD" },
              kind: "standard",
            },
          ],
        },
      ),
    ).toMatchObject({
      success: true,
      setValues: { [fieldIds.table]: [expect.objectContaining({ description: "New" })] },
    });
  });

  it("requires presence after the merged update and refuses an empty required attachment", () => {
    const configured = recordType({
      fields: fields().map((candidate) =>
        candidate.fieldId === fieldIds.attachment
          ? moduleFieldV2Schema.parse({ ...candidate, required: true })
          : candidate,
      ),
    });
    expect(
      prepareRecordFieldValuesV2({
        operation: "create",
        recordType: configured,
        submittedValues: { [fieldIds.attachment]: [] },
      }),
    ).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "required_attachment_empty" }),
      ]),
    });
    expect(
      prepareRecordFieldValuesV2({
        operation: "update",
        recordType: configured,
        submittedValues: {},
        existingValues: { [fieldIds.text]: "Existing", [fieldIds.attachment]: [fileId] },
      }),
    ).toEqual({ success: true, setValues: {}, clearFieldIds: [], pendingChecks: [] });
  });

  it("enforces single attachment cardinality without interpreting one file as a different shape", () => {
    const configured = recordType({
      fields: fields().map((candidate) =>
        candidate.fieldId === fieldIds.attachment
          ? moduleFieldV2Schema.parse({
              ...candidate,
              settings: {
                allowedKinds: ["document"],
                maxFileSizeMb: 20,
                multiple: false,
              },
            })
          : candidate,
      ),
    });
    expect(
      prepareRecordFieldValuesV2({
        operation: "create",
        recordType: configured,
        submittedValues: { [fieldIds.attachment]: [fileId] },
      }),
    ).toMatchObject({
      success: true,
      setValues: { [fieldIds.attachment]: [fileId] },
    });
    expect(
      prepareRecordFieldValuesV2({
        operation: "create",
        recordType: configured,
        submittedValues: { [fieldIds.attachment]: [fileId, richFileId] },
      }),
    ).toMatchObject({
      success: false,
      issues: expect.arrayContaining([expect.objectContaining({ fieldId: fieldIds.attachment })]),
    });
  });

  it("reports a required writable field that is absent after create preparation", () => {
    const configuredFields = fields();
    const title = { ...configuredFields[0] } as Record<string, unknown>;
    delete title.default;
    configuredFields[0] = moduleFieldV2Schema.parse(title);
    const result = prepareRecordFieldValuesV2({
      operation: "create",
      recordType: recordType({ fields: configuredFields }),
      submittedValues: {},
    });
    expect(result).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "required_field_missing", fieldId: fieldIds.text }),
      ]),
    });
  });

  it("refuses malformed or non-normalized canonical existing values", () => {
    expect(
      prepareRecordFieldValuesV2({
        operation: "update",
        recordType: recordType(),
        submittedValues: {},
        existingValues: {
          [fieldIds.text]: "Existing",
          [fieldIds.decimal]: "1.00",
          [fieldIds.money]: { amount: "2.00", currency: "NZD" },
        },
      }),
    ).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_existing_value", fieldId: fieldIds.decimal }),
        expect.objectContaining({ code: "invalid_existing_value", fieldId: fieldIds.money }),
      ]),
    });
  });

  it("lets the submitted patch replace or clear an invalid existing optional value", () => {
    expect(
      prepareRecordFieldValuesV2({
        operation: "update",
        recordType: recordType(),
        submittedValues: { [fieldIds.decimal]: "2.00" },
        existingValues: {
          [fieldIds.text]: "Existing",
          [fieldIds.decimal]: "1.00",
        },
      }),
    ).toMatchObject({
      success: true,
      setValues: { [fieldIds.decimal]: "2" },
    });
    expect(
      prepareRecordFieldValuesV2({
        operation: "update",
        recordType: recordType(),
        submittedValues: { [fieldIds.decimal]: null },
        existingValues: {
          [fieldIds.text]: "Existing",
          [fieldIds.decimal]: "1.00",
        },
      }),
    ).toEqual({
      success: true,
      setValues: {},
      clearFieldIds: [fieldIds.decimal],
      pendingChecks: [],
    });
  });
});

describe("persistedRecordFieldValueMatches", () => {
  it("reuses canonical V2 value and static reference-target semantics", () => {
    const definitions = fields();
    const byId = new Map(definitions.map((candidate) => [candidate.fieldId, candidate]));
    expect(
      persistedRecordFieldValueMatches({
        validationContractVersion: "2.0.0",
        field: byId.get(fieldIds.reference)!,
        value: "00000042",
      }),
    ).toBe(true);
    expect(
      persistedRecordFieldValueMatches({
        validationContractVersion: "2.0.0",
        field: byId.get(fieldIds.attachment)!,
        value: [fileId],
      }),
    ).toBe(true);
    expect(
      persistedRecordFieldValueMatches({
        validationContractVersion: "2.0.0",
        field: byId.get(fieldIds.link)!,
        value: { recordTypeId: otherRecordTypeId, recordId: id(201) },
      }),
    ).toBe(false);
    expect(
      persistedRecordFieldValueMatches({
        validationContractVersion: "2.0.0",
        field: byId.get(fieldIds.decimal)!,
        value: "1.00",
      }),
    ).toBe(false);
  });

  it("checks accepted V1 persisted values against their historical field settings", () => {
    const base = {
      fieldId: id(300),
      key: "historical",
      label: "Historical",
      required: false,
      unique: false,
      filterable: true,
      sortable: true,
      personalData: "none" as const,
      publicDisplay: "refused" as const,
    };
    const text = fieldDefinitionSchema.parse({
      ...base,
      type: "text",
      settings: { maxLength: 3 },
    });
    const whole = fieldDefinitionSchema.parse({
      ...base,
      fieldId: id(301),
      type: "whole_number",
      settings: { minimum: 1, maximum: 9, step: 2 },
    });
    const attachment = fieldDefinitionSchema.parse({
      ...base,
      fieldId: id(302),
      type: "attachment",
      settings: {
        allowedKinds: ["document"],
        maxFileSizeMb: 20,
        multiple: false,
      },
    });
    expect(
      persistedRecordFieldValueMatches({
        validationContractVersion: "1.0.0",
        field: text,
        value: "old",
      }),
    ).toBe(true);
    expect(
      persistedRecordFieldValueMatches({
        validationContractVersion: "1.0.0",
        field: text,
        value: "long",
      }),
    ).toBe(false);
    expect(
      persistedRecordFieldValueMatches({
        validationContractVersion: "1.0.0",
        field: whole,
        value: 4,
      }),
    ).toBe(false);
    expect(
      persistedRecordFieldValueMatches({
        validationContractVersion: "1.0.0",
        field: attachment,
        value: [fileId],
      }),
    ).toBe(true);
  });
});
