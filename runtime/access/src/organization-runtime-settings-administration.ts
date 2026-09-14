import "server-only";

import {
  identitySessionSchema,
  organizationRuntimeSettingsSchema,
  organizationSelectionCandidateSchema,
  type IdentitySession,
  type OrganizationRuntimeSettings,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { stageOrganizationRuntimeSettingsUpdate } from "@vortex/identity";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "./human-organization-request";

export interface UpdateOrganizationRuntimeSettingsCommand {
  readonly expectedRevision: number;
  readonly settings: OrganizationRuntimeSettings;
}

type UpdateRow = DatabaseRow & { organization_id: unknown; settings: unknown };
type ReadRow = DatabaseRow & {
  organization_id: unknown;
  language: unknown;
  time_zone: unknown;
  currency: unknown;
  date_format: unknown;
  number_format: unknown;
  revision: unknown;
};

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const unavailable = (): Error => {
  const error = new Error("ORGANIZATION_RUNTIME_SETTINGS_UNAVAILABLE");
  Object.assign(error, { code: "42501" });
  return error;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

/** Reads only the organisation already established by the request context. */
export const readCurrentOrganizationRuntimeSettingsAfterAuthorization = async (
  transaction: RequestDatabaseTransaction,
): Promise<OrganizationRuntimeSettings | undefined> => {
  const rows = await transaction.query<ReadRow>`
    select * from vortex_access.read_current_organization_runtime_settings_for_application()
  `;
  if (rows.length > 1) throw unavailable();
  const row = rows[0];
  if (row === undefined) return undefined;
  const settings = organizationRuntimeSettingsSchema.safeParse({
    organizationId: row.organization_id,
    language: row.language,
    timeZone: row.time_zone,
    currency: row.currency,
    dateFormat: row.date_format,
    numberFormat: row.number_format,
    revision: revision(row.revision),
  });
  if (!settings.success) throw unavailable();
  return settings.data;
};

const parseCommand = (
  candidate: UpdateOrganizationRuntimeSettingsCommand,
): UpdateOrganizationRuntimeSettingsCommand | undefined => {
  const settings = organizationRuntimeSettingsSchema.safeParse(candidate.settings);
  if (
    !settings.success ||
    !Number.isSafeInteger(candidate.expectedRevision) ||
    candidate.expectedRevision < 1 ||
    candidate.expectedRevision > Number.MAX_SAFE_INTEGER ||
    settings.data.revision !== candidate.expectedRevision
  )
    return undefined;
  return { expectedRevision: candidate.expectedRevision, settings: settings.data };
};

/**
 * The settings object is contract-validated and transaction-bound while still
 * under vortex_runtime. The later request-role operation receives only the
 * revision; it cannot substitute raw setting values through SQL.
 */
export const createOrganizationRuntimeSettingsAdministrationService = (
  dependencies: HumanOrganizationRequestDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);

  return Object.freeze({
    async update(
      sessionCandidate: IdentitySession,
      selectionCandidate: OrganizationSelectionCandidate,
      commandCandidate: UpdateOrganizationRuntimeSettingsCommand,
    ): Promise<HumanOrganizationRequestResult<OrganizationRuntimeSettings>> {
      const session = identitySessionSchema.safeParse(sessionCandidate);
      const selection = organizationSelectionCandidateSchema.safeParse(selectionCandidate);
      const command = parseCommand(commandCandidate);
      if (!session.success || !selection.success || command === undefined)
        return { kind: "unavailable" };

      return requests.runChangePrepared(
        session.data,
        selection.data,
        async (transaction, scope) => {
          if (!sameUuid(command.settings.organizationId, scope.organizationId)) throw unavailable();
          await stageOrganizationRuntimeSettingsUpdate(transaction, command.settings);
        },
        async (transaction, scope) => {
          const rows = await transaction.query<UpdateRow>`
            select organization_id, settings
            from vortex_access.update_organization_runtime_settings_for_administration(
              ${command.expectedRevision}::bigint
            )
          `;
          if (
            rows.length !== 1 ||
            rows[0] === undefined ||
            !sameUuid(String(rows[0].organization_id), scope.organizationId)
          )
            throw unavailable();
          const settings = organizationRuntimeSettingsSchema.safeParse(rows[0].settings);
          if (!settings.success || settings.data.revision !== command.expectedRevision + 1)
            throw unavailable();
          return settings.data;
        },
      );
    },
  });
};
