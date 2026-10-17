import "server-only";

import {
  fingerprintPermissionMeaning,
  type BuilderConferredPermission,
  type createOrganizationAccessAdministrationService,
} from "../access/index";
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
 * One organisation role accepted from this application's role template that differs from the
 * selected version's template. Until the role revision is accepted its holders keep exactly the
 * access they accepted; `changes` says in plain words everything accepting would change, compared
 * with what the role accepted (including changes still pending from earlier versions).
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
  meaningFingerprint: string;
}>;

const referenceKey = (reference: Readonly<{ ownerKind: string; ownerId: string; permissionId: string }>) =>
  `${reference.ownerKind}:${reference.ownerId.toLowerCase()}:${reference.permissionId.toLowerCase()}`;

/** Every permission a release declares, by key, with the reference and meaning a role entry carries. */
const declaredPermissions = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
): ReadonlyMap<string, Declared> => {
  const rootId = String(releaseSet.application.rootId);
  const declare = (
    declaration: PermissionDeclaration,
    ownerKind: "application" | "module",
    ownerId: string,
  ): [string, Declared] => [
    declaration.key,
    {
      declaration,
      reference: { applicationRootId: rootId, ownerKind, ownerId, permissionId: String(declaration.permissionId) },
      meaningFingerprint: fingerprintPermissionMeaning(ownerKind, ownerId, declaration),
    },
  ];
  return new Map([
    ...releaseSet.application.content.permissions.map((declaration) =>
      declare(declaration, "application", rootId)),
    ...releaseSet.modules.flatMap((module) =>
      module.content.permissions.map((declaration) => declare(declaration, "module", String(module.rootId)))),
  ]);
};

/**
 * The permissions a role template grants in a release: its keys resolved to declarations, and for
 * an application wildcard only the application's own non-administrative, non-export ones, as the
 * live template projection does.
 */
const templatePermissions = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
  sourceRoleId: string,
): readonly Declared[] | undefined => {
  const role = releaseSet.application.content.roles.find((candidate) => sameId(candidate.roleId, sourceRoleId));
  if (role === undefined) return undefined;
  const declared = declaredPermissions(releaseSet);
  const wildcard = role.permissionSelection.kind === "application_wildcard";
  return role.permissionKeys
    .map((key) => declared.get(key))
    .filter((entry): entry is Declared => entry !== undefined)
    .filter((entry) => !wildcard || (
      entry.reference.ownerKind === "application" &&
      !entry.declaration.administrative &&
      entry.declaration.actionKind !== "export"
    ));
};

/** Field labels and record type plural labels, by id, across releases (newest first). */
const fieldNames = (releaseSets: readonly SystemApplicationBoundReleaseSetResult[]) => {
  const fields = new Map<string, string>();
  const recordTypes = new Map<string, string>();
  for (const releaseSet of releaseSets)
    for (const module of releaseSet.modules)
      for (const recordType of module.content.recordTypes) {
        const typeId = String(recordType.recordTypeId).toLowerCase();
        if (!recordTypes.has(typeId)) recordTypes.set(typeId, recordType.pluralLabel);
        for (const field of recordType.fields) {
          const fieldId = String(field.fieldId).toLowerCase();
          if (!fields.has(fieldId)) fields.set(fieldId, field.label);
        }
      }
  return { fields, recordTypes };
};

type AcceptedPermission = Readonly<{
  reference: Readonly<{ ownerKind: string; ownerId: string; permissionId: string }>;
  label: string;
  recordTypeId?: string | undefined;
  action: Readonly<{ actionKind: string; namedAction?: string | undefined }>;
  administrative: boolean;
  recordScope?: unknown;
  fieldPolicy?: Readonly<{ readableFieldIds: readonly string[]; changeableFieldIds: readonly string[] }> | undefined;
}>;

/**
 * The plain-English difference between what a role accepted and what the selected template grants:
 * permissions added and removed, fields gained and lost, and any other change of meaning.
 */
