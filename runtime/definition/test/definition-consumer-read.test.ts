import fs from "node:fs";
import path from "node:path";
import {
  definitionResolutionSnapshotSchema,
  definitionSourceDocumentSchema,
  sessionContextSchema,
  type ExactDefinitionDependency,
  type SessionContext,
} from "@vortex/contracts";
import { describe, expect, it, vi } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { compileDefinition } from "../src/compiler";
import {
  createDefinitionConsumerReadService,
  type DefinitionConsumerReadRepository,
} from "../src/definition-consumer-read";
import type {
  DefinitionPublicationCatalogue,
  ResolvableConnectionTypeRelease,
} from "../src/definition-publication";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../testing/fixtures");
const readSource = (kind: "modules" | "applications", name: string) =>
  definitionSourceDocumentSchema.parse(
    JSON.parse(fs.readFileSync(path.join(fixtureRoot, kind, name), "utf8")),
  );
const resolution = definitionResolutionSnapshotSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "definition-resolution-snapshot.json"), "utf8"),
  ),
);
const organizationId = "10000000-0000-4000-a000-000000000001";
const actorId = "10000000-0000-4000-a000-000000000002";
const correlationId = "50000000-0000-4000-8000-000000000001";
const publishedAt = "2026-09-04T00:00:00.000Z";
const dependencyFingerprint = `sha256:${"d".repeat(64)}`;
const catalogueFingerprint = `sha256:${"e".repeat(64)}`;

const context = (overrides: Partial<SessionContext> = {}): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "system",
    tenantId: "10000000-0000-4000-8000-000000000001",
    organizationId,
    systemActorId: actorId,
    sessionId: "40000000-0000-4000-8000-000000000001",
    authenticationStrength: "service",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    accessVersion: 1,
    correlationId,
    ...overrides,
  });

const compile = (kind: "modules" | "applications", name: string) => {
  const source = readSource(kind, name);
  return compileDefinition({
    source,
    resolution,
    draftMetadata: {
      organizationId,
      draftRevision: 1,
      createdAt: publishedAt,
      createdBy: actorId,
      updatedAt: publishedAt,
      updatedBy: actorId,
    },
    savedConditionRevisions: [],
  });
};

const moduleOutput = compile("modules", "crm.organisations.json");
if (moduleOutput.kind !== "module") throw new Error("Module fixture required");

const applicationOutput = compile("applications", "crm.json");
if (applicationOutput.kind !== "application") throw new Error("Application fixture required");

const definitionKeyFor = (kind: "module" | "connection_type", rootId: string): string => {
  const definition = resolution.definitions.find(
    (candidate) => candidate.kind === kind && candidate.rootId === rootId,
  );
  if (!definition) throw new Error("Resolution fixture is incomplete");
  return definition.key;
};

const applicationManifest: ExactDefinitionDependency[] = [
  ...applicationOutput.canonical.content.connectionBindings.map(
    (binding): ExactDefinitionDependency => ({
      kind: "connection_type",
      key: definitionKeyFor("connection_type", binding.connectionTypeId),
      rootId: binding.connectionTypeId,
      releaseVersion: binding.resolvedVersion,
      contentFingerprint: dependencyFingerprint,
      catalogueFingerprint,
    }),
  ),
  ...applicationOutput.canonical.content.moduleBindings.map(
    (binding): ExactDefinitionDependency => ({
      kind: "module",
      key: definitionKeyFor("module", binding.moduleRootId),
      rootId: binding.moduleRootId,
      releaseRevision: 1,
      releaseVersion: binding.resolvedVersion,
      contentFingerprint: dependencyFingerprint,
      resolutionFingerprint: dependencyFingerprint,
    }),
  ),
].sort((left, right) => {
  const leftSubject = `${left.kind}:${"key" in left ? left.key : left.catalogueThemeId}`;
  const rightSubject = `${right.kind}:${"key" in right ? right.key : right.catalogueThemeId}`;
  return leftSubject.localeCompare(rightSubject);
});

const releaseEvidence = (
  output: typeof moduleOutput | typeof applicationOutput,
  dependencyManifest: readonly ExactDefinitionDependency[],
) => ({
  organizationId,
  kind: output.kind,
  key: output.canonical.envelope.key,
  rootId: output.canonical.envelope.rootId,
  releaseRevision: 1,
  releaseVersion: "1.0.0",
  validationContractVersion: "1.0.0",
  contentFingerprint: fingerprintCanonicalValue(output.canonical.content),
  resolutionFingerprint: resolution.fingerprint,
  compilationOutput: output,
  resolutionSnapshot: resolution,
  dependencyManifest,
  moduleDependencyTargets: dependencyManifest
    .filter((entry) => entry.kind === "module")
    .map((entry) => ({
      rootId: entry.rootId,
      releaseRevision: entry.releaseRevision,
      releaseVersion: entry.releaseVersion,
      contentFingerprint: entry.contentFingerprint,
      resolutionFingerprint: entry.resolutionFingerprint,
    })),
});

