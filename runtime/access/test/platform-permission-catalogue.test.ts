import { fingerprintCanonicalValue } from "@vortex/definition";
import { describe, expect, it } from "vitest";
import { fingerprintPermissionMeaning } from "../src/permission-fingerprints";
import {
  platformPermissionCatalogue,
  platformPermissionCatalogueOwnerId,
  platformPermissionCatalogueVersion,
} from "../src/platform-permission-catalogue";

describe("platform permission catalogue", () => {
  it("publishes the complete current administration catalogue", () => {
    expect(platformPermissionCatalogue).toMatchObject({
      catalogueVersion: platformPermissionCatalogueVersion,
      ownerKind: "platform",
      ownerId: platformPermissionCatalogueOwnerId,
    });
    expect(platformPermissionCatalogue.permissions).toHaveLength(22);
    expect(
      new Set(platformPermissionCatalogue.permissions.map((entry) => entry.permissionId)),
    ).toHaveProperty("size", 22);
    expect(
      new Set(platformPermissionCatalogue.permissions.map((entry) => entry.key)),
    ).toHaveProperty("size", 22);
    expect(platformPermissionCatalogue.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "platform.organization.permissions.read" }),
        expect.objectContaining({ key: "platform.organization.roles.manage" }),
        expect.objectContaining({ key: "platform.organization.accounts.manage" }),
        expect.objectContaining({ key: "platform.organization.invitations.manage" }),
        expect.objectContaining({ key: "platform.organization.runtime_settings.manage" }),
        expect.objectContaining({
          key: "platform.organization.applications.manage",
          actionKind: "manage",
          administrative: true,
        }),
        expect.objectContaining({ key: "platform.organization.definition_drafts.manage" }),
        expect.objectContaining({ key: "platform.organization.definition_releases.manage" }),
        expect.objectContaining({ key: "platform.organization.custom_code.manage" }),
        expect.objectContaining({ key: "platform.organization.system_applications.manage" }),
      ]),
    );
    expect(
      platformPermissionCatalogue.permissions.every(
        (entry) =>
          entry.administrative &&
          (entry.actionKind === "read" || entry.actionKind === "manage") &&
          entry.recordTypeId === undefined &&
          entry.namedAction === undefined,
      ),
    ).toBe(true);
  });

  it("has deterministic version and content provenance", () => {
    const { catalogueFingerprint, ...catalogueCore } = platformPermissionCatalogue;
    expect(catalogueFingerprint).toBe(fingerprintCanonicalValue(catalogueCore));
    const permission = platformPermissionCatalogue.permissions[0];
    if (!permission) throw new Error("Platform permission required");
    expect(
      fingerprintPermissionMeaning("platform", platformPermissionCatalogueOwnerId, {
        ...permission,
        label: `${permission.label} updated`,
        description: `${permission.description} Updated display copy.`,
      }),
    ).toBe(
      fingerprintPermissionMeaning("platform", platformPermissionCatalogueOwnerId, permission),
    );

    const recordPermission = {
      permissionId: "00000000-0000-4000-8000-000000000001",
      key: "sample.records.read",
      label: "Read records",
      description: "Read scoped records.",
      recordTypeId: "00000000-0000-4000-8000-000000000002",
      actionKind: "read" as const,
      administrative: false,
    };
    const baseline = fingerprintPermissionMeaning(
      "module",
      "00000000-0000-4000-8000-000000000003",
      recordPermission,
    );
    expect(
      fingerprintPermissionMeaning("module", "00000000-0000-4000-8000-000000000003", {
        ...recordPermission,
        recordScope: { routes: [{ kind: "all_records" }] },
      }),
    ).not.toBe(baseline);
    expect(
      fingerprintPermissionMeaning("module", "00000000-0000-4000-8000-000000000003", {
        ...recordPermission,
        recordScope: { routes: [{ kind: "direct_share" }] },
      }),
    ).not.toBe(baseline);
    expect(
      fingerprintPermissionMeaning("module", "00000000-0000-4000-8000-000000000003", {
        ...recordPermission,
        recordScope: undefined,
      }),
    ).toBe(baseline);
    expect(
      fingerprintPermissionMeaning("module", "00000000-0000-4000-8000-000000000003", {
        ...recordPermission,
        fieldPolicy: {
          readableFieldIds: ["00000000-0000-4000-8000-000000000004"],
          changeableFieldIds: [],
        },
      }),
    ).not.toBe(baseline);
    expect(
      fingerprintPermissionMeaning("module", "00000000-0000-4000-8000-000000000003", {
        ...recordPermission,
        fieldPolicy: undefined,
      }),
    ).toBe(baseline);
  });
});
