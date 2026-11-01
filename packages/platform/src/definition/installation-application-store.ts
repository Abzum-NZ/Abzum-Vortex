import "server-only";

import { z } from "zod";
import type { HumanOrganizationRequestResult } from "../access/human-organization-request";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import type { JsonValue } from "../catalogue/common";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  roleIdSchema,
} from "../catalogue/identifiers";
import { describeFailure } from "../catalogue/runtime-primitives";
import type { FlowRefusalFeedback } from "../workflows/flow-refusal-feedback";
import { canonicalJson } from "./canonical-json";
import {
  InstallationProblem,
  type InstallationMemberRoleRefusal,
  type InstallationProblemShape,
  type ReceiptStep,
  type StoreReceiptCompletion,
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
import {
  activateFirstInstall,
  readMemberRoleAssignable,
  resumeFirstInstallRoles,
} from "./installation-first-install-roles";
import { releaseMemberRole, type ApplicationRoleChange } from "./installation-role-templates";
import {
  ApplicationPurgeRefused,
  type ApplicationPurgeImpact,
  purgeApplication,
  readApplicationPurge,
  requireApplicationChangeStepUp,
} from "./installation-purge";
import {
  createApplicationAuthoringService,
  type NewApplicationSourceBuilder,
} from "./installation-application-authoring";
import { readApplicationRemoval, removeApplication } from "./installation-removal";
import {
  readUpgradeAuthorizedState,
  sameUpgradeSelectedSnapshot,
  sameUpgradeSnapshotState,
  upgradeModuleChanges,
  type UpgradeSelector,
  type UpgradeSnapshot,
} from "./installation-upgrade";
import {
  readUpgradeRoleChanges,
  resumeUpgradeRoleChanges,
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
type ApplicationStoreEnvironment = FirstInstallFlowEnvironment &
  UpgradeRoleEnvironment &
  Readonly<{ newApplicationSource: NewApplicationSourceBuilder }>;

export type { StoreReceiptCompletion };

type Outputs = Readonly<Record<string, JsonValue>>;

/** A result the protected operation executor maps: available outputs, a refusal, a failure or a conflict. */
type ApplicationStoreResult =
  | HumanOrganizationRequestResult<Outputs>
  | "conflict"
  | "uncertain"
  | Readonly<{
      kind: "confirmed_failure";
      outcome: "refused" | "conflict";
      diagnostic: FlowRefusalFeedback;
    }>;

/** Why the latest version can be neither installed nor upgraded to here, as the review names it. */
type UnavailableReason =
  "not_published" | "installation_incomplete" | "registration_misaligned" | "unsupported";

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
    module_changes: "",
    roles: [],
    member_role_name: "",
    member_role_assignable: false,
    role_changes: [],
    role_change_count: 0,
    role_template_ids: [],
    expected: {},
    ...values,
  }) as Outputs;

/** The words a person uses for each standard record operation, in the order they are listed. */
const standardOperationWords: ReadonlyArray<readonly [string, string]> = [
  ["read", "view"],
  ["create", "create"],
  ["update", "edit"],
  ["soft delete", "delete"],
  ["restore", "restore"],
  ["export", "export"],
];
const standardPermission = /^Allows the standard (.+) operation for (.+)\.$/u;

const listWords = (words: readonly string[]): string =>
  words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/**
 * One role as the install or upgrade confirmation lists it: the role's name as the heading, then
 * what the role allows, one line per record type and one line for each other permission. The
 * confirmation nests these lines under the role, so no dense sentence is ever shown.
 */
type ApplicationStoreRoleSummary = Readonly<{
  text: string;
  lines: string[];
}>;

/** A standard record permission's operation and the record types it covers. */
const standardOperationOf = (
  label: string,
): Readonly<{ operation: string; records: string }> | undefined => {
  const match = standardPermission.exec(label);
  return match === null
    ? undefined
    : { operation: (match[1] ?? "").replaceAll("_", " "), records: match[2] ?? "" };
};

/** The words a person uses for a set of standard operations, in the order they are listed. */
const operationWords = (operations: ReadonlySet<string>): string =>
  listWords(
    standardOperationWords
      .filter(([operation]) => operations.has(operation))
      .map(([, word]) => word),
  );

