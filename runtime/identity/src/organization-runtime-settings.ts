import "server-only";

import {
  organizationRuntimeSettingsSchema,
  type OrganizationRuntimeSettings,
} from "@vortex/contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";

export const organizationRuntimeSettingsErrorCodes = [
  "INVALID_ORGANIZATION_RUNTIME_SETTINGS",
  "ORGANIZATION_RUNTIME_SETTINGS_STORAGE_UNAVAILABLE",
] as const;

export type OrganizationRuntimeSettingsErrorCode =
  (typeof organizationRuntimeSettingsErrorCodes)[number];

export class OrganizationRuntimeSettingsError extends Error {
  readonly code: OrganizationRuntimeSettingsErrorCode;

  constructor(code: OrganizationRuntimeSettingsErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationRuntimeSettingsError";
    this.code = code;
  }
}

type RuntimeSettingsRow = DatabaseRow & {
  organization_id: unknown;
  language: unknown;
  time_zone: unknown;
  currency: unknown;
  date_format: unknown;
  number_format: unknown;
  revision: unknown;
};

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

export interface OrganizationRuntimeSettingsStoreDependencies {
  readonly runtimeTransaction?: RuntimeTransactionRunner;
}

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const parseRow = (row: RuntimeSettingsRow): OrganizationRuntimeSettings =>
  organizationRuntimeSettingsSchema.parse({
    organizationId: row.organization_id,
    language: row.language,
    timeZone: row.time_zone,
    currency: row.currency,
    dateFormat: row.date_format,
    numberFormat: row.number_format,
    revision: revision(row.revision),
  });

const requireOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new OrganizationRuntimeSettingsError("ORGANIZATION_RUNTIME_SETTINGS_STORAGE_UNAVAILABLE");
  return rows[0];
};

const mapError = (error: unknown): OrganizationRuntimeSettingsError => {
  if (error instanceof OrganizationRuntimeSettingsError) return error;
  return new OrganizationRuntimeSettingsError("ORGANIZATION_RUNTIME_SETTINGS_STORAGE_UNAVAILABLE");
};

/**
 * Identity-owned adapter for trusted setup and trusted runtime staging. The
 * request-role reader belongs to Access, which owns that protected boundary.
 */
export const createOrganizationRuntimeSettingsStore = (
  dependencies: OrganizationRuntimeSettingsStoreDependencies = {},
) => {
  const runtimeTransaction = dependencies.runtimeTransaction ?? withRuntimeTransaction;

  return Object.freeze({
    async initialize(
      settingsCandidate: OrganizationRuntimeSettings,
    ): Promise<OrganizationRuntimeSettings> {
      const settings = organizationRuntimeSettingsSchema.safeParse(settingsCandidate);
      if (!settings.success || settings.data.revision !== 1)
        throw new OrganizationRuntimeSettingsError("INVALID_ORGANIZATION_RUNTIME_SETTINGS");
      try {
        return await runtimeTransaction(async (transaction) => {
          const rows = await transaction.query<RuntimeSettingsRow>`
            select *
            from vortex_identity.initialize_organization_runtime_settings(
              ${settings.data.organizationId}::uuid,
              ${settings.data.language}::text,
              ${settings.data.timeZone}::text,
              ${settings.data.currency}::text,
              ${settings.data.dateFormat}::text,
              ${settings.data.numberFormat}::text
            )
          `;
          return parseRow(requireOne(rows));
        });
      } catch (error) {
        throw mapError(error);
      }
    },

    async stageUpdate(
      transaction: RuntimeDatabaseTransaction,
      settingsCandidate: OrganizationRuntimeSettings,
    ): Promise<void> {
      const settings = organizationRuntimeSettingsSchema.safeParse(settingsCandidate);
      if (!settings.success)
        throw new OrganizationRuntimeSettingsError("INVALID_ORGANIZATION_RUNTIME_SETTINGS");
      try {
        await transaction.query`
          select vortex_identity.stage_organization_runtime_settings_update(
            ${JSON.stringify(settings.data)}::text::jsonb
          )
        `;
      } catch (error) {
        throw mapError(error);
      }
    },
  });
};

const defaultStore = createOrganizationRuntimeSettingsStore();

export const initializeOrganizationRuntimeSettings = defaultStore.initialize;
export const stageOrganizationRuntimeSettingsUpdate = defaultStore.stageUpdate;
