import "server-only";

import {
  databaseRevision,
  databaseTimestamp,
  sameId,
  unavailableError,
  organizationRecordAccessDeclarationSchema,
  organizationRecordPermissionEligibilitySchema,
  safeOrganizationAccessRefusal,
  selectedOrganizationScopeSchema,
  type OrganizationRecordAccessDeclaration,
  type OrganizationRecordPermissionEligibility,
  type SafeOrganizationAccessRefusal,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

const unavailableCode = "ORGANIZATION_RECORD_PERMISSION_AVAILABILITY_UNAVAILABLE";

/** Permission availability only: no row identity, final access decision or operation callback. */
export type OrganizationRecordPermissionAvailability =
  | Readonly<{ outcome: "eligible"; correlationId: string; validUntil: string }>
  | SafeOrganizationAccessRefusal;

type AvailabilityRow = DatabaseRow & {
  eligibility: unknown;
  organization_id: unknown;
  organization_account_id: unknown;
  application_root_id: unknown;
  access_version: unknown;
  correlation_id: unknown;
  expires_at: unknown;
  observed_at: unknown;
};

const samePermission = (
  left: OrganizationRecordAccessDeclaration["requiredPermissions"][number],
  right: OrganizationRecordAccessDeclaration["requiredPermissions"][number],
): boolean =>
  left.ownerKind === right.ownerKind &&
  sameId(left.ownerId, right.ownerId) &&
  sameId(left.permissionId, right.permissionId) &&
  left.applicationRootId !== undefined &&
  right.applicationRootId !== undefined &&
  sameId(left.applicationRootId, right.applicationRootId);

const boundEvidence = (
  evidence: OrganizationRecordPermissionEligibility,
  scope: SelectedOrganizationScope,
  declaration: OrganizationRecordAccessDeclaration,
  row: AvailabilityRow,
): boolean => {
  const binding = declaration.recordBinding;
  const observedAt = databaseTimestamp(row.observed_at);
  const expiresAt = databaseTimestamp(row.expires_at);
  if (
    evidence.operationKey !== declaration.operationKey ||
    !sameId(evidence.target.applicationRootId, declaration.target.applicationRootId) ||
    !sameId(evidence.organizationId, scope.organizationId) ||
    !sameId(evidence.organizationAccountId, scope.organizationAccountId) ||
    evidence.accessVersion !== scope.accessVersion ||
    scope.applicationRootId === undefined ||
    !sameId(scope.applicationRootId, declaration.target.applicationRootId) ||
    !sameId(evidence.recordBinding.moduleRootId, binding.moduleRootId) ||
    !sameId(evidence.recordBinding.recordTypeId, binding.recordTypeId) ||
    !sameId(evidence.recordBinding.storageContractId, binding.storageContractId) ||
    evidence.recordBinding.storageScope !== binding.storageScope ||
    typeof row.organization_id !== "string" ||
    !sameId(row.organization_id, evidence.organizationId) ||
    typeof row.organization_account_id !== "string" ||
    !sameId(row.organization_account_id, evidence.organizationAccountId) ||
    typeof row.application_root_id !== "string" ||
    !sameId(row.application_root_id, evidence.target.applicationRootId) ||
    databaseRevision(row.access_version) !== evidence.accessVersion ||
    typeof row.correlation_id !== "string" ||
    !sameId(row.correlation_id, evidence.correlationId) ||
    typeof observedAt !== "string" || typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt)) || !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(evidence.checkedAt) !== Date.parse(observedAt)
  ) return false;
  if (evidence.outcome === "refused") return true;
  const permission = declaration.requiredPermissions[0];
  return permission !== undefined &&
    evidence.eligiblePermissions.every((candidate) =>
      samePermission(candidate.permission, permission),
    ) &&
    Date.parse(expiresAt) > Date.parse(observedAt) &&
    Date.parse(evidence.validUntil) > Date.parse(observedAt) &&
    Date.parse(evidence.validUntil) <= Date.parse(expiresAt) &&
    Date.parse(expiresAt) > Date.now() &&
    Date.parse(evidence.validUntil) > Date.now();
};

/** Consumes the private core through its fixed Access-owned, human-context-bound wrapper. */
export const evaluateOrganizationRecordPermissionAvailability = async (
  transaction: RequestDatabaseTransaction,
  scopeCandidate: SelectedOrganizationScope,
  declarationCandidate: OrganizationRecordAccessDeclaration,
): Promise<OrganizationRecordPermissionAvailability> => {
  const scope = selectedOrganizationScopeSchema.safeParse(scopeCandidate);
  const declaration = organizationRecordAccessDeclarationSchema.safeParse(declarationCandidate);
  if (!scope.success || !declaration.success || declaration.data.requiredPermissions.length !== 1)
    throw unavailableError(unavailableCode);

  let rows: readonly AvailabilityRow[];
  try {
    rows = await transaction.query<AvailabilityRow>`
      select eligibility, organization_id, organization_account_id, application_root_id,
        access_version, correlation_id, expires_at, observed_at
      from vortex_access.evaluate_organization_record_permission_availability(
        ${JSON.stringify(declaration.data)}::text::jsonb
      )
    `;
  } catch {
    throw unavailableError(unavailableCode);
  }
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) throw unavailableError(unavailableCode);
  const evidence = organizationRecordPermissionEligibilitySchema.safeParse(row.eligibility);
  if (!evidence.success || !boundEvidence(evidence.data, scope.data, declaration.data, row))
    throw unavailableError(unavailableCode);
  return evidence.data.outcome === "refused"
    ? safeOrganizationAccessRefusal(evidence.data)
    : {
        outcome: "eligible",
        correlationId: evidence.data.correlationId,
        validUntil: evidence.data.validUntil,
      };
};
