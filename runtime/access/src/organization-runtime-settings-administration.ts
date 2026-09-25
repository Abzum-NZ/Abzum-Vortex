import "server-only";

import { randomUUID } from "node:crypto";
import {
  activityIdSchema,
  applicationRootIdSchema,
  identitySessionSchema,
  organizationRuntimeSettingsSchema,
  organizationSelectionCandidateSchema,
  type IdentitySession,
  type ApplicationRootId,
  type OrganizationId,
  type OrganizationRuntimeSettings,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "./human-organization-request";

export interface UpdateOrganizationRuntimeSettingsCommand {
  readonly expectedRevision: number;
  readonly settings: OrganizationRuntimeSettings;
}

/**
 * Sets, changes or clears the organisation default application. A null
 * `defaultApplicationRootId` clears it so the organisation address falls back
 * to the permitted launcher.
 */
export interface SetOrganizationDefaultApplicationCommand {
  readonly expectedRevision: number;
  readonly defaultApplicationRootId: ApplicationRootId | null;
}

export interface OrganizationDefaultApplication {
  readonly organizationId: OrganizationId;
  readonly defaultApplicationRootId: ApplicationRootId | null;
  readonly revision: number;
}

export type OrganizationRuntimeSettingsAdministrationDependencies =
  HumanOrganizationRequestDependencies &
    Readonly<{
      activityId?: () => string;
    }>;

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
type DefaultApplicationRow = DatabaseRow & { default_application_root_id: unknown };
type DefaultApplicationChangeRow = DatabaseRow & {
  organization_id: unknown;
  default_application_root_id: unknown;
  revision: unknown;
  changed: unknown;
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

/** The request context fixes the organisation; the application still needs its own Access check. */
export const readCurrentOrganizationDefaultApplicationAfterAuthorization = async (
  transaction: RequestDatabaseTransaction,
): Promise<ApplicationRootId | null> => {
  const rows = await transaction.query<DefaultApplicationRow>`
    select vortex_access.read_current_organization_default_application_for_application()
      as default_application_root_id
  `;
  if (rows.length !== 1 || rows[0] === undefined) throw unavailable();
  const value = rows[0].default_application_root_id;
  if (value === null) return null;
  const parsed = applicationRootIdSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  return parsed.data;
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

const parseDefaultApplicationCommand = (
  candidate: SetOrganizationDefaultApplicationCommand,
): SetOrganizationDefaultApplicationCommand | undefined => {
  if (
    !Number.isSafeInteger(candidate.expectedRevision) ||
    candidate.expectedRevision < 1 ||
    candidate.expectedRevision > Number.MAX_SAFE_INTEGER
  )
    return undefined;
  if (candidate.defaultApplicationRootId === null)
    return { expectedRevision: candidate.expectedRevision, defaultApplicationRootId: null };
  const application = applicationRootIdSchema.safeParse(candidate.defaultApplicationRootId);
  if (!application.success) return undefined;
  return {
    expectedRevision: candidate.expectedRevision,
    defaultApplicationRootId: application.data,
  };
};

/**
 * The settings object is contract-validated here, before the protected
 * request-role operation, which takes the values as arguments. SQL repeats the
 * shape, currency and format checks but not exact BCP-47 or pinned IANA zone
 * validation, so every value must reach it only through this contract check.
 * No separate staging call precedes it.
 */
export const createOrganizationRuntimeSettingsAdministrationService = (
  dependencies: OrganizationRuntimeSettingsAdministrationDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newActivityId = dependencies.activityId ?? randomUUID;

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

      return requests.runChange(session.data, selection.data, async (transaction, scope) => {
        if (!sameUuid(command.settings.organizationId, scope.organizationId)) throw unavailable();
        const rows = await transaction.query<UpdateRow>`
          select organization_id, settings
          from vortex_access.update_organization_runtime_settings_for_administration(
            ${command.expectedRevision}::bigint,
            ${command.settings.language}::text,
            ${command.settings.timeZone}::text,
            ${command.settings.currency}::text,
            ${command.settings.dateFormat}::text,
            ${command.settings.numberFormat}::text
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
      });
    },

    /**
     * Sets, changes or clears the organisation default application. The SQL
     * operation derives authority and organisation from the validated request
     * context and accepts only an exact active installed application of that
     * organisation; nothing in the command can choose another organisation.
     */
    async setDefaultApplication(
      sessionCandidate: IdentitySession,
      selectionCandidate: OrganizationSelectionCandidate,
      commandCandidate: SetOrganizationDefaultApplicationCommand,
    ): Promise<HumanOrganizationRequestResult<OrganizationDefaultApplication>> {
      const session = identitySessionSchema.safeParse(sessionCandidate);
      const selection = organizationSelectionCandidateSchema.safeParse(selectionCandidate);
      const command = parseDefaultApplicationCommand(commandCandidate);
      if (!session.success || !selection.success || command === undefined)
        return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }

      return requests.runChange(session.data, selection.data, async (transaction, scope) => {
        const rows = await transaction.query<DefaultApplicationChangeRow>`
          select organization_id, default_application_root_id, revision, changed
          from vortex_access.set_organization_default_application_for_administration(
            ${command.defaultApplicationRootId}::uuid,
            ${command.expectedRevision}::bigint,
            ${activityId}::uuid
          )
        `;
        if (
          rows.length !== 1 ||
          rows[0] === undefined ||
          !sameUuid(String(rows[0].organization_id), scope.organizationId)
        )
          throw unavailable();
        const changed = rows[0].changed;
        const nextRevision = revision(rows[0].revision);
        if (
          typeof changed !== "boolean" ||
          typeof nextRevision !== "number" ||
          (changed && nextRevision !== command.expectedRevision + 1) ||
          (!changed && nextRevision !== command.expectedRevision)
        )
          throw unavailable();
        const value = rows[0].default_application_root_id;
        if (value === null) {
          if (command.defaultApplicationRootId !== null) throw unavailable();
          return {
            organizationId: scope.organizationId,
            defaultApplicationRootId: null,
            revision: nextRevision,
          };
        }
        const parsed = applicationRootIdSchema.safeParse(value);
        if (
          !parsed.success ||
          command.defaultApplicationRootId === null ||
          !sameUuid(parsed.data, command.defaultApplicationRootId)
        )
          throw unavailable();
        return {
          organizationId: scope.organizationId,
          defaultApplicationRootId: parsed.data,
          revision: nextRevision,
        };
      });
    },
  });
};
