import {
  DEFAULT_PLATFORM_THEME_RELEASE,
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE,
  PLATFORM_CONNECTION_TYPE_RELEASES,
  PLATFORM_BLOCK_RELEASES,
  readBuilderApplicationOrigin,
} from "@vortex/platform/server";
import {
  platformIdSchema,
  sameId,
  type SessionContext,
  type StoredDefinitionSource,
} from "@vortex/platform/schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/platform/server";
import {
  createDatabaseDefinitionPublicationService,
  createDatabaseDefinitionPublicationRepository,
  createDefinitionStore,
  type ImmutableDefinitionPublicationCatalogueDefinition,
  type TrustedApplicationRootOriginKind,
} from "@vortex/platform/server";
import { shippedApplications } from "@vortex/definitions";
import {
  developmentBuilderAuthority,
  inSystemTransaction,
  mintSystemContext,
  type SystemContextFacts,
} from "./development-authority";
import type { PublishedRelease, SetupState } from "./state";
import { DefinitionError } from "@vortex/platform/server";
import { platformPermissionSource } from "../../app/_lib/platform-permission-source";

/**
 * Publishes the shipped Application definitions, with their inline Modules, into the target organisation through
 * the ordinary Definition store and publication service. Nothing is written to a table directly:
 * each release is a draft root, a prepared publication and a confirmed publication.
 */

/**
 * The platform release catalogue the shipped applications were authored against: every registered
 * platform block release and the default platform theme, no custom component releases, and the
 * platform connection types.
 */
export const developmentPublicationCatalogue: ImmutableDefinitionPublicationCatalogueDefinition = {
  permissions: platformPermissionSource,
  connectionTypeReleases: PLATFORM_CONNECTION_TYPE_RELEASES,
  applicationComposition: {
    compositionPolicy: IMMUTABLE_PLATFORM_BLOCK_CATALOGUE.compositionPolicy,
    platformBlockReleases: PLATFORM_BLOCK_RELEASES.map(
      ({ contentFingerprint, customComponent, ...definition }) => {
        void contentFingerprint;
        void customComponent;
        return definition;
      },
    ),
    platformThemeReleases: [
      (({ contentFingerprint, ...definition }) => {
        void contentFingerprint;
        return definition;
      })(DEFAULT_PLATFORM_THEME_RELEASE),
    ],
  },
};

type TrustedApplicationDescriptor = Readonly<{
  source: Extract<StoredDefinitionSource, { kind: "application" }>;
  applicationOriginKind: TrustedApplicationRootOriginKind;
}>;

const applicationDescriptors: readonly TrustedApplicationDescriptor[] = shippedApplications;

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
  const origin = await readBuilderApplicationOrigin(transaction, rootId);
  const rows = await transaction.query<DatabaseRow & { definition_key: unknown }>`
    select vortex_definition.read_builder_application_root_key(${rootId}::uuid) as definition_key
  `;
  if (
    origin !== descriptor.applicationOriginKind ||
    rows.length !== 1 ||
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
      if (
        release !== undefined &&
        draft !== undefined &&
        !sameId(recordedRootId(release), recordedRootId(draft))
      )
        refuseRecordedApplicationRoot();
      if (release !== undefined)
        await verifyApplicationRoot(transaction, descriptor, recordedRootId(release));
      if (draft !== undefined)
        await verifyApplicationRoot(transaction, descriptor, recordedRootId(draft));
    }
  });
};

/**
 * The selected Applications in publication order: an Application that uses another's Module is
 * published after the Application that owns it, so it pins that owner's current release.
 */
const applicationsInPublicationOrder = (
  applicationKeys: readonly string[],
): TrustedApplicationDescriptor[] => {
  const descriptors = applicationKeys.map(shippedApplicationDescriptor);
  const ownerOf = new Map(
    applicationDescriptors.flatMap((descriptor) =>
      descriptor.source.body.modules.map((module) => [module.key, descriptor.source.key] as const),
    ),
  );
  const ordered: TrustedApplicationDescriptor[] = [];
  const placed = new Set<string>();
  while (ordered.length < descriptors.length) {
    const next = descriptors.find(
      (descriptor) =>
        !placed.has(descriptor.source.key) &&
        descriptor.source.body.uses.every((use) => {
          const owner = ownerOf.get(use.module);
          if (owner === undefined || !applicationKeys.includes(owner))
            throw new Error(
              `${descriptor.source.key} uses ${use.module}, whose owning Application is not selected`,
            );
          return placed.has(owner);
        }),
    );
    if (next === undefined)
      throw new Error("Shipped Applications use each other's Modules in a cycle");
    placed.add(next.source.key);
    ordered.push(next);
  }
  return ordered;
};

/**
 * Authors the current shipped source on its recorded root and asks publication whether a release
 * is needed. Only prepare's DEFINITION_NO_CHANGE means current. The live publication anchor also
 * recovers a publication committed before an interrupted activation, without publishing it again.
 */
