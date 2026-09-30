import { developmentSetupManifest } from "./manifest";
import {
  createHumanOrganizationRequestService,
  createOrganizationRuntimeSettingsAdministrationService,
  readCurrentOrganizationDefaultApplicationAfterAuthorization,
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
} from "@vortex/access";
import {
  organizationSelectionCandidateSchema,
  provisionTenantCommandSchema,
} from "@vortex/contracts";
import {
  DevelopmentSetupRefusal,
  parseSetupArguments,
  requireLocalDevelopmentEnvironment,
  resolveFirstOwnerIdentity,
} from "./guards";
import { createConfiguredTenantAdministrationService } from "@vortex/identity";
import { publishShippedDefinitions } from "./definitions";
import { installApplications, type InstallFacts } from "./install";
import { grantStewardInstallerRole } from "./installer-access";
import { grantFirstOwnerApplicationRoles } from "./first-owner-application-roles";
import { nominatedOwnerSession } from "./development-authority";
import { loadSetupState } from "./state";

/**
 * The development-only setup provisions the disposable organisation, publishes and installs the
 * shipped applications through the protected entry points, and grants their application roles to
 * the nominated steward through the same protected Access operations used by IAM.
 * `pnpm setup:local` runs this command.
 *
 * An interrupted run resumes: provisioning replays by its fixed duplicate key and the steps already
 * recorded in the setup state are skipped. Once every step has completed, a re-run is a no-op. A
 * different nominated account is refused by provisioning.
 */

const log = (message: string): void => {
  process.stdout.write(`[setup] ${message}\n`);
};

const landingZoneApplicationKey = "vortex.app.landing_zone";

const initializeLandingZoneDefault = async (
  identityAuthorityId: ReturnType<typeof requireLocalDevelopmentEnvironment>,
  organizationId: string,
  stewardIdentityId: string,
  applicationRootId: string,
  state: ReturnType<typeof loadSetupState>,
): Promise<void> => {
  if (state.defaultApplicationInitializationCompleted) return;
  if (state.defaultApplicationInitializationAttempted) {
    state.defaultApplicationInitializationCompleted = true;
    state.save();
    log(
      "a prior Landing Zone default initialization was interrupted; the current default was preserved",
    );
    return;
  }

  const session = nominatedOwnerSession(stewardIdentityId);
  const selection = organizationSelectionCandidateSchema.parse({ organizationId });
  const requests = createHumanOrganizationRequestService({ identityAuthorityId });
  const observed = await requests.run(session, selection, async (transaction, scope) => {
    const before = await readCurrentOrganizationRuntimeSettingsAfterAuthorization(transaction);
    const defaultApplicationRootId =
      await readCurrentOrganizationDefaultApplicationAfterAuthorization(transaction);
    const after = await readCurrentOrganizationRuntimeSettingsAfterAuthorization(transaction);
    if (
      before === undefined ||
      after === undefined ||
      before.organizationId.toLowerCase() !== scope.organizationId.toLowerCase() ||
      after.organizationId.toLowerCase() !== scope.organizationId.toLowerCase() ||
      before.revision !== after.revision
    )
      return undefined;
    return { defaultApplicationRootId, revision: after.revision };
  });

  if (observed.kind !== "available" || observed.value === undefined) {
    state.defaultApplicationInitializationCompleted = true;
    state.save();
    log(
      "Landing Zone default state was unavailable or changed during observation; leaving it unchanged",
    );
    return;
  }

  if (observed.value.defaultApplicationRootId !== null) {
    state.defaultApplicationInitializationCompleted = true;
    state.save();
    log("preserved the organisation's existing default application");
    return;
  }

  // Fence reruns before the protected write. If the process stops after the write, a later
  // explicit clear must remain the user's choice; an interrupted attempt falls back to the launcher.
  state.defaultApplicationInitializationAttempted = true;
  state.save();

  const administration = createOrganizationRuntimeSettingsAdministrationService({
    identityAuthorityId,
  });
  const result = await administration.setDefaultApplication(session, selection, {
    expectedRevision: observed.value.revision,
    defaultApplicationRootId: applicationRootId,
  });
  state.defaultApplicationInitializationCompleted = true;
  state.save();
  if (
    result.kind === "available" &&
    result.value.defaultApplicationRootId?.toLowerCase() === applicationRootId.toLowerCase()
  ) {
    log(
      `initialized the organisation default to Landing Zone at settings revision ${result.value.revision}`,
    );
  } else {
    log(
      `Landing Zone default initialization was not confirmed (${result.kind}); no follow-up write will be made`,
    );
  }
};

