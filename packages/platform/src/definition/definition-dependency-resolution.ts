import "server-only";

import type { ModuleRootId, Revision } from "../catalogue/identifiers";
import type { FlowDefinition } from "../workflows/flow-contracts";
import {
  applicationCompositionCatalogueSnapshotSchema,
  type ApplicationCompositionCatalogueSnapshot,
} from "./application-composition/catalogue-snapshot";
import { customComponentPlacementAllowed } from "./application-composition/custom-components";
import {
  protectedOperationReferenceSchema,
  type PlatformServiceOperationRelease,
  type ProtectedOperationReference,
} from "./application-flow-bindings";
import {
  definitionCompilationOutputSchema,
  definitionResolutionSnapshotSchema,
  moduleCompilationOutputSchema,
  type DefinitionCompilationOutput,
  type DefinitionResolutionSnapshot,
} from "./definition-compilation-contracts";
import { assertModuleContractPair, type ApplicationSourceDocument } from "./definition-source";
import type {
  ExactDefinitionDependency,
  StoredDefinitionDraft,
} from "./definition-store-contracts";
import type { VersionRequirement } from "./definitions";
import { stableDefinitionReleaseVersionSchema } from "./version-impact";
import { compare, satisfies } from "semver";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "./canonical-json-definition";
import { applicationModuleKeys } from "./application-module-sources";
import { createApplicationResolutionSnapshot } from "./application-resolution";
import {
  flowOperationReferencesByNode,
  platformOperationsCalledBy,
  type ProtectedOperationReferenceLookups,
} from "./flow-operation-calls";
import {
  type ModuleOutput,
  type DefinitionResolution,
  refuse,
  type DefinitionCandidateDraft,
  type ResolvableModuleRelease,
  type ModuleReleasePageCursor,
  type ResolvableConnectionTypeRelease,
  type DefinitionPublicationReader,
  type DefinitionPublicationCatalogue,
} from "./definition-publication-contracts";
import { moduleDependencies } from "./module-dependencies";
import { DefinitionError } from "./definition-error";

type Requirement = Readonly<{ key: string; version: VersionRequirement }>;

export type ResolvedDependencies = Readonly<{
  modules: readonly ResolvableModuleRelease[];
  connections: readonly ResolvableConnectionTypeRelease[];
  composition?: ApplicationCompositionCatalogueSnapshot;
  platformOperations: readonly PlatformServiceOperationRelease[];
}>;

const stable = (version: string): boolean =>
  stableDefinitionReleaseVersionSchema.safeParse(version).success;

const moduleOutputContractVersion = (output: ModuleOutput): "4.0.0" =>
  output.validationContractVersion;

const accepts = (requirements: readonly VersionRequirement[], version: string): boolean =>
  requirements.every((requirement) =>
    requirement.selection === "exact"
      ? requirement.version === version
      : satisfies(version, requirement.expression, { includePrerelease: false }),
  );

const groupRequirements = (requirements: readonly Requirement[]) => {
  const grouped = new Map<string, VersionRequirement[]>();
  for (const requirement of requirements)
    grouped.set(requirement.key, [...(grouped.get(requirement.key) ?? []), requirement.version]);
  return [...grouped].sort(([left], [right]) => compareCanonicalStrings(left, right));
};

const chooseStableRelease = <Release extends { releaseVersion: string }>(
  releases: readonly Release[],
  requirements: readonly VersionRequirement[],
): Release => {
  if (releases.length === 0) return refuse("DEFINITION_DEPENDENCY_MISSING");
  const stableReleases = releases.filter((release) => stable(release.releaseVersion));
  if (stableReleases.length === 0) return refuse("DEFINITION_DEPENDENCY_PRERELEASE_ONLY");
  const compatible = stableReleases.filter((release) =>
    accepts(requirements, release.releaseVersion),
  );
  if (compatible.length === 0) return refuse("DEFINITION_DEPENDENCY_INCOMPATIBLE");
  const highestVersion = compatible
    .map((release) => release.releaseVersion)
    .sort(compare)
    .at(-1)!;
  const highest = compatible.filter((release) => release.releaseVersion === highestVersion);
  if (highest.length !== 1) return refuse("DEFINITION_DEPENDENCY_AMBIGUOUS");
  return highest[0]!;
};

type ModuleSelectionFold = {
  sawRelease: boolean;
  sawStable: boolean;
  sawCompatible: boolean;
  best: ResolvableModuleRelease | undefined;
  bestMultiplicity: number;
};

const createModuleSelectionFold = (): ModuleSelectionFold => ({
  sawRelease: false,
  sawStable: false,
  sawCompatible: false,
  best: undefined,
  bestMultiplicity: 0,
});

