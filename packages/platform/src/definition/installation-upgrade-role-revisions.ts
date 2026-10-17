import "server-only";

import type { BuilderConferredPermission, createOrganizationAccessAdministrationService } from "../access/index";
import {
  canonicalJson,
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  prepareOrganizationAdministrationRoleRevisionAcceptanceCommandSchema,
  sameId,
  type IdentitySession,
  type OrganizationAdministrationRoleSummary,
  type PermissionDeclaration,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";
import { installationProblem } from "./installation-authority";
import { requireRoleAcceptanceAuthority } from "./installation-first-install-member-role";
import {
  activateUpgradeRelease,
  type UpgradeEnvironment,
  type UpgradeSelector,
  type UpgradeState,
} from "./installation-upgrade";

type AccessAdministration = ReturnType<typeof createOrganizationAccessAdministrationService>;

/** What an upgrade that can accept role revisions needs beyond the upgrade itself. */
export type UpgradeRoleEnvironment = UpgradeEnvironment &
  Readonly<{ accessAdministration: AccessAdministration }>;

/**
 * One organisation role accepted from this application's role template whose permissions the
 * selected version changes. Until the role revision is accepted its holders keep exactly the
 * access they had; `changes` says in plain words what accepting adds, removes or changes.
 */
export type UpgradeRoleRevision = Readonly<{
  roleId: string;
  label: string;
  sourceRoleId: string;
  changes: readonly string[];
}>;

type Declared = Readonly<{
  declaration: PermissionDeclaration;
  reference: BuilderConferredPermission;
}>;

/** Every permission a release declares, by key, with the reference a role entry would carry. */
const declaredPermissions = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
): ReadonlyMap<string, Declared> => {
  const rootId = String(releaseSet.application.rootId);
  const entries: [string, Declared][] = [
    ...releaseSet.application.content.permissions.map((declaration): [string, Declared] => [
      declaration.key,
      {
        declaration,
        reference: {
          applicationRootId: rootId,
          ownerKind: "application",
          ownerId: rootId,
          permissionId: String(declaration.permissionId),
        },
      },
    ]),
    ...releaseSet.modules.flatMap((module) =>
      module.content.permissions.map((declaration): [string, Declared] => [
        declaration.key,
        {
          declaration,
          reference: {
            applicationRootId: rootId,
            ownerKind: "module",
            ownerId: String(module.rootId),
            permissionId: String(declaration.permissionId),
          },
        },
      ]),
    ),
  ];
  return new Map(entries);
};

/** Field labels and record type plural labels, by id, across a release's modules. */
const fieldNames = (releaseSet: SystemApplicationBoundReleaseSetResult) => {
  const fields = new Map<string, string>();
  const recordTypes = new Map<string, string>();
  for (const module of releaseSet.modules)
    for (const recordType of module.content.recordTypes) {
      recordTypes.set(String(recordType.recordTypeId).toLowerCase(), recordType.pluralLabel);
      for (const field of recordType.fields)
        fields.set(String(field.fieldId).toLowerCase(), field.label);
    }
  return { fields, recordTypes };
};

const fieldSet = (ids: readonly string[] | undefined): ReadonlySet<string> =>
  new Set((ids ?? []).map((id) => id.toLowerCase()));

/**
 * The plain-English changes one role template makes between two releases, or none. A changed
 * meaning that changes no field or permission is still reported, because it still needs acceptance.
 */
