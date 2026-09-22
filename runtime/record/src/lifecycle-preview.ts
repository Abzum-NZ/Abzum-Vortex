import "server-only";

import {
  applicationRootIdSchema,
  lifecycleCandidateRecordSchema,
  organizationIdSchema,
  recordIdSchema,
  recordLifecycleHandoffSchema,
  recordTypeLifecyclePolicySchema,
  revisionSchema,
  selectDueRecordsForLifecycleHandoff,
  storageContractIdSchema,
  timestampSchema,
  type BlockedRemovalRecord,
  type DueRecordHandoffItem,
  type IdentitySession,
  type LifecycleCandidateRecord,
  type OrganizationSelectionCandidate,
  type RecordLifecycleHandoff,
  type RecordTypeLifecyclePolicy,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { DatabaseRow } from "@vortex/db";

/**
 * Keyset cursor identifying the last evaluated record in a bounded preview page.
 */
export interface LifecyclePreviewCursor {
  readonly afterCreatedAt: string;
  readonly afterRecordId: string;
}

/**
 * Continuation metadata for paginating lifecycle candidates.
 */
export interface LifecyclePreviewContinuation {
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly next?: LifecyclePreviewCursor;
}

/**
 * Encodes keyset cursor values into an opaque URL-safe string.
 */
export const encodeLifecyclePreviewCursor = (cursor: LifecyclePreviewCursor): string =>
  Buffer.from(JSON.stringify({ c: cursor.afterCreatedAt, r: cursor.afterRecordId })).toString(
    "base64url",
  );

/**
 * Decodes an opaque URL-safe cursor string into structured keyset values.
 */
export const decodeLifecyclePreviewCursor = (token: string): LifecyclePreviewCursor | undefined => {
  try {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof raw.c === "string" &&
      typeof raw.r === "string" &&
      recordIdSchema.safeParse(raw.r).success &&
      timestampSchema.safeParse(raw.c).success
    ) {
      return { afterCreatedAt: raw.c, afterRecordId: raw.r };
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Input command for previewing record lifecycle evaluation and #117 handoff preparation.
 */
export interface RecordLifecyclePreviewCommand {
  readonly organizationId: string;
  readonly storageContractId: string;
  readonly applicationRootId: string | null;
  readonly limit?: number;
  readonly afterCreatedAt?: string;
  readonly afterRecordId?: string;
  readonly cursor?: string;
  readonly evaluatedAt?: string | Date;
  readonly heldRecordIds?: readonly string[];
  readonly protectedRecordIds?: readonly string[];
  readonly candidates?: readonly LifecycleCandidateRecord[];
}

/**
 * Comprehensive preview outcome describing policy state, candidates, continuation,
 * and the exact #117 handoff without record mutations or deletions.
 */
export interface RecordLifecyclePreviewResult {
  readonly policyStatus: "available" | "unavailable";
  readonly policy: RecordTypeLifecyclePolicy | null;
  readonly handoff: RecordLifecycleHandoff | null;
  readonly candidates: readonly LifecycleCandidateRecord[];
  readonly dueRecords: readonly DueRecordHandoffItem[];
  readonly blockedRecords: readonly BlockedRemovalRecord[];
  readonly totalRetainedCount: number;
  readonly continuation: LifecyclePreviewContinuation | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const previewCommandKeys = [
  "organizationId",
  "storageContractId",
  "applicationRootId",
  "limit",
  "afterCreatedAt",
  "afterRecordId",
  "cursor",
  "evaluatedAt",
  "heldRecordIds",
  "protectedRecordIds",
  "candidates",
] as const;

const hasOnlyKeys = (candidate: Readonly<Record<string, unknown>>, allowed: readonly string[]) =>
  Object.keys(candidate).every((key) => allowed.includes(key));

const parseRecordLifecyclePreviewCommand = (
  candidate: unknown,
): RecordLifecyclePreviewCommand | undefined => {
  if (!isPlainObject(candidate) || !hasOnlyKeys(candidate, previewCommandKeys)) {
    return undefined;
  }

  const organizationId = organizationIdSchema.safeParse(candidate.organizationId);
  const storageContractId = storageContractIdSchema.safeParse(candidate.storageContractId);
  const applicationRootId =
    candidate.applicationRootId === null
      ? { success: true as const, data: null }
      : applicationRootIdSchema.safeParse(candidate.applicationRootId);

  if (!organizationId.success || !storageContractId.success || !applicationRootId.success) {
    return undefined;
  }

  let limit: number | undefined;
  if (candidate.limit !== undefined) {
    if (
      typeof candidate.limit !== "number" ||
      !Number.isSafeInteger(candidate.limit) ||
      candidate.limit < 1 ||
      candidate.limit > 500
    ) {
      return undefined;
    }
    limit = candidate.limit;
  }

  if ((candidate.afterCreatedAt !== undefined) !== (candidate.afterRecordId !== undefined)) {
    return undefined;
  }

  let afterCreatedAt: string | undefined;
  let afterRecordId: string | undefined;
  if (candidate.afterCreatedAt !== undefined && candidate.afterRecordId !== undefined) {
    const parsedCreatedAt = timestampSchema.safeParse(candidate.afterCreatedAt);
    const parsedRecordId = recordIdSchema.safeParse(candidate.afterRecordId);
    if (!parsedCreatedAt.success || !parsedRecordId.success) {
      return undefined;
    }
    afterCreatedAt = parsedCreatedAt.data;
    afterRecordId = parsedRecordId.data;
  }

  let cursor: string | undefined;
  if (candidate.cursor !== undefined) {
    if (typeof candidate.cursor !== "string") {
      return undefined;
    }
    if (decodeLifecyclePreviewCursor(candidate.cursor) === undefined) {
      return undefined;
    }
    cursor = candidate.cursor;
  }

  let evaluatedAt: string | Date | undefined;
  if (candidate.evaluatedAt !== undefined) {
    if (candidate.evaluatedAt instanceof Date) {
      if (Number.isNaN(candidate.evaluatedAt.getTime())) return undefined;
      evaluatedAt = candidate.evaluatedAt;
    } else {
      const parsedTimestamp = timestampSchema.safeParse(candidate.evaluatedAt);
      if (!parsedTimestamp.success) return undefined;
      evaluatedAt = parsedTimestamp.data;
    }
  }

  let heldRecordIds: readonly string[] | undefined;
  if (candidate.heldRecordIds !== undefined) {
    if (!Array.isArray(candidate.heldRecordIds)) return undefined;
    const validatedIds: string[] = [];
    for (const item of candidate.heldRecordIds) {
      const parsed = recordIdSchema.safeParse(item);
      if (!parsed.success) return undefined;
      validatedIds.push(parsed.data);
    }
    heldRecordIds = validatedIds;
  }

  let protectedRecordIds: readonly string[] | undefined;
  if (candidate.protectedRecordIds !== undefined) {
    if (!Array.isArray(candidate.protectedRecordIds)) return undefined;
    const validatedIds: string[] = [];
    for (const item of candidate.protectedRecordIds) {
      const parsed = recordIdSchema.safeParse(item);
      if (!parsed.success) return undefined;
      validatedIds.push(parsed.data);
    }
    protectedRecordIds = validatedIds;
  }

  let candidates: readonly LifecycleCandidateRecord[] | undefined;
  if (candidate.candidates !== undefined) {
    if (!Array.isArray(candidate.candidates)) return undefined;
    const validatedRecords: LifecycleCandidateRecord[] = [];
    for (const item of candidate.candidates) {
      const parsed = lifecycleCandidateRecordSchema.safeParse(item);
      if (!parsed.success) return undefined;
      validatedRecords.push(parsed.data);
    }
    candidates = validatedRecords;
  }

  return {
    organizationId: organizationId.data,
    storageContractId: storageContractId.data,
    applicationRootId: applicationRootId.data,
    limit,
    afterCreatedAt,
    afterRecordId,
    cursor,
    evaluatedAt,
    heldRecordIds,
    protectedRecordIds,
    candidates,
  };
};

/**
 * Pure, state-free lifecycle preview evaluation helper.
 * Validates inputs, feeds candidates to selectDueRecordsForLifecycleHandoff,
 * and formats the exact deterministic handoff preview result.
 */
export interface EvaluateLifecyclePreviewInput {
  readonly policy: RecordTypeLifecyclePolicy;
  readonly candidates: readonly LifecycleCandidateRecord[];
  readonly evaluatedAt?: string | Date;
  readonly totalRetainedCount?: number;
  readonly continuation?: LifecyclePreviewContinuation | null;
}

export const evaluateLifecyclePreview = (
  input: EvaluateLifecyclePreviewInput,
): RecordLifecyclePreviewResult => {
  const policy = recordTypeLifecyclePolicySchema.parse(input.policy);
  const handoff = selectDueRecordsForLifecycleHandoff({
    policy,
    records: input.candidates,
    evaluatedAt: input.evaluatedAt,
  });

  return {
    policyStatus: "available",
    policy,
    handoff,
    candidates: input.candidates,
    dueRecords: handoff.dueRecords,
    blockedRecords: handoff.blockedRecords,
    totalRetainedCount: input.totalRetainedCount ?? handoff.totalRetainedCount,
    continuation: input.continuation ?? { hasMore: false },
  };
};

type PreviewRow = DatabaseRow & { readonly result: unknown };

export type RecordLifecyclePreviewServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{ clock?: () => Date }>;

/**
 * Protected Record lifecycle preview service.
 * Reads stored #566 policy and bounded records for the exact organisation and scope,
 * feeds candidates into selectDueRecordsForLifecycleHandoff, and returns policy status,
 * candidates, exact continuation state, and the exact #117 handoff without mutating records.
 */
export const createRecordLifecyclePreviewService = (
  dependencies: RecordLifecyclePreviewServiceDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const clock = dependencies.clock ?? (() => new Date());

  return Object.freeze({
    async preview(
      session: IdentitySession,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<RecordLifecyclePreviewResult>> {
      const command = parseRecordLifecyclePreviewCommand(commandCandidate);
      if (command === undefined) return { kind: "unavailable" };

      const selection: OrganizationSelectionCandidate =
        command.applicationRootId === null
          ? { organizationId: command.organizationId }
          : {
              organizationId: command.organizationId,
              applicationRootId: command.applicationRootId,
            };

      return requests.run(session, selection, async (transaction, _scope, issuedAt) => {
        let afterCreatedAt = command.afterCreatedAt ?? null;
        let afterRecordId = command.afterRecordId ?? null;

        if (command.cursor !== undefined) {
          const decoded = decodeLifecyclePreviewCursor(command.cursor);
          if (decoded === undefined) {
            throw new Error("INVALID_LIFECYCLE_PREVIEW_CURSOR");
          }
          afterCreatedAt = decoded.afterCreatedAt;
          afterRecordId = decoded.afterRecordId;
        }

        const limit = command.limit ?? 100;

        const rows = await transaction.query<PreviewRow>`
          select vortex_record.preview_record_lifecycle_candidates(
            ${command.storageContractId}::uuid,
            ${command.applicationRootId}::uuid,
            ${afterCreatedAt}::timestamptz,
            ${afterRecordId}::uuid,
            ${limit}::integer
          ) as result
        `;

        if (rows.length !== 1 || rows[0] === undefined) {
          throw new Error("LIFECYCLE_PREVIEW_STORAGE_UNAVAILABLE");
        }

        const raw = rows[0].result;
        if (typeof raw !== "object" || raw === null) {
          throw new Error("LIFECYCLE_PREVIEW_STORAGE_UNAVAILABLE");
        }

        const previewData = raw as Record<string, unknown>;

        if (previewData.policyStatus === "unavailable" || previewData.policy === null) {
          return {
            policyStatus: "unavailable" as const,
            policy: null,
            handoff: null,
            candidates: [],
            dueRecords: [],
            blockedRecords: [],
            totalRetainedCount: 0,
            continuation: null,
          };
        }

        const policy = recordTypeLifecyclePolicySchema.parse(previewData.policy);

        const heldSet = new Set((command.heldRecordIds ?? []).map((id) => id.toLowerCase()));
        const protectedSet = new Set(
          (command.protectedRecordIds ?? []).map((id) => id.toLowerCase()),
        );

        let candidatesToEvaluate: readonly LifecycleCandidateRecord[];

        if (command.candidates !== undefined) {
          candidatesToEvaluate = command.candidates.map((c) =>
            lifecycleCandidateRecordSchema.parse(c),
          );
        } else {
          const recordsArray = Array.isArray(previewData.records) ? previewData.records : [];
          candidatesToEvaluate = recordsArray.map((entry) => {
            if (typeof entry !== "object" || entry === null) {
              throw new Error("LIFECYCLE_PREVIEW_RECORD_DATA_INVALID");
            }
            const item = entry as Record<string, unknown>;
            const recordId = recordIdSchema.parse(item.recordId);
            const expectedRecordRevision = revisionSchema
              .max(Number.MAX_SAFE_INTEGER)
              .parse(item.expectedRecordRevision);
            const createdAt = timestampSchema.parse(item.createdAt);
            const isHeld = heldSet.has(recordId.toLowerCase());
            const isProtected = protectedSet.has(recordId.toLowerCase());

            return lifecycleCandidateRecordSchema.parse({
              recordId,
              expectedRecordRevision,
              createdAt,
              isHeld,
              isProtected,
            });
          });
        }

        const evaluationTime =
          command.evaluatedAt ?? dependencies.clock?.() ?? new Date(issuedAt);

        const handoff = selectDueRecordsForLifecycleHandoff({
          policy,
          records: candidatesToEvaluate,
          evaluatedAt: evaluationTime,
        });

        const hasMore = Boolean(previewData.hasMore);
        let continuation: LifecyclePreviewContinuation | null = null;
        if (
          hasMore &&
          typeof previewData.nextAfterCreatedAt === "string" &&
          typeof previewData.nextAfterRecordId === "string"
        ) {
          const next: LifecyclePreviewCursor = {
            afterCreatedAt: previewData.nextAfterCreatedAt,
            afterRecordId: previewData.nextAfterRecordId,
          };
          continuation = {
            hasMore: true,
            next,
            nextCursor: encodeLifecyclePreviewCursor(next),
          };
        } else {
          continuation = { hasMore: false };
        }

        const totalRetained =
          typeof previewData.totalRetainedCount === "number"
            ? previewData.totalRetainedCount
            : typeof previewData.totalRetainedCount === "string"
              ? Number.parseInt(previewData.totalRetainedCount, 10)
              : candidatesToEvaluate.length;

        return {
          policyStatus: "available" as const,
          policy,
          handoff,
          candidates: candidatesToEvaluate,
          dueRecords: handoff.dueRecords,
          blockedRecords: handoff.blockedRecords,
          totalRetainedCount: totalRetained,
          continuation,
        };
      });
    },
  });
};
