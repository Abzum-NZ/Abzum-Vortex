import "server-only";

import {
  initialOperatingRoleGrantManifestSchema,
  initialOperatingRoleGrantResultSchema,
  type InitialOperatingRoleGrantManifest,
  type InitialOperatingRoleGrantResult,
} from "@vortex/contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

export interface InitialOperatingRoleGrantDependencies {
  /** Server-only runtime transaction; browser request transactions are never accepted. */
  readonly runtimeTransaction?: RuntimeTransactionRunner;
}

export const initialOperatingRoleGrantErrorCodes = [
  "INVALID_INITIAL_OPERATING_ROLE_GRANT_MANIFEST",
  "INITIAL_OPERATING_ROLE_GRANT_SCOPE_UNAVAILABLE",
  "INITIAL_OPERATING_ROLE_GRANT_ALREADY_ESTABLISHED",
  "INITIAL_OPERATING_ROLE_GRANT_STALE",
  "INITIAL_OPERATING_ROLE_GRANT_VERSION_EXHAUSTED",
  "INITIAL_OPERATING_ROLE_GRANT_STORAGE_RESULT_INVALID",
  "INITIAL_OPERATING_ROLE_GRANT_FAILED",
] as const;

export type InitialOperatingRoleGrantErrorCode =
  (typeof initialOperatingRoleGrantErrorCodes)[number];

export class InitialOperatingRoleGrantError extends Error {
  readonly code: InitialOperatingRoleGrantErrorCode;

  constructor(code: InitialOperatingRoleGrantErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "InitialOperatingRoleGrantError";
    this.code = code;
  }
}

export interface InitialOperatingRoleGrant {
  /**
   * Applies the frozen first-owner manifest once. An exact retry of the original
   * manifest replays the stored result; any other manifest is refused.
   */
  establish(
    manifest: InitialOperatingRoleGrantManifest,
  ): Promise<InitialOperatingRoleGrantResult>;
}

type GrantRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  operating_role_id: unknown;
  operating_role_revision: unknown;
  role_assignment_id: unknown;
  role_assignment_revision: unknown;
  management_application_root_id: unknown;
  management_application_release_revision: unknown;
  management_required_role_revision: unknown;
  setup_revision: unknown;
  access_version: unknown;
  correlation_id: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const fail = (
  code: InitialOperatingRoleGrantErrorCode,
  cause?: unknown,
): InitialOperatingRoleGrantError =>
  new InitialOperatingRoleGrantError(code, cause === undefined ? undefined : { cause });

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapStorageFailure = (error: unknown): InitialOperatingRoleGrantError => {
  switch (databaseCode(error)) {
    case "22023":
      return fail("INVALID_INITIAL_OPERATING_ROLE_GRANT_MANIFEST", error);
    case "42501":
      return fail("INITIAL_OPERATING_ROLE_GRANT_SCOPE_UNAVAILABLE", error);
    case "23505":
      return fail("INITIAL_OPERATING_ROLE_GRANT_ALREADY_ESTABLISHED", error);
    case "40001":
      return fail("INITIAL_OPERATING_ROLE_GRANT_STALE", error);
    case "22003":
      return fail("INITIAL_OPERATING_ROLE_GRANT_VERSION_EXHAUSTED", error);
    default:
      return fail("INITIAL_OPERATING_ROLE_GRANT_FAILED", error);
  }
};

const parseResult = (
  rows: readonly GrantRow[],
  manifest: InitialOperatingRoleGrantManifest,
): InitialOperatingRoleGrantResult => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw fail("INITIAL_OPERATING_ROLE_GRANT_STORAGE_RESULT_INVALID");
  const row = rows[0];
  const parsed = initialOperatingRoleGrantResultSchema.safeParse({
    outcome: row.outcome,
    organizationId: row.organization_id,
    operatingRoleId: row.operating_role_id,
    operatingRoleRevision: revision(row.operating_role_revision),
    roleAssignmentId: row.role_assignment_id,
    roleAssignmentRevision: revision(row.role_assignment_revision),
    managementApplicationRootId: row.management_application_root_id,
    managementApplicationReleaseRevision: revision(
      row.management_application_release_revision,
    ),
    managementRequiredRoleRevision: revision(row.management_required_role_revision),
    setupRevision: revision(row.setup_revision),
    accessVersion: revision(row.access_version),
    correlationId: row.correlation_id,
  });
  if (!parsed.success) throw fail("INITIAL_OPERATING_ROLE_GRANT_STORAGE_RESULT_INVALID");

  const evidenceRoleId = manifest.operatingRoleChangeEvidence.candidate.roleId;
  if (
    !sameUuid(parsed.data.organizationId, manifest.organizationId) ||
    !sameUuid(parsed.data.operatingRoleId, evidenceRoleId) ||
    !sameUuid(parsed.data.roleAssignmentId, manifest.roleAssignmentId) ||
    !sameUuid(parsed.data.managementApplicationRootId, manifest.applicationRootId) ||
    !sameUuid(parsed.data.correlationId, manifest.correlationId) ||
    parsed.data.managementApplicationReleaseRevision !== manifest.applicationReleaseRevision ||
    parsed.data.setupRevision !== manifest.setupRevision
  )
    throw fail("INITIAL_OPERATING_ROLE_GRANT_STORAGE_RESULT_INVALID");

  return parsed.data;
};

/**
 * The Access-owned first-owner setup operation. It runs only on the trusted
 * server runtime connection; the database refuses every browser/request role, so
 * there is no callable grant endpoint and no raw helper exposure.
 */
export const createInitialOperatingRoleGrantService = (
  dependencies: InitialOperatingRoleGrantDependencies = {},
): InitialOperatingRoleGrant => {
  const run = dependencies.runtimeTransaction ?? withRuntimeTransaction;

  return Object.freeze({
    async establish(manifestCandidate: InitialOperatingRoleGrantManifest) {
      const manifest = initialOperatingRoleGrantManifestSchema.safeParse(manifestCandidate);
      if (!manifest.success) throw fail("INVALID_INITIAL_OPERATING_ROLE_GRANT_MANIFEST");

      try {
        return await run(async (transaction) => {
          const rows = await transaction.query<GrantRow>`
            select *
            from vortex_access.compose_initial_operating_role_grant(
              ${JSON.stringify(manifest.data)}::text::jsonb
            )
          `;
          return parseResult(rows, manifest.data);
        });
      } catch (error) {
        if (error instanceof InitialOperatingRoleGrantError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
};

const defaultService = createInitialOperatingRoleGrantService();
export const establishInitialOperatingRoleGrant = defaultService.establish;