/**
 * One line per record type for a role's standard operations: what it gains and, when accepting the
 * version also takes an operation away, what it loses.
 */
const operationsLine = (
  gained: ReadonlySet<string> | undefined,
  lost: ReadonlySet<string> | undefined,
  records: string,
): string => {
  if (gained === undefined) return `Can no longer ${operationWords(lost ?? new Set())} ${records}.`;
  if (lost === undefined) return `Can ${operationWords(gained)} ${records}.`;
  return `Can ${operationWords(gained)} ${records}, and can no longer ${operationWords(lost)} ${records}.`;
};

/**
 * One role's summary: its standard record permissions grouped by record type ("can view, create,
 * edit, delete, restore and export assets") as one line each, then its other permissions as
 * written.
 */
const roleSummaryLine = (
  role: Readonly<{
    name: string;
    permissions: readonly Readonly<{ description: string }>[];
  }>,
): ApplicationStoreRoleSummary => {
  const operationsByRecords = new Map<string, Set<string>>();
  const others: string[] = [];
  for (const { description } of role.permissions) {
    const standard = standardOperationOf(description);
    if (standard === undefined) {
      others.push(description);
      continue;
    }
    operationsByRecords.set(
      standard.records,
      (operationsByRecords.get(standard.records) ?? new Set()).add(standard.operation),
    );
  }
  const standard = [...operationsByRecords].map(([records, operations]) =>
    operationsLine(operations, undefined, records),
  );
  return { text: role.name, lines: [...standard, ...others] };
};

/** A review that names why neither an install nor an upgrade is possible; the flow explains it. */
const unavailable = (reason: UnavailableReason): ApplicationStoreResult => ({
  kind: "available",
  value: reviewOutputs({ change: "unavailable", reason }),
});

/** The review's answer to a failure: a named unavailability the flow explains, or the failure itself. */
const reviewFailure = (error: unknown): ApplicationStoreResult => {
  if (error instanceof FirstInstallUnavailable) {
    console.info(`[installation] application review unavailable: ${describeFailure(error)}`);
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
  if (problem.unavailableReason === "republish_required")
    return {
      kind: "confirmed_failure",
      outcome: "refused",
      diagnostic: { code: "application_republish_required" },
    };
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
  if (problem.kind === "multi_factor_required")
    return { kind: "unavailable", code: "multi_factor_required" };
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
  if (error instanceof InstallationProblem && error.code === "first_install_latest_release_moved") {
    console.error(`[installation] application release changed: ${describeFailure(error)}`);
    return releaseChanged();
  }
  return commandFailure(classifyInstallationFailure(error));
};

/**
 * A failure after the release was activated leaves part of the journey saved, so it is reported as
 * uncertain: a retry of the same command resumes toward the target. Before activation it is a
 * plain failure that changed nothing.
 */
const afterActivation = (result: ApplicationStoreResult): ApplicationStoreResult =>
  result !== "conflict" && result !== "uncertain" && result.kind === "temporarily_unavailable"
    ? "uncertain"
    : result;

const releaseChanged = (): ApplicationStoreResult => ({
  kind: "confirmed_failure",
  outcome: "conflict",
  diagnostic: { code: "application_release_changed" },
});

const expectedOf = (snapshot: unknown): JsonValue =>
  JSON.parse(canonicalJson(snapshot)) as JsonValue;

/**
 * One role change as the upgrade confirmation lists it: the role's line, then what accepting the
 * version changes, one line per record type and one line for each other change. A role the version
 * adds is held by nobody until it is assigned; a new role's whole permission set is its change.
 */
const roleChangeSummary = (change: ApplicationRoleChange): ApplicationStoreRoleSummary => {
  const added = new Map<string, Set<string>>();
  const removed = new Map<string, Set<string>>();
  const others: string[] = [];
  const collect = (target: Map<string, Set<string>>, label: string): boolean => {
    const standard = standardOperationOf(label);
    if (standard === undefined) return false;
    target.set(
      standard.records,
      (target.get(standard.records) ?? new Set()).add(standard.operation),
    );
    return true;
  };
  for (const line of change.changes) {
    if (line.startsWith("+ ")) {
      if (collect(added, line.slice(2))) continue;
    } else if (line.startsWith("− ")) {
      if (collect(removed, line.slice(2))) continue;
    } else if (collect(added, line)) continue;
    others.push(line);
  }
  const lines = [...new Set([...added.keys(), ...removed.keys()])].map((records) =>
    operationsLine(added.get(records), removed.get(records), records),
  );
  return {
    text:
      change.roleId === undefined
        ? `${change.name}, a new role nobody holds yet`
        : `${change.name}, held by ${change.holders} ${change.holders === 1 ? "person or Group" : "people or Groups"}`,
    lines: [...lines, ...others],
  };
};

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
    roles: roles.map(roleSummaryLine),
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
        module_changes: installed ? "" : upgradeModuleChanges(authorized.state),
        role_changes: changes.map(roleChangeSummary),
        role_change_count: changes.length,
        role_template_ids: changes.map((change) => change.sourceRoleId),
        expected: expectedOf({
          ...authorized.snapshot,
          latest,
          roleRevisions: changes.map(
            ({ sourceRoleId, roleId, liveRevision, registrationRevision }) => ({
              sourceRoleId,
              roleId: roleId ?? null,
              liveRevision: liveRevision ?? null,
              registrationRevision: registrationRevision ?? null,
            }),
          ),
        }),
      }),
    };
  } catch (error) {
    return reviewFailure(error);
  }
};

