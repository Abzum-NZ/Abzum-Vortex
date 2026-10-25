import {
  createHumanOrganizationRequestService,
  type PermissionRegistryDefinitionSetReader,
} from "@vortex/platform/server";
import {
  applicationInstallationActivationRequestSchema,
  applicationInstallationPreparationRequestSchema,
  createApplicationInstallationCoordinator,
  type ApplicationInstallationCoordinatorDependencies,
} from "@vortex/platform/server";
import {
  organizationSelectionCandidateSchema,
  sameId,
  type IdentityAuthorityId,
} from "@vortex/platform/schema";
import {
  createDatabaseSystemApplicationBoundReleaseSetService,
  createPreparedInstallationRuntimeSourceReader,
  resolveModuleContributions,
  readInstallationBindings,
  type TrustedApplicationRootOriginKind,
} from "@vortex/platform/server";
import { releaseSetContainsCustomComponents } from "../../app/_lib/definition-catalogue";
import { developmentPublicationCatalogue, publishShippedDefinitions } from "./definitions";
import {
  developmentBuilderAuthority,
  inSystemTransaction,
  mintSystemContext,
  nominatedOwnerSession,
  type SystemContextFacts,
} from "./development-authority";
import type { DevelopmentSetupManifest } from "./manifest";
import { initializeLifecycleLimits } from "./lifecycle";
import type { PublishedRelease, SetupState } from "./state";
import { DefinitionError } from "@vortex/platform/server";

/**
 * Installs the exact published application releases for the nominated steward through the
 * protected App installation coordinator. Local setup accepts and assigns the installed
 * application roles afterward through the same protected Access operations IAM uses.
 */

export type InstallFacts = Readonly<{
  identityAuthorityId: IdentityAuthorityId;
  system: SystemContextFacts;
  manifest: DevelopmentSetupManifest;
  stewardIdentityId: string;
  releases: ReadonlyMap<string, PublishedRelease>;
  state: SetupState;
}>;

const definitionReader = (_facts: InstallFacts): PermissionRegistryDefinitionSetReader => ({
  read: (context, command, purpose) =>
    inSystemTransaction(context, (transaction) =>
      createDatabaseSystemApplicationBoundReleaseSetService(
        developmentPublicationCatalogue,
        transaction,
      ).read(context, command, purpose),
    ),
});

const coordinatorDependencies = (
  facts: InstallFacts,
): ApplicationInstallationCoordinatorDependencies<never> => ({
  installerRequests: createHumanOrganizationRequestService({
    identityAuthorityId: facts.identityAuthorityId,
  }),
  definitionSystemContext: () => mintSystemContext(facts.system),
  definitionReader: definitionReader(facts),
  resolveModuleContributions,
  builderAuthority: (_transaction, scope) => developmentBuilderAuthority(scope.organizationId),
  containsCustomComponents: releaseSetContainsCustomComponents,
  preparedRuntimeSource: createPreparedInstallationRuntimeSourceReader(
    developmentPublicationCatalogue,
    [],
  ),
});

const release = (facts: InstallFacts, key: string): PublishedRelease => {
  const found = facts.releases.get(key);
  if (found === undefined) throw new Error(`No published release recorded for ${key}`);
  return found;
};

/**
 * Prepares one exact release and stores its source-bound runtime bundle. Activation gives every
 * record type its lifecycle policy. A release that is already active is left alone.
 */
const prepareRelease = async (
  facts: InstallFacts,
  applicationKey: string,
  log: (message: string) => void,
): Promise<void> => {
  const coordinator = createApplicationInstallationCoordinator(coordinatorDependencies(facts));
  const published = release(facts, applicationKey);
  const target = {
    organizationId: facts.system.organizationId,
    applicationRootId: published.rootId,
    applicationReleaseRevision: published.releaseRevision,
  };
  const prepared = await coordinator
    .prepare(
      nominatedOwnerSession(facts.stewardIdentityId),
      applicationInstallationPreparationRequestSchema.parse(target),
    )
    .catch((error: unknown) => {
      if (error instanceof DefinitionError && error.code === "APPLICATION_INSTALLATION_STALE")
        return undefined;
      throw error;
    });
  if (prepared !== undefined) log(`prepared ${applicationKey}: ${prepared.outcome}`);
};

/** Prepares and activates one exact release; a release that is already active is unchanged. */
const installOne = async (
  facts: InstallFacts,
  applicationKey: string,
  log: (message: string) => void,
): Promise<void> => {
  await prepareRelease(facts, applicationKey, log);
  const published = release(facts, applicationKey);
  const coordinator = createApplicationInstallationCoordinator(coordinatorDependencies(facts));
  const activation = await coordinator.activate(
    nominatedOwnerSession(facts.stewardIdentityId),
    applicationInstallationActivationRequestSchema.parse({
      organizationId: facts.system.organizationId,
      applicationRootId: published.rootId,
      applicationReleaseRevision: published.releaseRevision,
      expectedActiveReleaseRevision: null,
    }),
  );
  log(`installed ${applicationKey}: ${activation.outcome}`);
};

