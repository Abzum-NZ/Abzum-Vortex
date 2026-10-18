import "server-only";

import { z } from "zod";
import type { HumanOrganizationRequestResult } from "../access/index";
import {
  applicationRootIdSchema,
  canonicalJson,
  describeFailure,
  organizationIdSchema,
  roleIdSchema,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "../schema";
import type { InstallationProblemShape } from "./installation-authority";
import { classifyInstallationFailure } from "./installation-failure";
import { FirstInstallUnavailable } from "./installation-first-install";
import {
  readCurrentApplicationLatestRelease,
  readCurrentFirstInstallCandidate,
  type FirstInstallCandidate,
  type FirstInstallFlowEnvironment,
} from "./installation-first-install-app";
import { createFirstInstallCoordinator } from "./installation-first-install-coordinator";
import { activateFirstInstall } from "./installation-first-install-member-role";
import {
  readUpgradeAuthorizedState,
  sameUpgradeSnapshotState,
  type UpgradeSelector,
  type UpgradeSnapshot,
} from "./installation-upgrade";
import {
  readUpgradeRoleRevisions,
  upgradeWithRoleRevisions,
  type UpgradeRoleEnvironment,
} from "./installation-upgrade-role-revisions";

/**
 * The installation journeys of the organisation's application catalogue, as three registered
 * platform operations a flow calls: a review that says whether the selected application's latest
 * published version would be a first install, an upgrade or nothing, and the install and the upgrade
 * themselves. They are the one human path to install and upgrade; each runs the shared installation
 * functions under the person's own authority: the installation authority alone (managing
 * applications, with the delegated scope and recent sign-in a role acceptance needs), never a right on
 * the application's draft. They re-prove that authority, the latest published version, the release
 * and the bindings in their own transactions. The review hands the caller the exact
 * state it showed (`expected`); the install and the upgrade refuse as a conflict when that state
 * moved, so a person only ever confirms what is still true.
 */
export type ApplicationStoreEnvironment = FirstInstallFlowEnvironment & UpgradeRoleEnvironment;

type Outputs = Readonly<Record<string, JsonValue>>;

/** A result the protected operation executor maps: available outputs, a refusal, a failure or a conflict. */
export type ApplicationStoreResult = HumanOrganizationRequestResult<Outputs> | "conflict";

/** Why the latest version can be neither installed nor upgraded to here, as the review names it. */
type UnavailableReason =
  | "not_published"
  | "module_set_changed"
  | "installation_incomplete"
  | "registration_misaligned"
  | "unsupported";

const maximumRoleChangeLines = 100;

const applicationRootInput = (candidate: unknown) => applicationRootIdSchema.safeParse(candidate);

const organizationOf = (selection: OrganizationSelectionCandidate) =>
  organizationIdSchema.parse(selection.organizationId);

const reviewOutputs = (
  values: Partial<Record<string, JsonValue>> & Readonly<{ change: string }>,
): Outputs =>
  ({
    reason: "",
    application_name: "",
    release_version: "",
    installed_version: "",
    release_note: "",
    member_role_name: "",
    member_role_permissions: [],
    role_changes: [],
    role_change_count: 0,
    role_ids: [],
    expected: {},
    ...values,
  }) as Outputs;

/** A review that names why neither an install nor an upgrade is possible; the flow explains it. */
const unavailable = (reason: UnavailableReason): ApplicationStoreResult => ({
  kind: "available",
  value: reviewOutputs({ change: "unavailable", reason }),
});

/** The review's answer to a failure: a named unavailability the flow explains, or the failure itself. */
const reviewFailure = (error: unknown): ApplicationStoreResult => {
  if (error instanceof FirstInstallUnavailable) {
    console.error(`[installation] application review unavailable: ${describeFailure(error)}`);
    switch (error.reason) {
      case "release_not_published":
        return unavailable("not_published");
      case "installation_incomplete":
        return unavailable("installation_incomplete");
      default:
        return unavailable("unsupported");
    }
  }
  const problem: InstallationProblemShape = classifyInstallationFailure(error);
  switch (problem.unavailableReason) {
    case "module_set_changed":
      return unavailable("module_set_changed");
    case "installation_incomplete":
      return unavailable("installation_incomplete");
    case "registration_misaligned":
      return unavailable("registration_misaligned");
    case "unsupported_root":
    case "not_installed":
      return unavailable("unsupported");
    default:
      break;
  }
  // A review changes nothing, so a state that moved while it read is a failure to read, not a conflict.
  return problem.kind === "conflict"
    ? { kind: "temporarily_unavailable" }
    : commandFailure(problem);
};

/** A command's failure: a conflict, a refusal (permission or eligibility) or a temporary failure. */
const commandFailure = (problem: InstallationProblemShape): ApplicationStoreResult => {
  if (problem.kind === "conflict") return "conflict";
  if (problem.kind === "authentication_required")
    return { kind: "unavailable", code: "recent_authentication_required" };
  if (problem.kind === "refused") return { kind: "unavailable" };
  return { kind: "temporarily_unavailable" };
};

const commandFailureOf = (error: unknown): ApplicationStoreResult => {
  if (error instanceof FirstInstallUnavailable) {
    console.error(`[installation] application command unavailable: ${describeFailure(error)}`);
    return error.reason === "already_installed" ? "conflict" : { kind: "unavailable" };
  }
  return commandFailure(classifyInstallationFailure(error));
};

const installReview = (candidate: FirstInstallCandidate): Outputs => {
  const role = candidate.snapshot.memberRole;
  return reviewOutputs({
    change: candidate.snapshot.registrationState === "active_exact" ? "current" : "install",
    application_name: candidate.releaseSet.application.content.name,
    release_version: candidate.snapshot.selected.releaseVersion,
    installed_version:
      candidate.snapshot.registrationState === "active_exact"
        ? candidate.snapshot.selected.releaseVersion
        : "",
    release_note: candidate.snapshot.latest.releaseNote,
    member_role_name: role.name,
    member_role_permissions: role.permissions
      .slice(0, maximumRoleChangeLines)
      .map((permission) => permission.label),
    expected: JSON.parse(canonicalJson(candidate.snapshot)) as JsonValue,
  });
};

/**
 * What installing or upgrading the application to its latest published version would do, for the
 * person asking: the version, its release note, and for a first install the default member role the
 * installer is offered, or for an upgrade every role whose accepted access the new version changes.
 */
const review = async (
  environment: ApplicationStoreEnvironment,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  inputs: Readonly<Record<string, unknown>>,
): Promise<ApplicationStoreResult> => {
  const rootId = applicationRootInput(inputs.application_root_id);
  if (!rootId.success) return { kind: "unavailable" };
  const organizationId = organizationOf(selection);
  try {
    const latest = await readCurrentApplicationLatestRelease(
      environment,
      session,
      organizationId,
      rootId.data,
    );
    const selector = {
      organizationId,
      rootId: rootId.data,
      releaseRevision: latest.releaseRevision,
    };
    try {
      const candidate = await readCurrentFirstInstallCandidate(environment, session, selector);
      return { kind: "available", value: installReview(candidate) };
    } catch (error) {
      // Installed at an earlier version: the latest one is an upgrade.
      if (!(error instanceof FirstInstallUnavailable) || error.reason !== "already_installed")
        throw error;
    }
    const authorized = await readUpgradeAuthorizedState(environment, selector, session, true);
    const application = authorized.state.selectedReleaseSet.application;
    if (authorized.snapshot.selected.releaseRevision === authorized.snapshot.active.releaseRevision)
      return {
        kind: "available",
        value: reviewOutputs({
          change: "current",
          application_name: application.content.name,
          release_version: authorized.snapshot.selected.releaseVersion,
          installed_version: authorized.snapshot.active.releaseVersion,
          release_note: latest.releaseNote,
        }),
      };
    // Reading the changed roles needs the role-reading permission; without it the upgrade still
    // goes ahead and every change waits in IAM, which the review says instead of listing them.
    const revisions = await readUpgradeRoleRevisions(
      environment,
      session,
      selector,
      authorized.state,
    ).catch((error: unknown) => {
      console.error(`[installation] upgrade role changes unreadable: ${describeFailure(error)}`);
      return undefined;
    });
    if (revisions === undefined)
      return {
        kind: "available",
        value: reviewOutputs({
          change: "upgrade",
          application_name: application.content.name,
          release_version: authorized.snapshot.selected.releaseVersion,
          installed_version: authorized.snapshot.active.releaseVersion,
          release_note: latest.releaseNote,
          role_changes: [
            "The roles this version changes could not be read with your access. People keep the access they have; the changes wait in IAM.",
          ],
          expected: JSON.parse(canonicalJson(authorized.snapshot)) as JsonValue,
        }),
      };
    return {
      kind: "available",
      value: reviewOutputs({
        change: "upgrade",
        application_name: application.content.name,
        release_version: authorized.snapshot.selected.releaseVersion,
        installed_version: authorized.snapshot.active.releaseVersion,
        release_note: latest.releaseNote,
        role_changes: revisions
          .slice(0, maximumRoleChangeLines)
          .map((revision) => `${revision.label}: ${revision.changes.join("; ")}`),
        role_change_count: revisions.length,
        role_ids: revisions.map((revision) => revision.roleId),
        expected: JSON.parse(canonicalJson(authorized.snapshot)) as JsonValue,
      }),
    };
  } catch (error) {
    return reviewFailure(error);
  }
};

const yes = (value: unknown): boolean => value === true;

const firstInstallExpectedSchema = z
  .object({ selected: z.object({ releaseRevision: z.number().int().positive() }).passthrough() })
  .passthrough();

/**
 * Installs the reviewed version for the first time: registers its access if that is not done yet,
 * then applies the installer's choice for the default member role and activates the release. Each
 * step runs only while the state is exactly the one the person reviewed.
 */
const install = async (
  environment: ApplicationStoreEnvironment,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  inputs: Readonly<Record<string, unknown>>,
): Promise<ApplicationStoreResult> => {
  const rootId = applicationRootInput(inputs.application_root_id);
  const expected = firstInstallExpectedSchema.safeParse(inputs.expected);
  if (!rootId.success || !expected.success) return { kind: "unavailable" };
  const organizationId = organizationOf(selection);
  const selector = {
    organizationId,
    rootId: rootId.data,
    releaseRevision: expected.data.selected.releaseRevision,
  };
  try {
    const reviewed = expected.data as unknown as FirstInstallCandidate["snapshot"];
    let candidate = await readCurrentFirstInstallCandidate(
      environment,
      session,
      selector,
      reviewed,
    );
    const state = candidate.snapshot.registrationState;
    if (state === "unprepared" || state === "registration_aligned_partial") {
      await createFirstInstallCoordinator(
        environment,
        candidate.selector,
        candidate.snapshot,
        candidate.releaseSet,
        "prepare",
      ).prepare(session, {
        organizationId,
        applicationRootId: rootId.data,
        applicationReleaseRevision: selector.releaseRevision,
      });
      candidate = await readCurrentFirstInstallCandidate(environment, session, selector);
      if (
        canonicalJson(candidate.snapshot.selected) !== canonicalJson(reviewed.selected) ||
        canonicalJson(candidate.snapshot.memberRole) !== canonicalJson(reviewed.memberRole)
      )
        return "conflict";
    }
    if (candidate.snapshot.registrationState !== "provisioned_inactive") return "conflict";
    const acceptRole = yes(inputs.accept_member_role);
    await activateFirstInstall(
      environment,
      candidate,
      acceptRole
        ? { kind: "accept", sourceRoleId: candidate.snapshot.memberRole.sourceRoleId }
        : { kind: "decline" },
    );
    return {
      kind: "available",
      value: {
        application_name: candidate.releaseSet.application.content.name,
        release_version: candidate.snapshot.selected.releaseVersion,
        member_role_granted: acceptRole,
      },
    };
  } catch (error) {
    return commandFailureOf(error);
  }
};

const upgradeExpectedSchema = z
  .object({
    selected: z.object({ releaseRevision: z.number().int().positive() }).passthrough(),
    validUntil: z.string().min(1),
  })
  .passthrough();

/**
 * Upgrades the application to the reviewed version. With the person's explicit choice it also
 * accepts the reviewed role changes; otherwise every role keeps exactly the access it accepted and
 * its change waits in role administration.
 */
const upgrade = async (
  environment: ApplicationStoreEnvironment,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  inputs: Readonly<Record<string, unknown>>,
): Promise<ApplicationStoreResult> => {
  const rootId = applicationRootInput(inputs.application_root_id);
  const expected = upgradeExpectedSchema.safeParse(inputs.expected);
  const roleIds = z.array(roleIdSchema).max(maximumRoleChangeLines).safeParse(inputs.role_ids);
  if (!rootId.success || !expected.success || !roleIds.success) return { kind: "unavailable" };
  const selector: UpgradeSelector = {
    organizationId: organizationOf(selection),
    rootId: rootId.data,
    releaseRevision: expected.data.selected.releaseRevision,
  };
  try {
    const reviewed = expected.data as unknown as UpgradeSnapshot;
    const current = await readUpgradeAuthorizedState(environment, selector, session, false);
    const now = Date.parse(current.checkedAt);
    if (
      !Number.isFinite(now) ||
      Date.parse(reviewed.validUntil) <= now ||
      Date.parse(current.snapshot.validUntil) <= now ||
      !sameUpgradeSnapshotState(reviewed, current.snapshot)
    )
      return "conflict";
    const acceptRoleIds = yes(inputs.accept_role_changes) ? roleIds.data : [];
    const { acceptedRoleIds } = await upgradeWithRoleRevisions(
      environment,
      selector,
      current.state,
      session,
      acceptRoleIds,
    );
    return {
      kind: "available",
      value: {
        application_name: current.state.selectedReleaseSet.application.content.name,
        release_version: current.snapshot.selected.releaseVersion,
        accepted_role_count: acceptedRoleIds.length,
        waiting_role_count: roleIds.data.length - acceptedRoleIds.length,
      },
    };
  } catch (error) {
    return commandFailureOf(error);
  }
};

/** The application catalogue's three journeys, bound to the application's installation environment. */
export const createApplicationStoreService = (environment: ApplicationStoreEnvironment) => ({
  review: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    inputs: Readonly<Record<string, unknown>>,
  ) => review(environment, session, selection, inputs),
  install: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    inputs: Readonly<Record<string, unknown>>,
  ) => install(environment, session, selection, inputs),
  upgrade: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    inputs: Readonly<Record<string, unknown>>,
  ) => upgrade(environment, session, selection, inputs),
});

export type ApplicationStoreService = ReturnType<typeof createApplicationStoreService>;
