import "server-only";

import type { RequestDatabaseTransaction } from "../db/index";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import {
  canonicalJson,
  sameId,
  systemApplicationBoundReleaseSetResultSchema,
  type IdentitySession,
  type RecordTypeLifecyclePolicy,
  type SelectedOrganizationScope,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";
import { createDatabaseApplicationBoundReleaseSetService } from "./application-bound-release-set";
import { DefinitionError } from "./definition-error";
import {
  installationOperation,
  installationProblem,
  readInstallationAuthorityDeadlines,
  readInstallationDatabaseTime,
  readInstallationHumanContext,
  readInstallationOrdinaryRoot,
  readInstallationPermissionDeadline,
  requireInstallationAuthority,
  type InstallationHumanContext,
} from "./installation-authority";
import { readInstallationBindings, type InstallationBindings } from "./installation-binding-reader";
import {
  FirstInstallUnavailable,
  firstInstallHistoryMatchesDraft,
  firstInstallSelectedIdentity,
  firstInstallSetMatchesHistory,
  firstInstallState,
  firstInstallUnavailable,
  firstInstallWorkflows,
  readFirstInstallReleaseSet,
  sameFirstInstallRelease,
  type FirstInstallHistory,
  type FirstInstallRegistrationState,
  type FirstInstallSelector,
} from "./installation-first-install";
import {
  readProvisionedSetupAccessDecision,
  readProvisionedSetupInTransaction,
  type ProvisionedSetup,
} from "./installation-provisioned-setup";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./publication/read";

/** What a first-install read needs from the application: the catalogue, the permissions, and the custom-component rule. */
export type FirstInstallEnvironment = Readonly<{
  catalogue: ImmutableDefinitionPublicationCatalogueDefinition;
  permissions: PlatformPermissionSource;
  containsCustomComponents: (releaseSet: SystemApplicationBoundReleaseSetResult) => boolean;
}>;

const sameContent = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

/** The part of a lifecycle policy a first-install caller is shown. */
export const visibleLifecyclePolicyBody = (policy: RecordTypeLifecyclePolicy) => {
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

/** The provisioned setup with every configured policy reduced to its visible body. */
export const visibleProvisionedSetup = (setup: ProvisionedSetup) => ({
  ...setup,
  targets: setup.targets.map((target) => ({
    ...target,
    policy:
      target.policy.state === "absent"
        ? target.policy
        : { ...target.policy, policyBody: visibleLifecyclePolicyBody(target.policy.policyBody) },
  })),
});

/**
 * Reads the selected release's bound release set inside an application-scoped transaction and
 * proves it names this organisation, application and revision.
 */
export const readAppScopedFirstInstallReleaseSet = async (
  transaction: RequestDatabaseTransaction,
  environment: FirstInstallEnvironment,
  selector: FirstInstallSelector,
): Promise<SystemApplicationBoundReleaseSetResult> => {
  let candidate: unknown;
  try {
    candidate = await createDatabaseApplicationBoundReleaseSetService(
      environment.catalogue,
      transaction,
    ).read({ applicationReleaseRevision: selector.releaseRevision });
  } catch (error) {
    if (!(error instanceof DefinitionError) || error.code === "DEFINITION_READ_FAILED")
      installationProblem(
        "first_install_app_release_set_read_failed",
        "temporarily_unavailable",
        undefined,
        { cause: error },
      );
    installationProblem("first_install_app_release_set_refused", "refused", undefined, { cause: error });
  }
  const parsed = systemApplicationBoundReleaseSetResultSchema.safeParse(candidate);
  if (!parsed.success) throw new FirstInstallUnavailable("setup_unavailable");
  const releaseSet = parsed.data;
  if (
    !sameId(releaseSet.application.organizationId, selector.organizationId) ||
    !sameId(releaseSet.application.rootId, selector.rootId) ||
    releaseSet.application.releaseRevision !== selector.releaseRevision ||
    releaseSet.modules.length === 0
  )
    throw new FirstInstallUnavailable("setup_unavailable");
  return releaseSet;
};

/**
 * Proves, at the end of an application-scoped first-install transaction, that the draft history,
 * authority, context and every setup access decision are still current, and returns the database
 * time and the earliest moment any of them lapses.
 */
export const firstInstallAppCompletion = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  environment: FirstInstallEnvironment,
  selector: FirstInstallSelector,
  history: FirstInstallHistory,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  initialContext: InstallationHumanContext,
): Promise<Readonly<{ checkedAt: string; minimumValidUntil: string }>> => {
  const { permissions } = environment;
  const customComponents = environment.containsCustomComponents(releaseSet);
  await firstInstallHistoryMatchesDraft(
    transaction, scope, selector, history, releaseSet.application.definitionKey,
  );
  await readInstallationOrdinaryRoot(transaction, selector.rootId);
  await requireInstallationAuthority(transaction, scope, permissions, { kind: "draft_change", rootId: selector.rootId });
  await requireInstallationAuthority(transaction, scope, permissions, installationOperation(selector.rootId, customComponents));
  const finalContext = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
    organizationId: selector.organizationId,
    applicationRootId: selector.rootId,
  });
  if (!sameContent(initialContext, finalContext))
    installationProblem("first_install_context_changed", "refused");
  const draftDeadline = await readInstallationPermissionDeadline(
    transaction, scope, finalContext, permissions, "platform.organization.definition_drafts.manage",
  );
  const installDeadlines = await readInstallationAuthorityDeadlines(
    transaction, scope, finalContext, permissions, selector.rootId, customComponents,
  );
  const setupDecisions = await Promise.all([
    readProvisionedSetupAccessDecision(transaction, scope, permissions, "platform.organization.applications.install"),
    readProvisionedSetupAccessDecision(transaction, scope, permissions, "platform.organization.applications.install_scope"),
    readProvisionedSetupAccessDecision(transaction, scope, permissions, "platform.organization.record_lifecycle.manage_policy"),
  ]);
  const completedAt = await readInstallationDatabaseTime(transaction);
  const retainedDeadlines = [draftDeadline, ...installDeadlines,
    ...setupDecisions.map((decision) => decision.validUntil)];
  let minimumValidUntil = finalContext.expiresAt;
  for (const deadline of retainedDeadlines) {
    const deadlineMs = Date.parse(deadline);
    if (!Number.isFinite(deadlineMs))
      installationProblem("first_install_deadline_unreadable", "refused");
    if (deadlineMs < Date.parse(minimumValidUntil)) minimumValidUntil = deadline;
  }
  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(completedAtMs) || !Number.isFinite(Date.parse(minimumValidUntil)) ||
    completedAtMs >= Date.parse(minimumValidUntil))
    installationProblem("first_install_authority_lapsed", "refused");
  if (setupDecisions.some((decision) =>
    !sameId(decision.correlationId, finalContext.correlationId) ||
    decision.accessVersion !== finalContext.accessVersion ||
    Date.parse(decision.checkedAt) > completedAtMs))
    installationProblem("first_install_setup_decision_mismatch", "refused");
  return { checkedAt: completedAt, minimumValidUntil };
};

