import {
  definitionResolutionSnapshotSchema,
  definitionSourceDocumentSchema,
  sessionContextSchema,
  storedDefinitionDraftSchema,
  type DefinitionSourceDocument,
  type PublishedDefinitionHistory,
  type SessionContext,
  type StoredDefinitionDraft,
} from "@vortex/contracts";
import { describe, expect, it, vi } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import {
  createDefinitionHistoryService,
  type DefinitionHistoryRepository,
} from "../src/definition-history";
import { compileDefinition } from "../src/compiler";
import {
  createDefinitionPublicationService,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationReader,
  type DefinitionPublicationRepository,
  type DefinitionPublicationTransaction,
  type DefinitionReleaseAppend,
} from "../src/definition-publication";
import { extractSourceIdentityRequirements } from "../src/source-identities";

const organizationId = "10000000-0000-4000-a000-000000000001";
const actorId = "10000000-0000-4000-a000-000000000002";
const rootId = "10000000-0000-4000-a000-000000000003";
const correlationId = "10000000-0000-4000-a000-000000000004";
const publishedAt = "2026-09-04T00:00:00.000Z";
const fingerprint = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

const context = (overrides: Partial<SessionContext> = {}): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "system",
    tenantId: "10000000-0000-4000-a000-000000000005",
    organizationId,
    systemActorId: actorId,
    sessionId: "10000000-0000-4000-a000-000000000006",
    authenticationStrength: "service",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    accessVersion: 1,
    correlationId,
    ...overrides,
  });

const source: DefinitionSourceDocument = definitionSourceDocumentSchema.parse({
  source_contract_version: "1.0.0",
  kind: "module",
  root_alias: "module_alpha",
  key: "vortex.example.records",
  body: {
    name: "Example records",
    description: "A neutral definition used only to verify definition infrastructure.",
    dependencies: [],
    record_types: [
      {
        id: "record_alpha",
        storage_contract_id: "storage_alpha",
        key: "entry",
        name: "Entry",
        plural_name: "Entries",
        storage_scope: "organisation_shared",
        ownership_mode: "none",
        title_field: "label",
        standard_actions: ["read"],
        custom_actions: [],
        fields: [
          {
            id: "field_alpha",
            key: "label",
            type: "text",
            label: "Label",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { max_length: 120 },
          },
        ],
        relationships: [],
      },
    ],
    permissions: [],
    actions: [],
    events: [],
    rules: [],
    extension_points: [],
    sharing_conditions: [],
  },
});

const snapshot = (() => {
  const requirements = extractSourceIdentityRequirements(source);
  let nextIdentifier = 10;
  const identities = requirements.flatMap((requirement) => {
    const identifier =
      requirement.kind === "root"
        ? rootId
        : `10000000-0000-4000-a000-${String(nextIdentifier++).padStart(12, "0")}`;
    return requirement.aliases.map((alias) => ({
      definitionKey: requirement.definitionKey,
      scope: requirement.scope,
      kind: requirement.kind,
      componentOwner: requirement.componentOwner,
      alias,
      identifier,
    }));
  });
  const evidence = {
    contractVersion: "1.0.0" as const,
    definitions: [{ kind: "module" as const, key: source.key, rootId, exactVersion: "1.0.0" }],
    identities,
  };
  return definitionResolutionSnapshotSchema.parse({
    ...evidence,
    fingerprint: fingerprintCanonicalValue(evidence),
  });
})();

