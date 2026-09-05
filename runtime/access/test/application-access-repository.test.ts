import type { PermissionDeclaration, PreparedApplicationRoleTemplates } from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { fingerprintCanonicalValue } from "@vortex/definition";
import * as shippingAccess from "../src/index";
import { describe, expect, it } from "vitest";
import {
  ApplicationAccessRepositoryError,
  createApplicationAccessPrivateRepository,
} from "./helpers/application-access-owner-handoff";
import { fingerprintPermissionMeaning } from "../src/permission-fingerprints";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const applicationRootId = id(10);
const permission: PermissionDeclaration = {
  permissionId: id(20),
  key: "example.orders.read",
  label: "View orders",
  description: "View orders in the example application.",
  actionKind: "read",
  administrative: false,
};
const applicationRelease = {
  kind: "application" as const,
  definitionKey: "example.orders",
  rootId: applicationRootId,
  releaseRevision: 3,
  releaseVersion: "1.2.0",
  validationContractVersion: "2.17.0",
  contentFingerprint: `sha256:${"1".repeat(64)}`,
  resolutionFingerprint: `sha256:${"2".repeat(64)}`,
};

const preparedTemplates = (): PreparedApplicationRoleTemplates => {
  const applicationCatalogueFingerprint = fingerprintCanonicalValue([permission]);
  const entry = {
    applicationRootId,
    ownerKind: "application" as const,
    ownerId: applicationRootId,
    permission,
    sourceRelease: applicationRelease,
    meaningFingerprint: fingerprintPermissionMeaning("application", applicationRootId, permission),
  };
  const registrationCore = {
    contractVersion: "1.0.0" as const,
    organizationId: id(1),
    applicationRootId,
    applicationRelease,
    applicationCatalogueFingerprint,
    applicationPermissionIds: [permission.permissionId],
    entries: [entry],
  };
  const template = {
    roleId: id(30),
    key: "reader",
    name: "Reader",
    homePageId: id(40),
    permissionKeys: [permission.key],
    permissionSelection: { kind: "exact" as const },
  };
  const core = {
    contractVersion: "1.0.0" as const,
    preparationBasis: { kind: "registration_candidate" as const },
    permissionRegistration: {
      ...registrationCore,
      candidateFingerprint: fingerprintCanonicalValue(registrationCore),
    },
    templates: [
      {
        template,
        sourceTemplateFingerprint: fingerprintCanonicalValue(template),
        sourcePermissions: [entry],
        livePermissions: [entry],
      },
    ],
  };
  return { ...core, candidateFingerprint: fingerprintCanonicalValue(core) };
};

type QueryCall = Readonly<{ text: string; values: readonly DatabaseValue[] }>;

const transactionFor = (
  responder: (call: QueryCall) => readonly DatabaseRow[],
  calls: QueryCall[] = [],
): RequestDatabaseTransaction => ({
  query: async <Row extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => {
    const call = { text: strings.join("$value"), values };
    calls.push(call);
    return responder(call) as readonly Row[];
  },
});

