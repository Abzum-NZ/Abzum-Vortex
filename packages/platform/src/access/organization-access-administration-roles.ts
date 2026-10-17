import "server-only";

import { z } from "zod";

import { randomUUID } from "node:crypto";
import {
  databaseRevision,
  sameId,
  activityIdSchema,
  affectedRoleAssignmentSchema,
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  changeOrganizationAdministrationRoleResultSchema,
  listOrganizationAdministrationApplicationRoleTemplatesCommandSchema,
  listOrganizationAdministrationApplicationRoleTemplatesResultSchema,
  listOrganizationAdministrationPermissionsCommandSchema,
  listOrganizationAdministrationPermissionsResultSchema,
  listOrganizationAdministrationRolesCommandSchema,
  listOrganizationAdministrationRolesResultSchema,
  readOrganizationAdministrationApplicationRoleTemplateCommandSchema,
  readOrganizationAdministrationApplicationRoleTemplateResultSchema,
  readOrganizationAdministrationPermissionCommandSchema,
  readOrganizationAdministrationPermissionResultSchema,
  readOrganizationAdministrationRoleCommandSchema,
  readOrganizationAdministrationRoleResultSchema,
  prepareOrganizationAdministrationRoleChangeCommandSchema,
  prepareOrganizationAdministrationRoleRevisionAcceptanceCommandSchema,
  organizationRoleChangeCandidateSchema,
  roleIdSchema,
  retireOrganizationAdministrationRoleCommandSchema,
  reviseOrganizationAdministrationRoleMetadataCommandSchema,
  type AffectedRoleAssignment,
  type ChangeOrganizationAdministrationRoleAuthorityCommand,
  type ChangeOrganizationAdministrationRoleResult,
  type IdentitySession,
  type ListOrganizationAdministrationApplicationRoleTemplatesCommand,
  type ListOrganizationAdministrationApplicationRoleTemplatesResult,
  type ListOrganizationAdministrationPermissionsCommand,
  type ListOrganizationAdministrationPermissionsResult,
  type ListOrganizationAdministrationRolesCommand,
  type ListOrganizationAdministrationRolesResult,
  type OrganizationRoleChangeCandidate,
  type OrganizationSelectionCandidate,
  type PreparedOrganizationRoleChange,
  type PrepareOrganizationAdministrationRoleChangeCommand,
  type PrepareOrganizationAdministrationRoleRevisionAcceptanceCommand,
  type ReadOrganizationAdministrationApplicationRoleTemplateCommand,
  type ReadOrganizationAdministrationApplicationRoleTemplateResult,
  type ReadOrganizationAdministrationPermissionCommand,
  type ReadOrganizationAdministrationPermissionResult,
  type ReadOrganizationAdministrationRoleCommand,
  type ReadOrganizationAdministrationRoleResult,
  type RetireOrganizationAdministrationRoleCommand,
  type ReviseOrganizationAdministrationRoleMetadataCommand,
  type RolePermissionEntry,
} from "../schema";
import type { HumanOrganizationRequestResult } from "./human-organization-request";
import {
  prepareOrganizationRoleChangeEvidence,
  verifyPreparedOrganizationRoleChangeEvidence,
} from "./organization-role-change-evidence";
import {
  samePermissionReference,
  sameApplicationRoleTemplateReference,
  requireOne,
  recordedRefusal,
  isRecordedRefusal,
  refuseAdministration,
  mapRecordedRefusal,
  preparationUnavailable,
  readRoleTemplateSource,
  sealPreparedRoleChange,
} from "./organization-access-administration-shared";
import type {
  PermissionPageRow,
  PermissionDetailRow,
  RolePageRow,
  RoleDetailRow,
  RoleChangeRow,
  ApplicationRoleTemplatePageRow,
  ApplicationRoleTemplateDetailRow,
  RoleChangePreparationRow,
  AccessAdministrationContext,
} from "./organization-access-administration-shared";

