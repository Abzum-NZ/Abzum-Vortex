import {
  canonicalJson,
  compareCanonicalStrings,
  flowControlTaskTypeKeys,
  flowRegisteredTaskTypeKeys,
  flowTaskChildLists,
  flowTaskRegistry,
  customComponentPlacementAllowedV2,
  type DefinitionCompilationOutput,
  type ExactDefinitionDependency,
  type FlowDefinition,
  type FlowTask,
} from "@vortex/contracts";
import {
  applicationPackageDependencySubject,
  applicationPackageManifestInputSchema,
  applicationPackageManifestSchema,
  applicationPackagePermissionDeclarationSchema,
  type ApplicationPackageManifest,
  type ApplicationPackageManifestInput,
} from "@vortex/contracts/application-package-contracts";
import {
  hasAuthenticResolutionFingerprint,
  releaseManifestMatchesCanonicalContent,
  sameCanonicalJson,
} from "./definition-release-integrity";
import { fingerprintCanonicalValue } from "./canonical-json";
import { platformBlockReleaseFingerprints, platformThemeReleaseFingerprints } from "./catalogue-release-fingerprints";

const maximumInputBytes = 4_000_000;
const maximumInputNodes = 150_000;
const maximumEvidenceDepth = 64;

export type ApplicationPackageManifestErrorCode =
  | "INVALID_EVIDENCE"
  | "RELEASE_INTEGRITY_FAILED"
  | "DEPENDENCY_CLOSURE_INVALID"
  | "BLOCK_OR_THEME_EVIDENCE_INVALID"
  | "UNSUPPORTED_ASSET_REFERENCE"
  | "UNSUPPORTED_SCRIPT_REFERENCE"
  | "UNSUPPORTED_PERMISSION_DECLARATION";

/** A finite error suitable for a caller boundary; it never includes input values or parser detail. */
export class ApplicationPackageManifestError extends Error {
  readonly code: ApplicationPackageManifestErrorCode;

  constructor(code: ApplicationPackageManifestErrorCode) {
    super(code);
    this.name = "ApplicationPackageManifestError";
    this.code = code;
  }
}

const refuse = (code: ApplicationPackageManifestErrorCode): never => {
  throw new ApplicationPackageManifestError(code);
};

/**
 * Accept only bounded JSON data. This runs before Zod so cycles, accessors, custom prototypes and
 * oversized evidence cannot turn a safe parse into an unbounded walk.
 */
const assertBoundedJsonEvidence = (input: unknown): void => {
  let nodes = 0;
  let evidenceBytes = 0;
  const active = new WeakSet<object>();
  const countBytes = (value: string): void => {
    evidenceBytes += Buffer.byteLength(value, "utf8");
    if (evidenceBytes > maximumInputBytes) refuse("INVALID_EVIDENCE");
  };
  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > maximumInputNodes || depth > maximumEvidenceDepth)
      refuse("INVALID_EVIDENCE");
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return;
    if (typeof value === "string") {
      countBytes(value);
      return;
    }
    if (typeof value !== "object") refuse("INVALID_EVIDENCE");
    const object = value as object;
    if (active.has(object)) refuse("INVALID_EVIDENCE");
    active.add(object);
    if (Array.isArray(value)) {
      if (value.length > 10_000) refuse("INVALID_EVIDENCE");
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0)
        refuse("INVALID_EVIDENCE");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
          refuse("INVALID_EVIDENCE");
        visit(descriptor.value, depth + 1);
      }
      if (
        Object.keys(descriptors).some((key) =>
          key !== "length" && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length),
        )
      )
        refuse("INVALID_EVIDENCE");
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) refuse("INVALID_EVIDENCE");
      if (Object.getOwnPropertySymbols(value).length > 0) refuse("INVALID_EVIDENCE");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !("value" in descriptor)) refuse("INVALID_EVIDENCE");
        if (key.length > 500) refuse("INVALID_EVIDENCE");
        countBytes(key);
        visit(descriptor.value, depth + 1);
      }
    }
    active.delete(object);
  };
  visit(input, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    refuse("INVALID_EVIDENCE");
  }
  if (Buffer.byteLength(serialized!, "utf8") > maximumInputBytes) refuse("INVALID_EVIDENCE");
};