const foldModuleSelection = (
  fold: ModuleSelectionFold,
  release: ResolvableModuleRelease,
  requirements: readonly VersionRequirement[],
): void => {
  fold.sawRelease = true;
  if (!stable(release.releaseVersion)) return;
  fold.sawStable = true;
  if (!accepts(requirements, release.releaseVersion)) return;
  fold.sawCompatible = true;
  if (fold.best === undefined || compare(release.releaseVersion, fold.best.releaseVersion) > 0) {
    fold.best = release;
    fold.bestMultiplicity = 1;
  } else if (release.releaseVersion === fold.best.releaseVersion) {
    fold.bestMultiplicity += 1;
  }
};

const completeModuleSelection = (fold: ModuleSelectionFold): ResolvableModuleRelease => {
  if (!fold.sawRelease) return refuse("DEFINITION_DEPENDENCY_MISSING");
  if (!fold.sawStable) return refuse("DEFINITION_DEPENDENCY_PRERELEASE_ONLY");
  if (!fold.sawCompatible || fold.best === undefined)
    return refuse("DEFINITION_DEPENDENCY_INCOMPATIBLE");
  if (fold.bestMultiplicity !== 1) return refuse("DEFINITION_DEPENDENCY_AMBIGUOUS");
  return fold.best;
};

/**
 * A Module depends on the Modules its references name (derived, never stored); an Application
 * accepts the current release of every Module it owns or uses.
 */
const moduleRequirements = (draft: StoredDefinitionDraft): Requirement[] =>
  draft.source.kind === "module"
    ? moduleDependencies(draft.source).map((entry) => ({
        key: entry.module,
        version: entry.version,
      }))
    : draft.source.kind === "application"
      ? applicationModuleKeys(draft.source).map((key) => ({
          key,
          version: { selection: "allowed_range", expression: "*" },
        }))
      : [];

const connectionRequirements = (draft: StoredDefinitionDraft): Requirement[] =>
  draft.source.kind === "application"
    ? draft.source.body.connection_bindings.map((entry) => ({
        key: entry.connection_type,
        version: entry.version,
      }))
    : [];

const subjectOf = (dependency: ExactDefinitionDependency): string =>
  dependency.kind === "platform_theme"
    ? `${dependency.kind}:${dependency.catalogueThemeId}`
    : dependency.kind === "platform_block"
      ? `${dependency.kind}:${dependency.blockId}@${dependency.releaseVersion}`
      : dependency.kind === "application_flow"
        ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.flowId}`
        : dependency.kind === "application_flow_node"
          ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.flowId}:${dependency.nodeId}`
          : dependency.kind === "application_query"
            ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.queryId}`
            : dependency.kind === "module_query"
              ? `${dependency.kind}:${dependency.moduleRootId}:${dependency.queryId}`
              : dependency.kind === "application_form"
                ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.formId}`
                : dependency.kind === "application_workflow"
                  ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.workflowId}`
                  : dependency.kind === "application_action"
                    ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.actionId}`
                    : dependency.kind === "protected_operation"
                      ? `${dependency.kind}:${dependency.operation.owner.kind}:${
                          dependency.operation.owner.kind === "application"
                            ? dependency.operation.owner.applicationRootId
                            : dependency.operation.owner.kind === "module"
                              ? dependency.operation.owner.moduleRootId
                              : dependency.operation.owner.serviceId
                        }:${dependency.operation.operationId}`
                      : `${dependency.kind}:${dependency.key}`;

const sortedManifest = (
  dependencies: readonly ExactDefinitionDependency[],
): ExactDefinitionDependency[] =>
  [...dependencies].sort((left, right) =>
    compareCanonicalStrings(subjectOf(left), subjectOf(right)),
  );

const verifyParsedModuleRelease = (
  candidate: DefinitionCandidateDraft,
  expectedKey: string,
  release: ResolvableModuleRelease,
  parsedOutput: ReturnType<typeof definitionCompilationOutputSchema.safeParse>,
): void => {
  const publication = release.published.publication;
  try {
    assertModuleContractPair(
      moduleOutputContractVersion(release.compilationOutput),
      publication.validationContractVersion,
    );
  } catch (cause) {
    throw new DefinitionError("DEFINITION_DEPENDENCY_SUBSTITUTED", { cause });
  }
  const parsedResolution = definitionResolutionSnapshotSchema.safeParse(release.resolutionSnapshot);
  const ownResolution = parsedResolution.success
    ? parsedResolution.data.definitions.filter(
        (definition) =>
          definition.kind === "module" &&
          definition.key === release.key &&
          definition.rootId === release.rootId &&
          definition.exactVersion === release.releaseVersion,
      )
    : [];
  const authenticResolutionFingerprint = parsedResolution.success
    ? fingerprintCanonicalValue({
        contractVersion: parsedResolution.data.contractVersion,
        definitions: parsedResolution.data.definitions,
        identities: parsedResolution.data.identities,
      })
    : undefined;
  if (
    release.organizationId !== candidate.draft.organizationId ||
    release.key !== expectedKey ||
    !parsedOutput.success ||
    parsedOutput.data.kind !== "module" ||
    !parsedResolution.success ||
    moduleOutputContractVersion(parsedOutput.data) !== publication.validationContractVersion ||
    ownResolution.length !== 1 ||
    authenticResolutionFingerprint !== release.resolutionFingerprint ||
    publication.kind !== "module" ||
    publication.rootId !== release.rootId ||
    publication.revision !== release.releaseRevision ||
    publication.releaseVersion !== release.releaseVersion ||
    publication.contentFingerprint !== release.contentFingerprint ||
    release.compilationOutput.artifact.rootId !== release.rootId ||
    release.compilationOutput.canonical.envelope.key !== release.key ||
    release.compilationOutput.artifact.exactVersion !== release.releaseVersion ||
    release.compilationOutput.artifact.contentFingerprint !== release.contentFingerprint ||
    release.resolutionSnapshot.fingerprint !== release.resolutionFingerprint ||
    release.compilationOutput.artifact.resolutionFingerprint !== release.resolutionFingerprint ||
    release.compilationOutput.resolutionFingerprint !== release.resolutionFingerprint ||
    fingerprintCanonicalValue(release.published.content) !== release.contentFingerprint
  )
    refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
};

