import {
  DEFAULT_PLATFORM_THEME_RELEASE_V2,
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
  PLATFORM_CONNECTION_TYPE_RELEASES,
  PLATFORM_BLOCK_RELEASES,
  platformIdSchema,
  type SessionContext,
  type StoredDefinitionSource,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  createDatabaseDefinitionPublicationService,
  createDefinitionStore,
  DefinitionStoreError,
  type ImmutableDefinitionPublicationCatalogueDefinition,
  type TrustedApplicationRootOriginKind,
} from "@vortex/definition";
import {
  crmApplication,
  crmModuleSources,
  hrModuleSources,
  iamApplication,
  iamModule,
  landingZoneApplication,
  landingZoneModuleSources,
  operationsApplication,
  operationsModuleSources,
  organisationAdministrationApplication,
  organisationAdministrationModule,
  serviceDeskApplication,
  serviceDeskModuleSources,
  systemDirectoryModule,
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
 * platform block release and the default platform theme, no custom component releases, and the
 * shipped platform connection types CRM and Service Desk bind.
 */
export const developmentPublicationCatalogue: ImmutableDefinitionPublicationCatalogueDefinition = {
  connectionTypeReleases: PLATFORM_CONNECTION_TYPE_RELEASES,
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

/**
 * Every module source available to the development setup. `modulesInDependencyOrder` publishes
 * only the modules reached through shipped application bindings and their dependencies. The
 * System Directory source is available for the administration bindings delivered by #1356;
 * until those bindings exist, the setup does not publish or install this module.
 */
const moduleSources = [
  iamModule,
  tenantAdministrationModule,
  organisationAdministrationModule,
  systemDirectoryModule,
  ...landingZoneModuleSources,
  ...crmModuleSources,
  ...serviceDeskModuleSources,
  ...operationsModuleSources,
  ...hrModuleSources,
] as readonly StoredDefinitionSource[];

type TrustedApplicationDescriptor = Readonly<{
  source: Extract<StoredDefinitionSource, { kind: "application" }>;
  applicationOriginKind: TrustedApplicationRootOriginKind;
}>;

const applicationDescriptors: readonly TrustedApplicationDescriptor[] = [
  { source: iamApplication, applicationOriginKind: "platform_system_application" },
  { source: tenantAdministrationApplication, applicationOriginKind: "platform_system_application" },
  {
    source: organisationAdministrationApplication,
    applicationOriginKind: "platform_system_application",
  },
  { source: operationsApplication, applicationOriginKind: "ordinary" },
  { source: crmApplication, applicationOriginKind: "ordinary" },
  { source: serviceDeskApplication, applicationOriginKind: "ordinary" },
  { source: landingZoneApplication, applicationOriginKind: "platform_system_application" },
];

const shippedApplicationDescriptor = (key: string): TrustedApplicationDescriptor => {
  const descriptor = applicationDescriptors.find((candidate) => candidate.source.key === key);
  if (descriptor === undefined || descriptor.source.kind !== "application")
    throw new Error(`Application ${key} is not a shipped application`);
  return descriptor;
};

/** The shipped application source for a manifest key, or a refusal for anything unshipped. */
export const shippedApplicationSource = (key: string): StoredDefinitionSource => {
  return shippedApplicationDescriptor(key).source;
};

const refuseRecordedApplicationRoot = (): never => {
  throw new Error(
    "Recorded Application root identity or provenance is unavailable or mismatched. Use a fresh disposable local database (pnpm db:reset) and run setup again; existing roots will not be relabelled.",
  );
};

const recordedRootId = (record: unknown) => {
  if (record === null || typeof record !== "object" || !("rootId" in record))
    return refuseRecordedApplicationRoot();
  const parsed = platformIdSchema.safeParse(record.rootId);
  if (!parsed.success) return refuseRecordedApplicationRoot();
  return parsed.data;
};

/** Both protected reads run in the same validated System transaction as the owning operation. */
const verifyApplicationRoot = async (
  transaction: RequestDatabaseTransaction,
  descriptor: TrustedApplicationDescriptor,
  rootId: string,
): Promise<void> => {
  const rows = await transaction.query<
    DatabaseRow & { outcome: unknown; application_origin_kind: unknown; definition_key: unknown }
  >`
    select classification.outcome, classification.application_origin_kind,
      vortex_definition.read_builder_application_root_key(${rootId}::uuid) as definition_key
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
      as classification
  `;
  if (
    rows.length !== 1 ||
    rows[0]!.outcome !== "available" ||
    rows[0]!.application_origin_kind !== descriptor.applicationOriginKind ||
    rows[0]!.definition_key !== descriptor.source.key
  )
    refuseRecordedApplicationRoot();
};

/** Verify only selected Applications, including interrupted upgrades, without changing setup state. */
export const verifyRecordedShippedApplicationRoots = async (
  facts: SystemContextFacts,
  applicationKeys: readonly string[],
  state: SetupState,
): Promise<void> => {
  const descriptors = applicationKeys.map(shippedApplicationDescriptor);
  await inSystemTransaction(mintSystemContext(facts), async (transaction) => {
    for (const descriptor of descriptors) {
      const release = state.releases[descriptor.source.key];
      const draft = state.drafts[descriptor.source.key];
      if (release !== undefined)
        await verifyApplicationRoot(transaction, descriptor, recordedRootId(release));
      if (draft !== undefined)
        await verifyApplicationRoot(transaction, descriptor, recordedRootId(draft));
    }
  });
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
 * already records for it. The created draft root is recorded before it is published, so an
 * interrupted run resumes at publication. A root that exists without any record is refused: the
 * setup never guesses which draft or release it belongs to.
 */
const publishOne = async (
  facts: SystemContextFacts,
  source: StoredDefinitionSource,
  state: SetupState,
  log: (message: string) => void,
  descriptor?: TrustedApplicationDescriptor,
): Promise<PublishedRelease> => {
  if (source.kind === "application" && (descriptor === undefined || descriptor.source !== source))
    throw new Error("Application publication requires its trusted shipped descriptor");
  const recorded = state.releases[source.key];
  if (recorded !== undefined) {
    if (descriptor !== undefined)
      await inSystemTransaction(mintSystemContext(facts), (transaction) =>
        verifyApplicationRoot(transaction, descriptor, recordedRootId(recorded)),
      );
    return recorded;
  }

  log(`publishing ${source.key}`);
  const authority = developmentBuilderAuthority(facts.organizationId);
  const context: SessionContext = mintSystemContext(facts);
  let draft = state.drafts[source.key];
  if (draft === undefined) {
    const created = await inSystemTransaction(context, async (transaction) => {
      const store = createDefinitionStore(transaction, authority);
      const creation =
        descriptor === undefined
          ? store.createRoot({ source })
          : store.createTrustedApplicationRoot({ source }, descriptor.applicationOriginKind);
      const created = await creation.catch((error: unknown) => {
        if (
          error instanceof DefinitionStoreError &&
          error.code === "DEFINITION_ROOT_ALREADY_EXISTS"
        )
          throw new Error(
            `${source.key} already exists in this organisation but the setup state does not record it. Reset the local database (pnpm db:reset) and run the setup again.`,
          );
        throw error;
      });
      if (descriptor !== undefined)
        await verifyApplicationRoot(transaction, descriptor, created.rootId);
      return created;
    });
    draft = { rootId: created.rootId, draftRevision: created.draftRevision };
    state.drafts[source.key] = draft;
    state.save();
  } else {
    // A resumed run authors the current shipped source over the unpublished draft.
    const saved = await inSystemTransaction(context, async (transaction) => {
      const rootId =
        descriptor === undefined ? platformIdSchema.parse(draft!.rootId) : recordedRootId(draft);
      if (descriptor !== undefined) await verifyApplicationRoot(transaction, descriptor, rootId);
      return createDefinitionStore(transaction, authority).saveDraft({
        rootId,
        expectedDraftRevision: draft!.draftRevision,
        source,
      });
    });
    draft = { rootId: saved.rootId, draftRevision: saved.draftRevision };
    state.drafts[source.key] = draft;
    state.save();
  }
  const { rootId, draftRevision } = draft;
  const prepared = await inSystemTransaction(context, async (transaction) => {
    if (descriptor !== undefined) await verifyApplicationRoot(transaction, descriptor, rootId);
    return createDatabaseDefinitionPublicationService(
      developmentPublicationCatalogue,
      transaction,
      authority,
    ).prepare(context, { rootId, expectedDraftRevision: draftRevision });
  });
  const published = await inSystemTransaction(context, async (transaction) => {
    if (descriptor !== undefined) await verifyApplicationRoot(transaction, descriptor, rootId);
    return createDatabaseDefinitionPublicationService(
      developmentPublicationCatalogue,
      transaction,
      authority,
    ).publish(context, {
      confirmation: prepared.confirmation,
      releaseNote: "Shipped release published by the local development setup",
    });
  });
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
  // Refuse every recorded selected Application before any Module or Application state changes.
  await verifyRecordedShippedApplicationRoots(facts, applicationKeys, state);
  const published = new Map<string, PublishedRelease>();
  for (const module of modulesInDependencyOrder(applicationKeys))
    published.set(module.key, await publishOne(facts, module, state, log));
  for (const key of applicationKeys) {
    const descriptor = shippedApplicationDescriptor(key);
    published.set(key, await publishOne(facts, descriptor.source, state, log, descriptor));
  }
  return published;
};