const output = compileDefinition({
  source,
  resolution: snapshot,
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
if (output.kind !== "module") throw new Error("Expected neutral Module output");

const evidence = () => ({
  organizationId,
  kind: "module" as const,
  key: source.key,
  rootId,
  releaseRevision: 1,
  releaseVersion: "1.0.0",
  authoredSource: source,
  sourceFingerprint: fingerprintCanonicalValue(source),
  sourceContractVersion: "1.0.0" as const,
  contentFingerprint: fingerprintCanonicalValue(output.canonical.content),
  resolutionFingerprint: snapshot.fingerprint,
  validationContractVersion: "1.0.0",
  compilationOutput: output,
  resolutionSnapshot: snapshot,
  dependencyManifest: [],
  moduleDependencyTargets: [],
  identityEvidence: extractSourceIdentityRequirements(source).flatMap((requirement) =>
    requirement.aliases.map((alias) => {
      const matching = snapshot.identities.find(
        (identity) =>
          identity.definitionKey === requirement.definitionKey &&
          identity.scope === requirement.scope &&
          identity.kind === requirement.kind &&
          identity.componentOwner === requirement.componentOwner &&
          identity.alias === alias,
      );
      if (!matching) throw new Error("Missing synthetic identity evidence");
      return { ...matching, ownerScope: requirement.ownerScope };
    }),
  ),
});

const restoredDraft = () =>
  storedDefinitionDraftSchema.parse({
    kind: "module",
    rootId,
    organizationId,
    key: source.key,
    draftRevision: 2,
    publishedRevision: 1,
    source,
    sourceContractVersion: "1.0.0",
    sourceFingerprint: fingerprintCanonicalValue(source),
    createdAt: publishedAt,
    createdBy: actorId,
    updatedAt: "2026-09-04T00:00:01.000Z",
    updatedBy: actorId,
    restoredFromReleaseRevision: 1,
    restoredFromSourceFingerprint: fingerprintCanonicalValue(source),
    restoredBy: actorId,
    restoredAt: "2026-09-04T00:00:01.000Z",
    restoreCorrelationId: correlationId,
  });

const publishedHistory: PublishedDefinitionHistory = {
  kind: "module",
  definitionKey: source.key,
  history: [
    {
      publication: {
        kind: "module",
        rootId,
        revision: 1,
        releaseVersion: "1.0.0",
        contentFingerprint: output.artifact.contentFingerprint,
        publishedAt,
        publishedBy: actorId,
        validationContractVersion: "1.0.0",
      },
      content: output.canonical.content,
      dependencyManifest: [],
      releaseNote: "Initial neutral release",
    },
  ],
};

const publicationRepositoryFor = (draft: StoredDefinitionDraft) => {
  const appends: DefinitionReleaseAppend[] = [];
  const candidate: DefinitionPublicationCandidate = {
    draft,
    identities: snapshot.identities,
    history: publishedHistory,
  };
  const reader: DefinitionPublicationReader = {
    readCandidate: async () => candidate,
    listModuleReleases: async () => [],
    readModuleRelease: async () => undefined,
  };
  const transaction: DefinitionPublicationTransaction = {
    ...reader,
    lockCandidate: async () => candidate,
    appendRelease: async (release) => {
      appends.push(release);
      return {
        rootId: release.draft.rootId,
        releaseRevision: release.draft.draftRevision,
        releaseVersion: release.assignedVersion,
        contentFingerprint: release.compilationOutput.artifact.contentFingerprint,
        resolutionFingerprint: release.compilationOutput.resolutionFingerprint,
        comparisonFingerprint: release.comparisonFingerprint,
        dependencyManifest: release.dependencyManifest,
        publishedAt,
        publishedBy: actorId,
      };
    },
  };
  const repository: DefinitionPublicationRepository = {
    read: async (_context, operation) => operation(reader),
    transaction: async (_context, operation) => operation(transaction),
  };
  return { appends, repository };
};

const catalogue: DefinitionPublicationCatalogue = {
  listConnectionTypeReleases: async () => [],
  readConnectionTypeRelease: async () => undefined,
  readPlatformThemeRelease: async () => undefined,
};

const metadata = (releaseRevision: number, isCurrent = false) => ({
  releaseRevision,
  releaseVersion: `${releaseRevision}.0.0`,
  sourceFingerprint: fingerprint(String(releaseRevision)),
  contentFingerprint: fingerprint(String(releaseRevision + 3)),
  releaseNote: `Release ${releaseRevision}`,
  publishedAt,
  publishedBy: actorId,
  isCurrent,
});

const repositoryFor = (
  overrides: Partial<DefinitionHistoryRepository> = {},
): DefinitionHistoryRepository => ({
  list: async () => ({
    kind: "module",
    organizationId,
    definitionKey: source.key,
    rootId,
    currentReleaseRevision: 3,
    entries: [metadata(3, true), metadata(2)],
    nextBeforeReleaseRevision: 2,
  }),
  readMetadata: async () => ({
    kind: "module",
    organizationId,
    definitionKey: source.key,
    rootId,
    currentReleaseRevision: 3,
    entry: metadata(2),
  }),
  restore: async (_context, _command, verify) => {
    await verify(evidence());
    return { outcome: "restored", draft: restoredDraft() };
  },
  ...overrides,
});

describe("Definition history and restore", () => {
  it("returns a bounded newest-first page and exact safe metadata projection", async () => {
    const service = createDefinitionHistoryService(repositoryFor(), catalogue);
    await expect(service.list(context(), { kind: "module", rootId, pageSize: 2 })).resolves.toEqual(
      {
        kind: "module",
        organizationId,
        definitionKey: source.key,
        rootId,
        currentReleaseRevision: 3,
        entries: [metadata(3, true), metadata(2)],
        nextBeforeReleaseRevision: 2,
        correlationId,
      },
    );
    await expect(
      service.readMetadata(context(), { kind: "module", rootId, releaseRevision: 2 }),
    ).resolves.toMatchObject({ metadata: metadata(2), correlationId });
  });

  it("refuses invalid history commands and contexts before the repository", async () => {
    const repository = repositoryFor({ list: vi.fn(repositoryFor().list) });
    const service = createDefinitionHistoryService(repository, catalogue);
    await expect(
      service.list(context(), { kind: "module", rootId, pageSize: 101 }),
    ).rejects.toMatchObject({
      code: "INVALID_DEFINITION_HISTORY_COMMAND",
    });
    await expect(
      service.list(
        context({
          issuedAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        { kind: "module", rootId, pageSize: 1 },
      ),
    ).rejects.toMatchObject({ code: "DEFINITION_CONTEXT_REFUSED" });
    expect(repository.list).not.toHaveBeenCalled();
  });

  it("maps only the exact missing organisation context failure to context refusal", async () => {
    const command = { kind: "module" as const, rootId, pageSize: 1 };
    const contextFailure = Object.assign(
      new Error("Vortex context organization does not exist in its tenant"),
      { code: "23503" },
    );
    await expect(
      createDefinitionHistoryService(
        repositoryFor({
          list: async () => {
            throw contextFailure;
          },
        }),
        catalogue,
      ).list(context(), command),
    ).rejects.toMatchObject({ code: "DEFINITION_CONTEXT_REFUSED" });

    const unrelatedForeignKey = Object.assign(new Error("unrelated foreign key"), {
      code: "23503",
    });
    await expect(
      createDefinitionHistoryService(
        repositoryFor({
          list: async () => {
            throw unrelatedForeignKey;
          },
        }),
        catalogue,
      ).list(context(), command),
    ).rejects.toMatchObject({ code: "DEFINITION_HISTORY_FAILED" });
  });

  it("maps malformed stored history results and absent roots without leaking storage details", async () => {
    const service = createDefinitionHistoryService(
      repositoryFor({ list: async () => ({ private: "row" }) }),
      catalogue,
    );
    await expect(
      service.list(context(), { kind: "module", rootId, pageSize: 1 }),
    ).rejects.toMatchObject({
      code: "INVALID_DEFINITION_HISTORY_RESULT",
    });
    await expect(
      createDefinitionHistoryService(
        repositoryFor({ list: async () => undefined }),
        catalogue,
      ).list(context(), {
        kind: "module",
        rootId,
        pageSize: 1,
      }),
    ).rejects.toMatchObject({ code: "DEFINITION_HISTORY_NOT_FOUND" });
  });

  it("refuses syntactically valid history metadata substituted from another scope or revision", async () => {
    const otherOrganizationId = "10000000-0000-4000-a000-000000000099";
    const historyService = createDefinitionHistoryService(
      repositoryFor({
        list: async () => ({
          kind: "module",
          organizationId: otherOrganizationId,
          definitionKey: source.key,
          rootId,
          currentReleaseRevision: 3,
          entries: [metadata(3, true)],
        }),
      }),
      catalogue,
    );
    await expect(
      historyService.list(context(), { kind: "module", rootId, pageSize: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_DEFINITION_HISTORY_RESULT" });

    const metadataService = createDefinitionHistoryService(
      repositoryFor({
        readMetadata: async () => ({
          kind: "module",
          organizationId,
          definitionKey: source.key,
          rootId,
          currentReleaseRevision: 3,
          entry: metadata(1),
        }),
      }),
      catalogue,
    );
    await expect(
      metadataService.readMetadata(context(), {
        kind: "module",
        rootId,
        releaseRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DEFINITION_HISTORY_RESULT" });
  });

  it("restores only verified immutable authored source and database-derived provenance", async () => {
    const service = createDefinitionHistoryService(repositoryFor(), catalogue);
    await expect(
      service.restoreDraft(context(), {
        kind: "module",
        rootId,
        targetReleaseRevision: 1,
        expectedDraftRevision: 1,
      }),
    ).resolves.toEqual(restoredDraft());
  });

  it("rejects unsupported Application version pairs before decoding restore evidence", async () => {
    const command = {
      kind: "application" as const,
      rootId,
      targetReleaseRevision: 1,
      expectedDraftRevision: 1,
    };
    const invalidVersions = [
      {
        sourceContractVersion: "1.0.0",
        validationContractVersion: "2.0.0",
        intrinsicSourceContractVersion: "1.0.0",
      },
      {
        sourceContractVersion: "2.0.0",
        validationContractVersion: "2.0.0",
        intrinsicSourceContractVersion: "2.0.0",
      },
      {
        sourceContractVersion: "1.0.0",
        validationContractVersion: "1.0.0",
        intrinsicSourceContractVersion: "2.0.0",
      },
    ];

    for (const versions of invalidVersions) {
      const service = createDefinitionHistoryService(
        repositoryFor({
          restore: async (_context, _command, verify) => {
            await verify({
              kind: "application",
              sourceContractVersion: versions.sourceContractVersion,
              validationContractVersion: versions.validationContractVersion,
              authoredSource: {
                source_contract_version: versions.intrinsicSourceContractVersion,
              },
            });
            return { outcome: "stale" };
          },
        }),
        catalogue,
      );
      await expect(service.restoreDraft(context(), command)).rejects.toMatchObject({
        code: "DEFINITION_RELEASE_INTEGRITY_FAILED",
      });
    }
  });

  it("refuses substituted source, contradictory owner evidence, malformed evidence, and stale drafts", async () => {
    const command = {
      kind: "module" as const,
      rootId,
      targetReleaseRevision: 1,
      expectedDraftRevision: 1,
    };
    const invalidEvidence = [
      { ...evidence(), sourceFingerprint: fingerprint("f") },
      {
        ...evidence(),
        identityEvidence: evidence().identityEvidence.map((entry, index) =>
          index === 0 ? { ...entry, ownerScope: "other" } : entry,
        ),
      },
      { private: "evidence" },
    ];
    for (const [index, candidate] of invalidEvidence.entries()) {
      const service = createDefinitionHistoryService(
        repositoryFor({
          restore: async (_context, _command, verify) => {
            await verify(candidate);
            return { outcome: "stale" };
          },
        }),
        catalogue,
      );
      try {
        await service.restoreDraft(context(), command);
        throw new Error(`Candidate ${index} unexpectedly restored`);
      } catch (error) {
        expect(error, `candidate ${index}`).toMatchObject({
          code:
            candidate === invalidEvidence[2]
              ? "INVALID_DEFINITION_HISTORY_RESULT"
              : "DEFINITION_RELEASE_INTEGRITY_FAILED",
        });
      }
    }
    await expect(
      createDefinitionHistoryService(
        repositoryFor({ restore: async () => ({ outcome: "stale" }) }),
        catalogue,
      ).restoreDraft(context(), command),
    ).rejects.toMatchObject({ code: "DEFINITION_DRAFT_STALE_OR_MISSING" });
  });

  it("refuses a validly shaped restored draft whose scope or provenance was substituted", async () => {
    const command = {
      kind: "module" as const,
      rootId,
      targetReleaseRevision: 1,
      expectedDraftRevision: 1,
    };
    const substitutedDrafts = [
      {
        ...restoredDraft(),
        organizationId: "10000000-0000-4000-a000-000000000099",
      },
      {
        ...restoredDraft(),
        rootId: "10000000-0000-4000-a000-000000000099",
      },
      { ...restoredDraft(), restoredFromReleaseRevision: 2 },
      {
        ...restoredDraft(),
        restoreCorrelationId: "10000000-0000-4000-a000-000000000099",
      },
      {
        ...restoredDraft(),
        sourceFingerprint: fingerprint("f"),
        restoredFromSourceFingerprint: fingerprint("f"),
      },
    ];

    for (const draft of substitutedDrafts) {
      const service = createDefinitionHistoryService(
        repositoryFor({
          restore: async (_context, _command, verify) => {
            await verify(evidence());
            return { outcome: "restored", draft };
          },
        }),
        catalogue,
      );
      await expect(service.restoreDraft(context(), command)).rejects.toMatchObject({
        code: "INVALID_DEFINITION_HISTORY_RESULT",
      });
    }
  });

  it("publishes a restored draft only through the normal latest-release version rules", async () => {
    const unchanged = publicationRepositoryFor(restoredDraft());
    const unchangedPublication = createDefinitionPublicationService(
      unchanged.repository,
      catalogue,
    );
    await expect(
      unchangedPublication.prepare(context(), {
        rootId,
        expectedDraftRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "DEFINITION_NO_CHANGE" });
    expect(unchanged.appends).toHaveLength(0);

    const priorRestore = restoredDraft();
    const changedSource = structuredClone(source);
    if (changedSource.kind !== "module") throw new Error("Expected neutral Module source");
    changedSource.body.description = "A reviewed change to the neutral definition.";
    const changedDraft = storedDefinitionDraftSchema.parse({
      ...priorRestore,
      draftRevision: 3,
      source: changedSource,
      sourceFingerprint: fingerprintCanonicalValue(changedSource),
      updatedAt: "2026-09-04T00:00:02.000Z",
      restoredFromReleaseRevision: undefined,
      restoredFromSourceFingerprint: undefined,
      restoredBy: undefined,
      restoredAt: undefined,
      restoreCorrelationId: undefined,
    });
    const changed = publicationRepositoryFor(changedDraft);
    const changedPublication = createDefinitionPublicationService(changed.repository, catalogue);
    const prepared = await changedPublication.prepare(context(), {
      rootId,
      expectedDraftRevision: 3,
    });
    expect(prepared.confirmation).toMatchObject({
      outcome: "release_required",
      assignedVersion: "1.0.1",
    });

    const published = await changedPublication.publish(context(), {
      confirmation: prepared.confirmation,
      releaseNote: "Publish the reviewed neutral change",
    });
    expect(published.releaseVersion).toBe("1.0.1");
    expect(changed.appends).toHaveLength(1);
    expect(changed.appends[0]).toMatchObject({
      assignedVersion: "1.0.1",
      releaseNote: "Publish the reviewed neutral change",
    });
  });
});