describe("owner-only application access handoff contract and result binding", () => {
  it("keeps the owner handoff implementation out of the shipping package export", () => {
    const shippingExports = Object.keys(shippingAccess);

    expect(shippingExports).not.toContain("createApplicationAccessPrivateRepository");
    expect(shippingExports).not.toContain("ApplicationAccessRepositoryError");
    expect(shippingExports).not.toContain("applicationAccessRepositoryErrorCodes");
  });

  it("verifies preparation and uses the sole coordinated SQL call", async () => {
    const calls: QueryCall[] = [];
    const prepared = preparedTemplates();
    const repository = createApplicationAccessPrivateRepository(
      transactionFor(
        () => [
          {
            outcome: "changed",
            operation: "register",
            organization_id: id(1),
            application_root_id: applicationRootId,
            registration_state: "active",
            registration_revision: "1",
            access_version: 3n,
            correlation_id: id(3),
          },
        ],
        calls,
      ),
    );

    await expect(
      repository.change({
        operation: "register",
        preparedTemplates: prepared,
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).resolves.toMatchObject({ outcome: "changed", registrationRevision: 1, accessVersion: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_access.coordinate_application_access_change");
    expect(calls[0]?.text).not.toContain("apply_application_permission_registration");
    expect(calls[0]?.values.slice(0, 2)).toEqual(["register", null]);
    expect(JSON.parse(String(calls[0]?.values[2]))).toEqual(prepared);
    expect(calls[0]?.values.slice(3)).toEqual([id(1), applicationRootId, id(2), id(3)]);
  });

  it("keeps withdrawal independent from prepared Definition evidence", async () => {
    const calls: QueryCall[] = [];
    const repository = createApplicationAccessPrivateRepository(
      transactionFor(
        () => [
          {
            outcome: "changed",
            operation: "withdraw",
            organization_id: id(1),
            application_root_id: applicationRootId,
            registration_state: "withdrawn",
            registration_revision: "4",
            access_version: "8",
            correlation_id: id(3),
          },
        ],
        calls,
      ),
    );

    await expect(
      repository.change({
        operation: "withdraw",
        organizationId: id(1),
        applicationRootId,
        expectedRevision: 3,
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).resolves.toMatchObject({ operation: "withdraw", registrationState: "withdrawn" });
    expect(calls[0]?.values[2]).toBeNull();
  });

  it("refuses tampered preparation before storage", async () => {
    const calls: QueryCall[] = [];
    const repository = createApplicationAccessPrivateRepository(transactionFor(() => [], calls));
    const prepared = {
      ...preparedTemplates(),
      candidateFingerprint: `sha256:${"0".repeat(64)}`,
    } as PreparedApplicationRoleTemplates;

    await expect(
      repository.change({
        operation: "update",
        expectedRevision: 1,
        preparedTemplates: prepared,
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).rejects.toMatchObject({ code: "INVALID_APPLICATION_ACCESS_COMMAND" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["organization", { organization_id: id(99) }],
    ["application", { application_root_id: id(99) }],
    ["operation", { operation: "reactivate" }],
    ["correlation", { correlation_id: id(99) }],
    ["registration revision", { registration_revision: "2" }],
  ])("refuses a valid-shaped result with the wrong %s", async (_field, override) => {
    const repository = createApplicationAccessPrivateRepository(
      transactionFor(() => [
        {
          outcome: "changed",
          operation: "register",
          organization_id: id(1),
          application_root_id: applicationRootId,
          registration_state: "active",
          registration_revision: "1",
          access_version: "3",
          correlation_id: id(3),
          ...override,
        },
      ]),
    );

    await expect(
      repository.change({
        operation: "register",
        preparedTemplates: preparedTemplates(),
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).rejects.toMatchObject({ code: "INVALID_APPLICATION_ACCESS_STORAGE_RESULT" });
  });

  it("binds changed and unchanged revisions to the requested transition", async () => {
    const wrongChangedRevision = createApplicationAccessPrivateRepository(
      transactionFor(() => [
        {
          outcome: "changed",
          operation: "update",
          organization_id: id(1),
          application_root_id: applicationRootId,
          registration_state: "active",
          registration_revision: "3",
          access_version: "7",
          correlation_id: id(3),
        },
      ]),
    );
    await expect(
      wrongChangedRevision.change({
        operation: "update",
        expectedRevision: 3,
        preparedTemplates: preparedTemplates(),
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).rejects.toMatchObject({ code: "INVALID_APPLICATION_ACCESS_STORAGE_RESULT" });

    const wrongUnchangedRevision = createApplicationAccessPrivateRepository(
      transactionFor(() => [
        {
          outcome: "unchanged",
          operation: "update",
          organization_id: id(1),
          application_root_id: applicationRootId,
          registration_state: "active",
          registration_revision: "4",
          access_version: "7",
          correlation_id: id(3),
        },
      ]),
    );
    await expect(
      wrongUnchangedRevision.change({
        operation: "update",
        expectedRevision: 3,
        preparedTemplates: preparedTemplates(),
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).rejects.toMatchObject({ code: "INVALID_APPLICATION_ACCESS_STORAGE_RESULT" });
  });

  it("parses unchanged explicitly and maps malformed/private failures", async () => {
    const unchanged = createApplicationAccessPrivateRepository(
      transactionFor(() => [
        {
          outcome: "unchanged",
          operation: "update",
          organization_id: id(1),
          application_root_id: applicationRootId,
          registration_state: "active",
          registration_revision: "3",
          access_version: "7",
          correlation_id: id(3),
        },
      ]),
    );
    await expect(
      unchanged.change({
        operation: "update",
        expectedRevision: 3,
        preparedTemplates: preparedTemplates(),
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).resolves.toMatchObject({ outcome: "unchanged", registrationRevision: 3 });

    const malformed = createApplicationAccessPrivateRepository(
      transactionFor(() => [{ outcome: "changed" }]),
    );
    await expect(
      malformed.change({
        operation: "register",
        preparedTemplates: preparedTemplates(),
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).rejects.toMatchObject({ code: "INVALID_APPLICATION_ACCESS_STORAGE_RESULT" });

    const failed = createApplicationAccessPrivateRepository({
      query: async () => {
        throw { code: "55000", message: "sensitive database detail" };
      },
    });
    await expect(
      failed.change({
        operation: "register",
        preparedTemplates: preparedTemplates(),
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).rejects.toEqual(
      new ApplicationAccessRepositoryError("APPLICATION_ACCESS_STALE_OR_UNAVAILABLE"),
    );
  });
});
