import { fingerprintCanonicalValue } from "@vortex/definition";
import {
  OrganizationDelegationScopeEvidenceError,
  prepareOrganizationDelegationScope,
  verifyPreparedOrganizationDelegationScope,
} from "../src/organization-delegation-scope-evidence";
import { describe, expect, it } from "vitest";

const fingerprint = (value: string): `sha256:${string}` => `sha256:${value.repeat(64)}`;
const applicationRootId = "a1000000-0000-4000-8000-000000000001";

const applicationPermission = () => ({
  kind: "exact" as const,
  applicationRootId,
  ownerKind: "application" as const,
  ownerId: applicationRootId,
  permissionId: "b1000000-0000-4000-8000-000000000001",
  acceptedRegistrationRevision: 3,
  catalogueFingerprint: fingerprint("a"),
  continuityRevision: 2,
  meaningFingerprint: fingerprint("b"),
});

const modulePermission = () => ({
  kind: "exact" as const,
  applicationRootId,
  ownerKind: "module" as const,
  ownerId: "c1000000-0000-4000-8000-000000000001",
  permissionId: "d1000000-0000-4000-8000-000000000001",
  acceptedRegistrationRevision: 4,
  catalogueFingerprint: fingerprint("c"),
  continuityRevision: 5,
  meaningFingerprint: fingerprint("d"),
});

const platformPermission = () => ({
  kind: "exact" as const,
  ownerKind: "platform" as const,
  ownerId: "e1000000-0000-4000-8000-000000000001",
  permissionId: "f1000000-0000-4000-8000-000000000001",
  acceptedRegistrationRevision: 1,
  catalogueFingerprint: fingerprint("e"),
  continuityRevision: 1,
  meaningFingerprint: fingerprint("f"),
});

describe("organization delegation-scope evidence", () => {
  it("preserves the closed organization-catalogue scope without a fingerprint", () => {
    expect(prepareOrganizationDelegationScope({ kind: "organization_catalogue" })).toEqual({
      kind: "organization_catalogue",
    });
    expect(verifyPreparedOrganizationDelegationScope({ kind: "organization_catalogue" })).toEqual({
      kind: "organization_catalogue",
    });
  });

  it("normalizes UUIDs, applies the database tuple order and derives one fingerprint", () => {
    const upperApplication = {
      ...applicationPermission(),
      applicationRootId: applicationRootId.toUpperCase(),
      ownerId: applicationRootId.toUpperCase(),
      permissionId: applicationPermission().permissionId.toUpperCase(),
    };
    expect(upperApplication.permissionId).not.toBe(applicationPermission().permissionId);

    const prepared = prepareOrganizationDelegationScope({
      kind: "bounded",
      permissions: [platformPermission(), modulePermission(), upperApplication],
    });
    expect(prepared.kind).toBe("bounded");
    if (prepared.kind !== "bounded") throw new Error("expected bounded scope");
    expect(prepared.permissions).toEqual([
      applicationPermission(),
      modulePermission(),
      platformPermission(),
    ]);
    expect(prepared.scopeFingerprint).toBe(
      fingerprintCanonicalValue({ kind: "bounded", permissions: prepared.permissions }),
    );
  });

  it("gives case-equivalent input the same canonical scope", () => {
    const lower = prepareOrganizationDelegationScope({
      kind: "bounded",
      permissions: [applicationPermission()],
    });
    const upper = prepareOrganizationDelegationScope({
      kind: "bounded",
      permissions: [
        {
          ...applicationPermission(),
          applicationRootId: applicationRootId.toUpperCase(),
          ownerId: applicationRootId,
          permissionId: applicationPermission().permissionId.toUpperCase(),
        },
      ],
    });
    expect(upper).toEqual(lower);
  });

  it("refuses duplicate identities after UUID normalization", () => {
    expect(() =>
      prepareOrganizationDelegationScope({
        kind: "bounded",
        permissions: [
          applicationPermission(),
          {
            ...applicationPermission(),
            applicationRootId: applicationRootId.toUpperCase(),
            ownerId: applicationRootId.toUpperCase(),
            permissionId: applicationPermission().permissionId.toUpperCase(),
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "ORGANIZATION_DELEGATION_SCOPE_EVIDENCE_INVALID",
      }),
    );
  });

  it.each([
    ["empty bounded set", { kind: "bounded", permissions: [] }],
    [
      "scope fingerprint supplied by candidate",
      {
        kind: "bounded",
        permissions: [applicationPermission()],
        scopeFingerprint: fingerprint("1"),
      },
    ],
    ["unknown catalogue field", { kind: "organization_catalogue", permissions: [] }],
  ])("refuses an invalid %s before preparation", (_name, candidate) => {
    expect(() => prepareOrganizationDelegationScope(candidate as never)).toThrowError(
      expect.objectContaining({
        code: "INVALID_ORGANIZATION_DELEGATION_SCOPE_CANDIDATE",
      }),
    );
  });

  it("verifies the complete prepared bounded evidence", () => {
    const prepared = prepareOrganizationDelegationScope({
      kind: "bounded",
      permissions: [modulePermission(), applicationPermission()],
    });
    expect(verifyPreparedOrganizationDelegationScope(prepared)).toEqual(prepared);
  });

  it.each([
    [
      "fingerprint",
      (
        prepared: Extract<
          ReturnType<typeof prepareOrganizationDelegationScope>,
          { kind: "bounded" }
        >,
      ) => ({
        ...prepared,
        scopeFingerprint: fingerprint("0"),
      }),
    ],
    [
      "tuple order",
      (
        prepared: Extract<
          ReturnType<typeof prepareOrganizationDelegationScope>,
          { kind: "bounded" }
        >,
      ) => ({
        ...prepared,
        permissions: [...prepared.permissions].reverse(),
      }),
    ],
    [
      "noncanonical UUID casing",
      (
        prepared: Extract<
          ReturnType<typeof prepareOrganizationDelegationScope>,
          { kind: "bounded" }
        >,
      ) => ({
        ...prepared,
        permissions: prepared.permissions.map((entry, index) =>
          index === 0 ? { ...entry, permissionId: entry.permissionId.toUpperCase() } : entry,
        ),
      }),
    ],
    [
      "permission evidence",
      (
        prepared: Extract<
          ReturnType<typeof prepareOrganizationDelegationScope>,
          { kind: "bounded" }
        >,
      ) => ({
        ...prepared,
        permissions: prepared.permissions.map((entry, index) =>
          index === 0 ? { ...entry, continuityRevision: entry.continuityRevision + 1 } : entry,
        ),
      }),
    ],
  ])("refuses tampered prepared %s", (_name, mutate) => {
    const prepared = prepareOrganizationDelegationScope({
      kind: "bounded",
      permissions: [applicationPermission(), modulePermission()],
    });
    if (prepared.kind !== "bounded") throw new Error("expected bounded scope");
    expect(() => verifyPreparedOrganizationDelegationScope(mutate(prepared))).toThrowError(
      OrganizationDelegationScopeEvidenceError,
    );
  });

  it("does not accept actor or correlation data inside scope evidence", () => {
    const prepared = prepareOrganizationDelegationScope({
      kind: "bounded",
      permissions: [applicationPermission()],
    });
    expect(() =>
      verifyPreparedOrganizationDelegationScope({
        ...prepared,
        changedBy: "aa000000-0000-4000-8000-000000000001",
      }),
    ).toThrowError(OrganizationDelegationScopeEvidenceError);
  });
});
