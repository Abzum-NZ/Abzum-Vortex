import fs from "node:fs";
import path from "node:path";
import {
  definitionResolutionSnapshotSchema,
  definitionConsumerReadResultSchema,
  definitionSourceDocumentSchema,
  sessionContextSchema,
  type DefinitionConsumerReadCommand,
  type DefinitionConsumerReadResult,
  type ExactDefinitionDependency,
  type PermissionDeclaration,
  type SessionContext,
} from "@vortex/contracts";
import {
  compareCanonicalStrings,
  compileDefinition,
  fingerprintCanonicalValue,
} from "@vortex/definition";
import { describe, expect, it, vi } from "vitest";
import {
  createPermissionRegistryDefinitionAdapter,
  mapInDeterministicBatches,
  permissionRegistryModuleReadConcurrency,
  verifyPreparedApplicationPermissionRegistration,
  type PermissionRegistryDefinitionReader,
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

const compile = (folder: "modules" | "applications", filename: string) => {
  const source = definitionSourceDocumentSchema.parse(
    JSON.parse(fs.readFileSync(path.join(fixtureRoot, folder, filename), "utf8")),
  );
  return compileDefinition({
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
    savedConditionRevisions: folder === "modules" ? savedConditionRevisions : [],
  });
};

const applicationOutput = compile("applications", "crm.json");
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
  const output = compile("modules", filename);
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
  output: typeof applicationOutput | (typeof moduleOutputs)[number],
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
  const read = vi.fn(async (_context: SessionContext, command: DefinitionConsumerReadCommand) => {
    const candidate = command.kind === "application" ? application : modules.get(command.rootId);
    if (!candidate) throw new Error("not found");
    return candidate;
  });
  return { reader: { read } satisfies PermissionRegistryDefinitionReader, read };
};