const sortDefinitions = <Value extends { kind: string; key: string; exactVersion: string }>(
  values: readonly Value[],
): Value[] =>
  [...values].sort((left, right) =>
    compareCanonicalStrings(
      `${left.kind}:${left.key}:${left.exactVersion}`,
      `${right.kind}:${right.key}:${right.exactVersion}`,
    ),
  );

const requireUniqueDefinitions = (
  definitions: readonly { kind: string; key: string; exactVersion: string; rootId: string }[],
): void => {
  const subjects = new Set<string>();
  for (const definition of definitions) {
    const subject = `${definition.kind}:${definition.key}`;
    if (subjects.has(subject)) refuse("RELEASE_INTEGRITY_FAILED");
    subjects.add(subject);
  }
};

const verifyReleaseEvidence = (
  evidence: ApplicationPackageManifestInput["application"] | ApplicationPackageManifestInput["modules"][number],
): void => {
  const { release, compilationOutput: output, resolutionSnapshot: snapshot, dependencyManifest } = evidence;
  if (
    output.kind !== release.kind ||
    output.canonical.envelope.organizationId !== release.organizationId ||
    output.canonical.envelope.rootId !== release.rootId ||
    output.artifact.rootId !== release.rootId ||
    output.canonical.envelope.key !== output.artifact.definitionKey ||
    output.artifact.exactVersion !== release.releaseVersion ||
    output.artifact.contentFingerprint !== release.contentFingerprint ||
    output.artifact.resolutionFingerprint !== release.resolutionFingerprint ||
    output.resolutionFingerprint !== release.resolutionFingerprint ||
    fingerprintCanonicalValue(output.canonical.content) !== release.contentFingerprint ||
    snapshot.fingerprint !== release.resolutionFingerprint ||
    !hasAuthenticResolutionFingerprint(snapshot)
  )
    refuse("RELEASE_INTEGRITY_FAILED");

  // New package manifests require the stored compiler-owned compatibility value. The required
  // application output schema enforces its syntax; no current platform version is consulted.
  if (
    release.kind === "application" &&
    (output.kind !== "application" || output.platformCompatibilityVersion === undefined)
  )
    refuse("RELEASE_INTEGRITY_FAILED");

  const ownDefinitions = snapshot.definitions.filter(
    (definition) =>
      definition.kind === release.kind &&
      definition.key === output.artifact.definitionKey &&
      String(definition.rootId).toLowerCase() === String(release.rootId).toLowerCase() &&
      definition.exactVersion === release.releaseVersion,
  );
  if (ownDefinitions.length !== 1) refuse("RELEASE_INTEGRITY_FAILED");
  const resolvedDefinitions = snapshot.definitions.filter((definition) => definition !== ownDefinitions[0]);
  requireUniqueDefinitions(resolvedDefinitions);
  requireUniqueDefinitions(output.resolvedDependencies);
  if (
    !sameCanonicalJson(
      sortDefinitions(resolvedDefinitions),
      sortDefinitions(output.resolvedDependencies),
    )
  )
    refuse("RELEASE_INTEGRITY_FAILED");

  const manifestResolvedDependencies = dependencyManifest
    .filter((dependency) => dependency.kind === "module" || dependency.kind === "connection_type")
    .map((dependency) => ({
      kind: dependency.kind,
      key: dependency.key,
      rootId: dependency.rootId,
      exactVersion: dependency.releaseVersion,
    }));
  requireUniqueDefinitions(manifestResolvedDependencies);
  if (
    !sameCanonicalJson(
      sortDefinitions(manifestResolvedDependencies),
      // Exact dependency rows declare release identity, not connection operation selection.
      // Complete operationKeys remain checked above against the authentic resolution snapshot.
      sortDefinitions(output.resolvedDependencies.map((definition) => ({
        kind: definition.kind,
        key: definition.key,
        rootId: definition.rootId,
        exactVersion: definition.exactVersion,
      }))),
    )
  )
    refuse("RELEASE_INTEGRITY_FAILED");
  const expectedDependencyOrder = [
    ...output.resolvedDependencies.map((definition) => definition.key),
    output.artifact.definitionKey,
  ];
  if (!sameCanonicalJson(expectedDependencyOrder, output.dependencyOrder))
    refuse("RELEASE_INTEGRITY_FAILED");

  if (
    !releaseManifestMatchesCanonicalContent(
      output as Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>,
      dependencyManifest,
    )
  )
    refuse("RELEASE_INTEGRITY_FAILED");
};

