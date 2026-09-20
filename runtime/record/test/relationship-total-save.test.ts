import {
  moduleFieldV2Schema,
  recordTypeDefinitionV2Schema,
  type ModuleFieldV2,
  type RecordTypeDefinitionV2,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { calculateLockedRelationshipTotalSave } from "../src/relationship-total-save";

const id = (value: number) => `74800000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

const ids = {
  module: id(1),
  recordType: id(2),
  storage: id(3),
  relationship: id(4),
  title: id(5),
  parent: id(6),
  recursiveTotal: id(7),
  moneyRecordType: id(8),
  moneyStorage: id(9),
  moneyTitle: id(10),
  moneyAmount: id(11),
  moneyTotalRecordType: id(12),
  moneyTotalStorage: id(13),
  moneyTotalTitle: id(14),
  moneyTotal: id(15),
  rootRecord: id(20),
  parentRecord: id(21),
  grandparentRecord: id(22),
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

const recursiveType = (): RecordTypeDefinitionV2 =>
  recordTypeDefinitionV2Schema.parse({
    recordTypeId: ids.recordType,
    key: "recursive",
    singularLabel: "Recursive",
    pluralLabel: "Recursive",
    titleFieldId: ids.title,
    storageContractId: ids.storage,
    storageScope: "organization_shared",
    ownershipMode: "none",
    fields: [
      field(ids.title, "title", "text", { maxLength: 100 }, true),
      field(ids.parent, "parent", "link", {
        target: { state: "resolved", moduleRootId: ids.module, recordTypeId: ids.recordType },
        reverseKey: "children",
        onParentDelete: "empty_optional",
      }),
      field(ids.recursiveTotal, "recursive_total", "total", {
        relationshipId: ids.relationship,
        operation: "sum",
        resultType: "decimal_number",
        fieldId: ids.recursiveTotal,
      }),
    ],
    relationships: [
      {
        relationshipId: ids.relationship,
        key: "parent",
        fromRecordTypeId: ids.recordType,
        fromFieldId: ids.parent,
        toRecordType: {
          state: "resolved",
          moduleRootId: ids.module,
          recordTypeId: ids.recordType,
        },
        cardinality: "many_to_one",
        onParentDelete: "empty_optional",
      },
    ],
    standardActions: ["create", "read", "update"],
    customActionIds: [],
  });

const source = (
  type: RecordTypeDefinitionV2,
  records: readonly Readonly<{
    recordKey?: string;
    fieldValues: Readonly<Record<string, unknown>>;
  }>[],
) => [{ relationshipId: ids.relationship, sourceRecordType: type, records }];

const command = {
  contractVersion: "2.0.0" as const,
  commandId: id(30),
  operation: "update" as const,
  recordTypeId: ids.recordType,
  recordId: ids.rootRecord,
  expectedConcurrencyNumber: 1,
  submittedValues: { [ids.title]: "Changed" },
};

describe("locked relationship total save calculation", () => {
  it("evaluates a finite recursive record hierarchy in concrete dependency order", () => {
    const type = recursiveType();
    const result = calculateLockedRelationshipTotalSave({
      command,
      preparation: {
        outcome: "prepared",
        correlationId: id(31),
        readableFieldIds: [ids.title],
        records: [
          {
            recordKey: "root",
            recordId: ids.rootRecord,
            recordType: type,
            concurrencyNumber: 1,
            existingValues: { [ids.title]: "Leaf", [ids.recursiveTotal]: "9" },
            relationshipSources: source(type, []),
          },
          {
            recordKey: "parent",
            recordId: ids.parentRecord,
            recordType: type,
            concurrencyNumber: 4,
            existingValues: { [ids.title]: "Parent", [ids.recursiveTotal]: "9" },
            relationshipSources: source(type, [
              { recordKey: "root", fieldValues: { [ids.recursiveTotal]: "9" } },
            ]),
          },
          {
            recordKey: "grandparent",
            recordId: ids.grandparentRecord,
            recordType: type,
            concurrencyNumber: 7,
            existingValues: { [ids.title]: "Grandparent", [ids.recursiveTotal]: "9" },
            relationshipSources: source(type, [
              { recordKey: "parent", fieldValues: { [ids.recursiveTotal]: "9" } },
            ]),
          },
        ],
      },
      clock: { instant: "2026-09-14T00:00:00.000Z", organizationLocalDate: "2026-09-14" },
    });

    expect(result).toEqual({
      success: true,
      sourceFinalValues: { [ids.title]: "Changed", [ids.recursiveTotal]: "0" },
      creationFinalValues: {},
      parentMutations: [
        {
          recordTypeId: ids.recordType,
          recordId: ids.parentRecord,
          expectedConcurrencyNumber: 4,
          finalValues: { [ids.recursiveTotal]: "0" },
        },
        {
          recordTypeId: ids.recordType,
          recordId: ids.grandparentRecord,
          expectedConcurrencyNumber: 7,
          finalValues: { [ids.recursiveTotal]: "0" },
        },
      ],
      pendingChecks: [],
    });
  });

  it("refuses an actual concrete record and field cycle", () => {
    const type = recursiveType();
    const result = calculateLockedRelationshipTotalSave({
      command,
      preparation: {
        outcome: "prepared",
        correlationId: id(32),
        readableFieldIds: [ids.title],
        records: [
          {
            recordKey: "root",
            recordId: ids.rootRecord,
            recordType: type,
            concurrencyNumber: 1,
            existingValues: { [ids.title]: "Root", [ids.recursiveTotal]: "1" },
            relationshipSources: source(type, [
              { recordKey: "parent", fieldValues: { [ids.recursiveTotal]: "1" } },
            ]),
          },
          {
            recordKey: "parent",
            recordId: ids.parentRecord,
            recordType: type,
            concurrencyNumber: 1,
            existingValues: { [ids.title]: "Parent", [ids.recursiveTotal]: "1" },
            relationshipSources: source(type, [
              { recordKey: "root", fieldValues: { [ids.recursiveTotal]: "1" } },
            ]),
          },
        ],
      },
      clock: { instant: "2026-09-14T00:00:00.000Z", organizationLocalDate: "2026-09-14" },
    });

    expect(result).toEqual({
      success: false,
      issues: [
        expect.objectContaining({
          code: "relationship_total_cycle",
          fieldId: ids.recursiveTotal,
        }),
      ],
    });
  });

  it("keeps mixed-currency detail internal while refusing the save safely", () => {
    const moneySource = recordTypeDefinitionV2Schema.parse({
      recordTypeId: ids.moneyRecordType,
      key: "money_source",
      singularLabel: "Money source",
      pluralLabel: "Money sources",
      titleFieldId: ids.moneyTitle,
      storageContractId: ids.moneyStorage,
      storageScope: "organization_shared",
      ownershipMode: "none",
      fields: [
        field(ids.moneyTitle, "title", "text", { maxLength: 100 }, true),
        field(ids.parent, "parent", "link", {
          target: {
            state: "resolved",
            moduleRootId: ids.module,
            recordTypeId: ids.moneyTotalRecordType,
          },
          reverseKey: "children",
          onParentDelete: "empty_optional",
        }),
        field(ids.moneyAmount, "amount", "money", { currencyMode: "organization_default" }),
      ],
      relationships: [
        {
          relationshipId: ids.relationship,
          key: "parent",
          fromRecordTypeId: ids.moneyRecordType,
          fromFieldId: ids.parent,
          toRecordType: {
            state: "resolved",
            moduleRootId: ids.module,
            recordTypeId: ids.moneyTotalRecordType,
          },
          cardinality: "many_to_one",
          onParentDelete: "empty_optional",
        },
      ],
      standardActions: ["create", "read", "update"],
      customActionIds: [],
    });
    const totalType = recordTypeDefinitionV2Schema.parse({
      recordTypeId: ids.moneyTotalRecordType,
      key: "money_total",
      singularLabel: "Money total",
      pluralLabel: "Money totals",
      titleFieldId: ids.moneyTotalTitle,
      storageContractId: ids.moneyTotalStorage,
      storageScope: "organization_shared",
      ownershipMode: "none",
      fields: [
        field(ids.moneyTotalTitle, "title", "text", { maxLength: 100 }, true),
        field(ids.moneyTotal, "money_total", "total", {
          relationshipId: ids.relationship,
          operation: "sum",
          resultType: "money",
          fieldId: ids.moneyAmount,
        }),
      ],
      relationships: [],
      standardActions: ["create", "read", "update"],
      customActionIds: [],
    });
    const result = calculateLockedRelationshipTotalSave({
      command: {
        ...command,
        recordTypeId: ids.moneyTotalRecordType,
        submittedValues: { [ids.moneyTotalTitle]: "Changed" },
      },
      preparation: {
        outcome: "prepared",
        correlationId: id(33),
        readableFieldIds: [ids.moneyTotalTitle],
        records: [
          {
            recordKey: "root",
            recordType: totalType,
            recordId: ids.rootRecord,
            concurrencyNumber: 1,
            existingValues: { [ids.moneyTotalTitle]: "Total" },
            relationshipSources: [
              {
                relationshipId: ids.relationship,
                sourceRecordType: moneySource,
                records: [
                  { fieldValues: { [ids.moneyAmount]: { amount: "1", currency: "NZD" } } },
                  { fieldValues: { [ids.moneyAmount]: { amount: "2", currency: "AUD" } } },
                ],
              },
            ],
          },
        ],
      },
      clock: { instant: "2026-09-14T00:00:00.000Z", organizationLocalDate: "2026-09-14" },
    });

    expect(result).toEqual({
      success: false,
      issues: [expect.objectContaining({ code: "mixed_currency", fieldId: ids.moneyTotal })],
    });
  });
});
