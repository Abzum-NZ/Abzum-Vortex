import "server-only";

import { randomUUID } from "node:crypto";
import {
  activityIdSchema,
  changeOrganizationAdministrationMembershipResultSchema,
  changeOrganizationAdministrationRoleResultSchema,
  changeOrganizationAdministrationDelegationAuthorityResultSchema,
  changeOrganizationAdministrationRoleAssignmentResultSchema,
  changeOrganizationAdministrationRoleActivationResultSchema,
  changeOrganizationAdministrationGroupResultSchema,
  createOrganizationAdministrationGroupCommandSchema,
  groupIdSchema,
  listOrganizationAdministrationApplicationRoleTemplatesCommandSchema,
  listOrganizationAdministrationApplicationRoleTemplatesResultSchema,
  listOrganizationAdministrationDelegationAuthoritiesCommandSchema,
  listOrganizationAdministrationDelegationAuthoritiesResultSchema,
  listOrganizationAdministrationGroupsCommandSchema,
  listOrganizationAdministrationGroupsResultSchema,
  listOrganizationAdministrationMembershipsCommandSchema,
  listOrganizationAdministrationMembershipsResultSchema,
  listOrganizationAdministrationPermissionsCommandSchema,
  listOrganizationAdministrationPermissionsResultSchema,
  listOrganizationAdministrationRolesCommandSchema,
  listOrganizationAdministrationRolesResultSchema,
  listOrganizationAdministrationRoleActivationsCommandSchema,
  listOrganizationAdministrationRoleActivationsResultSchema,
  listOrganizationAdministrationRoleAssignmentsCommandSchema,
  listOrganizationAdministrationRoleAssignmentsResultSchema,
  readOrganizationAdministrationApplicationRoleTemplateCommandSchema,
  readOrganizationAdministrationApplicationRoleTemplateResultSchema,
  readOrganizationAdministrationDelegationAuthorityCommandSchema,
  readOrganizationAdministrationDelegationAuthorityResultSchema,
  readOrganizationAdministrationGroupCommandSchema,
  readOrganizationAdministrationGroupResultSchema,
  readOrganizationAdministrationMembershipCommandSchema,
  readOrganizationAdministrationMembershipResultSchema,
  readOrganizationAdministrationPermissionCommandSchema,
  readOrganizationAdministrationPermissionResultSchema,
  readOrganizationAdministrationRoleCommandSchema,
  readOrganizationAdministrationRoleResultSchema,
  readOrganizationAdministrationRoleActivationCommandSchema,
  readOrganizationAdministrationRoleActivationResultSchema,
  readOrganizationAdministrationRoleAssignmentCommandSchema,
  readOrganizationAdministrationRoleAssignmentResultSchema,
  removeOrganizationAdministrationMembershipCommandSchema,
  renameOrganizationAdministrationGroupCommandSchema,
  retireOrganizationAdministrationGroupCommandSchema,
  retireOrganizationAdministrationRoleCommandSchema,
  reviseOrganizationAdministrationRoleMetadataCommandSchema,
  deactivateOrganizationAdministrationRoleActivationCommandSchema,
  revokeOrganizationAdministrationDelegationAuthorityCommandSchema,
  revokeOrganizationAdministrationRoleAssignmentCommandSchema,
  type ChangeOrganizationAdministrationGroupResult,
  type ChangeOrganizationAdministrationMembershipResult,
  type ChangeOrganizationAdministrationRoleResult,
  type ChangeOrganizationAdministrationRoleAssignmentResult,
  type ChangeOrganizationAdministrationDelegationAuthorityResult,
  type ChangeOrganizationAdministrationRoleActivationResult,
  type CreateOrganizationAdministrationGroupCommand,
  type IdentitySession,
  type ListOrganizationAdministrationGroupsCommand,
  type ListOrganizationAdministrationGroupsResult,
  type ListOrganizationAdministrationApplicationRoleTemplatesCommand,
  type ListOrganizationAdministrationApplicationRoleTemplatesResult,
  type ListOrganizationAdministrationDelegationAuthoritiesCommand,
  type ListOrganizationAdministrationDelegationAuthoritiesResult,
  type ListOrganizationAdministrationMembershipsCommand,
  type ListOrganizationAdministrationMembershipsResult,
  type ListOrganizationAdministrationPermissionsCommand,
  type ListOrganizationAdministrationPermissionsResult,
  type ListOrganizationAdministrationRolesCommand,
  type ListOrganizationAdministrationRolesResult,
  type ListOrganizationAdministrationRoleActivationsCommand,
  type ListOrganizationAdministrationRoleActivationsResult,
  type ListOrganizationAdministrationRoleAssignmentsCommand,
  type ListOrganizationAdministrationRoleAssignmentsResult,
  type OrganizationSelectionCandidate,
  organizationRoleChangeCandidateSchema,
  type ReadOrganizationAdministrationGroupCommand,
  type ReadOrganizationAdministrationGroupResult,
  type ReadOrganizationAdministrationApplicationRoleTemplateCommand,
  type ReadOrganizationAdministrationApplicationRoleTemplateResult,
  type ReadOrganizationAdministrationDelegationAuthorityCommand,
  type ReadOrganizationAdministrationDelegationAuthorityResult,
  type ReadOrganizationAdministrationMembershipCommand,
  type ReadOrganizationAdministrationMembershipResult,
  type ReadOrganizationAdministrationPermissionCommand,
  type ReadOrganizationAdministrationPermissionResult,
  type ReadOrganizationAdministrationRoleCommand,
  type ReadOrganizationAdministrationRoleResult,
  type ReadOrganizationAdministrationRoleActivationCommand,
  type ReadOrganizationAdministrationRoleActivationResult,
  type ReadOrganizationAdministrationRoleAssignmentCommand,
  type ReadOrganizationAdministrationRoleAssignmentResult,
  type RenameOrganizationAdministrationGroupCommand,
  type RemoveOrganizationAdministrationMembershipCommand,
  type RetireOrganizationAdministrationGroupCommand,
  type RetireOrganizationAdministrationRoleCommand,
  type ReviseOrganizationAdministrationRoleMetadataCommand,
  type RevokeOrganizationAdministrationRoleAssignmentCommand,
  type DeactivateOrganizationAdministrationRoleActivationCommand,
  type RevokeOrganizationAdministrationDelegationAuthorityCommand,
} from "@vortex/contracts";
import type { DatabaseRow } from "@vortex/db";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "./human-organization-request";
import { prepareOrganizationRoleChangeEvidence } from "./organization-role-change-evidence";

