import {
  createApplicationRoleTemplateAdapter,
  createHumanOrganizationRequestService,
  createInitialOperatingRoleGrantService,
  createPermissionRegistryPrivateRepository,
  prepareOrganizationRoleChangeEvidence,
  type PermissionRegistryDefinitionSetReader,
} from "@vortex/access";
import {
  applicationInstallationActivationRequestSchema,
  ApplicationInstallationCoordinatorError,
  applicationInstallationPreparationRequestSchema,
  createApplicationInstallationCoordinator,
  createFirstOwnerApplicationEntryComposition,
  firstOwnerApplicationEntryRequestSchema,
  type ApplicationInstallationCoordinatorDependencies,
} from "@vortex/app";
import {
  applicationRootIdSchema,
  organizationRoleChangePreparationSchema,
  type IdentityAuthorityId,
  type IdentitySession,
  type InitialOperatingRoleGrantResult,
  type PreparedApplicationRoleTemplates,
  type PreparedOrganizationRoleChange,
} from "@vortex/contracts";
import { createDatabaseSystemApplicationBoundReleaseSetService } from "@vortex/definition";
import { developmentPublicationCatalogue } from "./definitions";
import {
  developmentBuilderAuthority,
  inSystemTransaction,
  mintSystemContext,
  nominatedOwnerSession,
  type SystemContextFacts,
} from "./development-authority";
import type { DevelopmentSetupManifest } from "./manifest";
import type { PublishedRelease } from "./state";

/**
 * Installs the published applications for the nominated first owner and hands that owner the one
 * operating role, using only the protected entry points: the App installation coordinator
 * (prepare then activate) and the App first-owner composition, which calls the Access-owned
 * initial operating-role grant. Raw stewardship or role helpers are never called here.
 */

