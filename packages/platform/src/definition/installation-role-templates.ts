import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { fingerprintPermissionMeaning, type BuilderConferredPermission } from "../access/index";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  canonicalJson,
  organizationAccountIdSchema,
  organizationAdministrationPermissionSchema,
  organizationIdSchema,
  permissionFieldPolicySchema,
  permissionRecordScopeSchema,
  prepareOrganizationAdministrationRoleChangeCommandSchema,
  prepareOrganizationAdministrationRoleRevisionAcceptanceCommandSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
  sameId,
  type ApplicationRootId,
  type IdentitySession,
  type OrganizationId,
  type PermissionDeclaration,
  type PreparedOrganizationRoleChange,
  type SelectedOrganizationScope,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";
import { classifyDatabaseError } from "./definition-error";
import {
  InstallationProblem,
  installationOperation,
  installationProblem,
  readInstallationPermissionDeadline,
  requireInstallationAuthority,
  type InstallationHumanContext,
  type InstallationMemberRoleRefusal,
} from "./installation-authority";
import type { FirstInstallFlowEnvironment } from "./installation-first-install-app";

/**
 * The roles an application release offers and how installing or upgrading turns them into
 * organisation roles. Accepting a role template, or a changed template on upgrade, is part of
 * installing the application: it needs the installation authority (Manage applications, delegated
 * scope over every permission the role confers and a recent primary sign-in), never role
 * management. Who holds a role is decided separately, by assignment.
 */
export type InstallationRoleEnvironment = Pick<
  FirstInstallFlowEnvironment,
  "requests" | "permissions" | "accessAdministration" | "containsCustomComponents"
>;

type Selector = Readonly<{ organizationId: OrganizationId; rootId: ApplicationRootId }>;

/** One role a release offers, as the install screen shows it. */
export type ApplicationRoleTemplate = Readonly<{
  sourceRoleId: string;
  key: string;
  name: string;
  /** True for the application's one default member role. */
  defaultMember: boolean;
  /** True when the role confers an administrative permission. */
  privileged: boolean;
  permissions: readonly Readonly<{ key: string; label: string; description: string }>[];
}>;

type Declared = Readonly<{
  declaration: PermissionDeclaration;
  reference: BuilderConferredPermission;
  meaningFingerprint: string;
}>;

const referenceKey = (
  reference: Readonly<{ ownerKind: string; ownerId: string; permissionId: string }>,
) =>
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
      reference: {
        applicationRootId: rootId,
        ownerKind,
        ownerId,
        permissionId: String(declaration.permissionId),
      },
      meaningFingerprint: fingerprintPermissionMeaning(ownerKind, ownerId, declaration),
    },
  ];
  return new Map([
    ...releaseSet.application.content.permissions.map((declaration) =>
      declare(declaration, "application", rootId),
    ),
    ...releaseSet.modules.flatMap((module) =>
      module.content.permissions.map((declaration) =>
        declare(declaration, "module", String(module.rootId)),
      ),
    ),
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
): readonly Declared[] => {
  const role = releaseSet.application.content.roles.find((candidate) =>
    sameId(candidate.roleId, sourceRoleId),
  );
  if (role === undefined) return [];
  const declared = declaredPermissions(releaseSet);
  const wildcard = role.permissionSelection.kind === "application_wildcard";
  return role.permissionKeys
    .map((key) => declared.get(key))
    .filter((entry): entry is Declared => entry !== undefined)
    .filter(
      (entry) =>
        !wildcard ||
        (entry.reference.ownerKind === "application" &&
          !entry.declaration.administrative &&
          entry.declaration.actionKind !== "export"),
    );
};

/** Every role the release offers, the default member role first, then by name. */
export const releaseRoleTemplates = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
): readonly ApplicationRoleTemplate[] =>
  releaseSet.application.content.roles
    .map((role) => {
      const granted = templatePermissions(releaseSet, String(role.roleId));
      return {
        sourceRoleId: String(role.roleId),
        key: role.key,
        name: role.name,
        defaultMember: role.defaultMember === true,
        privileged: granted.some((entry) => entry.declaration.administrative),
        permissions: granted.map((entry) => ({
          key: entry.declaration.key,
          label: entry.declaration.label,
          description: entry.declaration.description,
        })),
      };
    })
    .sort(
      (left, right) =>
        Number(right.defaultMember) - Number(left.defaultMember) ||
        left.name.localeCompare(right.name),
    );

