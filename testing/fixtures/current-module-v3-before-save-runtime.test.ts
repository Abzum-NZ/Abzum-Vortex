import fs from "node:fs";
import path from "node:path";
import {
  moduleCompilationRequestV3Schema,
  moduleSourceDocumentV3Schema,
  moduleVersionImpactHistoryEntryV3Schema,
  sessionContextSchema,
  storedDefinitionDraftSchema,
  type JsonValue,
  type ModuleCompilationRequestV3,
  type ModuleSourceDocumentV3,
  type PublishDefinitionResult,
  type SessionContext,
} from "@vortex/contracts";
import {
  compileDefinition,
  createDefinitionConsumerReadService,
  createDefinitionPublicationService,
  extractModuleSourceIdentityRequirementsV3,
  fingerprintCanonicalValue,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationReader,
  type DefinitionPublicationRepository,
  type DefinitionPublicationTransaction,
  type DefinitionReleaseAppend,
  type ResolvableModuleRelease,
} from "@vortex/definition";
import {
  finalizeRecordFieldCandidateV2,
  prepareInitialRecordFieldCandidateV2,
} from "@vortex/record";
import { evaluateBeforeSaveRuleGraphs } from "@vortex/rule";
import { describe, expect, it } from "vitest";

const timestamp = "2026-09-09T00:00:00Z";

const graphModuleFixture = (name: "candidate" | "shared"): ModuleSourceDocumentV3 =>
  moduleSourceDocumentV3Schema.parse(
    JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, `rule-graphs/${name}-module.source.json`),
        "utf8",
      ),
    ),
  );

