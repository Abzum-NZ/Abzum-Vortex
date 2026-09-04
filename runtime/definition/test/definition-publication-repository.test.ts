import fs from "node:fs";
import path from "node:path";
import {
  definitionResolutionSnapshotSchema,
  definitionSourceDocumentSchema,
  sessionContextSchema,
  storedDefinitionDraftSchema,
  type SessionContext,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it } from "vitest";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "../src/canonical-json";
import { compileDefinition } from "../src/compiler";
import {
  createDefinitionPublicationService,
  type DefinitionPublicationCatalogue,
} from "../src/definition-publication";
import {
  createDatabaseDefinitionPublicationRepository,
  type DefinitionPublicationTransactionRunner,
} from "../src/definition-publication-repository";
import { createDefinitionStore } from "../src/definition-store";
import {
  extractSourceIdentityRequirements,
  type SourceIdentityRequirement,
} from "../src/source-identities";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../testing/fixtures");
const source = definitionSourceDocumentSchema.parse(
  JSON.parse(fs.readFileSync(path.join(fixtureRoot, "modules", "crm.organisations.json"), "utf8")),
);
const resolution = definitionResolutionSnapshotSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "definition-resolution-snapshot.json"), "utf8"),
  ),
);
if (source.kind !== "module") throw new Error("Module fixture required");
const ownResolution = resolution.definitions.find(
  (definition) => definition.kind === "module" && definition.key === source.key,
);
if (!ownResolution || ownResolution.kind !== "module") throw new Error("Fixture root missing");

const organizationId = "10000000-0000-4000-a000-000000000001";
const actorId = "10000000-0000-4000-a000-000000000002";
const publishedAt = "2026-09-04T00:00:00.000Z";
const comparisonFingerprint = `sha256:${"a".repeat(64)}`;

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

const draft = storedDefinitionDraftSchema.parse({
  kind: "module",
  rootId: ownResolution.rootId,
  organizationId,
  key: source.key,
  draftRevision: 2,
  publishedRevision: 1,
  source,
  sourceContractVersion: source.source_contract_version,
  sourceFingerprint: fingerprintCanonicalValue(source),
  createdAt: publishedAt,
  createdBy: actorId,
  updatedAt: publishedAt,
  updatedBy: actorId,
});

