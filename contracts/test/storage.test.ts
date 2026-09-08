import { describe, expect, test } from "vitest";
import {
  activeApplicationInstallationEvidenceSchema,
  fieldStorageMappingSchema,
  moduleInstallationStorageCommandSchema,
  moduleInstallationBindingEvidenceSchema,
  moduleInstallationStorageResultSchema,
  recordStorageColumnTokenSchema,
  recordStorageReleaseProvisionSchema,
  recordStorageSchemaTokenSchema,
  recordStorageTableTokenSchema,
  storageCatalogEntrySchema,
} from "../src";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const fingerprint = (value: string) => `sha256:${value.repeat(64)}`;
const moduleRootId = id("1");
const applicationRootId = id("2");
const storageContractId = id("3");
const fieldId = id("4");
const tableToken = `rt_${storageContractId.replaceAll("-", "")}`;
const columnToken = `f_${fieldId.replaceAll("-", "")}`;

describe("record storage provisioning contracts", () => {
  test("uses the fixed schema and complete UUID-derived physical tokens", () => {
    expect(recordStorageSchemaTokenSchema.parse("record_data")).toBe("record_data");
    expect(recordStorageTableTokenSchema.parse(tableToken)).toBe(tableToken);
    expect(recordStorageColumnTokenSchema.parse(columnToken)).toBe(columnToken);

    for (const candidate of ["vtx_record_data", "crm", "rt_short", `${tableToken}0`])
      expect(recordStorageTableTokenSchema.safeParse(candidate).success).toBe(false);
    for (const candidate of ["company_name", "f_short", tableToken, columnToken.toUpperCase()])
      expect(recordStorageColumnTokenSchema.safeParse(candidate).success).toBe(false);
  });

  test("records storage meaning without fabricating per-install migration identities", () => {
    expect(
      storageCatalogEntrySchema.parse({
        storageContractId,
        owningService: "record",
        physicalSchemaToken: "record_data",
        physicalTableToken: tableToken,
        moduleRootId,
        recordTypeId: id("5"),
        storageScope: "organization_shared",
        compatibleRevisions: { firstRevision: 1 },
        state: "active",
        generatorContractVersion: "1.0.0",
        contentFingerprint: fingerprint("a"),
      }),
    ).not.toHaveProperty("creationMigrationId");
  });

  test("binds field introduction and retirement to exact module releases", () => {
    const active = {
      storageContractId,
      fieldId,
      physicalColumnToken: columnToken,
      databaseValueType: "text",
      introducedByModuleRootId: moduleRootId,
      introducedAtReleaseRevision: 1,
      state: "active",
    } as const;
    expect(fieldStorageMappingSchema.safeParse(active).success).toBe(true);
    expect(
      fieldStorageMappingSchema.safeParse({
        ...active,
        state: "retired",
        retiredByModuleRootId: moduleRootId,
        retiredAtReleaseRevision: 2,
      }).success,
    ).toBe(true);
    expect(
      fieldStorageMappingSchema.safeParse({
        ...active,
        state: "retired",
        retiredAtReleaseRevision: 2,
      }).success,
    ).toBe(false);
  });

  test("requires exact installation identities and a nullable first-binding revision", () => {
    const command = {
      applicationRootId,
      applicationReleaseRevision: 4,
      moduleRootId,
      moduleReleaseRevision: 3,
      expectedBindingRevision: null,
    };
    expect(moduleInstallationStorageCommandSchema.safeParse(command).success).toBe(true);
    expect(
      moduleInstallationStorageCommandSchema.safeParse({ ...command, organizationId: id("9") })
        .success,
    ).toBe(false);
    expect(
      moduleInstallationStorageCommandSchema.safeParse({
        ...command,
        physicalTableToken: tableToken,
      }).success,
    ).toBe(false);
  });

  test("keeps exact release provenance and canonical storage identity order", () => {
    const result = {
      state: "provisioned",
      changed: true,
      bindingRevision: 1,
      applicationRootId,
      applicationReleaseRevision: 4,
      moduleRootId,
      moduleReleaseRevision: 3,
      contentFingerprint: fingerprint("b"),
      resolutionFingerprint: fingerprint("c"),
      generatorContractVersion: "1.0.0",
      storageContractIds: [storageContractId, id("6")],
    } as const;
    expect(moduleInstallationStorageResultSchema.safeParse(result).success).toBe(true);
    expect(recordStorageReleaseProvisionSchema.safeParse(result).success).toBe(false);
    expect(
      moduleInstallationStorageResultSchema.safeParse({
        ...result,
        storageContractIds: [...result.storageContractIds].reverse(),
      }).success,
    ).toBe(false);
    expect(
      recordStorageReleaseProvisionSchema.safeParse({
        moduleRootId,
        releaseRevision: 3,
        contentFingerprint: fingerprint("b"),
        resolutionFingerprint: fingerprint("c"),
        generatorContractVersion: "1.0.0",
        storageContractIds: result.storageContractIds,
      }).success,
    ).toBe(true);
  });

  test("keeps active binding evidence exact and tied to one Application release", () => {
    const binding = {
      organizationId: id("8"),
      applicationRootId,
      moduleRootId,
      bindingRevision: 2,
      applicationReleaseRevision: 4,
      moduleReleaseRevision: 3,
      state: "active",
    } as const;
    expect(moduleInstallationBindingEvidenceSchema.safeParse(binding).success).toBe(true);
    expect(
      activeApplicationInstallationEvidenceSchema.safeParse({
        organizationId: binding.organizationId,
        applicationRootId,
        applicationReleaseRevision: 4,
        moduleBindings: [binding],
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...binding, state: "provisioned" },
      { ...binding, applicationReleaseRevision: 5 },
      { ...binding, organizationId: id("9") },
    ])
      expect(
        activeApplicationInstallationEvidenceSchema.safeParse({
          organizationId: binding.organizationId,
          applicationRootId,
          applicationReleaseRevision: 4,
          moduleBindings: [invalid],
        }).success,
      ).toBe(false);
    expect(
      activeApplicationInstallationEvidenceSchema.safeParse({
        organizationId: binding.organizationId,
        applicationRootId,
        applicationReleaseRevision: 4,
        moduleBindings: [binding, binding],
      }).success,
    ).toBe(false);
  });
});
