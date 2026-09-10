import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  definitionCompilationOutputSchema,
  definitionCompilationRequestSchema,
  definitionResolutionSnapshotV2Schema,
  definitionResolutionSnapshotV3Schema,
  moduleCompilationOutputV3Schema,
  moduleCompilationRequestV3Schema,
  sourceIdentityKindV2Schema,
  sourceIdentityKindV3Schema,
} from "../src/definition-compilation-contracts";
import {
  definitionConsumerReadResultSchema,
  moduleDefinitionConsumerReadResultV3Schema,
} from "../src/definition-consumer-read";
import {
  definitionSourceDocumentSchema,
  moduleSourceDocumentV1Schema,
  moduleSourceDocumentV2Schema,
  moduleSourceDocumentV3Schema,
  moduleSourceDocumentVersionedSchema,
  selectModuleContractPair,
} from "../src/definition-source";
import {
  createModuleRootCommandV3Schema,
  saveModuleDraftCommandV3Schema,
  storedDefinitionDraftSchema,
  storedModuleDefinitionDraftV3Schema,
} from "../src/definition-store-contracts";
import {
  moduleVersionImpactHistoryEntryV3Schema,
  moduleVersionImpactRequestV3Schema,
} from "../src/version-impact";

const fixture = (name: string): unknown =>
  JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, `../../testing/fixtures/${name}`), "utf8"),
  );

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
const timestamp = "2026-09-09T00:00:00Z";

const moduleSourceV1 = fixture("historical/module-v1/modules/crm.tags.json");
const moduleSourceV2 = moduleSourceDocumentV2Schema.parse(fixture("modules/crm.tags.json"));
const sourceGraph = fixture("rule-graphs/before-save-complete.source.json");
const canonicalGraph = fixture("rule-graphs/before-save-complete.canonical.json");
const moduleSourceV3 = moduleSourceDocumentV3Schema.parse({
  ...moduleSourceV2,
  source_contract_version: "3.0.0",
  body: { ...moduleSourceV2.body, rules: [sourceGraph] },
});

const draftMetadata = {
  organizationId: ids.organization,
  draftRevision: 1,
  createdAt: timestamp,
  createdBy: ids.actor,
  updatedAt: timestamp,
  updatedBy: ids.actor,
} as const;

