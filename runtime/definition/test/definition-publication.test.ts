import fs from "node:fs";
import path from "node:path";
import {
  definitionResolutionSnapshotSchema,
  definitionSourceDocumentSchema,
  publishedModuleDefinitionSchema,
  sessionContextSchema,
  type DefinitionResolutionSnapshot,
  type PublishedDefinitionHistory,
  type PublishDefinitionResult,
  type SessionContext,
  type StoredDefinitionDraft,
} from "@vortex/contracts";
import { describe, expect, it, vi } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { compileDefinition } from "../src/compiler";
import {
  createDefinitionPublicationService,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationReader,
  type DefinitionPublicationRepository,
  type DefinitionPublicationTransaction,
  type DefinitionReleaseAppend,
  type ResolvableConnectionTypeRelease,
  type ResolvableModuleRelease,
} from "../src/definition-publication";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../testing/fixtures");
const sourceNamed = (name: string) =>
  definitionSourceDocumentSchema.parse(
    JSON.parse(fs.readFileSync(path.join(fixtureRoot, "modules", name), "utf8")),
  );
const applicationSourceNamed = (name: string) =>
  definitionSourceDocumentSchema.parse(
    JSON.parse(fs.readFileSync(path.join(fixtureRoot, "applications", name), "utf8")),
  );
const connectionSourceNamed = (name: string) =>
  definitionSourceDocumentSchema.parse(
    JSON.parse(fs.readFileSync(path.join(fixtureRoot, "connection-types", name), "utf8")),
  );
const baseResolution = definitionResolutionSnapshotSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "definition-resolution-snapshot.json"), "utf8"),
  ),
);
const organizationId = "10000000-0000-4000-a000-000000000001";
const actorId = "10000000-0000-4000-a000-000000000002";
const publishedAt = "2026-09-04T00:00:00.000Z";

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

const resolutionAt = (key: string, version: string): DefinitionResolutionSnapshot => {
  const evidence = {
    contractVersion: "1.0.0" as const,
    definitions: baseResolution.definitions.map((definition) =>
      definition.key === key ? { ...definition, exactVersion: version } : definition,
    ),
    identities: baseResolution.identities,
  };
  return definitionResolutionSnapshotSchema.parse({
    ...evidence,
    fingerprint: fingerprintCanonicalValue(evidence),
  });
};

const metadata = (draftRevision: number) => ({
  organizationId,
  draftRevision,
  createdAt: publishedAt,
  createdBy: actorId,
  updatedAt: publishedAt,
  updatedBy: actorId,
});

const candidateFor = (
  source: ReturnType<typeof sourceNamed>,
  draftRevision = 1,
): DefinitionPublicationCandidate => {
  if (source.kind !== "module") throw new Error("Module fixture required");
  const own = baseResolution.definitions.find(
    (definition) => definition.kind === "module" && definition.key === source.key,
  );
  if (!own || own.kind !== "module") throw new Error("Fixture root missing");
  const draft: StoredDefinitionDraft = {
    kind: "module",
    rootId: own.rootId,
    organizationId: context().organizationId,
    key: source.key,
    draftRevision,
    sourceContractVersion: source.source_contract_version,
    sourceFingerprint: fingerprintCanonicalValue(source),
    source,
    createdAt: publishedAt,
    createdBy: context().systemActorId,
    updatedAt: publishedAt,
    updatedBy: context().systemActorId,
  };
  return {
    draft,
    identities: baseResolution.identities.filter(
      (identity) => identity.definitionKey === source.key,
    ),
    history: { kind: "module", definitionKey: source.key, history: [] },
  };
};

const applicationCandidateFor = (
  source: ReturnType<typeof applicationSourceNamed>,
): DefinitionPublicationCandidate => {
  if (source.kind !== "application") throw new Error("Application fixture required");
  const own = baseResolution.definitions.find(
    (definition) => definition.kind === "application" && definition.key === source.key,
  );
  if (!own || own.kind !== "application") throw new Error("Fixture application root missing");
  const draft: StoredDefinitionDraft = {
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
  };
  return {
    draft,
    identities: baseResolution.identities.filter(
      (identity) => identity.definitionKey === source.key,
    ),
    history: { kind: "application", definitionKey: source.key, history: [] },
  };
};