/** The first-install release set and bindings a draft-change caller may install, with its authority proved. */
export const readFirstInstallCandidateInTransaction = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  environment: FirstInstallEnvironment,
  selector: FirstInstallSelector,
  history: FirstInstallHistory,
  inspected: Readonly<{
    definitionKey: string;
    metadata: Readonly<{ releaseRevision: number; releaseVersion: string }>;
  }>,
): Promise<Readonly<{ releaseSet: SystemApplicationBoundReleaseSetResult; bindings: InstallationBindings }>> => {
  const { permissions } = environment;
  const expected = { organizationId: selector.organizationId };
  const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, expected);
  if (scope.applicationRootId !== undefined)
    installationProblem("first_install_scope_not_organization", "refused");
  await readInstallationOrdinaryRoot(transaction, selector.rootId);
  await requireInstallationAuthority(transaction, scope, permissions, { kind: "draft_change", rootId: selector.rootId });
  await firstInstallHistoryMatchesDraft(transaction, scope, selector, history, inspected.definitionKey);
  const releaseSet = await readFirstInstallReleaseSet(transaction, environment.catalogue, selector, context);
  if (!firstInstallSetMatchesHistory(releaseSet, inspected.metadata, selector) ||
    releaseSet.application.definitionKey !== inspected.definitionKey)
    installationProblem("first_install_release_set_history_mismatch", "conflict");
  const customComponents = environment.containsCustomComponents(releaseSet);
  await requireInstallationAuthority(transaction, scope, permissions, installationOperation(selector.rootId, customComponents));
  await firstInstallHistoryMatchesDraft(transaction, scope, selector, history, inspected.definitionKey);
  const bindings = await readInstallationBindings(transaction, selector.rootId);
  const finalContext = await readInstallationHumanContext(transaction, scope, session, issuedAt, expected);
  if (!sameContent(context, finalContext))
    installationProblem("first_install_context_changed", "refused");
  await requireInstallationAuthority(transaction, scope, permissions, { kind: "draft_change", rootId: selector.rootId });
  await requireInstallationAuthority(transaction, scope, permissions, installationOperation(selector.rootId, customComponents));
  const draftDeadline = await readInstallationPermissionDeadline(
    transaction, scope, finalContext, permissions, "platform.organization.definition_drafts.manage",
  );
  const installationDeadlines = await readInstallationAuthorityDeadlines(
    transaction, scope, finalContext, permissions, selector.rootId, customComponents,
  );
  const checkedAt = await readInstallationDatabaseTime(transaction);
  if (Date.parse(checkedAt) >= Math.min(
    Date.parse(finalContext.expiresAt), Date.parse(draftDeadline),
    ...installationDeadlines.map((deadline) => Date.parse(deadline)),
  )) installationProblem("first_install_authority_lapsed", "refused");
  return { releaseSet, bindings };
};

