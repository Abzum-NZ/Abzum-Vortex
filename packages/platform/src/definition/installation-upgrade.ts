import "server-only";

import { createHash } from "node:crypto";
import type { RequestDatabaseTransaction } from "../db/index";
import {
  createBuilderAuthority,
  prepareApplicationRoleTemplatesForHumanRequest,
  type createHumanOrganizationRequestService,
  type HumanOrganizationRequestResult,
} from "../access/index";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import {
  canonicalJson,
  sameId,
  type ActiveApplicationInstallationEvidence,
  type ApplicationRootId,
  type IdentitySession,
  type OrganizationId,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";
import { createDatabaseApplicationReleaseAdoptionReleaseSetService } from "./application-bound-release-set";
import { DefinitionError } from "./definition-error";
import { resolveModuleContributions } from "./extension-contributions";
import { createApplicationInstallationCoordinator } from "./installation-coordinator";
import type {
  ApplicationInstallationActivationResult,
  HumanInstallationDefinitionAccess,
} from "./installation-coordinator-contracts";
import { createPreparedInstallationRuntimeSourceReader } from "./prepared-installation-runtime-source";
import { classifyInstallationFailure } from "./installation-failure";
import {
  InstallationProblem,
  installationOperation,
  installationProblem,
  installationTargetFacts,
  readInstallationAuthorityDeadlines,
  readInstallationDatabaseTime,
  readInstallationHumanContext,
  readInstallationOrdinaryRoot,
  requireInstallationAuthority,
  type InstallationHumanContext,
  type InstallationProblemShape,
} from "./installation-authority";
import {
  createActiveApplicationInstallationRepository,
  readInstallationBindings,
  readInstallationReleaseSet,
  releaseSetModuleTuples,
  sameActiveBindings,
  sortedBindingTuples,
  type InstallationBindings,
} from "./installation-binding-reader";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./publication/read";

type HumanOrganizationRequests = ReturnType<typeof createHumanOrganizationRequestService>;

/** What an install or upgrade needs from the application: its request runner, catalogue, permissions and custom-component rule. */
export type UpgradeEnvironment = Readonly<{
  requests: HumanOrganizationRequests;
  catalogue: ImmutableDefinitionPublicationCatalogueDefinition;
  permissions: PlatformPermissionSource;
  containsCustomComponents: (releaseSet: SystemApplicationBoundReleaseSetResult) => boolean;
}>;

export type UpgradeSelector = Readonly<{
  organizationId: OrganizationId;
  rootId: ApplicationRootId;
  releaseRevision: number;
}>;

export type UpgradeReleaseIdentity = Readonly<{
  releaseRevision: number;
  releaseVersion: string;
  validationContractVersion: string;
  contentFingerprint: string;
  resolutionFingerprint: string;
}>;

/** The exact state an install or upgrade was authorised against. */
export type UpgradeSnapshot = Readonly<{
  organizationId: OrganizationId;
  rootId: ApplicationRootId;
  definitionKey: string;
  selected: UpgradeReleaseIdentity;
  active: UpgradeReleaseIdentity;
  moduleSetFingerprint: string;
  bindingSetFingerprint: string;
  validUntil: string;
  correlationId: string;
}>;

export type UpgradeState = Readonly<{
  active: ActiveApplicationInstallationEvidence;
  activeReleaseSet: SystemApplicationBoundReleaseSetResult;
  selectedReleaseSet: SystemApplicationBoundReleaseSetResult;
  bindings: InstallationBindings;
}>;

export type UpgradeAuthorizedState = Readonly<{
  snapshot: UpgradeSnapshot;
  state: UpgradeState;
  checkedAt: string;
}>;

const same = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const fingerprint = (domain: string, value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify([domain, value]), "utf8")
    .digest("hex")}`;

const releaseIdentity = (release: UpgradeReleaseIdentity): UpgradeReleaseIdentity => ({
  releaseRevision: release.releaseRevision,
  releaseVersion: release.releaseVersion,
  validationContractVersion: release.validationContractVersion,
  contentFingerprint: release.contentFingerprint,
  resolutionFingerprint: release.resolutionFingerprint,
});

const readCurrentInstallation = async (
  transaction: RequestDatabaseTransaction,
  selector: UpgradeSelector,
): Promise<Pick<UpgradeState, "active" | "bindings">> => {
  await readInstallationOrdinaryRoot(transaction, selector.rootId);
  let active: ActiveApplicationInstallationEvidence;
  try {
    active = await createActiveApplicationInstallationRepository(transaction).readCurrent();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { readonly code?: unknown }).code)
        : "";
    switch (code) {
      case "ACTIVE_APPLICATION_CONTEXT_REFUSED":
        return installationProblem("active_installation_context_refused", "refused", undefined, {
          cause: error,
        });
      case "ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE":
        return installationProblem("active_installation_missing", "refused", "not_installed", {
          cause: error,
        });
      case "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE":
        return installationProblem(
          "active_installation_incomplete",
          "refused",
          "installation_incomplete",
          { cause: error },
        );
      default:
        return installationProblem(
          "active_installation_read_failed",
          "temporarily_unavailable",
          undefined,
          { cause: error },
        );
    }
  }
  if (
    !sameId(active.organizationId, selector.organizationId) ||
    !sameId(active.applicationRootId, selector.rootId) ||
    active.moduleBindings.length === 0
  )
    installationProblem("active_installation_mismatch", "refused", "installation_incomplete");
  const bindings = await readInstallationBindings(transaction, selector.rootId);
  if (!sameId(bindings.organizationId, selector.organizationId))
    installationProblem("bindings_organization_mismatch", "refused", "installation_incomplete");
  if (
    bindings.moduleBindings.some(
      (binding) =>
        !sameId(binding.organizationId, selector.organizationId) ||
        !sameId(binding.applicationRootId, selector.rootId),
    )
  )
    installationProblem("bindings_scope_mismatch", "refused", "installation_incomplete");
  const activeBindings = bindings.moduleBindings.filter((binding) => binding.state === "active");
  if (
    bindings.moduleBindings.some(
      (binding) => binding.state !== "active" && binding.state !== "detached",
    ) ||
    !same(sortedBindingTuples(activeBindings), sortedBindingTuples(active.moduleBindings))
  )
    installationProblem("bindings_active_set_misaligned", "refused", "installation_incomplete");
  // A prior failed upgrade may have left registration at another release. The supported
  // upgrade repairs it in the same transaction as activation, after current authority and
  // exact target evidence are checked; runtime readers still refuse the inconsistent state.

  return { active, bindings };
};

const readCurrentState = async (
  environment: UpgradeEnvironment,
  transaction: RequestDatabaseTransaction,
  selector: UpgradeSelector,
  context: InstallationHumanContext,
): Promise<UpgradeState> => {
  const { active, bindings } = await readCurrentInstallation(transaction, selector);
  const activeReleaseSet = await readInstallationReleaseSet(
    transaction,
    environment.catalogue,
    selector.rootId,
    active.applicationReleaseRevision,
    selector.organizationId,
    context.correlationId,
    "replace_or_remove",
  );
  const selectedReleaseSet = await readInstallationReleaseSet(
    transaction,
    environment.catalogue,
    selector.rootId,
    selector.releaseRevision,
    selector.organizationId,
    context.correlationId,
  );
  const activeModules = releaseSetModuleTuples(activeReleaseSet);
  if (
    activeModules.length !== active.moduleBindings.length ||
    active.moduleBindings.some(
      (binding) =>
        !activeReleaseSet.modules.some(
          (module) =>
            sameId(module.rootId, binding.moduleRootId) &&
            module.releaseRevision === binding.moduleReleaseRevision &&
            binding.applicationReleaseRevision === active.applicationReleaseRevision,
        ),
    )
  )
    installationProblem("active_release_set_misaligned", "refused", "installation_incomplete");
  return { active, activeReleaseSet, selectedReleaseSet, bindings };
};

const makeSnapshot = (
  selector: UpgradeSelector,
  state: UpgradeState,
  context: InstallationHumanContext,
  validUntil: string,
): UpgradeSnapshot => {
  const application = state.selectedReleaseSet.application;
  if (
    application.kind !== "application" ||
    !sameId(application.rootId, selector.rootId) ||
    !sameId(application.organizationId, selector.organizationId) ||
    state.activeReleaseSet.application.definitionKey !== application.definitionKey
  )
    installationProblem("snapshot_application_mismatch", "refused");
  return {
    organizationId: selector.organizationId,
    rootId: selector.rootId,
    definitionKey: application.definitionKey,
    selected: releaseIdentity(application),
    active: releaseIdentity(state.activeReleaseSet.application),
    moduleSetFingerprint: fingerprint(
      "vortex.studio.install.module-set.v1",
      releaseSetModuleTuples(state.selectedReleaseSet),
    ),
    bindingSetFingerprint: fingerprint("vortex.studio.install.binding-set.v1", {
      registeredReleaseRevision: state.bindings.registeredReleaseRevision,
      moduleBindings: sortedBindingTuples(state.bindings.moduleBindings),
    }),
    validUntil,
    correlationId: context.correlationId,
  };
};

const assertStateEligible = (
  selector: UpgradeSelector,
  state: UpgradeState,
  allowEqual: boolean,
): void => {
  if (selector.releaseRevision < state.active.applicationReleaseRevision)
    installationProblem("selected_release_older", "refused", "not_newer");
  const sameModules = same(
    releaseSetModuleTuples(state.activeReleaseSet),
    releaseSetModuleTuples(state.selectedReleaseSet),
  );
  if (selector.releaseRevision === state.active.applicationReleaseRevision) {
    if (!sameModules)
      installationProblem(
        "active_release_module_set_differs",
        "refused",
        "installation_incomplete",
      );
    if (!allowEqual) installationProblem("selected_release_not_newer", "refused", "not_newer");
    return;
  }
  // A newer Application version releases its changed Modules with it, so an upgrade moves to the
  // new pinned Module releases; only the set of Modules the Application binds must stay the same.
  const moduleRoots = (releaseSet: UpgradeState["activeReleaseSet"]) =>
    releaseSet.modules.map((module) => module.rootId.toLowerCase()).sort();
  if (!same(moduleRoots(state.activeReleaseSet), moduleRoots(state.selectedReleaseSet)))
    installationProblem("module_set_changed", "refused", "module_set_changed");
};

/** Whether two snapshots describe the same organisation, application, releases and bindings. */
export const sameUpgradeSnapshotState = (left: UpgradeSnapshot, right: UpgradeSnapshot): boolean =>
  same(
    {
      organizationId: left.organizationId,
      rootId: left.rootId,
      definitionKey: left.definitionKey,
      selected: left.selected,
      active: left.active,
      moduleSetFingerprint: left.moduleSetFingerprint,
      bindingSetFingerprint: left.bindingSetFingerprint,
    },
    {
      organizationId: right.organizationId,
      rootId: right.rootId,
      definitionKey: right.definitionKey,
      selected: right.selected,
      active: right.active,
      moduleSetFingerprint: right.moduleSetFingerprint,
      bindingSetFingerprint: right.bindingSetFingerprint,
    },
  );

/** Whether two snapshots select the same release of the same application with the same modules. */
export const sameUpgradeSelectedSnapshot = (
  expected: UpgradeSnapshot,
  current: UpgradeSnapshot,
): boolean =>
  same(
    {
      organizationId: expected.organizationId,
      rootId: expected.rootId,
      definitionKey: expected.definitionKey,
      selected: expected.selected,
      moduleSetFingerprint: expected.moduleSetFingerprint,
    },
    {
      organizationId: current.organizationId,
      rootId: current.rootId,
      definitionKey: current.definitionKey,
      selected: current.selected,
      moduleSetFingerprint: current.moduleSetFingerprint,
    },
  );

/** The earliest moment the context or any permission the install needs lapses, proved before it. */
const installationDeadline = async (
  environment: UpgradeEnvironment,
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: InstallationHumanContext,
  rootId: string,
  releaseSet: SystemApplicationBoundReleaseSetResult,
): Promise<Readonly<{ deadline: number; completedAt: string }>> => {
  const installationDeadlines = await readInstallationAuthorityDeadlines(
    transaction,
    scope,
    context,
    environment.permissions,
    rootId,
    environment.containsCustomComponents(releaseSet),
  );
  const completedAt = await readInstallationDatabaseTime(transaction);
  const deadline = Math.min(
    Date.parse(context.expiresAt),
    ...installationDeadlines.map((validUntil) => Date.parse(validUntil)),
  );
  if (!Number.isFinite(deadline) || Date.parse(completedAt) >= deadline)
    installationProblem("authority_lapsed", "refused");
  return { deadline, completedAt };
};

/**
 * Reads the current installation state in one application-scoped transaction, proves the caller
 * may install the selected release, proves the state did not move while authority was checked,
 * and returns the snapshot the install is bound to. A failure inside the transaction is
 * rethrown as the same refusal the caller is shown.
 */
export const readUpgradeAuthorizedState = async (
  environment: UpgradeEnvironment,
  selector: UpgradeSelector,
  session: IdentitySession,
  allowEqual: boolean,
): Promise<UpgradeAuthorizedState> => {
  let captured: InstallationProblemShape | undefined;
  const scopeCandidate = {
    organizationId: selector.organizationId,
    applicationRootId: selector.rootId,
  };
  const result = await environment.requests.run(
    session,
    scopeCandidate,
    async (transaction, scope, issuedAt) => {
      try {
        const context = await readInstallationHumanContext(
          transaction,
          scope,
          session,
          issuedAt,
          scopeCandidate,
        );
        const firstState = await readCurrentState(environment, transaction, selector, context);
        assertStateEligible(selector, firstState, allowEqual);
        await requireInstallationAuthority(
          transaction,
          scope,
          environment.permissions,
          installationOperation(
            selector.rootId,
            environment.containsCustomComponents(firstState.selectedReleaseSet),
          ),
        );

        const finalContext = await readInstallationHumanContext(
          transaction,
          scope,
          session,
          issuedAt,
          scopeCandidate,
        );
        if (!same(context, finalContext)) installationProblem("human_context_changed", "refused");
        // Release contents are immutable. Re-read the live installation and binding revisions,
        // keeping the exact release sets already verified in this transaction only while that
        // mutable state is unchanged. Authority and its deadline are still checked afresh below.
        const finalInstallation = await readCurrentInstallation(transaction, selector);
        if (!same({ active: firstState.active, bindings: firstState.bindings }, finalInstallation))
          installationProblem("installation_state_changed", "conflict");
        await requireInstallationAuthority(
          transaction,
          scope,
          environment.permissions,
          installationOperation(
            selector.rootId,
            environment.containsCustomComponents(firstState.selectedReleaseSet),
          ),
        );

        const { deadline, completedAt } = await installationDeadline(
          environment,
          transaction,
          scope,
          finalContext,
          selector.rootId,
          firstState.selectedReleaseSet,
        );
        return {
          snapshot: makeSnapshot(
            selector,
            firstState,
            finalContext,
            new Date(deadline).toISOString(),
          ),
          state: firstState,
          checkedAt: completedAt,
        };
      } catch (error) {
        captured = classifyInstallationFailure(error);
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (captured !== undefined)
    throw new InstallationProblem(captured, "transaction_failure_captured");
  if (result.kind === "unavailable")
    return installationProblem("upgrade_request_unavailable", "refused");
  return installationProblem("upgrade_request_temporarily_unavailable", "temporarily_unavailable");
};

/**
 * Reads the release the application's active installation names after an install, under the
 * same checks as the install itself.
 */
export const readUpgradeActiveObservation = async (
  environment: UpgradeEnvironment,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
  session: IdentitySession,
): Promise<UpgradeReleaseIdentity> => {
  let captured: InstallationProblemShape | undefined;
  const scopeCandidate = { organizationId, applicationRootId: rootId };
  const result = await environment.requests.run(
    session,
    scopeCandidate,
    async (transaction, scope, issuedAt) => {
      try {
        const context = await readInstallationHumanContext(
          transaction,
          scope,
          session,
          issuedAt,
          scopeCandidate,
        );
        const active =
          await createActiveApplicationInstallationRepository(transaction).readCurrent();
        if (
          !sameId(active.organizationId, organizationId) ||
          !sameId(active.applicationRootId, rootId)
        )
          installationProblem("observed_installation_mismatch", "refused");
        const registration = await readInstallationBindings(transaction, rootId);
        const registeredActive = registration.moduleBindings.filter(
          (binding) => binding.state === "active",
        );
        if (
          !sameId(registration.organizationId, organizationId) ||
          !sameId(registration.applicationRootId, rootId) ||
          registration.moduleBindings.some(
            (binding) =>
              !sameId(binding.organizationId, organizationId) ||
              !sameId(binding.applicationRootId, rootId),
          ) ||
          registration.registeredReleaseRevision !== active.applicationReleaseRevision ||
          registration.moduleBindings.some(
            (binding) => binding.state !== "active" && binding.state !== "detached",
          ) ||
          !same(sortedBindingTuples(registeredActive), sortedBindingTuples(active.moduleBindings))
        )
          installationProblem("observed_bindings_misaligned", "refused");
        const releaseSet = await readInstallationReleaseSet(
          transaction,
          environment.catalogue,
          rootId,
          active.applicationReleaseRevision,
          organizationId,
          context.correlationId,
        );
        if (
          releaseSet.modules.length !== active.moduleBindings.length ||
          active.moduleBindings.some(
            (binding) =>
              !releaseSet.modules.some(
                (module) =>
                  sameId(module.rootId, binding.moduleRootId) &&
                  module.releaseRevision === binding.moduleReleaseRevision,
              ),
          )
        )
          installationProblem("observed_release_set_misaligned", "refused");
        await readInstallationOrdinaryRoot(transaction, rootId);
        await requireInstallationAuthority(
          transaction,
          scope,
          environment.permissions,
          installationOperation(rootId, environment.containsCustomComponents(releaseSet)),
        );
        const finalContext = await readInstallationHumanContext(
          transaction,
          scope,
          session,
          issuedAt,
          scopeCandidate,
        );
        if (!same(context, finalContext)) installationProblem("human_context_changed", "refused");
        await installationDeadline(
          environment,
          transaction,
          scope,
          finalContext,
          rootId,
          releaseSet,
        );
        return releaseIdentity(releaseSet.application);
      } catch (error) {
        captured = classifyInstallationFailure(error);
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (captured !== undefined)
    throw new InstallationProblem(captured, "transaction_failure_captured");
  return result.kind === "unavailable"
    ? installationProblem("observation_request_unavailable", "refused")
    : installationProblem("observation_request_temporarily_unavailable", "temporarily_unavailable");
};

/**
 * The coordinator's release reads. Release contents are immutable, so a release set this upgrade
 * already read and verified under the installer's authority earlier in the same call is handed over
 * instead of being read and projected again; any other release is read afresh.
 */
const humanDefinitionAccess = (
  environment: UpgradeEnvironment,
  consumptionVerified: readonly SystemApplicationBoundReleaseSetResult[],
  replacementVerified: readonly SystemApplicationBoundReleaseSetResult[],
): HumanInstallationDefinitionAccess => ({
  async readReleaseSet(session, target, purpose) {
    const verified =
      purpose === "consume"
        ? consumptionVerified
        : [...consumptionVerified, ...replacementVerified];
    const known = verified.find(
      (releaseSet) =>
        sameId(releaseSet.application.organizationId, target.organizationId) &&
        sameId(releaseSet.application.rootId, target.applicationRootId) &&
        releaseSet.application.releaseRevision === target.applicationReleaseRevision,
    );
    if (known !== undefined) return known;
    const result = await environment.requests.run(
      session,
      { organizationId: target.organizationId, applicationRootId: target.applicationRootId },
      (transaction) =>
        createDatabaseApplicationReleaseAdoptionReleaseSetService(
          environment.catalogue,
          transaction,
          purpose,
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

const currentInstallationStateForCoordinator = async (
  transaction: RequestDatabaseTransaction,
  selector: UpgradeSelector,
  baseline: UpgradeState,
  context: InstallationHumanContext,
): Promise<void> => {
  const current = await readInstallationBindings(transaction, selector.rootId);
  if (
    !sameId(current.organizationId, selector.organizationId) ||
    !sameId(current.applicationRootId, selector.rootId) ||
    current.moduleBindings.some(
      (binding) => binding.state !== "active" && binding.state !== "detached",
    ) ||
    !same(
      sortedBindingTuples(current.moduleBindings),
      sortedBindingTuples(baseline.bindings.moduleBindings),
    ) ||
    !sameActiveBindings(
      current.moduleBindings.filter((binding) => binding.state === "active"),
      baseline.active.moduleBindings,
    )
  )
    installationProblem("coordinator_bindings_changed", "conflict");
  if (current.registeredReleaseRevision !== baseline.bindings.registeredReleaseRevision)
    installationProblem("coordinator_registration_changed", "conflict");
  if (!sameId(context.organizationId, selector.organizationId))
    installationProblem("coordinator_organization_mismatch", "refused");
};

const coordinatorFor = (
  environment: UpgradeEnvironment,
  selector: UpgradeSelector,
  baseline: UpgradeState,
  beforeRegistration?: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
  ) => Promise<void>,
) => {
  let started = false;
  const runInstallerRequest = async <Result>(
    requestMode: "runAccessChange" | "runChange",
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate,
    operation: (
      transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope,
      issuedAt: string,
    ) => Promise<Result>,
  ): Promise<HumanOrganizationRequestResult<Result>> => {
    // Registration and activation have exactly one commit boundary. No later switch or
    // compensating transaction may act on the already-authorised baseline.
    if (started || requestMode !== "runAccessChange")
      installationProblem("coordinator_unexpected_transaction", "temporarily_unavailable");
    started = true;
    let callbackFailure: unknown;
    const result = await environment.requests[requestMode](
      session,
      candidate,
      async (transaction, scope, issuedAt) => {
        try {
          if (
            !sameId(scope.organizationId, selector.organizationId) ||
            scope.applicationRootId !== undefined
          )
            installationProblem("coordinator_scope_mismatch", "refused");
          const context = await readInstallationHumanContext(
            transaction,
            scope,
            session,
            issuedAt,
            {
              organizationId: selector.organizationId,
            },
          );
          await readInstallationOrdinaryRoot(transaction, selector.rootId);
          await currentInstallationStateForCoordinator(transaction, selector, baseline, context);
          if (beforeRegistration !== undefined) await beforeRegistration(transaction, scope);
          return await operation(transaction, scope, issuedAt);
        } catch (error) {
          callbackFailure = error;
          throw error;
        }
      },
    );
    if (callbackFailure !== undefined) throw callbackFailure;
    return result;
  };
  const installerRequests: Pick<HumanOrganizationRequests, "runAccessChange" | "runChange"> = {
    runAccessChange: (...args) => runInstallerRequest("runAccessChange", ...args),
    runChange: (...args) => runInstallerRequest("runChange", ...args),
  };
  return createApplicationInstallationCoordinator({
    installerRequests,
    resolveModuleContributions,
    builderAuthority: (transaction, scope) =>
      createBuilderAuthority({
        transaction,
        scope,
        targetFacts: installationTargetFacts,
        permissions: environment.permissions,
      }),
    containsCustomComponents: environment.containsCustomComponents,
    humanDefinitionAccess: humanDefinitionAccess(
      environment,
      [baseline.selectedReleaseSet],
      [baseline.activeReleaseSet],
    ),
    preparedRuntimeSource: createPreparedInstallationRuntimeSourceReader(environment.catalogue, [
      baseline.selectedReleaseSet,
    ]),
  });
};

const verifyCoordinatorActivation = (
  result: ApplicationInstallationActivationResult<unknown>,
  selector: UpgradeSelector,
  priorRevision: number,
  selectedReleaseSet: SystemApplicationBoundReleaseSetResult,
): Readonly<{ outcome: "activated" | "unchanged"; previousActiveRevision: number | null }> => {
  const installed = result.installation;
  const selectedModules = new Map(
    selectedReleaseSet.modules.map((module) => [module.rootId.toLowerCase(), module]),
  );
  if (
    !sameId(installed.organizationId, selector.organizationId) ||
    !sameId(installed.applicationRootId, selector.rootId) ||
    installed.applicationReleaseRevision !== selector.releaseRevision ||
    installed.moduleBindings.length !== selectedModules.size ||
    installed.moduleBindings.some((binding) => {
      const module = selectedModules.get(binding.moduleRootId.toLowerCase());
      return (
        binding.state !== "active" ||
        !sameId(binding.organizationId, selector.organizationId) ||
        !sameId(binding.applicationRootId, selector.rootId) ||
        binding.applicationReleaseRevision !== selector.releaseRevision ||
        module === undefined ||
        binding.moduleReleaseRevision !== module.releaseRevision
      );
    })
  )
    installationProblem("activation_result_mismatch", "failed");
  if (result.outcome === "activated") {
    if (result.previousApplicationReleaseRevision !== priorRevision)
      installationProblem("activation_prior_revision_mismatch", "conflict");
    return {
      outcome: "activated",
      previousActiveRevision: result.previousApplicationReleaseRevision,
    };
  }
  if (result.previousApplicationReleaseRevision !== selector.releaseRevision)
    installationProblem("activation_unchanged_revision_mismatch", "conflict");
  return { outcome: "unchanged", previousActiveRevision: null };
};

type UpgradeActivation = Readonly<{
  outcome: "activated" | "unchanged";
  previousActiveRevision: number | null;
  activeAtCommitRevision: number;
}>;

/**
 * Activates the selected release through the installation coordinator, held to the state the
 * install was authorised against, and proves the committed installation is exactly the selected
 * release.
 */
export const activateUpgradeRelease = async (
  environment: UpgradeEnvironment,
  selector: UpgradeSelector,
  state: UpgradeState,
  session: IdentitySession,
  beforeRegistration?: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
  ) => Promise<void>,
): Promise<UpgradeActivation> => {
  const priorRevision = state.active.applicationReleaseRevision;
  const result = await coordinatorFor(environment, selector, state, beforeRegistration).activate(
    session,
    {
      organizationId: state.active.organizationId,
      applicationRootId: selector.rootId,
      applicationReleaseRevision: selector.releaseRevision,
      expectedActiveReleaseRevision: priorRevision,
    },
  );
  const verified = verifyCoordinatorActivation(
    result,
    selector,
    priorRevision,
    state.selectedReleaseSet,
  );
  return { ...verified, activeAtCommitRevision: result.installation.applicationReleaseRevision };
};
