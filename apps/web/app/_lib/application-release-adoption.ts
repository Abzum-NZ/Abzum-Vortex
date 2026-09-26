import "server-only";

import {
  createBuilderAuthority,
  createHumanOrganizationRequestService,
  prepareApplicationRoleTemplatesForHumanRequest,
} from "@vortex/access";
import {
  ApplicationInstallationCoordinatorError,
  applicationInstallationActivationRequestSchema,
  createApplicationInstallationCoordinator,
  createAppTelemetryCollector,
  createOperationsAlertSink,
  type HumanInstallationDefinitionAccess,
} from "@vortex/app";
import {
  type IdentitySession,
  type SystemApplicationBoundReleaseSetResult,
} from "@vortex/contracts";
import {
  createDatabaseApplicationReleaseAdoptionReleaseSetService,
  createDatabaseApplicationReleaseAdoptionTargetService,
  type ApplicationReleaseAdoptionTarget,
} from "@vortex/definition";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";

/**
 * The deliberate release adoption of one installed application (#610). The offered target is the
 * application root's published-current release, read through the governed human read under the
 * caller's own application scope; the adoption itself is the #598 App installation coordinator. A
 * successful adoption changes the installation the next request resolves; a refusal, stale
 * revision or preparation failure leaves the previous active release exactly as it was.
 */

/** The publication catalogue the installed release was published against (see the page loader). */
const definitionCatalogue = { connectionTypeReleases: [] } as const;

const telemetry = createAppTelemetryCollector({ downstream: createOperationsAlertSink() });

const requests = () =>
  createHumanOrganizationRequestService({
    identityAuthorityId: getIdentityAuthorityConfiguration().authorityId,
    telemetry,
  });

/**
 * The definition access the coordinator reads through when the deployment cannot mint a system
 * context: the exact release set is read under the installer's own human request, and the role
 * templates are prepared from that same human evidence.
 */
const humanDefinitionAccess = (): HumanInstallationDefinitionAccess => ({
  async readReleaseSet(
    session: IdentitySession,
    target,
  ): Promise<SystemApplicationBoundReleaseSetResult> {
    const result = await requests().run(
      session,
      { organizationId: target.organizationId, applicationRootId: target.applicationRootId },
      (transaction) =>
        createDatabaseApplicationReleaseAdoptionReleaseSetService(
          definitionCatalogue,
          transaction,
        ).read({
          applicationRootId: target.applicationRootId,
          applicationReleaseRevision: target.applicationReleaseRevision,
        }),
    );
    if (result.kind !== "available")
      throw new ApplicationInstallationCoordinatorError(
        "APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE",
      );
    return result.value;
  },
  async prepareRegistrationCandidate(target, releaseSet) {
    return prepareApplicationRoleTemplatesForHumanRequest(
      target.organizationId,
      {
        applicationRootId: target.applicationRootId,
        releaseRevision: target.applicationReleaseRevision,
      },
      releaseSet,
    );
  },
});

const coordinator = () =>
  createApplicationInstallationCoordinator({
    installerRequests: requests(),
    builderAuthority: (transaction, scope) =>
      createBuilderAuthority({
        transaction,
        scope,
        // The installation/upgrade requirements do not depend on the target being a system
        // application; an upgrade is never refused on that fact. Reading the fact is a separate
        // composition concern owned by the system-application work.
        targetFacts: async () => ({ isSystemApplication: false }),
      }),
    // This deployment's publication catalogue carries no custom component releases, so an
    // installable release set can contain none (the same catalogue seam as the page loader).
    containsCustomComponents: () => false,
    humanDefinitionAccess: humanDefinitionAccess(),
  });

/**
 * The published-current release offered for adoption, or undefined when the caller may not manage
 * installations, the application is not installed, or no target can be proven. A refusal is
 * indistinguishable from "nothing to adopt", so nothing is disclosed.
 */
export const readApplicationReleaseAdoption = async (
  session: IdentitySession,
  scope: Readonly<{ organizationId: string; applicationRootId: string }>,
): Promise<ApplicationReleaseAdoptionTarget | undefined> => {
  try {
    const result = await requests().run(
      session,
      { organizationId: scope.organizationId, applicationRootId: scope.applicationRootId },
      (transaction) =>
        createDatabaseApplicationReleaseAdoptionTargetService(transaction).read({
          applicationRootId: scope.applicationRootId,
        }),
    );
    return result.kind === "available" ? result.value : undefined;
  } catch {
    return undefined;
  }
};

export type AdoptApplicationReleaseRequest = Readonly<{
  organizationId: string;
  applicationRootId: string;
  applicationReleaseRevision: number;
  expectedActiveReleaseRevision: number;
}>;

/**
 * Deliberately upgrades the installation to the exact offered release, or refuses. The browser's
 * offered target is never trusted: the published-current release is re-read under the caller's
 * own permission-gated request and must be exactly the offered revision and strictly newer than
 * the loaded installation. The #598 coordinator then re-checks installation authority and refuses
 * as stale unless the active release is still exactly the one the page loaded.
 */
export const adoptApplicationRelease = async (
  session: IdentitySession,
  request: AdoptApplicationReleaseRequest,
): Promise<void> => {
  const activation = applicationInstallationActivationRequestSchema.parse(request);
  const target = await readApplicationReleaseAdoption(session, {
    organizationId: activation.organizationId,
    applicationRootId: activation.applicationRootId,
  });
  if (
    target === undefined ||
    target.organizationId.toLowerCase() !== activation.organizationId.toLowerCase() ||
    target.currentReleaseRevision !== activation.applicationReleaseRevision ||
    activation.expectedActiveReleaseRevision === null ||
    activation.applicationReleaseRevision <= activation.expectedActiveReleaseRevision
  )
    throw new ApplicationInstallationCoordinatorError("APPLICATION_INSTALLATION_STALE");
  await coordinator().activate(session, activation);
};
