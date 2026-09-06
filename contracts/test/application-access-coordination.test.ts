import {
  applicationAccessChangeCommandSchema,
  applicationAccessChangeResultSchema,
  preparedApplicationRoleTemplatesSchema,
  type PreparedApplicationRoleTemplates,
} from "../src";
import { describe, expect, it } from "vitest";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const fingerprint = (character: string): string => `sha256:${character.repeat(64)}`;

const preparedTemplates = (): PreparedApplicationRoleTemplates => {
  const applicationRootId = id(10);
  const permission = {
    permissionId: id(20),
    key: "example.orders.read",
    label: "View orders",
    description: "View orders in the example application.",
    actionKind: "read" as const,
    administrative: false,
  };
  const sourceRelease = {
    kind: "application" as const,
    definitionKey: "example.orders",
    rootId: applicationRootId,
    releaseRevision: 1,
    releaseVersion: "1.0.0",
    validationContractVersion: "2.17.0",
    contentFingerprint: fingerprint("a"),
    resolutionFingerprint: fingerprint("b"),
  };
  const entry = {
    applicationRootId,
    ownerKind: "application" as const,
    ownerId: applicationRootId,
    permission,
    sourceRelease,
    meaningFingerprint: fingerprint("c"),
  };
  return preparedApplicationRoleTemplatesSchema.parse({
    contractVersion: "1.0.0",
    preparationBasis: { kind: "registration_candidate" },
    permissionRegistration: {
      contractVersion: "1.0.0",
      organizationId: id(1),
      applicationRootId,
      applicationRelease: sourceRelease,
      applicationCatalogueFingerprint: fingerprint("d"),
      applicationPermissionIds: [permission.permissionId],
      entries: [entry],
      candidateFingerprint: fingerprint("e"),
    },
    templates: [
      {
        template: {
          roleId: id(30),
          key: "reader",
          name: "Reader",
          homePageId: id(40),
          permissionKeys: [permission.key],
          permissionSelection: { kind: "exact" },
        },
        sourceTemplateFingerprint: fingerprint("f"),
        sourcePermissions: [entry],
        livePermissions: [entry],
      },
    ],
    candidateFingerprint: fingerprint("0"),
  });
};

describe("coordinated application access contracts", () => {
  it("accepts exact prepared registration changes and definition-free withdrawal", () => {
    expect(
      applicationAccessChangeCommandSchema.safeParse({
        operation: "register",
        preparedTemplates: preparedTemplates(),
        changedBy: id(2),
        correlationId: id(3),
      }).success,
    ).toBe(true);
    expect(
      applicationAccessChangeCommandSchema.safeParse({
        operation: "withdraw",
        organizationId: id(1),
        applicationRootId: id(10),
        expectedRevision: 2,
        changedBy: id(2),
        correlationId: id(3),
      }).success,
    ).toBe(true);
  });

  it("refuses current-registration acceptance evidence and mixed command shapes", () => {
    const current = {
      ...preparedTemplates(),
      preparationBasis: { kind: "current_active_registration", registrationRevision: 1 },
    };
    expect(
      applicationAccessChangeCommandSchema.safeParse({
        operation: "update",
        expectedRevision: 1,
        preparedTemplates: current,
        changedBy: id(2),
        correlationId: id(3),
      }).success,
    ).toBe(false);
    expect(
      applicationAccessChangeCommandSchema.safeParse({
        operation: "withdraw",
        organizationId: id(1),
        applicationRootId: id(10),
        expectedRevision: 1,
        preparedTemplates: preparedTemplates(),
        changedBy: id(2),
        correlationId: id(3),
      }).success,
    ).toBe(false);
  });

  it("keeps changed and unchanged outcomes explicit", () => {
    expect(
      applicationAccessChangeResultSchema.parse({
        outcome: "changed",
        operation: "withdraw",
        organizationId: id(1),
        applicationRootId: id(10),
        registrationState: "withdrawn",
        registrationRevision: 2,
        accessVersion: 4,
        correlationId: id(3),
      }),
    ).toMatchObject({ outcome: "changed", registrationState: "withdrawn" });
    expect(
      applicationAccessChangeResultSchema.safeParse({
        outcome: "unchanged",
        operation: "register",
        organizationId: id(1),
        applicationRootId: id(10),
        registrationState: "active",
        registrationRevision: 1,
        accessVersion: 3,
        correlationId: id(3),
      }).success,
    ).toBe(false);
  });
});
