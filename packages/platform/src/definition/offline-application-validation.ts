import "server-only";

import { compare } from "semver";
import {
  applicationCompilationRequestSchema,
  applicationSourceDocumentSchema,
  definitionCompilationOutputSchema,
  type ApplicationCompositionCatalogueSnapshot,
  type ApplicationSourceDocument,
  type DefinitionCompilationOutput,
  type StoredDefinitionSource,
} from "../schema";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import { applicationModuleKeys } from "./application-module-sources";
import { applicationModuleSources } from "./application-module-lowering";
import { createApplicationResolutionSnapshot } from "./application-resolution";
import { applicationSourceContractVersion } from "./application-contract-versions";
import { compareCanonicalStrings } from "./canonical-json-definition";
import { compileParsedDefinition } from "./compiler";
import { compatibleVersion } from "./compiler/resolution";
import { DefinitionCompilationError } from "./compilation-error";
import {
  compileModulesOffline,
  historyDependentCodes,
  renderLocation,
  syntheticActor,
  syntheticId,
  syntheticVersion,
  unexpected,
  type CompiledModule,
  type Identity,
  type OfflineSourceFailure,
  type ResolvedDefinition,
} from "./offline-source-validation";
import type { ImmutableDefinitionPublicationCatalogue } from "./publication/read";
import { extractApplicationSourceIdentityRequirements } from "./source-identities";
import { validateDefinitionSet } from "./validation";

type ConnectionRelease = Awaited<
  ReturnType<ImmutableDefinitionPublicationCatalogue["listConnectionTypeReleases"]>
>[number];

const resolutionFailure = (
  definitionKey: string,
  code: string,
  location: string,
  detail: string,
): OfflineSourceFailure => ({ definitionKey, stage: "resolution", code, location, detail });

/** The highest catalogue release of a connection type that satisfies the binding's requirement. */
const chooseConnectionRelease = (
  releases: readonly ConnectionRelease[],
  requirement: ApplicationSourceDocument["body"]["connection_bindings"][number]["version"],
): ConnectionRelease | undefined =>
  releases
    .filter((release) => compatibleVersion(requirement, release.releaseVersion))
    .sort((left, right) => compare(right.releaseVersion, left.releaseVersion))[0];

/**
 * Reads the platform block and theme releases the Application selects from the immutable
 * catalogue, the way publication does, and names each selection the catalogue does not hold.
 */
const readCompositionSnapshot = async (
  source: ApplicationSourceDocument,
  modules: readonly ResolvedDefinition[],
  catalogue: ImmutableDefinitionPublicationCatalogue,
  failures: OfflineSourceFailure[],
): Promise<ApplicationCompositionCatalogueSnapshot | undefined> => {
  const { platform_block_dependencies: blocks, theme } = source.body;
  const missing: string[] = [];
  for (const block of blocks)
    if (
      (await catalogue.readPlatformBlockRelease(block.block_id, block.release_version)) ===
      undefined
    )
      missing.push(`platform block ${block.block_id}@${block.release_version}`);
  const base = theme.base;
  if (
    (await catalogue.readPlatformThemeRelease(base.catalogue_theme_id, base.release_version)) ===
    undefined
  )
    missing.push(`platform theme ${base.catalogue_theme_id}@${base.release_version}`);
  if (missing.length > 0) {
    failures.push(
      resolutionFailure(
        source.key,
        "offline_catalogue_release_missing",
        "platform_block_dependencies",
        `the platform catalogue holds no ${missing.join(", ")}`,
      ),
    );
    return undefined;
  }
  try {
    const snapshot = await catalogue.readApplicationCompositionCatalogueSnapshot({
      platformBlocks: blocks.map((block) => ({
        blockId: block.block_id,
        releaseVersion: block.release_version,
      })),
      platformTheme: {
        catalogueThemeId: base.catalogue_theme_id,
        releaseVersion: base.release_version,
      },
      customComponentPlacement: {
        applicationKey: source.key,
        boundModuleReleases: modules.map((module) => ({
          moduleKey: module.key,
          releaseVersion: module.exactVersion,
        })),
      },
    });
    if (snapshot !== undefined) return snapshot;
    failures.push(
      resolutionFailure(
        source.key,
        "offline_catalogue_snapshot_unavailable",
        "(source)",
        "the platform catalogue returned no composition snapshot",
      ),
    );
  } catch (error) {
    failures.push(unexpected(source.key, "compile", error));
  }
  return undefined;
};

/**
 * Compiles one Application the way publication does, against the Modules compiled offline, the
 * platform catalogue snapshot and the catalogue's connection releases, with identities derived from
 * the source instead of read from the database. Reports every failure it can locate.
 */
