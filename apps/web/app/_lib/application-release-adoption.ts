import "server-only";

import {
  createBuilderAuthority,
  prepareApplicationRoleTemplatesForHumanRequest,
} from "@vortex/platform/server";
import {
  applicationInstallationActivationRequestSchema,
  createApplicationInstallationCoordinator,
  type HumanInstallationDefinitionAccess,
} from "@vortex/platform/server";
import type {
  ApplicationRootId,
  IdentitySession,
  OrganizationId,
  SystemApplicationBoundReleaseSetResult,
} from "@vortex/platform/schema";
import {
  createDatabaseApplicationReleaseAdoptionReleaseSetService,
  createDatabaseApplicationReleaseAdoptionTargetService,
  createPreparedInstallationRuntimeSourceReader,
  resolveModuleContributions,
  type ApplicationReleaseAdoptionTarget,
} from "@vortex/platform/server";
import {
  installedReleaseCatalogue,
  releaseSetContainsCustomComponents,
} from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { DefinitionError } from "@vortex/platform/server";
import { platformPermissionSource } from "./platform-permission-source";

/**
 * The deliberate release adoption of one installed application (#610). The offered target is the
 * application root's published-current release, read through the governed human read under the
 * caller's own application scope; the adoption itself is the #598 App installation coordinator. A
 * successful adoption changes the installation the next request resolves; a refusal, stale
 * revision or preparation failure leaves the previous active release exactly as it was.
 */

const requests = () => humanOrganizationRequests();

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
          installedReleaseCatalogue,
          transaction,
        ).read({
          applicationRootId: target.applicationRootId,
          applicationReleaseRevision: target.applicationReleaseRevision,
        }),
    );
    if (result.kind !== "available")
      throw new DefinitionError("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
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
    resolveModuleContributions,
    builderAuthority: (transaction, scope) =>
      createBuilderAuthority({
        transaction,
        scope,
        // The installation/upgrade requirements do not depend on the target being a system
        // application; an upgrade is never refused on that fact. Reading the fact is a separate
        // composition concern owned by the system-application work.
        targetFacts: async () => ({ isSystemApplication: false }),
        permissions: platformPermissionSource,
      }),
    // Derived from the exact release set, so a release that places a custom component also
    // requires `custom_code.manage` and a recent sign-in.
    containsCustomComponents: releaseSetContainsCustomComponents,
    humanDefinitionAccess: humanDefinitionAccess(),
    preparedRuntimeSource: createPreparedInstallationRuntimeSourceReader(
      installedReleaseCatalogue,
      [],
    ),
  });

/**
 * The published-current release offered for adoption, or undefined when the caller may not manage
 * installations, the application is not installed, or no target can be proven. The caller's
 * `applications.manage` decision is made first in the same request, so a person without it never
 * reaches the admin-only read; a refusal is indistinguishable from "nothing to adopt", so nothing
 * is disclosed. A temporary read failure is raised so callers can log its cause and offer retry.
 */
export const readApplicationReleaseAdoption = async (
  session: IdentitySession,
  scope: Readonly<{ organizationId: OrganizationId; applicationRootId: ApplicationRootId }>,
): Promise<ApplicationReleaseAdoptionTarget | undefined> => {
  const result = await requests().run(
    session,
    { organizationId: scope.organizationId, applicationRootId: scope.applicationRootId },
    async (transaction, requestScope) => {
      const authority = createBuilderAuthority({
        transaction,
        scope: requestScope,
        targetFacts: async () => ({ isSystemApplication: false }),
        permissions: platformPermissionSource,
      });
      const decision = await authority.require({
        kind: "installation",
        applicationRootId: scope.applicationRootId,
        change: "install_or_upgrade",
        containsCustomComponents: false,
        acceptedPermissions: [],
      });
      if (decision.outcome !== "allowed") return undefined;
      return createDatabaseApplicationReleaseAdoptionTargetService(transaction).read({
        applicationRootId: scope.applicationRootId,
      });
    },
  );
  if (result.kind !== "available") {
    if (result.kind === "temporarily_unavailable")
      throw new Error("APPLICATION_RELEASE_ADOPTION_TARGET_READ_FAILED", {
        cause: new Error(result.cause ?? "Human request temporarily unavailable", {
          cause: { code: result.databaseCode },
        }),
      });
    return undefined;
  }
  return result.value;
};

type AdoptApplicationReleaseRequest = Readonly<{
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
    throw new DefinitionError("APPLICATION_INSTALLATION_STALE");
  await coordinator().activate(session, activation);
};
