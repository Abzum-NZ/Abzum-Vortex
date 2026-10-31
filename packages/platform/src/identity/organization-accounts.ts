import "server-only";

import {
  ensureIdentityProjectionCommandSchema,
  identityProjectionSchema,
  verifiedIdentitySchema,
  type EnsureIdentityProjectionCommand,
  type IdentityProjection,
  type VerifiedIdentity,
} from "../access/identity-access";
import { databaseTimestamp, databaseRevision } from "../catalogue/runtime-primitives";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
  type RuntimeTransactionRunner,
} from "../db/request-transaction";

/** @knipignore */
export const organizationAccountErrorCodes = [
  "INVALID_ORGANIZATION_ACCOUNT_COMMAND",
  "INVALID_ORGANIZATION_ACCOUNT_STORAGE_RESULT",
  "ORGANIZATION_ACCOUNT_CONTEXT_REFUSED",
  "ORGANIZATION_ACCOUNT_STALE_OR_UNAVAILABLE",
  "ORGANIZATION_ACCOUNT_OPERATION_FAILED",
] as const;

type OrganizationAccountErrorCode = (typeof organizationAccountErrorCodes)[number];

class OrganizationAccountError extends Error {
  readonly code: OrganizationAccountErrorCode;

  constructor(code: OrganizationAccountErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationAccountError";
    this.code = code;
  }
}

interface OrganizationAccountStoreDependencies {
  readonly runtimeTransaction?: RuntimeTransactionRunner;
}

type IdentityProjectionRow = DatabaseRow & {
  identity_id: unknown;
  state: unknown;
  created_at: unknown;
  state_changed_at: unknown;
  state_changed_by: unknown;
  state_change_correlation_id: unknown;
  revision: unknown;
};

const parseIdentityProjection = (row: IdentityProjectionRow): IdentityProjection =>
  identityProjectionSchema.parse({
    identityId: row.identity_id,
    state: row.state,
    createdAt: databaseTimestamp(row.created_at),
    stateChangedAt: databaseTimestamp(row.state_changed_at),
    stateChangedBy: row.state_changed_by,
    stateChangeCorrelationId: row.state_change_correlation_id,
    revision: databaseRevision(row.revision),
  });

const mapStorageFailure = (error: unknown): OrganizationAccountError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;

  if (databaseCode === "22023" || databaseCode === "23514")
    return new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
  if (databaseCode === "42501")
    return new OrganizationAccountError("ORGANIZATION_ACCOUNT_CONTEXT_REFUSED");
  if (databaseCode === "40001" || databaseCode === "23503" || databaseCode === "23505")
    return new OrganizationAccountError("ORGANIZATION_ACCOUNT_STALE_OR_UNAVAILABLE");
  return new OrganizationAccountError("ORGANIZATION_ACCOUNT_OPERATION_FAILED");
};

const requireOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_STORAGE_RESULT");
  return rows[0];
};

const requireZeroOrOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row | undefined => {
  if (rows.length > 1)
    throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_STORAGE_RESULT");
  return rows[0];
};

const createOrganizationAccountStore = (
  dependencies: OrganizationAccountStoreDependencies = {},
) => {
  const runtimeTransaction = dependencies.runtimeTransaction ?? withRuntimeTransaction;

  return Object.freeze({
    async ensureIdentityProjection(
      verifiedIdentity: VerifiedIdentity,
      command: EnsureIdentityProjectionCommand,
    ): Promise<IdentityProjection> {
      const verified = verifiedIdentitySchema.safeParse(verifiedIdentity);
      const parsed = ensureIdentityProjectionCommandSchema.safeParse(command);
      if (!verified.success || !parsed.success)
        throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");

      try {
        return await runtimeTransaction(async (transaction) => {
          const rows = await transaction.query<IdentityProjectionRow>`
            select *
            from vortex_identity.ensure_identity_projection(
              ${verified.data.identityId}::uuid,
              ${parsed.data.correlationId}::uuid
            )
          `;
          return parseIdentityProjection(requireOne(rows));
        });
      } catch (error) {
        if (error instanceof OrganizationAccountError) throw error;
        throw mapStorageFailure(error);
      }
    },

    async readIdentityProjection(
      verifiedIdentity: VerifiedIdentity,
      openTransaction?: RequestDatabaseTransaction,
    ): Promise<IdentityProjection | undefined> {
      const verified = verifiedIdentitySchema.safeParse(verifiedIdentity);
      if (!verified.success)
        throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");

      try {
        const read = async (transaction: RequestDatabaseTransaction) => {
          const rows = await transaction.query<IdentityProjectionRow>`
            select *
            from vortex_identity.read_identity_projection(${verified.data.identityId}::uuid)
          `;
          const row = requireZeroOrOne(rows);
          return row === undefined ? undefined : parseIdentityProjection(row);
        };
        return await (openTransaction === undefined
          ? runtimeTransaction(read)
          : read(openTransaction));
      } catch (error) {
        if (error instanceof OrganizationAccountError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
};

const defaultStore = createOrganizationAccountStore();

export const ensureIdentityProjection = defaultStore.ensureIdentityProjection;
export const readIdentityProjection = defaultStore.readIdentityProjection;
