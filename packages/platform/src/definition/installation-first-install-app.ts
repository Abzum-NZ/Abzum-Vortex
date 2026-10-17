import "server-only";

import type { RequestDatabaseTransaction } from "../db/index";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import type {
  createHumanOrganizationRequestService,
  createOrganizationAccessAdministrationService,
} from "../access/index";
import {
  canonicalJson,
  type ApplicationRootId,
  type IdentitySession,
  type OrganizationId,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";
import {
  installationOperation,
  installationProblem,
  readInstallationAuthorityDeadlines,
  readInstallationDatabaseTime,
  readInstallationHumanContext,
  readInstallationOrdinaryRoot,
  readInstallationPermissionDeadline,
  requireInstallationAuthority,
} from "./installation-authority";
import { readInstallationBindings, type InstallationBindings } from "./installation-binding-reader";
import {
  firstInstallHistory,
  firstInstallHistoryMatchesDraft,
  firstInstallSelectedIdentity,
  firstInstallSetMatchesHistory,
  firstInstallState,
  firstInstallUnavailable,
  readFirstInstallReleaseSet,
  type FirstInstallHistory,
  type FirstInstallRegistrationState,
  type FirstInstallSelector,
} from "./installation-first-install";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./publication/read";
import { firstInstallMemberRole, type FirstInstallMemberRole } from "./installation-first-install-member-role";

/** What a first-install read needs from the application: the catalogue, the permissions, and the custom-component rule. */
export type FirstInstallEnvironment = Readonly<{
  catalogue: ImmutableDefinitionPublicationCatalogueDefinition;
  permissions: PlatformPermissionSource;
  containsCustomComponents: (releaseSet: SystemApplicationBoundReleaseSetResult) => boolean;
}>;

const sameContent = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

/** The first-install release set and bindings a draft-change caller may install, with its authority proved. */
const readFirstInstallCandidateInTransaction = async (
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

/** What a first-install caller is shown, and later sends back to prove what it saw is still true. */
type FirstInstallSnapshot = Readonly<{
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
  /** The default member role the installer is offered, and accepts explicitly, on activation. */
  memberRole: FirstInstallMemberRole;
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
        metadata: Readonly<{ releaseRevision: number; releaseVersion: string; releaseNote: string }>;
      }>
  >;
}>;

/** What the first-install reads and commands need from the application beyond the release reads. */
export type FirstInstallFlowEnvironment = FirstInstallEnvironment &
  Readonly<{
    requests: ReturnType<typeof createHumanOrganizationRequestService>;
    history: FirstInstallHistoryReads;
    /** The Access operations that accept and assign the default member role for the installer. */
    accessAdministration: ReturnType<typeof createOrganizationAccessAdministrationService>;
  }>;

/** The current first-install state, proved for one session: the release set, the snapshot and who proved it. */
export type FirstInstallCandidate = Readonly<{
  selector: FirstInstallSelector;
  history: FirstInstallHistory;
  releaseSet: SystemApplicationBoundReleaseSetResult;
  snapshot: FirstInstallSnapshot;
  session: IdentitySession;
}>;

const firstInstallSnapshot = (
  selector: FirstInstallSelector,
  history: FirstInstallHistory,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
  registrationState: FirstInstallRegistrationState,
): FirstInstallSnapshot => ({
  organizationId: selector.organizationId,
  rootId: selector.rootId,
  selected: firstInstallSelectedIdentity(releaseSet),
  history,
  registrationState,
  registeredReleaseRevision: bindings.registeredReleaseRevision,
  moduleBindings: bindings.moduleBindings,
  memberRole: firstInstallMemberRole(releaseSet),
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

/**
 * Reads the first-install state for `selector` as `session` may see it: the draft history, the
 * selected release and its bindings. With `expected`, the state must be exactly what the caller
 * saw, otherwise the read is a conflict.
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
  const snapshot = firstInstallSnapshot(selector, history, releaseSet, bindings, registrationState);
  if (expected !== undefined && !sameContent(expected, snapshot))
    return installationProblem("first_install_snapshot_changed", "conflict");
  return { selector, history, releaseSet, snapshot, session };
};
