import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  definitionCompilationOutputSchema,
  definitionCompilationRequestSchema,
  moduleCompilationOutputV2Schema,
  moduleCompilationRequestV2Schema,
} from "../src/definition-compilation-contracts";
import {
  definitionConsumerReadResultSchema,
  moduleDefinitionConsumerReadResultV2Schema,
} from "../src/definition-consumer-read";
import {
  moduleSourceDocumentVersionedSchema,
  moduleSourceDocumentV1Schema,
  moduleSourceDocumentV2Schema,
} from "../src/definition-source";
import {
  createModuleRootCommandV2Schema,
  saveModuleDraftCommandV2Schema,
  storedDefinitionDraftSchema,
  storedModuleDefinitionDraftV2Schema,
} from "../src/definition-store-contracts";
import {
  moduleVersionImpactHistoryEntryV2Schema,
  moduleVersionImpactRequestV2Schema,
} from "../src/version-impact";

const ids = {
  root: "10000000-0000-4000-8000-000000000001",
  organization: "20000000-0000-4000-8000-000000000001",
  actor: "30000000-0000-4000-8000-000000000001",
  recordType: "40000000-0000-4000-8000-000000000001",
  field: "50000000-0000-4000-8000-000000000001",
  storageContract: "60000000-0000-4000-8000-000000000001",
  correlation: "70000000-0000-4000-8000-000000000001",
} as const;
const fingerprint = `sha256:${"a".repeat(64)}`;
const timestamp = "2026-09-08T00:00:00Z";

const moduleSourceV1 = JSON.parse(
  fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../testing/fixtures/historical/module-v1/modules/crm.tags.json",
    ),
    "utf8",
  ),
);
const moduleSourceV2 = JSON.parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, "../../testing/fixtures/modules/crm.tags.json"),
    "utf8",
  ),
);

const draftMetadata = {
  organizationId: ids.organization,
  draftRevision: 1,
  createdAt: timestamp,
  createdBy: ids.actor,
  updatedAt: timestamp,
  updatedBy: ids.actor,
} as const;

const moduleContentV2 = {
  name: "Exact values",
  description: "A Module V2 definition with an exact decimal field.",
  dependencies: [],
  recordTypes: [
    {
      recordTypeId: ids.recordType,
      key: "amount",
      singularLabel: "Amount",
      pluralLabel: "Amounts",
      titleFieldId: ids.field,
      storageContractId: ids.storageContract,
      storageScope: "organization_shared",
      ownershipMode: "none",
      fields: [
        {
          fieldId: ids.field,
          key: "value",
          label: "Value",
          required: true,
          unique: false,
          filterable: true,
          sortable: true,
          personalData: "none",
          publicDisplay: "refused",
          type: "decimal_number",
          settings: {
            digitsBeforeDecimal: 30,
            decimalPlaces: 12,
            minimum: "0.000000000001",
            maximum: "999999999999999999999999999999.999999999999",
          },
          default: "1.25",
        },
      ],
      relationships: [],
      standardActions: ["create", "read"],
      customActionIds: [],
    },
  ],
  permissions: [],
  actions: [],
  events: [],
  rules: [],
  sharingConditions: [],
  extensionPoints: [],
} as const;

const moduleDraftV2 = {
  envelope: {
    kind: "module",
    rootId: ids.root,
    key: "example.exact_values",
    ...draftMetadata,
  },
  content: moduleContentV2,
} as const;

const resolutionV2 = {
  contractVersion: "2.0.0",
  fingerprint,
  definitions: [
    {
      kind: "module",
      key: "example.exact_values",
      rootId: ids.root,
      exactVersion: "1.0.0",
    },
  ],
  identities: [],
} as const;

const compilationRequestV2 = {
  sourceContractVersion: "2.0.0",
  validationContractVersion: "2.0.0",
  source: moduleSourceV2,
  resolution: resolutionV2,
  draftMetadata,
} as const;

const compilationOutputV2 = {
  kind: "module",
  validationContractVersion: "2.0.0",
  canonical: moduleDraftV2,
  artifact: {
    kind: "module",
    definitionKey: "example.exact_values",
    rootId: ids.root,
    exactVersion: "1.0.0",
    contentFingerprint: fingerprint,
    resolutionFingerprint: fingerprint,
  },
  provenance: [],
  dependencyOrder: [],
  resolvedDependencies: [],
  resolutionFingerprint: fingerprint,
} as const;

const historyEntryV2 = {
  publication: {
    kind: "module",
    rootId: ids.root,
    revision: 1,
    releaseVersion: "1.0.0",
    contentFingerprint: fingerprint,
    publishedAt: timestamp,
    publishedBy: ids.actor,
    validationContractVersion: "2.0.0",
  },
  content: moduleContentV2,
  dependencyManifest: [],
  releaseNote: "Initial Module V2 release",
} as const;

