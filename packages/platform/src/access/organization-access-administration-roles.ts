import "server-only";

import { z } from "zod";
import { maximumApplicationRoles } from "../definition/application-contracts";

import { randomUUID } from "node:crypto";
import { activityIdSchema, roleIdSchema } from "../catalogue/identifiers";
import { databaseRevision, sameId } from "../catalogue/runtime-primitives";
import type { IdentitySession, OrganizationSelectionCandidate } from "./identity-access";
import {
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  changeOrganizationAdministrationRoleResultSchema,
  readOrganizationAdministrationRoleCommandSchema,
  readOrganizationAdministrationRoleResultSchema,
  prepareOrganizationAdministrationRoleChangeCommandSchema,
  prepareOrganizationAdministrationRoleRevisionAcceptanceCommandSchema,
  retireOrganizationAdministrationRoleCommandSchema,
  reviseOrganizationAdministrationRoleMetadataCommandSchema,
  type ChangeOrganizationAdministrationRoleAuthorityCommand,
  type ChangeOrganizationAdministrationRoleResult,
  type PrepareOrganizationAdministrationRoleChangeCommand,
  type PrepareOrganizationAdministrationRoleRevisionAcceptanceCommand,
  type ReadOrganizationAdministrationRoleCommand,
  type ReadOrganizationAdministrationRoleResult,
  type RetireOrganizationAdministrationRoleCommand,
  type ReviseOrganizationAdministrationRoleMetadataCommand,
} from "./organization-access-administration";
import {
  affectedRoleAssignmentSchema,
  type AffectedRoleAssignment,
  type RolePermissionEntry,
} from "./organization-access-catalogue";
import {
  organizationRoleChangeCandidateSchema,
  type OrganizationRoleChangeCandidate,
  type PreparedOrganizationRoleChange,
} from "./organization-role-changes";
import type { HumanOrganizationRequestResult } from "./human-organization-request";
import {
  prepareOrganizationRoleChangeEvidence,
  verifyPreparedOrganizationRoleChangeEvidence,
} from "./organization-role-change-evidence";
import {
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
  RoleDetailRow,
  RoleChangeRow,
  RoleChangePreparationRow,
  AccessAdministrationContext,
} from "./organization-access-administration-shared";

/** One role as the protected roles projection shows it, with the facts a grant needs. */
const projectedRoleSchema = z.object({
  organization_id: z.string(),
  record_id: roleIdSchema,
  revision: z.preprocess(databaseRevision, z.number().int().min(1)),
  attribute_values: z
    .object({
      key: z.string(),
      label: z.string(),
      lifecycle: z.enum(["active", "acceptance_required", "unavailable", "retired"]),
      assignment_policy: z.enum(["standing", "activation_required"]),
    })
    .loose(),
});

type ProjectedOrganizationRole = Readonly<{
  roleId: string;
  key: string;
  label: string;
  liveRevision: number;
  lifecycle: z.infer<typeof projectedRoleSchema>["attribute_values"]["lifecycle"];
  assignmentPolicy: z.infer<typeof projectedRoleSchema>["attribute_values"]["assignment_policy"];
}>;

