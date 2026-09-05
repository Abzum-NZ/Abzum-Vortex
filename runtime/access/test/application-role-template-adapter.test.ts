import fs from "node:fs";
import path from "node:path";
import {
  definitionResolutionSnapshotSchema,
  definitionSourceDocumentSchema,
  sessionContextSchema,
  type ApplicationPermissionCatalogueSnapshot,
  type DefinitionConsumerReadCommand,
  type DefinitionConsumerReadResult,
  type DefinitionSourceDocument,
  type ExactDefinitionDependency,
  type PermissionCatalogueLookupResult,
  type PreparedApplicationPermissionRegistration,
  type SessionContext,
} from "@vortex/contracts";
import {
  compareCanonicalStrings,
  compileDefinition,
  fingerprintCanonicalValue,
} from "@vortex/definition";
import { describe, expect, it, vi } from "vitest";
import {
  applicationRoleTemplateFactReadConcurrency,
  createApplicationRoleTemplateAdapter,
  verifyPreparedApplicationRoleTemplates,
  type ApplicationRoleTemplateAdapterDependencies,
  type ApplicationRoleTemplatePreparationError,
} from "../src/application-role-template-adapter";
import type { PermissionRegistryDefinitionReader } from "../src/permission-registry-definition-adapter";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../testing/fixtures");
const organizationId = "10000000-0000-4000-a000-000000000001";
const actorId = "10000000-0000-4000-a000-000000000002";
const correlationId = "50000000-0000-4000-8000-000000000001";
const dependencyFingerprint = `sha256:${"d".repeat(64)}`;
const catalogueFingerprint = `sha256:${"e".repeat(64)}`;
const registrationRevision = 7;
const savedConditionRevisions = [
  { conditionId: "a4b5546d-8a54-4003-adc4-ddb8b0d7257d", revision: 1 },
] as const;

const resolution = definitionResolutionSnapshotSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "definition-resolution-snapshot.json"), "utf8"),
  ),
);

const readSource = (folder: "modules" | "applications", filename: string) =>
  definitionSourceDocumentSchema.parse(
    JSON.parse(fs.readFileSync(path.join(fixtureRoot, folder, filename), "utf8")),
  );

const compileSource = (source: DefinitionSourceDocument) =>
  compileDefinition({
    source,
    resolution,
    draftMetadata: {
      organizationId,
      draftRevision: 1,
      createdAt: "2026-09-05T00:00:00.000Z",
      createdBy: actorId,
      updatedAt: "2026-09-05T00:00:00.000Z",
      updatedBy: actorId,
    },
    savedConditionRevisions: source.kind === "module" ? savedConditionRevisions : [],
  });

const compileFixture = (folder: "modules" | "applications", filename: string) =>
  compileSource(readSource(folder, filename));

const moduleFiles = [
  "crm.activities.json",
  "crm.opportunities.json",
  "crm.organisations.json",
  "crm.people.json",
  "crm.tags.json",
  "service-desk.cases.json",
  "service-desk.knowledge.json",
  "service-desk.sla.json",
] as const;
const moduleOutputs = moduleFiles.map((filename) => {
  const output = compileFixture("modules", filename);
  if (output.kind !== "module") throw new Error("Module fixture required");
  return output;
});
const moduleOutputByRoot = new Map(
  moduleOutputs.map((output) => [output.canonical.envelope.rootId, output] as const),
);

const definitionKeyFor = (kind: "module" | "connection_type", rootId: string): string => {
  const entry = resolution.definitions.find(
    (candidate) => candidate.kind === kind && candidate.rootId === rootId,
  );
  if (!entry) throw new Error("Resolution fixture is incomplete");
  return entry.key;
};

const dependencyManifestFor = (
  applicationOutput: Extract<ReturnType<typeof compileSource>, { kind: "application" }>,
): ExactDefinitionDependency[] =>
  [
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
      (binding): ExactDefinitionDependency => {
        const output = moduleOutputByRoot.get(binding.moduleRootId);
        if (!output) throw new Error("Bound module fixture is missing");
        return {
          kind: "module",
          key: definitionKeyFor("module", binding.moduleRootId),
          rootId: binding.moduleRootId,
          releaseRevision: 1,
          releaseVersion: binding.resolvedVersion,
          contentFingerprint: fingerprintCanonicalValue(output.canonical.content),
          resolutionFingerprint: resolution.fingerprint,
        };
      },
    ),
  ].sort((left, right) => {
    const subject = (entry: ExactDefinitionDependency) =>
      `${entry.kind}:${"key" in entry ? entry.key : entry.catalogueThemeId}`;
    return compareCanonicalStrings(subject(left), subject(right));
  });

