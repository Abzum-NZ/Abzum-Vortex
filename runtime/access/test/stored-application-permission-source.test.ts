import type { PreparedApplicationPermissionRegistration, SessionContext } from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStoredApplicationPermissionSource } from "../src/stored-application-permission-source";

vi.mock("server-only", () => ({}));

const {
  read,
  prepareApplicationRegistration,
  createReader,
  createBoundReleaseSetService,
} = vi.hoisted(() => {
  const read = vi.fn();
  return {
    read,
    prepareApplicationRegistration: vi.fn(),
    createReader: vi.fn(() => ({ read })),
    createBoundReleaseSetService: vi.fn(),
  };
});

vi.mock("@vortex/definition", () => ({
  createDatabaseDefinitionConsumerReadService: createReader,
  createDatabaseApplicationBoundReleaseSetService: createBoundReleaseSetService,
}));

vi.mock("../src/permission-registry-definition-adapter", () => ({
  createPermissionRegistryDefinitionAdapter: () => ({ prepareApplicationRegistration }),
}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1);
const applicationRootId = id(2);
const correlationId = id(3);
const systemContext: SessionContext = {
  callerKind: "system",
  tenantId: id(4),
  organizationId,
  applicationRootId,
  systemActorId: id(5),
  sessionId: id(6),
  authenticationStrength: "service",
  issuedAt: "2026-09-08T00:00:00.000Z",
  expiresAt: "2026-09-09T00:00:00.000Z",
  accessVersion: 7,
  correlationId,
};
const applicationRelease = {
  kind: "application" as const,
  organizationId,
  definitionKey: "example.application",
  rootId: applicationRootId,
  releaseRevision: 5,
  releaseVersion: "1.0.0",
  validationContractVersion: "1.0.0",
  contentFingerprint: `sha256:${"a".repeat(64)}`,
  resolutionFingerprint: `sha256:${"b".repeat(64)}`,
  dependencyManifest: [],
  correlationId,
  content: { pages: [] },
};
const permissionRegistration: PreparedApplicationPermissionRegistration = {
  organizationId,
  applicationRootId,
  applicationRelease: {
    definitionKey: applicationRelease.definitionKey,
    releaseRevision: applicationRelease.releaseRevision,
    releaseVersion: applicationRelease.releaseVersion,
    validationContractVersion: applicationRelease.validationContractVersion,
    contentFingerprint: applicationRelease.contentFingerprint,
    resolutionFingerprint: applicationRelease.resolutionFingerprint,
  },
  entries: [],
};

describe("stored application permission source", () => {
  beforeEach(() => {
    read.mockReset().mockResolvedValue(applicationRelease);
    prepareApplicationRegistration.mockReset().mockResolvedValue(permissionRegistration);
    createReader.mockClear();
    createBoundReleaseSetService.mockClear();
  });

  it("uses the resolved request transaction for one exact immutable release and registration", async () => {
    const requestTransaction = { query: vi.fn() } as unknown as RequestDatabaseTransaction;
    const resolvedRequestTransaction = vi.fn(async (resolve, operation) => {
      const resolved = await resolve({ query: vi.fn() });
      expect(resolved).toEqual({ context: systemContext, scope: undefined });
      return operation(requestTransaction, resolved.scope);
    });
    const source = createStoredApplicationPermissionSource({
      systemContext,
      applicationRootId,
      releaseRevision: 5,
      definitionCatalogue: { connectionTypeReleases: [], platformThemeReleases: [] },
      resolvedRequestTransaction,
    });

    await expect(source.readExact()).resolves.toEqual({
      applicationRelease,
      permissionRegistration,
    });
    expect(createReader).toHaveBeenCalledWith(
      { connectionTypeReleases: [], platformThemeReleases: [] },
      requestTransaction,
    );
    expect(createBoundReleaseSetService).toHaveBeenCalledWith(
      { connectionTypeReleases: [], platformThemeReleases: [] },
      requestTransaction,
    );
    expect(prepareApplicationRegistration).toHaveBeenCalledWith(systemContext, {
      applicationRootId,
      releaseRevision: 5,
    });
    expect(read).toHaveBeenCalledWith(systemContext, {
      kind: "application",
      rootId: applicationRootId,
      selector: { selection: "revision", releaseRevision: 5 },
    });
  });

  it("refuses a mismatched fixed application before opening a request transaction", () => {
    const resolvedRequestTransaction = vi.fn();
    expect(() =>
      createStoredApplicationPermissionSource({
        systemContext: { ...systemContext, applicationRootId: id(99) },
        applicationRootId,
        releaseRevision: 5,
        definitionCatalogue: { connectionTypeReleases: [], platformThemeReleases: [] },
        resolvedRequestTransaction,
      }),
    ).toThrow("STORED_APPLICATION_SYSTEM_CONTEXT_UNAVAILABLE");
    expect(resolvedRequestTransaction).not.toHaveBeenCalled();
  });

  it("refuses release evidence from another correlation or registered artifact", async () => {
    const run = async (release: typeof applicationRelease) => {
      read.mockResolvedValueOnce(release);
      const source = createStoredApplicationPermissionSource({
        systemContext,
        applicationRootId,
        releaseRevision: 5,
        definitionCatalogue: { connectionTypeReleases: [], platformThemeReleases: [] },
        resolvedRequestTransaction: async (resolve, operation) => {
          const resolved = await resolve({ query: vi.fn() });
          return operation({ query: vi.fn() }, resolved.scope);
        },
      });
      return source.readExact();
    };

    await expect(run({ ...applicationRelease, correlationId: id(98) })).rejects.toThrow(
      "STORED_APPLICATION_DEFINITION_EVIDENCE_UNAVAILABLE",
    );
    await expect(
      run({ ...applicationRelease, contentFingerprint: `sha256:${"c".repeat(64)}` }),
    ).rejects.toThrow("STORED_APPLICATION_DEFINITION_EVIDENCE_UNAVAILABLE");
  });
});
