import "server-only";

import { randomUUID } from "node:crypto";
import {
  activityIdSchema,
  changeOrganizationDirectRecordShareResultSchema,
  directShareIdSchema,
  grantOrganizationDirectRecordShareCommandSchema,
  revokeOrganizationDirectRecordShareCommandSchema,
  type ChangeOrganizationDirectRecordShareResult,
  type GrantOrganizationDirectRecordShareCommand,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type RevokeOrganizationDirectRecordShareCommand,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "./human-organization-request";

/**
 * A server-owned binding to operation-specific SQL. Its implementation fixes
 * the record declarations, physical row adapter and private writer. Request
 * data never selects a permission, decision, field ceiling or database helper.
 */
export interface FixedOrganizationDirectRecordShareAdapter {
  grant(
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    command: GrantOrganizationDirectRecordShareCommand,
    generated: Readonly<{ directShareId: string; activityId: string }>,
  ): Promise<unknown>;
  revoke(
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    command: RevokeOrganizationDirectRecordShareCommand,
    generated: Readonly<{ activityId: string }>,
  ): Promise<unknown>;
}

export type OrganizationDirectRecordShareDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    adapter: FixedOrganizationDirectRecordShareAdapter;
    directShareId?: () => string;
    activityId?: () => string;
  }>;

export const createOrganizationDirectRecordShareService = (
  dependencies: OrganizationDirectRecordShareDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newDirectShareId = dependencies.directShareId ?? randomUUID;
  const newActivityId = dependencies.activityId ?? randomUUID;

  return Object.freeze({
    grant: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationDirectRecordShareResult>> => {
      const command = grantOrganizationDirectRecordShareCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let directShareId: string;
      let activityId: string;
      try {
        directShareId = directShareIdSchema.parse(newDirectShareId());
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }
      return requests.runChange(session, candidate, async (transaction, scope) =>
        changeOrganizationDirectRecordShareResultSchema.parse(
          await dependencies.adapter.grant(transaction, scope, command.data, {
            directShareId,
            activityId,
          }),
        ),
      );
    },
    revoke: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationDirectRecordShareResult>> => {
      const command = revokeOrganizationDirectRecordShareCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }
      return requests.runChange(session, candidate, async (transaction, scope) =>
        changeOrganizationDirectRecordShareResultSchema.parse(
          await dependencies.adapter.revoke(transaction, scope, command.data, { activityId }),
        ),
      );
    },
  });
};