const moduleContentV3 = {
  name: "Shared Rule graph",
  description: "A candidate Module V3 definition.",
  dependencies: [],
  recordTypes: [
    {
      recordTypeId: ids.recordType,
      key: "candidate",
      singularLabel: "Candidate",
      pluralLabel: "Candidates",
      titleFieldId: ids.field,
      storageContractId: ids.storageContract,
      storageScope: "organization_shared",
      ownershipMode: "none",
      fields: [
        {
          fieldId: ids.field,
          key: "amount",
          label: "Amount",
          required: true,
          unique: false,
          filterable: true,
          sortable: true,
          personalData: "none",
          publicDisplay: "refused",
          type: "decimal_number",
          settings: { digitsBeforeDecimal: 30, decimalPlaces: 12 },
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
  rules: [canonicalGraph],
  sharingConditions: [],
  extensionPoints: [],
} as const;

const moduleDraftV3 = {
  envelope: {
    kind: "module",
    rootId: ids.root,
    key: "example.rule_graph",
    ...draftMetadata,
  },
  content: moduleContentV3,
} as const;

const resolutionV3 = {
  contractVersion: "3.0.0",
  fingerprint,
  definitions: [
    {
      kind: "module",
      key: "example.rule_graph",
      rootId: ids.root,
      exactVersion: "1.0.0",
    },
  ],
  identities: [
    {
      definitionKey: "example.rule_graph",
      scope: "rule:prepare_candidate",
      kind: "rule_node",
      componentOwner: "start",
      alias: "start",
      identifier: "80000000-0000-4000-8000-000000000001",
    },
  ],
} as const;

const compilationRequestV3 = {
  sourceContractVersion: "3.0.0",
  validationContractVersion: "3.0.0",
  source: moduleSourceV3,
  resolution: resolutionV3,
  draftMetadata,
} as const;

const compilationOutputV3 = {
  kind: "module",
  validationContractVersion: "3.0.0",
  canonical: moduleDraftV3,
  artifact: {
    kind: "module",
    definitionKey: "example.rule_graph",
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

const historyEntryV3 = {
  publication: {
    kind: "module",
    rootId: ids.root,
    revision: 1,
    releaseVersion: "1.0.0",
    contentFingerprint: fingerprint,
    publishedAt: timestamp,
    publishedBy: ids.actor,
    validationContractVersion: "3.0.0",
  },
  content: moduleContentV3,
  dependencyManifest: [],
  releaseNote: "Initial Module V3 candidate",
} as const;

describe("Module V3 Definition contract plumbing", () => {
  it("selects only exact Module contract pairs while retaining V1 and V2", () => {
    expect(selectModuleContractPair("1.0.0", "1.0.0").schema).toBe("v1");
    expect(selectModuleContractPair("2.0.0", "2.0.0").schema).toBe("v2");
    expect(selectModuleContractPair("3.0.0", "3.0.0").schema).toBe("v3");
    expect(() => selectModuleContractPair("3.0.0", "2.0.0")).toThrow(TypeError);
    expect(moduleSourceDocumentV1Schema.safeParse(moduleSourceV1).success).toBe(true);
    expect(moduleSourceDocumentV2Schema.safeParse(moduleSourceV2).success).toBe(true);
    expect(moduleSourceDocumentV3Schema.safeParse(moduleSourceV3).success).toBe(true);
    expect(moduleSourceDocumentVersionedSchema.safeParse(moduleSourceV3).success).toBe(true);
    expect(definitionSourceDocumentSchema.safeParse(moduleSourceV3).success).toBe(false);
  });

  it("stores V3 drafts with exact source metadata", () => {
    const stored = {
      kind: "module",
      rootId: ids.root,
      key: "vortex.crm.tags",
      sourceContractVersion: "3.0.0",
      sourceFingerprint: fingerprint,
      source: moduleSourceV3,
      ...draftMetadata,
    };
    expect(createModuleRootCommandV3Schema.safeParse({ source: moduleSourceV3 }).success).toBe(
      true,
    );
    expect(
      saveModuleDraftCommandV3Schema.safeParse({
        rootId: ids.root,
        expectedDraftRevision: 1,
        source: moduleSourceV3,
      }).success,
    ).toBe(true);
    expect(storedModuleDefinitionDraftV3Schema.safeParse(stored).success).toBe(true);
    expect(storedDefinitionDraftSchema.safeParse(stored).success).toBe(true);
    expect(
      storedModuleDefinitionDraftV3Schema.safeParse({
        ...stored,
        sourceContractVersion: "2.0.0",
      }).success,
    ).toBe(false);
  });

  it("binds compilation request and output to the 3.0.0 identity snapshot", () => {
    expect(definitionResolutionSnapshotV3Schema.safeParse(resolutionV3).success).toBe(true);
    expect(moduleCompilationRequestV3Schema.safeParse(compilationRequestV3).success).toBe(true);
    expect(
      moduleCompilationRequestV3Schema.safeParse({
        ...compilationRequestV3,
        validationContractVersion: "2.0.0",
      }).success,
    ).toBe(false);
    expect(
      moduleCompilationRequestV3Schema.safeParse({
        ...compilationRequestV3,
        resolution: { ...resolutionV3, contractVersion: "2.0.0" },
      }).success,
    ).toBe(false);
    expect(definitionCompilationRequestSchema.safeParse(compilationRequestV3).success).toBe(false);
    expect(moduleCompilationOutputV3Schema.safeParse(compilationOutputV3).success).toBe(true);
    expect(definitionCompilationOutputSchema.safeParse(compilationOutputV3).success).toBe(true);
    expect(
      moduleCompilationOutputV3Schema.safeParse({
        ...compilationOutputV3,
        validationContractVersion: "2.0.0",
      }).success,
    ).toBe(false);
  });

  it("keeps graph identity kinds exclusive to the V3 snapshot", () => {
    expect(sourceIdentityKindV3Schema.safeParse("rule_node").success).toBe(true);
    expect(sourceIdentityKindV3Schema.safeParse("rule_input").success).toBe(true);
    expect(sourceIdentityKindV3Schema.safeParse("rule_variable").success).toBe(true);
    expect(sourceIdentityKindV2Schema.safeParse("rule_node").success).toBe(false);
    expect(definitionResolutionSnapshotV2Schema.safeParse(resolutionV3).success).toBe(false);
  });

  it("decodes V3 comparison history and consumer reads without relabeling content", () => {
    expect(moduleVersionImpactHistoryEntryV3Schema.safeParse(historyEntryV3).success).toBe(true);
    expect(
      moduleVersionImpactHistoryEntryV3Schema.safeParse({
        ...historyEntryV3,
        publication: { ...historyEntryV3.publication, validationContractVersion: "2.0.0" },
      }).success,
    ).toBe(false);
    expect(
      moduleVersionImpactRequestV3Schema.safeParse({
        kind: "module",
        validationContractVersion: "3.0.0",
        history: [historyEntryV3],
        candidate: moduleDraftV3,
      }).success,
    ).toBe(true);

    const consumer = {
      kind: "module",
      rootId: ids.root,
      organizationId: ids.organization,
      definitionKey: "example.rule_graph",
      releaseRevision: 1,
      releaseVersion: "1.0.0",
      validationContractVersion: "3.0.0",
      contentFingerprint: fingerprint,
      resolutionFingerprint: fingerprint,
      content: moduleContentV3,
      dependencyManifest: [],
      correlationId: ids.correlation,
    } as const;
    expect(moduleDefinitionConsumerReadResultV3Schema.safeParse(consumer).success).toBe(true);
    expect(definitionConsumerReadResultSchema.safeParse(consumer).success).toBe(true);
    expect(
      moduleDefinitionConsumerReadResultV3Schema.safeParse({
        ...consumer,
        validationContractVersion: "2.0.0",
      }).success,
    ).toBe(false);
  });
});
