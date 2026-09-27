import "server-only";

import {
  grantVortexSuperAdministratorCommandSchema,
  identitySessionSchema,
  organizationSelectionCandidateSchema,
  revokeVortexSuperAdministratorCommandSchema,
  vortexSuperAdministratorAssignmentMutationResultSchema,
  vortexSuperAdministratorAssignmentPageSchema,
  vortexSuperAdministratorAssignmentQuerySchema,
  type GrantVortexSuperAdministratorCommand,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type RevokeVortexSuperAdministratorCommand,
  type VortexSuperAdministratorAssignmentMutationResult,
  type VortexSuperAdministratorAssignmentPage,
  type VortexSuperAdministratorAssignmentQuery,
} from "@vortex/contracts";
import type { DatabaseRow } from "@vortex/db";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "./human-organization-request";

type MutationRow = DatabaseRow & {
  outcome: unknown;
  assignment_id: unknown;
  identity_id: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};
type MutationOperation =
  | "grant_vortex_super_administrator"
  | "revoke_vortex_super_administrator";

const timestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const mutation = (
  operation: MutationOperation,
  row: MutationRow | undefined,
): VortexSuperAdministratorAssignmentMutationResult =>
  row === undefined
    ? {
        outcome: "refused",
        operation,
        code: "operation_unavailable",
      }
    : vortexSuperAdministratorAssignmentMutationResultSchema.parse({
        outcome: row.outcome,
        operation,
        assignmentId: row.assignment_id,
        identityId: row.identity_id,
        revision: revision(row.revision),
        correlationId: row.correlation_id,
        acceptedAt: timestamp(row.accepted_at),
      });

export type VortexSuperAdministratorAdministrationDependencies =
  HumanOrganizationRequestDependencies;

/** Runs global assignment commands inside the existing account-bound human request context. */
export const createVortexSuperAdministratorAdministrationService = (
  dependencies: VortexSuperAdministratorAdministrationDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);

  return Object.freeze({
    async list(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      candidate: VortexSuperAdministratorAssignmentQuery,
    ): Promise<HumanOrganizationRequestResult<VortexSuperAdministratorAssignmentPage>> {
      const verifiedSession = identitySessionSchema.safeParse(session);
      const verifiedSelection = organizationSelectionCandidateSchema.safeParse(selection);
      const query = vortexSuperAdministratorAssignmentQuerySchema.safeParse(candidate);
      if (!verifiedSession.success || !verifiedSelection.success || !query.success)
        return { kind: "unavailable" };

      return requests.run(verifiedSession.data, verifiedSelection.data, async (transaction) => {
        const rows = await transaction.query`
          select *
          from vortex_identity.list_vortex_super_administrator_assignments(
            ${query.data.limit + 1}::integer,
            ${query.data.after ?? null}::uuid
          )
        `;
        const entries = rows.slice(0, query.data.limit).map((row) => ({
          assignmentId: row.assignment_id,
          identityId: row.identity_id,
          revision: revision(row.revision),
          grantedAt: timestamp(row.granted_at),
          grantedByKind: row.granted_by_kind,
          grantedById: row.granted_by_id,
          changedAt: timestamp(row.changed_at),
          changedByKind: row.changed_by_kind,
          changedById: row.changed_by_id,
          grantCorrelationId: row.grant_correlation_id,
          changeCorrelationId: row.change_correlation_id,
          ...(row.revoked_at == null ? {} : { revokedAt: timestamp(row.revoked_at) }),
          ...(row.revoked_by_kind == null ? {} : { revokedByKind: row.revoked_by_kind }),
          ...(row.revoked_by_id == null ? {} : { revokedById: row.revoked_by_id }),
          ...(row.revocation_correlation_id == null
            ? {}
            : { revocationCorrelationId: row.revocation_correlation_id }),
        }));
        return vortexSuperAdministratorAssignmentPageSchema.parse({
          entries,
          ...(rows.length > query.data.limit
            ? { next: entries.at(-1)?.assignmentId }
            : {}),
        });
      });
    },

    async grant(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      candidate: GrantVortexSuperAdministratorCommand,
    ): Promise<HumanOrganizationRequestResult<VortexSuperAdministratorAssignmentMutationResult>> {
      const verifiedSession = identitySessionSchema.safeParse(session);
      const verifiedSelection = organizationSelectionCandidateSchema.safeParse(selection);
      const command = grantVortexSuperAdministratorCommandSchema.safeParse(candidate);
      if (!verifiedSession.success || !verifiedSelection.success || !command.success)
        return {
          kind: "available",
          value: {
            outcome: "refused",
            operation: "grant_vortex_super_administrator",
            code: "invalid_command",
          },
        };

      return requests.runChange(
        verifiedSession.data,
        verifiedSelection.data,
        async (transaction) => {
          const value = command.data;
          const rows = await transaction.query<MutationRow>`
            select *
            from vortex_identity.grant_vortex_super_administrator(
              ${value.duplicateKey}::uuid, ${value.identityId}::uuid
            )
          `;
          return mutation("grant_vortex_super_administrator", rows.length === 1 ? rows[0] : undefined);
        },
      );
    },

    async revoke(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      candidate: RevokeVortexSuperAdministratorCommand,
    ): Promise<HumanOrganizationRequestResult<VortexSuperAdministratorAssignmentMutationResult>> {
      const verifiedSession = identitySessionSchema.safeParse(session);
      const verifiedSelection = organizationSelectionCandidateSchema.safeParse(selection);
      const command = revokeVortexSuperAdministratorCommandSchema.safeParse(candidate);
      if (!verifiedSession.success || !verifiedSelection.success || !command.success)
        return {
          kind: "available",
          value: {
            outcome: "refused",
            operation: "revoke_vortex_super_administrator",
            code: "invalid_command",
          },
        };

      return requests.runChange(
        verifiedSession.data,
        verifiedSelection.data,
        async (transaction) => {
          const value = command.data;
          const rows = await transaction.query<MutationRow>`
            select *
            from vortex_identity.revoke_vortex_super_administrator(
              ${value.duplicateKey}::uuid, ${value.assignmentId}::uuid,
              ${value.expectedRevision}::bigint
            )
          `;
          return mutation("revoke_vortex_super_administrator", rows.length === 1 ? rows[0] : undefined);
        },
      );
    },
  });
};
