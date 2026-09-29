import "server-only";

import {
  applicationRootIdSchema,
  isRecord,
  organizationIdSchema,
  protectedLegalHoldReferenceSchema,
  recordIdSchema,
  recordTypeIdSchema,
  sameId,
  tenantIdSchema,
  type ProtectedLegalHoldReference,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import type { RecordRemovalCandidateIdentity } from "./lifecycle-hold-scope";

type LegalHoldReadRow = DatabaseRow & { result: unknown };

type ParsedRecordCandidate = RecordRemovalCandidateIdentity;

const hasOwn = (candidate: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(candidate, key);

const allowedCandidateKeys = new Set([
  "kind",
  "tenantId",
  "organizationId",
  "applicationRootId",
  "recordTypeId",
  "recordId",
]);

const parseRecordCandidate = (candidate: unknown): ParsedRecordCandidate | undefined => {
  if (!isRecord(candidate) || candidate.kind !== "record") return undefined;
  if (Object.keys(candidate).some((key) => !allowedCandidateKeys.has(key))) return undefined;

  const tenantId = tenantIdSchema.safeParse(candidate.tenantId);
  const organizationId = organizationIdSchema.safeParse(candidate.organizationId);
  const recordTypeId = recordTypeIdSchema.safeParse(candidate.recordTypeId);
  const recordId = recordIdSchema.safeParse(candidate.recordId);
  if (!tenantId.success || !organizationId.success || !recordTypeId.success || !recordId.success)
    return undefined;

  let applicationRootId: string | null | undefined;
  if (hasOwn(candidate, "applicationRootId")) {
    if (candidate.applicationRootId === null) {
      applicationRootId = null;
    } else {
      const parsedApplicationRootId = applicationRootIdSchema.safeParse(
        candidate.applicationRootId,
      );
      if (!parsedApplicationRootId.success) return undefined;
      applicationRootId = parsedApplicationRootId.data;
    }
  }

  return {
    kind: "record",
    tenantId: tenantId.data,
    organizationId: organizationId.data,
    ...(applicationRootId === undefined ? {} : { applicationRootId }),
    recordTypeId: recordTypeId.data,
    recordId: recordId.data,
  };
};

export type CurrentLegalHoldReadResult =
  | Readonly<{
      outcome: "complete";
      holds: readonly ProtectedLegalHoldReference[];
    }>
  | Readonly<{ outcome: "unavailable" }>;

const UNAVAILABLE: CurrentLegalHoldReadResult = Object.freeze({
  outcome: "unavailable" as const,
});

/**
 * Reads the current protected references for one exact Record candidate from
 * an already initialized request transaction. SQL validates the transaction's
 * human or system context again after this adapter switches to its runtime role.
 */
export const readCurrentLegalHolds = async (
  transaction: RequestDatabaseTransaction,
  candidate: unknown,
): Promise<CurrentLegalHoldReadResult> => {
  const parsedCandidate = parseRecordCandidate(candidate);
  if (parsedCandidate === undefined) return UNAVAILABLE;

  let rows: readonly LegalHoldReadRow[];
  try {
    await transaction.query`set local role vortex_runtime`;
    rows = await transaction.query<LegalHoldReadRow>`
      select vortex_record.read_current_legal_holds(
        ${JSON.stringify(parsedCandidate)}::text::jsonb
      ) as result
    `;
  } catch {
    return UNAVAILABLE;
  }
  if (rows.length !== 1 || rows[0] === undefined || !isRecord(rows[0].result))
    return UNAVAILABLE;

  const result = rows[0].result;
  if (result.outcome === "unavailable") return UNAVAILABLE;
  if (
    result.outcome !== "complete" ||
    Object.keys(result).some((key) => key !== "outcome" && key !== "holds") ||
    !Array.isArray(result.holds)
  )
    return UNAVAILABLE;

  const holds: ProtectedLegalHoldReference[] = [];
  const holdIds = new Set<string>();
  for (const candidateHold of result.holds) {
    const parsedHold = protectedLegalHoldReferenceSchema.safeParse(candidateHold);
    const holdId = parsedHold.success ? parsedHold.data.holdId.toLowerCase() : undefined;
    if (
      !parsedHold.success ||
      !sameId(parsedHold.data.tenantId, parsedCandidate.tenantId) ||
      !sameId(parsedHold.data.organizationId, parsedCandidate.organizationId) ||
      holdId === undefined ||
      holdIds.has(holdId)
    )
      return UNAVAILABLE;
    holdIds.add(holdId);
    holds.push(parsedHold.data);
  }

  return Object.freeze({
    outcome: "complete",
    holds: Object.freeze(holds),
  });
};