const main = async (): Promise<void> => {
  const args = parseSetupArguments(process.argv.slice(2));
  const identityAuthorityId = requireLocalDevelopmentEnvironment(process.env);
  const manifest = developmentSetupManifest;
  const stewardIdentityId = await resolveFirstOwnerIdentity(args.firstOwner);
  log(`first owner identity ${stewardIdentityId}`);

  // 1. Provision the tenant and organisation with the nominated account as its steward.
  const tenantAdministration = createConfiguredTenantAdministrationService({
    environment: {
      VORTEX_CLUSTER_ID: manifest.operator.clusterId,
      VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID: manifest.operator.systemActorId,
    },
  });
  const provisioned = await tenantAdministration.provisionTenant(
    provisionTenantCommandSchema.parse({
      operation: "provision_tenant",
      duplicateKey: manifest.provisioning.duplicateKey,
      tenant: manifest.provisioning.tenant,
      rootOrganization: manifest.provisioning.rootOrganization,
      tenantSteward: { identityId: stewardIdentityId },
      organizationSteward: {
        identityId: stewardIdentityId,
        accountDisplayName: manifest.provisioning.accountDisplayName,
        accountLanguage: manifest.provisioning.language,
        accountTimeZone: manifest.provisioning.timeZone,
      },
      runtimeSettings: {
        language: manifest.provisioning.language,
        timeZone: manifest.provisioning.timeZone,
        currency: manifest.provisioning.currency,
        dateFormat: "medium",
        numberFormat: "auto",
      },
    }),
  );
  if (provisioned.outcome === "refused")
    throw new DevelopmentSetupRefusal(
      `Provisioning was refused (${provisioned.code}). If the organisation already exists for a different account, reset the local database (pnpm db:reset).`,
    );
  log(`organisation ${provisioned.rootOrganizationId} (${provisioned.outcome})`);

  // 2. Publish the shipped releases into the organisation.
  const system = {
    tenantId: provisioned.tenantId,
    organizationId: provisioned.rootOrganizationId,
    systemActorId: manifest.definitionActorId,
    accessVersion: provisioned.accessVersion,
  };
  const state = loadSetupState(provisioned.rootOrganizationId);
  const installFacts = (
    releases: InstallFacts["releases"],
    applicationKeys: readonly (typeof manifest.applicationKeys)[number][] = manifest.applicationKeys,
  ): InstallFacts => ({
    identityAuthorityId,
    system,
    manifest: { ...manifest, applicationKeys: [...applicationKeys] },
    stewardIdentityId,
    releases,
    state,
  });

  let releases: InstallFacts["releases"];
  if (state.setupCompleted) {
    const missingApplications = manifest.applicationKeys.filter(
      (key) => state.releases[key] === undefined,
    );
    if (missingApplications.length === 0) {
      log(
        `the applications were already installed for account ${provisioned.organizationAccountId}`,
      );
      releases = new Map(Object.entries(state.releases));
    } else {
      log(
        `publishing and installing newly configured applications: ${missingApplications.join(", ")}`,
      );
      // Mark an upgrade incomplete before recording new releases, so an interrupted installation
      // replays the protected coordinator on the next setup run.
      state.setupCompleted = false;
      state.save();
      releases = await publishShippedDefinitions(system, manifest.applicationKeys, state, log);
      await installApplications(installFacts(releases, missingApplications), log);
    }
  } else {
    releases = await publishShippedDefinitions(system, manifest.applicationKeys, state, log);

    // 3. The steward creates the application-installation role through Access, then installs the
    //    releases through the protected App installation coordinator.
    await grantStewardInstallerRole(
      {
        identityAuthorityId,
        organizationId: system.organizationId,
        stewardIdentityId,
        stewardOrganizationAccountId: provisioned.organizationAccountId,
        manifest,
        state,
      },
      log,
    );
    await installApplications(installFacts(releases), log);
  }

  // 4. Local development deliberately leaves the nominated first owner able to open the
  //    applications installed in this organisation, while all grants remain normal Access facts.
  await grantFirstOwnerApplicationRoles(
    {
      identityAuthorityId,
      organizationId: system.organizationId,
      stewardIdentityId,
      stewardOrganizationAccountId: provisioned.organizationAccountId,
      applicationKeys: manifest.applicationKeys,
      releases,
    },
    log,
  );
  const landingZoneRelease = releases.get(landingZoneApplicationKey);
  if (landingZoneRelease === undefined)
    throw new Error(`No published release recorded for ${landingZoneApplicationKey}`);
  await initializeLandingZoneDefault(
    identityAuthorityId,
    system.organizationId,
    stewardIdentityId,
    landingZoneRelease.rootId,
    state,
  );
  log("done. Sign in with the nominated account and open the organisation.");
};

main().catch((error: unknown) => {
  if (error instanceof DevelopmentSetupRefusal) process.stderr.write(`[setup] ${error.message}\n`);
  else {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    process.stderr.write(
      `[setup] failed${code === undefined ? "" : ` (${code})`}: ${error instanceof Error ? error.message : "unexpected error"}\n`,
    );
    if (process.env.VORTEX_SETUP_DEBUG === "1") console.error(error);
  }
  process.exitCode = 1;
});
