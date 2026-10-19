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
  requireInstallationAuthority,
} from "./installation-authority";
import { readInstallationBindings, type InstallationBindings } from "./installation-binding-reader";
import {
  firstInstallLatestReleaseMatches,
  firstInstallSelectedIdentity,
  firstInstallSetMatchesLatest,
  firstInstallState,
  firstInstallUnavailable,
  readApplicationLatestRelease,
  readFirstInstallReleaseSet,
  type ApplicationLatestRelease,
  type FirstInstallRegistrationState,
  type FirstInstallSelector,
} from "./installation-first-install";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./publication/read";
import { releaseRoleTemplates, type ApplicationRoleTemplate } from "./installation-role-templates";

/** What a first-install read needs from the application: the catalogue, the permissions, and the custom-component rule. */
export type FirstInstallEnvironment = Readonly<{
  catalogue: ImmutableDefinitionPublicationCatalogueDefinition;
  permissions: PlatformPermissionSource;
  containsCustomComponents: (releaseSet: SystemApplicationBoundReleaseSetResult) => boolean;
}>;

const sameContent = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

/**
 * The first-install release set and bindings the caller may install, with the installation
 * authority proved. It needs only that authority: no right on the application's draft.
 */
const readFirstInstallCandidateInTransaction = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  environment: FirstInstallEnvironment,
  selector: FirstInstallSelector,
): Promise<
  | Readonly<{
      latest: ApplicationLatestRelease;
      releaseSet: SystemApplicationBoundReleaseSetResult;
      bindings: InstallationBindings;
    }>
  | "already_installed"
> => {
  const { permissions } = environment;
  const expected = { organizationId: selector.organizationId };
  const context = await readInstallationHumanContext(
    transaction,
    scope,
    session,
    issuedAt,
    expected,
  );
  if (scope.applicationRootId !== undefined)
    installationProblem("first_install_scope_not_organization", "refused");
  await readInstallationOrdinaryRoot(transaction, selector.rootId);
  const latest = await readApplicationLatestRelease(transaction, selector.rootId);
  if (selector.releaseRevision > latest.releaseRevision)
    firstInstallUnavailable("release_not_published");
  const bindings = await readInstallationBindings(transaction, selector.rootId);
  // A different registered release needs the upgrade journey. Decide that from the protected
  // binding read before fetching and projecting a release set a first install cannot use.
  if (
    bindings.registeredReleaseRevision !== null &&
    bindings.registeredReleaseRevision !== selector.releaseRevision
  )
    return "already_installed";
  const releaseSet = await readFirstInstallReleaseSet(
    transaction,
    environment.catalogue,
    selector,
    context,
  );
  if (!firstInstallSetMatchesLatest(releaseSet, latest, selector))
    installationProblem("first_install_release_set_latest_mismatch", "conflict");
  const customComponents = environment.containsCustomComponents(releaseSet);
  await requireInstallationAuthority(
    transaction,
    scope,
    permissions,
    installationOperation(selector.rootId, customComponents),
  );
  await firstInstallLatestReleaseMatches(transaction, selector, latest);
  const finalContext = await readInstallationHumanContext(
    transaction,
    scope,
    session,
    issuedAt,
    expected,
  );
  if (!sameContent(context, finalContext))
    installationProblem("first_install_context_changed", "refused");
  await requireInstallationAuthority(
    transaction,
    scope,
    permissions,
    installationOperation(selector.rootId, customComponents),
  );
  const installationDeadlines = await readInstallationAuthorityDeadlines(
    transaction,
    scope,
    finalContext,
    permissions,
    selector.rootId,
    customComponents,
  );
  const checkedAt = await readInstallationDatabaseTime(transaction);
  if (
    Date.parse(checkedAt) >=
    Math.min(
      Date.parse(finalContext.expiresAt),
      ...installationDeadlines.map((deadline) => Date.parse(deadline)),
    )
  )
    installationProblem("first_install_authority_lapsed", "refused");
  return { latest, releaseSet, bindings };
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
  /** The latest published version the install is anchored to, with its release note. */
  latest: ApplicationLatestRelease;
  registrationState: FirstInstallRegistrationState;
  registeredReleaseRevision: number | null;
  moduleBindings: InstallationBindings["moduleBindings"];
  /** Every role the release offers; installing makes each of them an organisation role. */
  roles: readonly ApplicationRoleTemplate[];
}>;

/** What the first-install reads and commands need from the application beyond the release reads. */
export type FirstInstallFlowEnvironment = FirstInstallEnvironment &
  Readonly<{
    requests: ReturnType<typeof createHumanOrganizationRequestService>;
    /** The Access operations that accept the application's roles and assign the member role. */
    accessAdministration: ReturnType<typeof createOrganizationAccessAdministrationService>;
  }>;

/** The current first-install state, proved for one session: the release set, the snapshot and who proved it. */
export type FirstInstallCandidate = Readonly<{
  selector: FirstInstallSelector;
  releaseSet: SystemApplicationBoundReleaseSetResult;
  snapshot: FirstInstallSnapshot;
  session: IdentitySession;
}>;

const firstInstallSnapshot = (
  selector: FirstInstallSelector,
  latest: ApplicationLatestRelease,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
  registrationState: FirstInstallRegistrationState,
): FirstInstallSnapshot => ({
  organizationId: selector.organizationId,
  rootId: selector.rootId,
  selected: firstInstallSelectedIdentity(releaseSet),
  latest,
  registrationState,
  registeredReleaseRevision: bindings.registeredReleaseRevision,
  moduleBindings: bindings.moduleBindings,
  roles: releaseRoleTemplates(releaseSet),
});

/**
 * Runs one first-install request transaction. A failure inside the callback is rethrown with its
 * own cause; only a request the service itself declined becomes a refusal or an unavailability.
 */
const runFirstInstallChange = async <Value>(
  environment: Pick<FirstInstallFlowEnvironment, "requests">,
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
  if (result.kind === "unavailable")
    return installationProblem("first_install_request_refused", "refused");
  return installationProblem("first_install_request_unavailable", "temporarily_unavailable");
};

/** The application's latest published version, read under the installation authority in its own request. */
export const readCurrentApplicationLatestRelease = (
  environment: Pick<FirstInstallFlowEnvironment, "requests">,
  session: IdentitySession,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
): Promise<ApplicationLatestRelease> =>
  runFirstInstallChange(environment, session, { organizationId }, (transaction) =>
    readApplicationLatestRelease(transaction, rootId),
  );

/**
 * Reads the first-install state for `selector` as `session` may see it: the latest published
 * version, the selected release and its bindings. With `expected`, the state must be exactly what
 * the caller saw, otherwise the read is a conflict.
 */
export const readCurrentFirstInstallCandidate = async (
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  selector: FirstInstallSelector,
  expected?: FirstInstallSnapshot,
): Promise<FirstInstallCandidate> => {
  const current = await runFirstInstallChange(
    environment,
    session,
    { organizationId: selector.organizationId },
    (transaction, scope, issuedAt) =>
      readFirstInstallCandidateInTransaction(
        transaction,
        scope,
        session,
        issuedAt,
        environment,
        selector,
      ),
  );
  if (current === "already_installed") return firstInstallUnavailable("already_installed");
  const { latest, releaseSet, bindings } = current;
  const registrationState = firstInstallState(selector, releaseSet, bindings);
  const snapshot = firstInstallSnapshot(selector, latest, releaseSet, bindings, registrationState);
  if (expected !== undefined && !sameContent(expected, snapshot))
    return installationProblem("first_install_snapshot_changed", "conflict");
  return { selector, releaseSet, snapshot, session };
};
