import fs from "node:fs";
import path from "node:path";
import {
  definitionResolutionSnapshotSchema,
  definitionResolutionSnapshotV2Schema,
  definitionSourceDocumentSchema,
  moduleSourceDocumentV2Schema,
  publishedDefinitionHistorySchema,
  publishedModuleDefinitionSchema,
  sessionContextSchema,
  storedDefinitionDraftSchema,
  type DefinitionCompilationOutput,
  type DefinitionResolutionSnapshot,
  type DefinitionResolutionSnapshotV2,
  type PublishedDefinitionHistory,
  type PublishDefinitionResult,
  type SessionContext,
} from "@vortex/contracts";
import {
  createDefinitionConsumerReadService,
  createDefinitionPublicationService,
  fingerprintCanonicalValue,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationReader,
  type DefinitionPublicationRepository,
  type DefinitionPublicationTransaction,
  type DefinitionReleaseAppend,
  type ResolvableConnectionTypeRelease,
  type ResolvableModuleRelease,
} from "@vortex/definition";
import { compileDefinition, compileDefinitionSet } from "@vortex/definition/compiler";
import { prepareRecordFieldValuesV2 } from "@vortex/record";
import { describe, expect, it } from "vitest";

const fixtureRoot = path.resolve("testing/fixtures");
const historicalRoot = path.join(fixtureRoot, "historical/module-v1");
const read = (root: string, relative: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));

const moduleFiles = [
  "modules/crm.organisations.json",
  "modules/crm.people.json",
  "modules/crm.opportunities.json",
  "modules/crm.activities.json",
  "modules/crm.tags.json",
  "modules/service-desk.sla.json",
  "modules/service-desk.cases.json",
  "modules/service-desk.knowledge.json",
] as const;
const applicationFiles = ["applications/crm.json", "applications/service-desk.json"] as const;
const connectionFiles = [
  "connection-types/email.json",
  "connection-types/calendar.json",
  "connection-types/webhook.json",
] as const;

const currentModules = moduleFiles.map((file) => moduleSourceDocumentV2Schema.parse(read(fixtureRoot, file)));
const currentApplications = applicationFiles.map((file) =>
  definitionSourceDocumentSchema.parse(read(fixtureRoot, file)),
);
const currentConnections = connectionFiles.map((file) =>
  definitionSourceDocumentSchema.parse(read(fixtureRoot, file)),
);
const historicalSources = [...moduleFiles, ...applicationFiles, ...connectionFiles].map((file) =>
  definitionSourceDocumentSchema.parse(read(historicalRoot, file)),
);
const resolutionV1 = definitionResolutionSnapshotSchema.parse(
  read(fixtureRoot, "definition-resolution-snapshot.json"),
);
const resolutionV2 = definitionResolutionSnapshotV2Schema.parse(
  read(fixtureRoot, "module-v2-definition-resolution-snapshot.json"),
);
const historicalResolution = definitionResolutionSnapshotSchema.parse(
  read(historicalRoot, "definition-resolution-snapshot.json"),
);

const organizationId = "10000000-0000-4000-a000-000000000001";
const actorId = "10000000-0000-4000-a000-000000000002";
const publishedAt = "2026-09-09T00:00:00.000Z";
const context = (): SessionContext =>
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

const draftMetadata = (draftRevision: number, publishedRevision?: number) => ({
  organizationId,
  draftRevision,
  ...(publishedRevision === undefined ? {} : { publishedRevision }),
  createdAt: publishedAt,
  createdBy: actorId,
  updatedAt: publishedAt,
  updatedBy: actorId,
});

const conditionRevisions = (
  source: (typeof currentModules)[number] | Extract<(typeof historicalSources)[number], { kind: "module" }>,
  resolution: DefinitionResolutionSnapshot | DefinitionResolutionSnapshotV2,
) =>
  source.body.sharing_conditions.map((condition) => {
    const identity = resolution.identities.find(
      (candidate) =>
        candidate.definitionKey === source.key &&
        candidate.kind === "sharing_condition" &&
        candidate.componentOwner === condition.id,
    );
    if (!identity) throw new Error(`Sharing-condition identity required for ${source.key}`);
    return { conditionId: identity.identifier, revision: 1 };
  });