const moduleNodeKey = (rootId: string, releaseVersion: string): string =>
  `${rootId.toLowerCase()}@${releaseVersion}`;

const mergeDependencyClosure = (
  applicationDependencies: readonly ExactDefinitionDependency[],
  modules: readonly ApplicationPackageManifestInput["modules"][number][],
): ExactDefinitionDependency[] => {
  const bySubject = new Map<string, ExactDefinitionDependency>();
  for (const dependency of [
    ...applicationDependencies,
    ...modules.flatMap((module) => module.dependencyManifest),
  ]) {
    const subject = applicationPackageDependencySubject(dependency);
    const previous = bySubject.get(subject);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(dependency))
      refuse("DEPENDENCY_CLOSURE_INVALID");
    bySubject.set(subject, dependency);
  }
  return [...bySubject.values()].sort((left, right) =>
    compareCanonicalStrings(applicationPackageDependencySubject(left), applicationPackageDependencySubject(right)),
  );
};

const hasAssetReference = (root: unknown): boolean => {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (value === null || typeof value !== "object") return false;
    const entry = value as Record<string, unknown>;
    const kind = entry.kind;
    if (
      (kind === "asset_reference" || kind === "asset") &&
      (typeof entry.assetId === "string" || typeof entry.asset_id === "string")
    )
      return true;
    return Object.values(entry).some(visit);
  };
  return visit(root);
};

const acceptedTaskRegistryFingerprint = (): `sha256:${string}` =>
  fingerprintCanonicalValue(
    {
      tasks: Object.fromEntries(
        Object.keys(flowTaskRegistry)
          .sort(compareCanonicalStrings)
          .map((type) => [type, { version: flowTaskRegistry[type as keyof typeof flowTaskRegistry].version }]),
      ),
    },
  );

const verifyFlowTaskTrees = (flow: FlowDefinition): void => {
  const controlTypes = new Set<string>(flowControlTaskTypeKeys);
  const registeredTypes = new Set<string>(flowRegisteredTaskTypeKeys);
  const visit = (tasks: readonly FlowTask[]): void => {
    for (const task of tasks) {
      if (task.type.toLowerCase().includes("script")) refuse("UNSUPPORTED_SCRIPT_REFERENCE");
      const registered = flowTaskRegistry[task.type as keyof typeof flowTaskRegistry];
      if (registered === undefined) refuse("UNSUPPORTED_SCRIPT_REFERENCE");
      if (!controlTypes.has(task.type)) {
        if (!registeredTypes.has(task.type)) refuse("UNSUPPORTED_SCRIPT_REFERENCE");
        if (registered.version !== (task as { version?: string }).version)
          refuse("UNSUPPORTED_SCRIPT_REFERENCE");
        const properties = (task as { properties?: Record<string, unknown> }).properties;
        if (properties && Object.keys(properties).some((key) => key.toLowerCase().includes("script")))
          refuse("UNSUPPORTED_SCRIPT_REFERENCE");
      }
      for (const child of flowTaskChildLists(task)) visit(child.tasks);
    }
  };
  visit(flow.tasks);
  visit(flow.errors);
  visit(flow.finally);
};

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};