const resultFor = (
  output: ReturnType<typeof compileSource>,
  dependencyManifest: readonly ExactDefinitionDependency[],
): DefinitionConsumerReadResult =>
  ({
    kind: output.kind,
    organizationId,
    definitionKey: output.canonical.envelope.key,
    rootId: output.canonical.envelope.rootId,
    releaseRevision: 1,
    releaseVersion: "1.0.0",
    validationContractVersion: "1.0.0",
    contentFingerprint: fingerprintCanonicalValue(output.canonical.content),
    resolutionFingerprint: resolution.fingerprint,
    content: output.canonical.content,
    dependencyManifest: [...dependencyManifest],
    correlationId,
  }) as DefinitionConsumerReadResult;

const applicationOutput = compileFixture("applications", "crm.json");
if (applicationOutput.kind !== "application") throw new Error("Application fixture required");
const applicationResult = resultFor(applicationOutput, dependencyManifestFor(applicationOutput));
if (applicationResult.kind !== "application") throw new Error("Application result required");
const moduleResults = new Map(
  moduleOutputs.map((output) => {
    const result = resultFor(output, []);
    return [result.rootId, result] as const;
  }),
);

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

const readerFor = (
  application: DefinitionConsumerReadResult = applicationResult,
  modules: ReadonlyMap<string, DefinitionConsumerReadResult> = moduleResults,
) => {
  const read = vi.fn(async (_context: SessionContext, command: DefinitionConsumerReadCommand) => {
    const candidate = command.kind === "application" ? application : modules.get(command.rootId);
    if (!candidate) throw new Error("not found");
    return candidate;
  });
  return { reader: { read } satisfies PermissionRegistryDefinitionReader, read };
};

const unavailableFacts =
  (): ApplicationRoleTemplateAdapterDependencies["permissionRegistryFacts"] => ({
    lookup: vi.fn(async () => ({ outcome: "unavailable" as const })),
    readApplicationSnapshot: vi.fn(async () => undefined),
  });

const prepareInitial = (
  reader: PermissionRegistryDefinitionReader,
  selectedContext: SessionContext = context(),
) =>
  createApplicationRoleTemplateAdapter({
    definitionReader: reader,
    permissionRegistryFacts: unavailableFacts(),
  }).prepareRegistrationCandidate(selectedContext, {
    applicationRootId: applicationResult.rootId,
    releaseRevision: applicationResult.releaseRevision,
  });

const snapshotFor = (
  registration: PreparedApplicationPermissionRegistration,
  revision = registrationRevision,
): ApplicationPermissionCatalogueSnapshot => ({
  organizationId: registration.organizationId,
  applicationRootId: registration.applicationRootId,
  registrationRevision: revision,
  applicationRelease: registration.applicationRelease,
  catalogueFingerprint: registration.applicationCatalogueFingerprint,
  permissionIds: registration.applicationPermissionIds,
});

const availableResult = (
  registration: PreparedApplicationPermissionRegistration,
  command: Parameters<
    ApplicationRoleTemplateAdapterDependencies["permissionRegistryFacts"]["lookup"]
  >[0],
  revision = registrationRevision,
): PermissionCatalogueLookupResult => {
  const candidate = registration.entries.find(
    (entry) =>
      entry.applicationRootId === command.applicationRootId &&
      entry.ownerKind === command.ownerKind &&
      entry.ownerId === command.ownerId &&
      entry.permission.permissionId === command.permissionId,
  );
  if (!candidate) return { outcome: "unavailable" };
  return {
    outcome: "available",
    entry: {
      organizationId: registration.organizationId,
      registrationRevision: revision,
      ...candidate,
    },
  };
};