/**
 * The one role the release marks `defaultMember`. The compiled contract requires exactly one, so
 * anything else is a release the platform did not produce and the install is refused.
 */
export const releaseMemberRole = (
  templates: readonly ApplicationRoleTemplate[],
): ApplicationRoleTemplate => {
  const marked = templates.filter((template) => template.defaultMember);
  const role = marked[0];
  if (marked.length !== 1 || role === undefined)
    return installationProblem("first_install_member_role_unavailable", "failed");
  return role;
};

/**
 * The organisation role key an accepted application role template gets. It is derived from the
 * template identity, so accepting the same template always names the same local role.
 */
export const acceptedApplicationRoleKey = (
  applicationRootId: string,
  sourceRoleId: string,
  templateKey: string,
): string => {
  const digest = createHash("sha256")
    .update(`${applicationRootId.toLowerCase()}:${sourceRoleId.toLowerCase()}`)
    .digest("hex")
    .slice(0, 12);
  const readableKey = templateKey.slice(0, 20).replace(/_+$/, "") || "role";
  return `local_${readableKey}_${digest}`;
};

/** Why a role step was refused, as the install screen names it. */
type Refusal = InstallationMemberRoleRefusal;

/** A refusal that names what is missing, so the install screen can say it plainly. */
export const refusedFor = (detail: string, refusal: Refusal, cause?: unknown): never => {
  throw new InstallationProblem(
    { kind: "refused", memberRoleRefusal: refusal },
    detail,
    cause === undefined ? undefined : { cause },
  );
};

/** Turns a check's refusal into the named refusal; a stale sign-in and other failures keep their own meaning. */
export const named = async <Value>(
  detail: string,
  refusal: Refusal,
  check: () => Promise<Value>,
): Promise<Value> => {
  try {
    return await check();
  } catch (error) {
    if (error instanceof InstallationProblem && error.problem.kind === "refused")
      return refusedFor(detail, refusal, error);
    throw error;
  }
};

