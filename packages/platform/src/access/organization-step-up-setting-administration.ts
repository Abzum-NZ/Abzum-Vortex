import "server-only";

import { z } from "zod";
import { activityIdSchema, revisionSchema } from "../catalogue/identifiers";
import { databaseRevision, unavailableError } from "../catalogue/runtime-primitives";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import type { HumanOrganizationRequestResult } from "./human-organization-request";
import type { IdentitySession, OrganizationSelectionCandidate } from "./identity-access";
import type { AccessAdministrationContext } from "./organization-access-administration-shared";
import { refuseAdministration } from "./organization-access-administration-shared";

const unavailableCode = "ORGANIZATION_STEP_UP_SETTING_UNAVAILABLE";

/**
 * The change the organisation's two-step setting is asked to make. The organisation is never an
 * input: the database takes it from the validated request context.
 */
export const changeOrganizationStepUpSettingCommandSchema = z
  .object({
    expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    requireStepUp: z.boolean(),
  })
  .strict();
export type ChangeOrganizationStepUpSettingCommand = z.infer<
  typeof changeOrganizationStepUpSettingCommandSchema
>;

const changeResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.enum(["saved", "unchanged", "conflict"]),
      revision: z.number().int().min(1),
      requireStepUp: z.boolean(),
      accessVersion: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      refusalReason: z.enum([
        "recent_authentication_required",
        "multi_factor_required",
        "development_instance_required",
      ]),
      accessVersion: z.number().int().min(1),
    })
    .strict(),
]);
export type ChangeOrganizationStepUpSettingResult = z.infer<typeof changeResultSchema>;

type ChangeRow = DatabaseRow & { result: unknown };

/** What the Security page and the Verify panel read: one row for the request's organisation. */
export type OrganizationStepUpSetting = Readonly<{
  requireStepUp: boolean;
  revision: number | null;
  changedAt: string | null;
  changedByDisplayName: string | null;
  canChange: boolean;
  canTurnOff: boolean;
}>;

type SettingRow = DatabaseRow & {
  require_step_up: unknown;
  revision: unknown;
  changed_at: unknown;
  changed_by_display_name: unknown;
  can_change: unknown;
  can_turn_off: unknown;
};

/** Reads only the organisation already established by the request context. */
export const readCurrentOrganizationStepUpSettingAfterAuthorization = async (
  transaction: RequestDatabaseTransaction,
): Promise<OrganizationStepUpSetting> => {
  const rows = await transaction.query<SettingRow>`
    select * from vortex_access.read_current_organization_step_up_setting()
  `;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row === undefined ||
    typeof row.require_step_up !== "boolean" ||
    typeof row.can_change !== "boolean" ||
    typeof row.can_turn_off !== "boolean" ||
    (row.changed_by_display_name !== null && typeof row.changed_by_display_name !== "string")
  )
    throw unavailableError(unavailableCode);
  const changedAt =
    row.changed_at === null || row.changed_at === undefined
      ? null
      : new Date(row.changed_at as string | number | Date).toISOString();
  return {
    requireStepUp: row.require_step_up,
    revision: row.revision === null ? null : revisionSchema.parse(databaseRevision(row.revision)),
    changedAt,
    changedByDisplayName: row.changed_by_display_name,
    canChange: row.can_change,
    canTurnOff: row.can_turn_off,
  };
};

/**
 * The change. The trusted entry point reads, for this one request, whether the person has a
 * verified second factor and states it in the request context; when it cannot tell, it leaves the
 * fact out and the database treats the person as enrolled (the code is required).
 */
export const createAccessAdministrationStepUpSettingOperations = ({
  requests,
  newActivityId,
  readSecondFactor,
}: AccessAdministrationContext) => ({
  changeStepUpSetting: async (
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate,
    commandCandidate: ChangeOrganizationStepUpSettingCommand,
  ): Promise<HumanOrganizationRequestResult<ChangeOrganizationStepUpSettingResult>> => {
    const command = changeOrganizationStepUpSettingCommandSchema.safeParse(commandCandidate);
    if (!command.success)
      return refuseAdministration(
        "changeStepUpSetting",
        "ACCESS_ADMIN_COMMAND_INVALID",
        { kind: "unavailable" } as const,
        command.error,
      );
    let activityId: string;
    try {
      activityId = activityIdSchema.parse(newActivityId());
    } catch (error) {
      return refuseAdministration(
        "changeStepUpSetting",
        "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
        { kind: "temporarily_unavailable" } as const,
        error,
      );
    }
    const hasSecondFactor = await readSecondFactor?.();
    const stamped: IdentitySession =
      hasSecondFactor === undefined ? session : { ...session, hasSecondFactor };
    return requests.runAccessChange(stamped, candidate, async (transaction) => {
      const rows = await transaction.query<ChangeRow>`
        select vortex_access.change_current_organization_step_up_setting(
          ${command.data.expectedRevision}::bigint,
          ${command.data.requireStepUp}::boolean,
          ${activityId}::uuid
        ) as result
      `;
      const parsed = changeResultSchema.safeParse(rows[0]?.result);
      if (rows.length !== 1 || !parsed.success) throw unavailableError(unavailableCode);
      return parsed.data;
    });
  },
});