const moduleEvidence = releaseEvidence(moduleOutput, []);
const applicationEvidence = releaseEvidence(applicationOutput, applicationManifest);

const catalogueFor = (
  manifest: readonly ExactDefinitionDependency[] = applicationManifest,
): DefinitionPublicationCatalogue => ({
  listConnectionTypeReleases: async () => [],
  readConnectionTypeRelease: async (rootId, releaseVersion) => {
    const entry = manifest.find(
      (candidate) =>
        candidate.kind === "connection_type" &&
        candidate.rootId === rootId &&
        candidate.releaseVersion === releaseVersion,
    );
    if (!entry || entry.kind !== "connection_type") return undefined;
    return {
      key: entry.key,
      rootId: entry.rootId,
      releaseVersion: entry.releaseVersion,
      contentFingerprint: entry.contentFingerprint,
      catalogueFingerprint: entry.catalogueFingerprint,
      compilationOutput: {} as ResolvableConnectionTypeRelease["compilationOutput"],
    };
  },
  readPlatformThemeRelease: async () => undefined,
});

const repositoryFor = (candidate: unknown): DefinitionConsumerReadRepository => ({
  read: vi.fn(async () => candidate),
});

describe("Definition consumer reads", () => {
  it("returns a strict consumer-safe Module projection and copies correlation", async () => {
    const service = createDefinitionConsumerReadService(
      repositoryFor(moduleEvidence),
      catalogueFor(),
    );
    const result = await service.read(context(), {
      kind: "module",
      rootId: moduleEvidence.rootId,
      selector: { selection: "current" },
    });

    expect(result).toEqual({
      kind: "module",
      organizationId,
      definitionKey: moduleEvidence.key,
      rootId: moduleEvidence.rootId,
      releaseRevision: 1,
      releaseVersion: "1.0.0",
      validationContractVersion: "1.0.0",
      contentFingerprint: moduleEvidence.contentFingerprint,
      resolutionFingerprint: resolution.fingerprint,
      content: moduleOutput.canonical.content,
      dependencyManifest: [],
      correlationId,
    });
    expect(result).not.toHaveProperty("compilationOutput");
    expect(result).not.toHaveProperty("resolutionSnapshot");
    expect(result).not.toHaveProperty("publishedAt");
  });

  it("returns an Application only when every exact Module and catalogue entry agrees", async () => {
    const service = createDefinitionConsumerReadService(
      repositoryFor(applicationEvidence),
      catalogueFor(),
    );
    await expect(
      service.read(context(), {
        kind: "application",
        rootId: applicationEvidence.rootId,
        selector: { selection: "revision", releaseRevision: 1 },
      }),
    ).resolves.toMatchObject({
      kind: "application",
      rootId: applicationEvidence.rootId,
      dependencyManifest: applicationManifest,
    });
  });

  it("refuses invalid commands and non-live or non-system contexts before storage", async () => {
    const repository = repositoryFor(moduleEvidence);
    const service = createDefinitionConsumerReadService(repository, catalogueFor());
    await expect(service.read(context(), {})).rejects.toMatchObject({
      code: "INVALID_DEFINITION_READ_COMMAND",
    });
    await expect(
      service.read(
        context({
          issuedAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        { kind: "module", rootId: moduleEvidence.rootId, selector: { selection: "current" } },
      ),
    ).rejects.toMatchObject({ code: "DEFINITION_CONTEXT_REFUSED" });
    expect(repository.read).not.toHaveBeenCalled();
  });

  it("uses one safe not-found outcome and checks an exact selector against returned evidence", async () => {
    const command = {
      kind: "module" as const,
      rootId: moduleEvidence.rootId,
      selector: { selection: "revision" as const, releaseRevision: 2 },
    };
    await expect(
      createDefinitionConsumerReadService(repositoryFor(undefined), catalogueFor()).read(
        context(),
        command,
      ),
    ).rejects.toMatchObject({ code: "DEFINITION_RELEASE_NOT_FOUND" });
    await expect(
      createDefinitionConsumerReadService(repositoryFor(moduleEvidence), catalogueFor()).read(
        context(),
        command,
      ),
    ).rejects.toMatchObject({ code: "DEFINITION_RELEASE_INTEGRITY_FAILED" });
  });

  it("refuses corrupted release, manifest and exact Module-target evidence", async () => {
    const command = {
      kind: "application" as const,
      rootId: applicationEvidence.rootId,
      selector: { selection: "current" as const },
    };
    const invalidCandidates = [
      { ...applicationEvidence, contentFingerprint: dependencyFingerprint },
      {
        ...applicationEvidence,
        dependencyManifest: [...applicationEvidence.dependencyManifest].reverse(),
      },
      {
        ...applicationEvidence,
        moduleDependencyTargets: [
          applicationEvidence.moduleDependencyTargets[0],
          applicationEvidence.moduleDependencyTargets[0],
          ...applicationEvidence.moduleDependencyTargets.slice(2),
        ],
      },
    ];
    for (const candidate of invalidCandidates)
      await expect(
        createDefinitionConsumerReadService(repositoryFor(candidate), catalogueFor()).read(
          context(),
          command,
        ),
      ).rejects.toMatchObject({ code: "DEFINITION_RELEASE_INTEGRITY_FAILED" });
  });

  it("distinguishes a missing exact catalogue release from mismatched catalogue evidence", async () => {
    const command = {
      kind: "application" as const,
      rootId: applicationEvidence.rootId,
      selector: { selection: "current" as const },
    };
    await expect(
      createDefinitionConsumerReadService(
        repositoryFor(applicationEvidence),
        catalogueFor([]),
      ).read(context(), command),
    ).rejects.toMatchObject({ code: "DEFINITION_DEPENDENCY_UNAVAILABLE" });

    const corrupted = applicationManifest.map((entry, index) =>
      index === 0 && entry.kind === "connection_type"
        ? { ...entry, catalogueFingerprint: `sha256:${"f".repeat(64)}` }
        : entry,
    );
    await expect(
      createDefinitionConsumerReadService(
        repositoryFor(applicationEvidence),
        catalogueFor(corrupted),
      ).read(context(), command),
    ).rejects.toMatchObject({ code: "DEFINITION_RELEASE_INTEGRITY_FAILED" });
  });

  it("refuses a platform-theme manifest version that differs from canonical content", async () => {
    const themeId = "70000000-0000-4000-8000-000000000009";
    const mismatchedVersion = "2.2.0";
    const content = {
      ...applicationOutput.canonical.content,
      theme: { mode: "platform" as const, catalogueThemeId: themeId, version: "2.1.0" },
    };
    const contentFingerprint = fingerprintCanonicalValue(content);
    const output = {
      ...applicationOutput,
      canonical: { ...applicationOutput.canonical, content },
      artifact: { ...applicationOutput.artifact, contentFingerprint },
    };
    const themeDependency: ExactDefinitionDependency = {
      kind: "platform_theme",
      catalogueThemeId: themeId,
      releaseVersion: mismatchedVersion,
      contentFingerprint: dependencyFingerprint,
      catalogueFingerprint,
    };
    const manifest = [...applicationManifest, themeDependency].sort((left, right) => {
      const leftSubject = `${left.kind}:${"key" in left ? left.key : left.catalogueThemeId}`;
      const rightSubject = `${right.kind}:${"key" in right ? right.key : right.catalogueThemeId}`;
      return leftSubject.localeCompare(rightSubject);
    });
    const evidence = releaseEvidence(output, manifest);
    const baseCatalogue = catalogueFor(manifest);
    const catalogue: DefinitionPublicationCatalogue = {
      ...baseCatalogue,
      readPlatformThemeRelease: async (catalogueThemeId, releaseVersion) =>
        catalogueThemeId === themeId && releaseVersion === mismatchedVersion
          ? {
              catalogueThemeId: themeId,
              releaseVersion: mismatchedVersion,
              contentFingerprint: dependencyFingerprint,
              catalogueFingerprint,
            }
          : undefined,
    };

    await expect(
      createDefinitionConsumerReadService(repositoryFor(evidence), catalogue).read(context(), {
        kind: "application",
        rootId: evidence.rootId,
        selector: { selection: "current" },
      }),
    ).rejects.toMatchObject({ code: "DEFINITION_RELEASE_INTEGRITY_FAILED" });
  });

  it("maps context and unexpected repository failures to stable safe outcomes", async () => {
    const command = {
      kind: "module" as const,
      rootId: moduleEvidence.rootId,
      selector: { selection: "current" as const },
    };
    await expect(
      createDefinitionConsumerReadService(
        { read: async () => Promise.reject(new Error("EXPIRED_REQUEST_CONTEXT")) },
        catalogueFor(),
      ).read(context(), command),
    ).rejects.toMatchObject({ code: "DEFINITION_CONTEXT_REFUSED" });
    const databaseExpiry = Object.assign(
      new Error("Vortex request context is expired or inconsistent"),
      { code: "22023" },
    );
    await expect(
      createDefinitionConsumerReadService(
        { read: async () => Promise.reject(databaseExpiry) },
        catalogueFor(),
      ).read(context(), command),
    ).rejects.toMatchObject({ code: "DEFINITION_CONTEXT_REFUSED" });
    await expect(
      createDefinitionConsumerReadService(
        { read: async () => Promise.reject(new Error("private storage detail")) },
        catalogueFor(),
      ).read(context(), command),
    ).rejects.toMatchObject({ code: "DEFINITION_READ_FAILED", message: "DEFINITION_READ_FAILED" });
  });
});
