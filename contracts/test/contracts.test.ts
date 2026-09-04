import { describe, expect, test } from "vitest";
import {
  applicationDefinitionEnvelopeSchema,
  builderKeySchema,
  containedComponentReferenceSchema,
  fingerprintSchema,
  moduleDefinitionEnvelopeSchema,
  namespacedKeySchema,
  platformIdSchema,
  publishedDefinitionReferenceSchema,
  recordScopeSchema,
  recordTypeReferenceSchema,
  revisionSchema,
  semanticVersionSchema,
  sourceIdentityAssignmentSchema,
  storageCatalogEntrySchema,
  storageLineageDecisionSchema,
  timestampSchema,
  versionRequirementSchema,
} from "../src";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const fingerprint = (letter = "a") => `sha256:${letter.repeat(64)}`;
const actor = id("99");
const sharedScope = {
  storageScope: "organization_shared",
  organizationId: id("1"),
  moduleRootId: id("2"),
  recordTypeId: id("3"),
  storageContractId: id("4"),
  recordId: id("5"),
} as const;

describe("identifier and definition contracts", () => {
  test.each(["a", "contact_2", "a".repeat(40)])("accepts builder key %s", (key) => {
    expect(builderKeySchema.safeParse(key).success).toBe(true);
  });

  test.each(["", "2contact", "Contact", "contact-name", "a".repeat(41)])(
    "rejects builder key %s",
    (key) => expect(builderKeySchema.safeParse(key).success).toBe(false),
  );

  test("enforces the namespaced-key boundary", () => {
    expect(namespacedKeySchema.safeParse("crm.people").success).toBe(true);
    expect(
      namespacedKeySchema.safeParse(`${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(38)}`)
        .success,
    ).toBe(true);
    expect(namespacedKeySchema.safeParse(`a.${"b".repeat(41)}`).success).toBe(false);
    expect(
      namespacedKeySchema.safeParse(`${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(39)}`)
        .success,
    ).toBe(false);
    expect(namespacedKeySchema.safeParse("abzum.crm__").success).toBe(false);
    expect(namespacedKeySchema.safeParse("abzum..crm").success).toBe(false);
  });

  test.each([
    ["nil identifier", platformIdSchema, "00000000-0000-0000-0000-000000000000"],
    ["malformed identifier", platformIdSchema, "not-an-id"],
    ["zero revision", revisionSchema, 0],
    ["negative revision", revisionSchema, -1],
    ["malformed fingerprint", fingerprintSchema, "sha256:abc"],
    ["timestamp without offset", timestampSchema, "2026-09-02T01:00:00"],
    ["numeric prerelease with a leading zero", semanticVersionSchema, "1.0.0-01"],
  ])("rejects %s", (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  test("versions applications independently and rejects unknown properties", () => {
    const value = {
      kind: "application",
      rootId: id("6"),
      organizationId: id("1"),
      key: "abzum.crm",
      draftRevision: 2,
      publishedRevision: 1,
      createdAt: "2026-09-02T01:00:00+00:00",
      createdBy: actor,
      updatedAt: "2026-09-02T02:00:00+00:00",
      updatedBy: actor,
    };
    expect(applicationDefinitionEnvelopeSchema.safeParse(value).success).toBe(true);
    expect(
      applicationDefinitionEnvelopeSchema.safeParse({ ...value, tableName: "crm" }).success,
    ).toBe(false);
  });

  test("same-named applications in different organizations keep different identities", () => {
    const common = {
      kind: "application",
      key: "abzum.crm",
      draftRevision: 1,
      createdAt: "2026-09-02T01:00:00+00:00",
      createdBy: actor,
      updatedAt: "2026-09-02T01:00:00+00:00",
      updatedBy: actor,
    } as const;
    const first = applicationDefinitionEnvelopeSchema.parse({
      ...common,
      rootId: id("6"),
      organizationId: id("1"),
    });
    const second = applicationDefinitionEnvelopeSchema.parse({
      ...common,
      rootId: id("7"),
      organizationId: id("2"),
    });
    expect(first.key).toBe(second.key);
    expect(first.rootId).not.toBe(second.rootId);
    expect(first.organizationId).not.toBe(second.organizationId);
  });

  test("same-named modules, record types and fields under different roots keep different identities", () => {
    const moduleCommon = {
      kind: "module",
      key: "abzum.people",
      draftRevision: 1,
      createdAt: "2026-09-02T01:00:00+00:00",
      createdBy: actor,
      updatedAt: "2026-09-02T01:00:00+00:00",
      updatedBy: actor,
    } as const;
    const first = moduleDefinitionEnvelopeSchema.parse({
      ...moduleCommon,
      rootId: id("20"),
      organizationId: id("1"),
    });
    const second = moduleDefinitionEnvelopeSchema.parse({
      ...moduleCommon,
      rootId: id("21"),
      organizationId: id("2"),
    });
    const firstRecordType = containedComponentReferenceSchema.parse({
      ownerKind: "module",
      ownerRootId: first.rootId,
      componentKind: "record_type",
      componentId: id("22"),
      key: "contact",
    });
    const secondRecordType = containedComponentReferenceSchema.parse({
      ownerKind: "module",
      ownerRootId: second.rootId,
      componentKind: "record_type",
      componentId: id("23"),
      key: "contact",
    });
    const firstField = containedComponentReferenceSchema.parse({
      ownerKind: "module",
      ownerRootId: first.rootId,
      componentKind: "field",
      componentId: id("24"),
      key: "primary_email",
    });
    const secondField = containedComponentReferenceSchema.parse({
      ownerKind: "module",
      ownerRootId: second.rootId,
      componentKind: "field",
      componentId: id("25"),
      key: "primary_email",
    });
    expect(first.rootId).not.toBe(second.rootId);
    expect(firstRecordType.key).toBe(secondRecordType.key);
    expect(firstRecordType.ownerRootId).not.toBe(secondRecordType.ownerRootId);
    expect(firstRecordType.componentId).not.toBe(secondRecordType.componentId);
    expect(firstField.key).toBe(secondField.key);
    expect(firstField.ownerRootId).not.toBe(secondField.ownerRootId);
    expect(firstField.componentId).not.toBe(secondField.componentId);
  });

  test("requires complete immutable published references", () => {
    expect(
      publishedDefinitionReferenceSchema.safeParse({
        kind: "module",
        rootId: id("2"),
        revision: 1,
        releaseVersion: "1.0.0",
        contentFingerprint: fingerprint(),
        publishedAt: "2026-09-02T01:00:00+00:00",
        publishedBy: actor,
        validationContractVersion: "1.0.0",
      }).success,
    ).toBe(true);
  });

  test("separates exact versions from uninterpreted allowed ranges", () => {
    expect(
      versionRequirementSchema.safeParse({ selection: "exact", version: "2.1.0" }).success,
    ).toBe(true);
    expect(
      versionRequirementSchema.safeParse({
        selection: "allowed_range",
        expression: ">=2.0.0 <3.0.0",
      }).success,
    ).toBe(true);
  });

  test("keeps builder references separate from resolved identities", () => {
    expect(
      recordTypeReferenceSchema.safeParse({ state: "unresolved", qualifiedKey: "people:contact" })
        .success,
    ).toBe(true);
    expect(
      recordTypeReferenceSchema.safeParse({
        state: "resolved",
        moduleRootId: id("2"),
        recordTypeId: id("3"),
      }).success,
    ).toBe(true);
    expect(
      recordTypeReferenceSchema.safeParse({ state: "resolved", qualifiedKey: "people:contact" })
        .success,
    ).toBe(false);
  });

  test("allows a complete public-address path as a permanent source alias", () => {
    expect(
      sourceIdentityAssignmentSchema.safeParse({
        definitionKey: "example.application",
        scope: "content",
        kind: "public_address",
        componentOwner: "public_address_owner",
        alias: `/${"path-segment/".repeat(20)}entry`,
        identifier: id("26"),
      }).success,
    ).toBe(true);
  });
});

describe("record and storage contracts", () => {
  test("organization-shared records refuse an application root", () => {
    expect(recordScopeSchema.safeParse(sharedScope).success).toBe(true);
    expect(
      recordScopeSchema.safeParse({ ...sharedScope, applicationRootId: id("6") }).success,
    ).toBe(false);
  });

  test("application-contained records require an application root", () => {
    expect(
      recordScopeSchema.safeParse({ ...sharedScope, storageScope: "application_contained" })
        .success,
    ).toBe(false);
    expect(
      recordScopeSchema.safeParse({
        ...sharedScope,
        storageScope: "application_contained",
        applicationRootId: id("6"),
      }).success,
    ).toBe(true);
  });

  test("physical mappings are system tokens and fit PostgreSQL's identifier limit", () => {
    const value = {
      storageContractId: id("4"),
      owningService: "record",
      physicalSchemaToken: "vtx_record_data",
      physicalTableToken: "vtx_1234567890abcdefghij",
      moduleRootId: id("2"),
      recordTypeId: id("3"),
      compatibleRevisions: { firstRevision: 1 },
      state: "active",
      creationMigrationId: id("8"),
      contentFingerprint: fingerprint(),
    };
    expect(storageCatalogEntrySchema.safeParse(value).success).toBe(true);
    expect(
      storageCatalogEntrySchema.safeParse({ ...value, physicalTableToken: "crm_contacts" }).success,
    ).toBe(false);
    expect(
      storageCatalogEntrySchema.safeParse({ ...value, physicalTableToken: `vtx_${"a".repeat(60)}` })
        .success,
    ).toBe(false);
  });
});

describe("storage lineage decisions", () => {
  const lineage = {
    lineageId: id("10"),
    packageId: id("11"),
    publisherOrganizationId: id("12"),
    sourceModuleRootId: id("2"),
    sourceRecordTypeId: id("3"),
    sourceStorageContractId: id("4"),
    sourceReleaseVersion: "1.0.0",
    sourceContentFingerprint: fingerprint("b"),
    localOrganizationId: id("1"),
    localModuleRootId: id("13"),
    localRecordTypeId: id("14"),
    localPublishedRevision: 1,
    componentMappings: [{ sourceComponentId: id("15"), localComponentId: id("16") }],
    mappingFingerprint: fingerprint("c"),
  };

  test("preserves proven signed compatible package storage", () => {
    expect(
      storageLineageDecisionSchema.safeParse({
        decision: "preserve_source_storage",
        lineage,
        selectedStorageContractId: id("4"),
        evidence: {
          signedPackageVerified: true,
          compatibilityState: "compatible",
          sourceStorageFingerprint: fingerprint("d"),
          localStorageFingerprint: fingerprint("d"),
          mappingFingerprint: fingerprint("c"),
        },
      }).success,
    ).toBe(true);
  });

  test.each([
    {
      selectedStorageContractId: id("17"),
      localStorageFingerprint: fingerprint("d"),
      mappingFingerprint: fingerprint("c"),
    },
    {
      selectedStorageContractId: id("4"),
      localStorageFingerprint: fingerprint("e"),
      mappingFingerprint: fingerprint("c"),
    },
    {
      selectedStorageContractId: id("4"),
      localStorageFingerprint: fingerprint("d"),
      mappingFingerprint: fingerprint("e"),
    },
  ])(
    "refuses unproven preservation %#",
    ({ selectedStorageContractId, localStorageFingerprint, mappingFingerprint }) => {
      expect(
        storageLineageDecisionSchema.safeParse({
          decision: "preserve_source_storage",
          lineage,
          selectedStorageContractId,
          evidence: {
            signedPackageVerified: true,
            compatibilityState: "compatible",
            sourceStorageFingerprint: fingerprint("d"),
            localStorageFingerprint,
            mappingFingerprint,
          },
        }).success,
      ).toBe(false);
    },
  );

  test.each([
    "independent_definition",
    "structural_fork",
    "incompatible_meaning",
    "unproven_lineage",
  ] as const)("allocates a new identity for %s", (reason) => {
    expect(
      storageLineageDecisionSchema.safeParse({
        decision: "allocate_new_storage",
        allocatedStorageContractId: id("17"),
        sourceStorageContractId: id("4"),
        reason,
      }).success,
    ).toBe(true);
  });

  test("refuses to allocate the source storage identity as new", () => {
    expect(
      storageLineageDecisionSchema.safeParse({
        decision: "allocate_new_storage",
        allocatedStorageContractId: id("4"),
        sourceStorageContractId: id("4"),
        reason: "structural_fork",
      }).success,
    ).toBe(false);
  });
});
