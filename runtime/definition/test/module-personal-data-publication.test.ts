import fs from "node:fs";
import path from "node:path";
import {
  definitionResolutionSnapshotSchema,
  definitionResolutionSnapshotV2Schema,
  moduleSourceDocumentV2Schema,
  sessionContextSchema,
  storedDefinitionDraftSchema,
  type DefinitionValidationLocation,
  type ModuleSourceDocumentV2,
  type SessionContext,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import {
  createDefinitionPublicationService,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationReader,
  type DefinitionPublicationRepository,
  type DefinitionPublicationTransaction,
  type DefinitionReleaseAppend,
} from "../src/definition-publication";
import { extractStoredSourceIdentityRequirements } from "../src/source-identities";
import { graphModuleRequests } from "./module-v3-fixtures";

// #44 (corrected scope, 12 September 2026): the strict V2/V3 source schemas
// already require personal_data on every field (sourceFieldBaseV2 in
// contracts/src/module-source-contracts-v2.ts:446; V3 reuses the V2 field
// catalogue). This is the one remaining proof: that a draft missing it is
// actually refused through the real publication path -- the same
// createDefinitionPublicationService(repository, catalogue).prepare() used by
// module-v2-runtime.test.ts and module-v3-publication-read.test.ts -- not by
// calling a schema's safeParse directly, and that nothing is appended when
// that happens.

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../../testing/fixtures/historical/module-v1",
);
const baseResolution = definitionResolutionSnapshotSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "definition-resolution-snapshot.json"), "utf8"),
  ),
);
const metadata = {
  organizationId: "10000000-0000-4000-a000-000000000001",
  draftRevision: 1,
  createdAt: "2026-09-01T00:00:00+00:00",
  createdBy: "10000000-0000-4000-a000-000000000002",
  updatedAt: "2026-09-01T00:00:00+00:00",
  updatedBy: "10000000-0000-4000-a000-000000000002",
} as const;
const context = (): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "system",
    tenantId: "10000000-0000-4000-8000-000000000010",
    organizationId: metadata.organizationId,
    systemActorId: metadata.createdBy,
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

/** Same shape as ModuleV2PublicationRepository/ModuleV3PublicationRepository in the sibling runtime tests. */
class RecordingRepository
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
  ) {
    return operation(this);
  }
  transaction<Result>(
    _context: SessionContext,
    operation: (transaction: DefinitionPublicationTransaction) => Promise<Result>,
  ) {
    return operation(this);
  }
  async readCandidate() {
    return structuredClone(this.candidate);
  }
  async lockCandidate() {
    return structuredClone(this.candidate);
  }
  async listModuleReleases() {
    return [];
  }
  async readModuleRelease() {
    return undefined;
  }
  async appendRelease(release: DefinitionReleaseAppend) {
    this.appended = release;
    return {
      rootId: release.draft.rootId,
      releaseRevision: release.draft.draftRevision,
      releaseVersion: release.assignedVersion,
      contentFingerprint: release.compilationOutput.artifact.contentFingerprint,
      resolutionFingerprint: release.compilationOutput.resolutionFingerprint,
      comparisonFingerprint: release.comparisonFingerprint,
      dependencyManifest: [...release.dependencyManifest],
      publishedAt: metadata.updatedAt,
      publishedBy: metadata.updatedBy,
    };
  }
}

// Corrupt the ALREADY-VALIDATED draft, not the raw JSON before its own
// constructor-time parse: this stands in for a draft already sitting in
// storage whose shape has since gone bad, which is what a publish call must
// defend against. It is not a way to dodge the fixture's own schema check.
const omitPersonalData = (field: { personal_data?: unknown }) => {
  delete field.personal_data;
};

const locationOf = (error: unknown): DefinitionValidationLocation | undefined =>
  (error as { location?: DefinitionValidationLocation }).location;

