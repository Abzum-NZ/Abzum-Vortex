import fs from "node:fs";
import path from "node:path";
import {
  applicationSourceDocumentSchema,
  connectionTypeSourceDocumentSchema,
  definitionResolutionSnapshotSchema,
  fingerprintSchema,
  moduleSourceDocumentSchema,
  publishedModuleDefinitionSchema,
  sessionContextSchema,
  storedDefinitionDraftSchema,
  type ApplicationSourceDocument,
  type SessionContext,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { compileDefinition } from "../src/compiler";
import { createImmutableDefinitionPublicationCatalogue } from "../src/definition-publication-catalogue";
import {
  createDefinitionPublicationService,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationReader,
  type DefinitionPublicationRepository,
  type ResolvableModuleRelease,
} from "../src/definition-publication";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../testing/fixtures");
const fixtureJson = (relativePath: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(fixtureRoot, relativePath), "utf8"));
const baseResolution = definitionResolutionSnapshotSchema.parse(
  fixtureJson("definition-resolution-snapshot.json"),
);
const connectionSources = ["email.json", "calendar.json"].map((name) => {
  const source = connectionTypeSourceDocumentSchema.parse(fixtureJson(`connection-types/${name}`));
  const resolved = baseResolution.definitions.find(
    (definition) => definition.kind === "connection_type" && definition.key === source.key,
  );
  if (resolved?.kind !== "connection_type") throw new Error("Connection fixture missing");
  return { source, rootId: resolved.rootId };
});
const moduleSources = fs
  .readdirSync(path.join(fixtureRoot, "modules"))
  .filter((name) => name.endsWith(".json"))
  .map((name) => moduleSourceDocumentSchema.parse(fixtureJson(`modules/${name}`)));
const organizationId = "10000000-0000-4000-a000-000000000001";
const actorId = "10000000-0000-4000-a000-000000000002";
const publishedAt = "2026-09-04T00:00:00.000Z";
const themeId = "70000000-0000-4000-8000-000000000001";
const themeContentFingerprint = fingerprintSchema.parse(`sha256:${"c".repeat(64)}`);
const savedConditionRevisions = [
  {
    conditionId: "a4b5546d-8a54-4003-adc4-ddb8b0d7257d",
    revision: 1,
  },
] as const;

const context = (): SessionContext =>
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
    correlationId: "50000000-0000-4000-8000-000000000001",
  });

const draftMetadata = {
  organizationId,
  draftRevision: 1,
  createdAt: publishedAt,
  createdBy: actorId,
  updatedAt: publishedAt,
  updatedBy: actorId,
} as const;

const moduleReleases = (): ResolvableModuleRelease[] => {
  const outputs = moduleSources.map((source) => {
    const output = compileDefinition({
      source,
      resolution: baseResolution,
      draftMetadata,
      savedConditionRevisions,
    });
    if (output.kind !== "module") throw new Error("Module output required");
    return output;
  });
  const references = new Map(
    outputs.map((output) => [
      String(output.artifact.rootId),
      {
        kind: "module" as const,
        rootId: output.artifact.rootId,
        revision: 1,
        releaseVersion: "1.0.0",
        contentFingerprint: output.artifact.contentFingerprint,
        publishedAt,
        publishedBy: actorId,
        validationContractVersion: "1.0.0",
      },
    ]),
  );
  return outputs.map((output) => {
    const dependencyManifest = output.canonical.content.dependencies.map((dependency) => {
      const reference = references.get(String(dependency.moduleRootId));
      if (!reference) throw new Error("Module dependency fixture missing");
      return reference;
    });
    const published = publishedModuleDefinitionSchema.parse({
      publication: references.get(String(output.artifact.rootId)),
      content: output.canonical.content,
      dependencyManifest,
      releaseNote: "Fixture release",
    });
    return {
      organizationId: context().organizationId,
      key: output.canonical.envelope.key,
      rootId: output.artifact.rootId,
      releaseRevision: 1,
      releaseVersion: "1.0.0",
      contentFingerprint: output.artifact.contentFingerprint,
      resolutionFingerprint: output.resolutionFingerprint,
      published,
      compilationOutput: output,
      resolutionSnapshot: baseResolution,
    };
  });
};