type GroupPageRow = DatabaseRow & {
  organization_id: unknown;
  groups: unknown;
  next_after_group_id: unknown;
  access_version: unknown;
};

type GroupDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  group_summary: unknown;
  access_version: unknown;
};

type GroupChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  group_summary: unknown;
  access_version: unknown;
};

type MembershipPageRow = DatabaseRow & {
  organization_id: unknown;
  group_id: unknown;
  memberships: unknown;
  next_after_membership_id: unknown;
  access_version: unknown;
};

type MembershipDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  membership_summary: unknown;
  access_version: unknown;
};

type MembershipChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  membership_summary: unknown;
  access_version: unknown;
};

type PermissionPageRow = DatabaseRow & {
  organization_id: unknown;
  permissions: unknown;
  next_after_application_root_id: unknown;
  next_after_owner_kind: unknown;
  next_after_owner_id: unknown;
  next_after_permission_id: unknown;
  access_version: unknown;
};

type PermissionDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  permission_summary: unknown;
  access_version: unknown;
};

type RolePageRow = DatabaseRow & {
  organization_id: unknown;
  roles: unknown;
  next_after_role_id: unknown;
  access_version: unknown;
};

type RoleDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  role_summary: unknown;
  access_version: unknown;
};

type RoleMetadataPreparationRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  candidate_basis: unknown;
  access_version: unknown;
};

type RoleChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  role_summary: unknown;
  access_version: unknown;
};

type ApplicationRoleTemplatePageRow = DatabaseRow & {
  organization_id: unknown;
  templates: unknown;
  next_after_application_root_id: unknown;
  next_after_source_role_id: unknown;
  access_version: unknown;
};

type ApplicationRoleTemplateDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  template_summary: unknown;
  access_version: unknown;
};

type RoleAssignmentPageRow = DatabaseRow & {
  organization_id: unknown;
  assignments: unknown;
  next_after_role_assignment_id: unknown;
  access_version: unknown;
};

type RoleAssignmentDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  assignment_summary: unknown;
  access_version: unknown;
};

type RoleAssignmentChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  assignment_summary: unknown;
  access_version: unknown;
};

type DelegationAuthorityChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  delegation_summary: unknown;
  access_version: unknown;
};

type RoleActivationChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  activation_summary: unknown;
  access_version: unknown;
};

type DelegationAuthorityPageRow = DatabaseRow & {
  organization_id: unknown;
  delegations: unknown;
  next_after_delegation_authority_id: unknown;
  access_version: unknown;
};

type DelegationAuthorityDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  delegation_summary: unknown;
  access_version: unknown;
};

type RoleActivationPageRow = DatabaseRow & {
  organization_id: unknown;
  activations: unknown;
  next_after_role_activation_id: unknown;
  access_version: unknown;
};

type RoleActivationDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  activation_summary: unknown;
  access_version: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const normalizeGroup = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ...value, revision: revision((value as { revision?: unknown }).revision) };
};

const normalizeMembership = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ...value, revision: revision((value as { revision?: unknown }).revision) };
};

const normalizeAssignmentLedgerFact = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ...value, revision: revision((value as { revision?: unknown }).revision) };
};