const historicalOutputs = compileDefinitionSet(
  historicalSources.map((source) => ({
    source,
    resolution: historicalResolution,
    ...(source.kind === "connection_type" ? {} : { draftMetadata: draftMetadata(1) }),
    ...(source.kind === "module"
      ? { savedConditionRevisions: conditionRevisions(source, historicalResolution) }
      : {}),
  })),
  {
    publishedHistories: historicalSources
      .filter((source) => source.kind === "module" || source.kind === "application")
      .map((source) => ({ kind: source.kind, definitionKey: source.key, history: [] })),
  },
);

type ModuleOutput = Extract<DefinitionCompilationOutput, { kind: "module" }>;
const historicalModuleOutputs = historicalOutputs.filter(
  (output): output is ModuleOutput => output.kind === "module",
);
const historicalPublicationByKey = new Map(
  historicalModuleOutputs.map((output) => [
    output.artifact.definitionKey,
    {
      kind: "module" as const,
      rootId: output.artifact.rootId,
      revision: 1,
      releaseVersion: "1.0.0",
      contentFingerprint: output.artifact.contentFingerprint,
      publishedAt,
      publishedBy: actorId,
      validationContractVersion: "1.0.0" as const,
    },
  ]),
);
const historicalPublishedByKey = new Map(
  historicalModuleOutputs.map((output) => {
    const published = publishedModuleDefinitionSchema.parse({
      publication: historicalPublicationByKey.get(output.artifact.definitionKey),
      content: output.canonical.content,
      dependencyManifest: output.resolvedDependencies.flatMap((dependency) => {
        if (dependency.kind !== "module") return [];
        const publication = historicalPublicationByKey.get(dependency.key);
        if (!publication) throw new Error(`Historical dependency required for ${dependency.key}`);
        return [publication];
      }),
      releaseNote: "Historical Module V1 fixture baseline",
    });
    return [output.artifact.definitionKey, published] as const;
  }),
);
const historicalModuleReleases: ResolvableModuleRelease[] = historicalModuleOutputs.map(
  (output) => ({
    organizationId,
    key: output.artifact.definitionKey,
    rootId: output.artifact.rootId,
    releaseRevision: 1,
    releaseVersion: "1.0.0",
    contentFingerprint: output.artifact.contentFingerprint,
    resolutionFingerprint: output.resolutionFingerprint,
    published: historicalPublishedByKey.get(output.artifact.definitionKey)!,
    compilationOutput: output,
    resolutionSnapshot: historicalResolution,
  }),
);

const connectionReleases: ResolvableConnectionTypeRelease[] = currentConnections.map((source) => {
  if (source.kind !== "connection_type") throw new Error("Connection fixture required");
  const output = compileDefinition({ source, resolution: resolutionV1 });
  if (output.kind !== "connection_type") throw new Error("Connection output required");
  return {
    key: source.key,
    rootId: output.artifact.rootId,
    releaseVersion: output.artifact.exactVersion,
    contentFingerprint: output.artifact.contentFingerprint,
    catalogueFingerprint: output.artifact.contentFingerprint,
    compilationOutput: output,
  };
});

const catalogue: DefinitionPublicationCatalogue = {
  listConnectionTypeReleases: async (key) =>
    connectionReleases.filter((release) => release.key === key),
  readConnectionTypeRelease: async (rootId, releaseVersion) =>
    connectionReleases.find(
      (release) => release.rootId === rootId && release.releaseVersion === releaseVersion,
    ),
  readPlatformThemeRelease: async () => undefined,
  readPlatformBlockReleaseV2: async () => undefined,
  readPlatformThemeReleaseV2: async () => undefined,
  readApplicationCompositionCatalogueSnapshotV2: async () => undefined,
};