const yes = (value: unknown): boolean => value === true;

/**
 * Removes an application and everything it holds after the typed name matches: a removed or
 * installed application is purged, and deleting refuses an installed one.
 */
const purgeJourney = async (
  environment: ApplicationStoreEnvironment,
  deleteOnly: boolean,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  inputs: Readonly<Record<string, unknown>>,
  receipt?: StoreReceiptCompletion,
): Promise<ApplicationStoreResult> => {
  const rootId = applicationRootInput(inputs.application_root_id);
  const confirmedName = z.string().min(1).max(200).safeParse(inputs.confirm_name);
  if (!rootId.success || !confirmedName.success) return { kind: "unavailable" };
  try {
    return {
      kind: "available",
      value: await purgeApplication(
        environment,
        session,
        organizationOf(selection),
        rootId.data,
        confirmedName.data,
        deleteOnly,
        receipt,
      ),
    };
  } catch (error) {
    return purgeFailure(error);
  }
};

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** The impact of a purge as the short lines the confirmation lists, and the facts behind them. */
const purgeReview = (impact: ApplicationPurgeImpact): Outputs => {
  const lines = [
    `${plural(impact.roles, "role", "roles")} and ${plural(impact.role_assignments, "person or group assignment", "person and group assignments")}`,
    plural(impact.permission_entries, "permission entry", "permission entries"),
    `${plural(impact.records, "record", "records")} in ${plural(impact.record_tables, "record table", "record tables")}`,
    plural(impact.releases, "published version", "published versions"),
    ...(impact.external_links === 0
      ? []
      : [
          `${plural(impact.external_links, "link", "links")} from records of other applications into it`,
        ]),
  ];
  return { ...impact, impact_lines: lines };
};

/** A purge's refusal the person is told by name, or the shared mapping of any other failure. */
const purgeFailure = (error: unknown): ApplicationStoreResult =>
  error instanceof ApplicationPurgeRefused
    ? {
        kind: "confirmed_failure",
        outcome: "refused",
        diagnostic: { code: error.code },
      }
    : commandFailureOf(error);

const firstInstallExpectedSchema = z
  .object({ selected: z.object({ releaseRevision: z.number().int().positive() }).passthrough() })
  .passthrough();

/**
 * Installs the reviewed version for the first time: registers its access if that is not done yet,
 * makes every role it offers an organisation role, applies the installer's choice for the default
 * member role and activates the release. A retry reuses progress toward the reviewed target.
 */