const normalizeRoleActivation = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const activation = value as {
    revision?: unknown;
    historicalRoleRevision?: unknown;
    eligibilitySource?: unknown;
    policyAtActivation?: unknown;
  };
  const source = activation.eligibilitySource;
  const normalizedSource =
    typeof source === "object" && source !== null && !Array.isArray(source)
      ? {
          ...source,
          ...(typeof (source as { eligibilityAssignment?: unknown }).eligibilityAssignment ===
            "object" &&
          (source as { eligibilityAssignment?: unknown }).eligibilityAssignment !== null &&
          !Array.isArray((source as { eligibilityAssignment?: unknown }).eligibilityAssignment)
            ? {
                eligibilityAssignment: {
                  ...(source as { eligibilityAssignment: object }).eligibilityAssignment,
                  revision: revision(
                    (
                      source as {
                        eligibilityAssignment: { revision?: unknown };
                      }
                    ).eligibilityAssignment.revision,
                  ),
                },
              }
            : {}),
          ...(typeof (source as { originatingMembership?: unknown }).originatingMembership ===
            "object" &&
          (source as { originatingMembership?: unknown }).originatingMembership !== null &&
          !Array.isArray((source as { originatingMembership?: unknown }).originatingMembership)
            ? {
                originatingMembership: {
                  ...(source as { originatingMembership: object }).originatingMembership,
                  revision: revision(
                    (
                      source as {
                        originatingMembership: { revision?: unknown };
                      }
                    ).originatingMembership.revision,
                  ),
                },
              }
            : {}),
        }
      : source;
  const policy = activation.policyAtActivation;
  return {
    ...activation,
    revision: revision(activation.revision),
    historicalRoleRevision: revision(activation.historicalRoleRevision),
    ...(source === undefined ? {} : { eligibilitySource: normalizedSource }),
    ...(typeof policy === "object" && policy !== null && !Array.isArray(policy)
      ? {
          policyAtActivation: {
            ...policy,
            maximumActivationDurationSeconds: revision(
              (policy as { maximumActivationDurationSeconds?: unknown })
                .maximumActivationDurationSeconds,
            ),
          },
        }
      : {}),
  };
};

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const samePermissionReference = (
  left: Readonly<{
    applicationRootId?: string | undefined;
    ownerKind: string;
    ownerId: string;
    permissionId: string;
  }>,
  right: Readonly<{
    applicationRootId?: string | undefined;
    ownerKind: string;
    ownerId: string;
    permissionId: string;
  }>,
): boolean =>
  left.ownerKind === right.ownerKind &&
  sameUuid(left.ownerId, right.ownerId) &&
  sameUuid(left.permissionId, right.permissionId) &&
  (left.applicationRootId === undefined) === (right.applicationRootId === undefined) &&
  (left.applicationRootId === undefined ||
    right.applicationRootId === undefined ||
    sameUuid(left.applicationRootId, right.applicationRootId));

const sameApplicationRoleTemplateReference = (
  left: Readonly<{ applicationRootId: string; sourceRoleId: string }>,
  right: Readonly<{ applicationRootId: string; sourceRoleId: string }>,
): boolean =>
  sameUuid(left.applicationRootId, right.applicationRootId) &&
  sameUuid(left.sourceRoleId, right.sourceRoleId);

const requireOne = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
  return rows[0];
};

const recordedRefusal = Symbol("recordedAccessAdministrationRefusal");
type RecordedRefusal = typeof recordedRefusal;

const isRecordedRefusal = (
  row: Readonly<{
    outcome: unknown;
    organization_id: unknown;
    access_version: unknown;
  }>,
  summary: unknown,
  organizationId: string,
  accessVersion: number,
): boolean => {
  if (row.outcome !== "refused") return false;
  if (
    typeof row.organization_id !== "string" ||
    !sameUuid(row.organization_id, organizationId) ||
    summary !== null ||
    revision(row.access_version) !== accessVersion
  )
    throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
  return true;
};

const mapRecordedRefusal = async <Result>(
  request: Promise<HumanOrganizationRequestResult<Result | RecordedRefusal>>,
): Promise<HumanOrganizationRequestResult<Result>> => {
  const result = await request;
  if (result.kind !== "available") return result;
  if (result.value === recordedRefusal) return { kind: "unavailable" };
  return { kind: "available", value: result.value as Result };
};

export type OrganizationAccessAdministrationDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    groupId?: () => string;
    activityId?: () => string;
  }>;