const candidateFor = (
  source: (typeof currentModules)[number] | (typeof currentApplications)[number],
): DefinitionPublicationCandidate => {
  if (source.kind === "connection_type") throw new Error("Customer definition required");
  const resolution = source.kind === "module" ? resolutionV2 : resolutionV1;
  const own = resolution.definitions.find(
    (definition) => definition.kind === source.kind && definition.key === source.key,
  );
  if (!own || own.kind !== source.kind) throw new Error(`Definition root required for ${source.key}`);
  const moduleV2 = source.kind === "module";
  const sourceFingerprint = fingerprintCanonicalValue(source);
  const draft = storedDefinitionDraftSchema.parse({
    kind: source.kind,
    rootId: own.rootId,
    key: source.key,
    sourceContractVersion: source.source_contract_version,
    sourceFingerprint,
    source,
    ...draftMetadata(moduleV2 ? 2 : 1, moduleV2 ? 1 : undefined),
  });
  const history: PublishedDefinitionHistory = moduleV2
    ? publishedDefinitionHistorySchema.parse({
        kind: "module",
        definitionKey: source.key,
        history: [historicalPublishedByKey.get(source.key)],
      })
    : { kind: "application", definitionKey: source.key, history: [] };
  return {
    draft,
    identities: resolution.identities.filter((identity) => identity.definitionKey === source.key),
    history,
  };
};

