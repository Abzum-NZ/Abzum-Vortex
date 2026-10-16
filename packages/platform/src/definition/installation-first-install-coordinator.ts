import "server-only";

import type { RequestDatabaseTransaction } from "../db/index";
import {
  createBuilderAuthority,
  prepareApplicationRoleTemplatesForHumanRequest,
  type createHumanOrganizationRequestService,
  type HumanOrganizationRequestResult,
  type BuilderOperation,
} from "../access/index";
import {
  canonicalJson,
  sameId,
  type IdentitySession,
  type ModuleInstallationBindingEvidence,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";
import { DefinitionError } from "./definition-error";
import { resolveModuleContributions } from "./extension-contributions";
import { createApplicationInstallationCoordinator } from "./installation-coordinator";
import type {
  ApplicationInstallationActivationResult,
  HumanInstallationDefinitionAccess,
} from "./installation-coordinator-contracts";
import {
  firstInstallConferredPermissions,
  installationOperation,
  installationProblem,
  installationTargetFacts,
  readBuilderOperationDeadlines,
  readInstallationAuthorityDeadlines,
  readInstallationDatabaseTime,
  readInstallationHumanContext,
  readInstallationOrdinaryRoot,
  readInstallationPermissionDeadline,
  requireInstallationAuthority,
  type InstallationHumanContext,
  type InstallationProblemShape,
} from "./installation-authority";
import {
  readInstallationBindings,
  sortedBindingTuples,
  type InstallationBindings,
} from "./installation-binding-reader";
import type { FirstInstallEnvironment } from "./installation-first-install-app";
import {
  firstInstallHistoryMatchesDraft,
  readFirstInstallReleaseSet,
  sameFirstInstallRelease,
  type FirstInstallHistory,
  type FirstInstallRegistrationState,
  type FirstInstallSelector,
} from "./installation-first-install";
import { createPreparedInstallationRuntimeSourceReader } from "./prepared-installation-runtime-source";

type PreparedFirstInstallRegistration = ReturnType<typeof prepareApplicationRoleTemplatesForHumanRequest>;

/** What the first-install coordinator needs from the application: its request runner and the first-install reads. */
export type FirstInstallCoordinatorEnvironment = FirstInstallEnvironment &
  Readonly<{ requests: ReturnType<typeof createHumanOrganizationRequestService> }>;

/** The state the caller proved and showed the person before running a first-install command. */
type FirstInstallExpectation = Readonly<{
  history: FirstInstallHistory;
  selected: Readonly<{ definitionKey: string }>;
  registrationState: FirstInstallRegistrationState;
  registeredReleaseRevision: number | null;
  moduleBindings: readonly ModuleInstallationBindingEvidence[];
}>;

function problem(kind: InstallationProblemShape["kind"]): never {
  return installationProblem(kind, kind, undefined);
}

const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

const firstInstallDefinitionAccess = (
  environment: FirstInstallCoordinatorEnvironment,
  selector: FirstInstallSelector,
  history: FirstInstallHistory,
  expectedReleaseSet: SystemApplicationBoundReleaseSetResult,
  onPreparedRegistration: (prepared: PreparedFirstInstallRegistration) => void,
): HumanInstallationDefinitionAccess => ({
  async readReleaseSet(session, target) {
    if (!sameId(target.organizationId, selector.organizationId) ||
      !sameId(target.applicationRootId, selector.rootId) ||
      target.applicationReleaseRevision !== selector.releaseRevision)
      throw new DefinitionError("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    let callbackFailure: unknown;
    const result = await environment.requests.runChange(
      session,
      { organizationId: selector.organizationId },
      async (transaction, scope, issuedAt) => {
        try {
          if (scope.applicationRootId !== undefined) problem("refused");
          const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          await readInstallationOrdinaryRoot(transaction, selector.rootId);
          await requireInstallationAuthority(transaction, scope, environment.permissions, { kind: "draft_change", rootId: selector.rootId });
          await firstInstallHistoryMatchesDraft(
            transaction, scope, selector, history, expectedReleaseSet.application.definitionKey,
          );
          const releaseSet = await readFirstInstallReleaseSet(transaction, environment.catalogue, selector, context);
          if (!sameFirstInstallRelease(releaseSet, expectedReleaseSet)) problem("conflict");
          await firstInstallHistoryMatchesDraft(
            transaction, scope, selector, history, expectedReleaseSet.application.definitionKey,
          );
          const finalContext = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          if (!same(context, finalContext)) problem("refused");
          await requireInstallationAuthority(transaction, scope, environment.permissions, { kind: "draft_change", rootId: selector.rootId });
          await requireInstallationAuthority(transaction, scope, environment.permissions, installationOperation(selector.rootId, environment.containsCustomComponents(releaseSet)));
          const draftDeadline = await readInstallationPermissionDeadline(
            transaction, scope, finalContext, environment.permissions, "platform.organization.definition_drafts.manage",
          );
          const installDeadlines = await readInstallationAuthorityDeadlines(
            transaction, scope, finalContext, environment.permissions, selector.rootId, environment.containsCustomComponents(releaseSet),
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
    if (!sameId(target.organizationId, selector.organizationId) ||
      !sameId(target.applicationRootId, selector.rootId) ||
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
  selector: FirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
  state: "active" | "provisioned",
): boolean => {
  const relevant = bindings.moduleBindings.filter((binding) => binding.state !== "detached");
  return bindings.registeredReleaseRevision === selector.releaseRevision &&
    relevant.length === releaseSet.modules.length &&
    releaseSet.modules.every((module) => relevant.filter((binding) =>
      sameId(binding.organizationId, selector.organizationId) &&
      sameId(binding.applicationRootId, selector.rootId) &&
      sameId(binding.moduleRootId, module.rootId) &&
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
  selector: FirstInstallSelector,
  expected: FirstInstallExpectation,
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

/**
 * The installation coordinator for one first install: each of its two transactions re-proves the
 * history, release, bindings, context and authority around the coordinator's own write.
 */
export const createFirstInstallCoordinator = (
  environment: FirstInstallCoordinatorEnvironment,
  selector: FirstInstallSelector,
  expected: FirstInstallExpectation,
  expectedReleaseSet: SystemApplicationBoundReleaseSetResult,
  mode: "prepare" | "activate",
) => {
  let step = 0;
  let preparedRegistration: PreparedFirstInstallRegistration | undefined;
  const installerRequests: Pick<FirstInstallCoordinatorEnvironment["requests"], "runChange"> = {
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
      const result = await environment.requests.runChange(session, candidate, async (transaction, scope, issuedAt) => {
        try {
          if (!sameId(candidate.organizationId, selector.organizationId) ||
            candidate.applicationRootId !== undefined || scope.applicationRootId !== undefined)
            problem("refused");
          const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          await readInstallationOrdinaryRoot(transaction, selector.rootId);
          await requireInstallationAuthority(transaction, scope, environment.permissions, { kind: "draft_change", rootId: selector.rootId });
          await firstInstallHistoryMatchesDraft(
            transaction, scope, selector, expected.history, expected.selected.definitionKey,
          );
          const releaseSet = await readFirstInstallReleaseSet(transaction, environment.catalogue, selector, context);
          if (!sameFirstInstallRelease(releaseSet, expectedReleaseSet)) problem("conflict");
          await requireInstallationAuthority(transaction, scope, environment.permissions, installationOperation(selector.rootId, environment.containsCustomComponents(releaseSet)));
          const before = await readInstallationBindings(transaction, selector.rootId);
          if (currentStep === 0 && mode === "prepare" &&
            before.registeredReleaseRevision !== expected.registeredReleaseRevision)
            problem("conflict");
          if (!sameFirstInstallBindings(before, expected.moduleBindings)) problem("conflict");
          assertFirstInstallCoordinatorBoundary(
            mode, currentStep === 0 ? "before" : "after_first", selector, expected, releaseSet, before,
          );
          let registrationContext: InstallationHumanContext | undefined;
          let registrationDeadline: string | undefined;
          if (currentStep === 0 && mode === "prepare") {
            const prepared = preparedRegistration;
            if (prepared === undefined) problem("temporarily_unavailable");
            registrationContext = context;
            const draftDeadline = await readInstallationPermissionDeadline(
              transaction, scope, context, environment.permissions, "platform.organization.definition_drafts.manage",
            );
            const acceptedInstall = {
              ...installationOperation(selector.rootId, environment.containsCustomComponents(releaseSet)),
              acceptedPermissions: firstInstallConferredPermissions(prepared),
            } satisfies BuilderOperation;
            const installDeadlines = await readBuilderOperationDeadlines(
              transaction, scope, context, environment.permissions, acceptedInstall,
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
          await requireInstallationAuthority(transaction, scope, environment.permissions, { kind: "draft_change", rootId: selector.rootId });
          await requireInstallationAuthority(transaction, scope, environment.permissions, installationOperation(selector.rootId, environment.containsCustomComponents(releaseSet)));
          const draftDeadline = await readInstallationPermissionDeadline(
            transaction, scope, finalContext, environment.permissions, "platform.organization.definition_drafts.manage",
          );
          const installDeadlines = await readInstallationAuthorityDeadlines(
            transaction, scope, finalContext, environment.permissions, selector.rootId, environment.containsCustomComponents(releaseSet),
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
    builderAuthority: (transaction, scope) => createBuilderAuthority({ transaction, scope, targetFacts: installationTargetFacts, permissions: environment.permissions }),
    containsCustomComponents: environment.containsCustomComponents,
    humanDefinitionAccess: firstInstallDefinitionAccess(
      environment,
      selector,
      expected.history,
      expectedReleaseSet,
      (prepared) => { preparedRegistration = prepared; },
    ),
    preparedRuntimeSource: createPreparedInstallationRuntimeSourceReader(environment.catalogue),
  });
};

/** Proves the activation result names exactly the selected release and its modules, all active. */
export const verifyFirstInstallActivation = (
  result: ApplicationInstallationActivationResult<unknown>,
  selector: FirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
): void => {
  const installed = result.installation;
  const expectedModules = new Map(releaseSet.modules.map((module) => [module.rootId.toLowerCase(), module]));
  if (!sameId(installed.organizationId, selector.organizationId) ||
    !sameId(installed.applicationRootId, selector.rootId) ||
    installed.applicationReleaseRevision !== selector.releaseRevision ||
    installed.moduleBindings.length !== expectedModules.size ||
    new Set(installed.moduleBindings.map((binding) => binding.moduleRootId.toLowerCase())).size !== expectedModules.size ||
    installed.moduleBindings.some((binding) => {
      const module = expectedModules.get(binding.moduleRootId.toLowerCase());
      return binding.state !== "active" || !sameId(binding.organizationId, selector.organizationId) ||
        !sameId(binding.applicationRootId, selector.rootId) ||
        binding.applicationReleaseRevision !== selector.releaseRevision || module === undefined ||
        binding.moduleReleaseRevision !== module.releaseRevision;
    }) ||
    (result.outcome === "activated" && result.previousApplicationReleaseRevision !== null) ||
    (result.outcome === "unchanged" &&
      result.previousApplicationReleaseRevision !== selector.releaseRevision))
    problem("failed");
};
