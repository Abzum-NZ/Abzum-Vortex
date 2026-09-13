import fs from "node:fs";
import path from "node:path";
import {
  definitionResolutionSnapshotSchema,
  definitionResolutionSnapshotV2Schema,
  definitionConsumerReadResultSchema,
  definitionSourceDocumentSchema,
  moduleSourceDocumentV2Schema,
  sessionContextSchema,
  type DefinitionConsumerReadResult,
  type ExactDefinitionDependency,
  type SessionContext,
  type ModuleSourceDocumentV2,
} from "@vortex/contracts";
import {
  canonicalJson,
  compareCanonicalStrings,
  compileDefinition,
  fingerprintCanonicalValue,
} from "@vortex/definition";
import { describe, expect, it, vi } from "vitest";
import {
  createPermissionRegistryDefinitionAdapter,
  verifyPreparedApplicationPermissionRegistration,
  type PermissionRegistryDefinitionSetReader,
  type PermissionRegistryPreparationError,
} from "../src/permission-registry-definition-adapter";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../testing/fixtures");
const organizationId = "10000000-0000-4000-a000-000000000001";
const actorId = "10000000-0000-4000-a000-000000000002";
const correlationId = "50000000-0000-4000-8000-000000000001";
const dependencyFingerprint = `sha256:${"d".repeat(64)}`;
const catalogueFingerprint = `sha256:${"e".repeat(64)}`;
const savedConditionRevisions = [
  { conditionId: "a4b5546d-8a54-4003-adc4-ddb8b0d7257d", revision: 1 },
] as const;

const resolution = definitionResolutionSnapshotSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "definition-resolution-snapshot.json"), "utf8"),
  ),
);
const moduleResolution = definitionResolutionSnapshotV2Schema.parse(
  JSON.parse(
    fs.readFileSync(
      path.join(fixtureRoot, "module-v2-definition-resolution-snapshot.json"),
      "utf8",
    ),
  ),
);

const readApplicationSource = (filename: string) =>
  definitionSourceDocumentSchema.parse(
    JSON.parse(fs.readFileSync(path.join(fixtureRoot, "applications", filename), "utf8")),
  );
const readModuleSource = (filename: string) =>
  moduleSourceDocumentV2Schema.parse(
    JSON.parse(fs.readFileSync(path.join(fixtureRoot, "modules", filename), "utf8")),
  );
const compile = (source: ReturnType<typeof readApplicationSource> | ModuleSourceDocumentV2) =>
  source.kind === "module"
    ? compileDefinition({
        sourceContractVersion: "2.0.0",
        validationContractVersion: "2.0.0",
        source,
        resolution: moduleResolution,
        draftMetadata: {
          organizationId,
          draftRevision: 2,
          publishedRevision: 1,
          createdAt: "2026-09-05T00:00:00.000Z",
          createdBy: actorId,
          updatedAt: "2026-09-05T00:00:00.000Z",
          updatedBy: actorId,
        },
        savedConditionRevisions,
      })
    : compileDefinition({
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
        savedConditionRevisions: [],
      });

const applicationOutput = compile(readApplicationSource("crm.json"));
if (applicationOutput.kind !== "application") throw new Error("Application fixture required");

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
  const output = compile(readModuleSource(filename));
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

const applicationManifest: ExactDefinitionDependency[] = [
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
        releaseRevision: 2,
        releaseVersion: binding.resolvedVersion,
        contentFingerprint: fingerprintCanonicalValue(output.canonical.content),
        resolutionFingerprint: output.resolutionFingerprint,
      };
    },
  ),
].sort((left, right) => {
  const subject = (entry: ExactDefinitionDependency) =>
    `${entry.kind}:${"key" in entry ? entry.key : entry.catalogueThemeId}`;
  return compareCanonicalStrings(subject(left), subject(right));
});

const resultFor = (
  output: typeof applicationOutput | (typeof moduleOutputs)[number],
  dependencyManifest: readonly ExactDefinitionDependency[],
): DefinitionConsumerReadResult =>
  ({
    kind: output.kind,
    organizationId,
    definitionKey: output.canonical.envelope.key,
    rootId: output.canonical.envelope.rootId,
    releaseRevision: output.kind === "module" ? 2 : 1,
    releaseVersion: output.kind === "module" ? "2.0.0" : "1.0.0",
    validationContractVersion: output.kind === "module" ? "2.0.0" : "1.0.0",
    contentFingerprint: fingerprintCanonicalValue(output.canonical.content),
    resolutionFingerprint: output.resolutionFingerprint,
    content: output.canonical.content,
    dependencyManifest: [...dependencyManifest],
    correlationId,
  }) as DefinitionConsumerReadResult;

