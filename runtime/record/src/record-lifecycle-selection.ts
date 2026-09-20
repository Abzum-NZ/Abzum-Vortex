import "server-only";

import {
  lifecycleCandidateRecordSchema,
  recordIdSchema,
  storageContractIdSchema,
  type LifecycleCandidateRecord,
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
 * Reads lifecycle candidate records from the database for a given storage
 * contract, within an already-established system request transaction/context.
 *
 * Returns an array of validated `LifecycleCandidateRecord` objects containing:
 * recordId, expectedRecordRevision, and createdAt.  The `isHeld` and
 * `isProtected` fields default to `false` because this reader reads raw candidate
 * rows from physical storage; hold/recovery evaluation belongs to the lifecycle
 * policy engine and executor #117.
 *
 * Fails closed on:
 *   - Missing, nil, or malformed storage contract identity
 *   - Duplicate record IDs in the result set
 *   - Non-JSON-safe revision values (outside 1..2^53 - 1)
 *   - Malformed timestamps
 *   - Any database error (propagated as-is)
 *
 * Does not expose an arbitrary-SQL/table reader.  The storage contract identity
 * is validated and the physical table is resolved server-side through the
 * authoritative storage catalogue.
 */
export async function readLifecycleCandidateRecords(
  transaction: RequestDatabaseTransaction,
  storageContractId: StorageContractId,
): Promise<readonly LifecycleCandidateRecord[]> {
  // Validate the storage contract identifier before sending to the database.
  const validatedStorageContractId = storageContractIdSchema.parse(storageContractId);

  const rows = await transaction.query<SelectionReaderRow>`
    select record_id, created_at, record_revision
    from vortex_record.read_lifecycle_candidate_records(${validatedStorageContractId})
  `;

  const seenRecordIds = new Set<string>();
  const candidates: LifecycleCandidateRecord[] = [];

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

    // Validate the complete candidate against the accepted contract schema.
    const candidate = lifecycleCandidateRecordSchema.parse({
      recordId,
      expectedRecordRevision: numericRevision,
      createdAt: createdAtIso,
    });

    candidates.push(candidate);
  }

  return candidates;
}
