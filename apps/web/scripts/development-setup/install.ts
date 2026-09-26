import {
  createHumanOrganizationRequestService,
  type PermissionRegistryDefinitionSetReader,
} from "@vortex/access";
import {
  applicationInstallationActivationRequestSchema,
  ApplicationInstallationCoordinatorError,
  applicationInstallationPreparationRequestSchema,
  createApplicationInstallationCoordinator,
  type ApplicationInstallationCoordinatorDependencies,
} from "@vortex/app";
import {
  applicationRootIdSchema,
  type IdentityAuthorityId,
} from "@vortex/contracts";
import {
  createDatabaseSystemApplicationBoundReleaseSetService,
} from "@vortex/definition";
import { developmentPublicationCatalogue } from "./definitions";
import {
  developmentBuilderAuthority,
  inSystemTransaction,
  mintSystemContext,
  nominatedOwnerSession,
  type SystemContextFacts,
} from "./development-authority";
import type { DevelopmentSetupManifest } from "./manifest";
import { initializeLifecycleLimits, storeInitialLifecyclePolicies } from "./lifecycle";
import type { PublishedRelease, SetupState } from "./state";

/**
 * Installs the exact published application releases for the nominated steward through the
 * protected App installation coordinator. Application roles are granted separately through IAM.
 */

export type InstallFacts = Readonly<{
  identityAuthorityId: IdentityAuthorityId;
  system: SystemContextFacts;
  manifest: DevelopmentSetupManifest;
  stewardIdentityId: string;
  releases: ReadonlyMap<string, PublishedRelease>;
  state: SetupState;
}>;

const definitionReader = (facts: InstallFacts): PermissionRegistryDefinitionSetReader => ({
  read: (context, command) =>
    inSystemTransaction(context, (transaction) =>
      createDatabaseSystemApplicationBoundReleaseSetService(
        developmentPublicationCatalogue,
        transaction,
      ).read(context, command),
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
  builderAuthority: (_transaction, scope) => developmentBuilderAuthority(scope.organizationId),
  // The setup's own publication catalogue carries no custom component releases, so a shipped
  // release set can contain none.
  containsCustomComponents: () => false,
});

const release = (facts: InstallFacts, key: string): PublishedRelease => {
  const found = facts.releases.get(key);
  if (found === undefined) throw new Error(`No published release recorded for ${key}`);
  return found;
};

/**
 * Prepares one exact release and stores the initial record-type lifecycle policies the activation
 * gate requires. A release that is already active is left alone.
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
      if (
        error instanceof ApplicationInstallationCoordinatorError &&
        error.code === "APPLICATION_INSTALLATION_STALE"
      )
        return undefined;
      throw error;
    });
  if (prepared === undefined || facts.state.lifecyclePolicies[applicationKey] === true) return;
  const context = mintSystemContext(facts.system);
  const releaseSet = await definitionReader(facts).read(context, {
    applicationRootId: applicationRootIdSchema.parse(published.rootId),
    applicationReleaseRevision: published.releaseRevision,
  });
  const stored = await storeInitialLifecyclePolicies({
    identityAuthorityId: facts.identityAuthorityId,
    organizationId: facts.system.organizationId,
    stewardIdentityId: facts.stewardIdentityId,
    applicationRootId: published.rootId,
    releaseSet,
    bindings: prepared.moduleBindings,
    sharedPolicies: facts.state.sharedLifecyclePolicies,
    saveProgress: () => facts.state.save(),
  });
  facts.state.lifecyclePolicies[applicationKey] = true;
  facts.state.save();
  log(`prepared ${applicationKey} with ${stored} lifecycle policies`);
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
  await initializeLifecycleLimits(facts.system.organizationId);
  for (const key of facts.manifest.applicationKeys) await installOne(facts, key, log);
  facts.state.setupCompleted = true;
  facts.state.save();
};