// A release read once is the same object for the rest of a draft compile, which checks it from
// several steps. The check is a pure function of the object and of what it is checked against,
// and a read release is never modified, so the same object passes the same check once. A release
// read again is a new object and is checked again; a refusal is never remembered.
const verifiedReleases = new WeakMap<ResolvableModuleRelease, Set<string>>();

const verifyOnce = (
  check: "current" | "historical",
  candidate: DefinitionCandidateDraft,
  expectedKey: string,
  release: ResolvableModuleRelease,
  verify: () => void,
): void => {
  const expectation = JSON.stringify([check, candidate.draft.organizationId, expectedKey]);
  const passed = verifiedReleases.get(release);
  if (passed?.has(expectation)) return;
  verify();
  if (passed === undefined) verifiedReleases.set(release, new Set([expectation]));
  else passed.add(expectation);
};

/** Every selected, pinned or transitive dependency must satisfy the current Module contract. */
const verifyModuleRelease = (
  candidate: DefinitionCandidateDraft,
  expectedKey: string,
  release: ResolvableModuleRelease,
): void =>
  verifyOnce("current", candidate, expectedKey, release, () =>
    verifyParsedModuleRelease(
      candidate,
      expectedKey,
      release,
      definitionCompilationOutputSchema.safeParse(release.compilationOutput),
    ),
  );

/** Historical enumeration preserves stored semantics before current dependency selection. */
const verifyHistoricalModuleRelease = (
  candidate: DefinitionCandidateDraft,
  expectedKey: string,
  release: ResolvableModuleRelease,
): void =>
  verifyOnce("historical", candidate, expectedKey, release, () =>
    verifyParsedModuleRelease(
      candidate,
      expectedKey,
      release,
      moduleCompilationOutputSchema.safeParse(release.compilationOutput),
    ),
  );

const sameModuleReleaseLocator = (
  left: ResolvableModuleRelease,
  right: ResolvableModuleRelease,
): boolean =>
  left.organizationId === right.organizationId &&
  left.key === right.key &&
  left.rootId === right.rootId &&
  left.releaseRevision === right.releaseRevision &&
  left.releaseVersion === right.releaseVersion &&
  left.contentFingerprint === right.contentFingerprint &&
  left.resolutionFingerprint === right.resolutionFingerprint;

const selectModuleRelease = async (
  reader: DefinitionPublicationReader,
  candidate: DefinitionCandidateDraft,
  key: string,
  requirements: readonly VersionRequirement[],
): Promise<ResolvableModuleRelease> => {
  const selection = createModuleSelectionFold();
  let cursor: ModuleReleasePageCursor | undefined;
  let anchoredRootId: ModuleRootId | undefined;
  let anchoredRevision: Revision | undefined;
  let previousReleaseRevision: Revision | null = null;
  while (true) {
    const page = await reader.readModuleReleasePage(candidate.draft.organizationId, key, cursor);
    if (page.entries.length > 100) refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    if (cursor === undefined) {
      if (page.rootId === null || page.anchorReleaseRevision === null) {
        if (
          page.rootId !== null ||
          page.anchorReleaseRevision !== null ||
          page.entries.length !== 0 ||
          page.nextAfterReleaseRevision !== null
        )
          refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
        break;
      }
      anchoredRootId = page.rootId;
      anchoredRevision = page.anchorReleaseRevision;
    } else if (
      page.rootId !== cursor.rootId ||
      page.anchorReleaseRevision !== cursor.anchorReleaseRevision
    ) {
      refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    }
    if (
      anchoredRootId === undefined ||
      anchoredRevision === undefined ||
      page.rootId !== anchoredRootId ||
      page.anchorReleaseRevision !== anchoredRevision ||
      page.entries.length === 0
    )
      refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    const currentRootId = anchoredRootId as ModuleRootId;
    const currentAnchorRevision = anchoredRevision as Revision;
    for (const entry of page.entries) {
      const release = entry.release;
      if (
        entry.previousReleaseRevision !== previousReleaseRevision ||
        release.rootId !== currentRootId ||
        release.releaseRevision <= (previousReleaseRevision ?? 0) ||
        release.releaseRevision > currentAnchorRevision
      )
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      verifyHistoricalModuleRelease(candidate, key, release);
      foldModuleSelection(selection, release, requirements);
      previousReleaseRevision = release.releaseRevision;
    }
    const last = previousReleaseRevision;
    if (page.nextAfterReleaseRevision === null) {
      if (last !== currentAnchorRevision) refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      break;
    }
    if (
      last === null ||
      page.nextAfterReleaseRevision !== last ||
      page.nextAfterReleaseRevision >= currentAnchorRevision
    )
      refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    cursor = {
      rootId: currentRootId,
      anchorReleaseRevision: currentAnchorRevision,
      afterReleaseRevision: page.nextAfterReleaseRevision,
    };
  }
  const selected = completeModuleSelection(selection);
  const exact = await reader.readModuleRelease(
    candidate.draft.organizationId,
    selected.rootId,
    selected.releaseRevision,
  );
  if (exact === undefined || !sameModuleReleaseLocator(selected, exact))
    return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  verifyModuleRelease(candidate, key, exact as ResolvableModuleRelease);
  return exact as ResolvableModuleRelease;
};

