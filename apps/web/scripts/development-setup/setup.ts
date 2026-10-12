import { randomUUID } from "node:crypto";
import { developmentSetupManifestFor } from "./manifest";
import {
  createHumanOrganizationRequestService,
  readCurrentOrganizationDefaultApplicationAfterAuthorization,
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
} from "@web/platform-server";
import {
  applicationRootIdSchema,
  organizationSelectionCandidateSchema,
  provisionTenantCommandSchema,
} from "@vortex/platform/schema";
import {
  DevelopmentSetupRefusal,
  parseSetupArguments,
  requireLocalDevelopmentEnvironment,
  resolveFirstOwnerIdentity,
} from "./guards";
import { createConfiguredTenantAdministrationService } from "@web/platform-server";
import { createDatabaseSystemApplicationBoundReleaseSetService } from "@web/platform-server";
import { createRecordSaveService } from "@web/platform-server";
import {
  developmentPublicationCatalogue,
  publishShippedDefinitions,
  verifyRecordedShippedApplicationRoots,
} from "./definitions";
import { installApplications, type InstallFacts } from "./install";
import { grantStewardDefinitionRole, grantStewardInstallerRole } from "./installer-access";
import { grantFirstOwnerApplicationRoles } from "./first-owner-application-roles";
import {
  inSystemTransaction,
  mintSystemContext,
  nominatedOwnerSession,
} from "./development-authority";
import { loadSetupState } from "./state";
import { seedDemoRecords } from "../demo-setup/seed-demo-records";
import { loadLocalWebEnvironment } from "../demo-setup/local-environment";

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
const organisationAdministrationApplicationKey = "vortex.app.organisation_administration";

const initializeLandingZoneDefault = async (
  facts: InstallFacts,
  applicationRootId: string,
): Promise<void> => {
  const { identityAuthorityId, stewardIdentityId, state } = facts;
  const { organizationId } = facts.system;
  const session = nominatedOwnerSession(stewardIdentityId);
  const requests = createHumanOrganizationRequestService({ identityAuthorityId });
  if (state.defaultApplicationInitializationCompleted) return;
  if (state.defaultApplicationInitializationAttempted) {
    state.defaultApplicationInitializationCompleted = true;
    state.save();
    log(
      "a prior Landing Zone default initialization was interrupted; the current default was preserved",
    );
    return;
  }

  const selection = organizationSelectionCandidateSchema.parse({ organizationId });
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
    const details =
      observed.kind === "temporarily_unavailable"
        ? `temporarily unavailable${observed.cause === undefined ? "" : `: ${observed.cause}`}`
        : observed.kind === "unavailable"
          ? "unavailable; see the access log for the refusal cause"
          : "the settings record was unavailable or changed during observation";
    log(`Landing Zone default initialization failed: ${details}`);
    throw new Error(`Landing Zone default initialization failed: ${details}`);
  }

  if (observed.value.defaultApplicationRootId !== null) {
    state.defaultApplicationInitializationCompleted = true;
    state.save();
    log("preserved the organisation's existing default application");
    return;
  }

  const defaultApplicationRootId = applicationRootIdSchema.parse(applicationRootId);
  const administrationRelease = facts.releases.get(organisationAdministrationApplicationKey);
  if (administrationRelease === undefined)
    throw new Error(
      `No published release recorded for ${organisationAdministrationApplicationKey}`,
    );
  const definitionContext = mintSystemContext(facts.system);
  const releaseSet = await inSystemTransaction(definitionContext, (transaction) =>
    createDatabaseSystemApplicationBoundReleaseSetService(
      developmentPublicationCatalogue,
      transaction,
    ).read(definitionContext, {
      applicationRootId: applicationRootIdSchema.parse(administrationRelease.rootId),
      applicationReleaseRevision: administrationRelease.releaseRevision,
    }),
  );
  const settingsRecordType = releaseSet.modules
    .find((module) => module.definitionKey === "vortex.organisation_administration")
    ?.content.recordTypes.find((recordType) => recordType.key === "organization_settings");
  const defaultApplicationField = settingsRecordType?.fields.find(
    (field) => field.key === "default_application_root_id",
  );
  if (
    settingsRecordType?.systemProjection?.protectedView !== "organization_runtime_settings" ||
    !settingsRecordType.standardActions.includes("update") ||
    defaultApplicationField === undefined
  )
    throw new Error("The installed Organisation Administration settings definition is unavailable");
  const saveSelection = organizationSelectionCandidateSchema.parse({
    organizationId,
    applicationRootId: administrationRelease.rootId,
  });
  // Fence reruns before the protected write. If the process stops after the write, a later
  // explicit clear must remain the user's choice; an interrupted attempt falls back to the launcher.
  state.defaultApplicationInitializationAttempted = true;
  state.save();

  const result = await createRecordSaveService({ identityAuthorityId }).save(
    session,
    saveSelection,
    {
      contractVersion: "2.0.0",
      commandId: randomUUID(),
      operation: "update",
      recordTypeId: settingsRecordType.recordTypeId,
      recordId: organizationId,
      expectedConcurrencyNumber: observed.value.revision,
      submittedValues: { [defaultApplicationField.fieldId]: defaultApplicationRootId },
    },
  );
  const savedDefaultApplicationRootId =
    result.kind === "available" && result.value.outcome === "saved"
      ? result.value.readableValues[defaultApplicationField.fieldId]
      : undefined;
  if (
    result.kind === "available" &&
    result.value.outcome === "saved" &&
    result.value.concurrencyNumber === observed.value.revision + 1 &&
    typeof savedDefaultApplicationRootId === "string" &&
    savedDefaultApplicationRootId.toLowerCase() === defaultApplicationRootId.toLowerCase()
  ) {
    state.defaultApplicationInitializationCompleted = true;
    state.save();
    log(
      `initialized the organisation default to Landing Zone at settings revision ${result.value.concurrencyNumber}`,
    );
  } else {
    if (
      result.kind === "unavailable" ||
      (result.kind === "available" && result.value.outcome !== "saved")
    ) {
      state.defaultApplicationInitializationAttempted = false;
      state.save();
    }
    const details =
      result.kind === "temporarily_unavailable"
        ? `temporarily unavailable${result.cause === undefined ? "" : `: ${result.cause}`}`
        : result.kind === "unavailable"
          ? "unavailable; see the access log for the refusal cause"
          : result.value.outcome === "refused"
            ? `refused (${result.value.error.code})`
            : result.value.outcome === "correction_required"
              ? `correction required (${result.value.corrections.map(({ code }) => code).join(", ")})`
              : `saved at revision ${result.value.concurrencyNumber} with default ${String(savedDefaultApplicationRootId)}`;
    log(
      `Landing Zone default initialization failed: ${details}; expected settings revision ${observed.value.revision + 1}`,
    );
    throw new Error(`Landing Zone default initialization failed: ${details}`);
  }
};

