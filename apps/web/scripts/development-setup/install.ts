import {
  createApplicationRoleTemplateAdapter,
  createHumanOrganizationRequestService,
  createOrganizationAccessAdministrationService,
  createInitialOperatingRoleGrantService,
  prepareOrganizationRoleChangeEvidence,
  verifyPreparedApplicationRoleTemplates,
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
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  initialOperatingRoleGrantManifestSchema,
  organizationRoleChangePreparationSchema,
  organizationSelectionCandidateSchema,
  type IdentityAuthorityId,
  type IdentitySession,
  type InitialOperatingRoleGrantResult,
  type PreparedApplicationRoleTemplates,
  type PreparedOrganizationRoleChange,
} from "@vortex/contracts";
import {
  createDatabaseSystemApplicationBoundReleaseSetService,
  fingerprintCanonicalValue,
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

/**
 * Freezes the operating-role acceptance of the named template against the just-activated
 * registration. The database re-verifies every fingerprint and revision in this evidence, so a
 * wrong value is refused, never accepted.
 */
const firstRegistrationRevision = 1;

const unusedRegistryFacts = {
  lookup: () => Promise.reject(new Error("The registry fact reader is not used")),
  readApplicationSnapshot: () => Promise.reject(new Error("The registry fact reader is not used")),
};

const prepareOperatingRoleEvidence = async (
  facts: InstallFacts,
  input: Readonly<{
    applicationKey: string;
    applicationRootId: string;
    operatingRoleId: string;
    operatingRoleSourceId: string;
  }>,
): Promise<PreparedOrganizationRoleChange> => {
  // The registry's private fact reader is not callable by any runtime or request role, so the
  // evidence is prepared from the immutable release and rebased onto the active registration the
  // installation just created (a first registration is revision 1). The database re-verifies the
  // registration revision and every fingerprint, so a wrong basis is refused.
  const context = mintSystemContext(facts.system);
  const candidate = await createApplicationRoleTemplateAdapter({
    definitionReader: definitionReader(facts),
    permissionRegistryFacts: unusedRegistryFacts,
  }).prepareRegistrationCandidate(context, {
    applicationRootId: applicationRootIdSchema.parse(input.applicationRootId),
    releaseRevision: release(facts, input.applicationKey).releaseRevision,
  });
  const { candidateFingerprint: _candidateFingerprint, ...candidateCore } = candidate;
  const activeCore = {
    ...candidateCore,
    preparationBasis: {
      kind: "current_active_registration" as const,
      registrationRevision: firstRegistrationRevision,
    },
  };
  const templates = verifyPreparedApplicationRoleTemplates({
    ...activeCore,
    candidateFingerprint: fingerprintCanonicalValue(activeCore),
  });
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
        description: "Application role granted to the first owner by the local development setup.",
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

/** The source role id of one role, read from the exact release definition. */
const roleSourceId = async (facts: InstallFacts, applicationKey: string, roleKey: string) => {
  const published = release(facts, applicationKey);
  const context = mintSystemContext(facts.system);
  const candidate = await createApplicationRoleTemplateAdapter({
    definitionReader: definitionReader(facts),
    permissionRegistryFacts: unusedRegistryFacts,
  }).prepareRegistrationCandidate(context, {
    applicationRootId: applicationRootIdSchema.parse(published.rootId),
    releaseRevision: published.releaseRevision,
  });
  const template = candidate.templates.find((entry) => entry.template.key === roleKey);
  if (template === undefined)
    throw new Error(`Application ${applicationKey} has no role ${roleKey}`);
  return template.template.roleId;
};

/**
 * The Access-owned initial operating-role grant accepts only a role whose permissions all belong
 * to its own application, which among the shipped roles is true only of the IAM reviewer. The
 * other roles the manifest names are therefore accepted and assigned by the steward through the
 * ordinary Access administration operations, the ones the IAM application drives.
 */
const grantAdditionalRoles = async (
  facts: InstallFacts,
  log: (message: string) => void,
): Promise<void> => {
  const selection = organizationSelectionCandidateSchema.parse({
    organizationId: facts.system.organizationId,
  });
  for (const role of facts.manifest.additionalRoles) {
    const recorded = `${role.applicationKey}/${role.roleKey}`;
    if (facts.state.rolesGranted[recorded] === true) continue;
    const published = release(facts, role.applicationKey);
    const evidence = await prepareOperatingRoleEvidence(facts, {
      applicationKey: role.applicationKey,
      applicationRootId: published.rootId,
      operatingRoleId: role.roleId,
      operatingRoleSourceId: await roleSourceId(facts, role.applicationKey, role.roleKey),
    });
    const administration = createOrganizationAccessAdministrationService({
      identityAuthorityId: facts.identityAuthorityId,
      roleAssignmentId: () => role.roleAssignmentId,
    });
    const accepted = await administration.acceptApplicationRoleTemplate(
      nominatedOwnerSession(facts.stewardIdentityId),
      selection,
      changeOrganizationAdministrationRoleAuthorityCommandSchema.parse({ evidence }),
    );
    if (accepted.kind !== "available")
      throw new Error(`The role ${recorded} could not be accepted (${accepted.kind})`);
    const assigned = await administration.assignRoleAssignment(
      nominatedOwnerSession(facts.stewardIdentityId),
      selection,
      assignOrganizationAdministrationRoleAssignmentCommandSchema.parse({
        roleId: role.roleId,
        expectedRoleRevision: accepted.value.role.liveRevision,
        assigneeKind: "organization_account",
        organizationAccountId: facts.stewardOrganizationAccountId,
        assignmentKind: "standing",
        startsAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    if (assigned.kind !== "available")
      throw new Error(`The role ${recorded} could not be assigned (${assigned.kind})`);
    facts.state.rolesGranted[recorded] = true;
    facts.state.save();
    log(`granted ${recorded} to the first owner`);
  }
};

/** The first-owner request both the first run and every replay send, from the same manifest. */
const firstOwnerRequest = (facts: InstallFacts, operatingRoleSourceId: string) => {
  const { manifest } = facts;
  const operating = release(facts, manifest.operatingRole.applicationKey);
  return firstOwnerApplicationEntryRequestSchema.parse({
    organizationId: facts.system.organizationId,
    applicationRootId: operating.rootId,
    applicationReleaseRevision: operating.releaseRevision,
    stewardOrganizationAccountId: facts.stewardOrganizationAccountId,
    provisioningReceiptId: facts.provisioningReceiptId,
    setupRevision: 1,
    setupActorId: manifest.operator.systemActorId,
    correlationId: manifest.setupCorrelationId,
    operatingRoleId: manifest.operatingRole.roleId,
    operatingRoleSourceId,
    roleAssignmentId: manifest.operatingRole.roleAssignmentId,
  });
};

/** Installs every manifest application; the operating application last, with the grant. */
export const installAndGrant = async (
  facts: InstallFacts,
  log: (message: string) => void,
): Promise<InitialOperatingRoleGrantResult> => {
  const { manifest } = facts;
  await initializeLifecycleLimits(facts.system.organizationId);
  for (const key of manifest.applicationKeys)
    if (key !== manifest.operatingRole.applicationKey) await installOne(facts, key, log);

  await prepareRelease(facts, manifest.operatingRole.applicationKey, log);
  const sourceRoleId = await roleSourceId(
    facts,
    manifest.operatingRole.applicationKey,
    manifest.operatingRole.roleKey,
  );
  const composition = createFirstOwnerApplicationEntryComposition({
    installation: coordinatorDependencies(facts),
    initialOperatingRoleGrant: createInitialOperatingRoleGrantService(),
    prepareOperatingRoleEvidence: (input) =>
      prepareOperatingRoleEvidence(facts, {
        applicationKey: manifest.operatingRole.applicationKey,
        applicationRootId: input.applicationRootId,
        operatingRoleId: input.operatingRoleId,
        operatingRoleSourceId: input.operatingRoleSourceId,
      }),
  });
  const session: IdentitySession = nominatedOwnerSession(facts.stewardIdentityId);
  const result = await composition.establish(session, firstOwnerRequest(facts, sourceRoleId));
  log(`installed ${manifest.operatingRole.applicationKey}: ${result.installation.outcome}`);
  await grantAdditionalRoles(facts, log);
  facts.state.setupCompleted = true;
  facts.state.save();
  return result.rights;
};

/**
 * A re-run after a completed setup does nothing but call the Access-owned initial operating-role
 * grant again with the original provisioning receipt and the same frozen manifest, so Access
 * replays its stored result. The manifest is rebuilt exactly as the App first-owner composition
 * built it: the evidence is deterministic for the unchanged release and registration, and Access
 * refuses anything that differs from what it stored.
 */
export const replayOperatingRoleGrant = async (
  facts: InstallFacts,
): Promise<InitialOperatingRoleGrantResult> => {
  const { manifest } = facts;
  const sourceRoleId = await roleSourceId(
    facts,
    manifest.operatingRole.applicationKey,
    manifest.operatingRole.roleKey,
  );
  const request = firstOwnerRequest(facts, sourceRoleId);
  const operatingRoleChangeEvidence = await prepareOperatingRoleEvidence(facts, {
    applicationKey: manifest.operatingRole.applicationKey,
    applicationRootId: request.applicationRootId,
    operatingRoleId: request.operatingRoleId,
    operatingRoleSourceId: request.operatingRoleSourceId,
  });
  return createInitialOperatingRoleGrantService().establish(
    initialOperatingRoleGrantManifestSchema.parse({
      manifestVersion: "1.0.0",
      organizationId: request.organizationId,
      stewardOrganizationAccountId: request.stewardOrganizationAccountId,
      applicationRootId: request.applicationRootId,
      applicationReleaseRevision: request.applicationReleaseRevision,
      provisioningReceiptId: request.provisioningReceiptId,
      setupRevision: request.setupRevision,
      setupActorId: request.setupActorId,
      correlationId: request.correlationId,
      roleAssignmentId: request.roleAssignmentId,
      operatingRoleChangeEvidence,
    }),
  );
};