/** The release of Module `key` that a dependant accepting any version resolves to now. */
export const selectCurrentModuleRelease = (
  reader: DefinitionPublicationReader,
  candidate: DefinitionCandidateDraft,
  key: string,
): Promise<ResolvableModuleRelease> =>
  selectModuleRelease(reader, candidate, key, [{ selection: "allowed_range", expression: "*" }]);

const verifyConnectionRelease = (
  expectedKey: string,
  release: ResolvableConnectionTypeRelease,
): void => {
  const output = definitionCompilationOutputSchema.safeParse(release.compilationOutput);
  if (
    release.key !== expectedKey ||
    !stable(release.releaseVersion) ||
    !output.success ||
    output.data.kind !== "connection_type" ||
    output.data.canonical.key !== release.key ||
    output.data.artifact.rootId !== release.rootId ||
    output.data.artifact.exactVersion !== release.releaseVersion ||
    output.data.artifact.contentFingerprint !== release.contentFingerprint ||
    fingerprintCanonicalValue(output.data.canonical) !== release.contentFingerprint
  )
    refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
};

const findPinned = <Kind extends ExactDefinitionDependency["kind"]>(
  manifest: readonly ExactDefinitionDependency[],
  kind: Kind,
  subject: string,
  releaseVersion?: string,
): Extract<ExactDefinitionDependency, { kind: Kind }> => {
  const matches = manifest.filter(
    (entry) =>
      entry.kind === kind &&
      (entry.kind === "platform_theme"
        ? entry.catalogueThemeId === subject
        : entry.kind === "platform_block"
          ? entry.blockId === subject &&
            (releaseVersion === undefined || entry.releaseVersion === releaseVersion)
          : entry.kind === "protected_operation"
            ? entry.operation.operationId === subject
            : entry.kind === "module" || entry.kind === "connection_type"
              ? entry.key === subject
              : false),
  );
  if (matches.length !== 1) return refuse("DEFINITION_CONFIRMATION_MISMATCH");
  return matches[0] as Extract<ExactDefinitionDependency, { kind: Kind }>;
};