/** Reads the selected release again and proves it is the release already read. */
export const readFirstInstallCurrentRelease = async (
  transaction: RequestDatabaseTransaction,
  environment: FirstInstallEnvironment,
  selector: FirstInstallSelector,
  expectedReleaseSet: SystemApplicationBoundReleaseSetResult,
): Promise<SystemApplicationBoundReleaseSetResult> => {
  const currentRelease = await readAppScopedFirstInstallReleaseSet(transaction, environment, selector);
  if (!sameFirstInstallRelease(currentRelease, expectedReleaseSet))
    installationProblem("first_install_release_changed", "conflict");
  return currentRelease;
};

/** Reads the provisioned setup of an exact first-install release inside an application-scoped transaction. */
export const readFirstInstallProvisionedSetupInTransaction = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  environment: FirstInstallEnvironment,
  selector: FirstInstallSelector,
  history: FirstInstallHistory,
  expectedReleaseSet: SystemApplicationBoundReleaseSetResult,
): Promise<ProvisionedSetup> => {
  const { permissions } = environment;
  const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
    organizationId: selector.organizationId,
    applicationRootId: selector.rootId,
  });
  await readInstallationOrdinaryRoot(transaction, selector.rootId);
  await requireInstallationAuthority(transaction, scope, permissions, { kind: "draft_change", rootId: selector.rootId });
  await firstInstallHistoryMatchesDraft(
    transaction, scope, selector, history, expectedReleaseSet.application.definitionKey,
  );
  const currentRelease = await readFirstInstallCurrentRelease(transaction, environment, selector, expectedReleaseSet);
  await requireInstallationAuthority(
    transaction, scope, permissions,
    installationOperation(selector.rootId, environment.containsCustomComponents(currentRelease)),
  );
  const setup = await readProvisionedSetupInTransaction(
    transaction, scope, session, issuedAt, selector, currentRelease, permissions,
  );
  await firstInstallHistoryMatchesDraft(
    transaction, scope, selector, history, expectedReleaseSet.application.definitionKey,
  );
  await firstInstallAppCompletion(
    transaction, scope, session, issuedAt, environment, selector, history, currentRelease, context,
  );
  return setup;
};

/** What an application-scoped first-install transaction has proved before its action runs. */
export type FirstInstallAppState = Readonly<{
  context: InstallationHumanContext;
  releaseSet: SystemApplicationBoundReleaseSetResult;
  bindings: InstallationBindings;
  setup: ProvisionedSetup;
}>;

