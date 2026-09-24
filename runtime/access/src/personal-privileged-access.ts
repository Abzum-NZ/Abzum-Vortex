import "server-only";

import {
  listOwnPrivilegedActivationsCommandSchema,
  listOwnPrivilegedActivationsResultSchema,
  listOwnPrivilegedEligibilityCommandSchema,
  listOwnPrivilegedEligibilityResultSchema,
  type IdentitySession,
  type ListOwnPrivilegedActivationsCommand,
  type ListOwnPrivilegedActivationsResult,
  type ListOwnPrivilegedEligibilityCommand,
  type ListOwnPrivilegedEligibilityResult,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import type { DatabaseRow } from "@vortex/db";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "./human-organization-request";

type EligibilityPageRow = DatabaseRow & {
  organization_id: unknown;
  eligibilities: unknown;
  next_after_role_assignment_id: unknown;
  access_version: unknown;
};

type ActivationPageRow = DatabaseRow & {
  organization_id: unknown;
  activations: unknown;
  next_after_role_activation_id: unknown;
  access_version: unknown;
};

const unavailable = (): Error => {
  const error = new Error("PERSONAL_PRIVILEGED_ACCESS_UNAVAILABLE");
  Object.assign(error, { code: "42501" });
  return error;
};

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const requireOne = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw unavailable();
  return rows[0];
};

const matchesScope = (
  row: { organization_id: unknown; access_version: unknown },
  organizationId: string,
  accessVersion: number,
): boolean =>
  typeof row.organization_id === "string" &&
  sameUuid(row.organization_id, organizationId) &&
  revision(row.access_version) === accessVersion;

/**
 * The viewer's own privileged eligibility and activations. Each protected SQL reader takes the
 * organisation and account from the validated request context, so the command carries neither and
 * no administrator authority is consulted or widened.
 */
export const createPersonalPrivilegedAccessService = (
  dependencies: HumanOrganizationRequestDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);

  return Object.freeze({
    async listOwnPrivilegedEligibility(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: ListOwnPrivilegedEligibilityCommand,
    ): Promise<HumanOrganizationRequestResult<ListOwnPrivilegedEligibilityResult>> {
      const command = listOwnPrivilegedEligibilityCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, selection, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<EligibilityPageRow>`
            select organization_id, eligibilities, next_after_role_assignment_id,
              access_version
            from vortex_access.list_own_privileged_eligible_roles_for_application(
              ${command.data.afterRoleAssignmentId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          !matchesScope(row, scope.organizationId, scope.accessVersion) ||
          !Array.isArray(row.eligibilities)
        )
          throw unavailable();
        return listOwnPrivilegedEligibilityResultSchema.parse({
          eligibilities: row.eligibilities,
          ...(row.next_after_role_assignment_id === null ||
          row.next_after_role_assignment_id === undefined
            ? {}
            : { nextAfterRoleAssignmentId: row.next_after_role_assignment_id }),
          accessVersion: revision(row.access_version),
        });
      });
    },

    async listOwnPrivilegedActivations(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: ListOwnPrivilegedActivationsCommand,
    ): Promise<HumanOrganizationRequestResult<ListOwnPrivilegedActivationsResult>> {
      const command = listOwnPrivilegedActivationsCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, selection, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<ActivationPageRow>`
            select organization_id, activations, next_after_role_activation_id,
              access_version
            from vortex_access.list_own_privileged_active_roles_for_application(
              ${command.data.afterRoleActivationId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          !matchesScope(row, scope.organizationId, scope.accessVersion) ||
          !Array.isArray(row.activations)
        )
          throw unavailable();
        return listOwnPrivilegedActivationsResultSchema.parse({
          activations: row.activations,
          ...(row.next_after_role_activation_id === null ||
          row.next_after_role_activation_id === undefined
            ? {}
            : { nextAfterRoleActivationId: row.next_after_role_activation_id }),
          accessVersion: revision(row.access_version),
        });
      });
    },
  });
};