export const createOrganizationAccessAdministrationService = (
  dependencies: OrganizationAccessAdministrationDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newGroupId = dependencies.groupId ?? randomUUID;
  const newActivityId = dependencies.activityId ?? randomUUID;

  const changedGroup = (
    rows: readonly GroupChangeRow[],
    organizationId: string,
    priorAccessVersion: number,
    expected: Readonly<{
      groupId: string;
      label: string;
      revision: number;
      key?: string;
    }>,
  ): ChangeOrganizationAdministrationGroupResult => {
    const row = requireOne(rows);
    const parsed = changeOrganizationAdministrationGroupResultSchema.safeParse({
      group: normalizeGroup(row.group_summary),
      accessVersion: revision(row.access_version),
    });
    if (
      typeof row.organization_id !== "string" ||
      !sameUuid(row.organization_id, organizationId) ||
      row.outcome !== "completed" ||
      !parsed.success ||
      parsed.data.accessVersion !== priorAccessVersion + 1 ||
      !sameUuid(parsed.data.group.groupId, expected.groupId) ||
      parsed.data.group.label !== expected.label ||
      parsed.data.group.revision !== expected.revision ||
      parsed.data.group.state !== "active" ||
      (expected.key !== undefined && parsed.data.group.key !== expected.key)
    )
      throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
    return parsed.data;
  };

  return Object.freeze({
    createGroup: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: CreateOrganizationAdministrationGroupCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationGroupResult>> => {
      const command =
        createOrganizationAdministrationGroupCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let groupId: string;
      let activityId: string;
      try {
        groupId = groupIdSchema.parse(newGroupId());
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }

      return mapRecordedRefusal(
        requests.runChange(session, candidate, async (transaction, scope) => {
          const rows = await transaction.query<GroupChangeRow>`
            select outcome, organization_id, group_summary, access_version
            from vortex_access.create_organization_group_for_administration(
              ${groupId}::uuid,
              ${command.data.key}::text,
              ${command.data.label}::text,
              ${activityId}::uuid
            )
          `;
          const row = requireOne(rows);
          if (isRecordedRefusal(row, row.group_summary, scope.organizationId, scope.accessVersion))
            return recordedRefusal;
          return changedGroup(rows, scope.organizationId, scope.accessVersion, {
            groupId,
            key: command.data.key,
            label: command.data.label,
            revision: 1,
          });
        }),
      );
    },

    renameGroup: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RenameOrganizationAdministrationGroupCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationGroupResult>> => {
      const command =
        renameOrganizationAdministrationGroupCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }

      return mapRecordedRefusal(
        requests.runChange(session, candidate, async (transaction, scope) => {
          const rows = await transaction.query<GroupChangeRow>`
            select outcome, organization_id, group_summary, access_version
            from vortex_access.rename_organization_group_for_administration(
              ${command.data.groupId}::uuid,
              ${command.data.expectedGroupRevision}::bigint,
              ${command.data.label}::text,
              ${activityId}::uuid
            )
          `;
          const row = requireOne(rows);
          if (isRecordedRefusal(row, row.group_summary, scope.organizationId, scope.accessVersion))
            return recordedRefusal;
          return changedGroup(rows, scope.organizationId, scope.accessVersion, {
            groupId: command.data.groupId,
            label: command.data.label,
            revision: command.data.expectedGroupRevision + 1,
          });
        }),
      );
    },

    retireGroup: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RetireOrganizationAdministrationGroupCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationGroupResult>> => {
      const command =
        retireOrganizationAdministrationGroupCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }

      return mapRecordedRefusal(
        requests.runChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<GroupChangeRow>`
            select outcome, organization_id, group_summary, access_version
            from vortex_access.retire_organization_group_for_administration(
              ${command.data.groupId}::uuid,
              ${command.data.expectedGroupRevision}::bigint,
              ${activityId}::uuid
            )
          `,
          );
          if (isRecordedRefusal(row, row.group_summary, scope.organizationId, scope.accessVersion))
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationGroupResultSchema.safeParse({
            group: normalizeGroup(row.group_summary),
            accessVersion: revision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameUuid(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameUuid(parsed.data.group.groupId, command.data.groupId) ||
            parsed.data.group.revision !== command.data.expectedGroupRevision + 1 ||
            parsed.data.group.state !== "retired"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    removeGroupMembership: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RemoveOrganizationAdministrationMembershipCommand,
    ): Promise<
      HumanOrganizationRequestResult<ChangeOrganizationAdministrationMembershipResult>
    > => {
      const command =
        removeOrganizationAdministrationMembershipCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }

      return mapRecordedRefusal(
        requests.runChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<MembershipChangeRow>`
            select outcome, organization_id, membership_summary, access_version
            from vortex_access.remove_organization_group_membership_for_administration(
              ${command.data.membershipId}::uuid,
              ${command.data.expectedMembershipRevision}::bigint,
              ${activityId}::uuid
            )
          `,
          );
          if (
            isRecordedRefusal(
              row,
              row.membership_summary,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationMembershipResultSchema.safeParse({
            membership: normalizeMembership(row.membership_summary),
            accessVersion: revision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameUuid(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameUuid(parsed.data.membership.membershipId, command.data.membershipId) ||
            parsed.data.membership.revision !== command.data.expectedMembershipRevision + 1 ||
            parsed.data.membership.state !== "revoked" ||
            parsed.data.membership.temporalState !== "revoked"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    reviseRoleMetadata: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReviseOrganizationAdministrationRoleMetadataCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleResult>> => {
      const command =
        reviseOrganizationAdministrationRoleMetadataCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }

      return mapRecordedRefusal(
        requests.runChange(session, candidate, async (transaction, scope) => {
          const preparationRow = requireOne(
            await transaction.query<RoleMetadataPreparationRow>`
            select outcome, organization_id, candidate_basis, access_version
            from vortex_access.prepare_organization_role_metadata_change_for_administration(
              ${command.data.roleId}::uuid,
              ${command.data.expectedRoleRevision}::bigint,
              ${activityId}::uuid
            )
          `,
          );
          if (
            isRecordedRefusal(
              preparationRow,
              preparationRow.candidate_basis,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          const basis = organizationRoleChangeCandidateSchema.safeParse(
            preparationRow.candidate_basis,
          );
          if (
            typeof preparationRow.organization_id !== "string" ||
            !sameUuid(preparationRow.organization_id, scope.organizationId) ||
            preparationRow.outcome !== "completed" ||
            revision(preparationRow.access_version) !== scope.accessVersion ||
            !basis.success ||
            basis.data.operation !== "revise_metadata_policy" ||
            !sameUuid(basis.data.organizationId, scope.organizationId) ||
            !sameUuid(basis.data.roleId, command.data.roleId) ||
            basis.data.expectedRoleRevision !== command.data.expectedRoleRevision
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

          const prepared = prepareOrganizationRoleChangeEvidence({
            candidate: {
              ...basis.data,
              label: command.data.label,
              description: command.data.description,
            },
          });
          const row = requireOne(
            await transaction.query<RoleChangeRow>`
            select outcome, organization_id, role_summary, access_version
            from vortex_access.revise_organization_role_metadata_for_administration(
              ${command.data.roleId}::uuid,
              ${command.data.expectedRoleRevision}::bigint,
              ${command.data.label}::text,
              ${command.data.description}::text,
              ${JSON.stringify(prepared)}::text::jsonb,
              ${activityId}::uuid
            )
          `,
          );
          if (isRecordedRefusal(row, row.role_summary, scope.organizationId, scope.accessVersion))
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationRoleResultSchema.safeParse({
            role: row.role_summary,
            accessVersion: revision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameUuid(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameUuid(parsed.data.role.roleId, command.data.roleId) ||
            parsed.data.role.liveRevision !== command.data.expectedRoleRevision + 1 ||
            parsed.data.role.label !== command.data.label
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    retireRole: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RetireOrganizationAdministrationRoleCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleResult>> => {
      const command = retireOrganizationAdministrationRoleCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }

      return mapRecordedRefusal(
        requests.runChange(session, candidate, async (transaction, scope) => {
          const prepared = prepareOrganizationRoleChangeEvidence({
            candidate: {
              operation: "retire_role",
              organizationId: scope.organizationId,
              roleId: command.data.roleId,
              expectedRoleRevision: command.data.expectedRoleRevision,
            },
          });
          const row = requireOne(
            await transaction.query<RoleChangeRow>`
            select outcome, organization_id, role_summary, access_version
            from vortex_access.retire_organization_role_for_administration(
              ${command.data.roleId}::uuid,
              ${command.data.expectedRoleRevision}::bigint,
              ${JSON.stringify(prepared)}::text::jsonb,
              ${activityId}::uuid
            )
          `,
          );
          if (isRecordedRefusal(row, row.role_summary, scope.organizationId, scope.accessVersion))
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationRoleResultSchema.safeParse({
            role: row.role_summary,
            accessVersion: revision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameUuid(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameUuid(parsed.data.role.roleId, command.data.roleId) ||
            parsed.data.role.liveRevision !== command.data.expectedRoleRevision + 1 ||
            parsed.data.role.lifecycle !== "retired"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    revokeRoleAssignment: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RevokeOrganizationAdministrationRoleAssignmentCommand,
    ): Promise<
      HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleAssignmentResult>
    > => {
      const command =
        revokeOrganizationAdministrationRoleAssignmentCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }
      return mapRecordedRefusal(
        requests.runChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<RoleAssignmentChangeRow>`
          select outcome, organization_id, assignment_summary, access_version
          from vortex_access.revoke_organization_role_assignment_for_administration(
            ${command.data.roleAssignmentId}::uuid,
            ${command.data.expectedAssignmentRevision}::bigint,
            ${activityId}::uuid
          )
        `,
          );
          if (
            isRecordedRefusal(
              row,
              row.assignment_summary,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationRoleAssignmentResultSchema.safeParse({
            assignment: normalizeAssignmentLedgerFact(row.assignment_summary),
            accessVersion: revision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameUuid(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameUuid(parsed.data.assignment.roleAssignmentId, command.data.roleAssignmentId) ||
            parsed.data.assignment.revision !== command.data.expectedAssignmentRevision + 1 ||
            parsed.data.assignment.state !== "revoked" ||
            parsed.data.assignment.temporalState !== "revoked"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    deactivateRoleActivation: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: DeactivateOrganizationAdministrationRoleActivationCommand,
    ): Promise<
      HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleActivationResult>
    > => {
      const command =
        deactivateOrganizationAdministrationRoleActivationCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }
      return mapRecordedRefusal(
        requests.runChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<RoleActivationChangeRow>`
          select outcome, organization_id, activation_summary, access_version
          from vortex_access.deactivate_organization_role_activation_for_administration(
            ${command.data.roleActivationId}::uuid,
            ${command.data.expectedActivationRevision}::bigint,
            ${activityId}::uuid
          )`,
          );
          if (
            isRecordedRefusal(
              row,
              row.activation_summary,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationRoleActivationResultSchema.safeParse({
            activation: normalizeRoleActivation(row.activation_summary),
            accessVersion: revision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameUuid(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameUuid(parsed.data.activation.roleActivationId, command.data.roleActivationId) ||
            parsed.data.activation.revision !== command.data.expectedActivationRevision + 1 ||
            parsed.data.activation.state !== "revoked" ||
            parsed.data.activation.temporalState !== "revoked"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    revokeDelegationAuthority: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RevokeOrganizationAdministrationDelegationAuthorityCommand,
    ): Promise<
      HumanOrganizationRequestResult<ChangeOrganizationAdministrationDelegationAuthorityResult>
    > => {
      const command =
        revokeOrganizationAdministrationDelegationAuthorityCommandSchema.safeParse(
          commandCandidate,
        );
      if (!command.success) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }
      return mapRecordedRefusal(
        requests.runChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<DelegationAuthorityChangeRow>`
          select outcome, organization_id, delegation_summary, access_version
          from vortex_access.revoke_organization_delegation_authority_for_administration(
            ${command.data.delegationAuthorityId}::uuid,
            ${command.data.expectedDelegationRevision}::bigint,
            ${activityId}::uuid
          )`,
          );
          if (
            isRecordedRefusal(
              row,
              row.delegation_summary,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationDelegationAuthorityResultSchema.safeParse({
            delegation: normalizeAssignmentLedgerFact(row.delegation_summary),
            accessVersion: revision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameUuid(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameUuid(
              parsed.data.delegation.delegationAuthorityId,
              command.data.delegationAuthorityId,
            ) ||
            parsed.data.delegation.revision !== command.data.expectedDelegationRevision + 1 ||
            parsed.data.delegation.state !== "revoked" ||
            parsed.data.delegation.temporalState !== "revoked"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    listGroups: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationGroupsCommand,
    ): Promise<HumanOrganizationRequestResult<ListOrganizationAdministrationGroupsResult>> => {
      const command = listOrganizationAdministrationGroupsCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<GroupPageRow>`
            select organization_id, groups, next_after_group_id, access_version
            from vortex_access.list_organization_groups_for_administration(
              ${command.data.afterGroupId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.groups)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationGroupsResultSchema.parse({
          groups: row.groups.map(normalizeGroup),
          ...(row.next_after_group_id === null || row.next_after_group_id === undefined
            ? {}
            : { nextAfterGroupId: row.next_after_group_id }),
          accessVersion: revision(row.access_version),
        });
      });
    },

    readGroup: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationGroupCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationAdministrationGroupResult>> => {
      const command = readOrganizationAdministrationGroupCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<GroupDetailRow>`
            select organization_id, outcome, group_summary, access_version
            from vortex_access.read_organization_group_for_administration(
              ${command.data.groupId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return readOrganizationAdministrationGroupResultSchema.parse({
          outcome: row.outcome,
          ...(row.group_summary === null || row.group_summary === undefined
            ? {}
            : { group: normalizeGroup(row.group_summary) }),
          accessVersion: revision(row.access_version),
        });
      });
    },

    listGroupMemberships: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationMembershipsCommand,
    ): Promise<HumanOrganizationRequestResult<ListOrganizationAdministrationMembershipsResult>> => {
      const command =
        listOrganizationAdministrationMembershipsCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<MembershipPageRow>`
            select organization_id, group_id, memberships,
              next_after_membership_id, access_version
            from vortex_access.list_organization_group_memberships_for_administration(
              ${command.data.groupId}::uuid,
              ${command.data.afterMembershipId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          typeof row.group_id !== "string" ||
          !sameUuid(row.group_id, command.data.groupId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.memberships)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationMembershipsResultSchema.parse({
          groupId: row.group_id,
          memberships: row.memberships.map(normalizeMembership),
          ...(row.next_after_membership_id === null || row.next_after_membership_id === undefined
            ? {}
            : { nextAfterMembershipId: row.next_after_membership_id }),
          accessVersion: revision(row.access_version),
        });
      });
    },

    readGroupMembership: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationMembershipCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationAdministrationMembershipResult>> => {
      const command =
        readOrganizationAdministrationMembershipCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<MembershipDetailRow>`
            select organization_id, outcome, membership_summary, access_version
            from vortex_access.read_organization_group_membership_for_administration(
              ${command.data.membershipId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return readOrganizationAdministrationMembershipResultSchema.parse({
          outcome: row.outcome,
          ...(row.membership_summary === null || row.membership_summary === undefined
            ? {}
            : { membership: normalizeMembership(row.membership_summary) }),
          accessVersion: revision(row.access_version),
        });
      });
    },

    listPermissions: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationPermissionsCommand,
    ): Promise<HumanOrganizationRequestResult<ListOrganizationAdministrationPermissionsResult>> => {
      const command =
        listOrganizationAdministrationPermissionsCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const after = command.data.after;
        const row = requireOne(
          await transaction.query<PermissionPageRow>`
            select organization_id, permissions,
              next_after_application_root_id, next_after_owner_kind,
              next_after_owner_id, next_after_permission_id, access_version
            from vortex_access.list_organization_permissions_for_administration(
              ${after?.applicationRootId ?? null}::uuid,
              ${after?.ownerKind ?? null}::text,
              ${after?.ownerId ?? null}::uuid,
              ${after?.permissionId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.permissions)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const hasNext = [
          row.next_after_application_root_id,
          row.next_after_owner_kind,
          row.next_after_owner_id,
          row.next_after_permission_id,
        ].some((value) => value !== null && value !== undefined);
        return listOrganizationAdministrationPermissionsResultSchema.parse({
          permissions: row.permissions,
          ...(hasNext
            ? {
                nextAfter: {
                  ...(row.next_after_application_root_id === null ||
                  row.next_after_application_root_id === undefined
                    ? {}
                    : { applicationRootId: row.next_after_application_root_id }),
                  ownerKind: row.next_after_owner_kind,
                  ownerId: row.next_after_owner_id,
                  permissionId: row.next_after_permission_id,
                },
              }
            : {}),
          accessVersion: revision(row.access_version),
        });
      });
    },

    readPermission: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationPermissionCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationAdministrationPermissionResult>> => {
      const command =
        readOrganizationAdministrationPermissionCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const reference = command.data.reference;
        const row = requireOne(
          await transaction.query<PermissionDetailRow>`
            select organization_id, outcome, permission_summary, access_version
            from vortex_access.read_organization_permission_for_administration(
              ${reference.applicationRootId ?? null}::uuid,
              ${reference.ownerKind}::text,
              ${reference.ownerId}::uuid,
              ${reference.permissionId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationPermissionResultSchema.parse({
          outcome: row.outcome,
          ...(row.permission_summary === null || row.permission_summary === undefined
            ? {}
            : { permission: row.permission_summary }),
          accessVersion: revision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !samePermissionReference(result.permission.reference, reference)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },

    listRoles: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationRolesCommand,
    ): Promise<HumanOrganizationRequestResult<ListOrganizationAdministrationRolesResult>> => {
      const command = listOrganizationAdministrationRolesCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RolePageRow>`
            select organization_id, roles, next_after_role_id, access_version
            from vortex_access.list_organization_roles_for_administration(
              ${command.data.afterRoleId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.roles)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationRolesResultSchema.parse({
          roles: row.roles,
          ...(row.next_after_role_id === null || row.next_after_role_id === undefined
            ? {}
            : { nextAfterRoleId: row.next_after_role_id }),
          accessVersion: revision(row.access_version),
        });
      });
    },

    readRole: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationRoleCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationAdministrationRoleResult>> => {
      const command = readOrganizationAdministrationRoleCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RoleDetailRow>`
            select organization_id, outcome, role_summary, access_version
            from vortex_access.read_organization_role_for_administration(
              ${command.data.roleId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationRoleResultSchema.parse({
          outcome: row.outcome,
          ...(row.role_summary === null || row.role_summary === undefined
            ? {}
            : { role: row.role_summary }),
          accessVersion: revision(row.access_version),
        });
        if (result.outcome === "available" && !sameUuid(result.role.roleId, command.data.roleId))
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },

    listApplicationRoleTemplates: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationApplicationRoleTemplatesCommand,
    ): Promise<
      HumanOrganizationRequestResult<ListOrganizationAdministrationApplicationRoleTemplatesResult>
    > => {
      const command =
        listOrganizationAdministrationApplicationRoleTemplatesCommandSchema.safeParse(
          commandCandidate,
        );
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const after = command.data.after;
        const row = requireOne(
          await transaction.query<ApplicationRoleTemplatePageRow>`
            select organization_id, templates, next_after_application_root_id,
              next_after_source_role_id, access_version
            from vortex_access.list_application_role_templates_for_administration(
              ${after?.applicationRootId ?? null}::uuid,
              ${after?.sourceRoleId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.templates)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const nextApplicationPresent =
          row.next_after_application_root_id !== null &&
          row.next_after_application_root_id !== undefined;
        const nextSourcePresent =
          row.next_after_source_role_id !== null && row.next_after_source_role_id !== undefined;
        if (nextApplicationPresent !== nextSourcePresent)
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        const hasNext = nextApplicationPresent && nextSourcePresent;
        return listOrganizationAdministrationApplicationRoleTemplatesResultSchema.parse({
          templates: row.templates,
          ...(hasNext
            ? {
                nextAfter: {
                  applicationRootId: row.next_after_application_root_id,
                  sourceRoleId: row.next_after_source_role_id,
                },
              }
            : {}),
          accessVersion: revision(row.access_version),
        });
      });
    },

    readApplicationRoleTemplate: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationApplicationRoleTemplateCommand,
    ): Promise<
      HumanOrganizationRequestResult<ReadOrganizationAdministrationApplicationRoleTemplateResult>
    > => {
      const command =
        readOrganizationAdministrationApplicationRoleTemplateCommandSchema.safeParse(
          commandCandidate,
        );
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const reference = command.data.reference;
        const row = requireOne(
          await transaction.query<ApplicationRoleTemplateDetailRow>`
            select organization_id, outcome, template_summary, access_version
            from vortex_access.read_application_role_template_for_administration(
              ${reference.applicationRootId}::uuid,
              ${reference.sourceRoleId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationApplicationRoleTemplateResultSchema.parse({
          outcome: row.outcome,
          ...(row.template_summary === null || row.template_summary === undefined
            ? {}
            : { template: row.template_summary }),
          accessVersion: revision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !sameApplicationRoleTemplateReference(result.template.reference, reference)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },

    listRoleAssignments: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationRoleAssignmentsCommand,
    ): Promise<
      HumanOrganizationRequestResult<ListOrganizationAdministrationRoleAssignmentsResult>
    > => {
      const command =
        listOrganizationAdministrationRoleAssignmentsCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RoleAssignmentPageRow>`
            select organization_id, assignments, next_after_role_assignment_id,
              access_version
            from vortex_access.list_organization_role_assignments_for_administration(
              ${command.data.afterRoleAssignmentId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.assignments)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationRoleAssignmentsResultSchema.parse({
          assignments: row.assignments.map(normalizeAssignmentLedgerFact),
          ...(row.next_after_role_assignment_id === null ||
          row.next_after_role_assignment_id === undefined
            ? {}
            : { nextAfterRoleAssignmentId: row.next_after_role_assignment_id }),
          accessVersion: revision(row.access_version),
        });
      });
    },

    readRoleAssignment: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationRoleAssignmentCommand,
    ): Promise<
      HumanOrganizationRequestResult<ReadOrganizationAdministrationRoleAssignmentResult>
    > => {
      const command =
        readOrganizationAdministrationRoleAssignmentCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RoleAssignmentDetailRow>`
            select organization_id, outcome, assignment_summary, access_version
            from vortex_access.read_organization_role_assignment_for_administration(
              ${command.data.roleAssignmentId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationRoleAssignmentResultSchema.parse({
          outcome: row.outcome,
          ...(row.assignment_summary === null || row.assignment_summary === undefined
            ? {}
            : { assignment: normalizeAssignmentLedgerFact(row.assignment_summary) }),
          accessVersion: revision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !sameUuid(result.assignment.roleAssignmentId, command.data.roleAssignmentId)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },

    listDelegationAuthorities: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationDelegationAuthoritiesCommand,
    ): Promise<
      HumanOrganizationRequestResult<ListOrganizationAdministrationDelegationAuthoritiesResult>
    > => {
      const command =
        listOrganizationAdministrationDelegationAuthoritiesCommandSchema.safeParse(
          commandCandidate,
        );
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<DelegationAuthorityPageRow>`
            select organization_id, delegations,
              next_after_delegation_authority_id, access_version
            from vortex_access.list_organization_delegation_authorities_for_administration(
              ${command.data.afterDelegationAuthorityId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.delegations)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationDelegationAuthoritiesResultSchema.parse({
          delegations: row.delegations.map(normalizeAssignmentLedgerFact),
          ...(row.next_after_delegation_authority_id === null ||
          row.next_after_delegation_authority_id === undefined
            ? {}
            : { nextAfterDelegationAuthorityId: row.next_after_delegation_authority_id }),
          accessVersion: revision(row.access_version),
        });
      });
    },

    readDelegationAuthority: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationDelegationAuthorityCommand,
    ): Promise<
      HumanOrganizationRequestResult<ReadOrganizationAdministrationDelegationAuthorityResult>
    > => {
      const command =
        readOrganizationAdministrationDelegationAuthorityCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<DelegationAuthorityDetailRow>`
            select organization_id, outcome, delegation_summary, access_version
            from vortex_access.read_organization_delegation_authority_for_administration(
              ${command.data.delegationAuthorityId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationDelegationAuthorityResultSchema.parse({
          outcome: row.outcome,
          ...(row.delegation_summary === null || row.delegation_summary === undefined
            ? {}
            : { delegation: normalizeAssignmentLedgerFact(row.delegation_summary) }),
          accessVersion: revision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !sameUuid(result.delegation.delegationAuthorityId, command.data.delegationAuthorityId)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },

    listRoleActivations: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationRoleActivationsCommand,
    ): Promise<
      HumanOrganizationRequestResult<ListOrganizationAdministrationRoleActivationsResult>
    > => {
      const command =
        listOrganizationAdministrationRoleActivationsCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RoleActivationPageRow>`
            select organization_id, activations, next_after_role_activation_id,
              access_version
            from vortex_access.list_organization_role_activations_for_administration(
              ${command.data.afterRoleActivationId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.activations)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationRoleActivationsResultSchema.parse({
          activations: row.activations.map(normalizeRoleActivation),
          ...(row.next_after_role_activation_id === null ||
          row.next_after_role_activation_id === undefined
            ? {}
            : { nextAfterRoleActivationId: row.next_after_role_activation_id }),
          accessVersion: revision(row.access_version),
        });
      });
    },

    readRoleActivation: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationRoleActivationCommand,
    ): Promise<
      HumanOrganizationRequestResult<ReadOrganizationAdministrationRoleActivationResult>
    > => {
      const command =
        readOrganizationAdministrationRoleActivationCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RoleActivationDetailRow>`
            select organization_id, outcome, activation_summary, access_version
            from vortex_access.read_organization_role_activation_for_administration(
              ${command.data.roleActivationId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationRoleActivationResultSchema.parse({
          outcome: row.outcome,
          ...(row.activation_summary === null || row.activation_summary === undefined
            ? {}
            : { activation: normalizeRoleActivation(row.activation_summary) }),
          accessVersion: revision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !sameUuid(result.activation.roleActivationId, command.data.roleActivationId)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },
  });
};