const projectedPageSize = 200;

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
  const changeRolesAuthority = async (
    expectedOperations: readonly PreparedOrganizationRoleChange["candidate"]["operation"][],
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate,
    commandCandidates: readonly ChangeOrganizationAdministrationRoleAuthorityCommand[],
  ): Promise<
    HumanOrganizationRequestResult<readonly ChangeOrganizationAdministrationRoleResult[]>
  > => {
    const commands = z
      .array(changeOrganizationAdministrationRoleAuthorityCommandSchema)
      .min(1)
      .max(maximumApplicationRoles)
      .safeParse(commandCandidates);
    if (!commands.success)
      return refuseAdministration(
        "changeRoleAuthority",
        "ACCESS_ADMIN_COMMAND_INVALID",
        { kind: "unavailable" } as const,
        commands.error,
      );
    let changes: { evidence: PreparedOrganizationRoleChange; activityId: string }[];
    try {
      changes = commands.data.map((command) => ({
        evidence: verifyPreparedOrganizationRoleChangeEvidence(command.evidence),
        activityId: activityIdSchema.parse(newActivityId()),
      }));
    } catch (error) {
      return refuseAdministration(
        "changeRoleAuthority",
        "ACCESS_ADMIN_EVIDENCE_REJECTED",
        { kind: "unavailable" } as const,
        error,
      );
    }
    if (changes.some(({ evidence }) => !expectedOperations.includes(evidence.candidate.operation)))
      return refuseAdministration("changeRoleAuthority", "ACCESS_ADMIN_OPERATION_NOT_EXPECTED", {
        kind: "unavailable",
      } as const);
    return requests.runAccessChange(session, candidate, async (transaction, scope) => {
      if (
        changes.some(
          ({ evidence }) => !sameId(evidence.candidate.organizationId, scope.organizationId),
        )
      )
        throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
      const rows = await transaction.query<RoleChangeRow>`
        select outcome, organization_id, role_summary, access_version
        from vortex_access.change_organization_role_authority_for_administration(
          ${JSON.stringify(changes)}::text::jsonb
        )
      `;
      if (rows.length !== changes.length)
        throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
      return rows.map((row, index) => {
        const evidence = changes[index]!.evidence;
        const expectedLiveRevision =
          "expectedRoleRevision" in evidence.candidate
            ? evidence.candidate.expectedRoleRevision + 1
            : 1;
        const parsed = changeOrganizationAdministrationRoleResultSchema.safeParse({
          role: row.role_summary,
          accessVersion: databaseRevision(row.access_version),
        });
        if (
          typeof row.organization_id !== "string" ||
          !sameId(row.organization_id, scope.organizationId) ||
          row.outcome !== "completed" ||
          !parsed.success ||
          parsed.data.accessVersion !== scope.accessVersion + index + 1 ||
          !sameId(parsed.data.role.roleId, evidence.candidate.roleId) ||
          parsed.data.role.liveRevision !== expectedLiveRevision
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return parsed.data;
      });
    });
  };

  const changeRoleAuthority = async (
    expectedOperations: readonly PreparedOrganizationRoleChange["candidate"]["operation"][],
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate,
    command: ChangeOrganizationAdministrationRoleAuthorityCommand,
  ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleResult>> => {
    const result = await changeRolesAuthority(expectedOperations, session, candidate, [command]);
    return result.kind === "available" ? { kind: "available", value: result.value[0]! } : result;
  };

  return {
    /** Accepts the complete reviewed installation role set, or rolls back every acceptance. */
    acceptApplicationRoles: (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commands: readonly ChangeOrganizationAdministrationRoleAuthorityCommand[],
    ) =>
      changeRolesAuthority(
        ["accept_new_application_role", "accept_application_role_revision"],
        session,
        candidate,
        commands,
      ),
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
    ): Promise<
      | HumanOrganizationRequestResult<PreparedOrganizationRoleChange>
      | Readonly<{ kind: "invalid_privilege_classification" }>
    > => {
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
      const result = await requests.run(session, candidate, async (transaction, scope) => {
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
            select vortex_access.read_organization_role_change_for_administration(
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
          read?.outcome === "invalid_privilege_classification" &&
          typeof read.organizationId === "string" &&
          sameId(read.organizationId, scope.organizationId)
        )
          return { kind: "invalid_privilege_classification" } as const;
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
      if (result.kind !== "available") return result;
      if ("kind" in result.value)
        return refuseAdministration(
          "prepareRoleChange",
          "ACCESS_ADMIN_PRIVILEGE_CLASSIFICATION_REQUIRES_PRIVILEGED",
          result.value,
        );
      return { kind: "available", value: result.value };
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
            select vortex_access.read_organization_role_change_for_administration(
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

    /**
     * One keyset page (at most 200, in role id order) of the organisation's roles, read through the
     * protected roles projection under the same role administration scope.
     */
    listRoles: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      afterRoleId: string | undefined,
    ): Promise<HumanOrganizationRequestResult<readonly ProjectedOrganizationRole[]>> =>
      requests.run(session, candidate, async (transaction, scope) => {
        const rows = await transaction.query`
          select organization_id, record_id, revision, attribute_values
          from vortex_access.list_organization_roles_projection(
            null, 'record_id', 'ascending',
            ${afterRoleId === undefined ? null : JSON.stringify({ recordId: afterRoleId })}::jsonb,
            ${projectedPageSize}::integer, null
          )
        `;
        return rows.map((row) => {
          const parsed = projectedRoleSchema.parse(row);
          if (!sameId(parsed.organization_id, scope.organizationId))
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return {
            roleId: parsed.record_id,
            key: parsed.attribute_values.key,
            label: parsed.attribute_values.label,
            liveRevision: parsed.revision,
            lifecycle: parsed.attribute_values.lifecycle,
            assignmentPolicy: parsed.attribute_values.assignment_policy,
          };
        });
      }),

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
  };
};