/**
 * Replaces only the observed active revision. System applications follow every shipped release;
 * an ordinary application keeps its administrator's choice while that release still verifies.
 */
export const upgradeOne = async (
  facts: InstallFacts,
  applicationKey: string,
  origin: TrustedApplicationRootOriginKind,
  log: (message: string) => void,
): Promise<void> => {
  const published = release(facts, applicationKey);
  let readFailure: unknown;
  const observed = await createHumanOrganizationRequestService({
    identityAuthorityId: facts.identityAuthorityId,
  }).runChange(
    nominatedOwnerSession(facts.stewardIdentityId),
    organizationSelectionCandidateSchema.parse({ organizationId: facts.system.organizationId }),
    async (transaction): Promise<number | null> => {
      try {
        const bindings = await readInstallationBindings(transaction, published.rootId);
        if (!sameId(bindings.organizationId, facts.system.organizationId))
          throw new Error(`Installation scope differs for ${applicationKey}`);
        const revisions = new Set(
          bindings.moduleBindings
            .filter((binding) => binding.state === "active")
            .map((binding) => binding.applicationReleaseRevision),
        );
        if (revisions.size > 1)
          throw new Error(`Active installation is mixed for ${applicationKey}`);
        return revisions.values().next().value ?? null;
      } catch (error) {
        readFailure = error;
        throw error;
      }
    },
  );
  if (observed.kind !== "available")
    throw new Error(
      `Active installation could not be read for ${applicationKey} (${observed.kind})`,
      {
        cause: readFailure ?? observed,
      },
    );
  const activeRevision = observed.value;
  if (activeRevision === null) {
    await installOne(facts, applicationKey, log);
    return;
  }
  if (activeRevision === published.releaseRevision) {
    log(`active ${applicationKey}: unchanged`);
    return;
  }
  if (activeRevision > published.releaseRevision)
    throw new Error(`Active release is newer than the publication for ${applicationKey}`);

  if (origin === "ordinary") {
    const context = mintSystemContext(facts.system);
    const superseded = await inSystemTransaction(context, (transaction) =>
      createDatabaseSystemApplicationBoundReleaseSetService(
        developmentPublicationCatalogue,
        transaction,
      ).read(context, {
        applicationRootId: published.rootId,
        applicationReleaseRevision: activeRevision,
      }),
    ).then(
      () => false,
      (error: unknown) => {
        if (error instanceof DefinitionError && error.code === "DEFINITION_DEPENDENCY_SUPERSEDED")
          return true;
        throw error;
      },
    );
    if (!superseded) {
      log(`available ${applicationKey} ${published.releaseVersion}: awaiting in-page adoption`);
      return;
    }
  }
  await prepareRelease(facts, applicationKey, log);
  const activation = await createApplicationInstallationCoordinator(
    coordinatorDependencies(facts),
  ).activate(
    nominatedOwnerSession(facts.stewardIdentityId),
    applicationInstallationActivationRequestSchema.parse({
      organizationId: facts.system.organizationId,
      applicationRootId: published.rootId,
      applicationReleaseRevision: published.releaseRevision,
      expectedActiveReleaseRevision: activeRevision,
    }),
  );
  log(`upgraded ${applicationKey}: ${activation.outcome}`);
};

/** The one local shipped-refresh operation, including first install and interrupted-run recovery. */
export const refreshShippedApplications = async (
  facts: Omit<InstallFacts, "releases">,
  log: (message: string) => void,
): Promise<InstallFacts["releases"]> => {
  // Existing organisations may have changed their lifecycle limits; a shipped refresh must not
  // reapply the initial policy. The first completed root proves initialization already committed.
  if (Object.keys(facts.state.releases).length === 0)
    await initializeLifecycleLimits(
      facts.system.organizationId,
      facts.manifest.initialLifecyclePolicy,
    );
  facts.state.setupCompleted = false;
  facts.state.save();
  const releases = await publishShippedDefinitions(
    facts.system,
    facts.manifest.applicationKeys,
    facts.state,
    log,
    (descriptor, published) =>
      upgradeOne(
        { ...facts, releases: new Map([[descriptor.source.key, published]]) },
        descriptor.source.key,
        descriptor.applicationOriginKind,
        log,
      ),
  );
  facts.state.setupCompleted = true;
  facts.state.save();
  return releases;
};
