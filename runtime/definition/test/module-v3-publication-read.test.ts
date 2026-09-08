import {
  moduleVersionImpactHistoryEntryV3Schema,
  sessionContextSchema,
  storedDefinitionDraftSchema,
  type PublishDefinitionResult,
  type SessionContext,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { compileDefinition } from "../src/compiler";
import { createDefinitionConsumerReadService } from "../src/definition-consumer-read";
import {
  createDefinitionHistoryService,
  type DefinitionHistoryRepository,
} from "../src/definition-history";
import {
  createDefinitionPublicationService,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationReader,
  type DefinitionPublicationRepository,
  type DefinitionPublicationTransaction,
  type DefinitionReleaseAppend,
  type ResolvableModuleRelease,
} from "../src/definition-publication";
import { createDatabaseDefinitionPublicationRepository } from "../src/definition-publication-repository";
import { extractStoredSourceIdentityRequirements } from "../src/source-identities";
import { graphModuleRequests } from "./module-v3-fixtures";

const requests = graphModuleRequests();
const sharedRequest = requests.find((request) => request.source.key === "example.shared")!;
const candidateRequest = requests.find((request) => request.source.key === "example.candidate")!;
const sharedOutput = compileDefinition(sharedRequest);
const timestamp = "2026-09-09T00:00:00Z";
const candidateDefinition = candidateRequest.resolution.definitions.find(
  (definition) => definition.kind === "module" && definition.key === candidateRequest.source.key,
);
if (candidateDefinition?.kind !== "module") throw new Error("Candidate Module root required");
const candidateDraft = storedDefinitionDraftSchema.parse({
  kind: "module",
  rootId: candidateDefinition.rootId,
  key: candidateRequest.source.key,
  draftRevision: 1,
  sourceContractVersion: "3.0.0",
  sourceFingerprint: fingerprintCanonicalValue(candidateRequest.source),
  source: candidateRequest.source,
  ...candidateRequest.draftMetadata,
});
const publicationCandidate: DefinitionPublicationCandidate = {
  draft: candidateDraft,
  identities: candidateRequest.resolution.identities.filter(
    (identity) => identity.definitionKey === candidateRequest.source.key,
  ),
  history: { kind: "module", definitionKey: candidateRequest.source.key, history: [] },
};

const context = (): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "system",
    tenantId: "10000000-0000-4000-8000-000000000010",
    organizationId: candidateRequest.draftMetadata.organizationId,
    systemActorId: candidateRequest.draftMetadata.createdBy,
    sessionId: "10000000-0000-4000-8000-000000000011",
    authenticationStrength: "service",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    accessVersion: 1,
    correlationId: "10000000-0000-4000-8000-000000000012",
  });

const catalogue: DefinitionPublicationCatalogue = {
  listConnectionTypeReleases: async () => [],
  readConnectionTypeRelease: async () => undefined,
  readPlatformThemeRelease: async () => undefined,
  readPlatformBlockReleaseV2: async () => undefined,
  readPlatformThemeReleaseV2: async () => undefined,
  readApplicationCompositionCatalogueSnapshotV2: async () => undefined,
};

const sharedRelease: ResolvableModuleRelease = {
  organizationId: sharedRequest.draftMetadata.organizationId,
  key: sharedRequest.source.key,
  rootId: sharedOutput.artifact.rootId,
  releaseRevision: 1,
  releaseVersion: "1.0.0",
  contentFingerprint: sharedOutput.artifact.contentFingerprint,
  resolutionFingerprint: sharedOutput.resolutionFingerprint,
  compilationOutput: sharedOutput,
  resolutionSnapshot: sharedRequest.resolution,
  published: moduleVersionImpactHistoryEntryV3Schema.parse({
    publication: {
      kind: "module",
      rootId: sharedOutput.artifact.rootId,
      revision: 1,
      releaseVersion: "1.0.0",
      contentFingerprint: sharedOutput.artifact.contentFingerprint,
      publishedAt: timestamp,
      publishedBy: sharedRequest.draftMetadata.createdBy,
      validationContractVersion: "3.0.0",
    },
    content: sharedOutput.canonical.content,
    dependencyManifest: [],
    releaseNote: "Shared graph dependency",
  }),
};