const install = async (
  environment: ApplicationStoreEnvironment,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  inputs: Readonly<Record<string, unknown>>,
  receipt?: StoreReceiptCompletion,
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
  let activated = false;
  try {
    const reviewed = expected.data as unknown as FirstInstallCandidate["snapshot"];
    let candidate = await readCurrentFirstInstallCandidate(
      environment,
      session,
      selector,
      reviewed,
    );
    const state = candidate.snapshot.registrationState;
    activated = state === "active_exact";
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
      candidate = await readCurrentFirstInstallCandidate(environment, session, selector, reviewed);
    }
    const acceptRole = yes(inputs.accept_member_role);
    const choice = acceptRole
      ? {
          kind: "accept" as const,
          sourceRoleId: releaseMemberRole(candidate.snapshot.roles).sourceRoleId,
        }
      : { kind: "decline" as const };
    const reported = {
      application_name: candidate.releaseSet.application.content.name,
      release_version: candidate.snapshot.selected.releaseVersion,
      member_role_granted: acceptRole,
    };
    // Reaching the install's target (activation, or the member assignment that follows it)
    // completes the claimed receipt in that same transaction.
    const complete: ReceiptStep | undefined =
      receipt === undefined ? undefined : (transaction) => receipt(transaction, reported);
    if (candidate.snapshot.registrationState === "provisioned_inactive") {
      await activateFirstInstall(environment, candidate, choice, complete);
      activated = true;
      if (choice.kind === "accept") {
        candidate = await readCurrentFirstInstallCandidate(
          environment,
          session,
          selector,
          reviewed,
        );
        if (candidate.snapshot.registrationState !== "active_exact") return "conflict";
        await resumeFirstInstallRoles(environment, candidate, choice, complete);
      }
    } else if (candidate.snapshot.registrationState === "active_exact") {
      await resumeFirstInstallRoles(environment, candidate, choice, complete);
      candidate = await readCurrentFirstInstallCandidate(environment, session, selector, reviewed);
      if (candidate.snapshot.registrationState !== "active_exact") return "conflict";
    } else return "conflict";
    return { kind: "available", value: reported };
  } catch (error) {
    const failure = commandFailureOf(error);
    return activated ? afterActivation(failure) : failure;
  }
};