const roleChanges = (
  accepted: readonly AcceptedPermission[],
  target: readonly Declared[],
  names: ReturnType<typeof fieldNames>,
): string[] => {
  const acceptedByKey = new Map(accepted.map((entry) => [referenceKey(entry.reference), entry]));
  const targetKeys = new Set(target.map((entry) => referenceKey(entry.reference)));
  const changes: string[] = [];
  for (const entry of target) {
    const before = acceptedByKey.get(referenceKey(entry.reference));
    const declaration = entry.declaration;
    if (before === undefined) {
      changes.push(`+ ${declaration.label}`);
      continue;
    }
    const sameMeaning =
      canonicalJson({
        recordTypeId: before.recordTypeId ?? null,
        actionKind: before.action.actionKind,
        namedAction: before.action.namedAction ?? null,
        administrative: before.administrative,
        recordScope: before.recordScope ?? null,
        fieldPolicy: before.fieldPolicy ?? null,
      }) ===
      canonicalJson({
        recordTypeId: declaration.recordTypeId ?? null,
        actionKind: declaration.actionKind,
        namedAction: declaration.namedAction ?? null,
        administrative: declaration.administrative,
        recordScope: declaration.recordScope ?? null,
        fieldPolicy: declaration.fieldPolicy ?? null,
      });
    if (sameMeaning) continue;
    const subject = declaration.recordTypeId === undefined
      ? declaration.label
      : names.recordTypes.get(String(declaration.recordTypeId).toLowerCase()) ?? declaration.label;
    const fieldChanges: string[] = [];
    for (const [kind, suffix] of [["readableFieldIds", ""], ["changeableFieldIds", " (edit)"]] as const) {
      const oldIds = new Set((before.fieldPolicy?.[kind] ?? []).map((id) => id.toLowerCase()));
      const newIds = new Set((declaration.fieldPolicy?.[kind] ?? []).map((id) => String(id).toLowerCase()));
      for (const id of newIds) if (!oldIds.has(id)) fieldChanges.push(`${subject} + ${names.fields.get(id) ?? id}${suffix}`);
      for (const id of oldIds) if (!newIds.has(id)) fieldChanges.push(`${subject} − ${names.fields.get(id) ?? id}${suffix}`);
    }
    const otherChange =
      before.recordTypeId !== declaration.recordTypeId ||
      before.action.actionKind !== declaration.actionKind ||
      (before.action.namedAction ?? null) !== (declaration.namedAction ?? null) ||
      before.administrative !== declaration.administrative ||
      canonicalJson(before.recordScope ?? null) !== canonicalJson(declaration.recordScope ?? null);
    changes.push(...fieldChanges);
    if (otherChange || fieldChanges.length === 0) changes.push(`${declaration.label} changed`);
  }
  for (const entry of accepted)
    if (!targetKeys.has(referenceKey(entry.reference))) changes.push(`− ${entry.label}`);
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

const readAcceptedPermissions = async (
  administration: AccessAdministration,
  session: IdentitySession,
  selector: UpgradeSelector,
  roleId: OrganizationAdministrationRoleSummary["roleId"],
): Promise<readonly AcceptedPermission[]> => {
  const read = await administration.readRole(session, { organizationId: selector.organizationId }, { roleId });
  if (read.kind !== "available" || read.value.outcome !== "available")
    return installationProblem(
      "upgrade_role_revision_unreadable",
      read.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "refused",
    );
  return read.value.role.acceptedPermissions.map((permission) => ({
    reference: {
      ownerKind: permission.reference.ownerKind,
      ownerId: String(permission.reference.ownerId),
      permissionId: String(permission.reference.permissionId),
    },
    label: permission.label,
    recordTypeId: permission.recordTypeId === undefined ? undefined : String(permission.recordTypeId),
    action: permission.action,
    administrative: permission.administrative,
    recordScope: permission.recordScope,
    fieldPolicy: permission.fieldPolicy,
  }));
};

/**
 * The organisation's roles from this application whose accepted permissions differ from the
 * selected version's template, each with every change accepting would apply. The upgrade screen
 * lists them so the upgrader can accept them in the same action; anything not accepted there is
 * accepted later in role administration.
 */
export const readUpgradeRoleRevisions = async (
  environment: UpgradeRoleEnvironment,
  session: IdentitySession,
  selector: UpgradeSelector,
  state: UpgradeState,
): Promise<readonly UpgradeRoleRevision[]> => {
  const administration = environment.accessAdministration;
  const roles = await listApplicationRoles(administration, session, selector);
  const names = fieldNames([state.selectedReleaseSet, state.activeReleaseSet]);
  const revisions: UpgradeRoleRevision[] = [];
  for (const role of roles) {
    const source = role.source;
    if (source.kind !== "application") continue;
    const target = templatePermissions(state.selectedReleaseSet, String(source.sourceRoleId));
    if (target === undefined) continue;
    const accepted = await readAcceptedPermissions(administration, session, selector, role.roleId);
    const changes = roleChanges(accepted, target, names);
    if (changes.length > 0)
      revisions.push({ roleId: String(role.roleId), label: role.label, sourceRoleId: String(source.sourceRoleId), changes });
  }
  return revisions.sort((left, right) => left.label.localeCompare(right.label));
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
 * commits in its own transaction after the switch, and only for exactly the template the upgrader
 * was shown: a preparation that names anything else (another version activated meanwhile) is not
 * accepted. One not accepted here is accepted later in role administration.
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
      chosen.flatMap((revision) =>
        (templatePermissions(state.selectedReleaseSet, revision.sourceRoleId) ?? []).map((entry) => entry.reference)),
    );
  }

  const activation = await activateUpgradeRelease(environment, selector, state, session);
  const acceptedRoleIds = await acceptUpgradeRoleRevisions(environment, session, selector, state, chosen);
  return { activation, acceptedRoleIds };
};

/**
 * Accepts, after the switch, the chosen role revisions of exactly the template the upgrader was
 * shown: every prepared permission must be one the activated version's template grants, with its
 * meaning in that version. A preparation that names anything else (another version activated in
 * the meantime) is not accepted and stays for role administration.
 */
export const acceptUpgradeRoleRevisions = async (
  environment: UpgradeRoleEnvironment,
  session: IdentitySession,
  selector: UpgradeSelector,
  state: UpgradeState,
  chosen: readonly UpgradeRoleRevision[],
): Promise<readonly string[]> => {
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
      // Accept only exactly the template of the version this upgrade activated, as shown: every
      // prepared permission must be one it grants, with its meaning in that version.
      const shown = new Map(
        (templatePermissions(state.selectedReleaseSet, revision.sourceRoleId) ?? [])
          .map((entry) => [referenceKey(entry.reference), entry.meaningFingerprint]),
      );
      const candidate = prepared.value.candidate;
      if (
        candidate.operation !== "accept_application_role_revision" ||
        candidate.permissions.length !== shown.size ||
        candidate.permissions.some((permission) =>
          shown.get(referenceKey({
            ownerKind: permission.ownerKind,
            ownerId: String(permission.ownerId),
            permissionId: String(permission.permissionId),
          })) !== permission.meaningFingerprint)
      ) {
        console.error(`[installation] upgrade role revision ${role.roleId} not accepted: template_changed_since_upgrade`);
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
  return acceptedRoleIds;
};