const compileApplication = async (
  source: ApplicationSourceDocument,
  compiled: ReadonlyMap<string, CompiledModule>,
  catalogue: ImmutableDefinitionPublicationCatalogue,
  permissions: PlatformPermissionSource,
): Promise<OfflineSourceFailure[]> => {
  const failures: OfflineSourceFailure[] = [];
  const modules: (CompiledModule & { key: string; own: ResolvedDefinition })[] = [];
  const moduleKeys = applicationModuleKeys(source);
  for (const key of moduleKeys) {
    const module = compiled.get(key);
    if (module === undefined)
      failures.push(
        resolutionFailure(
          source.key,
          "offline_dependency_not_compiled",
          `modules > ${key}`,
          `builds on Module ${key}, which is not shipped or failed to compile above`,
        ),
      );
    else modules.push({ ...module, key, own: module.definitions.find((d) => d.key === key)! });
  }
  const connections: ConnectionRelease[] = [];
  for (const binding of source.body.connection_bindings) {
    const release = chooseConnectionRelease(
      await catalogue.listConnectionTypeReleases(binding.connection_type),
      binding.version,
    );
    if (release === undefined)
      failures.push(
        resolutionFailure(
          source.key,
          "offline_connection_type_unavailable",
          `connection_bindings > ${binding.connection_type}`,
          `the platform catalogue holds no release of ${binding.connection_type} satisfying ${JSON.stringify(binding.version)}`,
        ),
      );
    else connections.push(release);
  }
  if (failures.length > 0) return failures;

  const definitions: ResolvedDefinition[] = [
    {
      kind: "application",
      key: source.key,
      rootId: syntheticId(source.key, "root") as never,
      exactVersion: syntheticVersion,
    },
    ...modules.map((module) => module.own),
    ...connections.map((release): ResolvedDefinition => ({
      kind: "connection_type",
      key: release.key,
      rootId: release.rootId,
      exactVersion: release.releaseVersion,
      operationKeys: release.compilationOutput.canonical.operations.map(
        (operation) => operation.key,
      ),
    })),
  ];
  const own = extractApplicationSourceIdentityRequirements(source).flatMap((requirement) =>
    requirement.aliases.map((alias): Identity => ({
      definitionKey: requirement.definitionKey,
      scope: requirement.scope,
      kind: requirement.kind,
      componentOwner: requirement.componentOwner,
      alias,
      identifier: syntheticId(
        requirement.definitionKey,
        requirement.scope,
        requirement.kind,
        requirement.componentOwner,
      ) as Identity["identifier"],
    })),
  );
  const identities = [
    ...own,
    ...modules.flatMap((module) =>
      module.identities.filter((identity) => identity.definitionKey === module.key),
    ),
  ];
  const snapshot = await readCompositionSnapshot(
    source,
    modules.map((module) => module.own),
    catalogue,
    failures,
  );
  if (snapshot === undefined) return failures;

  const dependencyOutputs: DefinitionCompilationOutput[] = [
    ...modules.map((module) => module.output),
    ...connections.map((release) => release.compilationOutput),
  ].map((output) => definitionCompilationOutputSchema.parse(output));
  const parsedRequest = applicationCompilationRequestSchema.safeParse({
    sourceContractVersion: applicationSourceContractVersion,
    validationContractVersion: "2.0.0",
    source,
    resolution: createApplicationResolutionSnapshot({
      definitions: definitions.sort((left, right) =>
        compareCanonicalStrings(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
      ),
      identities,
    }),
    catalogueSnapshot: snapshot,
    draftMetadata: {
      organizationId: syntheticId("organisation"),
      draftRevision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: syntheticActor,
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: syntheticActor,
    },
  });
  if (!parsedRequest.success) return [unexpected(source.key, "compile", parsedRequest.error)];
  const request = parsedRequest.data;
  let output;
  try {
    output = compileParsedDefinition(request, dependencyOutputs, permissions);
  } catch (error) {
    if (error instanceof DefinitionCompilationError)
      return [
        {
          definitionKey: source.key,
          stage: "compile",
          code: error.ruleCode,
          location: renderLocation(error.location),
          detail: error.family,
        },
      ];
    return [unexpected(source.key, "compile", error)];
  }
  const validation = validateDefinitionSet({
    permissions,
    requests: [request],
    outputs: [output],
    dependencyOutputs,
    publishedHistories: [],
  });
  return validation.failures
    .filter((failure) => !historyDependentCodes.has(failure.ruleCode))
    .map((failure) => ({
      definitionKey: source.key,
      stage: "validation" as const,
      code: failure.ruleCode,
      location: renderLocation(failure.location),
      detail: failure.family,
    }));
};

/**
 * Runs the publication checks that need no database over shipped Application sources and reports
 * every failure, not the first: the source schema, Module ownership and use, the compile of each
 * inline Module against its siblings and the Modules its Application uses, the Application compile
 * against those Modules, the platform block and theme catalogue and its connection releases, and
 * the publish-stage rules for pages, navigation, layout, theme, bindings and permissions.
 */
export const validateApplicationsOffline = async (
  sources: readonly StoredDefinitionSource[],
  catalogue: ImmutableDefinitionPublicationCatalogue,
  permissions: PlatformPermissionSource,
): Promise<{ failures: OfflineSourceFailure[]; moduleCount: number }> => {
  const failures: OfflineSourceFailure[] = [];
  const applications: ApplicationSourceDocument[] = [];
  for (const source of sources) {
    if (source.kind !== "application") continue;
    const parsed = applicationSourceDocumentSchema.safeParse(source);
    if (!parsed.success) failures.push(unexpected(source.key, "source_schema", parsed.error));
    else applications.push(parsed.data);
  }
  const moduleSources = applications.flatMap((application) => {
    try {
      return applicationModuleSources(application);
    } catch (error) {
      failures.push(unexpected(application.key, "source_schema", error));
      return [];
    }
  });
  const modules = compileModulesOffline(moduleSources, permissions);
  failures.push(...modules.failures);
  for (const application of applications)
    try {
      failures.push(
        ...(await compileApplication(application, modules.compiled, catalogue, permissions)),
      );
    } catch (error) {
      failures.push(unexpected(application.key, "compile", error));
    }
  return { failures, moduleCount: moduleSources.length };
};