const templateChanges = (
  sourceRoleId: string,
  active: SystemApplicationBoundReleaseSetResult,
  selected: SystemApplicationBoundReleaseSetResult,
): readonly string[] => {
  const before = active.application.content.roles.find((role) => sameId(role.roleId, sourceRoleId));
  const after = selected.application.content.roles.find((role) => sameId(role.roleId, sourceRoleId));
  if (before === undefined || after === undefined) return [];
  const oldDeclared = declaredPermissions(active);
  const newDeclared = declaredPermissions(selected);
  const names = fieldNames(selected);
  const oldNames = fieldNames(active);
  const changes: string[] = [];
  for (const key of after.permissionKeys) {
    const next = newDeclared.get(key);
    if (next === undefined) continue;
    if (!before.permissionKeys.includes(key)) {
      changes.push(`+ ${next.declaration.label}`);
      continue;
    }
    const previous = oldDeclared.get(key);
    if (previous === undefined || canonicalJson(previous.declaration) === canonicalJson(next.declaration))
      continue;
    const recordType = next.declaration.recordTypeId === undefined
      ? undefined
      : names.recordTypes.get(String(next.declaration.recordTypeId).toLowerCase());
    const describe = (
      kind: "readableFieldIds" | "changeableFieldIds",
      verb: string,
    ): string[] => {
      const oldIds = fieldSet(previous.declaration.fieldPolicy?.[kind]);
      const newIds = fieldSet(next.declaration.fieldPolicy?.[kind]);
      return [
        ...[...newIds].filter((id) => !oldIds.has(id))
          .map((id) => `${recordType ?? next.declaration.label} + ${names.fields.get(id) ?? id}${verb}`),
        ...[...oldIds].filter((id) => !newIds.has(id))
          .map((id) => `${recordType ?? next.declaration.label} − ${oldNames.fields.get(id) ?? id}${verb}`),
      ];
    };
    const fieldChanges = [...describe("readableFieldIds", ""), ...describe("changeableFieldIds", " (edit)")];
    changes.push(...(fieldChanges.length > 0 ? fieldChanges : [`${next.declaration.label} changed`]));
  }
  // Removing a permission narrows the role at upgrade without acceptance, so it is not listed.
  return [...new Set(changes)];
};

const listApplicationRoles = async (
  administration: AccessAdministration,
  session: IdentitySession,
  selector: UpgradeSelector,
): Promise<OrganizationAdministrationRoleSummary[]> => {
  const roles: OrganizationAdministrationRoleSummary[] = [];
  let afterRoleId: OrganizationAdministrationRoleSummary["roleId"] | undefined;
  for (;;) {
    const page = await administration.listRoles(
      session,
      { organizationId: selector.organizationId },
      { pageSize: 100, ...(afterRoleId === undefined ? {} : { afterRoleId }) },
    );
    if (page.kind !== "available")
      return installationProblem(
        "upgrade_role_revisions_unreadable",
        page.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "refused",
      );
    roles.push(
      ...page.value.roles.filter(
        (role) =>
          role.source.kind === "application" &&
          sameId(role.source.applicationRootId, selector.rootId) &&
          role.lifecycle !== "retired",
      ),
    );
    afterRoleId = page.value.nextAfterRoleId;
    if (afterRoleId === undefined) return roles;
  }
};

/**
 * The organisation's roles from this application that the upgrade leaves waiting for acceptance:
 * their template gains a permission or changes a permission's meaning, or they already wait from
 * an earlier upgrade. The upgrade screen lists them so the upgrader can accept them in the same
 * action; anything not accepted there is accepted later in role administration.
 */
export const readUpgradeRoleRevisions = async (
  environment: UpgradeRoleEnvironment,
  session: IdentitySession,
  selector: UpgradeSelector,
  state: UpgradeState,
): Promise<readonly UpgradeRoleRevision[]> => {
  const roles = await listApplicationRoles(environment.accessAdministration, session, selector);
  return roles
    .map((role): UpgradeRoleRevision | undefined => {
      const source = role.source;
      if (source.kind !== "application") return undefined;
      const changes = templateChanges(
        String(source.sourceRoleId),
        state.activeReleaseSet,
        state.selectedReleaseSet,
      );
      const waiting = role.lifecycle === "acceptance_required"
        ? ["Changes from an earlier version are waiting for acceptance"]
        : [];
      const all = [...changes, ...(changes.length === 0 ? waiting : [])];
      return all.length === 0
        ? undefined
        : { roleId: String(role.roleId), label: role.label, sourceRoleId: String(source.sourceRoleId), changes: all };
    })
    .filter((entry): entry is UpgradeRoleRevision => entry !== undefined)
    .sort((left, right) => left.label.localeCompare(right.label));
};

