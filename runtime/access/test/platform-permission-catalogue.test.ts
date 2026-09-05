import fs from "node:fs";
import path from "node:path";
import { fingerprintCanonicalValue } from "@vortex/definition";
import { describe, expect, it } from "vitest";
import { fingerprintPermissionMeaning } from "../src/permission-fingerprints";
import {
  platformPermissionCatalogue,
  platformPermissionCatalogueV1,
  platformPermissionCatalogueOwnerId,
  platformPermissionCatalogueVersion,
  platformPermissionCatalogueVersionV1,
} from "../src/platform-permission-catalogue";

describe("platform permission catalogue", () => {
  it("publishes the complete current administration catalogue", () => {
    expect(platformPermissionCatalogue).toMatchObject({
      catalogueVersion: platformPermissionCatalogueVersion,
      ownerKind: "platform",
      ownerId: platformPermissionCatalogueOwnerId,
    });
    expect(platformPermissionCatalogue.permissions).toHaveLength(13);
    expect(
      new Set(platformPermissionCatalogue.permissions.map((entry) => entry.permissionId)),
    ).toHaveProperty("size", 13);
    expect(
      new Set(platformPermissionCatalogue.permissions.map((entry) => entry.key)),
    ).toHaveProperty("size", 13);
    expect(platformPermissionCatalogue.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "platform.organization.permissions.read" }),
        expect.objectContaining({ key: "platform.organization.roles.manage" }),
        expect.objectContaining({ key: "platform.organization.accounts.manage" }),
        expect.objectContaining({ key: "platform.organization.invitations.manage" }),
        expect.objectContaining({ key: "platform.organization.runtime_settings.manage" }),
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

  it("changes only Group-facing display metadata across the explicit patch revision", () => {
    expect(platformPermissionCatalogueV1.catalogueVersion).toBe(
      platformPermissionCatalogueVersionV1,
    );
    expect(platformPermissionCatalogue.catalogueVersion).toBe(platformPermissionCatalogueVersion);
    expect(platformPermissionCatalogue.catalogueFingerprint).not.toBe(
      platformPermissionCatalogueV1.catalogueFingerprint,
    );

    const withoutDisplayMetadata = (catalogue: typeof platformPermissionCatalogue) =>
      catalogue.permissions.map((permission) => ({
        permissionId: permission.permissionId,
        key: permission.key,
        recordTypeId: permission.recordTypeId,
        actionKind: permission.actionKind,
        namedAction: permission.namedAction,
        administrative: permission.administrative,
      }));
    expect(withoutDisplayMetadata(platformPermissionCatalogue)).toEqual(
      withoutDisplayMetadata(platformPermissionCatalogueV1),
    );

    const changed = platformPermissionCatalogue.permissions.filter((permission, index) => {
      const historical = platformPermissionCatalogueV1.permissions[index];
      return (
        historical?.label !== permission.label || historical.description !== permission.description
      );
    });
    expect(changed).toEqual([
      expect.objectContaining({
        permissionId: "290ae49f-4cab-4159-9c20-6e664f07d50b",
        key: "platform.organization.teams.read",
        label: "View groups",
      }),
      expect.objectContaining({
        permissionId: "6185dc64-464b-4776-97dc-c64a6f299550",
        key: "platform.organization.teams.manage",
        label: "Manage groups",
      }),
    ]);
    expect(
      platformPermissionCatalogue.permissions.map((permission) =>
        fingerprintPermissionMeaning("platform", platformPermissionCatalogueOwnerId, permission),
      ),
    ).toEqual(
      platformPermissionCatalogueV1.permissions.map((permission) =>
        fingerprintPermissionMeaning("platform", platformPermissionCatalogueOwnerId, permission),
      ),
    );
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
  });

  it("keeps every SQL catalogue identity and metadata byte-for-byte aligned", () => {
    const migration = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../supabase/migrations/20260905060000_permission_registry.sql",
      ),
      "utf8",
    );
    const entriesMatch = migration.match(
      /catalogue_entries constant jsonb := \$catalogue\$(\[[\s\S]*?\])\$catalogue\$::jsonb;/,
    );
    const fingerprintMatch = migration.match(
      /catalogue_fingerprint constant text := '(sha256:[a-f0-9]{64})';/,
    );
    expect(entriesMatch?.[1]).toBeDefined();
    expect(fingerprintMatch?.[1]).toBe(platformPermissionCatalogueV1.catalogueFingerprint);

    const sqlEntries = JSON.parse(entriesMatch![1]!) as unknown;
    expect(sqlEntries).toEqual(
      platformPermissionCatalogueV1.permissions.map((permission) => ({
        permissionId: permission.permissionId,
        key: permission.key,
        label: permission.label,
        description: permission.description,
        actionKind: permission.actionKind,
        meaningFingerprint: fingerprintPermissionMeaning(
          "platform",
          platformPermissionCatalogueOwnerId,
          permission,
        ),
      })),
    );
  });

  it("keeps the additive SQL metadata revision byte-for-byte aligned with the current catalogue", () => {
    const migration = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../supabase/migrations/20260905060003_platform_permission_catalogue_group_metadata.sql",
      ),
      "utf8",
    );
    const entriesMatch = migration.match(
      /catalogue_entries constant jsonb := \$catalogue\$(\[[\s\S]*?\])\$catalogue\$::jsonb;/,
    );
    const fingerprintMatch = migration.match(
      /current_catalogue_fingerprint constant text :=\s*'(sha256:[a-f0-9]{64})';/,
    );
    expect(entriesMatch?.[1]).toBeDefined();
    expect(fingerprintMatch?.[1]).toBe(platformPermissionCatalogue.catalogueFingerprint);

    const sqlEntries = JSON.parse(entriesMatch![1]!) as unknown;
    expect(sqlEntries).toEqual(
      platformPermissionCatalogue.permissions.map((permission) => ({
        permissionId: permission.permissionId,
        key: permission.key,
        label: permission.label,
        description: permission.description,
        actionKind: permission.actionKind,
        meaningFingerprint: fingerprintPermissionMeaning(
          "platform",
          platformPermissionCatalogueOwnerId,
          permission,
        ),
      })),
    );
  });
});
