import "server-only";

import { createHash } from "node:crypto";
import {
  createBuilderAuthority,
  prepareApplicationRoleTemplatesForHumanRequest,
  type BuilderOperation,
  type HumanOrganizationRequestResult,
} from "@vortex/platform/server";
import {
  createApplicationInstallationCoordinator,
  type ApplicationInstallationActivationResult,
  type HumanInstallationDefinitionAccess,
} from "@vortex/platform/server";
import {
  canonicalJson,
  describeFailure,
  moduleRootIdSchema,
  organizationIdSchema,
  sameId,
  systemApplicationBoundReleaseSetResultSchema,
  type ActiveApplicationInstallationEvidence,
  type IdentitySession,
  type ModuleInstallationBindingEvidence,
  type OrganizationLifecycleLimits,
  type OrganizationSelectionCandidate,
  type RecordTypeLifecyclePolicy,
  type StorageContractId,
  type SelectedOrganizationScope,
  type SystemApplicationBoundReleaseSetResult,
} from "@vortex/platform/schema";
import {
  FirstInstallUnavailable,
  InstallationArchiveConnectionError,
  InstallationProblem,
  ProvisionedSetupError,
  firstInstallConferredPermissions,
  firstInstallHistory,
  firstInstallHistoryMatchesDraft,
  firstInstallSelectedIdentity,
  firstInstallSetMatchesHistory,
  firstInstallState,
  firstInstallUnavailable,
  firstInstallWorkflows,
  readFirstInstallReleaseSet,
  sameFirstInstallRelease,
  installationOperation,
  installationProblem,
  installationTargetFacts,
  readBuilderOperationDeadlines,
  readInstallationAuthorityDeadlines,
  readInstallationBindings,
  readInstallationDatabaseTime,
  readInstallationHumanContext,
  readInstallationOrdinaryRoot,
  readInstallationPermissionDeadline,
  readInstallationReleaseSet,
  releaseSetModuleTuples,
  requireInstallationAuthority,
  sameActiveBindings,
  sortedBindingTuples,
  type InstallationBindings,
  type InstallationHumanContext,
  type InstallationProblemShape,
  initialLifecyclePolicyMatches,
  readProvisionedSetupAccessDecision,
  readProvisionedSetupInTransaction as readInstallationProvisionedSetup,
  type ProvisionedSetup,
  saveInitialArchiveWorkflowPolicy,
  workflowIsInExactRelease,
  type InitialLifecyclePolicyTarget,
  readInstallationArchiveConnectionOptions,
  readSelectedInstallationArchiveConnection,
} from "@vortex/platform/server";
import type { RequestDatabaseTransaction } from "@vortex/platform/server";
import {
  createDatabaseApplicationBoundReleaseSetService,
  createDatabaseApplicationReleaseAdoptionReleaseSetService,
  createDatabasePreparedInstallationRuntimeSourceService,
  resolveModuleContributions,
} from "@vortex/platform/server";
import { createActiveApplicationInstallationRepository } from "@vortex/platform/server";
import { createRecordTypeLifecyclePolicyService } from "@vortex/platform/server";
import type { z } from "zod";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue, releaseSetContainsCustomComponents } from "./definition-catalogue";
import { humanOrganizationRequestDependencies, humanOrganizationRequests } from "./server-composition";
import {
  inspectStudioApplicationReleaseHistory,
  loadStudioApplicationHistoryAccess,
} from "./studio-application-history";
import type {
  studioApplicationFirstInstallPolicyInputSchema,
  studioApplicationFirstInstallTargetSchema} from "./studio-application-installation-contracts";
import {
  studioApplicationInstallationCommandResultSchema,
  studioApplicationInstallationCommandSchema,
  studioApplicationInstallationLoadResultSchema,
  studioApplicationInstallationReleaseIdentitySchema,
  studioApplicationInstallationSelectorSchema,
  studioApplicationInstallationSnapshotSchema,
  studioApplicationArchiveOptionsQuerySchema,
  studioApplicationArchiveOptionsResultSchema,
  studioApplicationFirstInstallActivateCommandSchema,
  studioApplicationFirstInstallCommandResultSchema,
  studioApplicationFirstInstallLoadResultSchema,
  studioApplicationFirstInstallPrepareCommandSchema,
  studioApplicationFirstInstallSaveCommandSchema,
  studioApplicationFirstInstallSelectorSchema,
  studioApplicationFirstInstallSetupSchema,
  studioApplicationFirstInstallSnapshotSchema,
  type StudioApplicationArchiveOptionsResult,
  type StudioApplicationFirstInstallCommandResult,
  type StudioApplicationFirstInstallLoadResult,
  type StudioApplicationFirstInstallSelector,
  type StudioApplicationFirstInstallSnapshot,
  type StudioApplicationInstallationCommandResult,
  type StudioApplicationInstallationReleaseIdentity,
  type StudioApplicationInstallationSelector,
  type StudioApplicationInstallationSnapshot,
} from "./studio-application-installation-contracts";
import { DefinitionError, classifyDatabaseError } from "@vortex/platform/server";
import { platformPermissionSource } from "./platform-permission-source";

type HumanContext = InstallationHumanContext;
type PreparedFirstInstallRegistration = ReturnType<typeof prepareApplicationRoleTemplatesForHumanRequest>;
type ReleaseIdentityInput = Readonly<{
  releaseRevision: number;
  releaseVersion: string;
  validationContractVersion: string;
  contentFingerprint: string;
  resolutionFingerprint: string;
}>;

type ReadState = Readonly<{
  active: ActiveApplicationInstallationEvidence;
  activeReleaseSet: SystemApplicationBoundReleaseSetResult;
  selectedReleaseSet: SystemApplicationBoundReleaseSetResult;
  bindings: InstallationBindings;
}>;
type AuthorizedState = Readonly<{
  snapshot: StudioApplicationInstallationSnapshot;
  state: ReadState;
  checkedAt: string;
}>;

type Problem = InstallationProblemShape;

function problem(kind: Problem["kind"], unavailableReason?: Problem["unavailableReason"]): never {
  return installationProblem(unavailableReason ?? kind, kind, unavailableReason);
}

const safeFailure = (error: unknown): Problem => {
  console.error(`[studio] application installation failed: ${describeFailure(error)}`);
  if (error instanceof InstallationProblem) return error.problem;
  if (error instanceof InstallationArchiveConnectionError) return { kind: error.reason };
  if (error instanceof ProvisionedSetupError) return { kind: "refused" };
  if (error instanceof DefinitionError) {
    switch (error.code) {
      case "APPLICATION_INSTALLATION_STALE":
        return { kind: "conflict" };
      case "APPLICATION_INSTALLATION_PERMISSION_REFUSED":
      case "APPLICATION_INSTALLATION_REFUSED":
        return { kind: "refused" };
      case "APPLICATION_INSTALLATION_RECENT_AUTHENTICATION_REQUIRED":
        return { kind: "authentication_required" };
      case "APPLICATION_INSTALLATION_TEMPORARILY_UNAVAILABLE":
        return { kind: "temporarily_unavailable" };
      default:
        return { kind: "failed" };
    }
  }
  const kind = classifyDatabaseError(error);
  if (kind === "refused") return { kind: "refused" };
  if (kind === "conflict" || kind === "constraint_failed" || kind === "wrong_state")
    return { kind: "conflict" };
  return { kind: "temporarily_unavailable" };
};

const unavailable = (reason: NonNullable<Problem["unavailableReason"]>) =>
  studioApplicationInstallationLoadResultSchema.parse({ kind: "unavailable", reason });

const toLoadFailure = (failure: Problem) => {
  if (failure.unavailableReason !== undefined) return unavailable(failure.unavailableReason);
  if (failure.kind === "refused" || failure.kind === "authentication_required")
    return studioApplicationInstallationLoadResultSchema.parse({ kind: "refused" });
  return studioApplicationInstallationLoadResultSchema.parse({ kind: "temporarily_unavailable" });
};

const toCommandFailure = (
  failure: Problem,
  registrationMayHaveChanged: boolean | "unknown",
): StudioApplicationInstallationCommandResult =>
  studioApplicationInstallationCommandResultSchema.parse({
    kind: failure.kind,
    registrationMayHaveChanged,
  });

const exactSession = async (): Promise<IdentitySession | undefined> => {
  const resolved = await resolveIdentitySession();
  if (resolved.kind === "temporarily_unavailable") problem("temporarily_unavailable");
  return resolved.kind === "active" ? resolved.session : undefined;
};

const sameUuid = (left: string, right: string): boolean => sameId(left, right);

const releaseIdentity = (release: ReleaseIdentityInput): StudioApplicationInstallationReleaseIdentity => {
  const parsed = studioApplicationInstallationReleaseIdentitySchema.safeParse({
    releaseRevision: release.releaseRevision,
    releaseVersion: release.releaseVersion,
    validationContractVersion: release.validationContractVersion,
    contentFingerprint: release.contentFingerprint,
    resolutionFingerprint: release.resolutionFingerprint,
  });
  if (!parsed.success) problem("refused");
  return parsed.data;
};

