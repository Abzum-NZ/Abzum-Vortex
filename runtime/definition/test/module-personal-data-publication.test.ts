import fs from "node:fs";
import path from "node:path";
import {
  correlationIdSchema,
  definitionResolutionSnapshotSchema,
  definitionResolutionSnapshotV2Schema,
  moduleSourceDocumentV2Schema,
  sessionContextSchema,
  storedDefinitionDraftSchema,
  translateDefinitionRuleFailures,
  type DefinitionValidationLocation,
  type ModuleSourceDocumentV2,
  type SessionContext,
} from "@vortex/contracts";
import { describe, expect, it, vi } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { createDefinitionStore } from "../src/definition-store";
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
import { validateDefinitionSource } from "../src/validation";
import { graphModuleRequests } from "./module-v3-fixtures";

// #44 (corrected scope, 12 September 2026; retargeted by the coordinator after
// review against spec 03 and data-contracts.md "Definition validation errors").
// The strict V2/V3 source schemas already require personal_data on every field
// (sourceFieldBaseV2 in contracts/src/module-source-contracts-v2.ts:446; V3
// reuses the V2 field catalogue). The located, public-catalogue refusal is
// owned by the versioned validation contract (validateDefinitionSource, the
// same function the draft store and the module designer use) -- not by
// publication, which is designed to fail closed with a coarse code. This
// proves all three for a Module V2 and a Module V3 draft with one field
// missing personal_data:
//   1. validateDefinitionSource returns a located, public-catalogue error
//      naming that field.
//   2. Publication (createDefinitionPublicationService, the same real path
//      used by module-v2-runtime.test.ts and module-v3-publication-read.test.ts)
//      is refused and stores nothing.
//   3. The draft store (createDefinitionStore, using the same in-memory
//      transaction fake as definition-store.test.ts) refuses it before
//      opening a transaction, and stores nothing.

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

// Corrupt the ALREADY-VALIDATED source, not the raw JSON before its own
// constructor-time parse: this stands in for a draft whose shape has since
// gone bad, which is what the validation contract, publication and the store
// must each independently defend against. It is not a way to dodge the
// fixture's own schema check.
const omitPersonalData = (field: { personal_data?: unknown }) => {
  delete field.personal_data;
};

const auditCorrelationId = correlationIdSchema.parse("00000000-0000-4000-8000-000000000099");

/**
 * Proves assertion 1: validateDefinitionSource locates the field, using only
 * the safe kind/key vocabulary (contracts/src/validation-errors.ts), and the
 * catalogue's public translation names the same location. personal_data is
 * enum-typed (personalDataClassSchema), so Zod reports an absent value as
 * "invalid_value" rather than "invalid_type" -- the catalogue's
 * definition_unsupported_choice member, not definition_required_value. Both
 * are members of the same closed missing/invalid-setting family; which one
 * fires is a property of the field's own type, not of this proof.
 */
const assertLocatedRefusal = (
  source: unknown,
  documentKey: string,
  fieldKey: string,
  protectedFieldId: string,
) => {
  const result = validateDefinitionSource(source);
  expect(result.valid).toBe(false);
  const expectedLocation: DefinitionValidationLocation = {
    documentKind: "module",
    documentKey,
    segments: expect.arrayContaining([
      { kind: "field", key: fieldKey },
    ]) as unknown as DefinitionValidationLocation["segments"],
  };
  const failure = result.failures.find((entry) => entry.family === "unsupported_choice");
  expect(failure).toBeDefined();
  expect(failure?.location).toEqual(expectedLocation);
  const serializedLocation = JSON.stringify(failure?.location);
  // Safe location vocabulary only: no raw JSON path segment and no protected
  // (builder-internal) identifier, only the typed kind/key pairs above.
  expect(serializedLocation).not.toContain(protectedFieldId);
  expect(serializedLocation).not.toContain("personal_data");
  expect(serializedLocation).not.toContain("body");
  expect(serializedLocation).not.toContain("record_types");

  const publicResult = translateDefinitionRuleFailures(result.failures, {
    correlationId: auditCorrelationId,
    rootLocation: { documentKind: "module", documentKey, segments: [] },
  });
  const publicError = publicResult.errors.find(
    (entry) => entry.code === "definition_unsupported_choice",
  );
  expect(publicError).toBeDefined();
  expect(publicError?.location).toEqual(expectedLocation);
  expect(publicError?.catalogueVersion).toBe("1.0.0");
};

