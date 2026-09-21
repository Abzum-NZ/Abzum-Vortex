import "server-only";

import {
  applicationRootIdSchema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  storageContractIdSchema,
  type ApplicationRootId,
  type OrganizationId,
  type RecordId,
  type RecordTypeId,
  type StorageContractId,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";

export type RecordStorageScope = "organization_shared" | "application_contained";

export type RecordRecoveryEligibilityInput = Readonly<{
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId | null;
  storageScope: RecordStorageScope;
  storageContractId: StorageContractId;
  recordTypeId: RecordTypeId;
  recordId: RecordId;
  deletedAt: string | Date;
}>;

export type RecordRecoveryEligibility =
  | Readonly<{ outcome: "eligible" }>
  | Readonly<{
      outcome: "refused";
      reasonCode: "recovery_unavailable" | "recovery_expired";
    }>;

export type RecordRemovalProtectionFact = Readonly<{
  recordId: RecordId;
  expectedRecordRevision: number;
  lifecycleState: "active" | "soft_deleted" | "removal_pending";
  deletedAt: string | null;
  removalDueAt: string | null;
  isHeld: boolean;
  isProtected: boolean;
  protectionRevision: number;
}>;

type EligibilityRow = Readonly<{ result: unknown }>;
type ProtectionRow = Readonly<{
  record_id: unknown;
  record_revision: unknown;
  lifecycle_state: unknown;
  deleted_at: unknown;
  removal_due_at: unknown;
  is_held: unknown;
  is_recovery_protected: unknown;
  protection_revision: unknown;
}>;

const canonicalTimestamp = (value: unknown, label: string): string => {
  if (value === null || value === undefined) {
    throw new Error(`Record removal protection: missing ${label}`);
  }
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Record removal protection: malformed ${label}`);
  }
  return parsed.toISOString();
};

const jsonSafeInteger = (value: unknown, label: string, minimum: number): number => {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" || typeof value === "number"
        ? Number(value)
        : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    (typeof value === "bigint" && BigInt(parsed) !== value) ||
    (typeof value === "string" && String(parsed) !== value.trim())
  ) {
    throw new Error(`Record removal protection: invalid ${label}`);
  }
  return parsed;
};

const parseEligibility = (value: unknown): RecordRecoveryEligibility => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Record recovery eligibility returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result).sort();
  if (result.outcome === "eligible" && keys.length === 1 && keys[0] === "outcome") {
    return Object.freeze({ outcome: "eligible" });
  }
  if (
    result.outcome === "refused" &&
    keys.length === 2 &&
    keys[0] === "outcome" &&
    keys[1] === "reasonCode" &&
    (result.reasonCode === "recovery_unavailable" || result.reasonCode === "recovery_expired")
  ) {
    return Object.freeze({ outcome: "refused", reasonCode: result.reasonCode });
  }
  throw new Error("Record recovery eligibility returned an invalid closed result");
};

/**
 * Resolves whether one exact retained deletion may be restored under both its
 * persisted deletion provenance and the current record-type recovery policy.
 *
 * The result is deliberately content-free. Missing/stale provenance, scope, or
 * policy evidence is returned as `recovery_unavailable`; a null removal due time
 * is never interpreted as unlimited recovery.
 */
export async function resolveRecordRecoveryEligibility(
  transaction: RequestDatabaseTransaction,
  input: RecordRecoveryEligibilityInput,
): Promise<RecordRecoveryEligibility> {
  const organizationId = organizationIdSchema.parse(input.organizationId);
  const storageContractId = storageContractIdSchema.parse(input.storageContractId);
  const recordTypeId = recordTypeIdSchema.parse(input.recordTypeId);
  const recordId = recordIdSchema.parse(input.recordId);
  const applicationRootId =
    input.applicationRootId === null
      ? null
      : applicationRootIdSchema.parse(input.applicationRootId);
  if (
    (input.storageScope === "organization_shared" && applicationRootId !== null) ||
    (input.storageScope === "application_contained" && applicationRootId === null) ||
    (input.storageScope !== "organization_shared" &&
      input.storageScope !== "application_contained")
  ) {
    throw new Error("Record recovery eligibility received a contradictory storage scope");
  }
  const deletedAt = canonicalTimestamp(input.deletedAt, "deletion timestamp");

  const rows = await transaction.query<EligibilityRow>`
    select vortex_record.resolve_record_recovery_eligibility(
      ${organizationId},
      ${applicationRootId},
      ${input.storageScope},
      ${storageContractId},
      ${recordTypeId},
      ${recordId},
      ${deletedAt}::timestamptz
    ) as result
  `;
  if (rows.length !== 1) {
    throw new Error("Record recovery eligibility returned an invalid row count");
  }
  return parseEligibility(rows[0]!.result);
}

/**
 * Reads the authoritative, content-free hold/recovery protection facts used to
 * enrich raw lifecycle candidates. Unknown deleted-row evidence is protected by
 * the database function rather than defaulted to false.
 */
export async function readLifecycleRemovalProtectionFacts(
  transaction: RequestDatabaseTransaction,
  storageContractId: StorageContractId,
): Promise<readonly RecordRemovalProtectionFact[]> {
  const validatedStorageContractId = storageContractIdSchema.parse(storageContractId);
  const rows = await transaction.query<ProtectionRow>`
    select record_id, record_revision, lifecycle_state, deleted_at, removal_due_at,
      is_held, is_recovery_protected, protection_revision
    from vortex_record.read_lifecycle_removal_protection_facts(
      ${validatedStorageContractId}
    )
  `;
  const seen = new Set<string>();
  const facts: RecordRemovalProtectionFact[] = [];
  for (const row of rows) {
    const recordId = recordIdSchema.parse(row.record_id);
    const canonicalId = recordId.toLowerCase();
    if (seen.has(canonicalId)) {
      throw new Error(`Record removal protection: duplicate record identity ${recordId}`);
    }
    seen.add(canonicalId);
    if (
      row.lifecycle_state !== "active" &&
      row.lifecycle_state !== "soft_deleted" &&
      row.lifecycle_state !== "removal_pending"
    ) {
      throw new Error("Record removal protection: invalid lifecycle state");
    }
    if (typeof row.is_held !== "boolean" || typeof row.is_recovery_protected !== "boolean") {
      throw new Error("Record removal protection: invalid protection facts");
    }
    const deletedAt =
      row.deleted_at === null ? null : canonicalTimestamp(row.deleted_at, "deletion timestamp");
    const removalDueAt =
      row.removal_due_at === null
        ? null
        : canonicalTimestamp(row.removal_due_at, "removal due timestamp");
    if (
      (row.lifecycle_state === "active" &&
        (deletedAt !== null || removalDueAt !== null || row.is_recovery_protected)) ||
      (row.lifecycle_state !== "active" && deletedAt === null)
    ) {
      throw new Error("Record removal protection: contradictory lifecycle facts");
    }
    facts.push(
      Object.freeze({
        recordId,
        expectedRecordRevision: jsonSafeInteger(row.record_revision, "record revision", 1),
        lifecycleState: row.lifecycle_state,
        deletedAt,
        removalDueAt,
        isHeld: row.is_held,
        isProtected: row.is_recovery_protected,
        protectionRevision: jsonSafeInteger(
          row.protection_revision,
          "protection revision",
          0,
        ),
      }),
    );
  }
  return Object.freeze(facts);
}