const resolveApplicationComposition = async (
  source: ApplicationSourceDocument,
  catalogue: DefinitionPublicationCatalogue,
  modules: readonly ResolvableModuleRelease[],
  pinned?: readonly ExactDefinitionDependency[],
): Promise<ApplicationCompositionCatalogueSnapshot> => {
  const customComponentPlacement = {
    applicationKey: source.key,
    boundModuleReleases: modules.map((module) => ({
      moduleKey: module.key,
      releaseVersion: module.releaseVersion,
    })),
  };
  const selection = {
    platformBlocks: source.body.platform_block_dependencies.map((dependency) => ({
      blockId: dependency.block_id,
      releaseVersion: dependency.release_version,
    })),
    platformTheme: {
      catalogueThemeId: source.body.theme.base.catalogue_theme_id,
      releaseVersion: source.body.theme.base.release_version,
    },
    customComponentPlacement,
  };
  const candidate = await catalogue.readApplicationCompositionCatalogueSnapshot(selection);
  if (candidate === undefined) return refuse("DEFINITION_DEPENDENCY_MISSING");
  const parsed = applicationCompositionCatalogueSnapshotSchema.safeParse(candidate);
  if (!parsed.success) return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  const snapshot = parsed.data;
  // A custom component is placeable only by its owning application or by an application that binds
  // the exact owning module release; the catalogue already filters, and this re-checks the returned
  // snapshot so a substituted catalogue can never introduce a foreign component.
  for (const release of snapshot.platformBlocks.releases) {
    const custom = release.customComponent;
    if (
      custom !== undefined &&
      !customComponentPlacementAllowed(custom.owner, customComponentPlacement)
    )
      return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  }
  const fingerprint = fingerprintCanonicalValue({
    contractVersion: snapshot.contractVersion,
    platformBlocks: snapshot.platformBlocks,
    platformTheme: snapshot.platformTheme,
  });
  if (snapshot.fingerprint !== fingerprint) refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  const blocks = new Map(
    snapshot.platformBlocks.releases.map(
      (release) => [`${release.blockId}@${release.releaseVersion}`, release] as const,
    ),
  );
  if (blocks.size !== source.body.platform_block_dependencies.length)
    refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  for (const authored of source.body.platform_block_dependencies) {
    const release = blocks.get(`${authored.block_id}@${authored.release_version}`);
    if (
      release === undefined ||
      !stable(release.releaseVersion) ||
      release.releaseVersion !== authored.release_version
    )
      return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    if (pinned !== undefined) {
      const exact = findPinned(
        pinned,
        "platform_block",
        String(authored.block_id),
        String(authored.release_version),
      );
      if (
        exact.releaseVersion !== release.releaseVersion ||
        exact.contentFingerprint !== release.contentFingerprint
      )
        refuse("DEFINITION_CONFIRMATION_MISMATCH");
    }
  }
  const base = source.body.theme.base;
  if (
    snapshot.platformTheme.catalogueThemeId !== base.catalogue_theme_id ||
    snapshot.platformTheme.releaseVersion !== base.release_version ||
    !stable(snapshot.platformTheme.releaseVersion)
  )
    refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  if (pinned !== undefined) {
    const exact = findPinned(pinned, "platform_theme", String(base.catalogue_theme_id));
    if (
      exact.releaseVersion !== snapshot.platformTheme.releaseVersion ||
      exact.contentFingerprint !== snapshot.platformTheme.contentFingerprint
    )
      refuse("DEFINITION_CONFIRMATION_MISMATCH");
  }
  return snapshot;
};

export const resolveDependencies = async (
  reader: DefinitionPublicationReader,
  catalogue: DefinitionPublicationCatalogue,
  candidate: DefinitionCandidateDraft,
  pinned?: readonly ExactDefinitionDependency[],
): Promise<ResolvedDependencies> => {
  const moduleGroups = [...groupRequirements(moduleRequirements(candidate.draft))];
  let moduleReleases: readonly (ResolvableModuleRelease | undefined)[];
  if (pinned === undefined) {
    moduleReleases = await Promise.all(
      moduleGroups.map(([key, requirements]) =>
        selectModuleRelease(reader, candidate, key, requirements),
      ),
    );
  } else {
    const exacts = moduleGroups.map(([key, requirements]) => {
      const exact = findPinned(pinned, "module", key);
      if (!accepts(requirements, exact.releaseVersion)) refuse("DEFINITION_CONFIRMATION_MISMATCH");
      return exact;
    });
    moduleReleases = await reader.readModuleReleases(
      candidate.draft.organizationId,
      exacts.map((exact) => ({ rootId: exact.rootId, releaseRevision: exact.releaseRevision })),
    );
    exacts.forEach((exact, index) => {
      const release = moduleReleases[index];
      if (
        release !== undefined &&
        (release.releaseVersion !== exact.releaseVersion ||
          release.contentFingerprint !== exact.contentFingerprint)
      )
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    });
  }
  const modules: ResolvableModuleRelease[] = moduleGroups.map(([key], index) => {
    const release = moduleReleases[index];
    if (release === undefined)
      return refuse(
        pinned === undefined
          ? "DEFINITION_DEPENDENCY_MISSING"
          : "DEFINITION_DEPENDENCY_SUBSTITUTED",
      );
    verifyModuleRelease(candidate, key, release);
    return release;
  });

  const connections: ResolvableConnectionTypeRelease[] = await Promise.all(
    [...groupRequirements(connectionRequirements(candidate.draft))].map(
      async ([key, requirements]) => {
        let release: ResolvableConnectionTypeRelease | undefined;
        if (pinned === undefined) {
          release = chooseStableRelease(
            await catalogue.listConnectionTypeReleases(key),
            requirements,
          );
        } else {
          const exact = findPinned(pinned, "connection_type", key);
          if (!accepts(requirements, exact.releaseVersion))
            refuse("DEFINITION_CONFIRMATION_MISMATCH");
          release = await catalogue.readConnectionTypeRelease(exact.rootId, exact.releaseVersion);
          if (release === undefined || release.contentFingerprint !== exact.contentFingerprint)
            refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
        }
        if (release === undefined) return refuse("DEFINITION_DEPENDENCY_MISSING");
        verifyConnectionRelease(key, release);
        return release;
      },
    ),
  );

  let composition: ApplicationCompositionCatalogueSnapshot | undefined;
  if (candidate.draft.source.kind === "application")
    composition = await resolveApplicationComposition(
      candidate.draft.source,
      catalogue,
      modules,
      pinned,
    );

  const platformOperations: PlatformServiceOperationRelease[] = [];
  const platformOperationSubjects = new Set<string>();
  if (candidate.draft.source.kind === "application") {
    // A flow names a platform-service operation only by its key, so the release the catalogue holds
    // for that operation is what publication pins.
    const called = platformOperationsCalledBy(candidate.draft.source.body.flows);
    const operationReleases = await Promise.all(
      called.map((operation) =>
        catalogue.readPlatformServiceOperationRelease?.(
          operation.release.serviceId,
          operation.release.operationId,
          operation.release.releaseVersion,
        ),
      ),
    );
    for (const [index, operation] of called.entries()) {
      const registered = operation.release;
      const release = operationReleases[index];
      if (
        release === undefined ||
        release.serviceId !== registered.serviceId ||
        release.operationId !== registered.operationId ||
        release.releaseVersion !== registered.releaseVersion
      )
        refuse(
          release === undefined
            ? "DEFINITION_DEPENDENCY_MISSING"
            : "DEFINITION_DEPENDENCY_SUBSTITUTED",
        );
      if (pinned !== undefined) {
        const exact = pinned.flatMap((dependency) =>
          dependency.kind === "protected_operation" &&
          dependency.operation.owner.kind === "platform_service" &&
          dependency.operation.owner.serviceId === registered.serviceId &&
          dependency.operation.operationId === registered.operationId
            ? [dependency]
            : [],
        );
        if (exact.length !== 1) refuse("DEFINITION_CONFIRMATION_MISMATCH");
        const pinnedOperation = exact[0]!;
        if (
          pinnedOperation.releaseVersion !== release.releaseVersion ||
          pinnedOperation.contentFingerprint !== release.contentFingerprint
        )
          refuse("DEFINITION_CONFIRMATION_MISMATCH");
      }
      const subject = `${release.serviceId}:${release.operationId}:${release.releaseVersion}`;
      if (!platformOperationSubjects.has(subject)) {
        platformOperationSubjects.add(subject);
        platformOperations.push(release);
      }
    }
  }

  const expectedSubjects = [
    ...modules.map((release) => `module:${release.key}`),
    ...connections.map((release) => `connection_type:${release.key}`),
    ...(composition === undefined
      ? []
      : [
          ...composition.platformBlocks.releases.map(
            (release) => `platform_block:${release.blockId}@${release.releaseVersion}`,
          ),
          `platform_theme:${composition.platformTheme.catalogueThemeId}`,
        ]),
  ].sort(compareCanonicalStrings);
  if (
    pinned !== undefined &&
    JSON.stringify(
      [...pinned]
        .filter((dependency) =>
          ["module", "connection_type", "platform_block", "platform_theme"].includes(
            dependency.kind,
          ),
        )
        .map(subjectOf)
        .sort(compareCanonicalStrings),
    ) !== JSON.stringify(expectedSubjects)
  )
    refuse("DEFINITION_CONFIRMATION_MISMATCH");
  return {
    modules,
    connections,
    platformOperations,
    ...(composition === undefined ? {} : { composition }),
  };
};

