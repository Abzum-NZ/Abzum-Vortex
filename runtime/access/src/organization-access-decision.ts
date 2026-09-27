import "server-only";

import {
  unavailableError,
  databaseTimestamp,
  databaseRevision,
  sameId,
  organizationAccessDecisionSchema,
  organizationAccessDeclarationSchema,
  organizationPermissionEligibilitySchema,
  safeOrganizationAccessRefusal,
  selectedOrganizationScopeSchema,
  type OrganizationAccessDeclaration,
  type OrganizationAccessDecision,
  type OrganizationPermissionEligibility,
  type SafeOrganizationAccessRefusal,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

const unavailableCode = "ORGANIZATION_ACCESS_DECISION_UNAVAILABLE";

type AllowedOrganizationAccessDecision = Extract<
  OrganizationAccessDecision,
  Readonly<{ outcome: "allowed" }>
>;

export type OrganizationAccessOperationResult<Result> =
  Readonly<{ outcome: "completed"; value: Result }> | SafeOrganizationAccessRefusal;

type EligibilityRow = DatabaseRow & {
  outcome: unknown;
  operation_key: unknown;
  target_kind: unknown;
  target_application_root_id: unknown;
  organization_id: unknown;
  organization_account_id: unknown;
  access_version: unknown;
  checked_at: unknown;
  valid_until: unknown;
  correlation_id: unknown;
  reason_code: unknown;
};

const parseEligibility = (rows: readonly EligibilityRow[]): OrganizationPermissionEligibility => {
  if (rows.length !== 1 || rows[0] === undefined) throw unavailableError(unavailableCode);
  const row = rows[0];
  const target =
    row.target_kind === "application"
      ? { kind: "application", applicationRootId: row.target_application_root_id }
      : { kind: row.target_kind };
  if (
    (row.target_kind === "organization" && row.target_application_root_id !== null) ||
    (row.target_kind === "application" && row.target_application_root_id === null)
  )
    throw unavailableError(unavailableCode);

  const evidence = {
    operationKey: row.operation_key,
    target,
    organizationId: row.organization_id,
    organizationAccountId: row.organization_account_id,
    accessVersion: databaseRevision(row.access_version),
    checkedAt: databaseTimestamp(row.checked_at),
    correlationId: row.correlation_id,
  };
  const candidate =
    row.outcome === "eligible"
      ? {
          ...evidence,
          outcome: row.outcome,
          validUntil: databaseTimestamp(row.valid_until),
        }
      : {
          ...evidence,
          outcome: row.outcome,
          reasonCode: row.reason_code,
        };
  if (
    (row.outcome === "eligible" && row.reason_code !== null) ||
    (row.outcome === "refused" && row.valid_until !== null)
  )
    throw unavailableError(unavailableCode);

  const parsed = organizationPermissionEligibilitySchema.safeParse(candidate);
  if (!parsed.success) throw unavailableError(unavailableCode);
  return parsed.data;
};

const sameTarget = (
  left: OrganizationPermissionEligibility["target"],
  right: OrganizationAccessDeclaration["target"],
): boolean =>
  left.kind === right.kind &&
  (left.kind === "organization" ||
    (right.kind === "application" && sameId(left.applicationRootId, right.applicationRootId)));

const isBoundToRequest = (
  eligibility: OrganizationPermissionEligibility,
  scope: SelectedOrganizationScope,
  declaration: OrganizationAccessDeclaration,
): boolean =>
  eligibility.operationKey === declaration.operationKey &&
  sameTarget(eligibility.target, declaration.target) &&
  sameId(eligibility.organizationId, scope.organizationId) &&
  sameId(eligibility.organizationAccountId, scope.organizationAccountId) &&
  eligibility.accessVersion === scope.accessVersion;

export const runOrganizationAccessOperation = async <Result>(
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  declarationCandidate: OrganizationAccessDeclaration,
  operation: (decision: AllowedOrganizationAccessDecision) => Promise<Result>,
): Promise<OrganizationAccessOperationResult<Result>> => {
  const declaration = organizationAccessDeclarationSchema.safeParse(declarationCandidate);
  const resolvedScope = selectedOrganizationScopeSchema.safeParse(scope);
  if (!declaration.success || !resolvedScope.success) throw unavailableError(unavailableCode);

  let rows: readonly EligibilityRow[];
  try {
    rows = await transaction.query<EligibilityRow>`
      select outcome, operation_key, target_kind, target_application_root_id,
        organization_id, organization_account_id, access_version, checked_at,
        valid_until, correlation_id, reason_code
      from vortex_access.evaluate_organization_permission_eligibility(
        ${JSON.stringify(declaration.data)}::text::jsonb
      )
    `;
  } catch {
    throw unavailableError(unavailableCode);
  }

  const eligibility = parseEligibility(rows);
  if (!isBoundToRequest(eligibility, resolvedScope.data, declaration.data))
    throw unavailableError(unavailableCode);
  if (
    declaration.data.target.kind === "application" &&
    (resolvedScope.data.applicationRootId === undefined ||
      !sameId(resolvedScope.data.applicationRootId, declaration.data.target.applicationRootId))
  )
    throw unavailableError(unavailableCode);
  if (eligibility.outcome === "refused") return safeOrganizationAccessRefusal(eligibility);

  const decision = organizationAccessDecisionSchema.safeParse({
    ...eligibility,
    outcome: "allowed",
  });
  if (!decision.success || decision.data.outcome !== "allowed")
    throw unavailableError(unavailableCode);
  try {
    return { outcome: "completed", value: await operation(decision.data) };
  } catch {
    throw unavailableError(unavailableCode);
  }
};