const upgradeExpectedSchema = z
  .object({
    selected: z.object({ releaseRevision: z.number().int().positive() }).passthrough(),
    active: z.object({ releaseRevision: z.number().int().positive() }).passthrough(),
    latest: z
      .object({
        definitionKey: z.string().min(1),
        releaseRevision: z.number().int().positive(),
        releaseVersion: z.string().min(1),
        releaseNote: z.string(),
      })
      .strict(),
    validUntil: z.string().min(1),
    roleRevisions: z
      .array(
        z
          .object({
            sourceRoleId: roleIdSchema,
            roleId: roleIdSchema.nullable(),
            liveRevision: z.number().int().positive().nullable(),
            registrationRevision: z.number().int().positive().nullable(),
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
  receipt?: StoreReceiptCompletion,
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
  let activated = false;
  try {
    const reviewed = expected.data as unknown as UpgradeSnapshot;
    const latest = await readCurrentApplicationLatestRelease(
      environment,
      session,
      selector.organizationId,
      selector.rootId,
    );
    if (
      selector.releaseRevision !== expected.data.latest.releaseRevision ||
      canonicalJson(latest) !== canonicalJson(expected.data.latest)
    )
      return releaseChanged();
    // Reviewing an installed version offers only its role changes still to accept.
    const rolesOnly = reviewed.selected.releaseRevision === reviewed.active.releaseRevision;
    const current = await readUpgradeAuthorizedState(environment, selector, session, true);
    const now = Date.parse(current.checkedAt);
    const reviewedDeadline = Date.parse(reviewed.validUntil);
    const currentDeadline = Date.parse(current.snapshot.validUntil);
    const atTarget = current.snapshot.active.releaseRevision === selector.releaseRevision;
    activated = atTarget;
    // The review deadline guards the confirmation, not the completion: once the claimed receipt
    // records progress (the release is already active), only current authority is re-proved.
    const resumed = receipt !== undefined && atTarget;
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(currentDeadline) ||
      (!resumed && (!Number.isFinite(reviewedDeadline) || reviewedDeadline <= now)) ||
      currentDeadline <= now ||
      !(atTarget && !rolesOnly
        ? sameUpgradeSelectedSnapshot(reviewed, current.snapshot)
        : sameUpgradeSnapshotState(reviewed, current.snapshot))
    )
      return "conflict";
    const reported = {
      application_name: current.state.selectedReleaseSet.application.content.name,
      release_version: current.snapshot.selected.releaseVersion,
      accepted_role_count: roleTemplateIds.data.length,
      waiting_role_count: 0,
    };
    // Reaching the target (activation, or the last role acceptance) completes the receipt there.
    const complete: ReceiptStep | undefined =
      receipt === undefined ? undefined : (transaction) => receipt(transaction, reported);
    if (atTarget)
      await resumeUpgradeRoleChanges(
        environment,
        selector,
        current.state,
        session,
        roleTemplateIds.data,
        expected.data.roleRevisions,
        !rolesOnly,
        expected.data.latest,
        complete,
      );
    else
      await upgradeWithRoleChanges(
        environment,
        selector,
        current.state,
        session,
        roleTemplateIds.data,
        expected.data.roleRevisions,
        expected.data.latest,
        complete,
        () => {
          activated = true;
        },
      );
    // Every reviewed role is accepted or the journey refused, so the counts are the reviewed ones.
    return { kind: "available", value: reported };
  } catch (error) {
    if (error instanceof InstallationProblem && error.problem.unavailableReason === "not_newer") {
      classifyInstallationFailure(error);
      return "conflict";
    }
    const failure = commandFailureOf(error);
    return activated ? afterActivation(failure) : failure;
  }
};

/** The application catalogue's journeys, bound to the application's installation environment. */
export const createApplicationStoreService = (environment: ApplicationStoreEnvironment) => ({
  ...createApplicationAuthoringService(environment),
  /**
   * The sign-in an install, upgrade or removal needs, asked for before its review is shown: the
   * person signs in again in the dialog, not after filling it. Undefined when the sign-in is
   * recent enough.
   */
  requireStepUp: async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    inputs: Readonly<Record<string, unknown>>,
  ): Promise<ApplicationStoreResult | undefined> => {
    const rootId = applicationRootInput(inputs.application_root_id);
    if (!rootId.success) return { kind: "unavailable" };
    try {
      await requireApplicationChangeStepUp(
        environment,
        session,
        organizationOf(selection),
        rootId.data,
      );
      return undefined;
    } catch (error) {
      return reviewFailure(error);
    }
  },
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
  reviewPurge: async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    inputs: Readonly<Record<string, unknown>>,
  ): Promise<ApplicationStoreResult> => {
    const rootId = applicationRootInput(inputs.application_root_id);
    if (!rootId.success) return { kind: "unavailable" };
    try {
      return {
        kind: "available",
        value: purgeReview(
          await readApplicationPurge(
            environment,
            session,
            organizationOf(selection),
            rootId.data,
            yes(inputs.delete_only),
          ),
        ),
      };
    } catch (error) {
      return purgeFailure(error);
    }
  },
  purge: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    inputs: Readonly<Record<string, unknown>>,
    receipt?: StoreReceiptCompletion,
  ) => purgeJourney(environment, false, session, selection, inputs, receipt),
  delete: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    inputs: Readonly<Record<string, unknown>>,
    receipt?: StoreReceiptCompletion,
  ) => purgeJourney(environment, true, session, selection, inputs, receipt),
  remove: async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    inputs: Readonly<Record<string, unknown>>,
    receipt?: StoreReceiptCompletion,
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
          receipt,
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
    receipt?: StoreReceiptCompletion,
  ) => install(environment, session, selection, inputs, receipt),
  upgrade: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    inputs: Readonly<Record<string, unknown>>,
    receipt?: StoreReceiptCompletion,
  ) => upgrade(environment, session, selection, inputs, receipt),
});

export type ApplicationStoreService = ReturnType<typeof createApplicationStoreService>;
