import {
  DEFAULT_PLATFORM_THEME_RELEASE,
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE,
  PLATFORM_CONNECTION_TYPE_RELEASES,
  PLATFORM_BLOCK_RELEASES,
} from "@vortex/platform/server";
import {
  platformIdSchema,
  type SessionContext,
  type StoredDefinitionSource,
} from "@vortex/platform/schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/platform/server";
import {
  createDatabaseDefinitionPublicationService,
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
 * shipped platform connection types CRM and Service Desk bind.
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
 * Publishes one shipped Application as an initial release, or returns the release the state file
 * already records for it. Its inline Modules are released inside that one publication. The
 * created draft root is recorded before it is published, so an interrupted run resumes at
 * publication. A root that exists without any record is refused: the setup never guesses which
 * draft or release it belongs to.
 */
const publishOne = async (
  facts: SystemContextFacts,
  descriptor: TrustedApplicationDescriptor,
  state: SetupState,
  log: (message: string) => void,
): Promise<PublishedRelease> => {
  const source = descriptor.source;
  const recorded = state.releases[source.key];
  if (recorded !== undefined) {
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
    // A resumed run authors the current shipped source over the unpublished draft.
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
  });
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
  state.releases[source.key] = release;
  state.save();
  log(`published ${source.key} ${release.releaseVersion} (revision ${release.releaseRevision})`);
  return release;
};

/** Publishes each selected Application, owners of used Modules first. */
export const publishShippedDefinitions = async (
  facts: SystemContextFacts,
  applicationKeys: readonly string[],
  state: SetupState,
  log: (message: string) => void,
): Promise<ReadonlyMap<string, PublishedRelease>> => {
  // Refuse every recorded selected Application before any state changes.
  await verifyRecordedShippedApplicationRoots(facts, applicationKeys, state);
  const published = new Map<string, PublishedRelease>();
  for (const descriptor of applicationsInPublicationOrder(applicationKeys))
    published.set(descriptor.source.key, await publishOne(facts, descriptor, state, log));
  return published;
};