const build = (candidate: unknown): ApplicationPackageManifest => {
  assertBoundedJsonEvidence(candidate);
  const parsed = applicationPackageManifestInputSchema.safeParse(candidate);
  if (!parsed.success) refuse("INVALID_EVIDENCE");
  const input = parsed.data;
  const application = input.application;
  verifyReleaseEvidence(application);
  for (const module of input.modules) verifyReleaseEvidence(module);

  const organizationId = application.release.organizationId.toLowerCase();
  const modulesByNode = new Map<string, (typeof input.modules)[number]>();
  const modulesByKey = new Map<string, (typeof input.modules)[number]>();
  const modulesByRoot = new Map<string, (typeof input.modules)[number]>();
  for (const module of input.modules) {
    if (module.release.organizationId.toLowerCase() !== organizationId)
      refuse("DEPENDENCY_CLOSURE_INVALID");
    const key = moduleNodeKey(module.release.rootId, module.release.releaseVersion);
    const definitionKey = module.compilationOutput.artifact.definitionKey;
    const root = module.release.rootId.toLowerCase();
    const existingKey = modulesByKey.get(definitionKey);
    const existingRoot = modulesByRoot.get(root);
    if (
      modulesByNode.has(key) ||
      existingKey !== undefined ||
      existingRoot !== undefined
    )
      refuse("DEPENDENCY_CLOSURE_INVALID");
    modulesByNode.set(key, module);
    modulesByKey.set(definitionKey, module);
    modulesByRoot.set(root, module);
  }

  const visiting = new Set<string>();
  const reached = new Set<string>();
  const visitModule = (module: (typeof input.modules)[number]): void => {
    const key = moduleNodeKey(module.release.rootId, module.release.releaseVersion);
    if (visiting.has(key)) refuse("DEPENDENCY_CLOSURE_INVALID");
    if (reached.has(key)) return;
    visiting.add(key);
    for (const dependency of module.dependencyManifest) {
      if (dependency.kind !== "module") continue;
      const target = modulesByNode.get(moduleNodeKey(dependency.rootId, dependency.releaseVersion));
      if (
        target === undefined ||
        target.release.organizationId.toLowerCase() !== organizationId ||
        target.release.rootId.toLowerCase() !== dependency.rootId.toLowerCase() ||
        target.release.releaseRevision !== dependency.releaseRevision ||
        target.release.releaseVersion !== dependency.releaseVersion ||
        target.release.contentFingerprint !== dependency.contentFingerprint ||
        target.release.resolutionFingerprint !== dependency.resolutionFingerprint ||
        target.compilationOutput.artifact.definitionKey !== dependency.key
      )
        refuse("DEPENDENCY_CLOSURE_INVALID");
      visitModule(target);
    }
    visiting.delete(key);
    reached.add(key);
  };

  for (const dependency of application.dependencyManifest) {
    if (dependency.kind !== "module") continue;
    const target = modulesByNode.get(moduleNodeKey(dependency.rootId, dependency.releaseVersion));
    if (
      target === undefined ||
      target.release.organizationId.toLowerCase() !== organizationId ||
      target.release.releaseRevision !== dependency.releaseRevision ||
      target.release.contentFingerprint !== dependency.contentFingerprint ||
      target.release.resolutionFingerprint !== dependency.resolutionFingerprint ||
      target.compilationOutput.artifact.definitionKey !== dependency.key
    )
      refuse("DEPENDENCY_CLOSURE_INVALID");
    visitModule(target);
  }
  if (reached.size !== input.modules.length) refuse("DEPENDENCY_CLOSURE_INVALID");

  const output = application.compilationOutput;
  if (output.kind !== "application") refuse("RELEASE_INTEGRITY_FAILED");
  const moduleOutputs = [...reached]
    .map((key) => modulesByNode.get(key)!)
    .sort((left, right) => compareCanonicalStrings(left.release.rootId.toLowerCase(), right.release.rootId.toLowerCase()));

  // Placement follows publication's direct Application bindings. Transitive Modules remain in
  // the complete package closure, but their presence does not authorize component placement.
  const boundModuleReleases = output.canonical.content.moduleBindings.map((binding) => {
    const module = modulesByNode.get(moduleNodeKey(binding.moduleRootId, binding.resolvedVersion));
    if (module === undefined) return refuse("DEPENDENCY_CLOSURE_INVALID");
    return {
      moduleKey: module.compilationOutput.canonical.envelope.key,
      releaseVersion: module.release.releaseVersion,
    };
  });

  if (
    input.selectedBlockReleases.length !==
    application.dependencyManifest.filter((entry) => entry.kind === "platform_block").length
  )
    refuse("BLOCK_OR_THEME_EVIDENCE_INVALID");
  const selectedBlocksByIdentity = new Map<string, (typeof input.selectedBlockReleases)[number]>();
  for (const block of input.selectedBlockReleases) {
    const identity = `${block.blockId.toLowerCase()}@${block.releaseVersion}`;
    if (selectedBlocksByIdentity.has(identity)) refuse("BLOCK_OR_THEME_EVIDENCE_INVALID");
    const fingerprints = platformBlockReleaseFingerprints(block);
    if (
      fingerprints.contentFingerprint !== block.contentFingerprint ||
      fingerprints.catalogueFingerprint !== block.catalogueFingerprint
    )
      refuse("BLOCK_OR_THEME_EVIDENCE_INVALID");
    const dependency = application.dependencyManifest.find(
      (entry) =>
        entry.kind === "platform_block" &&
        entry.blockId.toLowerCase() === block.blockId.toLowerCase() &&
        entry.releaseVersion === block.releaseVersion,
    );
    if (
      dependency === undefined ||
      dependency.contentFingerprint !== block.contentFingerprint ||
      dependency.catalogueFingerprint !== block.catalogueFingerprint
    )
      refuse("BLOCK_OR_THEME_EVIDENCE_INVALID");
    const custom = block.customComponent;
    if (custom !== undefined) {
      const allowed = customComponentPlacementAllowedV2(custom.owner, {
        applicationKey: output.canonical.envelope.key,
        boundModuleReleases,
      });
      if (
        !allowed ||
        (custom.owner.kind === "application" &&
          custom.owner.releaseVersion !== application.release.releaseVersion)
      )
        refuse("BLOCK_OR_THEME_EVIDENCE_INVALID");
    }
    selectedBlocksByIdentity.set(identity, block);
  }

  const selectedTheme = input.selectedThemeRelease;
  const themeFingerprints = platformThemeReleaseFingerprints(selectedTheme);
  const themeDependency = application.dependencyManifest.find(
    (entry) => entry.kind === "platform_theme",
  );
  if (
    themeDependency === undefined ||
    themeDependency.catalogueThemeId.toLowerCase() !== selectedTheme.catalogueThemeId.toLowerCase() ||
    themeDependency.releaseVersion !== selectedTheme.releaseVersion ||
    themeDependency.contentFingerprint !== selectedTheme.contentFingerprint ||
    themeDependency.catalogueFingerprint !== selectedTheme.catalogueFingerprint ||
    themeFingerprints.contentFingerprint !== selectedTheme.contentFingerprint ||
    themeFingerprints.catalogueFingerprint !== selectedTheme.catalogueFingerprint
  )
    refuse("BLOCK_OR_THEME_EVIDENCE_INVALID");

  if (
    hasAssetReference(output.canonical.content) ||
    input.selectedBlockReleases.some(hasAssetReference) ||
    hasAssetReference(selectedTheme.tokens) ||
    moduleOutputs.some((module) => hasAssetReference(module.compilationOutput.canonical.content))
  )
    refuse("UNSUPPORTED_ASSET_REFERENCE");

  const applicationOwner = application.release;
  const packagePermissions: ApplicationPackageManifest["permissions"] = [];
  const storage: ApplicationPackageManifest["storage"] = [];
  const flows: ApplicationPackageManifest["flows"] = [];
  const allFlows: FlowDefinition[] = [];
  const packagePermission = (declaration: unknown): ApplicationPackageManifest["permissions"][number]["declaration"] => {
    const parsed = applicationPackagePermissionDeclarationSchema.safeParse(declaration);
    if (!parsed.success) return refuse("UNSUPPORTED_PERMISSION_DECLARATION");
    return parsed.data;
  };
  const permissions: ApplicationPackageManifest["permissions"] = output.canonical.content.permissions.map((declaration) => ({
    owner: applicationOwner,
    declaration: packagePermission(declaration),
  }));
  for (const flow of output.canonical.content.flows) {
    allFlows.push(flow);
    flows.push({ owner: applicationOwner, flowId: flow.id, key: flow.key });
  }
  for (const module of moduleOutputs) {
    const moduleOutput = module.compilationOutput;
    if (moduleOutput.kind !== "module") refuse("RELEASE_INTEGRITY_FAILED");
    packagePermissions.push(
      ...moduleOutput.canonical.content.permissions.map((declaration) => ({
        owner: module.release,
        declaration: packagePermission(declaration),
      })),
    );
    for (const recordType of moduleOutput.canonical.content.recordTypes) {
      const systemProjection = recordType.systemProjection;
      storage.push({
        owner: module.release,
        recordTypeId: recordType.recordTypeId,
        key: recordType.key,
        storageContractId: recordType.storageContractId,
        storageScope: recordType.storageScope,
        storageKind: systemProjection === undefined ? "generated" : "system_projection",
        ...(systemProjection === undefined
          ? {}
          : {
              systemProjection: {
                ...systemProjection,
                filterableFieldIds: [...systemProjection.filterableFieldIds].sort(compareCanonicalStrings),
                sortableFieldIds: [...systemProjection.sortableFieldIds].sort(compareCanonicalStrings),
              },
            }),
      });
    }
    for (const flow of moduleOutput.canonical.content.flows) {
      allFlows.push(flow);
      flows.push({ owner: module.release, flowId: flow.id, key: flow.key });
    }
  }
  for (const flow of allFlows) verifyFlowTaskTrees(flow);

  const appPermissionKeys = new Set(
    [...permissions, ...packagePermissions].map((entry) =>
      (entry.declaration as { key: string }).key,
    ),
  );
  const roles: ApplicationPackageManifest["roles"] = output.canonical.content.roles.map((declaration) => {
    if (declaration.permissionKeys.some((key) => !appPermissionKeys.has(key)))
      refuse("RELEASE_INTEGRITY_FAILED");
    return {
      owner: applicationOwner,
      declaration: {
        ...declaration,
        permissionKeys: [...declaration.permissionKeys].sort(compareCanonicalStrings),
      },
    };
  });
  const allPermissions = [...permissions, ...packagePermissions].sort((left, right) =>
    compareCanonicalStrings(
      `${left.owner.rootId.toLowerCase()}:${(left.declaration as { permissionId: string }).permissionId.toLowerCase()}`,
      `${right.owner.rootId.toLowerCase()}:${(right.declaration as { permissionId: string }).permissionId.toLowerCase()}`,
    ),
  );
  const allRoles = [...roles];
  const allBlocks = [...selectedBlocksByIdentity.values()]
    .sort((left, right) =>
      compareCanonicalStrings(
        `${left.blockId.toLowerCase()}@${left.releaseVersion}`,
        `${right.blockId.toLowerCase()}@${right.releaseVersion}`,
      ),
    )
    .map((block) => ({
      blockId: block.blockId,
      key: block.key,
      releaseVersion: block.releaseVersion,
      contentFingerprint: block.contentFingerprint,
      catalogueFingerprint: block.catalogueFingerprint,
      ...(block.customComponent === undefined
        ? {}
        : {
            customComponent: {
              ...block.customComponent,
              bundle: {
                ...block.customComponent.bundle,
                allowedHosts: [...block.customComponent.bundle.allowedHosts].sort(compareCanonicalStrings),
              },
            },
          }),
    }));
  const componentHosts = [...new Set(
    input.selectedBlockReleases.flatMap((block) => block.customComponent?.bundle.allowedHosts ?? []),
  )].sort(compareCanonicalStrings);
  const orderedRoles = allRoles.sort((left, right) =>
    compareCanonicalStrings(
      `${left.owner.rootId.toLowerCase()}:${left.declaration.roleId.toLowerCase()}`,
      `${right.owner.rootId.toLowerCase()}:${right.declaration.roleId.toLowerCase()}`,
    ),
  );
  const orderedFlows = flows.sort((left, right) =>
    compareCanonicalStrings(
      `${left.owner.rootId.toLowerCase()}:${left.flowId.toLowerCase()}`,
      `${right.owner.rootId.toLowerCase()}:${right.flowId.toLowerCase()}`,
    ),
  );
  const orderedStorage = storage.sort((left, right) =>
    compareCanonicalStrings(
      `${left.owner.rootId.toLowerCase()}:${left.recordTypeId.toLowerCase()}`,
      `${right.owner.rootId.toLowerCase()}:${right.recordTypeId.toLowerCase()}`,
    ),
  );
  const orderedDependencies = mergeDependencyClosure(application.dependencyManifest, moduleOutputs);
  const bundleChecksum = fingerprintCanonicalValue(output.toolBundle);
  const withoutFingerprint = {
    manifestKind: "application_package" as const,
    manifestVersion: "1.0.0" as const,
    application: application.release,
    platformCompatibilityVersion: output.platformCompatibilityVersion,
    modules: moduleOutputs.map((module) => module.release),
    dependencies: orderedDependencies,
    roles: orderedRoles,
    permissions: allPermissions,
    storage: orderedStorage,
    flows: orderedFlows,
    tools: { bundle: output.toolBundle, checksum: bundleChecksum },
    blocks: allBlocks,
    componentHosts,
    componentsPresent: allBlocks.some((block) => block.customComponent !== undefined),
    theme: {
      catalogueThemeId: selectedTheme.catalogueThemeId,
      releaseVersion: selectedTheme.releaseVersion,
      contentFingerprint: selectedTheme.contentFingerprint,
      catalogueFingerprint: selectedTheme.catalogueFingerprint,
    },
    assets: { support: "unsupported" as const, referenceCount: 0 as const },
    seeds: { support: "unsupported" as const, recordCount: 0 as const },
    scripts: {
      support: "unsupported" as const,
      referencesPresent: false as const,
      acceptedTaskRegistryFingerprint: acceptedTaskRegistryFingerprint(),
    },
  };
  const fingerprint = fingerprintCanonicalValue(withoutFingerprint);
  const manifest = applicationPackageManifestSchema.parse({ ...withoutFingerprint, fingerprint });
  if (
    manifest.fingerprint !== fingerprintCanonicalValue(withoutFingerprint) ||
    !sameCanonicalJson(withoutFingerprint, Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "fingerprint")))
  )
    refuse("INVALID_EVIDENCE");
  return deepFreeze(manifest);
};

/** Builds a deterministic package declaration from caller-supplied exact immutable release evidence. */
export const buildApplicationPackageManifest = (candidate: unknown): ApplicationPackageManifest => {
  try {
    return build(candidate);
  } catch (error) {
    if (error instanceof ApplicationPackageManifestError) throw error;
    throw new ApplicationPackageManifestError("INVALID_EVIDENCE");
  }
};
