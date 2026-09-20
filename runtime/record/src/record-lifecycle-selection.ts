import "server-only";

import {
  recordIdSchema,
  storageContractIdSchema,
  type RecordId,
  type StorageContractId,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";

/**
 * Raw row shape returned by `vortex_record.read_lifecycle_candidate_records`.
 * The database function returns `(record_id uuid, created_at timestamptz,
 * record_revision bigint)`.
 */
type SelectionReaderRow = Readonly<{
  record_id: unknown;
  created_at: unknown;
  record_revision: unknown;
}>;

/**
 * Raw candidate record facts returned by the lifecycle selection reader.
 * Contains only source-owned physical storage facts: identity, revision, and creation time.
 *
 * Distinct from `LifecycleCandidateRecord` because hold and recovery protection facts
 * are not evaluated by this raw reader and must not be defaulted to `false`. An explicit
 * enrichment step is required before evaluating lifecycle policy handoffs.
 */
export type RawLifecycleCandidateRecord = Readonly<{
  recordId: RecordId;
  expectedRecordRevision: number;
  createdAt: string;
}>;

/**
 * Reads lifecycle candidate records from the database for a given storage
 * contract, within an already-established system request transaction/context.
 *
 * Returns an array of raw `RawLifecycleCandidateRecord` objects containing:
 * recordId, expectedRecordRevision, and createdAt.
 *
 * Deliberately does not construct `LifecycleCandidateRecord` or populate
 * `isHeld` / `isProtected` defaults, ensuring raw candidate facts cannot be passed
 * directly to the lifecycle policy handoff selector without an authoritative hold/recovery
 * evaluation step.
 *
 * Fails closed on:
 *   - Missing, nil, or malformed storage contract identity
 *   - Duplicate record IDs in the result set
 *   - Non-JSON-safe revision values (outside 1..2^53 - 1) or precision-losing coercions
 *   - Malformed timestamps
 *   - Any database error (propagated as-is)
 *
 * Does not expose an arbitrary-SQL/table reader. The storage contract identity
 * is validated and the physical table is resolved server-side through the
 * authoritative storage catalogue.
 */
export async function readLifecycleCandidateRecords(
  transaction: RequestDatabaseTransaction,
  storageContractId: StorageContractId,
): Promise<readonly RawLifecycleCandidateRecord[]> {
  // Validate the storage contract identifier before sending to the database.
  const validatedStorageContractId = storageContractIdSchema.parse(storageContractId);

  const rows = await transaction.query<SelectionReaderRow>`
    select record_id, created_at, record_revision
    from vortex_record.read_lifecycle_candidate_records(${validatedStorageContractId})
  `;

  const seenRecordIds = new Set<string>();
  const candidates: RawLifecycleCandidateRecord[] = [];

  for (const row of rows) {
    // Validate the record ID is a valid platform-issued non-nil UUID using contracts schema.
    const recordId = recordIdSchema.parse(row.record_id);

    // Fail closed on duplicate record IDs (indicates broken scope or query).
    const canonicalId = recordId.toLowerCase();
    if (seenRecordIds.has(canonicalId)) {
      throw new Error(
        `Lifecycle selection reader: duplicate record identity in result: ${recordId}`,
      );
    }
    seenRecordIds.add(canonicalId);

    // Validate the revision is a JSON-safe positive integer.
    const rawRevision = row.record_revision;
    if (rawRevision === null || rawRevision === undefined) {
      throw new Error(
        `Lifecycle selection reader: missing record revision for record ${recordId}`,
      );
    }
    const numericRevision =
      typeof rawRevision === "bigint"
        ? Number(rawRevision)
        : typeof rawRevision === "string"
          ? Number(rawRevision)
          : typeof rawRevision === "number"
            ? rawRevision
            : NaN;
    if (
      !Number.isFinite(numericRevision) ||
      !Number.isInteger(numericRevision) ||
      numericRevision < 1 ||
      numericRevision > Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        `Lifecycle selection reader: non-JSON-safe record revision for record ${recordId}: ${String(rawRevision)}`,
      );
    }

    // Exact string and bigint representation check: detect precision loss outside safe integers.
    if (typeof rawRevision === "string" && String(numericRevision) !== rawRevision.trim()) {
      throw new Error(
        `Lifecycle selection reader: precision loss in string record revision for record ${recordId}: ${rawRevision}`,
      );
    }
    if (typeof rawRevision === "bigint" && BigInt(numericRevision) !== rawRevision) {
      throw new Error(
        `Lifecycle selection reader: precision loss in bigint record revision for record ${recordId}: ${rawRevision.toString()}`,
      );
    }

    // Validate the created_at timestamp.
    const rawCreatedAt = row.created_at;
    if (rawCreatedAt === null || rawCreatedAt === undefined) {
      throw new Error(
        `Lifecycle selection reader: missing creation timestamp for record ${recordId}`,
      );
    }
    const createdAtDate =
      rawCreatedAt instanceof Date ? rawCreatedAt : new Date(String(rawCreatedAt));
    if (Number.isNaN(createdAtDate.getTime())) {
      throw new Error(
        `Lifecycle selection reader: malformed creation timestamp for record ${recordId}: ${String(rawCreatedAt)}`,
      );
    }
    const createdAtIso = createdAtDate.toISOString();

    candidates.push(
      Object.freeze({
        recordId,
        expectedRecordRevision: numericRevision,
        createdAt: createdAtIso,
      }),
    );
  }

  return Object.freeze(candidates);
}
