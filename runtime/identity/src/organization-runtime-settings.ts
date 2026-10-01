import "server-only";

import {
  databaseRevision,
  organizationRuntimeSettingsSchema,
  type OrganizationRuntimeSettings,
} from "@vortex/contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
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
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

export interface OrganizationRuntimeSettingsStoreDependencies {
  readonly runtimeTransaction?: RuntimeTransactionRunner;
}

const parseRow = (row: RuntimeSettingsRow): OrganizationRuntimeSettings =>
  organizationRuntimeSettingsSchema.parse({
    organizationId: row.organization_id,
    language: row.language,
    timeZone: row.time_zone,
    currency: row.currency,
    dateFormat: row.date_format,
    numberFormat: row.number_format,
    revision: databaseRevision(row.revision),
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
 * Identity-owned adapter for trusted setup. Changes belong to the generic
 * revision-checked organization settings record save.
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
  });
};

const defaultStore = createOrganizationRuntimeSettingsStore();

export const initializeOrganizationRuntimeSettings = defaultStore.initialize;