const releaseFor = (
  source: ReturnType<typeof sourceNamed>,
  releaseVersion: string,
  releaseRevision: number,
): ResolvableModuleRelease => {
  if (source.kind !== "module") throw new Error("Module fixture required");
  const resolutionSnapshot = resolutionAt(source.key, releaseVersion);
  const compilationOutput = compileDefinition({
    source,
    resolution: resolutionSnapshot,
    draftMetadata: metadata(releaseRevision),
    savedConditionRevisions:
      source.key === "vortex.service_desk.cases"
        ? [{ conditionId: "a4b5546d-8a54-4003-adc4-ddb8b0d7257d", revision: 1 }]
        : [],
  });
  if (compilationOutput.kind !== "module") throw new Error("Module output required");
  const published = publishedModuleDefinitionSchema.parse({
    publication: {
      kind: "module",
      rootId: compilationOutput.artifact.rootId,
      revision: releaseRevision,
      releaseVersion,
      contentFingerprint: compilationOutput.artifact.contentFingerprint,
      publishedAt,
      publishedBy: actorId,
      validationContractVersion: "1.0.0",
    },
    content: compilationOutput.canonical.content,
    dependencyManifest: [],
    releaseNote: "Fixture release",
  });
  return {
    organizationId: context().organizationId,
    key: source.key,
    rootId: compilationOutput.artifact.rootId,
    releaseRevision,
    releaseVersion,
    contentFingerprint: compilationOutput.artifact.contentFingerprint,
    resolutionFingerprint: compilationOutput.resolutionFingerprint,
    published,
    compilationOutput,
    resolutionSnapshot,
  };
};

const connectionReleaseFor = (
  source: ReturnType<typeof connectionSourceNamed>,
): ResolvableConnectionTypeRelease => {
  if (source.kind !== "connection_type") throw new Error("Connection fixture required");
  const compilationOutput = compileDefinition({ source, resolution: baseResolution });
  if (compilationOutput.kind !== "connection_type") throw new Error("Connection output required");
  return {
    key: source.key,
    rootId: compilationOutput.artifact.rootId,
    releaseVersion: compilationOutput.artifact.exactVersion,
    contentFingerprint: compilationOutput.artifact.contentFingerprint,
    catalogueFingerprint: compilationOutput.artifact.contentFingerprint,
    compilationOutput,
  };
};

const catalogueWith = (
  releases: readonly ResolvableConnectionTypeRelease[],
): DefinitionPublicationCatalogue => ({
  listConnectionTypeReleases: async (key) => releases.filter((release) => release.key === key),
  readConnectionTypeRelease: async (rootId, releaseVersion) =>
    releases.find(
      (release) => release.rootId === rootId && release.releaseVersion === releaseVersion,
    ),
  readPlatformThemeRelease: async () => undefined,
});

const emptyCatalogue: DefinitionPublicationCatalogue = {
  listConnectionTypeReleases: async () => [],
  readConnectionTypeRelease: async () => undefined,
  readPlatformThemeRelease: async () => undefined,
};

