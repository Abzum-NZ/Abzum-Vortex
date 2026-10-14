import "server-only";

import type { RequestDatabaseTransaction } from "../db/index";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import type { createHumanOrganizationRequestService } from "../access/index";
import type { createRecordTypeLifecyclePolicyService } from "../records/record-lifecycle-policy-record";
import {
  canonicalJson,
  sameId,
  systemApplicationBoundReleaseSetResultSchema,
  type ApplicationRootId,
  type ConnectionInstanceId,
  type IdentitySession,
  type OrganizationId,
  type OrganizationLifecycleLimits,
  type OrganizationSelectionCandidate,
  type RecordTypeLifecyclePolicy,
  type SelectedOrganizationScope,
  type StorageContractId,
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
import {
  readInstallationArchiveConnectionOptions,
  readSelectedInstallationArchiveConnection,
} from "./installation-archive-connections";
import { readInstallationBindings, type InstallationBindings } from "./installation-binding-reader";
import {
  initialLifecyclePolicyMatches,
  saveInitialArchiveWorkflowPolicy,
  workflowIsInExactRelease,
  type InitialLifecyclePolicyInput,
  type InitialLifecyclePolicyTarget,
} from "./installation-initial-lifecycle-policy";
import {
  FirstInstallUnavailable,
  firstInstallHistory,
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

type DeletePolicy = Extract<RecordTypeLifecyclePolicy, { action: "delete" }>;
type ArchivePolicy = Extract<RecordTypeLifecyclePolicy, { action: "archive_workflow" }>;
type PolicyLimits = Pick<
  RecordTypeLifecyclePolicy,
  "maxAgeDays" | "maxCount" | "allowUnlimitedAge" | "allowUnlimitedCount"
>;

/** The part of a lifecycle policy a first-install caller is shown. */
export type VisibleLifecyclePolicyBody =
  | Readonly<PolicyLimits & { action: "delete"; recoveryWindowDays?: DeletePolicy["recoveryWindowDays"] }>
  | Readonly<
      PolicyLimits &
        Pick<
          ArchivePolicy,
          | "action"
          | "archiveWorkflowId"
          | "expectedWorkflowRevision"
          | "archiveConnectionInstanceId"
          | "archiveDestination"
          | "expectedConnectionRevision"
          | "expectedConnectionHealthOutcome"
        >
    >;

export const visibleLifecyclePolicyBody = (policy: RecordTypeLifecyclePolicy): VisibleLifecyclePolicyBody => {
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

/** The provisioned setup as a first-install caller is shown it. */
export type VisibleProvisionedSetup = ReturnType<typeof visibleProvisionedSetup>;

/** One storage target of the visible setup. */
export type VisibleProvisionedTarget = VisibleProvisionedSetup["targets"][number];

/** What a first-install caller is shown, and later sends back to prove what it saw is still true. */
export type FirstInstallSnapshot = Readonly<{
  organizationId: OrganizationId;
  rootId: ApplicationRootId;
  selected: Readonly<{
    definitionKey: string;
    releaseRevision: number;
    releaseVersion: string;
    validationContractVersion: string;
    contentFingerprint: string;
    resolutionFingerprint: string;
    moduleSetFingerprint: string;
  }>;
  history: FirstInstallHistory;
  registrationState: FirstInstallRegistrationState;
  registeredReleaseRevision: number | null;
  moduleBindings: InstallationBindings["moduleBindings"];
  workflows: string[];
  setup: VisibleProvisionedSetup | null;
}>;

/** Why a draft-history read did not produce a snapshot; `reason` is the stable code it logged. */
type FirstInstallHistoryFailure = Readonly<{
  kind: "refused" | "conflict" | "temporarily_unavailable";
  reason: string;
}>;

/**
 * The draft-history reads a first install is anchored to. History is owned by the Studio
 * application; the first install only asks it for the draft identity and one release's metadata.
 */
export type FirstInstallHistoryReads = Readonly<{
  readAccess: (
    organizationId: OrganizationId,
    rootId: ApplicationRootId,
  ) => Promise<FirstInstallHistoryFailure | Readonly<{ kind: "available"; snapshot: FirstInstallHistory }>>;
  inspectRelease: (
    organizationId: OrganizationId,
    request: Readonly<{ rootId: ApplicationRootId; expected: FirstInstallHistory; releaseRevision: number }>,
  ) => Promise<
    | FirstInstallHistoryFailure
    | Readonly<{
        kind: "available";
        snapshot: Readonly<{ definitionKey: string }>;
        metadata: Readonly<{ releaseRevision: number; releaseVersion: string }>;
      }>
  >;
}>;

/** What the first-install reads and commands need from the application beyond the release reads. */
export type FirstInstallFlowEnvironment = FirstInstallEnvironment &
  Readonly<{
    requests: ReturnType<typeof createHumanOrganizationRequestService>;
    history: FirstInstallHistoryReads;
    lifecyclePolicies: ReturnType<typeof createRecordTypeLifecyclePolicyService>;
  }>;

/** The current first-install state, proved for one session: the release set, the snapshot and who proved it. */
export type FirstInstallCandidate = Readonly<{
  selector: FirstInstallSelector;
  history: FirstInstallHistory;
  releaseSet: SystemApplicationBoundReleaseSetResult;
  snapshot: FirstInstallSnapshot;
  session: IdentitySession;
}>;

/** Set when a command's first write has started, so the caller can tell the state may have changed. */
export type FirstInstallCommandRun = { writeStarted: boolean };

/** Whether two first-install snapshots hold the same content. */
export const sameFirstInstallSnapshot = (
  expected: FirstInstallSnapshot,
  actual: FirstInstallSnapshot,
): boolean => sameContent(expected, actual);

const firstInstallSnapshot = (
  selector: FirstInstallSelector,
  history: FirstInstallHistory,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
  registrationState: FirstInstallRegistrationState,
  setup: VisibleProvisionedSetup | null,
): FirstInstallSnapshot => ({
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

/**
 * Runs one first-install request transaction. A failure inside the callback is rethrown with its
 * own cause; only a request the service itself declined becomes a refusal or an unavailability.
 */
const runFirstInstallChange = async <Value>(
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  operation: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    issuedAt: string,
  ) => Promise<Value>,
): Promise<Value> => {
  let callbackFailure: unknown;
  const result = await environment.requests.runChange(
    session,
    selection,
    async (transaction, scope, issuedAt) => {
      try {
        return await operation(transaction, scope, issuedAt);
      } catch (error) {
        callbackFailure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (callbackFailure !== undefined) throw callbackFailure;
  if (result.kind === "unavailable") return installationProblem("first_install_request_refused", "refused");
  return installationProblem("first_install_request_unavailable", "temporarily_unavailable");
};

const readCurrentProvisionedSetup = async (
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  selector: FirstInstallSelector,
  history: FirstInstallHistory,
  expectedReleaseSet: SystemApplicationBoundReleaseSetResult,
): Promise<VisibleProvisionedSetup> =>
  visibleProvisionedSetup(
    await runFirstInstallChange(
      environment,
      session,
      { organizationId: selector.organizationId, applicationRootId: selector.rootId },
      (transaction, scope, issuedAt) =>
        readFirstInstallProvisionedSetupInTransaction(
          transaction, scope, session, issuedAt, environment, selector, history, expectedReleaseSet,
        ),
    ),
  );

/**
 * Reads the first-install state for `selector` as `session` may see it: the draft history, the
 * selected release, its bindings and, once provisioned, its setup. With `expected`, the state must
 * be exactly what the caller saw, otherwise the read is a conflict.
 */
export const readCurrentFirstInstallCandidate = async (
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  selector: FirstInstallSelector,
  expected?: FirstInstallSnapshot,
): Promise<FirstInstallCandidate> => {
  const access = await environment.history.readAccess(selector.organizationId, selector.rootId);
  if (access.kind !== "available") return installationProblem(access.reason, access.kind);
  const history = firstInstallHistory(access.snapshot);
  if (history.anchorReleaseRevision === null || selector.releaseRevision > history.anchorReleaseRevision)
    return firstInstallUnavailable("release_not_published");
  const inspected = await environment.history.inspectRelease(selector.organizationId, {
    rootId: selector.rootId,
    expected: history,
    releaseRevision: selector.releaseRevision,
  });
  if (inspected.kind === "refused") return firstInstallUnavailable("release_not_published");
  if (inspected.kind !== "available") return installationProblem(inspected.reason, inspected.kind);
  const { releaseSet, bindings } = await runFirstInstallChange(
    environment,
    session,
    { organizationId: selector.organizationId },
    (transaction, scope, issuedAt) =>
      readFirstInstallCandidateInTransaction(
        transaction, scope, session, issuedAt, environment, selector, history,
        { definitionKey: inspected.snapshot.definitionKey, metadata: inspected.metadata },
      ),
  );
  const registrationState = firstInstallState(selector, releaseSet, bindings);
  let setup: VisibleProvisionedSetup | null = null;
  if (registrationState === "provisioned_inactive")
    setup = await readCurrentProvisionedSetup(environment, session, selector, history, releaseSet);
  const snapshot = firstInstallSnapshot(selector, history, releaseSet, bindings, registrationState, setup);
  if (expected !== undefined && !sameFirstInstallSnapshot(expected, snapshot))
    return installationProblem("first_install_snapshot_changed", "conflict");
  return { selector, history, releaseSet, snapshot, session };
};

type FirstInstallActionState = FirstInstallAppState &
  Readonly<{ visibleSetup: VisibleProvisionedSetup }>;

/**
 * Runs `action` inside an application-scoped transaction that first proves the first-install state
 * is still what the caller expected and, unless the action is the last database operation, proves
 * the authority and release are unchanged afterwards.
 */
const runFirstInstallAppTransaction = async <Value>(
  environment: FirstInstallFlowEnvironment,
  candidate: FirstInstallCandidate,
  expected: FirstInstallSnapshot,
  action: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    issuedAt: string,
    initial: FirstInstallActionState,
  ) => Promise<Value>,
  actionIsFinalDatabaseOperation = false,
): Promise<Value> =>
  runFirstInstallChange(
    environment,
    candidate.session,
    { organizationId: candidate.selector.organizationId, applicationRootId: candidate.selector.rootId },
    async (transaction, scope, issuedAt) => {
      const proved = await readFirstInstallAppState(
        transaction, scope, candidate.session, issuedAt, environment, candidate.selector, expected,
        (current) => sameFirstInstallSnapshot(expected, firstInstallSnapshot(
          candidate.selector, expected.history, current.releaseSet, current.bindings, current.state,
          visibleProvisionedSetup(current.setup),
        )),
      );
      const initial: FirstInstallActionState = {
        ...proved,
        visibleSetup: visibleProvisionedSetup(proved.setup),
      };
      const value = await action(transaction, scope, issuedAt, initial);
      if (!actionIsFinalDatabaseOperation) {
        const currentRelease = await readFirstInstallCurrentRelease(
          transaction, environment, candidate.selector, initial.releaseSet,
        );
        await firstInstallAppCompletion(
          transaction, scope, candidate.session, issuedAt, environment, candidate.selector,
          expected.history, currentRelease, initial.context,
        );
      }
      return value;
    },
  );

const currentFirstInstallTarget = (
  setup: VisibleProvisionedSetup,
  storageContractId: StorageContractId,
): VisibleProvisionedTarget => {
  const matching = setup.targets.filter((target) => sameId(target.storageContractId, storageContractId));
  const target = matching[0];
  if (matching.length !== 1 || target === undefined)
    return installationProblem("first_install_target_not_unique", "conflict");
  return target;
};

/** The archive connections a first install may choose for one application-contained target. */
export const readFirstInstallArchiveOptions = async (
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  query: Readonly<{
    selector: FirstInstallSelector;
    expected: FirstInstallSnapshot;
    storageContractId: StorageContractId;
    afterConnectionInstanceId?: ConnectionInstanceId | undefined;
  }>,
) => {
  const { selector, expected } = query;
  const candidate = await readCurrentFirstInstallCandidate(environment, session, selector, expected);
  return runFirstInstallAppTransaction(
    environment,
    candidate,
    expected,
    async (transaction, scope, issuedAt, initial) => {
      const target = currentFirstInstallTarget(initial.visibleSetup, query.storageContractId);
      const limits = initial.visibleSetup.organizationLimits;
      if (target.policy.state !== "absent" || target.storageScope !== "application_contained" ||
        target.applicationRootId === null || !limits.allowedActions.includes("archive_workflow") ||
        limits.allowedArchiveDestinations.length === 0)
        return installationProblem("first_install_archive_options_not_applicable", "refused");
      const currentRelease = await readFirstInstallCurrentRelease(
        transaction, environment, selector, initial.releaseSet,
      );
      await requireFirstInstallSetupUnchanged(
        transaction, scope, session, issuedAt, environment, selector, currentRelease, initial,
      );
      const retainedFence = await firstInstallAppCompletion(
        transaction, scope, session, issuedAt, environment, selector, expected.history, currentRelease,
        initial.context,
      );
      const page = await readInstallationArchiveConnectionOptions(
        transaction,
        selector.organizationId,
        selector.rootId,
        limits.allowedArchiveDestinations,
        query.afterConnectionInstanceId,
      );
      await completeFirstInstallConnectionRead(
        transaction, scope, session, issuedAt, environment, selector, expected.history, initial,
        retainedFence,
      );
      return page;
    },
    true,
  );
};

const assertPolicyCommonFields = (
  policy: InitialLifecyclePolicyInput,
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
    installationProblem("first_install_policy_outside_limits", "refused");
};

/** The initial lifecycle policy a first install saves for one storage target. */
export type FirstInstallPolicyCommand = Readonly<{
  selector: FirstInstallSelector;
  expected: FirstInstallSnapshot;
  storageContractId: StorageContractId;
  targetApplicationRootId: ApplicationRootId | null;
  expectedBindingRevision: number;
  expectedSettingsRevision: number;
  policy: InitialLifecyclePolicyInput;
}>;

const assertInitialPolicyTarget = (
  setup: VisibleProvisionedSetup,
  command: FirstInstallPolicyCommand,
): VisibleProvisionedTarget => {
  const target = currentFirstInstallTarget(setup, command.storageContractId);
  if ((target.applicationRootId === null) !== (command.targetApplicationRootId === null) ||
    (target.applicationRootId !== null && command.targetApplicationRootId !== null &&
      !sameId(target.applicationRootId, command.targetApplicationRootId)) ||
    target.policy.state !== "absent" ||
    setup.organizationLimits.settingsRevision !== command.expectedSettingsRevision ||
    !target.sourceBindings.some((binding) => binding.bindingRevision === command.expectedBindingRevision))
    return installationProblem("first_install_policy_target_changed", "conflict");
  assertPolicyCommonFields(command.policy, setup.organizationLimits);
  if (command.policy.action === "archive_workflow" &&
    (target.storageScope !== "application_contained" ||
      target.applicationRootId === null ||
      !sameId(target.applicationRootId, command.selector.rootId)))
    return installationProblem("first_install_archive_target_not_contained", "refused");
  return target;
};

const initialPolicyTarget = (
  candidate: FirstInstallCandidate,
  target: VisibleProvisionedTarget,
): InitialLifecyclePolicyTarget => ({
  organizationId: candidate.selector.organizationId,
  installationRootId: candidate.selector.rootId,
  releaseRevision: candidate.selector.releaseRevision,
  storageContractId: target.storageContractId,
  applicationRootId: target.applicationRootId,
});

const saveDeleteInitialPolicy = async (
  environment: FirstInstallFlowEnvironment,
  candidate: FirstInstallCandidate,
  target: VisibleProvisionedTarget,
  command: FirstInstallPolicyCommand,
  policy: Extract<InitialLifecyclePolicyInput, { action: "delete" }>,
): Promise<RecordTypeLifecyclePolicy> => {
  if (!target.sourceBindings.some((binding) => binding.bindingRevision === command.expectedBindingRevision))
    return installationProblem("first_install_binding_revision_changed", "conflict");
  const result = await environment.lifecyclePolicies.saveInitialForProvisionedSetup(candidate.session, {
    organizationId: candidate.selector.organizationId,
    bindingApplicationRootId: candidate.selector.rootId,
    expectedBindingRevision: command.expectedBindingRevision,
    storageContractId: target.storageContractId,
    applicationRootId: target.applicationRootId,
    expectedSettingsRevision: command.expectedSettingsRevision,
    policy,
  });
  if (result.kind === "unavailable") return installationProblem("first_install_policy_save_refused", "refused");
  if (result.kind !== "available")
    return installationProblem("first_install_policy_save_unavailable", "temporarily_unavailable");
  return initialLifecyclePolicyMatches(result.value, initialPolicyTarget(candidate, target), policy);
};

/** Proves the policy just saved is the one a fresh read of the first install now shows. */
const requireSavedPolicyObserved = async (
  environment: FirstInstallFlowEnvironment,
  candidate: FirstInstallCandidate,
  target: VisibleProvisionedTarget,
  saved: RecordTypeLifecyclePolicy,
): Promise<void> => {
  const current = await readCurrentFirstInstallCandidate(
    environment, candidate.session, candidate.selector,
  );
  if (!sameContent(current.snapshot.history, candidate.history) ||
    !sameContent(current.snapshot.selected, candidate.snapshot.selected))
    return installationProblem("first_install_release_changed", "conflict");
  if (current.snapshot.registrationState === "active_exact") return;
  if (current.snapshot.registrationState !== "provisioned_inactive" || current.snapshot.setup === null)
    return installationProblem("first_install_saved_policy_state_unobserved", "temporarily_unavailable");
  const observed = currentFirstInstallTarget(current.snapshot.setup, target.storageContractId);
  if (observed.policy.state !== "configured" ||
    !sameId(observed.policy.policyId, saved.policyId) ||
    observed.policy.policyRevision !== saved.policyRevision ||
    !sameContent(observed.policy.policyBody, visibleLifecyclePolicyBody(saved)))
    return installationProblem("first_install_saved_policy_unobserved", "temporarily_unavailable");
};

/**
 * Saves the initial lifecycle policy of one storage target of a provisioned, inactive first
 * install. `run.writeStarted` is set as the first write begins, whether or not it then succeeds.
 */
export const saveFirstInstallInitialPolicy = async (
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  command: FirstInstallPolicyCommand,
  run: FirstInstallCommandRun,
): Promise<void> => {
  const { selector, expected, policy } = command;
  const candidate = await readCurrentFirstInstallCandidate(environment, session, selector, expected);
  const { setup } = candidate.snapshot;
  if (candidate.snapshot.registrationState !== "provisioned_inactive" || setup === null)
    return installationProblem("first_install_not_provisioned_inactive", "conflict");
  const target = assertInitialPolicyTarget(setup, command);
  let saved: RecordTypeLifecyclePolicy;
  if (policy.action === "delete") {
    await runFirstInstallAppTransaction(environment, candidate, expected, async (_transaction, _scope, _issuedAt, initial) => {
      if (!sameContent(assertInitialPolicyTarget(initial.visibleSetup, command), target))
        installationProblem("first_install_policy_target_changed", "conflict");
    });
    run.writeStarted = true;
    saved = await saveDeleteInitialPolicy(environment, candidate, target, command, policy);
  } else {
    saved = await runFirstInstallAppTransaction(
      environment,
      candidate,
      expected,
      async (transaction, scope, issuedAt, initial) => {
        const currentTarget = assertInitialPolicyTarget(initial.visibleSetup, command);
        if (!sameContent(currentTarget, target) || !sameContent(initial.visibleSetup, setup))
          installationProblem("first_install_policy_target_changed", "conflict");
        if (!workflowIsInExactRelease(initial.releaseSet, selector.rootId, policy.archiveWorkflowId))
          installationProblem("first_install_archive_workflow_not_in_release", "refused");
        const currentRelease = await readFirstInstallCurrentRelease(
          transaction, environment, selector, initial.releaseSet,
        );
        await requireFirstInstallSetupUnchanged(
          transaction, scope, session, issuedAt, environment, selector, currentRelease, initial,
        );
        const retainedFence = await firstInstallAppCompletion(
          transaction, scope, session, issuedAt, environment, selector, expected.history, currentRelease,
          initial.context,
        );
        const option = await readSelectedInstallationArchiveConnection(
          transaction,
          selector.organizationId,
          selector.rootId,
          initial.visibleSetup.organizationLimits.allowedArchiveDestinations,
          {
            connectionInstanceId: policy.archiveConnectionInstanceId,
            destinationKey: policy.archiveDestination,
            expectedRevision: policy.expectedConnectionRevision,
          },
        );
        await completeFirstInstallConnectionRead(
          transaction, scope, session, issuedAt, environment, selector, expected.history, initial,
          retainedFence,
        );
        run.writeStarted = true;
        return saveInitialArchiveWorkflowPolicy(
          transaction,
          initialPolicyTarget(candidate, currentTarget),
          candidate.releaseSet,
          currentTarget.sourceBindings.map((binding) => binding.bindingRevision),
          command.expectedBindingRevision,
          command.expectedSettingsRevision,
          policy,
          option,
        );
      },
      true,
    );
  }
  await requireSavedPolicyObserved(environment, candidate, target, saved);
};