/** Runs one installer request transaction; a failure inside it is rethrown with its own cause. */
export const inInstallerRequest = async <Value>(
  environment: Pick<InstallationRoleEnvironment, "requests">,
  session: IdentitySession,
  selector: Pick<Selector, "organizationId">,
  operation: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    issuedAt: string,
  ) => Promise<Value>,
): Promise<Value> => {
  let failure: unknown;
  const result = await environment.requests.runChange(
    session,
    { organizationId: selector.organizationId },
    async (transaction, scope, issuedAt) => {
      try {
        if (
          scope.applicationRootId !== undefined ||
          !sameId(scope.organizationId, selector.organizationId)
        )
          installationProblem("installation_roles_scope_mismatch", "refused");
        return await operation(transaction, scope, issuedAt);
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (failure !== undefined) throw failure;
  return result.kind === "temporarily_unavailable"
    ? installationProblem("installation_roles_request_unavailable", "temporarily_unavailable")
    : refusedFor("installation_roles_request_refused", "installation_authority");
};

/** Proves one platform permission in the open installer transaction, refusing it by name. */
export const requireInstallerPermission = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: InstallationHumanContext,
  environment: Pick<InstallationRoleEnvironment, "permissions">,
  key: "platform.organization.assignments.manage",
): Promise<void> => {
  await named("installation_roles_assignments_manage_refused", "assignments_manage", () =>
    readInstallationPermissionDeadline(transaction, scope, context, environment.permissions, key),
  );
};

const installedRoleSchema = z
  .object({
    roleId: roleIdSchema,
    sourceRoleId: roleIdSchema,
    label: z.string(),
    liveRevision: z.number().int().min(1),
    lifecycle: z.enum(["active", "acceptance_required", "unavailable", "retired"]),
    assignmentPolicy: z.enum(["standing", "activation_required"]),
    liveAssignmentCount: z.number().int().min(0),
    installerAssignment: z
      .object({
        roleAssignmentId: roleAssignmentIdSchema,
        revision: z.number().int().min(1),
        selfGranted: z.boolean(),
      })
      .strict()
      .nullable(),
    acceptedPermissions: z.array(
      organizationAdministrationPermissionSchema.safeExtend({
        recordScope: permissionRecordScopeSchema.optional(),
        fieldPolicy: permissionFieldPolicySchema.optional(),
      }),
    ),
  })
  .strict();

const installationRolesSchema = z
  .object({
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    roles: z.array(installedRoleSchema),
  })
  .strict();

/** The organisation's roles accepted from one application's templates, read under the installation authority. */
export type InstallationRoles = z.infer<typeof installationRolesSchema>;
export type InstalledApplicationRole = InstallationRoles["roles"][number];

/**
 * Reads, in the open installer transaction and under the installer's own installation authority,
 * every organisation role accepted from this application's templates and the installer's own
 * assignment of each. Reading the application's own roles is part of the installation authority,
 * so no roles.read grant is needed.
 */
export const readInstallationRolesIn = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  environment: Pick<InstallationRoleEnvironment, "permissions">,
  selector: Selector,
  containsCustomComponents: boolean,
): Promise<InstallationRoles> => {
  await named("installation_roles_installation_refused", "installation_authority", () =>
    requireInstallationAuthority(
      transaction,
      scope,
      environment.permissions,
      installationOperation(selector.rootId, containsCustomComponents),
    ),
  );
  // The read re-proves the installation authority, including delegated management of the
  // organisation catalogue; the database refusing it is the installer lacking that authority.
  const rows = await named("installation_roles_read_refused", "installation_authority", () =>
    transaction.query<DatabaseRow & { readonly roles: unknown }>`
        select vortex_access.read_application_roles_for_installation(
          ${selector.rootId}::uuid
        ) as roles
      `.catch((error: unknown) => {
      if (classifyDatabaseError(error) === "refused")
        installationProblem("installation_roles_read_refused", "refused", undefined, {
          cause: error,
        });
      throw error;
    }),
  );
  const state = installationRolesSchema.safeParse(rows[0]?.roles);
  if (
    rows.length !== 1 ||
    !state.success ||
    !sameId(state.data.organizationId, scope.organizationId) ||
    !sameId(state.data.organizationAccountId, scope.organizationAccountId)
  )
    return installationProblem("installation_roles_state_invalid", "failed", undefined, {
      cause: state.success ? undefined : state.error,
    });
  return state.data;
};

/** The application's roles in their own installer request transaction. */
export const readInstallationRoles = (
  environment: InstallationRoleEnvironment,
  session: IdentitySession,
  selector: Selector,
  containsCustomComponents: boolean,
): Promise<InstallationRoles> =>
  inInstallerRequest(environment, session, selector, (transaction, scope) =>
    readInstallationRolesIn(transaction, scope, environment, selector, containsCustomComponents),
  );

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

type AcceptedPermission = InstalledApplicationRole["acceptedPermissions"][number];

/**
 * The plain-English difference between what a role accepted and what the selected template grants:
 * permissions added and removed, fields gained and lost, and any other change of meaning.
 */
const permissionChanges = (
  accepted: readonly AcceptedPermission[],
  target: readonly Declared[],
  names: ReturnType<typeof fieldNames>,
): string[] => {
  const acceptedByKey = new Map(
    accepted.map((entry) => [
      referenceKey({
        ownerKind: entry.reference.ownerKind,
        ownerId: String(entry.reference.ownerId),
        permissionId: String(entry.reference.permissionId),
      }),
      entry,
    ]),
  );
  const targetKeys = new Set(target.map((entry) => referenceKey(entry.reference)));
  const changes: string[] = [];
  for (const entry of target) {
    const before = acceptedByKey.get(referenceKey(entry.reference));
    const declaration = entry.declaration;
    if (before === undefined) {
      changes.push(`+ ${declaration.label}`);
      continue;
    }
    const beforeRecordTypeId =
      before.recordTypeId === undefined ? undefined : String(before.recordTypeId);
    const declarationRecordTypeId =
      declaration.recordTypeId === undefined ? undefined : String(declaration.recordTypeId);
    const sameMeaning =
      canonicalJson({
        recordTypeId: beforeRecordTypeId ?? null,
        actionKind: before.action.actionKind,
        namedAction: before.action.namedAction ?? null,
        administrative: before.administrative,
        recordScope: before.recordScope ?? null,
        fieldPolicy: before.fieldPolicy ?? null,
      }) ===
      canonicalJson({
        recordTypeId: declarationRecordTypeId ?? null,
        actionKind: declaration.actionKind,
        namedAction: declaration.namedAction ?? null,
        administrative: declaration.administrative,
        recordScope: declaration.recordScope ?? null,
        fieldPolicy: declaration.fieldPolicy ?? null,
      });
    if (sameMeaning) continue;
    const subject =
      declarationRecordTypeId === undefined
        ? declaration.label
        : (names.recordTypes.get(declarationRecordTypeId.toLowerCase()) ?? declaration.label);
    const fieldChanges: string[] = [];
    for (const [kind, suffix] of [
      ["readableFieldIds", ""],
      ["changeableFieldIds", " (edit)"],
    ] as const) {
      const oldIds = new Set(
        (before.fieldPolicy?.[kind] ?? []).map((id) => String(id).toLowerCase()),
      );
      const newIds = new Set(
        (declaration.fieldPolicy?.[kind] ?? []).map((id) => String(id).toLowerCase()),
      );
      for (const id of newIds)
        if (!oldIds.has(id))
          fieldChanges.push(`${subject} + ${names.fields.get(id) ?? id}${suffix}`);
      for (const id of oldIds)
        if (!newIds.has(id))
          fieldChanges.push(`${subject} − ${names.fields.get(id) ?? id}${suffix}`);
    }
    const otherChange =
      beforeRecordTypeId !== declarationRecordTypeId ||
      before.action.actionKind !== declaration.actionKind ||
      (before.action.namedAction ?? null) !== (declaration.namedAction ?? null) ||
      before.administrative !== declaration.administrative ||
      canonicalJson(before.recordScope ?? null) !== canonicalJson(declaration.recordScope ?? null);
    changes.push(...fieldChanges);
    if (otherChange || fieldChanges.length === 0) changes.push(`${declaration.label} changed`);
  }
  for (const entry of accepted)
    if (
      !targetKeys.has(
        referenceKey({
          ownerKind: entry.reference.ownerKind,
          ownerId: String(entry.reference.ownerId),
          permissionId: String(entry.reference.permissionId),
        }),
      )
    )
      changes.push(`− ${entry.label}`);
  return [...new Set(changes)];
};

/**
 * One role whose access the selected version changes for this organisation: a role the version
 * offers that has no organisation role yet (`roleId` undefined), or an accepted role whose
 * permissions differ from the version's template. Until it is accepted its holders keep exactly the
 * access they have.
 */
export type ApplicationRoleChange = Readonly<{
  sourceRoleId: string;
  roleId: string | undefined;
  liveRevision: number | undefined;
  /** The revision registration will produce before role acceptance. */
  registrationRevision: number | undefined;
  name: string;
  /** Every permission of a new role, or what accepting changes for an accepted one. */
  changes: readonly string[];
  /** How many live assignments (people or Groups) hold the role now. */
  holders: number;
}>;

/**
 * Every role the selected release offers whose organisation role is missing or differs from it,
 * by name. A role that was retired (for example before an uninstall) or is unavailable is left
 * alone, never accepted a second time.
 */
export const applicationRoleChanges = (
  roles: readonly InstalledApplicationRole[],
  releaseSet: SystemApplicationBoundReleaseSetResult,
  earlierReleaseSets: readonly SystemApplicationBoundReleaseSetResult[],
): readonly ApplicationRoleChange[] => {
  const names = fieldNames([releaseSet, ...earlierReleaseSets]);
  const changes: ApplicationRoleChange[] = [];
  for (const template of releaseRoleTemplates(releaseSet)) {
    const role = roles.find((candidate) => sameId(candidate.sourceRoleId, template.sourceRoleId));
    if (role === undefined) {
      changes.push({
        sourceRoleId: template.sourceRoleId,
        roleId: undefined,
        liveRevision: undefined,
        registrationRevision: undefined,
        name: template.name,
        changes: template.permissions.map((permission) => permission.label),
        holders: 0,
      });
      continue;
    }
    if (role.lifecycle !== "active" && role.lifecycle !== "acceptance_required") continue;
    const changed = permissionChanges(
      role.acceptedPermissions,
      templatePermissions(releaseSet, template.sourceRoleId),
      names,
    );
    const targetReferences = new Set(
      templatePermissions(releaseSet, template.sourceRoleId).map(({ reference }) =>
        referenceKey(reference),
      ),
    );
    const retained = role.acceptedPermissions.filter(({ reference }) =>
      targetReferences.has(referenceKey(reference)),
    );
    const targetUnchanged =
      permissionChanges(retained, templatePermissions(releaseSet, template.sourceRoleId), names)
        .length === 0;
    const targetLifecycle =
      role.lifecycle === "active" && targetUnchanged ? "active" : "acceptance_required";
    const registrationChangesRevision =
      role.lifecycle !== targetLifecycle || retained.length !== role.acceptedPermissions.length;
    if (changed.length > 0 || role.lifecycle === "acceptance_required")
      changes.push({
        sourceRoleId: template.sourceRoleId,
        roleId: String(role.roleId),
        liveRevision: role.liveRevision,
        registrationRevision: role.liveRevision + (registrationChangesRevision ? 1 : 0),
        name: role.label,
        changes: changed.length > 0 ? changed : ["Accept this role again"],
        holders: role.liveAssignmentCount,
      });
  }
  return changes.sort((left, right) => left.name.localeCompare(right.name));
};

/**
 * Proves, before anything is written, the role-template acceptance rule of the installation
 * authority for every permission the listed roles confer: Manage applications, every permission
 * inside the installer's delegated scope and a primary sign-in within the last 15 minutes. A stale
 * sign-in is refused as `authentication_required`, which the install screen shows as "Sign in
 * again". The acceptance operation re-checks all of it.
 */
export const requireRoleAcceptanceAuthority = async (
  environment: Pick<InstallationRoleEnvironment, "requests" | "permissions">,
  session: IdentitySession,
  selector: Selector,
  containsCustomComponents: boolean,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  sourceRoleIds: readonly string[],
): Promise<void> => {
  const conferred = sourceRoleIds.flatMap((sourceRoleId) =>
    templatePermissions(releaseSet, sourceRoleId).map((entry) => entry.reference),
  );
  if (conferred.length === 0) return;
  await inInstallerRequest(environment, session, selector, (transaction, scope) =>
    named("installation_roles_delegation_refused", "member_role_delegation", () =>
      requireInstallationAuthority(transaction, scope, environment.permissions, {
        ...installationOperation(selector.rootId, containsCustomComponents),
        acceptedPermissions: conferred,
      }),
    ),
  );
};

/** Whether prepared evidence names exactly the permissions, with their meaning, the release's template grants. */
const preparesShownTemplate = (
  prepared: PreparedOrganizationRoleChange,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  sourceRoleId: string,
): boolean => {
  const shown = new Map(
    templatePermissions(releaseSet, sourceRoleId).map((entry) => [
      referenceKey(entry.reference),
      entry.meaningFingerprint,
    ]),
  );
  const candidate = prepared.candidate;
  return (
    "permissions" in candidate &&
    candidate.permissions.length === shown.size &&
    candidate.permissions.every(
      (permission) =>
        shown.get(
          referenceKey({
            ownerKind: permission.ownerKind,
            ownerId: String(permission.ownerId),
            permissionId: String(permission.permissionId),
          }),
        ) === permission.meaningFingerprint,
    )
  );
};

/**
 * Accepts each listed role change for exactly the template of `releaseSet` the installer was
 * shown, through the existing Access operations under the installer's own authority, in one
 * transaction. Every role is prepared before the complete set is written; any refusal rolls back
 * every acceptance in that set. A new role is
 * accepted from its template; a changed one has its pending revision accepted. A role that an
 * upgrade left active (it only narrowed) needs no acceptance. Returns the source role ids now
 * matching the template and those that were not accepted, with the cause logged.
 */
export const acceptApplicationRoleChanges = async (
  environment: InstallationRoleEnvironment,
  session: IdentitySession,
  selector: Selector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  changes: readonly ApplicationRoleChange[],
): Promise<Readonly<{ accepted: readonly string[]; notAccepted: readonly string[] }>> => {
  const accepted: string[] = [];
  const commands: { evidence: PreparedOrganizationRoleChange }[] = [];
  const notAccepted: string[] = [];
  if (changes.length === 0) return { accepted, notAccepted };
  const administration = environment.accessAdministration;
  const selection = { organizationId: selector.organizationId };
  const templates = releaseRoleTemplates(releaseSet);
  const current = await readInstallationRoles(
    environment,
    session,
    selector,
    environment.containsCustomComponents(releaseSet),
  );
  for (const change of changes) {
    const refuse = (cause: string) => {
      console.error(`[installation] role ${change.sourceRoleId} not accepted: ${cause}`);
      installationProblem(`installation_role_not_accepted_${cause}`, "conflict");
    };
    const role = current.roles.find((candidate) =>
      sameId(candidate.sourceRoleId, change.sourceRoleId),
    );
    const template = templates.find((candidate) =>
      sameId(candidate.sourceRoleId, change.sourceRoleId),
    );
    if (template === undefined) {
      refuse("template_not_in_release");
      continue;
    }
    if (change.roleId === undefined) {
      if (role !== undefined) {
        refuse(`role_already_${role.lifecycle}`);
        continue;
      }
      const prepared = await administration.prepareRoleChange(
        session,
        selection,
        prepareOrganizationAdministrationRoleChangeCommandSchema.parse({
          operation: "accept_new_application_role",
          roleKey: acceptedApplicationRoleKey(selector.rootId, template.sourceRoleId, template.key),
          label: template.name,
          description: `The ${template.name} role of the application, accepted when it was installed or upgraded.`,
          privilegeClassification: template.privileged ? "privileged" : "standard",
          templateApplicationRootId: selector.rootId,
          sourceRoleId: template.sourceRoleId,
          acceptBroadenedAuthority: "accept",
        }),
      );
      if (prepared.kind !== "available") {
        refuse(`preparation_${prepared.kind}`);
        continue;
      }
      if (
        prepared.value.candidate.operation !== "accept_new_application_role" ||
        !preparesShownTemplate(prepared.value, releaseSet, template.sourceRoleId)
      ) {
        refuse("template_changed_since_review");
        continue;
      }
      commands.push({ evidence: prepared.value });
      accepted.push(change.sourceRoleId);
      continue;
    }
    if (
      role === undefined ||
      !sameId(role.roleId, change.roleId) ||
      role.liveRevision !== change.liveRevision
    ) {
      refuse("role_changed_since_review");
      continue;
    }
    if (role.lifecycle === "active") {
      accepted.push(change.sourceRoleId);
      continue;
    }
    if (role.lifecycle !== "acceptance_required") {
      refuse(`role_${role.lifecycle}`);
      continue;
    }
    const prepared = await administration.prepareApplicationRoleRevisionAcceptance(
      session,
      selection,
      prepareOrganizationAdministrationRoleRevisionAcceptanceCommandSchema.parse({
        operation: "accept_application_role_revision",
        roleId: role.roleId,
        expectedRoleRevision: role.liveRevision,
        acceptBroadenedAuthority: "accept",
      }),
    );
    if (prepared.kind !== "available") {
      refuse(`preparation_${prepared.kind}`);
      continue;
    }
    if (
      prepared.value.candidate.operation !== "accept_application_role_revision" ||
      !preparesShownTemplate(prepared.value, releaseSet, template.sourceRoleId)
    ) {
      refuse("template_changed_since_review");
      continue;
    }
    commands.push({ evidence: prepared.value });
    accepted.push(change.sourceRoleId);
  }
  if (commands.length > 0) {
    const result = await administration.acceptApplicationRoles(session, selection, commands);
    if (result.kind !== "available") {
      if (result.kind === "unavailable" && result.code === "recent_authentication_required")
        installationProblem(
          "installation_role_acceptance_authentication",
          "authentication_required",
        );
      installationProblem(
        "installation_role_set_not_accepted",
        result.kind === "unavailable" ? "refused" : "temporarily_unavailable",
      );
    }
  }
  return { accepted, notAccepted };
};
