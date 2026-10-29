import { randomUUID } from "node:crypto";
import { developmentSetupManifestFor } from "./manifest";
import { signupPrivacyNoticeSetting } from "@vortex/definitions";
import {
  createHumanOrganizationRequestService,
  readPrivacyNotice,
  readCurrentOrganizationDefaultApplicationAfterAuthorization,
  readCurrentOrganizationAppStoreAddressAfterAuthorization,
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
} from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  identityIdSchema,
  organizationSelectionCandidateSchema,
  provisionTenantCommandSchema,
} from "@vortex/platform/schema";
import {
  DevelopmentSetupRefusal,
  parseSetupArguments,
  requireLocalDevelopmentEnvironment,
  resolveFirstOwnerIdentity,
} from "./guards";
import { createConfiguredTenantAdministrationService } from "@vortex/platform/server";
import { createDatabaseSystemApplicationBoundReleaseSetService } from "@vortex/platform/server";
import { createRecordSaveService } from "@vortex/platform/server";
import {
  developmentPublicationCatalogue,
  verifyRecordedShippedApplicationRoots,
} from "./definitions";
import { refreshShippedApplications, type InstallFacts } from "./install";
import { grantStewardDefinitionRole, grantStewardInstallerRole } from "./installer-access";
import { grantFirstOwnerApplicationRoles } from "./first-owner-application-roles";
import {
  inSystemTransaction,
  mintSystemContext,
  nominatedOwnerSession,
} from "./development-authority";
import { loadSetupState } from "./state";
import { loadLocalWebEnvironment } from "../demo-setup/local-environment";
import { createInProcessEventDispatcher } from "../../app/_lib/event-dispatch";

/**
 * The development-only setup provisions the disposable organisation, publishes and installs the
 * shipped applications through the protected entry points, and grants their application roles to
 * the nominated steward through the same protected Access operations used by IAM.
 * `pnpm setup:local` runs this command.
 *
 * An interrupted run resumes through the protected live draft and publication anchors. Every run
 * refreshes shipped sources; publication alone decides whether a new release is needed. A different
 * nominated account is refused by provisioning.
 */

const log = (message: string): void => {
  process.stdout.write(`[setup] ${message}\n`);
};

const landingZoneApplicationKey = "vortex.app.landing_zone";
const organisationAdministrationApplicationKey = "vortex.app.organisation_administration";

/** The installed Organisation Administration settings record type, the one writer of organisation settings. */
const readInstalledOrganizationSettings = async (facts: InstallFacts) => {
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
  if (
    settingsRecordType?.systemProjection?.protectedView !== "organization_runtime_settings" ||
    !settingsRecordType.standardActions.includes("update")
  )
    throw new Error("The installed Organisation Administration settings definition is unavailable");
  return { administrationRootId: administrationRelease.rootId, settingsRecordType };
};