const publishOne = async (
  facts: SystemContextFacts,
  descriptor: TrustedApplicationDescriptor,
  state: SetupState,
  log: (message: string) => void,
): Promise<PublishedRelease> => {
  const source = descriptor.source;
  const recorded = state.releases[source.key];
  log(`refreshing ${source.key}`);
  const authority = developmentBuilderAuthority(facts.organizationId);
  const context: SessionContext = mintSystemContext(facts);
  let draft = state.drafts[source.key];
  const existingRoot = recorded ?? draft;
  if (existingRoot !== undefined) {
    const current = await inSystemTransaction(context, async (transaction) => {
      const rootId = recordedRootId(existingRoot);
      await verifyApplicationRoot(transaction, descriptor, rootId);
      return createDatabaseDefinitionPublicationRepository(transaction).read(context, (reader) =>
        reader.readDraftCandidate(rootId),
      );
    });
    if (current === undefined) throw new Error(`Shipped draft is missing for ${source.key}`);
    draft = { rootId: current.draft.rootId, draftRevision: current.draft.draftRevision };
  }
  if (draft === undefined) {
    const created = await inSystemTransaction(context, async (transaction) => {
      const store = createDefinitionStore(transaction, authority, platformPermissionSource);
      const created = await store
        .createTrustedApplicationRoot({ source }, descriptor.applicationOriginKind)
        .catch((error: unknown) => {
          if (error instanceof DefinitionError && error.code === "DEFINITION_ROOT_ALREADY_EXISTS")
            throw new Error(
              `${source.key} already exists in this organisation but the setup state does not record it. Reset the local database (pnpm db:reset) and run the setup again.`,
            );
          throw error;
        });
      await verifyApplicationRoot(transaction, descriptor, created.rootId);
      return created;
    });
    draft = { rootId: created.rootId, draftRevision: created.draftRevision };
    state.drafts[source.key] = draft;
    state.save();
  } else {
    // Save on the observed live revision; a concurrent edit or publication must refuse.
    const saved = await inSystemTransaction(context, async (transaction) => {
      const rootId = recordedRootId(draft);
      await verifyApplicationRoot(transaction, descriptor, rootId);
      return createDefinitionStore(transaction, authority, platformPermissionSource).saveDraft({
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
    await verifyApplicationRoot(transaction, descriptor, rootId);
    return createDatabaseDefinitionPublicationService(
      developmentPublicationCatalogue,
      transaction,
      authority,
    ).prepare(context, { rootId, expectedDraftRevision: draftRevision });
  }).catch(async (error: unknown) => {
    if (!(error instanceof DefinitionError) || error.code !== "DEFINITION_NO_CHANGE") throw error;
    const current = await inSystemTransaction(context, async (transaction) => {
      await verifyApplicationRoot(transaction, descriptor, rootId);
      return createDatabaseDefinitionPublicationRepository(transaction).read(context, (reader) =>
        reader.readCandidate(rootId),
      );
    });
    const latest = current?.historyEvidence.latestRelease;
    if (current?.draft.draftRevision !== draftRevision)
      throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
    if (latest === undefined || latest === null)
      throw new Error(`Publication reported no change without a release for ${source.key}`, {
        cause: error,
      });
    log(`current ${source.key}: DEFINITION_NO_CHANGE`);
    return {
      current: {
        rootId,
        releaseRevision: latest.publication.revision,
        releaseVersion: latest.publication.releaseVersion,
      },
    };
  });
  if ("current" in prepared) return prepared.current;
  const published = await inSystemTransaction(context, async (transaction) => {
    await verifyApplicationRoot(transaction, descriptor, rootId);
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
  log(`published ${source.key} ${release.releaseVersion} (revision ${release.releaseRevision})`);
  return release;
};

/** Refreshes and handles each root completely before the next root that uses its Modules. */
export const publishShippedDefinitions = async (
  facts: SystemContextFacts,
  applicationKeys: readonly string[],
  state: SetupState,
  log: (message: string) => void,
  handleRelease: (
    descriptor: TrustedApplicationDescriptor,
    release: PublishedRelease,
  ) => Promise<void>,
): Promise<ReadonlyMap<string, PublishedRelease>> => {
  // Refuse every recorded selected Application before any state changes.
  await verifyRecordedShippedApplicationRoots(facts, applicationKeys, state);
  const published = new Map<string, PublishedRelease>();
  for (const descriptor of applicationsInPublicationOrder(applicationKeys)) {
    const release = await publishOne(facts, descriptor, state, log);
    await handleRelease(descriptor, release);
    // A failed activation leaves the prior checkpoint intact. The root's live anchor recovers
    // the already-published release on the next run. A deliberate adoption offer is handled too.
    state.releases[descriptor.source.key] = release;
    state.save();
    published.set(descriptor.source.key, release);
  }
  return published;
};