const fingerprint = (domain: string, value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify([domain, value]), "utf8").digest("hex")}`;

const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

const readCurrentState = async (
  transaction: RequestDatabaseTransaction,
  selector: StudioApplicationInstallationSelector,
  context: HumanContext,
): Promise<ReadState> => {
  await readInstallationOrdinaryRoot(transaction, selector.rootId);
  let active: ActiveApplicationInstallationEvidence;
  try {
    active = await createActiveApplicationInstallationRepository(transaction).readCurrent();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code) : "";
    switch (code) {
      case "ACTIVE_APPLICATION_CONTEXT_REFUSED":
        problem("refused");
      case "ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE":
        problem("refused", "not_installed");
      case "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE":
        problem("refused", "installation_incomplete");
      default:
        problem("temporarily_unavailable");
    }
  }
  if (!sameUuid(active.organizationId, selector.organizationId) ||
    !sameUuid(active.applicationRootId, selector.rootId) || active.moduleBindings.length === 0)
    problem("refused", "installation_incomplete");
  const bindings = await readInstallationBindings(transaction, selector.rootId);
  if (!sameUuid(bindings.organizationId, selector.organizationId))
    problem("refused", "installation_incomplete");
  if (bindings.moduleBindings.some((binding) =>
    !sameUuid(binding.organizationId, selector.organizationId) ||
    !sameUuid(binding.applicationRootId, selector.rootId)))
    problem("refused", "installation_incomplete");
  const activeBindings = bindings.moduleBindings.filter((binding) => binding.state === "active");
  if (bindings.moduleBindings.some((binding) => binding.state !== "active" && binding.state !== "detached") ||
    !same(sortedBindingTuples(activeBindings), sortedBindingTuples(active.moduleBindings)) ||
    bindings.registeredReleaseRevision !== active.applicationReleaseRevision)
    problem("refused", bindings.registeredReleaseRevision !== active.applicationReleaseRevision
      ? "registration_misaligned" : "installation_incomplete");

  const activeReleaseSet = await readInstallationReleaseSet(
    transaction, installedReleaseCatalogue,
    selector.rootId,
    active.applicationReleaseRevision,
    selector.organizationId,
    context.correlationId,
  );
  const selectedReleaseSet = await readInstallationReleaseSet(
    transaction, installedReleaseCatalogue,
    selector.rootId,
    selector.releaseRevision,
    selector.organizationId,
    context.correlationId,
  );
  const activeModules = releaseSetModuleTuples(activeReleaseSet);
  if (activeModules.length !== active.moduleBindings.length ||
    active.moduleBindings.some((binding) => !activeReleaseSet.modules.some((module) =>
      sameUuid(module.rootId, binding.moduleRootId) && module.releaseRevision === binding.moduleReleaseRevision &&
      binding.applicationReleaseRevision === active.applicationReleaseRevision)))
    problem("refused", "installation_incomplete");
  return { active, activeReleaseSet, selectedReleaseSet, bindings };
};

const makeSnapshot = (
  selector: StudioApplicationInstallationSelector,
  state: ReadState,
  context: HumanContext,
  validUntil: string,
): StudioApplicationInstallationSnapshot => {
  const application = state.selectedReleaseSet.application;
  if (application.kind !== "application" ||
    !sameUuid(application.rootId, selector.rootId) ||
    !sameUuid(application.organizationId, selector.organizationId) ||
    state.activeReleaseSet.application.definitionKey !== application.definitionKey)
    problem("refused");
  const selected = releaseIdentity(application);
  const active = releaseIdentity(state.activeReleaseSet.application);
  const snapshot = studioApplicationInstallationSnapshotSchema.safeParse({
    organizationId: selector.organizationId,
    rootId: selector.rootId,
    definitionKey: application.definitionKey,
    selected,
    active,
    moduleSetFingerprint: fingerprint("vortex.studio.install.module-set.v1", releaseSetModuleTuples(state.selectedReleaseSet)),
    bindingSetFingerprint: fingerprint(
      "vortex.studio.install.binding-set.v1",
      sortedBindingTuples(state.bindings.moduleBindings),
    ),
    validUntil,
    correlationId: context.correlationId,
  });
  if (!snapshot.success) problem("temporarily_unavailable");
  return snapshot.data;
};

const assertStateEligible = (
  selector: StudioApplicationInstallationSelector,
  state: ReadState,
  allowEqual: boolean,
): void => {
  if (selector.releaseRevision < state.active.applicationReleaseRevision)
    problem("refused", "not_newer");
  const sameModules = same(
    releaseSetModuleTuples(state.activeReleaseSet),
    releaseSetModuleTuples(state.selectedReleaseSet),
  );
  if (selector.releaseRevision === state.active.applicationReleaseRevision) {
    if (!sameModules) problem("refused", "installation_incomplete");
    if (!allowEqual) problem("refused", "not_newer");
    return;
  }
  if (!sameModules) problem("refused", "module_set_changed");
};

const sameSnapshotState = (
  left: StudioApplicationInstallationSnapshot,
  right: StudioApplicationInstallationSnapshot,
): boolean => same({
  organizationId: left.organizationId,
  rootId: left.rootId,
  definitionKey: left.definitionKey,
  selected: left.selected,
  active: left.active,
  moduleSetFingerprint: left.moduleSetFingerprint,
  bindingSetFingerprint: left.bindingSetFingerprint,
}, {
  organizationId: right.organizationId,
  rootId: right.rootId,
  definitionKey: right.definitionKey,
  selected: right.selected,
  active: right.active,
  moduleSetFingerprint: right.moduleSetFingerprint,
  bindingSetFingerprint: right.bindingSetFingerprint,
});

const sameSelectedSnapshot = (
  expected: StudioApplicationInstallationSnapshot,
  current: StudioApplicationInstallationSnapshot,
): boolean => same({
  organizationId: expected.organizationId,
  rootId: expected.rootId,
  definitionKey: expected.definitionKey,
  selected: expected.selected,
  moduleSetFingerprint: expected.moduleSetFingerprint,
}, {
  organizationId: current.organizationId,
  rootId: current.rootId,
  definitionKey: current.definitionKey,
  selected: current.selected,
  moduleSetFingerprint: current.moduleSetFingerprint,
});

const withCurrentAuthorizedState = async (
  selector: StudioApplicationInstallationSelector,
  session: IdentitySession,
  allowEqual: boolean,
): Promise<AuthorizedState> => {
  let captured: Problem | undefined;
  const result = await humanOrganizationRequests().run(
    session,
    { organizationId: selector.organizationId, applicationRootId: selector.rootId },
    async (transaction, scope, issuedAt) => {
      try {
        const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
          organizationId: selector.organizationId,
          applicationRootId: selector.rootId,
        });
        await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId: selector.rootId });
        const firstState = await readCurrentState(transaction, selector, context);
        assertStateEligible(selector, firstState, allowEqual);
        await requireInstallationAuthority(transaction, scope, platformPermissionSource, installationOperation(selector.rootId, releaseSetContainsCustomComponents(firstState.selectedReleaseSet)));

        const finalContext = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
          organizationId: selector.organizationId,
          applicationRootId: selector.rootId,
        });
        if (!same(context, finalContext)) problem("refused");
        const finalState = await readCurrentState(transaction, selector, finalContext);
        assertStateEligible(selector, finalState, allowEqual);
        if (!same({
          active: firstState.active,
          activeReleaseSet: firstState.activeReleaseSet,
          selectedReleaseSet: firstState.selectedReleaseSet,
          bindings: firstState.bindings,
        }, {
          active: finalState.active,
          activeReleaseSet: finalState.activeReleaseSet,
          selectedReleaseSet: finalState.selectedReleaseSet,
          bindings: finalState.bindings,
        })) problem("conflict");
        await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId: selector.rootId });
        await requireInstallationAuthority(transaction, scope, platformPermissionSource, installationOperation(selector.rootId, releaseSetContainsCustomComponents(finalState.selectedReleaseSet)));

        const draftDeadline = await readInstallationPermissionDeadline(
          transaction, scope, finalContext, platformPermissionSource, "platform.organization.definition_drafts.manage",
        );
        const installationDeadlines = await readInstallationAuthorityDeadlines(
          transaction, scope, finalContext, platformPermissionSource, selector.rootId, releaseSetContainsCustomComponents(finalState.selectedReleaseSet),
        );
        const completedAt = await readInstallationDatabaseTime(transaction);
        const deadline = Math.min(
          Date.parse(finalContext.expiresAt),
          Date.parse(draftDeadline),
          ...installationDeadlines.map((validUntil) => Date.parse(validUntil)),
        );
        if (!Number.isFinite(deadline) || Date.parse(completedAt) >= deadline)
          problem("refused");
        return {
          snapshot: makeSnapshot(selector, finalState, finalContext, new Date(deadline).toISOString()),
          state: finalState,
          checkedAt: completedAt,
        };
      } catch (error) {
        captured = safeFailure(error);
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (captured !== undefined) throw new InstallationProblem(captured, "transaction_failure_captured");
  if (result.kind === "unavailable") problem("refused");
  problem("temporarily_unavailable");
};

const readActiveObservation = async (
  organizationId: SelectedOrganizationScope["organizationId"],
  rootId: StudioApplicationInstallationSelector["rootId"],
  session: IdentitySession,
): Promise<StudioApplicationInstallationReleaseIdentity> => {
  let captured: Problem | undefined;
  const result = await humanOrganizationRequests().run(
    session,
    { organizationId, applicationRootId: rootId },
    async (transaction, scope, issuedAt) => {
      try {
        const context = await readInstallationHumanContext(
          transaction, scope, session, issuedAt, { organizationId, applicationRootId: rootId },
        );
        await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId });
        const active = await createActiveApplicationInstallationRepository(transaction).readCurrent();
        if (!sameUuid(active.organizationId, organizationId) || !sameUuid(active.applicationRootId, rootId))
          problem("refused");
        const registration = await readInstallationBindings(transaction, rootId);
        const registeredActive = registration.moduleBindings.filter((binding) => binding.state === "active");
        if (!sameUuid(registration.organizationId, organizationId) ||
          !sameUuid(registration.applicationRootId, rootId) ||
          registration.moduleBindings.some((binding) =>
            !sameUuid(binding.organizationId, organizationId) || !sameUuid(binding.applicationRootId, rootId)) ||
          registration.registeredReleaseRevision !== active.applicationReleaseRevision ||
          registration.moduleBindings.some((binding) => binding.state !== "active" && binding.state !== "detached") ||
          !same(sortedBindingTuples(registeredActive), sortedBindingTuples(active.moduleBindings)))
          problem("refused");
        const releaseSet = await readInstallationReleaseSet(
    transaction, installedReleaseCatalogue,
    rootId, active.applicationReleaseRevision, organizationId, context.correlationId,
        );
        if (releaseSet.modules.length !== active.moduleBindings.length ||
          active.moduleBindings.some((binding) => !releaseSet.modules.some((module) =>
            sameUuid(module.rootId, binding.moduleRootId) && module.releaseRevision === binding.moduleReleaseRevision)))
          problem("refused");
        await readInstallationOrdinaryRoot(transaction, rootId);
        await requireInstallationAuthority(transaction, scope, platformPermissionSource, installationOperation(rootId, releaseSetContainsCustomComponents(releaseSet)));
        const finalContext = await readInstallationHumanContext(
          transaction, scope, session, issuedAt, { organizationId, applicationRootId: rootId },
        );
        if (!same(context, finalContext)) problem("refused");
        await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId });
        const draftDeadline = await readInstallationPermissionDeadline(
          transaction, scope, finalContext, platformPermissionSource, "platform.organization.definition_drafts.manage",
        );
        const installationDeadlines = await readInstallationAuthorityDeadlines(
          transaction, scope, finalContext, platformPermissionSource, rootId, releaseSetContainsCustomComponents(releaseSet),
        );
        const completedAt = await readInstallationDatabaseTime(transaction);
        const deadline = Math.min(
          Date.parse(finalContext.expiresAt),
          Date.parse(draftDeadline),
          ...installationDeadlines.map((validUntil) => Date.parse(validUntil)),
        );
        if (!Number.isFinite(deadline) || Date.parse(completedAt) >= deadline) problem("refused");
        return releaseIdentity(releaseSet.application);
      } catch (error) {
        captured = safeFailure(error);
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (captured !== undefined) throw new InstallationProblem(captured, "transaction_failure_captured");
  problem(result.kind === "unavailable" ? "refused" : "temporarily_unavailable");
};

export const loadStudioApplicationInstallation = async (
  organizationIdCandidate: string,
  selectorCandidate: unknown,
) => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const selector = studioApplicationInstallationSelectorSchema.safeParse(selectorCandidate);
  if (!organizationId.success || !selector.success ||
    !sameUuid(organizationId.data, selector.data.organizationId))
    return studioApplicationInstallationLoadResultSchema.parse({ kind: "refused" });
  try {
    const session = await exactSession();
    if (session === undefined) return studioApplicationInstallationLoadResultSchema.parse({ kind: "refused" });
    const authorized = await withCurrentAuthorizedState(selector.data, session, true);
    if (authorized.snapshot.selected.releaseRevision < authorized.snapshot.active.releaseRevision)
      return unavailable("not_newer");
    return studioApplicationInstallationLoadResultSchema.parse({
      kind: "available",
      snapshot: authorized.snapshot,
    });
  } catch (error) {
    return toLoadFailure(safeFailure(error));
  }
};

const humanDefinitionAccess = (): HumanInstallationDefinitionAccess => ({
  async readReleaseSet(session, target) {
    const result = await humanOrganizationRequests().run(
      session,
      { organizationId: target.organizationId, applicationRootId: target.applicationRootId },
      (transaction) => createDatabaseApplicationReleaseAdoptionReleaseSetService(
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
      { applicationRootId: target.applicationRootId, releaseRevision: target.applicationReleaseRevision },
      releaseSet,
    );
  },
});

const currentInstallationStateForCoordinator = async (
  transaction: RequestDatabaseTransaction,
  selector: StudioApplicationInstallationSelector,
  baseline: ReadState,
  step: number,
  context: HumanContext,
): Promise<void> => {
  const current = await readInstallationBindings(transaction, selector.rootId);
  if (!sameUuid(current.organizationId, selector.organizationId) ||
    !sameUuid(current.applicationRootId, selector.rootId) ||
    current.moduleBindings.some((binding) => binding.state !== "active" && binding.state !== "detached") ||
    !same(sortedBindingTuples(current.moduleBindings), sortedBindingTuples(baseline.bindings.moduleBindings)) ||
    !sameActiveBindings(current.moduleBindings.filter((binding) => binding.state === "active"), baseline.active.moduleBindings))
    problem("conflict");
  const allowedRegistrations = step === 0
    ? [baseline.active.applicationReleaseRevision]
    : [baseline.active.applicationReleaseRevision, selector.releaseRevision];
  if (!allowedRegistrations.includes(current.registeredReleaseRevision ?? -1))
    problem("conflict");
  if (!sameUuid(context.organizationId, selector.organizationId))
    problem("refused");
};

const coordinatorFor = (selector: StudioApplicationInstallationSelector, baseline: ReadState) => {
  const requests = humanOrganizationRequests();
  let step = 0;
  const installerRequests: Pick<ReturnType<typeof humanOrganizationRequests>, "runChange"> = {
    runChange: async <Result>(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      operation: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        issuedAt: string,
      ) => Promise<Result>,
    ): Promise<HumanOrganizationRequestResult<Result>> => {
      const thisStep = step++;
      // The existing coordinator can open a third, compensating Access transaction after a
      // failed switch. The same baseline guard below permits only restoration of this request's
      // exact prior registration; any further installer transaction is unexpected.
      if (thisStep > 2) problem("temporarily_unavailable");
      let callbackFailure: unknown;
      const result = await requests.runChange(session, candidate, async (transaction, scope, issuedAt) => {
        try {
          if (!sameUuid(scope.organizationId, selector.organizationId) || scope.applicationRootId !== undefined)
            problem("refused");
          const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          await readInstallationOrdinaryRoot(transaction, selector.rootId);
          await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId: selector.rootId });
          await currentInstallationStateForCoordinator(transaction, selector, baseline, thisStep, context);
          return await operation(transaction, scope, issuedAt);
        } catch (error) {
          callbackFailure = error;
          throw error;
        }
      });
      if (callbackFailure !== undefined) throw callbackFailure;
      return result;
    },
  };
  return createApplicationInstallationCoordinator({
    installerRequests,
    resolveModuleContributions,
    builderAuthority: (transaction, scope) => createBuilderAuthority({ transaction, scope, targetFacts: installationTargetFacts, permissions: platformPermissionSource }),
    containsCustomComponents: releaseSetContainsCustomComponents,
    humanDefinitionAccess: humanDefinitionAccess(),
  });
};

const verifyCoordinatorActivation = (
  result: ApplicationInstallationActivationResult<unknown>,
  selector: StudioApplicationInstallationSelector,
  priorRevision: number,
  selectedReleaseSet: SystemApplicationBoundReleaseSetResult,
): Readonly<{ outcome: "activated" | "unchanged"; previousActiveRevision: number | null }> => {
  const installed = result.installation;
  const selectedModules = new Map(selectedReleaseSet.modules.map((module) => [module.rootId.toLowerCase(), module]));
  if (!sameUuid(installed.organizationId, selector.organizationId) ||
    !sameUuid(installed.applicationRootId, selector.rootId) ||
    installed.applicationReleaseRevision !== selector.releaseRevision ||
    installed.moduleBindings.length !== selectedModules.size ||
    installed.moduleBindings.some((binding) => {
      const module = selectedModules.get(binding.moduleRootId.toLowerCase());
      return binding.state !== "active" || !sameUuid(binding.organizationId, selector.organizationId) ||
        !sameUuid(binding.applicationRootId, selector.rootId) ||
        binding.applicationReleaseRevision !== selector.releaseRevision || module === undefined ||
        binding.moduleReleaseRevision !== module.releaseRevision;
    })) problem("failed");
  if (result.outcome === "activated") {
    if (result.previousApplicationReleaseRevision !== priorRevision) problem("conflict");
    return { outcome: "activated", previousActiveRevision: result.previousApplicationReleaseRevision };
  }
  if (result.previousApplicationReleaseRevision !== selector.releaseRevision) problem("conflict");
  return { outcome: "unchanged", previousActiveRevision: null };
};

export const installSelectedStudioApplicationRelease = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationInstallationCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationInstallationCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !sameUuid(organizationId.data, command.data.selector.organizationId) ||
    !sameUuid(command.data.expected.organizationId, command.data.selector.organizationId) ||
    !sameUuid(command.data.expected.rootId, command.data.selector.rootId) ||
    command.data.expected.selected.releaseRevision !== command.data.selector.releaseRevision)
    return toCommandFailure({ kind: "refused" }, false);

  let invocationStarted = false;
  try {
    const session = await exactSession();
    if (session === undefined) return toCommandFailure({ kind: "refused" }, false);
    const current = await withCurrentAuthorizedState(command.data.selector, session, true);
    const currentSnapshot = current.snapshot;
    const now = Date.parse(current.checkedAt);
    if (!Number.isFinite(now) || Date.parse(command.data.expected.validUntil) <= now ||
      Date.parse(currentSnapshot.validUntil) <= now)
      return toCommandFailure({ kind: "conflict" }, false);

    const selected = current.snapshot.selected;
    const currentActiveRevision = current.state.active.applicationReleaseRevision;
    if (selected.releaseRevision === currentActiveRevision) {
      if (!sameSelectedSnapshot(command.data.expected, currentSnapshot) ||
        !same(current.snapshot.active, current.snapshot.selected))
        return toCommandFailure({ kind: "conflict" }, false);
      const postCommit = { kind: "observed" as const, active: current.snapshot.active };
      return studioApplicationInstallationCommandResultSchema.parse({
        kind: "completed",
        outcome: "unchanged",
        selected,
        previousActiveRevision: null,
        activeAtCommitRevision: currentActiveRevision,
        postCommit,
        registrationMayHaveChanged: false,
      });
    }
    if (!sameSnapshotState(command.data.expected, currentSnapshot))
      return toCommandFailure({ kind: "conflict" }, false);

    invocationStarted = true;
    const result = await coordinatorFor(command.data.selector, current.state).activate(session, {
      organizationId: current.state.active.organizationId,
      applicationRootId: command.data.selector.rootId,
      applicationReleaseRevision: command.data.selector.releaseRevision,
      expectedActiveReleaseRevision: currentActiveRevision,
    });
    const verified = verifyCoordinatorActivation(
      result,
      command.data.selector,
      currentActiveRevision,
      current.state.selectedReleaseSet,
    );
    let postCommit: { kind: "observed"; active: StudioApplicationInstallationReleaseIdentity } |
      { kind: "unavailable" } = { kind: "unavailable" };
    try {
      postCommit = {
        kind: "observed",
        active: await readActiveObservation(organizationId.data, command.data.selector.rootId, session),
      };
    } catch {
      postCommit = { kind: "unavailable" };
    }
    return studioApplicationInstallationCommandResultSchema.parse({
      kind: "completed",
      outcome: verified.outcome,
      selected,
      previousActiveRevision: verified.previousActiveRevision,
      activeAtCommitRevision: result.installation.applicationReleaseRevision,
      postCommit,
      registrationMayHaveChanged: invocationStarted,
    });
  } catch (error) {
    return toCommandFailure(safeFailure(error), invocationStarted ? "unknown" : false);
  }
};

const firstInstallSnapshot = (
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
  registrationState: StudioApplicationFirstInstallSnapshot["registrationState"],
  setup: unknown | null,
): StudioApplicationFirstInstallSnapshot => studioApplicationFirstInstallSnapshotSchema.parse({
  organizationId: selector.organizationId,
  rootId: selector.rootId,
  selected: firstInstallSelectedIdentity(releaseSet),
  history,
  registrationState,
  registeredReleaseRevision: bindings.registeredReleaseRevision,
  moduleBindings: bindings.moduleBindings,
  workflows: firstInstallWorkflows(releaseSet),
  setup,
});

const firstInstallLoadFailure = (error: unknown): StudioApplicationFirstInstallLoadResult => {
  if (error instanceof FirstInstallUnavailable)
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "unavailable", reason: error.reason });
  if (error instanceof ProvisionedSetupError && error.reason !== "refused") {
    console.error(`[studio] application installation failed: ${describeFailure(error)}`);
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "unavailable", reason: error.reason });
  }
  const failure = safeFailure(error);
  if (failure.kind === "conflict")
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "conflict" });
  if (failure.kind === "refused" || failure.kind === "authentication_required")
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "refused" });
  return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "temporarily_unavailable" });
};

const firstInstallCommandFailure = (
  error: unknown,
  stateMayHaveChanged: boolean | "unknown",
): StudioApplicationFirstInstallCommandResult => {
  const failure = error instanceof FirstInstallUnavailable
    ? error.reason === "already_installed"
      ? { kind: "conflict" as const }
      : { kind: "refused" as const }
    : safeFailure(error);
  return studioApplicationFirstInstallCommandResultSchema.parse({
    kind: failure.kind,
    stateMayHaveChanged,
  });
};

type FirstInstallCandidate = Readonly<{
  selector: StudioApplicationFirstInstallSelector;
  history: ReturnType<typeof firstInstallHistory>;
  releaseSet: SystemApplicationBoundReleaseSetResult;
  snapshot: StudioApplicationFirstInstallSnapshot;
  session: IdentitySession;
}>;

const readCurrentFirstInstallCandidate = async (
  selector: StudioApplicationFirstInstallSelector,
): Promise<FirstInstallCandidate> => {
  const session = await exactSession();
  if (session === undefined) problem("refused");
  const access = await loadStudioApplicationHistoryAccess(selector.organizationId, selector.rootId);
  if (access.kind !== "available") {
    if (access.kind === "conflict") problem("conflict");
    if (access.kind === "refused") problem("refused");
    problem("temporarily_unavailable");
  }
  const history = firstInstallHistory(access.snapshot);
  if (history.anchorReleaseRevision === null || selector.releaseRevision > history.anchorReleaseRevision)
    firstInstallUnavailable("release_not_published");
  const inspected = await inspectStudioApplicationReleaseHistory(selector.organizationId, {
    rootId: selector.rootId,
    expected: history,
    releaseRevision: selector.releaseRevision,
  });
  if (inspected.kind !== "available") {
    if (inspected.kind === "conflict") problem("conflict");
    if (inspected.kind === "refused") firstInstallUnavailable("release_not_published");
    problem("temporarily_unavailable");
  }
  const result = await humanOrganizationRequests().runChange(
    session,
    { organizationId: selector.organizationId },
    async (transaction, scope, issuedAt) => {
      const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
        organizationId: selector.organizationId,
      });
      if (scope.applicationRootId !== undefined) problem("refused");
      await readInstallationOrdinaryRoot(transaction, selector.rootId);
      await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId: selector.rootId });
      await firstInstallHistoryMatchesDraft(
        transaction, scope, selector, history, inspected.snapshot.definitionKey,
      );
      const releaseSet = await readFirstInstallReleaseSet(transaction, installedReleaseCatalogue, selector, context);
      if (!firstInstallSetMatchesHistory(releaseSet, inspected.metadata, selector) ||
        releaseSet.application.definitionKey !== inspected.snapshot.definitionKey)
        problem("conflict");
      await requireInstallationAuthority(transaction, scope, platformPermissionSource, installationOperation(selector.rootId, releaseSetContainsCustomComponents(releaseSet)));
      await firstInstallHistoryMatchesDraft(
        transaction, scope, selector, history, inspected.snapshot.definitionKey,
      );
      const bindings = await readInstallationBindings(transaction, selector.rootId);
      const finalContext = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
        organizationId: selector.organizationId,
      });
      if (!same(context, finalContext)) problem("refused");
      await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId: selector.rootId });
      await requireInstallationAuthority(transaction, scope, platformPermissionSource, installationOperation(selector.rootId, releaseSetContainsCustomComponents(releaseSet)));
      const draftDeadline = await readInstallationPermissionDeadline(
          transaction, scope, finalContext, platformPermissionSource, "platform.organization.definition_drafts.manage",
      );
      const installationDeadlines = await readInstallationAuthorityDeadlines(
          transaction, scope, finalContext, platformPermissionSource, selector.rootId, releaseSetContainsCustomComponents(releaseSet),
        );
      const checkedAt = await readInstallationDatabaseTime(transaction);
      if (Date.parse(checkedAt) >= Math.min(
        Date.parse(finalContext.expiresAt), Date.parse(draftDeadline),
        ...installationDeadlines.map((deadline) => Date.parse(deadline)),
      )) problem("refused");
      return { releaseSet, bindings };
    },
  );
  if (result.kind !== "available") problem(result.kind === "unavailable" ? "refused" : "temporarily_unavailable");
  const { releaseSet, bindings } = result.value;
  const registrationState = firstInstallState(selector, releaseSet, bindings);
  let setup: unknown | null = null;
  if (registrationState === "provisioned_inactive") {
    setup = await readCurrentProvisionedSetup(selector, history, releaseSet, session);
    if (setup === null) firstInstallUnavailable("setup_unavailable");
  }
  const snapshot = firstInstallSnapshot(
    selector, history, releaseSet, bindings, registrationState, setup,
  );
  return {
    selector,
    history,
    releaseSet,
    snapshot,
    session,
  };
};

const visiblePolicyBody = (policy: RecordTypeLifecyclePolicy) => {
  const common = {
    maxAgeDays: policy.maxAgeDays,
    maxCount: policy.maxCount,
    allowUnlimitedAge: policy.allowUnlimitedAge,
    allowUnlimitedCount: policy.allowUnlimitedCount,
  };
  return policy.action === "delete"
    ? {
        ...common,
        action: policy.action,
        ...(policy.recoveryWindowDays === undefined ? {} : { recoveryWindowDays: policy.recoveryWindowDays }),
      }
    : {
        ...common,
        action: policy.action,
        archiveWorkflowId: policy.archiveWorkflowId,
        expectedWorkflowRevision: policy.expectedWorkflowRevision,
        archiveConnectionInstanceId: policy.archiveConnectionInstanceId,
        archiveDestination: policy.archiveDestination,
        expectedConnectionRevision: policy.expectedConnectionRevision,
        expectedConnectionHealthOutcome: policy.expectedConnectionHealthOutcome,
      };
};

const visibleProvisionedSetup = (
  setup: ProvisionedSetup,
): z.infer<typeof studioApplicationFirstInstallSetupSchema> =>
  studioApplicationFirstInstallSetupSchema.parse({
    ...setup,
    targets: setup.targets.map((target) => ({
      ...target,
      policy: target.policy.state === "absent" ? target.policy : {
        ...target.policy,
        policyBody: visiblePolicyBody(target.policy.policyBody),
      },
    })),
  });

const readProvisionedSetupInTransaction = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  selector: StudioApplicationFirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
): Promise<z.infer<typeof studioApplicationFirstInstallSetupSchema>> =>
  visibleProvisionedSetup(await readInstallationProvisionedSetup(
    transaction, scope, session, issuedAt, selector, releaseSet, platformPermissionSource,
  ));

const readCurrentProvisionedSetup = async (
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  expectedReleaseSet: SystemApplicationBoundReleaseSetResult,
  session: IdentitySession,
): Promise<z.infer<typeof studioApplicationFirstInstallSetupSchema> | null> => {
  let callbackFailure: unknown;
  const result = await humanOrganizationRequests().runChange(
    session,
    { organizationId: selector.organizationId, applicationRootId: selector.rootId },
    async (transaction, scope, issuedAt) => {
      try {
        const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
          organizationId: selector.organizationId,
          applicationRootId: selector.rootId,
        });
        await readInstallationOrdinaryRoot(transaction, selector.rootId);
        await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId: selector.rootId });
        await firstInstallHistoryMatchesDraft(
          transaction, scope, selector, history, expectedReleaseSet.application.definitionKey,
        );
        const currentCandidate = await createDatabaseApplicationBoundReleaseSetService(
          installedReleaseCatalogue,
          transaction,
        ).read({ applicationReleaseRevision: selector.releaseRevision });
        const currentRelease = systemApplicationBoundReleaseSetResultSchema.safeParse(currentCandidate);
        if (!currentRelease.success ||
          !sameUuid(currentRelease.data.application.organizationId, selector.organizationId) ||
          !sameUuid(currentRelease.data.application.rootId, selector.rootId) ||
          !sameFirstInstallRelease(currentRelease.data, expectedReleaseSet))
          problem("conflict");
        await requireInstallationAuthority(transaction, scope, platformPermissionSource, installationOperation(selector.rootId, releaseSetContainsCustomComponents(currentRelease.data)));
        const setup = await readProvisionedSetupInTransaction(
          transaction, scope, session, issuedAt, selector, currentRelease.data,
        );
        await firstInstallHistoryMatchesDraft(
          transaction, scope, selector, history, expectedReleaseSet.application.definitionKey,
        );
        await firstInstallAppCompletion(
          transaction, scope, session, issuedAt, selector, history, currentRelease.data, context,
        );
        return setup;
      } catch (error) {
        callbackFailure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (callbackFailure !== undefined) throw callbackFailure;
  if (result.kind === "unavailable") problem("refused");
  problem("temporarily_unavailable");
};

export const loadStudioApplicationFirstInstall = async (
  organizationIdCandidate: string,
  selectorCandidate: unknown,
): Promise<StudioApplicationFirstInstallLoadResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const selector = studioApplicationFirstInstallSelectorSchema.safeParse(selectorCandidate);
  if (!organizationId.success || !selector.success ||
    !sameUuid(organizationId.data, selector.data.organizationId))
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "refused" });
  try {
    const current = await readCurrentFirstInstallCandidate(selector.data);
    return studioApplicationFirstInstallLoadResultSchema.parse({
      kind: "available",
      snapshot: current.snapshot,
    });
  } catch (error) {
    return firstInstallLoadFailure(error);
  }
};

const firstInstallDefinitionAccess = (
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  expectedReleaseSet: SystemApplicationBoundReleaseSetResult,
  onPreparedRegistration: (prepared: PreparedFirstInstallRegistration) => void,
): HumanInstallationDefinitionAccess => ({
  async readReleaseSet(session, target) {
    if (!sameUuid(target.organizationId, selector.organizationId) ||
      !sameUuid(target.applicationRootId, selector.rootId) ||
      target.applicationReleaseRevision !== selector.releaseRevision)
      throw new DefinitionError("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    let callbackFailure: unknown;
    const result = await humanOrganizationRequests().runChange(
      session,
      { organizationId: selector.organizationId },
      async (transaction, scope, issuedAt) => {
        try {
          if (scope.applicationRootId !== undefined) problem("refused");
          const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          await readInstallationOrdinaryRoot(transaction, selector.rootId);
          await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId: selector.rootId });
          await firstInstallHistoryMatchesDraft(
            transaction, scope, selector, history, expectedReleaseSet.application.definitionKey,
          );
          const releaseSet = await readFirstInstallReleaseSet(transaction, installedReleaseCatalogue, selector, context);
          if (!sameFirstInstallRelease(releaseSet, expectedReleaseSet)) problem("conflict");
          await firstInstallHistoryMatchesDraft(
            transaction, scope, selector, history, expectedReleaseSet.application.definitionKey,
          );
          const finalContext = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          if (!same(context, finalContext)) problem("refused");
          await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId: selector.rootId });
          await requireInstallationAuthority(transaction, scope, platformPermissionSource, installationOperation(selector.rootId, releaseSetContainsCustomComponents(releaseSet)));
          const draftDeadline = await readInstallationPermissionDeadline(
          transaction, scope, finalContext, platformPermissionSource, "platform.organization.definition_drafts.manage",
          );
          const installDeadlines = await readInstallationAuthorityDeadlines(
          transaction, scope, finalContext, platformPermissionSource, selector.rootId, releaseSetContainsCustomComponents(releaseSet),
        );
          const completedAt = await readInstallationDatabaseTime(transaction);
          if (Date.parse(completedAt) >= Math.min(
            Date.parse(finalContext.expiresAt), Date.parse(draftDeadline),
            ...installDeadlines.map((deadline) => Date.parse(deadline)),
          )) problem("refused");
          return releaseSet;
        } catch (error) {
          callbackFailure = error;
          throw error;
        }
      },
    );
    if (result.kind !== "available") {
      if (callbackFailure !== undefined) throw callbackFailure;
      throw new DefinitionError("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    }
    return result.value;
  },
  async prepareRegistrationCandidate(target, releaseSet) {
    if (!sameUuid(target.organizationId, selector.organizationId) ||
      !sameUuid(target.applicationRootId, selector.rootId) ||
      target.applicationReleaseRevision !== selector.releaseRevision ||
      !sameFirstInstallRelease(releaseSet, expectedReleaseSet))
      throw new DefinitionError("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    const prepared = prepareApplicationRoleTemplatesForHumanRequest(
      target.organizationId,
      { applicationRootId: target.applicationRootId, releaseRevision: target.applicationReleaseRevision },
      releaseSet,
    );
    onPreparedRegistration(prepared);
    return prepared;
  },
});

const exactFirstInstallBindings = (
  selector: StudioApplicationFirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
  state: "active" | "provisioned",
): boolean => {
  const relevant = bindings.moduleBindings.filter((binding) => binding.state !== "detached");
  return bindings.registeredReleaseRevision === selector.releaseRevision &&
    relevant.length === releaseSet.modules.length &&
    releaseSet.modules.every((module) => relevant.filter((binding) =>
      sameUuid(binding.organizationId, selector.organizationId) &&
      sameUuid(binding.applicationRootId, selector.rootId) &&
      sameUuid(binding.moduleRootId, module.rootId) &&
      binding.applicationReleaseRevision === selector.releaseRevision &&
      binding.moduleReleaseRevision === module.releaseRevision && binding.state === state).length === 1);
};

const sameFirstInstallBindings = (
  left: InstallationBindings,
  right: readonly ModuleInstallationBindingEvidence[],
): boolean => same(sortedBindingTuples(left.moduleBindings), sortedBindingTuples(right));

const assertFirstInstallCoordinatorBoundary = (
  mode: "prepare" | "activate",
  phase: "before" | "after_first" | "after_final",
  selector: StudioApplicationFirstInstallSelector,
  expected: StudioApplicationFirstInstallSnapshot,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
): void => {
  if (!sameFirstInstallBindings(bindings, expected.moduleBindings)) {
    if (!(phase === "after_final" && mode === "prepare" &&
      exactFirstInstallBindings(selector, releaseSet, bindings, "provisioned")) &&
      !(phase === "after_final" && mode === "activate" &&
        exactFirstInstallBindings(selector, releaseSet, bindings, "active")))
      problem("conflict");
  }
  if (phase === "before" && mode === "prepare" &&
    expected.registrationState !== "unprepared" &&
    expected.registrationState !== "registration_aligned_partial")
    problem("conflict");
  if (phase === "before" && mode === "activate" &&
    expected.registrationState !== "provisioned_inactive")
    problem("conflict");
  if ((phase === "after_first" || (phase === "before" && mode === "activate")) &&
    bindings.registeredReleaseRevision !== selector.releaseRevision)
    problem("conflict");
  if (phase === "after_final") {
    const expectedState = mode === "prepare" ? "provisioned" : "active";
    if (!exactFirstInstallBindings(selector, releaseSet, bindings, expectedState))
      problem("conflict");
  }
};

const firstInstallCoordinator = (
  selector: StudioApplicationFirstInstallSelector,
  expected: StudioApplicationFirstInstallSnapshot,
  expectedReleaseSet: SystemApplicationBoundReleaseSetResult,
  mode: "prepare" | "activate",
) => {
  const requests = humanOrganizationRequests();
  let step = 0;
  let preparedRegistration: PreparedFirstInstallRegistration | undefined;
  const installerRequests: Pick<ReturnType<typeof humanOrganizationRequests>, "runChange"> = {
    runChange: async <Result>(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      operation: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        issuedAt: string,
      ) => Promise<Result>,
    ): Promise<HumanOrganizationRequestResult<Result>> => {
      const currentStep = step++;
      if (currentStep > 1) problem("temporarily_unavailable");
      let callbackFailure: unknown;
      const result = await requests.runChange(session, candidate, async (transaction, scope, issuedAt) => {
        try {
          if (!sameUuid(candidate.organizationId, selector.organizationId) ||
            candidate.applicationRootId !== undefined || scope.applicationRootId !== undefined)
            problem("refused");
          const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          await readInstallationOrdinaryRoot(transaction, selector.rootId);
          await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId: selector.rootId });
          await firstInstallHistoryMatchesDraft(
            transaction, scope, selector, expected.history, expected.selected.definitionKey,
          );
          const releaseSet = await readFirstInstallReleaseSet(transaction, installedReleaseCatalogue, selector, context);
          if (!sameFirstInstallRelease(releaseSet, expectedReleaseSet)) problem("conflict");
          await requireInstallationAuthority(transaction, scope, platformPermissionSource, installationOperation(selector.rootId, releaseSetContainsCustomComponents(releaseSet)));
          const before = await readInstallationBindings(transaction, selector.rootId);
          if (currentStep === 0 && mode === "prepare" &&
            before.registeredReleaseRevision !== expected.registeredReleaseRevision)
            problem("conflict");
          if (!sameFirstInstallBindings(before, expected.moduleBindings)) problem("conflict");
          assertFirstInstallCoordinatorBoundary(
            mode, currentStep === 0 ? "before" : "after_first", selector, expected, releaseSet, before,
          );
          let registrationContext: HumanContext | undefined;
          let registrationDeadline: string | undefined;
          if (currentStep === 0 && mode === "prepare") {
            const prepared = preparedRegistration;
            if (prepared === undefined) problem("temporarily_unavailable");
            registrationContext = context;
            const draftDeadline = await readInstallationPermissionDeadline(
          transaction, scope, context, platformPermissionSource, "platform.organization.definition_drafts.manage",
            );
            const acceptedInstall = {
              ...installationOperation(selector.rootId, releaseSetContainsCustomComponents(releaseSet)),
              acceptedPermissions: firstInstallConferredPermissions(prepared),
            } satisfies BuilderOperation;
            const installDeadlines = await readBuilderOperationDeadlines(
              transaction, scope, context, platformPermissionSource, acceptedInstall,
            );
            registrationDeadline = [context.expiresAt, draftDeadline, ...installDeadlines]
              .reduce((earliest, deadline) =>
                Date.parse(deadline) < Date.parse(earliest) ? deadline : earliest);
            const prewriteAt = await readInstallationDatabaseTime(transaction);
            if (!Number.isFinite(Date.parse(prewriteAt)) ||
              !Number.isFinite(Date.parse(registrationDeadline)) ||
              Date.parse(prewriteAt) >= Date.parse(registrationDeadline)) problem("refused");
          }
          const value = await operation(transaction, scope, issuedAt);
          if (currentStep === 0 && mode === "prepare") {
            if (typeof value !== "boolean" || registrationContext === undefined ||
              registrationDeadline === undefined ||
              value !== (before.registeredReleaseRevision !== selector.releaseRevision))
              problem("conflict");
            const completedAt = await readInstallationDatabaseTime(transaction);
            if (!Number.isFinite(Date.parse(completedAt)) ||
              Date.parse(completedAt) >= Date.parse(registrationDeadline) ||
              Date.parse(completedAt) >= Date.parse(registrationContext.expiresAt))
              problem("refused");
            return value;
          }
          const after = await readInstallationBindings(transaction, selector.rootId);
          if (currentStep === 0) {
            if (after.registeredReleaseRevision !== selector.releaseRevision ||
              !sameFirstInstallBindings(after, expected.moduleBindings)) problem("conflict");
            assertFirstInstallCoordinatorBoundary(
              mode, "after_first", selector, expected, releaseSet, after,
            );
          } else {
            assertFirstInstallCoordinatorBoundary(
              mode, "after_final", selector, expected, releaseSet, after,
            );
          }
          await firstInstallHistoryMatchesDraft(
            transaction, scope, selector, expected.history, expected.selected.definitionKey,
          );
          const finalContext = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          if (!same(context, finalContext)) problem("refused");
          if (currentStep === 0) {
            const completedAt = await readInstallationDatabaseTime(transaction);
            if (Date.parse(finalContext.expiresAt) <= Date.parse(completedAt)) problem("refused");
            return value;
          }
          await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId: selector.rootId });
          await requireInstallationAuthority(transaction, scope, platformPermissionSource, installationOperation(selector.rootId, releaseSetContainsCustomComponents(releaseSet)));
          const draftDeadline = await readInstallationPermissionDeadline(
          transaction, scope, finalContext, platformPermissionSource, "platform.organization.definition_drafts.manage",
          );
          const installDeadlines = await readInstallationAuthorityDeadlines(
          transaction, scope, finalContext, platformPermissionSource, selector.rootId, releaseSetContainsCustomComponents(releaseSet),
        );
          const completedAt = await readInstallationDatabaseTime(transaction);
          if (Date.parse(completedAt) >= Math.min(
            Date.parse(finalContext.expiresAt), Date.parse(draftDeadline),
            ...installDeadlines.map((deadline) => Date.parse(deadline)),
          )) problem("refused");
          return value;
        } catch (error) {
          callbackFailure = error;
          throw error;
        }
      });
      if (callbackFailure !== undefined && result.kind !== "available") throw callbackFailure;
      return result;
    },
  };
  return createApplicationInstallationCoordinator({
    installerRequests,
    resolveModuleContributions,
    builderAuthority: (transaction, scope) => createBuilderAuthority({ transaction, scope, targetFacts: installationTargetFacts, permissions: platformPermissionSource }),
    containsCustomComponents: releaseSetContainsCustomComponents,
    humanDefinitionAccess: firstInstallDefinitionAccess(
      selector,
      expected.history,
      expectedReleaseSet,
      (prepared) => { preparedRegistration = prepared; },
    ),
    preparedRuntimeSource: (transaction, input) => {
      const moduleBindings = input.moduleBindings.map((binding) => {
        const moduleRootId = moduleRootIdSchema.safeParse(binding.moduleRootId);
        if (!moduleRootId.success)
          throw new DefinitionError("APPLICATION_INSTALLATION_FAILED");
        return { ...binding, moduleRootId: moduleRootId.data };
      });
      return createDatabasePreparedInstallationRuntimeSourceService(
        installedReleaseCatalogue,
        transaction,
      ).read({ ...input, moduleBindings });
    },
  });
};

const sameFirstInstallExpectation = (
  expected: StudioApplicationFirstInstallSnapshot,
  actual: StudioApplicationFirstInstallSnapshot,
): boolean => same(expected, actual);

export const prepareStudioApplicationFirstInstall = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationFirstInstallPrepareCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !sameUuid(organizationId.data, command.data.selector.organizationId) ||
    !sameUuid(command.data.expected.organizationId, command.data.selector.organizationId) ||
    !sameUuid(command.data.expected.rootId, command.data.selector.rootId) ||
    command.data.expected.selected.releaseRevision !== command.data.selector.releaseRevision)
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "refused", stateMayHaveChanged: false,
    });
  let invocationStarted = false;
  try {
    const current = await readCurrentFirstInstallCandidate(command.data.selector);
    if (!sameFirstInstallExpectation(command.data.expected, current.snapshot))
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    if (current.snapshot.registrationState !== "unprepared" &&
      current.snapshot.registrationState !== "registration_aligned_partial")
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    const coordinator = firstInstallCoordinator(
      current.selector, current.snapshot, current.releaseSet, "prepare",
    );
    invocationStarted = true;
    const outcome = await coordinator.prepare(current.session, {
      organizationId: current.selector.organizationId,
      applicationRootId: current.selector.rootId,
      applicationReleaseRevision: current.selector.releaseRevision,
    });
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "completed",
      action: "prepared",
      stateMayHaveChanged: outcome.outcome === "prepared",
    });
  } catch (error) {
    return firstInstallCommandFailure(error, invocationStarted ? "unknown" : false);
  }
};

const archiveOptionsFailure = (error: unknown): StudioApplicationArchiveOptionsResult => {
  const failure = safeFailure(error);
  if (failure.kind === "conflict")
    return studioApplicationArchiveOptionsResultSchema.parse({ kind: "conflict" });
  if (failure.kind === "refused" || failure.kind === "authentication_required")
    return studioApplicationArchiveOptionsResultSchema.parse({ kind: "refused" });
  return studioApplicationArchiveOptionsResultSchema.parse({ kind: "temporarily_unavailable" });
};

export const loadStudioApplicationArchiveOptions = async (
  organizationIdCandidate: string,
  queryCandidate: unknown,
): Promise<StudioApplicationArchiveOptionsResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const query = studioApplicationArchiveOptionsQuerySchema.safeParse(queryCandidate);
  if (!organizationId.success || !query.success ||
    !sameUuid(organizationId.data, query.data.selector.organizationId) ||
    !sameUuid(query.data.expected.organizationId, query.data.selector.organizationId) ||
    !sameUuid(query.data.expected.rootId, query.data.selector.rootId) ||
    query.data.expected.selected.releaseRevision !== query.data.selector.releaseRevision)
    return studioApplicationArchiveOptionsResultSchema.parse({ kind: "refused" });
  try {
    const current = await readCurrentFirstInstallCandidate(query.data.selector);
    if (!sameFirstInstallExpectation(query.data.expected, current.snapshot))
      return studioApplicationArchiveOptionsResultSchema.parse({ kind: "conflict" });
    const result = await runFirstInstallAppTransaction(
      current,
      query.data.expected,
      async (transaction, _scope, _issuedAt, initial) => {
        const target = currentTarget(initial.setup, query.data.storageContractId);
        if (target.policy.state !== "absent" || target.storageScope !== "application_contained" ||
          target.applicationRootId === null || !initial.setup.organizationLimits.allowedActions.includes("archive_workflow") ||
          initial.setup.organizationLimits.allowedArchiveDestinations.length === 0)
          problem("refused");
        const finalSetup = await readInstallationProvisionedSetup(
          transaction, _scope, current.session, _issuedAt, query.data.selector, initial.releaseSet, platformPermissionSource
        );
        if (!same(finalSetup, initial.internalSetup)) problem("conflict");
        const currentRelease = await readAppScopedFirstInstallReleaseSet(transaction, query.data.selector);
        if (!sameFirstInstallRelease(currentRelease, initial.releaseSet)) problem("conflict");
        const retainedFence = await firstInstallAppCompletion(
          transaction, _scope, current.session, _issuedAt, query.data.selector,
          query.data.expected.history, currentRelease, initial.context,
        );
        const page = await readInstallationArchiveConnectionOptions(
          transaction,
          query.data.selector.organizationId,
          query.data.selector.rootId,
          initial.setup.organizationLimits.allowedArchiveDestinations,
          query.data.afterConnectionInstanceId,
        );
        await completeFirstInstallConnectionRead(
          transaction,
          _scope,
          current.session,
          _issuedAt,
          query.data.selector,
          query.data.expected.history,
          initial,
          retainedFence,
        );
        return studioApplicationArchiveOptionsResultSchema.parse({
          kind: "available",
          options: page.options.map(({ destinationFingerprint: _privateFingerprint, ...option }) => option),
          ...(page.nextAfterConnectionInstanceId === undefined
            ? {}
            : { nextAfterConnectionInstanceId: page.nextAfterConnectionInstanceId }),
        });
      },
      true,
    );
    return result;
  } catch (error) {
    return archiveOptionsFailure(error);
  }
};

const initialPolicyTarget = (
  candidate: FirstInstallCandidate,
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
): InitialLifecyclePolicyTarget => ({
  organizationId: candidate.selector.organizationId,
  installationRootId: candidate.selector.rootId,
  releaseRevision: candidate.selector.releaseRevision,
  storageContractId: target.storageContractId,
  applicationRootId: target.applicationRootId,
});

const saveDeleteInitialPolicy = async (
  candidate: FirstInstallCandidate,
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
  expectedBindingRevision: number,
  expectedSettingsRevision: number,
  policy: Extract<z.infer<typeof studioApplicationFirstInstallPolicyInputSchema>, { action: "delete" }>,
): Promise<RecordTypeLifecyclePolicy> => {
  if (!target.sourceBindings.some((binding) => binding.bindingRevision === expectedBindingRevision))
    problem("conflict");
  const service = createRecordTypeLifecyclePolicyService(humanOrganizationRequestDependencies());
  const result = await service.saveInitialForProvisionedSetup(candidate.session, initialPolicyCommand(
    candidate, target, expectedBindingRevision, expectedSettingsRevision, policy,
  ));
  if (result.kind !== "available") {
    if (result.kind === "unavailable") problem("refused");
    problem("temporarily_unavailable");
  }
  return initialLifecyclePolicyMatches(result.value, initialPolicyTarget(candidate, target), policy);
};

const readAppScopedFirstInstallReleaseSet = async (
  transaction: RequestDatabaseTransaction,
  selector: StudioApplicationFirstInstallSelector,
): Promise<SystemApplicationBoundReleaseSetResult> => {
  let candidate: unknown;
  try {
    candidate = await createDatabaseApplicationBoundReleaseSetService(
      installedReleaseCatalogue,
      transaction,
    ).read({ applicationReleaseRevision: selector.releaseRevision });
  } catch (error) {
    if (!(error instanceof DefinitionError) || error.code === "DEFINITION_READ_FAILED")
      problem("temporarily_unavailable");
    problem("refused");
  }
  const parsed = systemApplicationBoundReleaseSetResultSchema.safeParse(candidate);
  if (!parsed.success) throw new FirstInstallUnavailable("setup_unavailable");
  const releaseSet = parsed.data;
  if (!sameUuid(releaseSet.application.organizationId, selector.organizationId) ||
    !sameUuid(releaseSet.application.rootId, selector.rootId) ||
    releaseSet.application.releaseRevision !== selector.releaseRevision ||
    releaseSet.modules.length === 0)
    throw new FirstInstallUnavailable("setup_unavailable");
  return releaseSet;
};

const firstInstallAppCompletion = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  initialContext: HumanContext,
): Promise<Readonly<{ checkedAt: string; minimumValidUntil: string }>> => {
  await firstInstallHistoryMatchesDraft(
    transaction, scope, selector, history, releaseSet.application.definitionKey,
  );
  await readInstallationOrdinaryRoot(transaction, selector.rootId);
  await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId: selector.rootId });
  await requireInstallationAuthority(transaction, scope, platformPermissionSource, installationOperation(selector.rootId, releaseSetContainsCustomComponents(releaseSet)));
  const finalContext = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
    organizationId: selector.organizationId,
    applicationRootId: selector.rootId,
  });
  if (!same(initialContext, finalContext)) problem("refused");
  const draftDeadline = await readInstallationPermissionDeadline(
          transaction, scope, finalContext, platformPermissionSource, "platform.organization.definition_drafts.manage",
  );
  const installDeadlines = await readInstallationAuthorityDeadlines(
          transaction, scope, finalContext, platformPermissionSource, selector.rootId, releaseSetContainsCustomComponents(releaseSet),
        );
  const setupDecisions = await Promise.all([
    readProvisionedSetupAccessDecision(transaction, scope, platformPermissionSource, "platform.organization.applications.install"),
    readProvisionedSetupAccessDecision(transaction, scope, platformPermissionSource, "platform.organization.applications.install_scope"),
    readProvisionedSetupAccessDecision(transaction, scope, platformPermissionSource, "platform.organization.record_lifecycle.manage_policy"),
  ]);
  const completedAt = await readInstallationDatabaseTime(transaction);
  const retainedDeadlines = [draftDeadline, ...installDeadlines,
    ...setupDecisions.map((decision) => decision.validUntil)];
  let minimumValidUntil = finalContext.expiresAt;
  for (const deadline of retainedDeadlines) {
    const deadlineMs = Date.parse(deadline);
    if (!Number.isFinite(deadlineMs)) problem("refused");
    if (deadlineMs < Date.parse(minimumValidUntil)) minimumValidUntil = deadline;
  }
  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(completedAtMs) || !Number.isFinite(Date.parse(minimumValidUntil)) ||
    completedAtMs >= Date.parse(minimumValidUntil) || setupDecisions.some((decision) =>
    !sameUuid(decision.correlationId, finalContext.correlationId) ||
    decision.accessVersion !== finalContext.accessVersion ||
    Date.parse(decision.checkedAt) > completedAtMs)) problem("refused");
  return { checkedAt: completedAt, minimumValidUntil };
}

type FirstInstallAppState = Readonly<{
  context: HumanContext;
  releaseSet: SystemApplicationBoundReleaseSetResult;
  bindings: InstallationBindings;
  setup: z.infer<typeof studioApplicationFirstInstallSetupSchema>;
  internalSetup: ProvisionedSetup;
}>;

const readFirstInstallAppState = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  selector: StudioApplicationFirstInstallSelector,
  expected: StudioApplicationFirstInstallSnapshot,
): Promise<FirstInstallAppState> => {
  const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
    organizationId: selector.organizationId,
    applicationRootId: selector.rootId,
  });
  await readInstallationOrdinaryRoot(transaction, selector.rootId);
  await requireInstallationAuthority(transaction, scope, platformPermissionSource, { kind: "draft_change", rootId: selector.rootId });
  await firstInstallHistoryMatchesDraft(
    transaction, scope, selector, expected.history, expected.selected.definitionKey,
  );
  const releaseSet = await readAppScopedFirstInstallReleaseSet(transaction, selector);
  if (!same(firstInstallSelectedIdentity(releaseSet), expected.selected) ||
    !same(firstInstallWorkflows(releaseSet), expected.workflows)) problem("conflict");
  await requireInstallationAuthority(transaction, scope, platformPermissionSource, installationOperation(selector.rootId, releaseSetContainsCustomComponents(releaseSet)));
  const bindings = await readInstallationBindings(transaction, selector.rootId);
  const state = firstInstallState(selector, releaseSet, bindings);
  if (state !== "provisioned_inactive") firstInstallUnavailable("installation_incomplete");
  const internalSetup = await readInstallationProvisionedSetup(
    transaction, scope, session, issuedAt, selector, releaseSet, platformPermissionSource
  );
  const setup = visibleProvisionedSetup(internalSetup);
  const current = firstInstallSnapshot(selector, expected.history, releaseSet, bindings, state, setup);
  if (!sameFirstInstallExpectation(expected, current)) problem("conflict");
  return { context, releaseSet, bindings, setup, internalSetup };
};

const completeFirstInstallConnectionRead = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  initial: FirstInstallAppState,
  retainedFence: Awaited<ReturnType<typeof firstInstallAppCompletion>>,
): Promise<void> => {
  const currentRelease = await readAppScopedFirstInstallReleaseSet(transaction, selector);
  if (!sameFirstInstallRelease(currentRelease, initial.releaseSet)) problem("conflict");
  const currentSetup = await readInstallationProvisionedSetup(
    transaction, scope, session, issuedAt, selector, currentRelease, platformPermissionSource
  );
  if (!same(currentSetup, initial.internalSetup)) problem("conflict");
  const completed = await firstInstallAppCompletion(
    transaction, scope, session, issuedAt, selector, history, currentRelease, initial.context,
  );
  if (Date.parse(completed.checkedAt) >= Date.parse(retainedFence.minimumValidUntil))
    problem("refused");
};

type FirstInstallTransactionAction<Value> = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  issuedAt: string,
  initial: FirstInstallAppState,
) => Promise<Value>;

const runFirstInstallAppTransaction = async <Value>(
  candidate: FirstInstallCandidate,
  expected: StudioApplicationFirstInstallSnapshot,
  action: FirstInstallTransactionAction<Value>,
  actionIsFinalDatabaseOperation = false,
): Promise<Value> => {
  let callbackFailure: unknown;
  const result = await humanOrganizationRequests().runChange(
    candidate.session,
    { organizationId: candidate.selector.organizationId, applicationRootId: candidate.selector.rootId },
    async (transaction, scope, issuedAt) => {
      try {
        const initial = await readFirstInstallAppState(
          transaction, scope, candidate.session, issuedAt, candidate.selector, expected,
        );
        const value = await action(transaction, scope, issuedAt, initial);
        if (!actionIsFinalDatabaseOperation) {
          const currentRelease = await readAppScopedFirstInstallReleaseSet(transaction, candidate.selector);
          if (!sameFirstInstallRelease(currentRelease, initial.releaseSet)) problem("conflict");
          await firstInstallAppCompletion(
            transaction, scope, candidate.session, issuedAt, candidate.selector,
            expected.history, currentRelease, initial.context,
          );
        }
        return value;
      } catch (error) {
        callbackFailure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (callbackFailure !== undefined) throw callbackFailure;
  if (result.kind === "unavailable") problem("refused");
  problem("temporarily_unavailable");
};

const currentTarget = (
  setup: z.infer<typeof studioApplicationFirstInstallSetupSchema>,
  storageContractId: StorageContractId,
) => {
  const matching = setup.targets.filter((target) => sameUuid(target.storageContractId, storageContractId));
  if (matching.length !== 1) problem("conflict");
  const target = matching[0];
  if (target === undefined) problem("conflict");
  return target;
};

const assertPolicyCommonFields = (
  policy: z.infer<typeof studioApplicationFirstInstallPolicyInputSchema>,
  limits: OrganizationLifecycleLimits,
): void => {
  if (!limits.allowedActions.includes(policy.action) ||
    (policy.allowUnlimitedAge && policy.maxAgeDays !== null) ||
    (!policy.allowUnlimitedAge && policy.maxAgeDays === null) ||
    (policy.allowUnlimitedCount && policy.maxCount !== null) ||
    (!policy.allowUnlimitedCount && policy.maxCount === null) ||
    (policy.maxAgeDays !== null && limits.maxRetentionDays !== null &&
      limits.maxRetentionDays !== undefined && policy.maxAgeDays > limits.maxRetentionDays) ||
    (policy.maxCount !== null && limits.maxRecordCount !== null &&
      limits.maxRecordCount !== undefined && policy.maxCount > limits.maxRecordCount) ||
    (policy.allowUnlimitedAge && !limits.allowUnlimitedRetentionDays) ||
    (policy.allowUnlimitedCount && !limits.allowUnlimitedRecordCount))
    problem("refused");
};

const initialPolicyCommand = (
  candidate: FirstInstallCandidate,
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
  expectedBindingRevision: number,
  expectedSettingsRevision: number,
  policy: z.infer<typeof studioApplicationFirstInstallPolicyInputSchema>,
) => ({
  organizationId: candidate.selector.organizationId,
  bindingApplicationRootId: candidate.selector.rootId,
  expectedBindingRevision,
  storageContractId: target.storageContractId,
  applicationRootId: target.applicationRootId,
  expectedSettingsRevision,
  policy,
});

const firstInstallCommandMatches = (
  organizationId: string,
  selector: StudioApplicationFirstInstallSelector,
  expected: StudioApplicationFirstInstallSnapshot,
): boolean => sameUuid(organizationId, selector.organizationId) &&
  sameUuid(expected.organizationId, selector.organizationId) &&
  sameUuid(expected.rootId, selector.rootId) &&
  expected.selected.releaseRevision === selector.releaseRevision;

const assertInitialPolicyTarget = (
  setup: z.infer<typeof studioApplicationFirstInstallSetupSchema>,
  command: z.infer<typeof studioApplicationFirstInstallSaveCommandSchema>,
): z.infer<typeof studioApplicationFirstInstallTargetSchema> => {
  const target = currentTarget(setup, command.storageContractId);
  if ((target.applicationRootId === null) !== (command.targetApplicationRootId === null) ||
    (target.applicationRootId !== null && command.targetApplicationRootId !== null &&
      !sameUuid(target.applicationRootId, command.targetApplicationRootId)) ||
    target.policy.state !== "absent" ||
    setup.organizationLimits.settingsRevision !== command.expectedSettingsRevision ||
    !target.sourceBindings.some((binding) =>
      binding.bindingRevision === command.expectedBindingRevision))
    problem("conflict");
  assertPolicyCommonFields(command.policy, setup.organizationLimits);
  if (command.policy.action === "archive_workflow" &&
    (target.storageScope !== "application_contained" ||
      target.applicationRootId === null ||
      !sameUuid(target.applicationRootId, command.selector.rootId)))
    problem("refused");
  return target;
};

const freshSavedPolicyIsObserved = async (
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  selected: StudioApplicationFirstInstallSnapshot["selected"],
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
  saved: RecordTypeLifecyclePolicy,
): Promise<void> => {
  const current = await readCurrentFirstInstallCandidate(selector);
  if (!same(current.snapshot.history, history) || !same(current.snapshot.selected, selected))
    problem("conflict");
  if (current.snapshot.registrationState === "active_exact") return;
  if (current.snapshot.registrationState !== "provisioned_inactive" || current.snapshot.setup === null)
    problem("temporarily_unavailable");
  const observedTarget = currentTarget(current.snapshot.setup, target.storageContractId);
  if (observedTarget.policy.state !== "configured" ||
    !sameUuid(observedTarget.policy.policyId, saved.policyId) ||
    observedTarget.policy.policyRevision !== saved.policyRevision ||
    !same(observedTarget.policy.policyBody, visiblePolicyBody(saved)))
    problem("temporarily_unavailable");
};

export const saveStudioApplicationFirstInstallPolicy = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationFirstInstallSaveCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !firstInstallCommandMatches(organizationId.data, command.data.selector, command.data.expected))
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "refused", stateMayHaveChanged: false,
    });

  let invocationStarted = false;
  try {
    const candidate = await readCurrentFirstInstallCandidate(command.data.selector);
    if (!sameFirstInstallExpectation(command.data.expected, candidate.snapshot))
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    if (candidate.snapshot.registrationState !== "provisioned_inactive" ||
      candidate.snapshot.setup === null)
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    const target = assertInitialPolicyTarget(candidate.snapshot.setup, command.data);
    const selectedPolicy = command.data.policy;
    let saved: RecordTypeLifecyclePolicy;
    if (selectedPolicy.action === "delete") {
      await runFirstInstallAppTransaction(candidate, command.data.expected,
        async (_transaction, _scope, _issuedAt, initial) => {
          const currentTargetValue = assertInitialPolicyTarget(initial.setup, command.data);
          if (!same(currentTargetValue, target)) problem("conflict");
        });
      invocationStarted = true;
      saved = await saveDeleteInitialPolicy(
        candidate,
        target,
        command.data.expectedBindingRevision,
        command.data.expectedSettingsRevision,
        selectedPolicy,
      );
    } else {
      const archivePolicy = selectedPolicy;
      saved = await runFirstInstallAppTransaction(candidate, command.data.expected,
        async (transaction, scope, issuedAt, initial) => {
          const currentTargetValue = assertInitialPolicyTarget(initial.setup, command.data);
          if (!same(currentTargetValue, target) || !same(initial.setup, candidate.snapshot.setup))
            problem("conflict");
          if (!workflowIsInExactRelease(
            initial.releaseSet, command.data.selector.rootId, archivePolicy.archiveWorkflowId,
          )) problem("refused");
          const currentRelease = await readAppScopedFirstInstallReleaseSet(transaction, command.data.selector);
          if (!sameFirstInstallRelease(currentRelease, initial.releaseSet)) problem("conflict");
          const currentSetup = await readInstallationProvisionedSetup(
            transaction, scope, candidate.session, issuedAt, command.data.selector, currentRelease, platformPermissionSource
          );
          if (!same(currentSetup, initial.internalSetup)) problem("conflict");
          const retainedFence = await firstInstallAppCompletion(
            transaction, scope, candidate.session, issuedAt, command.data.selector,
            command.data.expected.history, currentRelease, initial.context,
          );
          const option = await readSelectedInstallationArchiveConnection(
            transaction,
            command.data.selector.organizationId,
            command.data.selector.rootId,
            initial.setup.organizationLimits.allowedArchiveDestinations,
            {
              connectionInstanceId: archivePolicy.archiveConnectionInstanceId,
              destinationKey: archivePolicy.archiveDestination,
              expectedRevision: archivePolicy.expectedConnectionRevision,
            },
          );
          await completeFirstInstallConnectionRead(
            transaction,
            scope,
            candidate.session,
            issuedAt,
            command.data.selector,
            command.data.expected.history,
            initial,
            retainedFence,
          );
          invocationStarted = true;
          return saveInitialArchiveWorkflowPolicy(
            transaction,
            initialPolicyTarget(candidate, currentTargetValue),
            candidate.releaseSet,
            currentTargetValue.sourceBindings.map((binding) => binding.bindingRevision),
            command.data.expectedBindingRevision,
            command.data.expectedSettingsRevision,
            archivePolicy,
            option,
          );
        }, true);
    }
    await freshSavedPolicyIsObserved(
      candidate.selector, candidate.history, candidate.snapshot.selected, target, saved,
    );
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "completed", action: "policy_saved", stateMayHaveChanged: true,
    });
  } catch (error) {
    return firstInstallCommandFailure(error, invocationStarted ? "unknown" : false);
  }
};

const verifyFirstInstallActivation = (
  result: ApplicationInstallationActivationResult<unknown>,
  selector: StudioApplicationFirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
): void => {
  const installed = result.installation;
  const expectedModules = new Map(releaseSet.modules.map((module) => [module.rootId.toLowerCase(), module]));
  if (!sameUuid(installed.organizationId, selector.organizationId) ||
    !sameUuid(installed.applicationRootId, selector.rootId) ||
    installed.applicationReleaseRevision !== selector.releaseRevision ||
    installed.moduleBindings.length !== expectedModules.size ||
    new Set(installed.moduleBindings.map((binding) => binding.moduleRootId.toLowerCase())).size !== expectedModules.size ||
    installed.moduleBindings.some((binding) => {
      const module = expectedModules.get(binding.moduleRootId.toLowerCase());
      return binding.state !== "active" || !sameUuid(binding.organizationId, selector.organizationId) ||
        !sameUuid(binding.applicationRootId, selector.rootId) ||
        binding.applicationReleaseRevision !== selector.releaseRevision || module === undefined ||
        binding.moduleReleaseRevision !== module.releaseRevision;
    }) ||
    (result.outcome === "activated" && result.previousApplicationReleaseRevision !== null) ||
    (result.outcome === "unchanged" &&
      result.previousApplicationReleaseRevision !== selector.releaseRevision))
    problem("failed");
};

export const activateStudioApplicationFirstInstall = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationFirstInstallActivateCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !firstInstallCommandMatches(organizationId.data, command.data.selector, command.data.expected))
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "refused", stateMayHaveChanged: false,
    });

  let invocationStarted = false;
  try {
    const candidate = await readCurrentFirstInstallCandidate(command.data.selector);
    if (!sameFirstInstallExpectation(command.data.expected, candidate.snapshot))
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    if (candidate.snapshot.registrationState !== "provisioned_inactive" ||
      candidate.snapshot.setup === null ||
      candidate.snapshot.setup.targets.some((target) => target.policy.state !== "configured"))
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "refused", stateMayHaveChanged: false,
      });

    const coordinator = firstInstallCoordinator(
      candidate.selector, candidate.snapshot, candidate.releaseSet, "activate",
    );
    invocationStarted = true;
    const result = await coordinator.activate(candidate.session, {
      organizationId: candidate.selector.organizationId,
      applicationRootId: candidate.selector.rootId,
      applicationReleaseRevision: candidate.selector.releaseRevision,
      expectedActiveReleaseRevision: null,
    });
    verifyFirstInstallActivation(result, candidate.selector, candidate.releaseSet);
    let postCommit: { kind: "observed"; activeReleaseRevision: number } | { kind: "unavailable" } = {
      kind: "unavailable",
    };
    try {
      const observed = await readActiveObservation(
        candidate.selector.organizationId, candidate.selector.rootId, candidate.session,
      );
      postCommit = { kind: "observed", activeReleaseRevision: observed.releaseRevision };
    } catch {
      postCommit = { kind: "unavailable" };
    }
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "completed",
      action: result.outcome === "activated" ? "activated" : "unchanged",
      activeAtCommitRevision: result.installation.applicationReleaseRevision,
      postCommit,
      stateMayHaveChanged: true,
    });
  } catch (error) {
    return firstInstallCommandFailure(error, invocationStarted ? "unknown" : false);
  }
};