const compilationOutput = compileDefinition({
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
if (compilationOutput.kind !== "module") throw new Error("Module output required");

const publication = {
  kind: "module" as const,
  rootId: ownResolution.rootId,
  revision: 1,
  releaseVersion: "1.0.0",
  contentFingerprint: compilationOutput.artifact.contentFingerprint,
  publishedAt,
  publishedBy: actorId,
  validationContractVersion: "1.0.0",
};

const currentSourceIdentities = extractSourceIdentityRequirements(source).flatMap((requirement) => {
  const owner = resolution.identities.find(
    (identity) =>
      identity.definitionKey === requirement.definitionKey &&
      identity.kind === requirement.kind &&
      identity.componentOwner === requirement.componentOwner,
  );
  if (owner === undefined) throw new Error("Fixture identity owner missing");
  return requirement.aliases.map((alias) => ({
    definitionKey: requirement.definitionKey,
    scope: requirement.scope,
    kind: requirement.kind,
    componentOwner: requirement.componentOwner,
    alias,
    identifier: owner.identifier,
  }));
});

const rawModuleRelease = {
  organizationId,
  key: source.key,
  rootId: ownResolution.rootId,
  releaseRevision: "1",
  releaseVersion: "1.0.0",
  contentFingerprint: compilationOutput.artifact.contentFingerprint,
  resolutionFingerprint: resolution.fingerprint,
  compilationOutput,
  resolutionSnapshot: resolution,
  identities: resolution.identities,
  published: {
    publication,
    content: compilationOutput.canonical.content,
    dependencyManifest: [],
    releaseNote: "Initial release",
  },
};

const publicationState = {
  root: {
    rootId: ownResolution.rootId,
    organizationId,
    kind: "module",
    key: source.key,
    currentReleaseRevision: 1,
    createdAt: publishedAt,
    createdBy: actorId,
  },
  draft,
  identities: currentSourceIdentities,
  history: {
    kind: "module",
    definitionKey: source.key,
    history: [
      {
        publication,
        content: compilationOutput.canonical.content,
        dependencyManifest: [],
        releaseNote: "Initial release",
        evidence: {
          authoredSource: source,
          authoredSourceFingerprint: fingerprintCanonicalValue(source),
          sourceContractVersion: source.source_contract_version,
          compilationOutput,
          resolutionSnapshot: resolution,
          resolutionFingerprint: resolution.fingerprint,
          comparisonFingerprint,
          impactReasons: [],
        },
      },
    ],
  },
};

const initialPublicationState = {
  ...publicationState,
  root: { ...publicationState.root, currentReleaseRevision: null },
  draft: { ...draft, publishedRevision: null },
  history: { ...publicationState.history, history: [] },
};

type Call = { text: string; values: readonly DatabaseValue[] };

const runnerWith = (
  response: (text: string, values: readonly DatabaseValue[]) => readonly DatabaseRow[],
) => {
  const calls: Call[] = [];
  const runner: DefinitionPublicationTransactionRunner = async <Result>(
    _context: SessionContext,
    operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
  ): Promise<Result> =>
    operation({
      query: async <ResultRow extends DatabaseRow>(
        strings: TemplateStringsArray,
        ...values: readonly DatabaseValue[]
      ) => {
        const text = strings.join("$value");
        calls.push({ text, values });
        return response(text, values) as readonly ResultRow[];
      },
    });
  return { calls, runner };
};

const responseFor = (text: string): readonly DatabaseRow[] => {
  if (text.includes("read_publication_state")) return [{ publication_state: publicationState }];
  if (text.includes("list_module_releases")) return [{ module_releases: [rawModuleRelease] }];
  if (text.includes("read_module_release")) return [{ module_release: rawModuleRelease }];
  if (text.includes("append_release"))
    return [
      {
        root_id: ownResolution.rootId,
        release_revision: "2",
        release_version: "1.0.1",
        content_fingerprint: compilationOutput.artifact.contentFingerprint,
        resolution_fingerprint: resolution.fingerprint,
        comparison_fingerprint: comparisonFingerprint,
        dependency_manifest: [],
        published_at: new Date(publishedAt),
        published_by: actorId,
      },
    ];
  throw new Error("Unexpected database operation");
};

const lifecycleCatalogue: DefinitionPublicationCatalogue = {
  listConnectionTypeReleases: async () => [],
  readConnectionTypeRelease: async () => undefined,
  readPlatformThemeRelease: async () => undefined,
};

const lifecycleRunner = () => {
  let draftSource = structuredClone(source);
  let draftRevision = 1;
  let publishedRevision: number | undefined;
  let identityRequirements = extractSourceIdentityRequirements(draftSource);
  const history: unknown[] = [];
  const appended: Array<{
    compilationOutput: typeof compilationOutput;
    resolutionSnapshot: typeof resolution;
  }> = [];
  const permanentIds = new Map<string, string>();
  for (const identity of resolution.identities.filter(
    (entry) => entry.definitionKey === source.key,
  )) {
    const owner = `${identity.kind}:${identity.componentOwner}`;
    const existing = permanentIds.get(owner);
    if (existing !== undefined && existing !== identity.identifier)
      throw new Error("Fixture owner has conflicting permanent identifiers");
    permanentIds.set(owner, identity.identifier);
  }

  const identitiesFor = (requirements: readonly SourceIdentityRequirement[]) =>
    requirements
      .flatMap((requirement) => {
        const identifier = permanentIds.get(`${requirement.kind}:${requirement.componentOwner}`);
        if (identifier === undefined) throw new Error("Fixture owner is missing a permanent ID");
        return requirement.aliases.map((alias) => ({
          definitionKey: requirement.definitionKey,
          scope: requirement.scope,
          kind: requirement.kind,
          componentOwner: requirement.componentOwner,
          alias,
          identifier,
        }));
      })
      .sort((left, right) =>
        compareCanonicalStrings(
          `${left.scope}:${left.kind}:${left.alias}`,
          `${right.scope}:${right.kind}:${right.alias}`,
        ),
      );

  const storedRow = () => ({
    root_id: ownResolution.rootId,
    organization_id: organizationId,
    kind: "module",
    definition_key: source.key,
    draft_revision: String(draftRevision),
    published_revision: publishedRevision === undefined ? null : String(publishedRevision),
    authored_source: draftSource,
    source_contract_version: draftSource.source_contract_version,
    source_fingerprint: fingerprintCanonicalValue(draftSource),
    created_at: new Date(publishedAt),
    created_by: actorId,
    updated_at: new Date(publishedAt),
    updated_by: actorId,
  });

  const publicationStateForCurrentDraft = () => ({
    root: {
      rootId: ownResolution.rootId,
      organizationId,
      kind: "module",
      key: source.key,
      currentReleaseRevision: publishedRevision ?? null,
      createdAt: publishedAt,
      createdBy: actorId,
    },
    draft: {
      rootId: ownResolution.rootId,
      organizationId,
      kind: "module",
      key: source.key,
      draftRevision,
      publishedRevision: publishedRevision ?? null,
      source: draftSource,
      sourceContractVersion: draftSource.source_contract_version,
      sourceFingerprint: fingerprintCanonicalValue(draftSource),
      createdAt: publishedAt,
      createdBy: actorId,
      updatedAt: publishedAt,
      updatedBy: actorId,
    },
    identities: identitiesFor(identityRequirements),
    history: { kind: "module", definitionKey: source.key, history },
  });

  const runner: DefinitionPublicationTransactionRunner = async <Result>(
    _context: SessionContext,
    operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
  ): Promise<Result> =>
    operation({
      query: async <ResultRow extends DatabaseRow>(
        strings: TemplateStringsArray,
        ...values: readonly DatabaseValue[]
      ) => {
        const text = strings.join("$value");
        if (text.includes("read_publication_state"))
          return [{ publication_state: publicationStateForCurrentDraft() }] as readonly ResultRow[];
        if (text.includes("save_draft")) {
          if (
            values[0] !== ownResolution.rootId ||
            values[1] !== draftRevision ||
            values[3] !== fingerprintCanonicalValue(JSON.parse(String(values[2])))
          )
            return [];
          const nextSource = definitionSourceDocumentSchema.parse(JSON.parse(String(values[2])));
          if (nextSource.kind !== "module") throw new Error("Module source required");
          draftSource = nextSource;
          identityRequirements = JSON.parse(String(values[4])) as SourceIdentityRequirement[];
          draftRevision += 1;
          return [storedRow()] as readonly ResultRow[];
        }
        if (text.includes("append_release")) {
          const evidence = JSON.parse(String(values[3])) as {
            releaseVersion: string;
            compilationOutput: typeof compilationOutput;
            resolutionSnapshot: typeof resolution;
            contentFingerprint: string;
            resolutionFingerprint: string;
            validationContractVersion: string;
            comparisonFingerprint: string;
            impactReasons: unknown[];
            releaseNote: string;
          };
          const operationAt = `2026-09-04T00:00:${String(draftRevision).padStart(2, "0")}.000Z`;
          const nextPublication = {
            kind: "module" as const,
            rootId: ownResolution.rootId,
            revision: draftRevision,
            releaseVersion: evidence.releaseVersion,
            contentFingerprint: evidence.contentFingerprint,
            publishedAt: operationAt,
            publishedBy: actorId,
            validationContractVersion: evidence.validationContractVersion,
          };
          history.push({
            publication: nextPublication,
            content: evidence.compilationOutput.canonical.content,
            dependencyManifest: [],
            releaseNote: evidence.releaseNote,
            evidence: {
              authoredSource: draftSource,
              authoredSourceFingerprint: fingerprintCanonicalValue(draftSource),
              sourceContractVersion: draftSource.source_contract_version,
              compilationOutput: evidence.compilationOutput,
              resolutionSnapshot: evidence.resolutionSnapshot,
              resolutionFingerprint: evidence.resolutionFingerprint,
              comparisonFingerprint: evidence.comparisonFingerprint,
              impactReasons: evidence.impactReasons,
            },
          });
          appended.push({
            compilationOutput: evidence.compilationOutput,
            resolutionSnapshot: evidence.resolutionSnapshot,
          });
          publishedRevision = draftRevision;
          return [
            {
              root_id: ownResolution.rootId,
              release_revision: String(draftRevision),
              release_version: evidence.releaseVersion,
              content_fingerprint: evidence.contentFingerprint,
              resolution_fingerprint: evidence.resolutionFingerprint,
              comparison_fingerprint: evidence.comparisonFingerprint,
              dependency_manifest: [],
              published_at: new Date(operationAt),
              published_by: actorId,
            },
          ] as readonly ResultRow[];
        }
        throw new Error("Unexpected lifecycle database operation");
      },
    });

  return { appended, runner };
};

describe("database Definition publication repository", () => {
  it("strictly reconstructs a candidate history from immutable stored evidence", async () => {
    const { calls, runner } = runnerWith((text) => responseFor(text));
    const repository = createDatabaseDefinitionPublicationRepository(runner);

    const candidate = await repository.read(context(), (reader) =>
      reader.readCandidate(ownResolution.rootId),
    );

    expect(candidate?.history).toMatchObject({
      kind: "module",
      definitionKey: source.key,
      history: [{ publication: { revision: 1 }, dependencyManifest: [] }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_definition.read_publication_state");
  });

  it("normalizes the database's explicit null pointer for an unpublished draft", async () => {
    const repository = createDatabaseDefinitionPublicationRepository(
      runnerWith(() => [{ publication_state: initialPublicationState }]).runner,
    );

    const candidate = await repository.read(context(), (reader) =>
      reader.readCandidate(ownResolution.rootId),
    );

    expect(candidate?.draft.publishedRevision).toBeUndefined();
    expect(candidate?.history.history).toEqual([]);
  });

  it("lists and reads only strict immutable Module releases using stored snapshots", async () => {
    const { calls, runner } = runnerWith((text) => responseFor(text));
    const repository = createDatabaseDefinitionPublicationRepository(runner);

    const result = await repository.read(context(), async (reader) => ({
      listed: await reader.listModuleReleases(context().organizationId, source.key),
      exact: await reader.readModuleRelease(context().organizationId, ownResolution.rootId, 1),
    }));

    expect(result.listed[0]?.resolutionSnapshot.fingerprint).toBe(resolution.fingerprint);
    expect(result.exact?.published.publication.revision).toBe(1);
    expect(calls.map((call) => call.text)).toEqual([
      expect.stringContaining("vortex_definition.list_module_releases"),
      expect.stringContaining("vortex_definition.read_module_release"),
    ]);
  });

  it("passes exact compiled output and resolution evidence to the atomic append operation", async () => {
    const { calls, runner } = runnerWith((text) => responseFor(text));
    const repository = createDatabaseDefinitionPublicationRepository(runner);

    const result = await repository.transaction(context(), (transaction) =>
      transaction.appendRelease({
        draft,
        compilationOutput,
        resolutionSnapshot: resolution,
        assignedVersion: "1.0.1",
        comparisonFingerprint,
        reasons: [],
        dependencyManifest: [],
        validationContractVersion: "1.0.0",
        releaseNote: "Follow-up release",
      }),
    );

    expect(result).toMatchObject({ releaseRevision: 2, releaseVersion: "1.0.1" });
    const call = calls[0]!;
    expect(call.text).toContain("vortex_definition.append_release");
    expect(call.values.slice(0, 3)).toEqual([
      draft.rootId,
      draft.draftRevision,
      draft.sourceFingerprint,
    ]);
    const evidence = JSON.parse(String(call.values[3]));
    expect(evidence).toMatchObject({
      compilationOutput: { kind: "module" },
      resolutionSnapshot: { fingerprint: resolution.fingerprint },
      dependencies: [],
    });
    expect(evidence).not.toHaveProperty("authoredSource");
    expect(evidence).not.toHaveProperty("publishedAt");
    expect(evidence).not.toHaveProperty("publishedBy");
  });

  it("maps zero-row stale appends and raw driver/storage failures to closed errors", async () => {
    const stale = createDatabaseDefinitionPublicationRepository(runnerWith(() => []).runner);
    await expect(
      stale.transaction(context(), (transaction) =>
        transaction.appendRelease({
          draft,
          compilationOutput,
          resolutionSnapshot: resolution,
          assignedVersion: "1.0.1",
          comparisonFingerprint,
          reasons: [],
          dependencyManifest: [],
          validationContractVersion: "1.0.0",
          releaseNote: "Stale release",
        }),
      ),
    ).rejects.toMatchObject({ code: "DEFINITION_DRAFT_STALE_OR_MISSING" });

    const serializationFailure = createDatabaseDefinitionPublicationRepository(
      runnerWith(() => {
        throw { code: "40001", message: "sensitive conflict detail" };
      }).runner,
    );
    await expect(
      serializationFailure.read(context(), (reader) => reader.readCandidate(ownResolution.rootId)),
    ).rejects.toMatchObject({
      name: "DefinitionPublicationError",
      code: "DEFINITION_DRAFT_STALE_OR_MISSING",
      message: "DEFINITION_DRAFT_STALE_OR_MISSING",
    });

    const rawFailure = createDatabaseDefinitionPublicationRepository(
      runnerWith(() => {
        throw new Error("sensitive driver detail");
      }).runner,
    );
    await expect(
      rawFailure.read(context(), (reader) => reader.readCandidate(ownResolution.rootId)),
    ).rejects.toMatchObject({
      name: "DefinitionPublicationError",
      code: "DEFINITION_PUBLICATION_FAILED",
      message: "DEFINITION_PUBLICATION_FAILED",
    });

    const invalidStorage = createDatabaseDefinitionPublicationRepository(
      runnerWith(() => [{ publication_state: { ...publicationState, unexpected: true } }]).runner,
    );
    await expect(
      invalidStorage.read(context(), (reader) => reader.readCandidate(ownResolution.rootId)),
    ).rejects.toMatchObject({ code: "DEFINITION_PUBLICATION_FAILED" });
  });

  it("publishes rename, removal and reintroduction with current aliases and one permanent ID", async () => {
    const lifecycle = lifecycleRunner();
    const repository = createDatabaseDefinitionPublicationRepository(lifecycle.runner);
    const service = createDefinitionPublicationService(repository, lifecycleCatalogue);
    const store = createDefinitionStore(lifecycle.runner);
    let currentRevision = 1;
    const publishCurrent = async (releaseNote: string) => {
      const prepared = await service.prepare(context(), {
        rootId: ownResolution.rootId,
        expectedDraftRevision: currentRevision,
      });
      await service.publish(
        context(),
        JSON.parse(JSON.stringify({ confirmation: prepared.confirmation, releaseNote })),
      );
    };

    await publishCurrent("Original extension point");
    const originalOutput = lifecycle.appended[0]!.compilationOutput;
    const permanentId = originalOutput.canonical.content.extensionPoints.find(
      (point) => point.key === "company_fields",
    )?.extensionPointId;
    expect(permanentId).toBeDefined();

    const renamed = structuredClone(source);
    renamed.body.extension_points[0]!.key = "renamed_company_fields";
    const renamedDraft = await store.saveDraft(context(), {
      rootId: ownResolution.rootId,
      expectedDraftRevision: currentRevision,
      source: renamed,
    });
    currentRevision = renamedDraft.draftRevision;
    await publishCurrent("Rename extension point");
    expect(
      lifecycle.appended[1]!.compilationOutput.canonical.content.extensionPoints.find(
        (point) => point.key === "renamed_company_fields",
      )?.extensionPointId,
    ).toBe(permanentId);

    const removed = structuredClone(renamed);
    removed.body.extension_points = removed.body.extension_points.filter(
      (point) => point.id !== "ext_company_fields",
    );
    const removedDraft = await store.saveDraft(context(), {
      rootId: ownResolution.rootId,
      expectedDraftRevision: currentRevision,
      source: removed,
    });
    currentRevision = removedDraft.draftRevision;
    await publishCurrent("Remove extension point");
    expect(
      lifecycle.appended[2]!.compilationOutput.canonical.content.extensionPoints.some(
        (point) => point.extensionPointId === permanentId,
      ),
    ).toBe(false);

    const restored = structuredClone(removed);
    restored.body.extension_points.push(structuredClone(renamed.body.extension_points[0]!));
    const restoredDraft = await store.saveDraft(context(), {
      rootId: ownResolution.rootId,
      expectedDraftRevision: currentRevision,
      source: restored,
    });
    currentRevision = restoredDraft.draftRevision;
    await publishCurrent("Restore extension point");
    expect(
      lifecycle.appended[3]!.compilationOutput.canonical.content.extensionPoints.find(
        (point) => point.key === "renamed_company_fields",
      )?.extensionPointId,
    ).toBe(permanentId);

    const aliasesAt = (release: number) =>
      lifecycle.appended[release]!.resolutionSnapshot.identities.filter(
        (identity) => identity.componentOwner === "ext_company_fields",
      );
    expect(aliasesAt(0).map((identity) => identity.alias)).toEqual([
      "company_fields",
      "ext_company_fields",
    ]);
    expect(aliasesAt(1).map((identity) => identity.alias)).toEqual([
      "ext_company_fields",
      "renamed_company_fields",
    ]);
    expect(aliasesAt(2)).toEqual([]);
    expect(new Set(aliasesAt(3).map((identity) => identity.identifier))).toEqual(
      new Set([permanentId]),
    );
    expect(aliasesAt(0).some((identity) => identity.alias === "renamed_company_fields")).toBe(
      false,
    );
  });
});