const graphModuleRequests = (
  sources: readonly ModuleSourceDocumentV3[],
): ModuleCompilationRequestV3[] => {
  let nextId = 1;
  const id = () => `90000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
  const roots = new Map(sources.map((source) => [source.key, id()]));
  const identities = sources.flatMap((source) =>
    extractModuleSourceIdentityRequirementsV3(source).flatMap((requirement) => {
      const identifier = requirement.kind === "root" ? roots.get(source.key)! : id();
      return requirement.aliases.map((alias) => ({
        definitionKey: source.key,
        scope: requirement.scope,
        kind: requirement.kind,
        componentOwner: requirement.componentOwner,
        alias,
        identifier,
      }));
    }),
  );
  const resolution = {
    contractVersion: "3.0.0" as const,
    definitions: sources.map((source) => ({
      kind: "module" as const,
      key: source.key,
      rootId: roots.get(source.key)!,
      exactVersion: "1.0.0",
    })),
    identities,
  };
  return sources.map((source) =>
    moduleCompilationRequestV3Schema.parse({
      sourceContractVersion: "3.0.0",
      validationContractVersion: "3.0.0",
      source,
      resolution: { ...resolution, fingerprint: fingerprintCanonicalValue(resolution) },
      draftMetadata: {
        organizationId: "10000000-0000-4000-8000-000000000001",
        draftRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: "10000000-0000-4000-8000-000000000002",
        updatedBy: "10000000-0000-4000-8000-000000000002",
      },
    }),
  );
};

const context = (organizationId: string, actorId: string): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "system",
    tenantId: "10000000-0000-4000-8000-000000000010",
    organizationId,
    systemActorId: actorId,
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

class PublicationRepository
  implements
    DefinitionPublicationRepository,
    DefinitionPublicationReader,
    DefinitionPublicationTransaction
{
  appended?: DefinitionReleaseAppend;

  constructor(
    readonly candidate: DefinitionPublicationCandidate,
    readonly dependency: ResolvableModuleRelease,
  ) {}

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
    return key === this.dependency.key ? [this.dependency] : [];
  }

  async readModuleRelease(_organizationId: string, rootId: string, releaseRevision: number) {
    return rootId === this.dependency.rootId && releaseRevision === this.dependency.releaseRevision
      ? this.dependency
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
      publishedBy: release.draft.updatedBy,
    };
  }
}

const applyRulePatch = (
  candidate: Readonly<Record<string, JsonValue>>,
  setValues: Readonly<Record<string, JsonValue>>,
  clearFieldIds: readonly string[],
): Record<string, JsonValue> => {
  const result = { ...candidate, ...setValues };
  clearFieldIds.forEach((fieldId) => delete result[fieldId]);
  return result;
};

describe("current Module V3 before-save engine handoff", () => {
  it("publishes and reads a graph that supplies a requirement and corrects the final candidate", async () => {
    const sharedSource = graphModuleFixture("shared");
    const candidateSource = graphModuleFixture("candidate");
    const sourceGraph = candidateSource.body.rules[0]!;
    sourceGraph.nodes.push({
      id: "supply_relation",
      node_version: "1.0.0",
      type: "set_field",
      field: "related",
      assignment: {
        kind: "set",
        value: { source: "input", input: "related_record" },
      },
    });
    sourceGraph.edges.find((edge) => edge.from === "require_relation")!.to = "supply_relation";
    sourceGraph.edges.push({ from: "supply_relation", port: "next", to: "warn_adjustment" });

    const requests = graphModuleRequests([sharedSource, candidateSource]);
    const sharedRequest = requests[0]!;
    const candidateRequest = requests[1]!;
    const sharedOutput = compileDefinition(sharedRequest);
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
        releaseNote: "Shared dependency",
      }),
    };
    const candidateDefinition = candidateRequest.resolution.definitions.find(
      (definition) =>
        definition.kind === "module" && definition.key === candidateRequest.source.key,
    );
    if (candidateDefinition?.kind !== "module") throw new Error("Candidate root required");
    const draft = storedDefinitionDraftSchema.parse({
      kind: "module",
      rootId: candidateDefinition.rootId,
      key: candidateRequest.source.key,
      draftRevision: 1,
      sourceContractVersion: "3.0.0",
      sourceFingerprint: fingerprintCanonicalValue(candidateRequest.source),
      source: candidateRequest.source,
      ...candidateRequest.draftMetadata,
    });
    const repository = new PublicationRepository(
      {
        draft,
        identities: candidateRequest.resolution.identities.filter(
          (identity) => identity.definitionKey === candidateRequest.source.key,
        ),
        history: { kind: "module", definitionKey: candidateRequest.source.key, history: [] },
      },
      sharedRelease,
    );
    const requestContext = context(
      candidateRequest.draftMetadata.organizationId,
      candidateRequest.draftMetadata.createdBy,
    );
    const publication = createDefinitionPublicationService(repository, catalogue);
    const prepared = await publication.prepare(requestContext, {
      rootId: draft.rootId,
      expectedDraftRevision: 1,
    });
    await publication.publish(requestContext, {
      confirmation: prepared.confirmation,
      releaseNote: "Executable before-save graph",
    });
    const appended = repository.appended;
    if (
      appended === undefined ||
      appended.compilationOutput.kind !== "module" ||
      appended.compilationOutput.validationContractVersion !== "3.0.0"
    )
      throw new Error("Published Module V3 output required");

    const evidence = {
      organizationId: candidateRequest.draftMetadata.organizationId,
      kind: "module" as const,
      key: candidateRequest.source.key,
      rootId: draft.rootId,
      releaseRevision: 1,
      releaseVersion: "1.0.0",
      sourceContractVersion: "3.0.0" as const,
      validationContractVersion: "3.0.0" as const,
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
    const release = await createDefinitionConsumerReadService(
      { read: async () => evidence },
      catalogue,
    ).read(requestContext, {
      kind: "module",
      rootId: draft.rootId,
      selector: { selection: "revision", releaseRevision: 1 },
    });
    if (release.kind !== "module" || release.validationContractVersion !== "3.0.0")
      throw new Error("Module V3 consumer release required");

    const recordType = release.content.recordTypes[0]!;
    const fieldByKey = new Map(recordType.fields.map((field) => [field.key, field]));
    const fieldId = (key: string) => {
      const field = fieldByKey.get(key);
      if (field === undefined) throw new Error(`Missing fixture field ${key}`);
      return field.fieldId;
    };
    const relatedRecordTypeId = sharedOutput.canonical.content.recordTypes.find(
      (recordType) => recordType.key === "related",
    )!.recordTypeId;
    const relatedValue = {
      recordTypeId: relatedRecordTypeId,
      recordId: "80000000-0000-4000-8000-000000000001",
    };
    const existingValues = {
      [fieldId("name")]: "Existing",
      [fieldId("amount")]: "9007199254740994",
      [fieldId("status")]: "draft",
      [fieldId("budget")]: { amount: "2000", currency: "USD" },
      [fieldId("obsolete_note")]: "Remove this",
    };
    const initial = prepareInitialRecordFieldCandidateV2({
      operation: "update",
      recordType,
      existingValues,
      submittedValues: { [fieldId("status")]: "ready" },
    });
    if (!initial.success) throw new Error("Initial Record candidate required");
    expect(
      finalizeRecordFieldCandidateV2({
        recordType,
        initialCandidate: initial.candidate,
        candidateValues: initial.candidate.candidateValues,
      }),
    ).toMatchObject({ success: false });

    const graph = release.content.rules[0]!;
    const inputId = (key: string) => {
      const declaration = graph.inputs.find((input) => input.key === key);
      if (declaration === undefined) throw new Error(`Missing graph input ${key}`);
      return declaration.inputId;
    };
    const evaluated = evaluateBeforeSaveRuleGraphs({
      release,
      subjectRecordTypeId: recordType.recordTypeId,
      operation: "update",
      initialCandidateValues: initial.candidate.candidateValues,
      previousValues: existingValues,
      inputValuesByRuleId: {
        [graph.ruleId]: {
          [inputId("requested_budget")]: { amount: "100", currency: "NZD" },
          [inputId("related_record")]: relatedValue,
        },
      },
    });
    if (!evaluated.success) throw new Error("Expected the published graph to complete");
    expect(evaluated.requirements).toEqual([
      expect.objectContaining({ fieldId: fieldId("related"), code: "related_required" }),
    ]);
    expect(evaluated.warnings).toEqual([
      { code: "budget_adjusted", message: "The proposed budget was applied." },
    ]);

    const finalCandidate = applyRulePatch(
      initial.candidate.candidateValues,
      evaluated.setValues,
      evaluated.clearFieldIds,
    );
    const finalized = finalizeRecordFieldCandidateV2({
      recordType,
      initialCandidate: initial.candidate,
      candidateValues: finalCandidate,
      requirements: evaluated.requirements,
    });
    expect(finalized).toMatchObject({
      success: true,
      setValues: {
        [fieldId("status")]: "ready",
        [fieldId("budget")]: { amount: "100", currency: "NZD" },
        [fieldId("related")]: relatedValue,
      },
      clearFieldIds: [fieldId("obsolete_note")],
      pendingChecks: [
        expect.objectContaining({
          kind: "record_reference",
          fieldId: fieldId("related"),
          recordId: relatedValue.recordId,
        }),
      ],
    });
  });
});