export const assertNoCycle = async (
  reader: DefinitionPublicationReader,
  candidate: DefinitionCandidateDraft,
  modules: readonly ResolvableModuleRelease[],
): Promise<void> => {
  const reference = (release: ResolvableModuleRelease) =>
    `${String(release.rootId).toLowerCase()}:${release.releaseRevision}`;
  const graph = new Map<string, ResolvableModuleRelease>();
  const edges = new Map<string, readonly string[]>();
  let frontier = [...modules];
  while (frontier.length > 0) {
    const unique = [
      ...new Map(
        frontier
          .filter((release) => !graph.has(reference(release)))
          .map((release) => [reference(release), release]),
      ).values(),
    ];
    if (unique.length === 0) break;
    const dependencies = unique.flatMap((release) => {
      if (String(release.rootId).toLowerCase() === String(candidate.draft.rootId).toLowerCase())
        refuse("DEFINITION_DEPENDENCY_CYCLE");
      graph.set(reference(release), release);
      const children = release.published.dependencyManifest.map((dependency) => {
        if (dependency.kind !== "module") return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
        return dependency;
      });
      edges.set(
        reference(release),
        children.map((child) => `${String(child.rootId).toLowerCase()}:${child.revision}`),
      );
      return children;
    });
    const missing = [
      ...new Map(
        dependencies
          .filter(
            (dependency) =>
              !graph.has(`${String(dependency.rootId).toLowerCase()}:${dependency.revision}`),
          )
          .map((dependency) => [
            `${String(dependency.rootId).toLowerCase()}:${dependency.revision}`,
            dependency,
          ]),
      ).values(),
    ];
    const children = await reader.readModuleReleases(
      candidate.draft.organizationId,
      missing.map((dependency) => ({
        rootId: dependency.rootId,
        releaseRevision: dependency.revision,
      })),
    );
    const found = new Map(
      missing.map((dependency, index) => [
        `${String(dependency.rootId).toLowerCase()}:${dependency.revision}`,
        children[index],
      ]),
    );
    for (const dependency of dependencies) {
      const key = `${String(dependency.rootId).toLowerCase()}:${dependency.revision}`;
      const child = graph.get(key) ?? found.get(key);
      if (
        child === undefined ||
        child.releaseVersion !== dependency.releaseVersion ||
        child.contentFingerprint !== dependency.contentFingerprint
      )
        return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      verifyModuleRelease(candidate, child.key, child);
    }
    frontier = children.filter((child): child is ResolvableModuleRelease => child !== undefined);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  for (const module of modules) {
    const stack = [{ key: reference(module), exiting: false }];
    while (stack.length > 0) {
      const entry = stack.pop()!;
      if (entry.exiting) {
        visiting.delete(entry.key);
        visited.add(entry.key);
        continue;
      }
      if (visiting.has(entry.key)) refuse("DEFINITION_DEPENDENCY_CYCLE");
      if (visited.has(entry.key)) continue;
      visiting.add(entry.key);
      stack.push({ key: entry.key, exiting: true });
      for (const child of [...(edges.get(entry.key) ?? [])].reverse())
        stack.push({ key: child, exiting: false });
    }
  }
};

/**
 * Pins each contained Application flow and protected Record or Query node, with the canonical
 * operation set resolved from that publication's exact definitions and dependencies. Platform
 * operations called by flows keep their own exact catalogue release entries.
 */
const protectedOperationReferenceLookups = (
  resolution: DefinitionResolution,
  dependencies: ResolvedDependencies,
): ProtectedOperationReferenceLookups => {
  const definitionsByKey = new Map<string, typeof resolution.definitions>();
  for (const definition of resolution.definitions)
    definitionsByKey.set(definition.key, [
      ...(definitionsByKey.get(definition.key) ?? []),
      definition,
    ]);

  const recordTypesById = new Map<string, ProtectedOperationReference>();
  const queriesById = new Map<string, ProtectedOperationReference>();
  const ownerReferenceFor = (
    definitionKey: string,
    operationId: string,
  ): ProtectedOperationReference => {
    const owners = (definitionsByKey.get(definitionKey) ?? []).filter(
      (definition) => definition.kind === "application" || definition.kind === "module",
    );
    if (owners.length !== 1) return refuse("DEFINITION_COMPILATION_REFUSED");
    const owner = owners[0]!;
    return protectedOperationReferenceSchema.parse({
      owner:
        owner.kind === "application"
          ? { kind: "application", applicationRootId: owner.rootId }
          : { kind: "module", moduleRootId: owner.rootId },
      operationId,
    });
  };
  for (const identity of resolution.identities) {
    if (identity.kind !== "record_type" && identity.kind !== "query") continue;
    const reference = ownerReferenceFor(identity.definitionKey, identity.identifier);
    const references = identity.kind === "record_type" ? recordTypesById : queriesById;
    const key = identity.identifier.toLowerCase();
    const prior = references.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(reference))
      return refuse("DEFINITION_COMPILATION_REFUSED");
    references.set(key, reference);
  }

  const relationshipRecordTypeIdsById = new Map<string, readonly string[]>();
  for (const release of dependencies.modules) {
    const moduleOutput = release.compilationOutput;
    if (moduleOutput.kind !== "module") return refuse("DEFINITION_COMPILATION_REFUSED");
    for (const recordType of moduleOutput.canonical.content.recordTypes)
      for (const relationship of recordType.relationships) {
        const targets = relationship.toRecordType
          ? [relationship.toRecordType]
          : (relationship.toRecordTypes ?? []);
        const resolvedTargets = targets.filter((target) => target.state === "resolved");
        const recordTypeIds =
          targets.length > 0 && resolvedTargets.length === targets.length
            ? [
                String(relationship.fromRecordTypeId),
                ...resolvedTargets.map((target) => String(target.recordTypeId)),
              ]
            : [];
        const key = String(relationship.relationshipId).toLowerCase();
        const prior = relationshipRecordTypeIdsById.get(key);
        if (
          prior !== undefined &&
          JSON.stringify([...prior].map((id) => id.toLowerCase()).sort(compareCanonicalStrings)) !==
            JSON.stringify(
              [...recordTypeIds].map((id) => id.toLowerCase()).sort(compareCanonicalStrings),
            )
        )
          return refuse("DEFINITION_COMPILATION_REFUSED");
        relationshipRecordTypeIdsById.set(key, recordTypeIds);
      }
  }

  return { recordTypesById, queriesById, relationshipRecordTypeIdsById };
};