export type InstallFacts = Readonly<{
  identityAuthorityId: IdentityAuthorityId;
  system: SystemContextFacts;
  manifest: DevelopmentSetupManifest;
  stewardIdentityId: string;
  stewardOrganizationAccountId: string;
  /** The original tenant provisioning receipt: the provisioning result's correlation id. */
  provisioningReceiptId: string;
  releases: ReadonlyMap<string, PublishedRelease>;
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

/** Prepares and activates one exact release; a release that is already active is unchanged. */
const installOne = async (
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
  const session = nominatedOwnerSession(facts.stewardIdentityId);
  await coordinator
    .prepare(session, applicationInstallationPreparationRequestSchema.parse(target))
    .catch((error: unknown) => {
      if (
        error instanceof ApplicationInstallationCoordinatorError &&
        error.code === "APPLICATION_INSTALLATION_STALE"
      )
        return undefined;
      throw error;
    });
  const activation = await coordinator.activate(
    session,
    applicationInstallationActivationRequestSchema.parse({
      ...target,
      expectedActiveReleaseRevision: null,
    }),
  );
  log(`installed ${applicationKey}: ${activation.outcome}`);
};

/**
 * Freezes the operating-role acceptance of the named template against the just-activated
 * registration. The database re-verifies every fingerprint and revision in this evidence, so a
 * wrong value is refused, never accepted.
 */
const prepareOperatingRoleEvidence = async (
  facts: InstallFacts,
  input: Readonly<{
    applicationRootId: string;
    operatingRoleId: string;
    operatingRoleSourceId: string;
  }>,
): Promise<PreparedOrganizationRoleChange> => {
  const context = mintSystemContext(facts.system);
  const templates: PreparedApplicationRoleTemplates = await inSystemTransaction(
    context,
    (transaction) =>
      createApplicationRoleTemplateAdapter({
        definitionReader: definitionReader(facts),
        permissionRegistryFacts: createPermissionRegistryPrivateRepository(transaction),
      }).prepareCurrentActive(context, {
        applicationRootId: applicationRootIdSchema.parse(input.applicationRootId),
      }),
  );
  if (templates.preparationBasis.kind !== "current_active_registration")
    throw new Error("The operating role must derive from the active registration");
  const basis = templates.preparationBasis;
  const selected = templates.templates.find(
    (entry) => entry.template.roleId.toLowerCase() === input.operatingRoleSourceId.toLowerCase(),
  );
  if (selected === undefined) throw new Error("The operating role template is not in the release");
  // A first registration starts every continuity at revision 1; the database checks exact equality.
  const continuityRevision = 1;
  return prepareOrganizationRoleChangeEvidence(
    organizationRoleChangePreparationSchema.parse({
      candidate: {
        operation: "accept_new_application_role",
        organizationId: facts.system.organizationId,
        roleId: input.operatingRoleId,
        key: selected.template.key,
        label: selected.template.name,
        description: "Operating role granted to the first owner by the local development setup.",
        privilegeClassification: "privileged",
        assignmentPolicy: { kind: "standing" },
        preparedTemplates: templates,
        sourceRoleId: selected.template.roleId,
        templateContinuityRevision: continuityRevision,
        permissions: selected.livePermissions.map((entry) => ({
          kind: "exact",
          applicationRootId: entry.applicationRootId,
          ownerKind: entry.ownerKind,
          ownerId: entry.ownerId,
          permissionId: entry.permission.permissionId,
          acceptedRegistrationRevision: basis.registrationRevision,
          catalogueFingerprint: templates.permissionRegistration.applicationCatalogueFingerprint,
          continuityRevision,
          meaningFingerprint: entry.meaningFingerprint,
        })),
      },
    }),
  );
};

/** The source role id of the manifest's operating role, read from the exact release definition. */
const operatingRoleSourceId = async (facts: InstallFacts, applicationRootId: string) => {
  const published = release(facts, facts.manifest.operatingRole.applicationKey);
  const context = mintSystemContext(facts.system);
  const candidate = await createApplicationRoleTemplateAdapter({
    definitionReader: definitionReader(facts),
    permissionRegistryFacts: {
      lookup: () => Promise.reject(new Error("Not used for a registration candidate")),
      readApplicationSnapshot: () =>
        Promise.reject(new Error("Not used for a registration candidate")),
    },
  }).prepareRegistrationCandidate(context, {
    applicationRootId: applicationRootIdSchema.parse(applicationRootId),
    releaseRevision: published.releaseRevision,
  });
  const template = candidate.templates.find(
    (entry) => entry.template.key === facts.manifest.operatingRole.roleKey,
  );
  if (template === undefined)
    throw new Error(
      `Application ${facts.manifest.operatingRole.applicationKey} has no role ${facts.manifest.operatingRole.roleKey}`,
    );
  return template.template.roleId;
};

/** Installs every manifest application; the operating application last, with the grant. */
export const installAndGrant = async (
  facts: InstallFacts,
  log: (message: string) => void,
): Promise<InitialOperatingRoleGrantResult> => {
  const { manifest } = facts;
  for (const key of manifest.applicationKeys)
    if (key !== manifest.operatingRole.applicationKey) await installOne(facts, key, log);

  const operating = release(facts, manifest.operatingRole.applicationKey);
  const sourceRoleId = await operatingRoleSourceId(facts, operating.rootId);
  const composition = createFirstOwnerApplicationEntryComposition({
    installation: coordinatorDependencies(facts),
    initialOperatingRoleGrant: createInitialOperatingRoleGrantService(),
    prepareOperatingRoleEvidence: (input) =>
      prepareOperatingRoleEvidence(facts, {
        applicationRootId: input.applicationRootId,
        operatingRoleId: input.operatingRoleId,
        operatingRoleSourceId: input.operatingRoleSourceId,
      }),
  });
  const session: IdentitySession = nominatedOwnerSession(facts.stewardIdentityId);
  const result = await composition.establish(
    session,
    firstOwnerApplicationEntryRequestSchema.parse({
      organizationId: facts.system.organizationId,
      applicationRootId: operating.rootId,
      applicationReleaseRevision: operating.releaseRevision,
      stewardOrganizationAccountId: facts.stewardOrganizationAccountId,
      provisioningReceiptId: facts.provisioningReceiptId,
      setupRevision: 1,
      setupActorId: manifest.operator.systemActorId,
      correlationId: manifest.setupCorrelationId,
      operatingRoleId: manifest.operatingRole.roleId,
      operatingRoleSourceId: sourceRoleId,
      roleAssignmentId: manifest.operatingRole.roleAssignmentId,
    }),
  );
  log(`installed ${manifest.operatingRole.applicationKey}: ${result.installation.outcome}`);
  return result.rights;
};