const initializeLandingZoneDefault = async (
  facts: InstallFacts,
  applicationRootId: string,
): Promise<void> => {
  const { identityAuthorityId, stewardIdentityId, state } = facts;
  const { organizationId } = facts.system;
  const session = nominatedOwnerSession(stewardIdentityId);
  const requests = createHumanOrganizationRequestService({ identityAuthorityId });
  if (state.defaultApplicationInitializationCompleted) return;
  const defaultApplicationRootId = applicationRootIdSchema.parse(applicationRootId);

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

  if (state.defaultApplicationInitializationAttempted) {
    const attemptRevision = state.defaultApplicationInitializationAttemptRevision;
    if (attemptRevision === null)
      throw new Error(
        "Development setup state has inconsistent default initialization metadata. Run `pnpm demo:setup` to reset the local database, or delete `supabase/.temp/development-setup-state.json`.",
      );
    const writeWasObserved =
      observed.value.revision === attemptRevision + 1 &&
      observed.value.defaultApplicationRootId?.toLowerCase() ===
        defaultApplicationRootId.toLowerCase();
    if (writeWasObserved) {
      state.defaultApplicationInitializationCompleted = true;
      state.save();
      log(
        `reconciled the prior Landing Zone default write at settings revision ${observed.value.revision}`,
      );
      return;
    }
    const writeDidNotOccur =
      observed.value.revision === attemptRevision &&
      observed.value.defaultApplicationRootId === null;
    if (!writeDidNotOccur) {
      state.defaultApplicationInitializationCompleted = true;
      state.save();
      log(
        "a prior default initialization changed organisation settings; the current default was preserved",
      );
      return;
    }
    log(`the prior default write did not change settings revision ${attemptRevision}; retrying it`);
  }

  if (observed.value.defaultApplicationRootId !== null) {
    state.defaultApplicationInitializationCompleted = true;
    state.save();
    log("preserved the organisation's existing default application");
    return;
  }

  const { administrationRootId, settingsRecordType } =
    await readInstalledOrganizationSettings(facts);
  const defaultApplicationField = settingsRecordType?.fields.find(
    (field) => field.key === "default_application_root_id",
  );
  if (defaultApplicationField === undefined)
    throw new Error("The installed Organisation Administration settings definition is unavailable");
  const saveSelection = organizationSelectionCandidateSchema.parse({
    organizationId,
    applicationRootId: administrationRootId,
  });
  // Persist the observed revision before the protected write so a rerun can reconcile the outcome.
  state.defaultApplicationInitializationAttempted = true;
  state.defaultApplicationInitializationAttemptRevision = observed.value.revision;
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

const initializeAppStoreAddress = async (facts: InstallFacts): Promise<void> => {
  const { identityAuthorityId, stewardIdentityId } = facts;
  const { organizationId } = facts.system;
  const appStoreAddress = "vortex.app.app_store";
  const session = nominatedOwnerSession(stewardIdentityId);
  const selection = organizationSelectionCandidateSchema.parse({ organizationId });
  const requests = createHumanOrganizationRequestService({ identityAuthorityId });
  const observed = await requests.run(session, selection, (transaction) =>
    readCurrentOrganizationRuntimeSettingsAfterAuthorization(transaction).then(async (settings) => {
      if (settings === undefined) return undefined;
      return {
        revision: settings.revision,
        appStoreAddress:
          await readCurrentOrganizationAppStoreAddressAfterAuthorization(transaction),
      };
    }),
  );
  if (observed.kind !== "available" || observed.value === undefined)
    throw new Error("The organisation App Store address could not be read from its settings");
  if (observed.value.appStoreAddress !== null) {
    log("preserved the organisation's configured App Store address");
    return;
  }

  const { administrationRootId, settingsRecordType } =
    await readInstalledOrganizationSettings(facts);
  const appStoreAddressField = settingsRecordType?.fields.find(
    (field) => field.key === "app_store_address",
  );
  if (appStoreAddressField === undefined)
    throw new Error("The installed Organisation Administration App Store setting is unavailable");
  const administrationSelection = organizationSelectionCandidateSchema.parse({
    organizationId,
    applicationRootId: administrationRootId,
  });

  const saved = await createRecordSaveService({ identityAuthorityId }).save(
    session,
    administrationSelection,
    {
      contractVersion: "2.0.0",
      commandId: randomUUID(),
      operation: "update",
      recordTypeId: settingsRecordType.recordTypeId,
      recordId: organizationId,
      expectedConcurrencyNumber: observed.value.revision,
      submittedValues: { [appStoreAddressField.fieldId]: appStoreAddress },
    },
  );
  if (
    saved.kind !== "available" ||
    saved.value.outcome !== "saved" ||
    saved.value.concurrencyNumber !== observed.value.revision + 1 ||
    saved.value.readableValues[appStoreAddressField.fieldId] !== appStoreAddress
  )
    throw new Error("The organisation App Store address could not be saved through its settings");
  log(
    `initialized the organisation App Store address at settings revision ${saved.value.concurrencyNumber}`,
  );
};

/**
 * Signup shows the latest published privacy notice, so a provisioned platform publishes the shipped
 * one. The first owner becomes the local platform's first super-administrator (an operator
 * bootstrap that replays) and the operator publishes the notice in their name.
 */
const publishShippedPrivacyNotice = async (
  tenantAdministration: ReturnType<typeof createConfiguredTenantAdministrationService>,
  manifest: ReturnType<typeof developmentSetupManifestFor>,
  stewardIdentityId: string,
): Promise<void> => {
  const current = await readPrivacyNotice();
  if (current?.versionLabel === signupPrivacyNoticeSetting.versionLabel) return;
  const bootstrap = await tenantAdministration.bootstrapVortexSuperAdministrator({
    operation: "bootstrap_vortex_super_administrator",
    duplicateKey: manifest.superAdministratorDuplicateKey,
    identityId: identityIdSchema.parse(stewardIdentityId),
  });
  if (bootstrap.outcome === "refused")
    throw new DevelopmentSetupRefusal(
      `The first owner could not become the platform super-administrator to publish the privacy notice (${bootstrap.code}). Another account already is: reset the local database (pnpm db:reset).`,
    );
  const published = await tenantAdministration.publishPrivacyNotice({
    ...signupPrivacyNoticeSetting,
    publisherIdentityId: stewardIdentityId,
  });
  if (published.outcome === "refused")
    throw new DevelopmentSetupRefusal(`The privacy notice was not published (${published.code}).`);
  log(`privacy notice ${signupPrivacyNoticeSetting.versionLabel} published`);
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
  await publishShippedPrivacyNotice(tenantAdministration, manifest, stewardIdentityId);

  // 2. Refresh the shipped applications through publication and protected installation.
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
  const installFacts = (releases: InstallFacts["releases"]): InstallFacts => ({
    identityAuthorityId,
    system,
    manifest,
    stewardIdentityId,
    releases,
    state,
  });

  // Verify provenance before changing any setup checkpoint or publishing a selected root.
  await verifyRecordedShippedApplicationRoots(system, manifest.applicationKeys, state);
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
  // Publication and activation finish for each root before a consumer of its Modules starts.
  // Hosted deployment needs the narrow platform-release authority from PR-H; local authority
  // remains confined to this setup command.
  const releases = await refreshShippedApplications(
    { identityAuthorityId, system, manifest, stewardIdentityId, state },
    log,
  );

  // 4. Local development deliberately leaves the nominated first owner able to open the
  //    applications installed in this organisation, while all grants remain normal Access facts.
  await grantFirstOwnerApplicationRoles(
    {
      identityAuthorityId,
      system,
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
  await initializeAppStoreAddress(installFacts(releases));
  // Index every record committed so far (the outbox holds each record's history) before the first sign-in.
  log(
    `delivered ${await createInProcessEventDispatcher().drain()} event occurrences to the consumers`,
  );
  log("done. Sign in with the nominated account and open the organisation.");
  return { organizationId: provisioned.rootOrganizationId, stewardIdentityId };
};

const main = async (): Promise<void> =>
  runDevelopmentSetup(process.argv.slice(2)).then(() => undefined);

// A one-shot command: exit once the setup settles, so an idle pooled connection or a client
// keep-alive socket can never hold the process (and the caller's setup lock) open.
main()
  .catch((error: unknown) => {
    if (error instanceof DevelopmentSetupRefusal)
      process.stderr.write(`[setup] ${error.message}\n`);
    else {
      const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
      process.stderr.write(
        `[setup] failed${code === undefined ? "" : ` (${code})`}: ${error instanceof Error ? error.message : "unexpected error"}\n`,
      );
      if (process.env.VORTEX_SETUP_DEBUG === "1") console.error(error);
    }
    process.exitCode = 1;
  })
  // Exit only after both streams have flushed, so a failure's cause is never truncated.
  .finally(() => process.stdout.write("", () => process.stderr.write("", () => process.exit())));