const applicationCandidate = (): DefinitionPublicationCandidate => {
  const source = structuredClone(
    applicationSourceDocumentSchema.parse(fixtureJson("applications/crm.json")),
  ) as ApplicationSourceDocument;
  const email = source.body.connection_bindings.find(
    (binding) => binding.connection_type === "vortex.connection.email",
  );
  if (!email) throw new Error("Email binding fixture missing");
  email.version = { selection: "allowed_range", expression: ">=1.0.0 <2.0.0" };
  source.body.theme = {
    mode: "platform",
    catalogue_theme_id: themeId,
    version: "2.1.0",
  };
  const own = baseResolution.definitions.find(
    (definition) => definition.kind === "application" && definition.key === source.key,
  );
  if (own?.kind !== "application") throw new Error("Application fixture missing");
  const draft = storedDefinitionDraftSchema.parse({
    kind: "application",
    rootId: own.rootId,
    organizationId,
    key: source.key,
    draftRevision: 1,
    sourceContractVersion: source.source_contract_version,
    sourceFingerprint: fingerprintCanonicalValue(source),
    source,
    createdAt: publishedAt,
    createdBy: actorId,
    updatedAt: publishedAt,
    updatedBy: actorId,
  });
  return {
    draft,
    identities: baseResolution.identities.filter(
      (identity) => identity.definitionKey === source.key,
    ),
    history: { kind: "application", definitionKey: source.key, history: [] },
  };
};

class PreparationRepository
  implements DefinitionPublicationRepository, DefinitionPublicationReader
{
  constructor(
    private readonly candidate: DefinitionPublicationCandidate,
    private readonly releases: readonly ResolvableModuleRelease[],
  ) {}

  read<Result>(
    _context: SessionContext,
    operation: (reader: DefinitionPublicationReader) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  async transaction<Result>(): Promise<Result> {
    throw new Error("Preparation must not open a write transaction");
  }

  async readCandidate(): Promise<DefinitionPublicationCandidate> {
    return structuredClone(this.candidate);
  }

  async listModuleReleases(_organizationId: string, key: string) {
    return this.releases.filter((release) => release.key === key);
  }

  async readModuleRelease(_organizationId: string, rootId: string, releaseRevision: number) {
    return this.releases.find(
      (release) => String(release.rootId) === rootId && release.releaseRevision === releaseRevision,
    );
  }
}

const catalogueFor = (includeTheme = true) =>
  createImmutableDefinitionPublicationCatalogue({
    connectionTypeReleases: [
      { ...connectionSources[0]!, releaseVersion: "1.0.0" },
      { ...connectionSources[0]!, releaseVersion: "1.6.0" },
      { ...connectionSources[1]!, releaseVersion: "1.0.0" },
      { ...connectionSources[1]!, releaseVersion: "1.5.0" },
    ],
    platformThemeReleases: includeTheme
      ? [
          {
            catalogueThemeId: themeId,
            releaseVersion: "2.1.0",
            contentFingerprint: themeContentFingerprint,
          },
        ]
      : [],
  });

describe("Application publication preparation with the platform catalogue", () => {
  it("resolves an exact connection, the highest stable allowed range, and an exact theme", async () => {
    const candidate = applicationCandidate();
    const repository = new PreparationRepository(candidate, moduleReleases());
    const service = createDefinitionPublicationService(repository, catalogueFor());

    const prepared = await service.prepare(context(), {
      rootId: candidate.draft.rootId,
      expectedDraftRevision: 1,
    });

    const connections = prepared.confirmation.dependencyManifest.filter(
      (dependency) => dependency.kind === "connection_type",
    );
    expect(connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "vortex.connection.email", releaseVersion: "1.6.0" }),
        expect.objectContaining({ key: "vortex.connection.calendar", releaseVersion: "1.0.0" }),
      ]),
    );
    expect(prepared.confirmation.dependencyManifest).toContainEqual(
      expect.objectContaining({
        kind: "platform_theme",
        catalogueThemeId: themeId,
        releaseVersion: "2.1.0",
        contentFingerprint: themeContentFingerprint,
      }),
    );
  });

  it("refuses preparation when exact platform-theme evidence is missing", async () => {
    const candidate = applicationCandidate();
    const repository = new PreparationRepository(candidate, moduleReleases());
    const service = createDefinitionPublicationService(repository, catalogueFor(false));

    await expect(
      service.prepare(context(), {
        rootId: candidate.draft.rootId,
        expectedDraftRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "DEFINITION_DEPENDENCY_MISSING" });
  });
});