const applicationResult = resultFor(applicationOutput, applicationManifest);
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
  if (application.kind !== "application") throw new Error("Application result required");
  const read = vi.fn(async () => ({ application, modules: [...modules.values()] }));
  return { reader: { read } satisfies PermissionRegistryDefinitionSetReader, read };
};

const prepare = (
  reader: PermissionRegistryDefinitionSetReader,
  selectedContext: SessionContext = context(),
) =>
  createPermissionRegistryDefinitionAdapter(reader).prepareApplicationRegistration(
    selectedContext,
    {
      applicationRootId: applicationResult.rootId,
      releaseRevision: applicationResult.releaseRevision,
    },
  );

describe("permission registry Definition adapter", () => {
  it("builds deterministic app and transitive Module evidence from one exact Definition set", async () => {
    const { reader, read } = readerFor();
    const first = await prepare(reader);
    const second = await prepare(reader);
    const expectedEntryCount =
      applicationResult.content.permissions.length +
      [...moduleResults.values()].reduce(
        (total, module) => total + module.content.permissions.length,
        0,
      );

    expect(first).toEqual(second);
    expect(first.entries).toHaveLength(expectedEntryCount);
    expect(
      first.entries.every((entry) => entry.applicationRootId === applicationResult.rootId),
    ).toBe(true);
    expect(first.applicationPermissionIds).toEqual(
      [...applicationResult.content.permissions]
        .filter((permission) => !permission.administrative)
        .sort((left, right) => compareCanonicalStrings(left.key, right.key))
        .map((permission) => permission.permissionId),
    );
    expect(first.applicationCatalogueFingerprint).toBe(
      fingerprintCanonicalValue(
        [...applicationResult.content.permissions]
          .filter((permission) => !permission.administrative)
          .sort((left, right) => compareCanonicalStrings(left.key, right.key)),
      ),
    );
    expect(
      first.applicationPermissionIds.some((permissionId) =>
        first.entries.some(
          (entry) => entry.ownerKind === "module" && entry.permission.permissionId === permissionId,
        ),
      ),
    ).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ callerKind: "system", organizationId }),
      { applicationRootId: applicationResult.rootId, applicationReleaseRevision: 1 },
    );
  });

  it("registers permissions from a transitive Module returned by Definition", async () => {
    const [directCandidate, transitiveCandidate] = [...moduleResults.values()];
    if (directCandidate?.kind !== "module" || transitiveCandidate?.kind !== "module")
      throw new Error("Two Module releases are required");
    const direct = structuredClone(directCandidate);
    const transitive = structuredClone(transitiveCandidate);
    direct.content.dependencies = [
      {
        dependencyKey: "transitive",
        moduleRootId: transitive.rootId,
        moduleKey: transitive.definitionKey,
        version: { selection: "exact", version: transitive.releaseVersion },
        resolvedVersion: transitive.releaseVersion,
      },
    ];
    direct.contentFingerprint = fingerprintCanonicalValue(direct.content);
    direct.dependencyManifest = [
      {
        kind: "module",
        key: transitive.definitionKey,
        rootId: transitive.rootId,
        releaseRevision: transitive.releaseRevision,
        releaseVersion: transitive.releaseVersion,
        contentFingerprint: transitive.contentFingerprint,
        resolutionFingerprint: transitive.resolutionFingerprint,
      },
    ];

    const selectedApplication = structuredClone(applicationResult);
    const directBinding = selectedApplication.content.moduleBindings.find(
      (binding) => binding.moduleRootId === direct.rootId,
    );
    if (!directBinding) throw new Error("Direct binding is required");
    selectedApplication.content.moduleBindings = [directBinding];
    selectedApplication.contentFingerprint = fingerprintCanonicalValue(selectedApplication.content);
    selectedApplication.dependencyManifest = [
      ...selectedApplication.dependencyManifest.filter((entry) => entry.kind !== "module"),
      {
        kind: "module",
        key: direct.definitionKey,
        rootId: direct.rootId,
        releaseRevision: direct.releaseRevision,
        releaseVersion: direct.releaseVersion,
        contentFingerprint: direct.contentFingerprint,
        resolutionFingerprint: direct.resolutionFingerprint,
      },
    ].sort((left, right) => {
      const subject = (entry: ExactDefinitionDependency) =>
        `${entry.kind}:${"key" in entry ? entry.key : entry.catalogueThemeId}`;
      return compareCanonicalStrings(subject(left), subject(right));
    });

    const prepared = await prepare(
      readerFor(
        selectedApplication,
        new Map([
          [direct.rootId, direct],
          [transitive.rootId, transitive],
        ]),
      ).reader,
    );
    const moduleOwners = new Set(
      prepared.entries
        .filter((entry) => entry.ownerKind === "module")
        .map((entry) => entry.ownerId),
    );
    expect(moduleOwners).toEqual(new Set([direct.rootId, transitive.rootId]));
  });

  it("accepts a valid Application with no Modules", async () => {
    const applicationOnly = structuredClone(applicationResult);
    applicationOnly.content.moduleBindings = [];
    applicationOnly.content.events = [];
    applicationOnly.dependencyManifest = applicationOnly.dependencyManifest.filter(
      (entry) => entry.kind !== "module",
    );
    applicationOnly.contentFingerprint = fingerprintCanonicalValue(applicationOnly.content);

    const prepared = await prepare(readerFor(applicationOnly, new Map()).reader);
    expect(prepared.entries.every((entry) => entry.ownerKind === "application")).toBe(true);
  });

  it("carries the exact compiled module record scope into prepared catalogue evidence", async () => {
    const prepared = await prepare(readerFor().reader);
    const scoped = prepared.entries.find(
      (entry) => entry.ownerKind === "module" && entry.permission.recordScope !== undefined,
    );
    if (!scoped || scoped.sourceRelease.kind !== "module")
      throw new Error("Scoped module permission required");
    const source = moduleResults.get(scoped.ownerId);
    if (!source || source.kind !== "module") throw new Error("Module release required");
    const sourcePermission = source.content.permissions.find(
      (permission) => permission.permissionId === scoped.permission.permissionId,
    );
    expect(scoped.permission.recordScope).toEqual(sourcePermission?.recordScope);

    const tampered = structuredClone(prepared);
    const tamperedEntry = tampered.entries.find(
      (entry) => entry.ownerKind === "module" && entry.permission.recordScope !== undefined,
    );
    if (!tamperedEntry) throw new Error("Scoped module permission required");
    tamperedEntry.permission.recordScope =
      canonicalJson(tamperedEntry.permission.recordScope) ===
      canonicalJson({ routes: [{ kind: "all_records" }] })
        ? { routes: [{ kind: "direct_share" }] }
        : { routes: [{ kind: "all_records" }] };
    const { candidateFingerprint, ...core } = tampered;
    expect(candidateFingerprint).toBeDefined();
    tampered.candidateFingerprint = fingerprintCanonicalValue(core);
    expect(() => verifyPreparedApplicationPermissionRegistration(tampered)).toThrow(
      expect.objectContaining({ code: "PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID" }),
    );
  });

  it("uses locale-independent canonical order for punctuation-valid permission keys", async () => {
    const changed = structuredClone(applicationResult);
    if (changed.kind !== "application") throw new Error("Application result required");
    const template = changed.content.permissions[0];
    if (!template) throw new Error("Application permission required");
    changed.content.permissions = [
      ...changed.content.permissions,
      {
        ...template,
        permissionId: "41000000-0000-4000-8000-000000000131",
        key: "shared.orders.read",
      },
      {
        ...template,
        permissionId: "41000000-0000-4000-8000-000000000135",
        key: "shared.orders_1.read",
      },
      {
        ...template,
        permissionId: "41000000-0000-4000-8000-000000000134",
        key: "shared.orders1.read",
      },
    ];
    const wildcardPermissions = [...changed.content.permissions]
      .filter((permission) => !permission.administrative)
      .sort((left, right) => compareCanonicalStrings(left.key, right.key));
    for (const role of changed.content.roles) {
      if (role.permissionSelection.kind !== "application_wildcard") continue;
      role.permissionKeys = wildcardPermissions.map((permission) => permission.key);
      role.permissionSelection.catalogueFingerprint =
        fingerprintCanonicalValue(wildcardPermissions);
    }
    changed.contentFingerprint = `sha256:${"f".repeat(64)}`;
    const structurallyValid = definitionConsumerReadResultSchema.safeParse(changed);
    if (!structurallyValid.success)
      throw new Error(JSON.stringify(structurallyValid.error.issues, null, 2));

    const prepared = await prepare(readerFor(changed).reader);
    expect(
      prepared.entries
        .filter(
          (entry) => entry.ownerKind === "application" && entry.permission.key.startsWith("shared"),
        )
        .map((entry) => entry.permission.key),
    ).toEqual(["shared.orders.read", "shared.orders1.read", "shared.orders_1.read"]);
    const addedIds = new Set([
      "41000000-0000-4000-8000-000000000131",
      "41000000-0000-4000-8000-000000000134",
      "41000000-0000-4000-8000-000000000135",
    ]);
    expect(
      prepared.applicationPermissionIds.filter((permissionId) => addedIds.has(permissionId)),
    ).toEqual([
      "41000000-0000-4000-8000-000000000131",
      "41000000-0000-4000-8000-000000000134",
      "41000000-0000-4000-8000-000000000135",
    ]);
  });

  it("keeps label-only changes out of permission meaning but in release/catalogue evidence", async () => {
    const initial = await prepare(readerFor().reader);
    const changed = structuredClone(applicationResult);
    if (changed.kind !== "application") throw new Error("Application result required");
    const selected = changed.content.permissions[0];
    if (!selected) throw new Error("Application permission required");
    selected.label = `${selected.label} updated`;
    changed.contentFingerprint = `sha256:${"f".repeat(64)}`;

    const updated = await prepare(readerFor(changed).reader);
    const initialEntry = initial.entries.find(
      (entry) => entry.permission.permissionId === selected.permissionId,
    );
    const updatedEntry = updated.entries.find(
      (entry) => entry.permission.permissionId === selected.permissionId,
    );
    expect(updatedEntry?.meaningFingerprint).toBe(initialEntry?.meaningFingerprint);
    expect(updated.applicationCatalogueFingerprint).not.toBe(
      initial.applicationCatalogueFingerprint,
    );
    expect(updated.candidateFingerprint).not.toBe(initial.candidateFingerprint);
  });

  it("detects semantic permission changes", async () => {
    const initial = await prepare(readerFor().reader);
    const changed = structuredClone(applicationResult);
    if (changed.kind !== "application") throw new Error("Application result required");
    const selected = changed.content.permissions[0];
    if (!selected || selected.actionKind !== "named") throw new Error("Named permission required");
    selected.namedAction = "enter";
    changed.contentFingerprint = `sha256:${"f".repeat(64)}`;
    const updated = await prepare(readerFor(changed).reader);
    expect(
      updated.entries.find((entry) => entry.permission.permissionId === selected.permissionId)
        ?.meaningFingerprint,
    ).not.toBe(
      initial.entries.find((entry) => entry.permission.permissionId === selected.permissionId)
        ?.meaningFingerprint,
    );
  });

  it("revalidates a prepared candidate before a later protected transaction uses it", async () => {
    const candidate = await prepare(readerFor().reader);
    expect(verifyPreparedApplicationPermissionRegistration(candidate)).toEqual(candidate);

    const changedMeaning = structuredClone(candidate);
    const selected = changedMeaning.entries[0];
    if (!selected) throw new Error("Permission entry required");
    selected.permission.actionKind = "read";
    delete selected.permission.namedAction;
    await expect(() => verifyPreparedApplicationPermissionRegistration(changedMeaning)).toThrow(
      expect.objectContaining({ code: "PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID" }),
    );

    const changedFingerprint = { ...candidate, candidateFingerprint: `sha256:${"0".repeat(64)}` };
    await expect(() => verifyPreparedApplicationPermissionRegistration(changedFingerprint)).toThrow(
      expect.objectContaining({ code: "PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID" }),
    );
  });

  it("refuses non-system context, ambiguous ownership and unavailable definitions safely", async () => {
    const { reader, read } = readerFor();
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
    await expect(prepare(reader, publicContext)).rejects.toMatchObject({
      code: "PERMISSION_REGISTRY_CONTEXT_REFUSED",
    });
    expect(read).not.toHaveBeenCalled();

    await expect(
      prepare(
        reader,
        context({
          issuedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T00:01:00.000Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_REGISTRY_CONTEXT_REFUSED" });
    expect(read).not.toHaveBeenCalled();

    const duplicate = structuredClone(applicationResult);
    if (duplicate.kind !== "application") throw new Error("Application result required");
    const existing = duplicate.content.permissions[0];
    if (!existing) throw new Error("Application permission required");
    duplicate.content.permissions.push({
      ...existing,
      permissionId: "00000000-0000-4000-8000-000000000099",
      label: "Duplicate owner-local key",
    });
    await expect(prepare(readerFor(duplicate).reader)).rejects.toMatchObject({
      code: "PERMISSION_REGISTRY_PERMISSION_OWNERSHIP_AMBIGUOUS",
    });

    const unavailable: PermissionRegistryDefinitionSetReader = {
      read: async () => {
        throw new Error("sensitive storage detail");
      },
    };
    await expect(prepare(unavailable)).rejects.toEqual(
      expect.objectContaining({
        name: "PermissionRegistryPreparationError",
        code: "PERMISSION_REGISTRY_DEFINITION_UNAVAILABLE",
        message: "PERMISSION_REGISTRY_DEFINITION_UNAVAILABLE",
      } satisfies Partial<PermissionRegistryPreparationError>),
    );
  });
});