describe("Module V2 draft missing personal_data", () => {
  // Build and validate the draft from a genuinely VALID source first; only
  // then corrupt the already-parsed copy. Feeding a pre-broken object into
  // storedDefinitionDraftSchema.parse would fail on construction itself,
  // which is a different (and uninteresting) proof than the one required.
  const validSource: ModuleSourceDocumentV2 = moduleSourceDocumentV2Schema.parse({
    ...JSON.parse(fs.readFileSync(path.join(fixtureRoot, "modules/service-desk.sla.json"), "utf8")),
    source_contract_version: "2.0.0",
  });
  const identities = [...baseResolution.identities];
  for (const requirement of extractStoredSourceIdentityRequirements(validSource)) {
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
    (definition) => definition.kind === "module" && definition.key === validSource.key,
  );
  if (own?.kind !== "module") throw new Error("Module resolution required");
  const draft = storedDefinitionDraftSchema.parse({
    kind: "module",
    rootId: own.rootId,
    key: validSource.key,
    draftRevision: 1,
    sourceContractVersion: "2.0.0",
    sourceFingerprint: fingerprintCanonicalValue(validSource),
    source: validSource,
    ...metadata,
  });
  if (draft.kind !== "module" || draft.source.source_contract_version !== "2.0.0")
    throw new Error("Module V2 draft required");
  const source = draft.source;
  const field = source.body.record_types
    .find((record) => record.key === "service_level")
    ?.fields.find((candidate) => candidate.key === "first_response_minutes");
  if (!field) throw new Error("service_level.first_response_minutes fixture field required");
  const protectedFieldId = field.id;
  omitPersonalData(field); // mutates draft.source in place, post-validation

  it("validateDefinitionSource locates the field with the catalogue's unsupported-choice error", () => {
    assertLocatedRefusal(source, source.key, "first_response_minutes", protectedFieldId);
  });

  it("publication is refused and stores nothing", async () => {
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

    expect(thrown).toMatchObject({
      name: "DefinitionPublicationError",
      code: "DEFINITION_HISTORY_INVALID",
    });
    expect(repository.appended).toBeUndefined();
    expect(repository.candidate.draft.publishedRevision).toBeUndefined();
  });

  it("the draft store refuses it before opening a transaction, and stores nothing", async () => {
    const transaction = { query: vi.fn() };
    const store = createDefinitionStore(transaction as never);

    // Empirically, this refuses as INVALID_DEFINITION_COMMAND, not
    // INVALID_DEFINITION_SOURCE: createDefinitionRootCommandSchema's own
    // `source` field is the same strict per-version module schema
    // (storedDefinitionSourceSchema in definition-store-contracts.ts), so a
    // missing personal_data is already a command-shape failure before the
    // store's separate validateSource/validateDefinitionSource call is ever
    // reached. Both codes fail closed before any query runs; only the more
    // specific one is actually reachable for this particular defect.
    await expect(store.createRoot({ source: source as never })).rejects.toMatchObject({
      name: "DefinitionStoreError",
      code: "INVALID_DEFINITION_COMMAND",
    });
    expect(transaction.query).not.toHaveBeenCalled();
  });
});

describe("Module V3 draft missing personal_data", () => {
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
  const source = draft.source;
  const field = source.body.record_types
    .find((record) => record.key === "candidate")
    ?.fields.find((candidate) => candidate.key === "name");
  if (!field) throw new Error("candidate.name fixture field required");
  const protectedFieldId = field.id;
  omitPersonalData(field); // mutates draft.source in place, post-validation

  it("validateDefinitionSource locates the field with the catalogue's unsupported-choice error", () => {
    assertLocatedRefusal(source, "example.candidate", "name", protectedFieldId);
  });

  it("publication is refused and stores nothing", async () => {
    const candidate: DefinitionPublicationCandidate = {
      draft,
      identities: request.resolution.identities.filter(
        (identity) => identity.definitionKey === source.key,
      ),
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

    expect(thrown).toMatchObject({
      name: "DefinitionPublicationError",
      code: "DEFINITION_HISTORY_INVALID",
    });
    expect(repository.appended).toBeUndefined();
    expect(repository.candidate.draft.publishedRevision).toBeUndefined();
  });

  it("the draft store refuses it before opening a transaction, and stores nothing", async () => {
    const transaction = { query: vi.fn() };
    const store = createDefinitionStore(transaction as never);

    // Same empirical code as the V2 case above: INVALID_DEFINITION_COMMAND,
    // not INVALID_DEFINITION_SOURCE, and for the same reason.
    await expect(store.createRoot({ source: source as never })).rejects.toMatchObject({
      name: "DefinitionStoreError",
      code: "INVALID_DEFINITION_COMMAND",
    });
    expect(transaction.query).not.toHaveBeenCalled();
  });
});