const factsFor = (
  registration: PreparedApplicationPermissionRegistration,
  options: {
    readonly snapshots?: readonly (ApplicationPermissionCatalogueSnapshot | undefined)[];
    readonly lookup?: (
      command: Parameters<
        ApplicationRoleTemplateAdapterDependencies["permissionRegistryFacts"]["lookup"]
      >[0],
    ) => Promise<PermissionCatalogueLookupResult>;
  } = {},
) => {
  const snapshots = options.snapshots ?? [snapshotFor(registration), snapshotFor(registration)];
  let snapshotIndex = 0;
  const readApplicationSnapshot = vi.fn(
    async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
  );
  const lookup = vi.fn(
    options.lookup ?? (async (command) => availableResult(registration, command)),
  );
  return { facts: { lookup, readApplicationSnapshot }, lookup, readApplicationSnapshot };
};

const expectCode = async (
  promise: Promise<unknown>,
  code: ApplicationRoleTemplatePreparationError["code"],
) => {
  await expect(promise).rejects.toMatchObject({ code });
};

const wildcardApplication = (onlyExport = false) => {
  const source = structuredClone(readSource("applications", "crm.json")) as Extract<
    DefinitionSourceDocument,
    { kind: "application" }
  >;
  const exportSourcePermission = source.body.permissions.find(
    (permission) => permission.id === "app_permission_3",
  );
  if (!exportSourcePermission) throw new Error("Application permission fixture required");
  exportSourcePermission.label = "Export CRM data";
  exportSourcePermission.description = "Allows exporting CRM data.";
  exportSourcePermission.action_kind = "export";
  delete exportSourcePermission.named_action;
  source.body.roles[0]!.permissions = ["*"];
  const output = compileSource(source);
  if (output.kind !== "application") throw new Error("Application fixture required");
  const result = resultFor(output, dependencyManifestFor(output));
  if (result.kind !== "application") throw new Error("Application result required");
  result.content.roles = [result.content.roles[0]!];
  result.contentFingerprint = fingerprintCanonicalValue(result.content);
  if (!onlyExport) return result;
  const exportPermission = result.content.permissions.find(
    (permission) => permission.actionKind === "export",
  );
  if (!exportPermission) throw new Error("Export permission required");
  const reduced = structuredClone(result);
  reduced.content.permissions = [exportPermission];
  const wildcard = reduced.content.roles[0]!;
  wildcard.permissionKeys = [exportPermission.key];
  wildcard.permissionSelection = {
    kind: "application_wildcard",
    catalogueFingerprint: fingerprintCanonicalValue([exportPermission]),
  };
  reduced.contentFingerprint = fingerprintCanonicalValue(reduced.content);
  return reduced;
};

