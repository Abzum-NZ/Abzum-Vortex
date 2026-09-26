import {
  DEFAULT_PLATFORM_THEME_RELEASE_V2,
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
  PLATFORM_BLOCK_RELEASES,
  type SessionContext,
  type StoredDefinitionSource,
} from "@vortex/contracts";
import {
  createDatabaseDefinitionPublicationService,
  createDefinitionStore,
  DefinitionStoreError,
  type ImmutableDefinitionPublicationCatalogueDefinition,
} from "@vortex/definition";
import {
  crmApplication,
  crmModuleSources,
  iamApplication,
  iamModule,
  operationsModuleSources,
  organisationAdministrationApplication,
  organisationAdministrationModule,
  serviceDeskApplication,
  serviceDeskModuleSources,
  tenantAdministrationApplication,
  tenantAdministrationModule,
} from "@vortex/modules";
import {
  developmentBuilderAuthority,
  inSystemTransaction,
  mintSystemContext,
  type SystemContextFacts,
} from "./development-authority";
import type { PublishedRelease, SetupState } from "./state";

/**
 * Publishes the shipped module and application definitions into the target organisation through
 * the ordinary Definition store and publication service. Nothing is written to a table directly:
 * each release is a draft root, a prepared publication and a confirmed publication.
 */

/**
 * The platform release catalogue the shipped applications were authored against: every registered
 * platform block release and the default platform theme, and no custom component releases.
 */
export const developmentPublicationCatalogue: ImmutableDefinitionPublicationCatalogueDefinition = {
  connectionTypeReleases: [],
  applicationCompositionV2: {
    compositionPolicy: IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2.compositionPolicy,
    platformBlockReleases: PLATFORM_BLOCK_RELEASES.map(
      ({ contentFingerprint, catalogueFingerprint, customComponent, ...definition }) => definition,
    ),
    platformThemeReleases: [
      (({ contentFingerprint, catalogueFingerprint, ...definition }) => definition)(
        DEFAULT_PLATFORM_THEME_RELEASE_V2,
      ),
    ],
  },
};

const moduleSources = [
  iamModule,
  tenantAdministrationModule,
  organisationAdministrationModule,
  ...crmModuleSources,
  ...serviceDeskModuleSources,
  ...operationsModuleSources,
] as readonly StoredDefinitionSource[];

const applicationSources = [
  iamApplication,
  tenantAdministrationApplication,
  organisationAdministrationApplication,
  crmApplication,
  serviceDeskApplication,
] as readonly StoredDefinitionSource[];

/** The shipped application source for a manifest key, or a refusal for anything unshipped. */
export const shippedApplicationSource = (key: string): StoredDefinitionSource => {
  const source = applicationSources.find((candidate) => candidate.key === key);
  if (source === undefined) throw new Error(`Application ${key} is not a shipped application`);
  return source;
};

type ModuleBody = Readonly<{ dependencies?: readonly Readonly<{ module: string }>[] }>;
type ApplicationBody = Readonly<{ module_bindings?: readonly Readonly<{ module: string }>[] }>;

/** The modules the named applications bind, and their module dependencies, in publish order. */
const modulesInDependencyOrder = (applicationKeys: readonly string[]): StoredDefinitionSource[] => {
  const byKey = new Map(moduleSources.map((source) => [source.key, source] as const));
  const needed = new Set<string>();
  const visit = (key: string): void => {
    if (needed.has(key)) return;
    const source = byKey.get(key);
    if (source === undefined) throw new Error(`Module ${key} is not a shipped module`);
    needed.add(key);
    for (const dependency of (source.body as ModuleBody).dependencies ?? [])
      visit(dependency.module);
  };
  for (const key of applicationKeys)
    for (const binding of (shippedApplicationSource(key).body as ApplicationBody).module_bindings ??
      [])
      visit(binding.module);
  const ordered: StoredDefinitionSource[] = [];
  const placed = new Set<string>();
  while (ordered.length < needed.size) {
    const next = [...needed].find(
      (key) =>
        !placed.has(key) &&
        ((byKey.get(key)!.body as ModuleBody).dependencies ?? []).every((dependency) =>
          placed.has(dependency.module),
        ),
    );
    if (next === undefined) throw new Error("Shipped module dependency cycle");
    placed.add(next);
    ordered.push(byKey.get(next)!);
  }
  return ordered;
};

/**
 * Publishes one definition source as an initial release, or returns the release the state file
 * already records for it. A root that exists without a record is refused: the setup never guesses
 * which release it belongs to.
 */
const publishOne = async (
  facts: SystemContextFacts,
  source: StoredDefinitionSource,
  state: SetupState,
  log: (message: string) => void,
): Promise<PublishedRelease> => {
  const recorded = state.releases[source.key];
  if (recorded !== undefined) return recorded;

  const authority = developmentBuilderAuthority(facts.organizationId);
  const context: SessionContext = mintSystemContext(facts);
  const draft = await inSystemTransaction(context, (transaction) =>
    createDefinitionStore(transaction, authority)
      .createRoot({ source })
      .catch((error: unknown) => {
        if (
          error instanceof DefinitionStoreError &&
          error.code === "DEFINITION_ROOT_ALREADY_EXISTS"
        )
          throw new Error(
            `${source.key} already exists in this organisation but the setup state does not record it. Reset the local database (pnpm db:reset) and run the setup again.`,
          );
        throw error;
      }),
  );
  const prepared = await inSystemTransaction(context, (transaction) =>
    createDatabaseDefinitionPublicationService(
      developmentPublicationCatalogue,
      transaction,
      authority,
    ).prepare(context, { rootId: draft.rootId, expectedDraftRevision: draft.draftRevision }),
  );
  const published = await inSystemTransaction(context, (transaction) =>
    createDatabaseDefinitionPublicationService(
      developmentPublicationCatalogue,
      transaction,
      authority,
    ).publish(context, {
      confirmation: prepared.confirmation,
      releaseNote: "Shipped release published by the local development setup",
    }),
  );
  const release: PublishedRelease = {
    rootId: published.rootId,
    releaseRevision: published.releaseRevision,
    releaseVersion: published.releaseVersion,
  };
  state.releases[source.key] = release;
  state.save();
  log(`published ${source.key} ${release.releaseVersion} (revision ${release.releaseRevision})`);
  return release;
};

/** Publishes every module the applications need, then each application. */
export const publishShippedDefinitions = async (
  facts: SystemContextFacts,
  applicationKeys: readonly string[],
  state: SetupState,
  log: (message: string) => void,
): Promise<ReadonlyMap<string, PublishedRelease>> => {
  const published = new Map<string, PublishedRelease>();
  for (const module of modulesInDependencyOrder(applicationKeys))
    published.set(module.key, await publishOne(facts, module, state, log));
  for (const key of applicationKeys)
    published.set(key, await publishOne(facts, shippedApplicationSource(key), state, log));
  return published;
};