class MemoryRepository
  implements
    DefinitionPublicationRepository,
    DefinitionPublicationReader,
    DefinitionPublicationTransaction
{
  candidate: DefinitionPublicationCandidate;
  moduleReleases: ResolvableModuleRelease[];
  appends: DefinitionReleaseAppend[] = [];
  reads = 0;
  transactions = 0;
  failAppend = false;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(candidate: DefinitionPublicationCandidate, releases: ResolvableModuleRelease[] = []) {
    this.candidate = candidate;
    this.moduleReleases = releases;
  }

  async read<Result>(
    _context: SessionContext,
    operation: (reader: DefinitionPublicationReader) => Promise<Result>,
  ): Promise<Result> {
    this.reads += 1;
    return operation(this);
  }

  transaction<Result>(
    _context: SessionContext,
    operation: (transaction: DefinitionPublicationTransaction) => Promise<Result>,
  ): Promise<Result> {
    this.transactions += 1;
    const run = this.transactionTail.then(() => operation(this));
    this.transactionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async readCandidate(): Promise<DefinitionPublicationCandidate> {
    return structuredClone(this.candidate);
  }

  async lockCandidate(): Promise<DefinitionPublicationCandidate> {
    return structuredClone(this.candidate);
  }

  async listModuleReleases(_organizationId: string, key: string) {
    return this.moduleReleases.filter((release) => release.key === key);
  }

  async readModuleRelease(_organizationId: string, rootId: string, releaseRevision: number) {
    return this.moduleReleases.find(
      (release) => release.rootId === rootId && release.releaseRevision === releaseRevision,
    );
  }

  async appendRelease(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult> {
    if (this.failAppend) throw new Error("injected append failure");
    if (this.candidate.draft.publishedRevision === release.draft.draftRevision)
      throw new Error("concurrent release conflict");
    this.appends.push(release);
    const output = release.compilationOutput;
    const publication = {
      kind: output.kind,
      rootId: output.artifact.rootId,
      revision: release.draft.draftRevision,
      releaseVersion: release.assignedVersion,
      contentFingerprint: output.artifact.contentFingerprint,
      publishedAt,
      publishedBy: context().systemActorId,
      validationContractVersion: release.validationContractVersion,
    } as const;
    const historyEntry = {
      publication,
      content: output.canonical.content,
      dependencyManifest: release.dependencyManifest
        .filter((dependency) => dependency.kind === "module")
        .map((dependency) => {
          const target = this.moduleReleases.find(
            (item) =>
              item.rootId === dependency.rootId &&
              item.releaseRevision === dependency.releaseRevision,
          );
          if (!target) throw new Error("manifest target missing");
          return target.published.publication;
        }),
      releaseNote: release.releaseNote,
    };
    const previous = this.candidate.history.history;
    this.candidate = {
      ...this.candidate,
      draft: { ...this.candidate.draft, publishedRevision: release.draft.draftRevision },
      history: {
        kind: output.kind,
        definitionKey: release.draft.key,
        history: [...previous, historyEntry],
      } as PublishedDefinitionHistory,
    };
    return {
      rootId: release.draft.rootId,
      releaseRevision: release.draft.draftRevision,
      releaseVersion: release.assignedVersion,
      contentFingerprint: output.artifact.contentFingerprint,
      resolutionFingerprint: output.resolutionFingerprint,
      comparisonFingerprint: release.comparisonFingerprint,
      dependencyManifest: [...release.dependencyManifest],
      publishedAt,
      publishedBy: context().systemActorId,
    };
  }
}

describe("Definition publication service", () => {
  it("translates raw repository failures into one closed service error", async () => {
    const repository: DefinitionPublicationRepository = {
      read: vi.fn(async () => {
        throw new Error("driver detail that must not escape");
      }),
      transaction: vi.fn(),
    };
    const service = createDefinitionPublicationService(repository, emptyCatalogue);

    await expect(
      service.prepare(context(), {
        rootId: "60000000-0000-4000-8000-000000000001",
        expectedDraftRevision: 1,
      }),
    ).rejects.toMatchObject({
      name: "DefinitionPublicationError",
      code: "DEFINITION_PUBLICATION_FAILED",
      message: "DEFINITION_PUBLICATION_FAILED",
    });
  });

  it("prepares without writing, then appends one inert release in one request transaction", async () => {
    const repository = new MemoryRepository(candidateFor(sourceNamed("crm.organisations.json")));
    const service = createDefinitionPublicationService(repository, emptyCatalogue);
    const command = {
      rootId: repository.candidate.draft.rootId,
      expectedDraftRevision: 1,
    };

    const prepared = await service.prepare(context(), command);

    expect(prepared.confirmation).toMatchObject({
      outcome: "initial_release",
      assignedVersion: "1.0.0",
      dependencyManifest: [],
    });
    expect(repository.appends).toHaveLength(0);
    expect(repository.transactions).toBe(0);

    const portableConfirmation = JSON.parse(JSON.stringify(prepared.confirmation));
    const result = await service.publish(context(), {
      confirmation: portableConfirmation,
      releaseNote: "Initial neutral module release",
    });

    expect(result.releaseRevision).toBe(1);
    expect(repository.appends).toHaveLength(1);
    expect(repository.appends[0]?.resolutionSnapshot.fingerprint).toBe(
      prepared.confirmation.resolutionFingerprint,
    );
    expect(repository.transactions).toBe(1);
    expect(repository.candidate.draft.publishedRevision).toBe(1);
  });

  it("rejects malformed commands before and altered confirmations inside a transaction", async () => {
    const repository = new MemoryRepository(candidateFor(sourceNamed("crm.organisations.json")));
    const service = createDefinitionPublicationService(repository, emptyCatalogue);
    await expect(service.prepare(context(), { expectedDraftRevision: 1 })).rejects.toMatchObject({
      code: "INVALID_DEFINITION_PUBLICATION_COMMAND",
    });
    expect(repository.reads).toBe(0);

    const prepared = await service.prepare(context(), {
      rootId: repository.candidate.draft.rootId,
      expectedDraftRevision: 1,
    });
    await expect(
      service.publish(context(), {
        confirmation: {
          ...prepared.confirmation,
          sourceFingerprint: `sha256:${"0".repeat(64)}`,
        },
        releaseNote: "Altered confirmation",
      }),
    ).rejects.toMatchObject({ code: "DEFINITION_CONFIRMATION_MISMATCH" });
    expect(repository.transactions).toBe(1);
    expect(repository.appends).toHaveLength(0);
  });

  it("serializes concurrent publication attempts so only one release is appended", async () => {
    const repository = new MemoryRepository(candidateFor(sourceNamed("crm.organisations.json")));
    const service = createDefinitionPublicationService(repository, emptyCatalogue);
    const prepared = await service.prepare(context(), {
      rootId: repository.candidate.draft.rootId,
      expectedDraftRevision: 1,
    });
    const publish = () =>
      service.publish(context(), {
        confirmation: prepared.confirmation,
        releaseNote: "One release only",
      });

    const results = await Promise.allSettled([publish(), publish()]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(repository.appends).toHaveLength(1);
  });

  it("pins the highest stable range result and does not retarget it during publication", async () => {
    const dependencySource = sourceNamed("crm.organisations.json");
    const candidateSource = structuredClone(sourceNamed("crm.people.json"));
    if (candidateSource.kind !== "module") throw new Error("Module fixture required");
    candidateSource.body.dependencies[0]!.version = {
      selection: "allowed_range",
      expression: "^1.0.0",
    };
    const repository = new MemoryRepository(candidateFor(candidateSource), [
      releaseFor(dependencySource, "1.0.0", 1),
      releaseFor(dependencySource, "1.2.0", 2),
    ]);
    const service = createDefinitionPublicationService(repository, emptyCatalogue);
    const prepared = await service.prepare(context(), {
      rootId: repository.candidate.draft.rootId,
      expectedDraftRevision: 1,
    });
    expect(prepared.confirmation.dependencyManifest[0]).toMatchObject({
      kind: "module",
      releaseVersion: "1.2.0",
      releaseRevision: 2,
    });

    repository.moduleReleases.push(releaseFor(dependencySource, "1.3.0", 3));
    await service.publish(context(), {
      confirmation: prepared.confirmation,
      releaseNote: "Keep the prepared exact dependency",
    });

    expect(repository.appends[0]?.dependencyManifest[0]).toMatchObject({
      releaseVersion: "1.2.0",
      releaseRevision: 2,
    });
  });

  it("uses the same verified module condition evidence for application prepare and publish", async () => {
    const source = structuredClone(applicationSourceNamed("crm.json"));
    if (source.kind !== "application") throw new Error("Application fixture required");
    const permission = source.body.permissions.find(
      (entry) => entry.key === "application.crm.shared_cases.read",
    );
    if (!permission) throw new Error("Application permission fixture required");
    permission.record_type = "vortex.service_desk.cases:case";
    permission.action_kind = "read";
    delete permission.named_action;
    permission.record_scope = {
      routes: [{ kind: "all_records" }],
      saved_condition: {
        condition: "matching_priority",
        parameter_bindings: [{ key: "allowed_priority", source: "literal", value: "high" }],
      },
    };
    permission.field_policy = {
      readable_fields: [
        "case_number",
        "subject",
        "status",
        "priority",
        "customer_company",
        "resolved_at",
      ],
      changeable_fields: [],
    };
    const moduleReleases = [
      "crm.organisations.json",
      "crm.people.json",
      "crm.opportunities.json",
      "crm.activities.json",
      "crm.tags.json",
      "service-desk.cases.json",
    ].map((name) => releaseFor(sourceNamed(name), "1.0.0", 1));
    const connectionReleases = ["email.json", "calendar.json"].map((name) =>
      connectionReleaseFor(connectionSourceNamed(name)),
    );
    const repository = new MemoryRepository(applicationCandidateFor(source), moduleReleases);
    const service = createDefinitionPublicationService(
      repository,
      catalogueWith(connectionReleases),
    );
    const prepared = await service.prepare(context(), {
      rootId: repository.candidate.draft.rootId,
      expectedDraftRevision: 1,
    });
    await service.publish(context(), {
      confirmation: prepared.confirmation,
      releaseNote: "Publish one application-owned saved condition",
    });

    const output = repository.appends[0]?.compilationOutput;
    if (!output || output.kind !== "application") throw new Error("Application append required");
    const compiledScope = output.canonical.content.permissions.find(
      (entry) => entry.key === permission.key,
    )?.recordScope;
    const casesRelease = moduleReleases.find(
      (release) => release.key === "vortex.service_desk.cases",
    );
    const condition = casesRelease?.compilationOutput.canonical.content.sharingConditions.find(
      (entry) => entry.key === "matching_priority",
    );
    expect(compiledScope?.savedCondition).toMatchObject({
      conditionId: condition?.conditionId,
      publishedRevision: condition?.publishedRevision,
      contractFingerprint: condition?.contractFingerprint,
    });

    if (!casesRelease) throw new Error("Cases release required");
    const substitutedRelease = structuredClone(casesRelease);
    substitutedRelease.compilationOutput.canonical.content.sharingConditions[0]!.key =
      "substituted_condition";
    const substitutedRepository = new MemoryRepository(applicationCandidateFor(source), [
      ...moduleReleases.filter((release) => release.key !== casesRelease.key),
      substitutedRelease,
    ]);
    await expect(
      createDefinitionPublicationService(
        substitutedRepository,
        catalogueWith(connectionReleases),
      ).prepare(context(), {
        rootId: substitutedRepository.candidate.draft.rootId,
        expectedDraftRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "DEFINITION_COMPILATION_REFUSED" });
  });

  it("rolls back the observable release and pointer when append fails", async () => {
    const repository = new MemoryRepository(candidateFor(sourceNamed("crm.organisations.json")));
    const service = createDefinitionPublicationService(repository, emptyCatalogue);
    const prepared = await service.prepare(context(), {
      rootId: repository.candidate.draft.rootId,
      expectedDraftRevision: 1,
    });
    repository.failAppend = true;

    await expect(
      service.publish(context(), {
        confirmation: prepared.confirmation,
        releaseNote: "Injected failure",
      }),
    ).rejects.toMatchObject({
      name: "DefinitionPublicationError",
      code: "DEFINITION_PUBLICATION_FAILED",
      message: "DEFINITION_PUBLICATION_FAILED",
    });
    expect(repository.appends).toHaveLength(0);
    expect(repository.candidate.draft.publishedRevision).toBeUndefined();
  });
});