const flowTargetManifestFor = (
  dependencies: ResolvedDependencies,
  output: Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>,
  resolution: DefinitionResolution,
): ExactDefinitionDependency[] => {
  if (output.kind !== "application") return [];
  const flows = output.canonical.content.flows as unknown as FlowDefinition[];
  const nodeReferences = flowOperationReferencesByNode(
    flows,
    protectedOperationReferenceLookups(resolution, dependencies),
  );
  const flowEntries: ExactDefinitionDependency[] = flows.map((flow) => ({
    kind: "application_flow" as const,
    applicationRootId: output.artifact.rootId,
    flowId: flow.id,
    releaseVersion: output.artifact.exactVersion,
    contentFingerprint: output.artifact.contentFingerprint,
    resolutionFingerprint: output.resolutionFingerprint,
  }));
  const flowNodeEntries: ExactDefinitionDependency[] = nodeReferences.map((node) => ({
    kind: "application_flow_node" as const,
    applicationRootId: output.artifact.rootId,
    flowId: node.flowId,
    nodeId: node.nodeId,
    operations: [...node.operations],
    grantable: node.operations.length > 0,
    releaseVersion: output.artifact.exactVersion,
    contentFingerprint: output.artifact.contentFingerprint,
    resolutionFingerprint: output.resolutionFingerprint,
  }));
  const platformOperationEntries: ExactDefinitionDependency[] = dependencies.platformOperations.map(
    (release) => ({
      kind: "protected_operation" as const,
      operation: {
        owner: { kind: "platform_service" as const, serviceId: release.serviceId },
        operationId: release.operationId,
      },
      releaseVersion: release.releaseVersion,
      contentFingerprint: release.contentFingerprint,
      resolutionFingerprint: output.resolutionFingerprint,
    }),
  );
  return [...flowEntries, ...flowNodeEntries, ...platformOperationEntries];
};

