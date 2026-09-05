import { describe, expect, it } from "vitest";
import {
  applicationPermissionCatalogueSnapshotSchema,
  initializePlatformPermissionCatalogueCommandSchema,
  initializePlatformPermissionCatalogueResultSchema,
  permissionCatalogueLookupCommandSchema,
  permissionCatalogueLookupResultSchema,
  permissionRegistryMutationCommandSchema,
  preparedApplicationPermissionRegistrationSchema,
} from "../src";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const fingerprint = (character: string): string => `sha256:${character.repeat(64)}`;

const applicationRelease = {
  kind: "application",
  definitionKey: "example.application",
  rootId: id(2),
  releaseRevision: 3,
  releaseVersion: "1.2.0",
  validationContractVersion: "1.0.0",
  contentFingerprint: fingerprint("a"),
  resolutionFingerprint: fingerprint("b"),
} as const;

const entry = {
  applicationRootId: id(2),
  ownerKind: "application",
  ownerId: id(2),
  permission: {
    permissionId: id(3),
    key: "example.application.open",
    label: "Open application",
    description: "Open this application without implying record access.",
    actionKind: "named",
    namedAction: "open",
    administrative: false,
  },
  sourceRelease: applicationRelease,
  meaningFingerprint: fingerprint("c"),
} as const;

const candidate = {
  contractVersion: "1.0.0",
  organizationId: id(1),
  applicationRootId: id(2),
  applicationRelease,
  applicationCatalogueFingerprint: fingerprint("d"),
  applicationPermissionIds: [id(3)],
  entries: [entry],
  candidateFingerprint: fingerprint("e"),
} as const;

describe("permission registry contracts", () => {
  it("models explicit organisation-local platform catalogue initialisation", () => {
    expect(
      initializePlatformPermissionCatalogueCommandSchema.parse({
        organizationId: id(1),
        changedBy: id(8),
        correlationId: id(9),
      }),
    ).toBeDefined();
    expect(
      initializePlatformPermissionCatalogueResultSchema.parse({
        organizationId: id(1),
        registrationRevision: 1,
        accessVersion: 2,
      }),
    ).toBeDefined();
  });

  it("retains exact owner, application context and release evidence", () => {
    expect(preparedApplicationPermissionRegistrationSchema.parse(candidate)).toEqual(candidate);
    expect(
      preparedApplicationPermissionRegistrationSchema.safeParse({
        ...candidate,
        entries: [{ ...entry, applicationRootId: id(4) }],
      }).success,
    ).toBe(false);
    expect(
      preparedApplicationPermissionRegistrationSchema.safeParse({
        ...candidate,
        entries: [{ ...entry, ownerId: id(5) }],
      }).success,
    ).toBe(false);
  });

  it("allows the same key under different owners but refuses owner-local ambiguity", () => {
    const moduleEntry = {
      ...entry,
      ownerKind: "module" as const,
      ownerId: id(4),
      sourceRelease: {
        ...applicationRelease,
        kind: "module" as const,
        definitionKey: "example.module",
        rootId: id(4),
      },
    };
    expect(
      preparedApplicationPermissionRegistrationSchema.safeParse({
        ...candidate,
        entries: [entry, moduleEntry],
      }).success,
    ).toBe(true);
    expect(
      preparedApplicationPermissionRegistrationSchema.safeParse({
        ...candidate,
        entries: [entry, { ...entry, permission: { ...entry.permission, label: "Duplicate" } }],
      }).success,
    ).toBe(false);
  });

  it("requires exact application context for application and module availability", () => {
    expect(
      permissionCatalogueLookupCommandSchema.safeParse({
        organizationId: id(1),
        applicationRootId: id(2),
        ownerKind: "module",
        ownerId: id(4),
        permissionId: id(3),
      }).success,
    ).toBe(true);
    expect(
      permissionCatalogueLookupCommandSchema.safeParse({
        organizationId: id(1),
        ownerKind: "module",
        ownerId: id(4),
        permissionId: id(3),
      }).success,
    ).toBe(false);
    expect(
      permissionCatalogueLookupCommandSchema.safeParse({
        organizationId: id(1),
        applicationRootId: id(2),
        ownerKind: "platform",
        ownerId: id(4),
        permissionId: id(3),
      }).success,
    ).toBe(false);

    expect(
      permissionCatalogueLookupResultSchema.safeParse({
        outcome: "available",
        entry: {
          organizationId: id(1),
          registrationRevision: 1,
          ownerKind: "platform",
          ownerId: id(10),
          permission: { ...entry.permission, administrative: true },
          sourceRelease: {
            kind: "platform_catalogue",
            ownerId: id(10),
            catalogueVersion: "1.0.0",
            catalogueFingerprint: fingerprint("f"),
          },
          meaningFingerprint: fingerprint("c"),
        },
      }).success,
    ).toBe(true);
    expect(
      permissionCatalogueLookupResultSchema.safeParse({
        outcome: "available",
        entry: {
          organizationId: id(1),
          applicationRootId: id(2),
          registrationRevision: 1,
          ownerKind: "platform",
          ownerId: id(10),
          permission: { ...entry.permission, administrative: true },
          sourceRelease: {
            kind: "platform_catalogue",
            ownerId: id(10),
            catalogueVersion: "1.0.0",
            catalogueFingerprint: fingerprint("f"),
          },
          meaningFingerprint: fingerprint("c"),
        },
      }).success,
    ).toBe(false);
  });

  it("models explicit revision-checked update, reactivation and withdrawal", () => {
    const common = { changedBy: id(8), correlationId: id(9) };
    expect(
      permissionRegistryMutationCommandSchema.safeParse({
        operation: "register",
        candidate,
        ...common,
      }).success,
    ).toBe(true);
    for (const operation of ["update", "reactivate"] as const)
      expect(
        permissionRegistryMutationCommandSchema.safeParse({
          operation,
          expectedRevision: 4,
          candidate,
          ...common,
        }).success,
      ).toBe(true);
    expect(
      permissionRegistryMutationCommandSchema.safeParse({
        operation: "withdraw",
        organizationId: id(1),
        applicationRootId: id(2),
        expectedRevision: 4,
        ...common,
      }).success,
    ).toBe(true);
    expect(
      permissionRegistryMutationCommandSchema.safeParse({
        operation: "reactivate",
        candidate,
        ...common,
      }).success,
    ).toBe(false);
  });

  it("keeps application-only snapshots bound to the exact application release", () => {
    const snapshot = {
      organizationId: id(1),
      applicationRootId: id(2),
      registrationRevision: 5,
      applicationRelease,
      catalogueFingerprint: fingerprint("d"),
      permissionIds: [id(3)],
    };
    expect(applicationPermissionCatalogueSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      applicationPermissionCatalogueSnapshotSchema.safeParse({
        ...snapshot,
        applicationRootId: id(6),
      }).success,
    ).toBe(false);
  });

  it("does not impose an artificial total-permission cap on a canonical registration", () => {
    const entries = Array.from({ length: 10_001 }, (_, index) => {
      const permissionId = id(index + 100_000);
      return {
        ...entry,
        permission: {
          ...entry.permission,
          permissionId,
          key: `example.application.permission_${index}`,
        },
      };
    });
    expect(
      preparedApplicationPermissionRegistrationSchema.safeParse({
        ...candidate,
        applicationPermissionIds: entries.map((item) => item.permission.permissionId),
        entries,
      }).success,
    ).toBe(true);
  });
});
