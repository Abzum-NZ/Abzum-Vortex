import "server-only";

import { z } from "zod";
import type { HumanOrganizationRequestResult } from "../access/index";
import {
  applicationRootIdSchema,
  canonicalJson,
  describeFailure,
  organizationIdSchema,
  roleIdSchema,
  type FlowRefusalFeedback,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "../schema";
import type {
  InstallationMemberRoleRefusal,
  InstallationProblemShape,
} from "./installation-authority";
import { maximumApplicationRoles } from "./application-contracts";
import { classifyInstallationFailure } from "./installation-failure";
import { FirstInstallUnavailable } from "./installation-first-install";
import {
  readCurrentApplicationLatestRelease,
  readCurrentFirstInstallCandidate,
  type FirstInstallCandidate,
  type FirstInstallFlowEnvironment,
} from "./installation-first-install-app";
import { createFirstInstallCoordinator } from "./installation-first-install-coordinator";
import { activateFirstInstall, readMemberRoleAssignable } from "./installation-first-install-roles";
import { releaseMemberRole, type ApplicationRoleChange } from "./installation-role-templates";
import { readApplicationRemoval, removeApplication } from "./installation-removal";
import {
  readUpgradeAuthorizedState,
  sameUpgradeSnapshotState,
  type UpgradeSelector,
  type UpgradeSnapshot,
} from "./installation-upgrade";
import {
  readUpgradeRoleChanges,
  upgradeWithRoleChanges,
  type UpgradeRoleEnvironment,
} from "./installation-upgrade-roles";

/**
 * The installation journeys of the organisation's application catalogue, as registered
 * platform operations a flow calls: a review that says whether the selected application's latest
 * published version would be a first install, an upgrade, role changes still to accept or
 * nothing, and the install, upgrade and removal themselves. They are the one human path to install,
 * upgrade and accept an application's roles; each runs the shared installation functions under the
 * person's own authority: the installation authority alone (managing applications, with the
 * delegated scope and recent sign-in a role acceptance needs), never role management or a right on
 * the application's draft. They re-prove that authority, the latest published version, the release
 * and the bindings in their own transactions. The review hands the caller the exact state it
 * showed (`expected`); the install and the upgrade refuse as a conflict when that state moved, so
 * a person only ever confirms what is still true.
 */
export type ApplicationStoreEnvironment = FirstInstallFlowEnvironment & UpgradeRoleEnvironment;

type Outputs = Readonly<Record<string, JsonValue>>;

/** A result the protected operation executor maps: available outputs, a refusal, a failure or a conflict. */
export type ApplicationStoreResult =
  | HumanOrganizationRequestResult<Outputs>
  | "conflict"
  | Readonly<{
      kind: "confirmed_failure";
      outcome: "refused";
      diagnostic: FlowRefusalFeedback;
    }>;

/** Why the latest version can be neither installed nor upgraded to here, as the review names it. */
type UnavailableReason =
  | "not_published"
  | "module_set_changed"
  | "installation_incomplete"
  | "registration_misaligned"
  | "unsupported";

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
    roles: [],
    member_role_name: "",
    member_role_assignable: false,
    role_changes: [],
    role_change_count: 0,
    role_template_ids: [],
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

/**
 * The one mapping from a refusal that names its missing piece to the public code the person is
 * shown; the cause stays in the log. A retired role or access changed meanwhile stay untyped.
 */
const namedRefusalCodes: Readonly<
  Partial<Record<InstallationMemberRoleRefusal, FlowRefusalFeedback["code"]>>
> = {
  installation_authority: "applications_manage_required",
  member_role_delegation: "installation_delegation_required",
  assignments_manage: "assignments_manage_required",
};

/** A command's failure: a conflict, a refusal (permission or eligibility) or a temporary failure. */
const commandFailure = (problem: InstallationProblemShape): ApplicationStoreResult => {
  if (problem.unavailableReason === "storage_incompatible")
    return {
      kind: "confirmed_failure",
      outcome: "refused",
      diagnostic: { code: "application_storage_incompatible" },
    };
  if (problem.kind === "conflict") return "conflict";
  if (problem.unavailableReason === "not_installed")
    return {
      kind: "confirmed_failure",
      outcome: "refused",
      diagnostic: { code: "application_not_installed" },
    };
  if (problem.unavailableReason === "not_newer")
    return {
      kind: "confirmed_failure",
      outcome: "refused",
      diagnostic: { code: "application_not_newer" },
    };
  if (problem.kind === "authentication_required")
    return { kind: "unavailable", code: "recent_authentication_required" };
  if (problem.kind === "refused") {
    const code =
      problem.memberRoleRefusal === undefined
        ? undefined
        : namedRefusalCodes[problem.memberRoleRefusal];
    return code === undefined
      ? { kind: "unavailable" }
      : { kind: "confirmed_failure", outcome: "refused", diagnostic: { code } };
  }
  return { kind: "temporarily_unavailable" };
};

const commandFailureOf = (error: unknown): ApplicationStoreResult => {
  if (error instanceof FirstInstallUnavailable) {
    console.error(`[installation] application command unavailable: ${describeFailure(error)}`);
    return error.reason === "already_installed" ? "conflict" : { kind: "unavailable" };
  }
  return commandFailure(classifyInstallationFailure(error));
};

const expectedOf = (snapshot: unknown): JsonValue =>
  JSON.parse(canonicalJson(snapshot)) as JsonValue;

/**
 * One line per role change, in plain words: who holds the role and what accepting changes. A role
 * the version adds is held by nobody until it is assigned.
 */
const roleChangeLine = (change: ApplicationRoleChange): string =>
  change.roleId === undefined
    ? `${change.name}, a new role nobody holds yet, lets people: ${change.changes.join(", ")}`
    : `${change.name}, held by ${change.holders} ${change.holders === 1 ? "person or Group" : "people or Groups"}: ${change.changes.join("; ")}`;

/**
 * A first install: every role the version offers (installing makes each an organisation role that
 * nobody holds until it is assigned), and whether the installer may take the default member role.
 */
const installReview = async (
  environment: ApplicationStoreEnvironment,
  session: IdentitySession,
  candidate: FirstInstallCandidate,
): Promise<Outputs> => {
  const roles = candidate.snapshot.roles;
  return reviewOutputs({
    change: "install",
    application_name: candidate.releaseSet.application.content.name,
    release_version: candidate.snapshot.selected.releaseVersion,
    release_note: candidate.snapshot.latest.releaseNote,
    roles: roles.map(
      (role) =>
        `${role.name}: ${role.permissions.map((permission) => permission.description).join(" ")}`,
    ),
    member_role_name: releaseMemberRole(roles).name,
    member_role_assignable: await readMemberRoleAssignable(
      environment,
      session,
      candidate.selector,
    ),
    expected: expectedOf(candidate.snapshot),
  });
};

/**
 * What installing or upgrading the application to its latest published version would do, for the
 * person asking: the version and its release note; for a first install every role it offers; for
 * an upgrade every role it adds or changes. When the latest version is installed but some of its
 * role changes were not accepted, the review offers exactly those.
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
      if (candidate.snapshot.registrationState !== "active_exact")
        return { kind: "available", value: await installReview(environment, session, candidate) };
    } catch (error) {
      // Installed at an earlier version: the latest one is an upgrade.
      if (!(error instanceof FirstInstallUnavailable) || error.reason !== "already_installed")
        throw error;
    }
    const authorized = await readUpgradeAuthorizedState(environment, selector, session, true);
    const application = authorized.state.selectedReleaseSet.application;
    const changes = await readUpgradeRoleChanges(environment, session, selector, authorized.state);
    const installed =
      authorized.snapshot.selected.releaseRevision === authorized.snapshot.active.releaseRevision;
    return {
      kind: "available",
      value: reviewOutputs({
        change: !installed ? "upgrade" : changes.length > 0 ? "roles" : "current",
        application_name: application.content.name,
        release_version: authorized.snapshot.selected.releaseVersion,
        installed_version: authorized.snapshot.active.releaseVersion,
        release_note: latest.releaseNote,
        role_changes: changes.map(roleChangeLine),
        role_change_count: changes.length,
        role_template_ids: changes.map((change) => change.sourceRoleId),
        expected: expectedOf({
          ...authorized.snapshot,
          roleRevisions: changes.map(({ sourceRoleId, roleId, liveRevision }) => ({
            sourceRoleId,
            roleId: roleId ?? null,
            liveRevision: liveRevision ?? null,
          })),
        }),
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
 * makes every role it offers an organisation role, applies the installer's choice for the default
 * member role and activates the release. Each step runs only while the state is exactly the one the
 * person reviewed.
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
        canonicalJson(candidate.snapshot.roles) !== canonicalJson(reviewed.roles)
      )
        return "conflict";
    }
    if (candidate.snapshot.registrationState !== "provisioned_inactive") return "conflict";
    const acceptRole = yes(inputs.accept_member_role);
    await activateFirstInstall(
      environment,
      candidate,
      acceptRole
        ? { kind: "accept", sourceRoleId: releaseMemberRole(candidate.snapshot.roles).sourceRoleId }
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
    active: z.object({ releaseRevision: z.number().int().positive() }).passthrough(),
    validUntil: z.string().min(1),
    roleRevisions: z
      .array(
        z
          .object({
            sourceRoleId: roleIdSchema,
            roleId: roleIdSchema.nullable(),
            liveRevision: z.number().int().positive().nullable(),
          })
          .strict(),
      )
      .max(maximumApplicationRoles),
  })
  .passthrough();

/**
 * Upgrades the application to the reviewed version and accepts the role changes the person reviewed,
 * or, when the reviewed version is already installed, accepts only those. Any refusal rolls back
 * the complete acceptance set; a later review offers the pending changes again.
 */
const upgrade = async (
  environment: ApplicationStoreEnvironment,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  inputs: Readonly<Record<string, unknown>>,
): Promise<ApplicationStoreResult> => {
  const rootId = applicationRootInput(inputs.application_root_id);
  const expected = upgradeExpectedSchema.safeParse(inputs.expected);
  const roleTemplateIds = z
    .array(roleIdSchema)
    .max(maximumApplicationRoles)
    .safeParse(inputs.role_template_ids);
  if (!rootId.success || !expected.success || !roleTemplateIds.success)
    return { kind: "unavailable" };
  const selector: UpgradeSelector = {
    organizationId: organizationOf(selection),
    rootId: rootId.data,
    releaseRevision: expected.data.selected.releaseRevision,
  };
  try {
    const reviewed = expected.data as unknown as UpgradeSnapshot;
    // Reviewing an installed version offers only its role changes still to accept.
    const rolesOnly = reviewed.selected.releaseRevision === reviewed.active.releaseRevision;
    const current = await readUpgradeAuthorizedState(environment, selector, session, rolesOnly);
    const now = Date.parse(current.checkedAt);
    if (
      !Number.isFinite(now) ||
      Date.parse(reviewed.validUntil) <= now ||
      Date.parse(current.snapshot.validUntil) <= now ||
      !sameUpgradeSnapshotState(reviewed, current.snapshot)
    )
      return "conflict";
    const { accepted, notAccepted } = await upgradeWithRoleChanges(
      environment,
      selector,
      current.state,
      session,
      roleTemplateIds.data,
      expected.data.roleRevisions,
    );
    return {
      kind: "available",
      value: {
        application_name: current.state.selectedReleaseSet.application.content.name,
        release_version: current.snapshot.selected.releaseVersion,
        accepted_role_count: accepted.length,
        waiting_role_count: notAccepted.length,
      },
    };
  } catch (error) {
    return commandFailureOf(error);
  }
};

/** The application catalogue's journeys, bound to the application's installation environment. */
export const createApplicationStoreService = (environment: ApplicationStoreEnvironment) => ({
  reviewRemoval: async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    inputs: Readonly<Record<string, unknown>>,
  ): Promise<ApplicationStoreResult> => {
    const rootId = applicationRootInput(inputs.application_root_id);
    if (!rootId.success) return { kind: "unavailable" };
    try {
      const current = await readApplicationRemoval(
        environment,
        session,
        organizationOf(selection),
        rootId.data,
      );
      return {
        kind: "available",
        value: {
          application_name: current.releaseSet.application.content.name,
          installed_version: current.releaseSet.application.releaseVersion,
          expected: JSON.parse(canonicalJson(current.expected)) as JsonValue,
        },
      };
    } catch (error) {
      const result = commandFailureOf(error);
      return result === "conflict" ? { kind: "unavailable" } : result;
    }
  },
  remove: async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    inputs: Readonly<Record<string, unknown>>,
  ): Promise<ApplicationStoreResult> => {
    const rootId = applicationRootInput(inputs.application_root_id);
    if (!rootId.success) return { kind: "unavailable" };
    try {
      return {
        kind: "available",
        value: await removeApplication(
          environment,
          session,
          organizationOf(selection),
          rootId.data,
          inputs.expected,
        ),
      };
    } catch (error) {
      return commandFailureOf(error);
    }
  },
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
