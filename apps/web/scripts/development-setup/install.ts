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
import type { IdentityAuthorityId } from "@vortex/platform/schema";
import {
  createDatabaseSystemApplicationBoundReleaseSetService,
  createPreparedInstallationRuntimeSourceReader,
  resolveModuleContributions,
} from "@vortex/platform/server";
import { releaseSetContainsCustomComponents } from "../../app/_lib/definition-catalogue";
import { developmentPublicationCatalogue } from "./definitions";
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

/** Installs every manifest application and records completion. */
export const installApplications = async (
  facts: InstallFacts,
  log: (message: string) => void,
): Promise<void> => {
  await initializeLifecycleLimits(
    facts.system.organizationId,
    facts.manifest.initialLifecyclePolicy,
  );
  for (const key of facts.manifest.applicationKeys) await installOne(facts, key, log);
  facts.state.setupCompleted = true;
  facts.state.save();
};