describe("application role template adapter", () => {
  it("prepares immutable templates for an initial registration without reading live facts", async () => {
    const { reader } = readerFor();
    const facts = unavailableFacts();
    const adapter = createApplicationRoleTemplateAdapter({
      definitionReader: reader,
      permissionRegistryFacts: facts,
    });
    const prepared = await adapter.prepareRegistrationCandidate(context(), {
      applicationRootId: applicationResult.rootId,
      releaseRevision: applicationResult.releaseRevision,
    });

    expect(prepared.preparationBasis).toEqual({ kind: "registration_candidate" });
    expect(prepared.templates.map((entry) => entry.template.roleId)).toEqual(
      applicationResult.content.roles.map((role) => role.roleId),
    );
    expect(facts.readApplicationSnapshot).not.toHaveBeenCalled();
    expect(facts.lookup).not.toHaveBeenCalled();
    expect(verifyPreparedApplicationRoleTemplates(prepared)).toEqual(prepared);
    expect(
      await adapter.prepareRegistrationCandidate(context(), {
        applicationRootId: applicationResult.rootId,
        releaseRevision: applicationResult.releaseRevision,
      }),
    ).toEqual(prepared);

    const changedTemplate = structuredClone(prepared);
    changedTemplate.templates[0]!.sourceTemplateFingerprint = `sha256:${"0".repeat(64)}`;
    expect(() => verifyPreparedApplicationRoleTemplates(changedTemplate)).toThrow();
    const changedCandidate = structuredClone(prepared);
    changedCandidate.candidateFingerprint = `sha256:${"0".repeat(64)}`;
    expect(() => verifyPreparedApplicationRoleTemplates(changedCandidate)).toThrow();
    const changedBasis = structuredClone(prepared);
    changedBasis.preparationBasis = {
      kind: "current_active_registration",
      registrationRevision,
    };
    expect(() => verifyPreparedApplicationRoleTemplates(changedBasis)).toThrow();
  });

  it("uses exact current #32 facts with bounded reads and a stable active revision", async () => {
    const { reader } = readerFor();
    const initial = await prepareInitial(reader);
    let active = 0;
    let maxActive = 0;
    const { facts, lookup, readApplicationSnapshot } = factsFor(initial.permissionRegistration, {
      lookup: async (command) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return availableResult(initial.permissionRegistration, command);
      },
    });
    const prepared = await createApplicationRoleTemplateAdapter({
      definitionReader: reader,
      permissionRegistryFacts: facts,
    }).prepareCurrentActive(context(), { applicationRootId: applicationResult.rootId });

    expect(prepared.preparationBasis).toEqual({
      kind: "current_active_registration",
      registrationRevision,
    });
    expect(lookup.mock.calls.length).toBeGreaterThan(applicationRoleTemplateFactReadConcurrency);
    expect(maxActive).toBe(applicationRoleTemplateFactReadConcurrency);
    expect(readApplicationSnapshot).toHaveBeenCalledTimes(2);
    expect(verifyPreparedApplicationRoleTemplates(prepared)).toEqual(prepared);

    const reactivatedRevision = registrationRevision + 1;
    const reactivated = factsFor(initial.permissionRegistration, {
      snapshots: [
        snapshotFor(initial.permissionRegistration, reactivatedRevision),
        snapshotFor(initial.permissionRegistration, reactivatedRevision),
      ],
      lookup: async (command) =>
        availableResult(initial.permissionRegistration, command, reactivatedRevision),
    });
    const reactivatedPrepared = await createApplicationRoleTemplateAdapter({
      definitionReader: reader,
      permissionRegistryFacts: reactivated.facts,
    }).prepareCurrentActive(context(), { applicationRootId: applicationResult.rootId });
    expect(reactivatedPrepared.preparationBasis).toEqual({
      kind: "current_active_registration",
      registrationRevision: reactivatedRevision,
    });
    expect(reactivatedPrepared.candidateFingerprint).not.toBe(prepared.candidateFingerprint);
  });

  it("retains the compiled V1 wildcard export source but excludes it from the live projection", async () => {
    const wildcard = wildcardApplication();
    const { reader } = readerFor(wildcard);
    const prepared = await createApplicationRoleTemplateAdapter({
      definitionReader: reader,
      permissionRegistryFacts: unavailableFacts(),
    }).prepareRegistrationCandidate(context(), {
      applicationRootId: wildcard.rootId,
      releaseRevision: wildcard.releaseRevision,
    });
    const template = prepared.templates[0]!;
    const sourceExport = template.sourcePermissions.find(
      (entry) => entry.permission.actionKind === "export",
    );

    expect(template.template.permissionSelection.kind).toBe("application_wildcard");
    expect(sourceExport).toBeDefined();
    expect(prepared.permissionRegistration.applicationPermissionIds).toContain(
      sourceExport!.permission.permissionId,
    );
    expect(template.livePermissions).not.toContainEqual(sourceExport);

    const exact = structuredClone(wildcard);
    exact.content.roles[0]!.permissionKeys = [sourceExport!.permission.key];
    exact.content.roles[0]!.permissionSelection = { kind: "exact" };
    exact.contentFingerprint = fingerprintCanonicalValue(exact.content);
    const exactPrepared = await createApplicationRoleTemplateAdapter({
      definitionReader: readerFor(exact).reader,
      permissionRegistryFacts: unavailableFacts(),
    }).prepareRegistrationCandidate(context(), {
      applicationRootId: exact.rootId,
      releaseRevision: exact.releaseRevision,
    });
    expect(exactPrepared.templates[0]!.livePermissions[0]!.permission.actionKind).toBe("export");
  });

  it("represents an all-excluded wildcard as nonempty source and empty live evidence", async () => {
    const application = wildcardApplication(true);
    const prepared = await createApplicationRoleTemplateAdapter({
      definitionReader: readerFor(application).reader,
      permissionRegistryFacts: unavailableFacts(),
    }).prepareRegistrationCandidate(context(), {
      applicationRootId: application.rootId,
      releaseRevision: application.releaseRevision,
    });

    expect(prepared.templates[0]!.sourcePermissions).toHaveLength(1);
    expect(prepared.templates[0]!.sourcePermissions[0]!.permission.actionKind).toBe("export");
    expect(prepared.templates[0]!.livePermissions).toEqual([]);
  });

  it("ignores a bound-module key collision for wildcard source but refuses it for exact source", async () => {
    const wildcard = wildcardApplication();
    const openKey = wildcard.content.roles[0]!.permissionKeys.find((key) => key.endsWith(".open"));
    if (!openKey) throw new Error("Open permission required");
    const collidingModules = new Map(moduleResults);
    const [moduleId, moduleResult] = [...collidingModules.entries()][0]!;
    if (moduleResult.kind !== "module") throw new Error("Module result required");
    const changedModule = structuredClone(moduleResult);
    changedModule.content.permissions[0]!.key = openKey;
    changedModule.contentFingerprint = fingerprintCanonicalValue(changedModule.content);
    collidingModules.set(moduleId, changedModule);
    const changedApplication = structuredClone(wildcard);
    const dependency = changedApplication.dependencyManifest.find(
      (entry) => entry.kind === "module" && entry.rootId === moduleId,
    );
    if (!dependency || dependency.kind !== "module") throw new Error("Dependency required");
    dependency.contentFingerprint = changedModule.contentFingerprint;

    const wildcardPrepared = await createApplicationRoleTemplateAdapter({
      definitionReader: readerFor(changedApplication, collidingModules).reader,
      permissionRegistryFacts: unavailableFacts(),
    }).prepareRegistrationCandidate(context(), {
      applicationRootId: changedApplication.rootId,
      releaseRevision: changedApplication.releaseRevision,
    });
    expect(wildcardPrepared.templates[0]!.sourcePermissions).not.toContainEqual(
      expect.objectContaining({ ownerKind: "module", ownerId: moduleId }),
    );

    const exact = structuredClone(changedApplication);
    exact.content.roles[0]!.permissionKeys = [openKey];
    exact.content.roles[0]!.permissionSelection = { kind: "exact" };
    exact.contentFingerprint = fingerprintCanonicalValue(exact.content);
    await expectCode(
      createApplicationRoleTemplateAdapter({
        definitionReader: readerFor(exact, collidingModules).reader,
        permissionRegistryFacts: unavailableFacts(),
      }).prepareRegistrationCandidate(context(), {
        applicationRootId: exact.rootId,
        releaseRevision: exact.releaseRevision,
      }),
      "APPLICATION_ROLE_TEMPLATE_PERMISSION_OWNERSHIP_AMBIGUOUS",
    );
  });

  it("refuses a changed exact Definition result after #32 preparation", async () => {
    const base = readerFor();
    let applicationReads = 0;
    const reader: PermissionRegistryDefinitionReader = {
      read: async (selectedContext, command) => {
        const result = await base.reader.read(selectedContext, command);
        if (command.kind !== "application" || applicationReads++ === 0) return result;
        return { ...result, contentFingerprint: `sha256:${"0".repeat(64)}` };
      },
    };
    await expectCode(
      prepareInitial(reader),
      "APPLICATION_ROLE_TEMPLATE_DEFINITION_EVIDENCE_INVALID",
    );

    const missing = structuredClone(applicationResult);
    missing.content.roles[0]!.permissionKeys = ["application.crm.permission_missing"];
    missing.content.roles[0]!.permissionSelection = { kind: "exact" };
    missing.contentFingerprint = fingerprintCanonicalValue(missing.content);
    await expectCode(
      prepareInitial(readerFor(missing).reader),
      "APPLICATION_ROLE_TEMPLATE_PERMISSION_OWNERSHIP_AMBIGUOUS",
    );
  });

  it("refuses unavailable, changed or stale current registration evidence", async () => {
    const { reader } = readerFor();
    const initial = await prepareInitial(reader);
    await expectCode(
      createApplicationRoleTemplateAdapter({
        definitionReader: reader,
        permissionRegistryFacts: unavailableFacts(),
      }).prepareCurrentActive(context(), { applicationRootId: applicationResult.rootId }),
      "APPLICATION_ROLE_TEMPLATE_ACTIVE_REGISTRATION_UNAVAILABLE",
    );

    const wrongCatalogue = snapshotFor(initial.permissionRegistration);
    wrongCatalogue.catalogueFingerprint = `sha256:${"0".repeat(64)}`;
    const mismatch = factsFor(initial.permissionRegistration, {
      snapshots: [wrongCatalogue, wrongCatalogue],
    });
    await expectCode(
      createApplicationRoleTemplateAdapter({
        definitionReader: reader,
        permissionRegistryFacts: mismatch.facts,
      }).prepareCurrentActive(context(), { applicationRootId: applicationResult.rootId }),
      "APPLICATION_ROLE_TEMPLATE_DEFINITION_EVIDENCE_INVALID",
    );

    const unavailable = factsFor(initial.permissionRegistration, {
      lookup: async () => ({ outcome: "unavailable" }),
    });
    await expectCode(
      createApplicationRoleTemplateAdapter({
        definitionReader: reader,
        permissionRegistryFacts: unavailable.facts,
      }).prepareCurrentActive(context(), { applicationRootId: applicationResult.rootId }),
      "APPLICATION_ROLE_TEMPLATE_ACTIVE_REGISTRATION_UNAVAILABLE",
    );

    const staleLookup = factsFor(initial.permissionRegistration, {
      lookup: async (command) =>
        availableResult(initial.permissionRegistration, command, registrationRevision + 1),
    });
    await expectCode(
      createApplicationRoleTemplateAdapter({
        definitionReader: reader,
        permissionRegistryFacts: staleLookup.facts,
      }).prepareCurrentActive(context(), { applicationRootId: applicationResult.rootId }),
      "APPLICATION_ROLE_TEMPLATE_ACTIVE_REGISTRATION_UNAVAILABLE",
    );

    const tamperedLookup = factsFor(initial.permissionRegistration, {
      lookup: async (command) => {
        const result = availableResult(initial.permissionRegistration, command);
        if (result.outcome === "unavailable") return result;
        return {
          ...result,
          entry: {
            ...result.entry,
            meaningFingerprint: `sha256:${"0".repeat(64)}`,
          },
        };
      },
    });
    await expectCode(
      createApplicationRoleTemplateAdapter({
        definitionReader: reader,
        permissionRegistryFacts: tamperedLookup.facts,
      }).prepareCurrentActive(context(), { applicationRootId: applicationResult.rootId }),
      "APPLICATION_ROLE_TEMPLATE_ACTIVE_REGISTRATION_UNAVAILABLE",
    );

    const changedSnapshot = factsFor(initial.permissionRegistration, {
      snapshots: [
        snapshotFor(initial.permissionRegistration),
        snapshotFor(initial.permissionRegistration, registrationRevision + 1),
      ],
    });
    await expectCode(
      createApplicationRoleTemplateAdapter({
        definitionReader: reader,
        permissionRegistryFacts: changedSnapshot.facts,
      }).prepareCurrentActive(context(), { applicationRootId: applicationResult.rootId }),
      "APPLICATION_ROLE_TEMPLATE_ACTIVE_REGISTRATION_UNAVAILABLE",
    );
  });

  it("refuses non-system, foreign-organisation and unsafe revision input", async () => {
    const { reader } = readerFor();
    const adapter = createApplicationRoleTemplateAdapter({
      definitionReader: reader,
      permissionRegistryFacts: unavailableFacts(),
    });
    const publicContext = sessionContextSchema.parse({
      callerKind: "public",
      tenantId: "10000000-0000-4000-8000-000000000001",
      organizationId,
      sessionId: "40000000-0000-4000-8000-000000000001",
      authenticationStrength: "anonymous",
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      accessVersion: 1,
      correlationId,
    });
    await expectCode(
      adapter.prepareRegistrationCandidate(publicContext, {
        applicationRootId: applicationResult.rootId,
        releaseRevision: applicationResult.releaseRevision,
      }),
      "APPLICATION_ROLE_TEMPLATE_CONTEXT_REFUSED",
    );
    await expectCode(
      adapter.prepareRegistrationCandidate(context(), {
        applicationRootId: applicationResult.rootId,
        releaseRevision: Number.MAX_SAFE_INTEGER + 1,
      }),
      "INVALID_APPLICATION_ROLE_TEMPLATE_PREPARATION_COMMAND",
    );
    const foreign = structuredClone(applicationResult);
    foreign.organizationId = "10000000-0000-4000-a000-000000000099";
    await expectCode(
      prepareInitial(readerFor(foreign).reader),
      "APPLICATION_ROLE_TEMPLATE_DEFINITION_EVIDENCE_INVALID",
    );
  });
});
