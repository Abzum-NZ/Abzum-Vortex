import { developmentSetupManifest } from "./manifest";
import {
  DevelopmentSetupRefusal,
  parseSetupArguments,
  requireLocalDevelopmentEnvironment,
  resolveFirstOwnerIdentity,
} from "./guards";
import { provisionTenantCommandSchema } from "@vortex/contracts";
import { createConfiguredTenantAdministrationService } from "@vortex/identity";
import { publishShippedDefinitions } from "./definitions";
import { installAndGrant } from "./install";
import { grantStewardInstallerRole } from "./installer-access";
import { loadSetupState } from "./state";

/**
 * The development-only setup: provisions the disposable organisation, publishes and installs the
 * shipped applications and grants the one nominated first owner their operating role, through the
 * protected entry points only. `pnpm setup:local` runs it; the README lists the exact steps.
 *
 * It is safe to run again: provisioning replays by its fixed duplicate key, published releases are
 * reused, installation reports "unchanged" and the operating-role grant replays its original
 * result. A different nominated account is refused by the database once the grant is established.
 */

const log = (message: string): void => {
  process.stdout.write(`[setup] ${message}\n`);
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
  const releases = await publishShippedDefinitions(system, manifest.applicationKeys, state, log);

  // 3. The steward gives themselves the application-installation permission, then installs the
  //    applications and receives the operating role.
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
  const rights = await installAndGrant(
    {
      identityAuthorityId,
      system,
      manifest,
      stewardIdentityId,
      stewardOrganizationAccountId: provisioned.organizationAccountId,
      provisioningReceiptId: provisioned.correlationId,
      releases,
      state,
    },
    log,
  );
  log(
    `operating role ${rights.operatingRoleId} ${rights.outcome} for account ${provisioned.organizationAccountId}`,
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