describe("Module publication refuses a field missing personal_data", () => {
  it("refuses a Module V2 draft naming the field, and stores nothing", async () => {
    const source: ModuleSourceDocumentV2 = moduleSourceDocumentV2Schema.parse({
      ...JSON.parse(
        fs.readFileSync(path.join(fixtureRoot, "modules/service-desk.sla.json"), "utf8"),
      ),
      source_contract_version: "2.0.0",
    });

    const identities = [...baseResolution.identities];
    for (const requirement of extractStoredSourceIdentityRequirements(source)) {
      const ownerIdentity = identities.find(
        (identity) =>
          identity.definitionKey === requirement.definitionKey &&
          identity.scope === requirement.scope &&
          identity.kind === requirement.kind &&
          identity.componentOwner === requirement.componentOwner,
      );
      const owner =
        ownerIdentity ??
        ({
          definitionKey: requirement.definitionKey,
          scope: requirement.scope,
          kind: requirement.kind,
          componentOwner: requirement.componentOwner,
          alias: requirement.aliases[0]!,
          identifier: `90000000-0000-4000-8000-${String(identities.length + 1).padStart(12, "0")}`,
        } as const);
      if (!ownerIdentity) identities.push(owner);
      for (const alias of requirement.aliases)
        if (
          !identities.some(
            (identity) =>
              identity.definitionKey === requirement.definitionKey &&
              identity.scope === requirement.scope &&
              identity.kind === requirement.kind &&
              identity.componentOwner === requirement.componentOwner &&
              identity.alias === alias,
          )
        )
          identities.push({ ...owner, alias });
    }
    const evidence = {
      contractVersion: "2.0.0" as const,
      definitions: baseResolution.definitions,
      identities,
    };
    const resolution = definitionResolutionSnapshotV2Schema.parse({
      ...evidence,
      fingerprint: fingerprintCanonicalValue(evidence),
    });
    const own = resolution.definitions.find(
      (definition) => definition.kind === "module" && definition.key === source.key,
    );
    if (own?.kind !== "module") throw new Error("Module resolution required");

    const draft = storedDefinitionDraftSchema.parse({
      kind: "module",
      rootId: own.rootId,
      key: source.key,
      draftRevision: 1,
      sourceContractVersion: "2.0.0",
      sourceFingerprint: fingerprintCanonicalValue(source),
      source,
      ...metadata,
    });
    if (draft.kind !== "module" || draft.source.source_contract_version !== "2.0.0")
      throw new Error("Module V2 draft required");
    const field = draft.source.body.record_types
      .find((record) => record.key === "service_level")
      ?.fields.find((candidate) => candidate.key === "first_response_minutes");
    if (!field) throw new Error("service_level.first_response_minutes fixture field required");
    omitPersonalData(field);

    const candidate: DefinitionPublicationCandidate = {
      draft,
      identities: resolution.identities.filter((identity) => identity.definitionKey === source.key),
      history: { kind: "module", definitionKey: source.key, history: [] },
    };
    const repository = new RecordingRepository(candidate);
    const service = createDefinitionPublicationService(repository, catalogue);

    let thrown: unknown;
    try {
      await service.prepare(context(), { rootId: draft.rootId, expectedDraftRevision: 1 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(repository.appended).toBeUndefined();
    expect(repository.candidate.draft.publishedRevision).toBeUndefined();

    // Required by #44: a safe location naming the omitting field, in the
    // DefinitionValidationLocation shape publication's own semantic rules use
    // for other field-level refusals (contracts/src/validation-errors.ts,
    // runtime/definition/src/validation.ts sourceCollectionLocationKind).
    expect(locationOf(thrown)).toEqual({
      documentKind: "module",
      documentKey: source.key,
      segments: expect.arrayContaining([{ kind: "field", key: "first_response_minutes" }]),
    });
  });

  it("refuses a Module V3 draft naming the field, and stores nothing", async () => {
    const requests = graphModuleRequests();
    const request = requests.find((candidate) => candidate.source.key === "example.candidate");
    if (!request) throw new Error("example.candidate fixture request required");
    const own = request.resolution.definitions.find(
      (definition) => definition.kind === "module" && definition.key === request.source.key,
    );
    if (own?.kind !== "module") throw new Error("Module resolution required");

    const draft = storedDefinitionDraftSchema.parse({
      kind: "module",
      rootId: own.rootId,
      key: request.source.key,
      draftRevision: 1,
      sourceContractVersion: "3.0.0",
      sourceFingerprint: fingerprintCanonicalValue(request.source),
      source: request.source,
      ...request.draftMetadata,
    });
    if (draft.kind !== "module" || draft.source.source_contract_version !== "3.0.0")
      throw new Error("Module V3 draft required");
    const field = draft.source.body.record_types
      .find((record) => record.key === "candidate")
      ?.fields.find((candidate) => candidate.key === "name");
    if (!field) throw new Error("candidate.name fixture field required");
    omitPersonalData(field);

    const candidate: DefinitionPublicationCandidate = {
      draft,
      identities: request.resolution.identities.filter(
        (identity) => identity.definitionKey === request.source.key,
      ),
      history: { kind: "module", definitionKey: request.source.key, history: [] },
    };
    const repository = new RecordingRepository(candidate);
    const service = createDefinitionPublicationService(repository, catalogue);

    let thrown: unknown;
    try {
      await service.prepare(context(), { rootId: draft.rootId, expectedDraftRevision: 1 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(repository.appended).toBeUndefined();
    expect(repository.candidate.draft.publishedRevision).toBeUndefined();

    expect(locationOf(thrown)).toEqual({
      documentKind: "module",
      documentKey: "example.candidate",
      segments: expect.arrayContaining([{ kind: "field", key: "name" }]),
    });
  });
});