export const runDevelopmentSetup = async (
  argv: readonly string[],
): Promise<Readonly<{ organizationId: string; stewardIdentityId: string }>> => {
  loadLocalWebEnvironment();
  const args = parseSetupArguments(argv);
  const identityAuthorityId = requireLocalDevelopmentEnvironment(process.env);
  const manifest = developmentSetupManifestFor(args.tenantShortName, args.organizationShortName);
  const stewardIdentityId = await resolveFirstOwnerIdentity(args.firstOwner);
  log(`first owner identity ${stewardIdentityId}`);

  // 1. Provision the tenant and organisation with the nominated account as its steward.
  const tenantAdministration = createConfiguredTenantAdministrationService({
    environment: {
      VORTEX_CLUSTER_ID: manifest.operator.clusterId,
      VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID: manifest.operator.systemActorId,
    },
  });
  const provisioningCommand = provisionTenantCommandSchema.safeParse({
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
  });
  if (!provisioningCommand.success) {
    const issue = provisioningCommand.error.issues[0];
    throw new DevelopmentSetupRefusal(
      `Provisioning manifest ${issue?.path.join(".") || "command"}: ${issue?.message ?? "invalid value"}.`,
    );
  }
  const provisioned = await tenantAdministration.provisionTenant(provisioningCommand.data);
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
  const state = loadSetupState(provisioned.rootOrganizationId, {
    tenantId: provisioned.tenantId,
    tenantShortName: manifest.provisioning.tenant.shortName,
    organizationShortName: manifest.provisioning.rootOrganization.shortName,
    accessVersion: provisioned.accessVersion,
    systemActorId: manifest.definitionActorId,
    stewardIdentityId,
    stewardOrganizationAccountId: provisioned.organizationAccountId,
  });
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
    // Check existing roots before either completed reuse or marking an upgrade incomplete.
    await verifyRecordedShippedApplicationRoots(system, manifest.applicationKeys, state);
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
  await grantStewardDefinitionRole(
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
  const landingZoneRelease = releases.get(landingZoneApplicationKey);
  if (landingZoneRelease === undefined)
    throw new Error(`No published release recorded for ${landingZoneApplicationKey}`);
  await initializeLandingZoneDefault(installFacts(releases), landingZoneRelease.rootId);
  if (args.seedDemo)
    await seedDemoRecords({
      identityAuthorityId,
      system,
      stewardIdentityId,
      releases,
      tenantShortName: manifest.provisioning.tenant.shortName,
      organizationShortName: manifest.provisioning.rootOrganization.shortName,
    });
  log("done. Sign in with the nominated account and open the organisation.");
  return { organizationId: provisioned.rootOrganizationId, stewardIdentityId };
};

const main = async (): Promise<void> =>
  runDevelopmentSetup(process.argv.slice(2)).then(() => undefined);

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