const prepare = (
  reader: PermissionRegistryDefinitionReader,
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
  it("bounds an exact 10,000-item scheduling input without imposing a catalogue limit", async () => {
    const dependencyCount = 10_000;
    let active = 0;
    let maxActive = 0;
    const output = await mapInDeterministicBatches(
      Array.from({ length: dependencyCount }, (_, index) => index),
      permissionRegistryModuleReadConcurrency,
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return value;
      },
    );

    expect(output).toHaveLength(dependencyCount);
    expect(output[0]).toBe(0);
    expect(output.at(-1)).toBe(dependencyCount - 1);
    expect(maxActive).toBe(permissionRegistryModuleReadConcurrency);
  });

  it("reports the first input-ordered failure from a concurrent batch", async () => {
    await expect(
      mapInDeterministicBatches(["first", "second", "third"], 3, async (value) => {
        if (value === "first") {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          throw new Error("first failure");
        }
        if (value === "second") throw new Error("later failure");
        return value;
      }),
    ).rejects.toThrow("first failure");
  });

  it("uses the bounded reader for a complete application with more than one batch of modules", async () => {
    const moduleCount = permissionRegistryModuleReadConcurrency * 2 + 1;
    const scaledApplication = structuredClone(applicationResult);
    if (scaledApplication.kind !== "application") throw new Error("Application result required");
    const moduleTemplate = [...moduleResults.values()].find(
      (candidate): candidate is Extract<DefinitionConsumerReadResult, { kind: "module" }> =>
        candidate.kind === "module",
    );
    const bindingTemplate = scaledApplication.content.moduleBindings[0];
    if (!moduleTemplate || !bindingTemplate) throw new Error("Module fixture required");

    const scaledModules = new Map<string, DefinitionConsumerReadResult>();
    const bindings = Array.from({ length: moduleCount }, (_, index) => {
      const suffix = String(index + 200_000).padStart(12, "0");
      const rootId = `31000000-0000-4000-8000-${suffix}` as typeof moduleTemplate.rootId;
      const definitionKey =
        `scale.module_${String(index).padStart(5, "0")}` as typeof moduleTemplate.definitionKey;
      const permissionId =
        `41000000-0000-4000-8000-${suffix}` as PermissionDeclaration["permissionId"];
      const content = {
        ...structuredClone(moduleTemplate.content),
        permissions: [
          {
            permissionId,
            key: `scale.permission_${String(index).padStart(5, "0")}.read`,
            label: `View scaled records ${index}`,
            description: `View records from scaled module ${index}.`,
            actionKind: "read" as const,
            administrative: false,
          },
        ],
      };
      const contentFingerprint = fingerprintCanonicalValue(content);
      scaledModules.set(rootId, {
        ...moduleTemplate,
        rootId,
        definitionKey,
        content,
        contentFingerprint,
      });
      return {
        ...bindingTemplate,
        moduleRootId: rootId,
      };
    });
    scaledApplication.content.moduleBindings = bindings;
    const nonModuleDependencies = scaledApplication.dependencyManifest.filter(
      (dependency) => dependency.kind !== "module",
    );
    scaledApplication.dependencyManifest = [
      ...nonModuleDependencies,
      ...[...scaledModules.values()].map((module): ExactDefinitionDependency => ({
        kind: "module",
        key: module.definitionKey,
        rootId: module.rootId,
        releaseRevision: module.releaseRevision,
        releaseVersion: bindingTemplate.resolvedVersion,
        contentFingerprint: module.contentFingerprint,
        resolutionFingerprint: module.resolutionFingerprint,
      })),
    ].sort((left, right) => {
      const subject = (dependency: ExactDefinitionDependency) =>
        `${dependency.kind}:${"key" in dependency ? dependency.key : dependency.catalogueThemeId}`;
      return compareCanonicalStrings(subject(left), subject(right));
    });

    let active = 0;
    let maxActive = 0;
    const read = vi.fn(async (_context: SessionContext, command: DefinitionConsumerReadCommand) => {
      if (command.kind === "application") return scaledApplication;
      const module = scaledModules.get(command.rootId);
      if (!module) throw new Error("not found");
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return module;
    });
    const prepared = await prepare({ read });
    const moduleEntries = prepared.entries.filter((entry) => entry.ownerKind === "module");

    expect(read).toHaveBeenCalledTimes(moduleCount + 1);
    expect(maxActive).toBe(permissionRegistryModuleReadConcurrency);
    expect(moduleEntries).toHaveLength(moduleCount);
    expect(moduleEntries.map((entry) => entry.ownerId)).toEqual(
      [...scaledModules.keys()].sort(compareCanonicalStrings),
    );
  });

  it("builds deterministic app and bound-module evidence only from exact #22 reads", async () => {
    const { reader, read } = readerFor();
    const first = await prepare(reader);
    const second = await prepare(reader);
    const expectedEntryCount =
      applicationResult.content.permissions.length +
      applicationResult.content.moduleBindings.reduce(
        (total, binding) =>
          total + (moduleResults.get(binding.moduleRootId)?.content.permissions.length ?? 0),
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
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ callerKind: "system", organizationId }),
      expect.objectContaining({
        kind: "application",
        selector: { selection: "revision", releaseRevision: 1 },
      }),
    );
    expect(read.mock.calls.every(([, command]) => command.selector.selection === "revision")).toBe(
      true,
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

  it("detects semantic changes and exact module-evidence substitution", async () => {
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

    const substituted = structuredClone(applicationResult);
    const moduleDependency = substituted.dependencyManifest.find(
      (entry) => entry.kind === "module",
    );
    if (!moduleDependency || moduleDependency.kind !== "module")
      throw new Error("Module dependency required");
    moduleDependency.contentFingerprint = `sha256:${"0".repeat(64)}`;
    await expect(prepare(readerFor(substituted).reader)).rejects.toMatchObject({
      code: "PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID",
    });
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

    const unavailable: PermissionRegistryDefinitionReader = {
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