/** The first-install facts a caller holds and expects to still be true. */
export type FirstInstallExpectation = Readonly<{
  history: FirstInstallHistory;
  selected: Readonly<{ definitionKey: string }> & Readonly<Record<string, unknown>>;
  workflows: readonly string[];
}>;

/**
 * Reads the provisioned-inactive first-install state inside an application-scoped transaction and
 * proves it is what the caller expects: `matchesSnapshot` judges the caller's own snapshot shape.
 */
export const readFirstInstallAppState = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  environment: FirstInstallEnvironment,
  selector: FirstInstallSelector,
  expected: FirstInstallExpectation,
  matchesSnapshot: (
    current: Readonly<{
      releaseSet: SystemApplicationBoundReleaseSetResult;
      bindings: InstallationBindings;
      state: FirstInstallRegistrationState;
      setup: ProvisionedSetup;
    }>,
  ) => boolean,
): Promise<FirstInstallAppState> => {
  const { permissions } = environment;
  const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
    organizationId: selector.organizationId,
    applicationRootId: selector.rootId,
  });
  await readInstallationOrdinaryRoot(transaction, selector.rootId);
  await requireInstallationAuthority(transaction, scope, permissions, { kind: "draft_change", rootId: selector.rootId });
  await firstInstallHistoryMatchesDraft(
    transaction, scope, selector, expected.history, expected.selected.definitionKey,
  );
  const releaseSet = await readAppScopedFirstInstallReleaseSet(transaction, environment, selector);
  if (!sameContent(firstInstallSelectedIdentity(releaseSet), expected.selected) ||
    !sameContent(firstInstallWorkflows(releaseSet), expected.workflows))
    installationProblem("first_install_release_changed", "conflict");
  await requireInstallationAuthority(
    transaction, scope, permissions,
    installationOperation(selector.rootId, environment.containsCustomComponents(releaseSet)),
  );
  const bindings = await readInstallationBindings(transaction, selector.rootId);
  const state = firstInstallState(selector, releaseSet, bindings);
  if (state !== "provisioned_inactive") firstInstallUnavailable("installation_incomplete");
  const setup = await readProvisionedSetupInTransaction(
    transaction, scope, session, issuedAt, selector, releaseSet, permissions,
  );
  if (!matchesSnapshot({ releaseSet, bindings, state, setup }))
    installationProblem("first_install_snapshot_changed", "conflict");
  return { context, releaseSet, bindings, setup };
};

/**
 * Proves, after an archive-connection read, that the release, the setup and the authority are
 * unchanged and that the retained authority had not lapsed when the read finished.
 */
export const completeFirstInstallConnectionRead = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  environment: FirstInstallEnvironment,
  selector: FirstInstallSelector,
  history: FirstInstallHistory,
  initial: FirstInstallAppState,
  retainedFence: Readonly<{ minimumValidUntil: string }>,
): Promise<void> => {
  const currentRelease = await readFirstInstallCurrentRelease(
    transaction, environment, selector, initial.releaseSet,
  );
  await requireFirstInstallSetupUnchanged(
    transaction, scope, session, issuedAt, environment, selector, currentRelease, initial,
  );
  const completed = await firstInstallAppCompletion(
    transaction, scope, session, issuedAt, environment, selector, history, currentRelease, initial.context,
  );
  if (Date.parse(completed.checkedAt) >= Date.parse(retainedFence.minimumValidUntil))
    installationProblem("first_install_authority_lapsed", "refused");
};

/** Proves the provisioned setup read again for `release` is the setup already read. */
export const requireFirstInstallSetupUnchanged = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  environment: FirstInstallEnvironment,
  selector: FirstInstallSelector,
  release: SystemApplicationBoundReleaseSetResult,
  initial: FirstInstallAppState,
): Promise<void> => {
  const currentSetup = await readProvisionedSetupInTransaction(
    transaction, scope, session, issuedAt, selector, release, environment.permissions,
  );
  if (!sameContent(currentSetup, initial.setup))
    installationProblem("first_install_setup_changed", "conflict");
};