/** The permissions accepting a role's selected template confers, for the delegated-scope check. */
const conferredPermissions = (
  selected: SystemApplicationBoundReleaseSetResult,
  sourceRoleIds: readonly string[],
): BuilderConferredPermission[] => {
  const declared = declaredPermissions(selected);
  const conferred = new Map<string, BuilderConferredPermission>();
  for (const role of selected.application.content.roles) {
    if (!sourceRoleIds.some((sourceRoleId) => sameId(sourceRoleId, role.roleId))) continue;
    for (const key of role.permissionKeys) {
      const entry = declared.get(key);
      if (entry === undefined) continue;
      conferred.set(`${entry.reference.ownerKind}:${entry.reference.ownerId}:${entry.reference.permissionId}`, entry.reference);
    }
  }
  return [...conferred.values()];
};

export type UpgradeWithRoleRevisionsResult = Readonly<{
  activation: Awaited<ReturnType<typeof activateUpgradeRelease>>;
  /** Role ids whose revision was accepted after the upgrade. */
  acceptedRoleIds: readonly string[];
}>;

/**
 * The one upgrade the Studio and the App Store share. With the upgrader's explicit choice it also
 * accepts the listed role revisions, through the existing Access operations under the upgrader's
 * own authority: role management, the delegated scope over every permission the revision confers
 * and a primary sign-in within the last 15 minutes. That authority is proved before anything is
 * written, so a stale sign-in refuses the whole action and nothing changes. Each acceptance then
 * commits in its own transaction after the switch; one the database refuses is accepted later in role administration.
 */
export const upgradeWithRoleRevisions = async (
  environment: UpgradeRoleEnvironment,
  selector: UpgradeSelector,
  state: UpgradeState,
  session: IdentitySession,
  acceptRoleIds: readonly string[],
): Promise<UpgradeWithRoleRevisionsResult> => {
  let chosen: readonly UpgradeRoleRevision[] = [];
  if (acceptRoleIds.length > 0) {
    const listed = await readUpgradeRoleRevisions(environment, session, selector, state);
    chosen = listed.filter((revision) => acceptRoleIds.some((roleId) => sameId(roleId, revision.roleId)));
    if (chosen.length !== new Set(acceptRoleIds.map((roleId) => roleId.toLowerCase())).size)
      installationProblem("upgrade_role_revision_not_listed", "conflict");
    await requireRoleAcceptanceAuthority(
      environment,
      session,
      selector,
      environment.containsCustomComponents(state.selectedReleaseSet),
      conferredPermissions(state.selectedReleaseSet, chosen.map((revision) => revision.sourceRoleId)),
    );
  }

  const activation = await activateUpgradeRelease(environment, selector, state, session);

  const acceptedRoleIds: string[] = [];
  if (chosen.length > 0) {
    const roles = await listApplicationRoles(environment.accessAdministration, session, selector);
    for (const revision of chosen) {
      const role = roles.find((candidate) => sameId(candidate.roleId, revision.roleId));
      // A role the upgrade left active (it only narrowed) needs no acceptance.
      if (role === undefined || role.lifecycle !== "acceptance_required") continue;
      const prepared = await environment.accessAdministration.prepareApplicationRoleRevisionAcceptance(
        session,
        { organizationId: selector.organizationId },
        prepareOrganizationAdministrationRoleRevisionAcceptanceCommandSchema.parse({
          operation: "accept_application_role_revision",
          roleId: role.roleId,
          expectedRoleRevision: role.liveRevision,
          acceptBroadenedAuthority: "accept",
        }),
      );
      if (prepared.kind !== "available") {
        console.error(`[installation] upgrade role revision ${role.roleId} not prepared: ${prepared.kind}`);
        continue;
      }
      const accepted = await environment.accessAdministration.acceptApplicationRoleRevision(
        session,
        { organizationId: selector.organizationId },
        changeOrganizationAdministrationRoleAuthorityCommandSchema.parse({ evidence: prepared.value }),
      );
      if (accepted.kind !== "available") {
        console.error(`[installation] upgrade role revision ${role.roleId} not accepted: ${accepted.kind}`);
        continue;
      }
      acceptedRoleIds.push(String(role.roleId));
    }
  }
  return { activation, acceptedRoleIds };
};
