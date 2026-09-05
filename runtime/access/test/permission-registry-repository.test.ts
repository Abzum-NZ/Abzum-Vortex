import type {
  PermissionDeclaration,
  PreparedApplicationPermissionRegistration,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { fingerprintCanonicalValue } from "@vortex/definition";
import { describe, expect, it } from "vitest";
import { fingerprintPermissionMeaning } from "../src/permission-fingerprints";
import {
  createPermissionRegistryPrivateRepository,
  PermissionRegistryRepositoryError,
} from "../src/permission-registry-repository";

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
  validationContractVersion: "2.15.0",
  contentFingerprint: `sha256:${"1".repeat(64)}`,
  resolutionFingerprint: `sha256:${"2".repeat(64)}`,
};

const preparedCandidate = (): PreparedApplicationPermissionRegistration => {
  const applicationCatalogueFingerprint = fingerprintCanonicalValue([permission]);
  const entry = {
    applicationRootId,
    ownerKind: "application" as const,
    ownerId: applicationRootId,
    permission,
    sourceRelease: applicationRelease,
    meaningFingerprint: fingerprintPermissionMeaning("application", applicationRootId, permission),
  };
  const core = {
    contractVersion: "1.0.0" as const,
    organizationId: id(1),
    applicationRootId,
    applicationRelease,
    applicationCatalogueFingerprint,
    applicationPermissionIds: [permission.permissionId],
    entries: [entry],
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

describe("permission registry private repository", () => {
  it("adapts explicit platform initialisation without exposing a default privileged connection", async () => {
    const calls: QueryCall[] = [];
    const repository = createPermissionRegistryPrivateRepository(
      transactionFor(
        () => [{ organization_id: id(1), registration_revision: "1", access_version: 2n }],
        calls,
      ),
    );

    await expect(
      repository.initializePlatformCatalogue({
        organizationId: id(1),
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).resolves.toEqual({ organizationId: id(1), registrationRevision: 1, accessVersion: 2 });
    expect(calls[0]?.text).toContain("vortex_access.initialize_platform_permission_catalogue");
    expect(calls[0]?.values).toEqual([id(1), id(2), id(3)]);
  });

  it("verifies a prepared candidate before calling the owner-only mutation handoff", async () => {
    const calls: QueryCall[] = [];
    const candidate = preparedCandidate();
    const repository = createPermissionRegistryPrivateRepository(
      transactionFor(
        () => [
          {
            operation: "register",
            organization_id: id(1),
            application_root_id: applicationRootId,
            registration_state: "active",
            registration_revision: "1",
            access_version: "3",
            correlation_id: id(3),
          },
        ],
        calls,
      ),
    );

    await expect(
      repository.mutate({
        operation: "register",
        candidate,
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).resolves.toMatchObject({ operation: "register", registrationRevision: 1, accessVersion: 3 });
    expect(calls[0]?.text).toContain("vortex_access.apply_application_permission_registration");
    expect(calls[0]?.values[0]).toBe("register");
    expect(calls[0]?.values[1]).toBeNull();
    expect(JSON.parse(String(calls[0]?.values[2]))).toEqual(candidate);

    const invalid = {
      ...candidate,
      candidateFingerprint: `sha256:${"0".repeat(64)}`,
    };
    await expect(
      repository.mutate({
        operation: "register",
        candidate: invalid,
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).rejects.toMatchObject({ code: "INVALID_PERMISSION_REGISTRY_COMMAND" });
    expect(calls).toHaveLength(1);
  });

  it("maps exact permission rows and preserves application context", async () => {
    const repository = createPermissionRegistryPrivateRepository(
      transactionFor(() => [
        {
          organization_id: id(1),
          application_root_id: applicationRootId,
          registration_revision: "4",
          owner_kind: "application",
          owner_id: applicationRootId,
          permission_id: permission.permissionId,
          permission_key: permission.key,
          label: permission.label,
          description: permission.description,
          record_type_id: null,
          action_kind: "read",
          named_action: null,
          administrative: false,
          source_kind: "application",
          source_definition_key: applicationRelease.definitionKey,
          source_root_id: applicationRootId,
          source_version: applicationRelease.releaseVersion,
          source_revision: "3",
          source_validation_contract_version: applicationRelease.validationContractVersion,
          source_content_fingerprint: applicationRelease.contentFingerprint,
          source_resolution_fingerprint: applicationRelease.resolutionFingerprint,
          source_catalogue_fingerprint: null,
          meaning_fingerprint: fingerprintPermissionMeaning(
            "application",
            applicationRootId,
            permission,
          ),
        },
      ]),
    );

    await expect(
      repository.lookup({
        organizationId: id(1),
        applicationRootId,
        ownerKind: "application",
        ownerId: applicationRootId,
        permissionId: permission.permissionId,
      }),
    ).resolves.toMatchObject({
      outcome: "available",
      entry: {
        applicationRootId,
        registrationRevision: 4,
        sourceRelease: applicationRelease,
      },
    });
  });

  it("maps the owner-qualified platform catalogue evidence without application context", async () => {
    const platformOwnerId = "cabe121e-0baf-4084-9471-cce915d460a8";
    const repository = createPermissionRegistryPrivateRepository(
      transactionFor(() => [
        {
          organization_id: id(1),
          application_root_id: null,
          registration_revision: "1",
          owner_kind: "platform",
          owner_id: platformOwnerId,
          permission_id: id(30),
          permission_key: "platform.organization.permissions.read",
          label: "View available permissions",
          description: "View the selected organisation permission catalogue.",
          record_type_id: null,
          action_kind: "read",
          named_action: null,
          administrative: true,
          source_kind: "platform_catalogue",
          source_definition_key: null,
          source_root_id: null,
          source_version: "1.0.0",
          source_revision: null,
          source_validation_contract_version: null,
          source_content_fingerprint: null,
          source_resolution_fingerprint: null,
          source_catalogue_fingerprint: `sha256:${"3".repeat(64)}`,
          meaning_fingerprint: `sha256:${"4".repeat(64)}`,
        },
      ]),
    );

    await expect(
      repository.lookup({
        organizationId: id(1),
        ownerKind: "platform",
        ownerId: platformOwnerId,
        permissionId: id(30),
      }),
    ).resolves.toMatchObject({
      outcome: "available",
      entry: {
        ownerKind: "platform",
        ownerId: platformOwnerId,
        sourceRelease: { kind: "platform_catalogue", ownerId: platformOwnerId },
      },
    });
  });

  it("returns unavailable lookup/snapshot outcomes and parses a deterministic snapshot", async () => {
    const unavailable = createPermissionRegistryPrivateRepository(transactionFor(() => []));
    await expect(
      unavailable.lookup({
        organizationId: id(1),
        applicationRootId,
        ownerKind: "application",
        ownerId: applicationRootId,
        permissionId: permission.permissionId,
      }),
    ).resolves.toEqual({ outcome: "unavailable" });
    await expect(
      unavailable.readApplicationSnapshot({ organizationId: id(1), applicationRootId }),
    ).resolves.toBeUndefined();

    const repository = createPermissionRegistryPrivateRepository(
      transactionFor(() => [
        {
          organization_id: id(1),
          application_root_id: applicationRootId,
          registration_revision: 2n,
          release_revision: "3",
          definition_key: applicationRelease.definitionKey,
          release_version: applicationRelease.releaseVersion,
          validation_contract_version: applicationRelease.validationContractVersion,
          content_fingerprint: applicationRelease.contentFingerprint,
          resolution_fingerprint: applicationRelease.resolutionFingerprint,
          catalogue_fingerprint: fingerprintCanonicalValue([permission]),
          permission_ids: [permission.permissionId],
        },
      ]),
    );
    await expect(
      repository.readApplicationSnapshot({ organizationId: id(1), applicationRootId }),
    ).resolves.toMatchObject({ registrationRevision: 2, permissionIds: [permission.permissionId] });
  });

  it("rejects malformed storage and maps database details to closed errors", async () => {
    const malformed = createPermissionRegistryPrivateRepository(
      transactionFor(() => [{ operation: "register" }]),
    );
    await expect(
      malformed.mutate({
        operation: "register",
        candidate: preparedCandidate(),
        changedBy: id(2),
        correlationId: id(3),
      }),
    ).rejects.toMatchObject({ code: "INVALID_PERMISSION_REGISTRY_STORAGE_RESULT" });

    const failed = createPermissionRegistryPrivateRepository({
      query: async () => {
        throw { code: "40001", message: "sensitive database detail" };
      },
    });
    await expect(
      failed.readApplicationSnapshot({ organizationId: id(1), applicationRootId }),
    ).rejects.toEqual(
      new PermissionRegistryRepositoryError("PERMISSION_REGISTRY_STALE_OR_UNAVAILABLE"),
    );
  });
});
