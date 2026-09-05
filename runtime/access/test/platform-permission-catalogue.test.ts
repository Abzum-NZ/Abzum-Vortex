import fs from "node:fs";
import path from "node:path";
import { fingerprintCanonicalValue } from "@vortex/definition";
import { describe, expect, it } from "vitest";
import { fingerprintPermissionMeaning } from "../src/permission-fingerprints";
import {
  platformPermissionCatalogue,
  platformPermissionCatalogueOwnerId,
  platformPermissionCatalogueVersion,
} from "../src/platform-permission-catalogue";

describe("platform permission catalogue", () => {
  it("matches the complete documented version-one administration catalogue", () => {
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