class FixturePublicationRepository
  implements
    DefinitionPublicationRepository,
    DefinitionPublicationReader,
    DefinitionPublicationTransaction
{
  readonly candidates = new Map<string, DefinitionPublicationCandidate>();
  readonly moduleReleases: ResolvableModuleRelease[];
  readonly releaseEvidence = new Map<string, unknown>();

  constructor(
    candidates: readonly DefinitionPublicationCandidate[],
    moduleReleases: readonly ResolvableModuleRelease[] = historicalModuleReleases,
  ) {
    for (const candidate of candidates) this.candidates.set(candidate.draft.rootId, candidate);
    this.moduleReleases = structuredClone(moduleReleases) as ResolvableModuleRelease[];
  }

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

  async readCandidate(rootId: string) {
    const candidate = this.candidates.get(rootId);
    return candidate === undefined ? undefined : structuredClone(candidate);
  }

  async lockCandidate(rootId: string) {
    return this.readCandidate(rootId);
  }

  async listModuleReleases(candidateOrganizationId: string, key: string) {
    return this.moduleReleases.filter(
      (release) => release.organizationId === candidateOrganizationId && release.key === key,
    );
  }

  async readModuleRelease(
    candidateOrganizationId: string,
    rootId: string,
    releaseRevision: number,
  ) {
    return this.moduleReleases.find(
      (release) =>
        release.organizationId === candidateOrganizationId &&
        release.rootId === rootId &&
        release.releaseRevision === releaseRevision,
    );
  }

  async appendRelease(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult> {
    const output = release.compilationOutput;
    const publication = {
      kind: output.kind,
      rootId: output.artifact.rootId,
      revision: release.draft.draftRevision,
      releaseVersion: release.assignedVersion,
      contentFingerprint: output.artifact.contentFingerprint,
      publishedAt,
      publishedBy: actorId,
      validationContractVersion: release.validationContractVersion,
    } as const;
    const dependencyPublications = release.dependencyManifest.flatMap((dependency) => {
      if (dependency.kind !== "module") return [];
      const target = this.moduleReleases.find(
        (candidate) =>
          candidate.rootId === dependency.rootId &&
          candidate.releaseRevision === dependency.releaseRevision,
      );
      if (!target) throw new Error(`Published dependency required for ${dependency.key}`);
      return [target.published.publication];
    });
    const entry = {
      publication,
      content: output.canonical.content,
      dependencyManifest: dependencyPublications,
      releaseNote: release.releaseNote,
    };
    const candidate = this.candidates.get(release.draft.rootId);
    if (!candidate) throw new Error(`Candidate required for ${release.draft.key}`);
    const history = publishedDefinitionHistorySchema.parse({
      kind: output.kind,
      definitionKey: release.draft.key,
      history: [...candidate.history.history, entry],
    });
    this.candidates.set(release.draft.rootId, {
      ...candidate,
      draft: { ...candidate.draft, publishedRevision: release.draft.draftRevision },
      history,
    });

    if (output.kind === "module") {
      const published = history.history.at(-1)!;
      this.moduleReleases.push({
        organizationId,
        key: release.draft.key,
        rootId: output.artifact.rootId,
        releaseRevision: release.draft.draftRevision,
        releaseVersion: release.assignedVersion,
        contentFingerprint: output.artifact.contentFingerprint,
        resolutionFingerprint: output.resolutionFingerprint,
        published,
        compilationOutput: output,
        resolutionSnapshot: release.resolutionSnapshot,
      });
    }

    this.releaseEvidence.set(output.artifact.rootId, {
      organizationId,
      kind: output.kind,
      key: release.draft.key,
      rootId: output.artifact.rootId,
      releaseRevision: release.draft.draftRevision,
      releaseVersion: release.assignedVersion,
      sourceContractVersion: release.draft.sourceContractVersion,
      validationContractVersion: release.validationContractVersion,
      contentFingerprint: output.artifact.contentFingerprint,
      resolutionFingerprint: output.resolutionFingerprint,
      compilationOutput: output,
      resolutionSnapshot: release.resolutionSnapshot,
      dependencyManifest: release.dependencyManifest,
      moduleDependencyTargets: release.dependencyManifest.flatMap((dependency) =>
        dependency.kind === "module"
          ? [
              {
                rootId: dependency.rootId,
                releaseRevision: dependency.releaseRevision,
                releaseVersion: dependency.releaseVersion,
                contentFingerprint: dependency.contentFingerprint,
                resolutionFingerprint: dependency.resolutionFingerprint,
              },
            ]
          : [],
      ),
    });
    return {
      rootId: output.artifact.rootId,
      releaseRevision: release.draft.draftRevision,
      releaseVersion: release.assignedVersion,
      contentFingerprint: output.artifact.contentFingerprint,
      resolutionFingerprint: output.resolutionFingerprint,
      comparisonFingerprint: release.comparisonFingerprint,
      dependencyManifest: release.dependencyManifest,
      publishedAt,
      publishedBy: actorId,
    };
  }
}

const publish = async (repository: FixturePublicationRepository, rootId: string) => {
  const service = createDefinitionPublicationService(repository, catalogue);
  const candidate = repository.candidates.get(rootId);
  if (!candidate) throw new Error(`Candidate required for ${rootId}`);
  const prepared = await service.prepare(context(), {
    rootId,
    expectedDraftRevision: candidate.draft.draftRevision,
  });
  return service.publish(context(), {
    confirmation: prepared.confirmation,
    releaseNote: "Current editable fixture release",
  });
};

const moduleByKey = new Map(currentModules.map((source) => [source.key, source] as const));
const publishModulesInDependencyOrder = async (repository: FixturePublicationRepository) => {
  const pending = new Set(moduleByKey.keys());
  while (pending.size > 0) {
    const ready = [...pending].find((key) =>
      moduleByKey
        .get(key)!
        .body.dependencies.every((dependency) => !pending.has(dependency.module)),
    );
    if (!ready) throw new Error("Current Module fixture dependency cycle");
    try {
      await publish(repository, candidateFor(moduleByKey.get(ready)!).draft.rootId);
    } catch (error) {
      const detail = error as { code?: string };
      throw new Error(`${ready}:${detail.code ?? "publication failed"}`, { cause: error });
    }
    pending.delete(ready);
  }
};

const fieldValues = (
  recordType: { fields: readonly { fieldId: string; key: string }[] },
  values: Readonly<Record<string, unknown>>,
) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const field = recordType.fields.find((candidate) => candidate.key === key);
      if (!field) throw new Error(`Field required: ${key}`);
      return [field.fieldId, value];
    }),
  );

