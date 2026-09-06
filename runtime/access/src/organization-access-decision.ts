import "server-only";

import {
  organizationAccessDecisionSchema,
  organizationAccessDeclarationSchema,
  organizationPermissionEligibilitySchema,
  safeOrganizationAccessRefusalSchema,
  selectedOrganizationScopeSchema,
  type OrganizationAccessDeclaration,
  type OrganizationAccessDecision,
  type OrganizationPermissionEligibility,
  type SafeOrganizationAccessRefusal,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

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

const unavailable = (): Error => new Error("ORGANIZATION_ACCESS_DECISION_UNAVAILABLE");

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const timestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const parseEligibility = (rows: readonly EligibilityRow[]): OrganizationPermissionEligibility => {
  if (rows.length !== 1 || rows[0] === undefined) throw unavailable();
  const row = rows[0];
  const target =
    row.target_kind === "application"
      ? { kind: "application", applicationRootId: row.target_application_root_id }
      : { kind: row.target_kind };
  if (
    (row.target_kind === "organization" && row.target_application_root_id !== null) ||
    (row.target_kind === "application" && row.target_application_root_id === null)
  )
    throw unavailable();

  const evidence = {
    operationKey: row.operation_key,
    target,
    organizationId: row.organization_id,
    organizationAccountId: row.organization_account_id,
    accessVersion: revision(row.access_version),
    checkedAt: timestamp(row.checked_at),
    correlationId: row.correlation_id,
  };
  const candidate =
    row.outcome === "eligible"
      ? {
          ...evidence,
          outcome: row.outcome,
          validUntil: timestamp(row.valid_until),
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
    throw unavailable();

  const parsed = organizationPermissionEligibilitySchema.safeParse(candidate);
  if (!parsed.success) throw unavailable();
  return parsed.data;
};

const sameTarget = (
  left: OrganizationPermissionEligibility["target"],
  right: OrganizationAccessDeclaration["target"],
): boolean =>
  left.kind === right.kind &&
  (left.kind === "organization" ||
    (right.kind === "application" && sameUuid(left.applicationRootId, right.applicationRootId)));

const isBoundToRequest = (
  eligibility: OrganizationPermissionEligibility,
  scope: SelectedOrganizationScope,
  declaration: OrganizationAccessDeclaration,
): boolean =>
  eligibility.operationKey === declaration.operationKey &&
  sameTarget(eligibility.target, declaration.target) &&
  sameUuid(eligibility.organizationId, scope.organizationId) &&
  sameUuid(eligibility.organizationAccountId, scope.organizationAccountId) &&
  eligibility.accessVersion === scope.accessVersion;

const safeRefusal = (
  refusal: Extract<OrganizationPermissionEligibility, Readonly<{ outcome: "refused" }>>,
): SafeOrganizationAccessRefusal =>
  safeOrganizationAccessRefusalSchema.parse({
    outcome: "refused",
    reasonCode:
      refusal.reasonCode === "authentication_unsatisfied"
        ? "authentication_required"
        : refusal.reasonCode === "target_policy_unavailable"
          ? "target_policy_unavailable"
          : "access_refused",
    correlationId: refusal.correlationId,
  });

export const runOrganizationAccessOperation = async <Result>(
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  declarationCandidate: OrganizationAccessDeclaration,
  operation: (decision: AllowedOrganizationAccessDecision) => Promise<Result>,
): Promise<OrganizationAccessOperationResult<Result>> => {
  const declaration = organizationAccessDeclarationSchema.safeParse(declarationCandidate);
  const resolvedScope = selectedOrganizationScopeSchema.safeParse(scope);
  if (!declaration.success || !resolvedScope.success) throw unavailable();

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
    throw unavailable();
  }

  const eligibility = parseEligibility(rows);
  if (!isBoundToRequest(eligibility, resolvedScope.data, declaration.data)) throw unavailable();
  if (
    declaration.data.target.kind === "application" &&
    (resolvedScope.data.applicationRootId === undefined ||
      !sameUuid(resolvedScope.data.applicationRootId, declaration.data.target.applicationRootId))
  )
    throw unavailable();
  if (eligibility.outcome === "refused") return safeRefusal(eligibility);

  const decision = organizationAccessDecisionSchema.safeParse({
    ...eligibility,
    outcome: "allowed",
  });
  if (!decision.success || decision.data.outcome !== "allowed") throw unavailable();
  try {
    return { outcome: "completed", value: await operation(decision.data) };
  } catch {
    throw unavailable();
  }
};
