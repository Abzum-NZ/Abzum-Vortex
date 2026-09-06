import "server-only";

import {
  delegationScopeSchema,
  organizationDelegationScopeCandidateSchema,
  type DelegationScope,
  type OrganizationDelegationScopeCandidate,
  type RolePermissionEntry,
} from "@vortex/contracts";
import { canonicalJson, fingerprintCanonicalValue } from "@vortex/definition";

export const organizationDelegationScopeEvidenceErrorCodes = [
  "INVALID_ORGANIZATION_DELEGATION_SCOPE_CANDIDATE",
  "ORGANIZATION_DELEGATION_SCOPE_EVIDENCE_INVALID",
] as const;

export type OrganizationDelegationScopeEvidenceErrorCode =
  (typeof organizationDelegationScopeEvidenceErrorCodes)[number];

export class OrganizationDelegationScopeEvidenceError extends Error {
  readonly code: OrganizationDelegationScopeEvidenceErrorCode;

  constructor(code: OrganizationDelegationScopeEvidenceErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationDelegationScopeEvidenceError";
    this.code = code;
  }
}

const evidenceError = (cause?: unknown): OrganizationDelegationScopeEvidenceError =>
  new OrganizationDelegationScopeEvidenceError(
    "ORGANIZATION_DELEGATION_SCOPE_EVIDENCE_INVALID",
    cause === undefined ? undefined : { cause },
  );

const normalizedUuid = <Value extends string>(value: Value): Value => value.toLowerCase() as Value;

const normalizeCandidateInput = (candidate: unknown): unknown => {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
    return candidate;
  const record = candidate as Record<string, unknown>;
  if (record.kind !== "bounded" || !Array.isArray(record.permissions)) return candidate;
  return {
    ...record,
    permissions: record.permissions.map((permission) => {
      if (typeof permission !== "object" || permission === null || Array.isArray(permission))
        return permission;
      const entry = permission as Record<string, unknown>;
      return {
        ...entry,
        ...(typeof entry.applicationRootId === "string"
          ? { applicationRootId: entry.applicationRootId.toLowerCase() }
          : {}),
        ...(typeof entry.ownerId === "string" ? { ownerId: entry.ownerId.toLowerCase() } : {}),
        ...(typeof entry.permissionId === "string"
          ? { permissionId: entry.permissionId.toLowerCase() }
          : {}),
      };
    }),
  };
};

const normalizePermission = (permission: RolePermissionEntry): RolePermissionEntry => ({
  ...permission,
  ...(permission.applicationRootId === undefined
    ? {}
    : { applicationRootId: normalizedUuid(permission.applicationRootId) }),
  ownerId: normalizedUuid(permission.ownerId),
  permissionId: normalizedUuid(permission.permissionId),
});

const permissionIdentity = (permission: RolePermissionEntry) =>
  [
    permission.applicationRootId,
    permission.ownerKind,
    permission.ownerId,
    permission.permissionId,
  ] as const;

const compareIdentity = (
  left: readonly (string | undefined)[],
  right: readonly (string | undefined)[],
): number => {
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === rightValue) continue;
    if (leftValue === undefined) return 1;
    if (rightValue === undefined) return -1;
    return leftValue < rightValue ? -1 : 1;
  }
  return 0;
};

const normalizedIdentity = (permission: RolePermissionEntry): string =>
  canonicalJson([
    permission.applicationRootId ?? null,
    permission.ownerKind,
    permission.ownerId,
    permission.permissionId,
  ]);

const prepareParsedScope = (candidate: OrganizationDelegationScopeCandidate): DelegationScope => {
  if (candidate.kind === "organization_catalogue") return candidate;

  const permissions = candidate.permissions
    .map(normalizePermission)
    .sort((left, right) => compareIdentity(permissionIdentity(left), permissionIdentity(right)));
  const identities = permissions.map(normalizedIdentity);
  if (new Set(identities).size !== identities.length) throw evidenceError();

  const prepared = {
    kind: "bounded" as const,
    permissions,
    scopeFingerprint: fingerprintCanonicalValue({ kind: "bounded", permissions }),
  };
  const parsed = delegationScopeSchema.safeParse(prepared);
  if (!parsed.success) throw evidenceError(parsed.error);
  return parsed.data;
};

export const prepareOrganizationDelegationScope = (
  candidateValue: OrganizationDelegationScopeCandidate,
): DelegationScope => {
  const parsed = organizationDelegationScopeCandidateSchema.safeParse(
    normalizeCandidateInput(candidateValue),
  );
  if (!parsed.success)
    throw new OrganizationDelegationScopeEvidenceError(
      "INVALID_ORGANIZATION_DELEGATION_SCOPE_CANDIDATE",
      { cause: parsed.error },
    );
  return prepareParsedScope(parsed.data);
};

export const verifyPreparedOrganizationDelegationScope = (
  candidateValue: unknown,
): DelegationScope => {
  const parsed = delegationScopeSchema.safeParse(candidateValue);
  if (!parsed.success) throw evidenceError(parsed.error);
  const expected = prepareParsedScope(
    parsed.data.kind === "organization_catalogue"
      ? parsed.data
      : { kind: "bounded", permissions: parsed.data.permissions },
  );
  if (canonicalJson(expected) !== canonicalJson(parsed.data)) throw evidenceError();
  return parsed.data;
};