class ModuleV3PublicationRepository
  implements
    DefinitionPublicationRepository,
    DefinitionPublicationReader,
    DefinitionPublicationTransaction
{
  appended?: DefinitionReleaseAppend;

  constructor(readonly candidate: DefinitionPublicationCandidate) {}

  read<Result>(
    _context: SessionContext,
    operation: (reader: DefinitionPublicationReader) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  transaction<Result>(
    _context: SessionContext,
    operation: (transaction: DefinitionPublicationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  async readCandidate() {
    return structuredClone(this.candidate);
  }

  async lockCandidate() {
    return structuredClone(this.candidate);
  }

  async listModuleReleases(_organizationId: string, key: string) {
    return key === sharedRelease.key ? [sharedRelease] : [];
  }

  async readModuleRelease(_organizationId: string, rootId: string, releaseRevision: number) {
    return rootId === sharedRelease.rootId && releaseRevision === sharedRelease.releaseRevision
      ? sharedRelease
      : undefined;
  }

  async appendRelease(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult> {
    this.appended = release;
    return {
      rootId: release.draft.rootId,
      releaseRevision: release.draft.draftRevision,
      releaseVersion: release.assignedVersion,
      contentFingerprint: release.compilationOutput.artifact.contentFingerprint,
      resolutionFingerprint: release.compilationOutput.resolutionFingerprint,
      comparisonFingerprint: release.comparisonFingerprint,
      dependencyManifest: [...release.dependencyManifest],
      publishedAt: timestamp,
      publishedBy: candidateRequest.draftMetadata.updatedBy,
    };
  }
}

describe("Module V3 publication, read and restore", () => {
  it("publishes and projects one exact graph Module with its exact Module dependency", async () => {
    const source = candidateRequest.source;
    const draft = candidateDraft;
    const repository = new ModuleV3PublicationRepository(publicationCandidate);
    const publication = createDefinitionPublicationService(repository, catalogue);
    const prepared = await publication.prepare(context(), {
      rootId: draft.rootId,
      expectedDraftRevision: 1,
    });
    await publication.publish(context(), {
      confirmation: prepared.confirmation,
      releaseNote: "Candidate graph Module",
    });

    const appended = repository.appended;
    if (
      appended === undefined ||
      appended.compilationOutput.kind !== "module" ||
      !("validationContractVersion" in appended.compilationOutput)
    )
      throw new Error("Module V3 append required");
    expect(appended.validationContractVersion).toBe("3.0.0");
    expect(appended.compilationOutput.validationContractVersion).toBe("3.0.0");
    expect(appended.dependencyManifest).toEqual([
      expect.objectContaining({
        kind: "module",
        key: sharedRelease.key,
        rootId: sharedRelease.rootId,
        releaseRevision: sharedRelease.releaseRevision,
      }),
    ]);

    const evidence = {
      organizationId: candidateRequest.draftMetadata.organizationId,
      kind: "module" as const,
      key: source.key,
      rootId: draft.rootId,
      releaseRevision: 1,
      releaseVersion: "1.0.0",
      sourceContractVersion: "3.0.0",
      validationContractVersion: "3.0.0",
      contentFingerprint: appended.compilationOutput.artifact.contentFingerprint,
      resolutionFingerprint: appended.compilationOutput.resolutionFingerprint,
      compilationOutput: appended.compilationOutput,
      resolutionSnapshot: appended.resolutionSnapshot,
      dependencyManifest: appended.dependencyManifest,
      moduleDependencyTargets: [
        {
          rootId: sharedRelease.rootId,
          releaseRevision: sharedRelease.releaseRevision,
          releaseVersion: sharedRelease.releaseVersion,
          contentFingerprint: sharedRelease.contentFingerprint,
          resolutionFingerprint: sharedRelease.resolutionFingerprint,
        },
      ],
    };
    const read = await createDefinitionConsumerReadService(
      { read: async () => evidence },
      catalogue,
    ).read(context(), {
      kind: "module",
      rootId: draft.rootId,
      selector: { selection: "revision", releaseRevision: 1 },
    });
    expect(read).toMatchObject({
      kind: "module",
      validationContractVersion: "3.0.0",
      content: appended.compilationOutput.canonical.content,
    });

    const identityEvidence = extractStoredSourceIdentityRequirements(source).flatMap(
      (requirement) =>
        requirement.aliases.map((alias) => {
          const identity = appended.resolutionSnapshot.identities.find(
            (entry) =>
              entry.definitionKey === source.key &&
              entry.scope === requirement.scope &&
              entry.kind === requirement.kind &&
              entry.componentOwner === requirement.componentOwner &&
              entry.alias === alias,
          );
          if (identity === undefined) throw new Error("Restore identity evidence required");
          return { ...identity, ownerScope: requirement.ownerScope };
        }),
    );
    const restored = storedDefinitionDraftSchema.parse({
      ...draft,
      draftRevision: 2,
      publishedRevision: 1,
      restoredFromReleaseRevision: 1,
      restoredFromSourceFingerprint: draft.sourceFingerprint,
      restoredBy: context().systemActorId,
      restoredAt: candidateRequest.draftMetadata.updatedAt,
      restoreCorrelationId: context().correlationId,
    });
    const historyRepository: DefinitionHistoryRepository = {
      list: async () => undefined,
      readMetadata: async () => undefined,
      restore: async (_context, _command, verify) => {
        await verify({
          ...evidence,
          authoredSource: source,
          sourceFingerprint: draft.sourceFingerprint,
          identityEvidence,
        });
        return { outcome: "restored", draft: restored };
      },
    };
    await expect(
      createDefinitionHistoryService(historyRepository, catalogue).restoreDraft(context(), {
        kind: "module",
        rootId: draft.rootId,
        targetReleaseRevision: 1,
        expectedDraftRevision: 1,
      }),
    ).resolves.toMatchObject({ sourceContractVersion: "3.0.0", source });
  });

  it("decodes the exact V3 draft and graph identities from publication storage", async () => {
    const transaction: RequestDatabaseTransaction = {
      query: async <ResultRow extends DatabaseRow>() =>
        [
          {
            publication_state: {
              root: {
                rootId: candidateDraft.rootId,
                organizationId: candidateDraft.organizationId,
                kind: "module",
                key: candidateDraft.key,
                currentReleaseRevision: null,
                createdAt: candidateDraft.createdAt,
                createdBy: candidateDraft.createdBy,
              },
              draft: candidateDraft,
              identities: publicationCandidate.identities,
              history: {
                kind: "module",
                definitionKey: candidateDraft.key,
                history: [],
              },
            },
          },
        ] as readonly ResultRow[],
    };
    const repository = createDatabaseDefinitionPublicationRepository(transaction);
    await expect(
      repository.read(context(), (reader) => reader.readCandidate(String(candidateDraft.rootId))),
    ).resolves.toMatchObject({
      draft: { sourceContractVersion: "3.0.0", source: candidateRequest.source },
      identities: expect.arrayContaining([
        expect.objectContaining({ kind: "rule_node", componentOwner: "start" }),
      ]),
    });
  });

  it("refuses relabelled V3 consumer evidence", async () => {
    const evidence = {
      organizationId: candidateRequest.draftMetadata.organizationId,
      kind: "module" as const,
      key: sharedRelease.key,
      rootId: sharedRelease.rootId,
      releaseRevision: sharedRelease.releaseRevision,
      releaseVersion: sharedRelease.releaseVersion,
      sourceContractVersion: "3.0.0",
      validationContractVersion: "2.0.0",
      contentFingerprint: sharedRelease.contentFingerprint,
      resolutionFingerprint: sharedRelease.resolutionFingerprint,
      compilationOutput: sharedRelease.compilationOutput,
      resolutionSnapshot: sharedRelease.resolutionSnapshot,
      dependencyManifest: [],
      moduleDependencyTargets: [],
    };
    await expect(
      createDefinitionConsumerReadService({ read: async () => evidence }, catalogue).read(
        context(),
        {
          kind: "module",
          rootId: sharedRelease.rootId,
          selector: { selection: "revision", releaseRevision: 1 },
        },
      ),
    ).rejects.toMatchObject({ code: "DEFINITION_RELEASE_INTEGRITY_FAILED" });
  });
});