describe("current Module V2 fixture runtime", () => {
  it("publishes, reads and prepares records from the complete current application bundle", async () => {
    const candidates = [...currentModules, ...currentApplications].map(candidateFor);
    const repository = new FixturePublicationRepository(candidates);
    await publishModulesInDependencyOrder(repository);
    for (const application of currentApplications) {
      if (application.kind !== "application") throw new Error("Application fixture required");
      await publish(repository, candidateFor(application).draft.rootId);
    }

    const currentReleases = repository.moduleReleases.filter(
      (release) => release.releaseVersion === "2.0.0",
    );
    expect(currentReleases).toHaveLength(8);
    expect(currentReleases.every((release) => release.releaseRevision === 2)).toBe(true);

    const consumer = createDefinitionConsumerReadService(
      {
        read: async (_readContext, command) => repository.releaseEvidence.get(command.rootId),
      },
      catalogue,
    );
    const readCurrent = (kind: "module" | "application", rootId: string) =>
      consumer.read(context(), { kind, rootId, selector: { selection: "current" } });
    const moduleReads = await Promise.all(
      currentReleases.map((release) => readCurrent("module", release.rootId)),
    );
    const applicationReads = await Promise.all(
      currentApplications.map((application) => {
        if (application.kind !== "application") throw new Error("Application fixture required");
        const rootId = resolutionV1.definitions.find(
          (definition) => definition.kind === "application" && definition.key === application.key,
        )?.rootId;
        if (!rootId) throw new Error(`Application root required for ${application.key}`);
        return readCurrent("application", rootId);
      }),
    );
    expect(moduleReads.every((result) => result.validationContractVersion === "2.0.0")).toBe(true);
    expect(applicationReads.every((result) => result.validationContractVersion === "1.0.0")).toBe(
      true,
    );

    const [crm, desk] = applicationReads;
    if (crm?.kind !== "application" || desk?.kind !== "application")
      throw new Error("Both current Applications must read back");
    for (const moduleKey of ["vortex.crm.organisations", "vortex.crm.people"]) {
      const rootId = resolutionV2.definitions.find(
        (definition) => definition.kind === "module" && definition.key === moduleKey,
      )?.rootId;
      expect(crm.content.moduleBindings).toContainEqual(
        expect.objectContaining({ moduleRootId: rootId, resolvedVersion: "2.0.0" }),
      );
      expect(desk.content.moduleBindings).toContainEqual(
        expect.objectContaining({ moduleRootId: rootId, resolvedVersion: "2.0.0" }),
      );
    }

    const moduleReadsByKey = new Map(
      currentReleases.map((release, index) => [release.key, moduleReads[index]!] as const),
    );
    const moduleRead = (key: string) => {
      const result = moduleReadsByKey.get(key);
      if (result?.kind !== "module" || result.validationContractVersion !== "2.0.0")
        throw new Error(`Current Module V2 consumer result required for ${key}`);
      return result;
    };
    const company = moduleRead("vortex.crm.organisations").content.recordTypes.find(
      (recordType) => recordType.key === "company",
    )!;
    const contact = moduleRead("vortex.crm.people").content.recordTypes.find(
      (recordType) => recordType.key === "contact",
    )!;
    const caseRecord = moduleRead("vortex.service_desk.cases").content.recordTypes.find(
      (recordType) => recordType.key === "case",
    )!;
    const companyPrepared = prepareRecordFieldValuesV2({
      operation: "create",
      recordType: company,
      submittedValues: fieldValues(company, {
        name: "South Harbour Ltd",
        company_kind: ["customer"],
        annual_revenue: { amount: "1200000.2500", currency: "NZD" },
      }),
    });
    const contactPrepared = prepareRecordFieldValuesV2({
      operation: "create",
      recordType: contact,
      submittedValues: fieldValues(contact, {
        first_name: "Aroha",
        last_name: "Ngata",
        email: "aroha@example.test",
      }),
    });
    const casePrepared = prepareRecordFieldValuesV2({
      operation: "create",
      recordType: caseRecord,
      submittedValues: fieldValues(caseRecord, {
        subject: "Cannot access the portal",
        description: {
          blocks: [
            { kind: "paragraph", children: [{ kind: "text", text: "Please investigate." }] },
          ],
        },
        customer_company: {
          recordTypeId: company.recordTypeId,
          recordId: "20000000-0000-4000-8000-000000000001",
        },
        requester: {
          recordTypeId: contact.recordTypeId,
          recordId: "20000000-0000-4000-8000-000000000002",
        },
        service_level: {
          recordTypeId: moduleRead("vortex.service_desk.sla").content.recordTypes.find(
            (recordType) => recordType.key === "service_level",
          )!.recordTypeId,
          recordId: "20000000-0000-4000-8000-000000000003",
        },
        opened_at: "2026-09-09T09:00:00+12:00",
        first_response_due_at: "2026-09-09T10:00:00+12:00",
        resolution_due_at: "2026-09-10T09:00:00+12:00",
      }),
    });
    expect(companyPrepared).toMatchObject({
      success: true,
      setValues: expect.objectContaining({
        [company.fields.find((field) => field.key === "annual_revenue")!.fieldId]: {
          amount: "1200000.25",
          currency: "NZD",
        },
      }),
    });
    expect(contactPrepared).toMatchObject({ success: true });
    expect(casePrepared).toMatchObject({ success: true });
    if (!casePrepared.success) throw new Error("Case values must prepare");
    expect(casePrepared.pendingChecks.filter((check) => check.kind === "record_reference")).toHaveLength(
      3,
    );

    const scenario = read(fixtureRoot, "scenarios/cross-application-sharing.json") as {
      body: {
        inter_application_grant: {
          readable_fields: string[];
          changeable_fields: string[];
        };
      };
    };
    const readableIds = scenario.body.inter_application_grant.readable_fields.map(
      (key) => caseRecord.fields.find((field) => field.key === key)!.fieldId,
    );
    const changeableIds = scenario.body.inter_application_grant.changeable_fields.map(
      (key) => caseRecord.fields.find((field) => field.key === key)!.fieldId,
    );
    expect(readableIds).toHaveLength(6);
    expect(changeableIds).toHaveLength(2);
    expect(readableIds).not.toContain(
      caseRecord.fields.find((field) => field.key === "description")!.fieldId,
    );
    expect(readableIds).not.toContain(
      caseRecord.fields.find((field) => field.key === "attachments")!.fieldId,
    );
  });

  it("keeps dependency-owned resolution evidence while refusing substituted releases", async () => {
    const candidates = [...currentModules, ...currentApplications].map(candidateFor);
    const repository = new FixturePublicationRepository(candidates);
    await publishModulesInDependencyOrder(repository);
    const crmSource = currentApplications.find((source) => source.key === "vortex.app.crm");
    if (crmSource?.kind !== "application") throw new Error("CRM Application required");
    const crmRoot = candidateFor(crmSource).draft.rootId;
    await publish(repository, crmRoot);
    const evidence = repository.releaseEvidence.get(crmRoot) as {
      resolutionFingerprint: string;
      dependencyManifest: Array<{ kind: string; resolutionFingerprint?: string }>;
    };
    const moduleFingerprints = evidence.dependencyManifest.flatMap((dependency) =>
      dependency.kind === "module" && dependency.resolutionFingerprint
        ? [dependency.resolutionFingerprint]
        : [],
    );
    expect(moduleFingerprints.length).toBeGreaterThan(0);
    expect(moduleFingerprints.every((fingerprint) => fingerprint !== evidence.resolutionFingerprint)).toBe(
      true,
    );

    const currentModuleReleases = repository.moduleReleases.filter(
      (release) => release.releaseVersion === "2.0.0",
    );
    const dependency = currentModuleReleases.find(
      (release) => release.key === "vortex.crm.organisations",
    )!;
    const mutations: Array<(release: ResolvableModuleRelease) => ResolvableModuleRelease> = [
      (release) => ({ ...release, rootId: "30000000-0000-4000-8000-000000000099" }),
      (release) => ({ ...release, releaseVersion: "9.0.0" }),
      (release) => ({ ...release, contentFingerprint: `sha256:${"0".repeat(64)}` }),
      (release) => ({
        ...release,
        compilationOutput: {
          ...release.compilationOutput,
          artifact: {
            ...release.compilationOutput.artifact,
            resolutionFingerprint: `sha256:${"1".repeat(64)}`,
          },
        },
      }),
    ];
    for (const mutate of mutations) {
      const invalidReleases = currentModuleReleases.map((release) =>
        release.key === dependency.key ? mutate(structuredClone(release)) : release,
      );
      const invalidRepository = new FixturePublicationRepository(
        [candidateFor(crmSource)],
        invalidReleases,
      );
      await expect(
        createDefinitionPublicationService(invalidRepository, catalogue).prepare(context(), {
          rootId: crmRoot,
          expectedDraftRevision: 1,
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(
          /^DEFINITION_DEPENDENCY_(SUBSTITUTED|INCOMPATIBLE|MISSING)$/,
        ),
      });
    }
  });
});