export const createAccessAdministrationRoleOperations = ({
  requests,
  newActivityId,
}: AccessAdministrationContext) => {
  /**
   * Runs one prepared role-authority change (create a custom role or accept an application role
   * template) through the protected request entry. The browser-submitted evidence is re-derived and
   * verified with the canonical preparation verifier before the database rechecks current
   * authority, affected assignments and acceptance; the owning composition keeps the
   * permanent-steward safeguard, so this entry never becomes a raw grant endpoint.
   */
  const changeRoleAuthority = async (
    expectedOperations: readonly PreparedOrganizationRoleChange["candidate"]["operation"][],
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate,
    commandCandidate: ChangeOrganizationAdministrationRoleAuthorityCommand,
  ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleResult>> => {
    const command =
      changeOrganizationAdministrationRoleAuthorityCommandSchema.safeParse(commandCandidate);
    if (!command.success)
      return refuseAdministration(
        "changeRoleAuthority",
        "ACCESS_ADMIN_COMMAND_INVALID",
        { kind: "unavailable" } as const,
        command.error,
      );
    let evidence: PreparedOrganizationRoleChange;
    try {
      evidence = verifyPreparedOrganizationRoleChangeEvidence(command.data.evidence);
    } catch (error) {
      return refuseAdministration(
        "changeRoleAuthority",
        "ACCESS_ADMIN_EVIDENCE_REJECTED",
        { kind: "unavailable" } as const,
        error,
      );
    }
    if (!expectedOperations.includes(evidence.candidate.operation))
      return refuseAdministration("changeRoleAuthority", "ACCESS_ADMIN_OPERATION_NOT_EXPECTED", {
        kind: "unavailable",
      } as const);
    // A new role starts at revision 1; an accepted revision advances the reviewed live revision.
    const expectedLiveRevision =
      "expectedRoleRevision" in evidence.candidate
        ? evidence.candidate.expectedRoleRevision + 1
        : 1;
    let activityId: string;
    try {
      activityId = activityIdSchema.parse(newActivityId());
    } catch (error) {
      return refuseAdministration(
        "changeRoleAuthority",
        "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
        { kind: "temporarily_unavailable" } as const,
        error,
      );
    }

    return mapRecordedRefusal(
      "changeRoleAuthority",
      requests.runAccessChange(session, candidate, async (transaction, scope) => {
        // The evidence names its organisation; it must be the one the request context selected.
        if (!sameId(evidence.candidate.organizationId, scope.organizationId))
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        const row = requireOne(
          await transaction.query<RoleChangeRow>`
            select outcome, organization_id, role_summary, access_version
            from vortex_access.change_organization_role_authority_for_administration(
              ${JSON.stringify(evidence)}::text::jsonb,
              ${activityId}::uuid
            )
          `,
        );
        if (isRecordedRefusal(row, row.role_summary, scope.organizationId, scope.accessVersion))
          return recordedRefusal;
        const parsed = changeOrganizationAdministrationRoleResultSchema.safeParse({
          role: row.role_summary,
          accessVersion: databaseRevision(row.access_version),
        });
        if (
          typeof row.organization_id !== "string" ||
          !sameId(row.organization_id, scope.organizationId) ||
          row.outcome !== "completed" ||
          !parsed.success ||
          parsed.data.accessVersion !== scope.accessVersion + 1 ||
          !sameId(parsed.data.role.roleId, evidence.candidate.roleId) ||
          parsed.data.role.liveRevision !== expectedLiveRevision
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return parsed.data;
      }),
    );
  };

  return {
    reviseRoleMetadata: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReviseOrganizationAdministrationRoleMetadataCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleResult>> => {
      const command =
        reviseOrganizationAdministrationRoleMetadataCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "reviseRoleMetadata",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        return refuseAdministration(
          "reviseRoleMetadata",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }

      return mapRecordedRefusal(
        "reviseRoleMetadata",
        requests.runChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<RoleChangeRow>`
            select outcome, organization_id, role_summary, access_version
            from vortex_access.revise_organization_role_metadata_for_administration(
              ${command.data.roleId}::uuid,
              ${command.data.expectedRoleRevision}::bigint,
              ${command.data.label}::text,
              ${command.data.description}::text,
              ${activityId}::uuid
            )
          `,
          );
          if (isRecordedRefusal(row, row.role_summary, scope.organizationId, scope.accessVersion))
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationRoleResultSchema.safeParse({
            role: row.role_summary,
            accessVersion: databaseRevision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameId(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion ||
            !sameId(parsed.data.role.roleId, command.data.roleId) ||
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
      if (!command.success)
        return refuseAdministration(
          "retireRole",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        return refuseAdministration(
          "retireRole",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }

      return mapRecordedRefusal(
        "retireRole",
        requests.runAccessChange(session, candidate, async (transaction, scope) => {
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
            accessVersion: databaseRevision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameId(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameId(parsed.data.role.roleId, command.data.roleId) ||
            parsed.data.role.liveRevision !== command.data.expectedRoleRevision + 1 ||
            parsed.data.role.lifecycle !== "retired"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    prepareRoleChange: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: PrepareOrganizationAdministrationRoleChangeCommand,
    ): Promise<HumanOrganizationRequestResult<PreparedOrganizationRoleChange>> => {
      const command =
        prepareOrganizationAdministrationRoleChangeCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "prepareRoleChange",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      if (command.data.acceptBroadenedAuthority !== "accept")
        return refuseAdministration(
          "prepareRoleChange",
          "ACCESS_ADMIN_BROADENED_AUTHORITY_NOT_ACCEPTED",
          { kind: "unavailable" } as const,
        );
      let roleId: OrganizationRoleChangeCandidate["roleId"];
      try {
        roleId = roleIdSchema.parse(randomUUID());
      } catch (error) {
        return refuseAdministration(
          "prepareRoleChange",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }
      return requests.run(session, candidate, async (transaction, scope) => {
        const preparation = {
          operation: command.data.operation,
          roleKey: command.data.roleKey,
          label: command.data.label,
          description: command.data.description,
          privilegeClassification: command.data.privilegeClassification,
          acceptBroadenedAuthority: command.data.acceptBroadenedAuthority,
          ...(command.data.permissionReferences === undefined
            ? {}
            : { permissions: command.data.permissionReferences }),
          ...(command.data.templateApplicationRootId === undefined
            ? {}
            : { applicationRootId: command.data.templateApplicationRootId }),
          ...(command.data.sourceRoleId === undefined
            ? {}
            : { sourceRoleId: command.data.sourceRoleId }),
        };
        const row = requireOne(
          await transaction.query<RoleChangePreparationRow>`
            select vortex_access.read_organization_role_change_evidence_for_administration(
              ${JSON.stringify(preparation)}::text::jsonb
            ) as preparation
          `,
        );
        const read = row.preparation as
          | Readonly<{
              outcome?: unknown;
              organizationId?: unknown;
              permissions?: unknown;
              templateContinuityRevision?: unknown;
              templateSource?: unknown;
            }>
          | undefined;
        if (
          read === undefined ||
          read.outcome !== "available" ||
          typeof read.organizationId !== "string" ||
          !sameId(read.organizationId, scope.organizationId) ||
          !Array.isArray(read.permissions)
        )
          throw preparationUnavailable();
        const organizationId = scope.organizationId;
        const permissions = read.permissions as RolePermissionEntry[];
        if (command.data.operation === "create_custom") {
          const roleCandidate: OrganizationRoleChangeCandidate = {
            operation: "create_custom",
            organizationId,
            roleId,
            key: command.data.roleKey,
            label: command.data.label,
            description: command.data.description,
            privilegeClassification: command.data.privilegeClassification,
            assignmentPolicy: { kind: "standing" },
            permissions,
          };
          return sealPreparedRoleChange(roleCandidate);
        }
        const templateContinuityRevision = databaseRevision(read.templateContinuityRevision);
        if (
          typeof templateContinuityRevision !== "number" ||
          command.data.sourceRoleId === undefined
        )
          throw preparationUnavailable();
        const templateCandidate: OrganizationRoleChangeCandidate = {
          operation: "accept_new_application_role",
          organizationId,
          roleId,
          key: command.data.roleKey,
          label: command.data.label,
          description: command.data.description,
          privilegeClassification: command.data.privilegeClassification,
          assignmentPolicy: { kind: "standing" },
          sourceRoleId: command.data.sourceRoleId,
          templateContinuityRevision,
          templateSource: readRoleTemplateSource(read.templateSource),
          permissions,
        };
        return sealPreparedRoleChange(templateCandidate);
      });
    },

    prepareApplicationRoleRevisionAcceptance: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: PrepareOrganizationAdministrationRoleRevisionAcceptanceCommand,
    ): Promise<HumanOrganizationRequestResult<PreparedOrganizationRoleChange>> => {
      const command =
        prepareOrganizationAdministrationRoleRevisionAcceptanceCommandSchema.safeParse(
          commandCandidate,
        );
      if (!command.success)
        return refuseAdministration(
          "prepareApplicationRoleRevisionAcceptance",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      if (command.data.acceptBroadenedAuthority !== "accept")
        return refuseAdministration(
          "prepareApplicationRoleRevisionAcceptance",
          "ACCESS_ADMIN_BROADENED_AUTHORITY_NOT_ACCEPTED",
          { kind: "unavailable" } as const,
        );
      return requests.run(session, candidate, async (transaction, scope) => {
        const preparation = {
          operation: command.data.operation,
          roleId: command.data.roleId,
          expectedRoleRevision: command.data.expectedRoleRevision,
          acceptBroadenedAuthority: command.data.acceptBroadenedAuthority,
        };
        const row = requireOne(
          await transaction.query<RoleChangePreparationRow>`
            select vortex_access.read_organization_role_change_evidence_for_administration(
              ${JSON.stringify(preparation)}::text::jsonb
            ) as preparation
          `,
        );
        const read = row.preparation as
          | Readonly<{
              outcome?: unknown;
              organizationId?: unknown;
              roleConfiguration?: unknown;
              permissions?: unknown;
              templateContinuityRevision?: unknown;
              templateSource?: unknown;
              manifestRequired?: unknown;
              affectedAssignments?: unknown;
            }>
          | undefined;
        if (
          read === undefined ||
          read.outcome !== "available" ||
          typeof read.organizationId !== "string" ||
          !sameId(read.organizationId, scope.organizationId) ||
          typeof read.roleConfiguration !== "object" ||
          read.roleConfiguration === null ||
          Array.isArray(read.roleConfiguration) ||
          !Array.isArray(read.permissions)
        )
          throw preparationUnavailable();

        const roleConfiguration = read.roleConfiguration as Record<string, unknown>;
        const configuredRoleId = roleIdSchema.safeParse(roleConfiguration.roleId);
        const configuredRoleRevision = databaseRevision(roleConfiguration.expectedRoleRevision);
        const templateContinuityRevision = databaseRevision(read.templateContinuityRevision);
        if (
          !configuredRoleId.success ||
          !sameId(configuredRoleId.data, command.data.roleId) ||
          configuredRoleRevision !== command.data.expectedRoleRevision ||
          typeof templateContinuityRevision !== "number"
        )
          throw preparationUnavailable();
        const candidateValue = organizationRoleChangeCandidateSchema.safeParse({
          operation: command.data.operation,
          organizationId: scope.organizationId,
          roleId: command.data.roleId,
          expectedRoleRevision: command.data.expectedRoleRevision,
          key: roleConfiguration.key,
          label: roleConfiguration.label,
          description: roleConfiguration.description,
          privilegeClassification: roleConfiguration.privilegeClassification,
          assignmentPolicy: roleConfiguration.assignmentPolicy,
          sourceRoleId: roleConfiguration.sourceRoleId,
          templateContinuityRevision,
          templateSource: readRoleTemplateSource(read.templateSource),
          permissions: read.permissions,
        });
        if (
          !candidateValue.success ||
          candidateValue.data.operation !== command.data.operation ||
          !sameId(candidateValue.data.roleId, command.data.roleId) ||
          candidateValue.data.expectedRoleRevision !== command.data.expectedRoleRevision
        )
          throw preparationUnavailable();
        let affectedAssignments: AffectedRoleAssignment[] | undefined;
        if (read.manifestRequired === true) {
          const parsedAssignments = z
            .array(affectedRoleAssignmentSchema)
            .safeParse(read.affectedAssignments);
          if (!parsedAssignments.success) throw preparationUnavailable();
          affectedAssignments = parsedAssignments.data;
        } else if (
          read.manifestRequired !== false ||
          (read.affectedAssignments !== undefined && read.affectedAssignments !== null)
        ) {
          throw preparationUnavailable();
        }
        return sealPreparedRoleChange(candidateValue.data, affectedAssignments);
      });
    },

    createCustomRole: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ChangeOrganizationAdministrationRoleAuthorityCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleResult>> =>
      changeRoleAuthority(["create_custom"], session, candidate, commandCandidate),

    createCustomRoleFromTemplate: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ChangeOrganizationAdministrationRoleAuthorityCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleResult>> =>
      changeRoleAuthority(["create_custom_from_template"], session, candidate, commandCandidate),

    acceptApplicationRoleTemplate: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ChangeOrganizationAdministrationRoleAuthorityCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleResult>> =>
      changeRoleAuthority(["accept_new_application_role"], session, candidate, commandCandidate),

    acceptApplicationRoleRevision: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ChangeOrganizationAdministrationRoleAuthorityCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleResult>> =>
      changeRoleAuthority(
        ["accept_application_role_revision"],
        session,
        candidate,
        commandCandidate,
      ),

    listPermissions: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationPermissionsCommand,
    ): Promise<HumanOrganizationRequestResult<ListOrganizationAdministrationPermissionsResult>> => {
      const command =
        listOrganizationAdministrationPermissionsCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "listPermissions",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

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
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion ||
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
          accessVersion: databaseRevision(row.access_version),
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
      if (!command.success)
        return refuseAdministration(
          "readPermission",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

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
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationPermissionResultSchema.parse({
          outcome: row.outcome,
          ...(row.permission_summary === null || row.permission_summary === undefined
            ? {}
            : { permission: row.permission_summary }),
          accessVersion: databaseRevision(row.access_version),
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
      if (!command.success)
        return refuseAdministration(
          "listRoles",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

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
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.roles)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationRolesResultSchema.parse({
          roles: row.roles,
          ...(row.next_after_role_id === null || row.next_after_role_id === undefined
            ? {}
            : { nextAfterRoleId: row.next_after_role_id }),
          accessVersion: databaseRevision(row.access_version),
        });
      });
    },

    readRole: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationRoleCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationAdministrationRoleResult>> => {
      const command = readOrganizationAdministrationRoleCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "readRole",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

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
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationRoleResultSchema.parse({
          outcome: row.outcome,
          ...(row.role_summary === null || row.role_summary === undefined
            ? {}
            : { role: row.role_summary }),
          accessVersion: databaseRevision(row.access_version),
        });
        if (result.outcome === "available" && !sameId(result.role.roleId, command.data.roleId))
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
      if (!command.success)
        return refuseAdministration(
          "listApplicationRoleTemplates",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

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
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion ||
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
          accessVersion: databaseRevision(row.access_version),
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
      if (!command.success)
        return refuseAdministration(
          "readApplicationRoleTemplate",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

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
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationApplicationRoleTemplateResultSchema.parse({
          outcome: row.outcome,
          ...(row.template_summary === null || row.template_summary === undefined
            ? {}
            : { template: row.template_summary }),
          accessVersion: databaseRevision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !sameApplicationRoleTemplateReference(result.template.reference, reference)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },
  };
};