describe("Module V2 Definition contract plumbing", () => {
  it("keeps Module V1 source acceptance while storing V2 with exact source metadata", () => {
    expect(moduleSourceDocumentV1Schema.safeParse(moduleSourceV1).success).toBe(true);
    expect(moduleSourceDocumentV2Schema.safeParse(moduleSourceV2).success).toBe(true);
    expect(moduleSourceDocumentVersionedSchema.safeParse(moduleSourceV1).success).toBe(true);
    expect(moduleSourceDocumentVersionedSchema.safeParse(moduleSourceV2).success).toBe(true);

    expect(
      storedDefinitionDraftSchema.safeParse({
        kind: "module",
        rootId: ids.root,
        key: "vortex.crm.tags",
        sourceContractVersion: "2.0.0",
        sourceFingerprint: fingerprint,
        source: moduleSourceV1,
        ...draftMetadata,
      }).success,
    ).toBe(false);

    const storedV2 = {
      kind: "module",
      rootId: ids.root,
      key: "vortex.crm.tags",
      sourceContractVersion: "2.0.0",
      sourceFingerprint: fingerprint,
      source: moduleSourceV2,
      ...draftMetadata,
    };
    expect(createModuleRootCommandV2Schema.safeParse({ source: moduleSourceV2 }).success).toBe(
      true,
    );
    expect(
      saveModuleDraftCommandV2Schema.safeParse({
        rootId: ids.root,
        expectedDraftRevision: 1,
        source: moduleSourceV2,
      }).success,
    ).toBe(true);
    expect(storedModuleDefinitionDraftV2Schema.safeParse(storedV2).success).toBe(true);
    expect(storedDefinitionDraftSchema.safeParse(storedV2).success).toBe(true);
    expect(
      storedModuleDefinitionDraftV2Schema.safeParse({
        ...storedV2,
        sourceContractVersion: "1.0.0",
      }).success,
    ).toBe(false);
  });

  it("couples the Module V2 source, version pair and V2 resolution snapshot", () => {
    expect(
      definitionCompilationRequestSchema.safeParse({
        source: moduleSourceV1,
        resolution: { ...resolutionV2, contractVersion: "1.0.0" },
      }).success,
    ).toBe(true);
    expect(moduleCompilationRequestV2Schema.safeParse(compilationRequestV2).success).toBe(true);
    expect(
      moduleCompilationRequestV2Schema.safeParse({
        ...compilationRequestV2,
        sourceContractVersion: "1.0.0",
      }).success,
    ).toBe(false);
    expect(
      moduleCompilationRequestV2Schema.safeParse({
        ...compilationRequestV2,
        validationContractVersion: "1.0.0",
      }).success,
    ).toBe(false);
    expect(
      moduleCompilationRequestV2Schema.safeParse({
        ...compilationRequestV2,
        resolution: { ...resolutionV2, contractVersion: "1.0.0" },
      }).success,
    ).toBe(false);
    expect(
      moduleCompilationRequestV2Schema.safeParse({
        ...compilationRequestV2,
        source: moduleSourceV1,
      }).success,
    ).toBe(false);
    expect(
      definitionCompilationRequestSchema.safeParse({
        source: moduleSourceV2,
        resolution: { ...resolutionV2, contractVersion: "1.0.0" },
      }).success,
    ).toBe(false);
  });

  it("keeps V2 compilation output and consumer content bound to validation version 2.0.0", () => {
    expect(moduleCompilationOutputV2Schema.safeParse(compilationOutputV2).success).toBe(true);
    expect(definitionCompilationOutputSchema.safeParse(compilationOutputV2).success).toBe(true);
    expect(
      definitionCompilationOutputSchema.safeParse({
        ...compilationOutputV2,
        validationContractVersion: "1.0.0",
      }).success,
    ).toBe(false);

    const consumerResultV2 = {
      kind: "module",
      rootId: ids.root,
      organizationId: ids.organization,
      definitionKey: "example.exact_values",
      releaseRevision: 1,
      releaseVersion: "1.0.0",
      validationContractVersion: "2.0.0",
      contentFingerprint: fingerprint,
      resolutionFingerprint: fingerprint,
      content: moduleContentV2,
      dependencyManifest: [],
      correlationId: ids.correlation,
    } as const;
    expect(moduleDefinitionConsumerReadResultV2Schema.safeParse(consumerResultV2).success).toBe(
      true,
    );
    expect(definitionConsumerReadResultSchema.safeParse(consumerResultV2).success).toBe(true);
    expect(
      definitionConsumerReadResultSchema.safeParse({
        ...consumerResultV2,
        validationContractVersion: "1.0.0",
      }).success,
    ).toBe(false);
  });

  it("accepts exact Module V2 comparison history and refuses mislabeled history", () => {
    expect(moduleVersionImpactHistoryEntryV2Schema.safeParse(historyEntryV2).success).toBe(true);
    expect(
      moduleVersionImpactRequestV2Schema.safeParse({
        kind: "module",
        validationContractVersion: "2.0.0",
        history: [historyEntryV2],
        candidate: moduleDraftV2,
      }).success,
    ).toBe(true);
    expect(
      moduleVersionImpactRequestV2Schema.safeParse({
        kind: "module",
        validationContractVersion: "2.0.0",
        history: [
          {
            ...historyEntryV2,
            publication: {
              ...historyEntryV2.publication,
              validationContractVersion: "1.0.0",
            },
          },
        ],
        candidate: moduleDraftV2,
      }).success,
    ).toBe(false);
  });
});