export const manifestFor = (
  dependencies: ResolvedDependencies,
  output: Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>,
  resolution: DefinitionResolution,
): ExactDefinitionDependency[] =>
  sortedManifest([
    ...dependencies.modules.map((release) => ({
      kind: "module" as const,
      key: release.key,
      rootId: release.rootId,
      releaseRevision: release.releaseRevision,
      releaseVersion: release.releaseVersion,
      contentFingerprint: release.contentFingerprint,
    })),
    ...dependencies.connections.map((release) => ({
      kind: "connection_type" as const,
      key: release.key,
      rootId: release.rootId,
      releaseVersion: release.releaseVersion,
      contentFingerprint: release.contentFingerprint,
    })),
    ...(dependencies.composition === undefined
      ? []
      : [
          ...dependencies.composition.platformBlocks.releases.map((release) => ({
            kind: "platform_block" as const,
            blockId: release.blockId,
            releaseVersion: release.releaseVersion,
            contentFingerprint: release.contentFingerprint,
          })),
          {
            kind: "platform_theme" as const,
            catalogueThemeId: dependencies.composition.platformTheme.catalogueThemeId,
            releaseVersion: dependencies.composition.platformTheme.releaseVersion,
            contentFingerprint: dependencies.composition.platformTheme.contentFingerprint,
          },
        ]),
    ...flowTargetManifestFor(dependencies, output, resolution),
  ]);

export const buildResolution = (
  candidate: DefinitionCandidateDraft,
  dependencies: ResolvedDependencies,
  ownVersion: string,
): DefinitionResolution => {
  const ownDefinition: DefinitionResolutionSnapshot["definitions"][number] =
    candidate.draft.kind === "module"
      ? {
          kind: "module",
          key: candidate.draft.key,
          rootId: candidate.draft.rootId,
          exactVersion: ownVersion,
        }
      : {
          kind: "application",
          key: candidate.draft.key,
          rootId: candidate.draft.rootId,
          exactVersion: ownVersion,
        };
  const definitions: DefinitionResolutionSnapshot["definitions"] = [
    ownDefinition,
    ...dependencies.modules.map((release) => ({
      kind: "module" as const,
      key: release.key,
      rootId: release.rootId,
      exactVersion: release.releaseVersion,
    })),
    ...dependencies.connections.map((release) => ({
      kind: "connection_type" as const,
      key: release.key,
      rootId: release.rootId,
      exactVersion: release.releaseVersion,
      operationKeys: release.compilationOutput.canonical.operations.map(
        (operation) => operation.key,
      ),
    })),
  ].sort((left, right) =>
    compareCanonicalStrings(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
  );
  const allIdentities = [
    ...candidate.identities,
    ...dependencies.modules.flatMap((release) =>
      release.resolutionSnapshot.identities.filter(
        (identity) => identity.definitionKey === release.key,
      ),
    ),
  ].sort((left, right) =>
    compareCanonicalStrings(
      JSON.stringify([
        left.definitionKey,
        left.scope,
        left.kind,
        left.componentOwner,
        left.alias,
        left.identifier,
      ]),
      JSON.stringify([
        right.definitionKey,
        right.scope,
        right.kind,
        right.componentOwner,
        right.alias,
        right.identifier,
      ]),
    ),
  );
  if (candidate.draft.source.kind === "module") {
    const evidence = { contractVersion: "4.0.0" as const, definitions, identities: allIdentities };
    return definitionResolutionSnapshotSchema.parse({
      ...evidence,
      fingerprint: fingerprintCanonicalValue(evidence),
    });
  }
  return createApplicationResolutionSnapshot({ definitions, identities: allIdentities });
};
