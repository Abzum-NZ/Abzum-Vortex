import "server-only";

import {
  applicationRootIdSchema,
  lifecycleCandidateRecordSchema,
  organizationIdSchema,
  recordIdSchema,
  recordLifecycleHandoffSchema,
  recordLifecyclePolicyIdSchema,
  recordTypeLifecyclePolicySchema,
  revisionSchema,
  selectDueRecordsForLifecycleHandoff,
  storageContractIdSchema,
  timestampSchema,
  type BlockedRemovalRecord,
  type DueRecordHandoffItem,
  type ApplicationRootId,
  type IdentitySession,
  type OrganizationId,
  type StorageContractId,
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
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

/**
 * Keyset cursor identifying the last evaluated record in a bounded preview page.
 */
export interface LifecyclePreviewCursor {
  readonly afterCreatedAt: string;
  readonly afterRecordId: string;
  readonly afterRecordPosition: number;
  readonly organizationId: OrganizationId;
  readonly storageContractId: StorageContractId;
  readonly applicationRootId: ApplicationRootId | null;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly evaluatedAt: string;
  readonly totalRetainedCount: number;
}

/**
 * Continuation metadata for paginating lifecycle candidates.
 */
export interface LifecyclePreviewContinuation {
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly next?: LifecyclePreviewCursor;
}

const lifecyclePreviewCursorKeys = [
  "c",
  "r",
  "x",
  "o",
  "s",
  "a",
  "p",
  "v",
  "e",
  "t",
] as const;
const lifecyclePreviewDecodedCursorKeys = [
  "afterCreatedAt",
  "afterRecordId",
  "afterRecordPosition",
  "organizationId",
  "storageContractId",
  "applicationRootId",
  "policyId",
  "policyRevision",
  "evaluatedAt",
  "totalRetainedCount",
] as const;

const parseLifecyclePreviewCursor = (candidate: unknown): LifecyclePreviewCursor | undefined => {
  if (!isPlainObject(candidate) || !hasOnlyKeys(candidate, lifecyclePreviewCursorKeys)) {
    return undefined;
  }
  const afterCreatedAt = timestampSchema.safeParse(candidate.c);
  const afterRecordId = recordIdSchema.safeParse(candidate.r);
  const afterRecordPosition =
    typeof candidate.x === "number" &&
    Number.isSafeInteger(candidate.x) &&
    candidate.x > 0
      ? candidate.x
      : undefined;
  const organizationId = organizationIdSchema.safeParse(candidate.o);
  const storageContractId = storageContractIdSchema.safeParse(candidate.s);
  const applicationRootId =
    candidate.a === null
      ? { success: true as const, data: null }
      : applicationRootIdSchema.safeParse(candidate.a);
  const policyId = recordLifecyclePolicyIdSchema.safeParse(candidate.p);
  const policyRevision = revisionSchema.max(Number.MAX_SAFE_INTEGER).safeParse(candidate.v);
  const evaluatedAt = timestampSchema.safeParse(candidate.e);
  const totalRetainedCount =
    typeof candidate.t === "number" &&
    Number.isSafeInteger(candidate.t) &&
    candidate.t >= 0
      ? candidate.t
      : undefined;
  if (
    !afterCreatedAt.success ||
    !afterRecordId.success ||
    afterRecordPosition === undefined ||
    !organizationId.success ||
    !storageContractId.success ||
    !applicationRootId.success ||
    !policyId.success ||
    !policyRevision.success ||
    totalRetainedCount === undefined ||
    !evaluatedAt.success
  ) {
    return undefined;
  }
  return {
    afterCreatedAt: afterCreatedAt.data,
    afterRecordId: afterRecordId.data,
    afterRecordPosition,
    organizationId: organizationId.data,
    storageContractId: storageContractId.data,
    applicationRootId: applicationRootId.data,
    policyId: policyId.data,
    policyRevision: policyRevision.data,
    evaluatedAt: evaluatedAt.data,
    totalRetainedCount,
  };
};

const parseDecodedLifecyclePreviewCursor = (
  candidate: unknown,
): LifecyclePreviewCursor | undefined => {
  if (!isPlainObject(candidate) || !hasOnlyKeys(candidate, lifecyclePreviewDecodedCursorKeys)) {
    return undefined;
  }
  return parseLifecyclePreviewCursor({
    c: candidate.afterCreatedAt,
    r: candidate.afterRecordId,
    x: candidate.afterRecordPosition,
    o: candidate.organizationId,
    s: candidate.storageContractId,
    a: candidate.applicationRootId,
    p: candidate.policyId,
    v: candidate.policyRevision,
    e: candidate.evaluatedAt,
    t: candidate.totalRetainedCount,
  });
};

/** Encodes a fully validated, scope- and policy-bound keyset cursor. */
export const encodeLifecyclePreviewCursor = (cursorCandidate: LifecyclePreviewCursor): string => {
  const cursor = parseLifecyclePreviewCursor({
    c: cursorCandidate.afterCreatedAt,
    r: cursorCandidate.afterRecordId,
    x: cursorCandidate.afterRecordPosition,
    o: cursorCandidate.organizationId,
    s: cursorCandidate.storageContractId,
    a: cursorCandidate.applicationRootId,
    p: cursorCandidate.policyId,
    v: cursorCandidate.policyRevision,
    e: cursorCandidate.evaluatedAt,
    t: cursorCandidate.totalRetainedCount,
  });
  if (cursor === undefined) throw new Error("INVALID_LIFECYCLE_PREVIEW_CURSOR");
  return Buffer.from(
    JSON.stringify({
      c: cursor.afterCreatedAt,
      r: cursor.afterRecordId,
      x: cursor.afterRecordPosition,
      o: cursor.organizationId,
      s: cursor.storageContractId,
      a: cursor.applicationRootId,
      p: cursor.policyId,
      v: cursor.policyRevision,
      e: cursor.evaluatedAt,
      t: cursor.totalRetainedCount,
    }),
  ).toString("base64url");
};

/**
 * Decodes an opaque URL-safe cursor string into structured keyset values.
 */
export const decodeLifecyclePreviewCursor = (token: string): LifecyclePreviewCursor | undefined => {
  try {
    return parseLifecyclePreviewCursor(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
};

/**
 * Input command for previewing record lifecycle evaluation and #117 handoff preparation.
 */
export interface RecordLifecyclePreviewCommand {
  readonly organizationId: OrganizationId;
  readonly storageContractId: StorageContractId;
  readonly applicationRootId: ApplicationRootId | null;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
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
  "cursor",
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

  let cursor: string | undefined;
  if (candidate.cursor !== undefined) {
    if (
      typeof candidate.cursor !== "string" ||
      candidate.cursor.length === 0 ||
      candidate.cursor.length > 4096
    ) {
      return undefined;
    }
    cursor = candidate.cursor;
  }

  return {
    organizationId: organizationId.data,
    storageContractId: storageContractId.data,
    applicationRootId: applicationRootId.data,
    limit,
    cursor,
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
  readonly recordOffset?: number;
  readonly continuation?: LifecyclePreviewContinuation | null;
}

export const evaluateLifecyclePreview = (
  input: EvaluateLifecyclePreviewInput,
): RecordLifecyclePreviewResult => {
  if (
    (input.totalRetainedCount === undefined) !==
    (input.recordOffset === undefined)
  ) {
    throw new Error("Bounded lifecycle count and offset must be supplied together");
  }
  const policy = recordTypeLifecyclePolicySchema.parse(input.policy);
  const handoff = selectDueRecordsForLifecycleHandoff({
    policy,
    records: input.candidates,
    ...(input.evaluatedAt === undefined ? {} : { evaluatedAt: input.evaluatedAt }),
    ...(input.totalRetainedCount === undefined || input.recordOffset === undefined
      ? {}
      : {
          totalRetainedCount: input.totalRetainedCount,
          recordOffset: input.recordOffset,
        }),
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

export interface LifecyclePreviewStoredCandidate {
  readonly recordId: string;
  readonly expectedRecordRevision: number;
  readonly createdAt: string;
  readonly lifecycleState: "active" | "soft_deleted" | "removal_pending";
  readonly deletedAt: string | null;
  readonly recordPosition: number;
}

export interface LifecycleCandidateProtectionRequest {
  readonly transaction: RequestDatabaseTransaction;
  readonly organizationId: OrganizationId;
  readonly storageContractId: StorageContractId;
  readonly applicationRootId: ApplicationRootId | null;
  readonly evaluatedAt: string;
  readonly records: readonly LifecyclePreviewStoredCandidate[];
}

export type LifecycleCandidateProtectionResolver = (
  request: LifecycleCandidateProtectionRequest,
) => Promise<unknown>;

/**
 * Server-owned authenticated cursor codec. `decode` returns the decoded
 * cursor object only after authenticity and freshness verification; the
 * protected service then schema-validates and scope-binds every field.
 */
export interface LifecyclePreviewCursorCodec {
  readonly encode: (cursor: LifecyclePreviewCursor) => string;
  readonly decode: (token: string) => unknown;
}

export type RecordLifecyclePreviewServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    resolveCandidateProtections: LifecycleCandidateProtectionResolver;
    cursorCodec: LifecyclePreviewCursorCodec;
  }>;

type StoredLifecyclePreview =
  | Readonly<{
      policyStatus: "unavailable";
      policy: null;
      totalRetainedCount: 0;
      records: readonly [];
      hasMore: false;
    }>
  | Readonly<{
      policyStatus: "available";
      policy: RecordTypeLifecyclePolicy;
      totalRetainedCount: number;
      records: readonly LifecyclePreviewStoredCandidate[];
      hasMore: boolean;
    }>;

const storedPreviewKeys = [
  "policyStatus",
  "policy",
  "totalRetainedCount",
  "records",
  "hasMore",
] as const;
const storedCandidateKeys = [
  "recordId",
  "expectedRecordRevision",
  "createdAt",
  "lifecycleState",
  "deletedAt",
  "recordPosition",
] as const;
const protectionKeys = ["recordId", "isHeld", "isProtected"] as const;

const sameIdentifier = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const sameNullableIdentifier = (left: string | null, right: string | null): boolean =>
  left === null || right === null ? left === right : sameIdentifier(left, right);

const parseJsonSafeNonnegativeInteger = (candidate: unknown): number | undefined =>
  typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
    ? candidate
    : undefined;

const parseStoredLifecyclePreview = (candidate: unknown): StoredLifecyclePreview | undefined => {
  if (!isPlainObject(candidate) || !hasOnlyKeys(candidate, storedPreviewKeys)) return undefined;

  if (candidate.policyStatus === "unavailable") {
    if (
      candidate.policy !== null ||
      candidate.totalRetainedCount !== 0 ||
      !Array.isArray(candidate.records) ||
      candidate.records.length !== 0 ||
      candidate.hasMore !== false
    ) {
      return undefined;
    }
    return {
      policyStatus: "unavailable",
      policy: null,
      totalRetainedCount: 0,
      records: [],
      hasMore: false,
    };
  }

  if (candidate.policyStatus !== "available" || typeof candidate.hasMore !== "boolean") {
    return undefined;
  }
  const policy = recordTypeLifecyclePolicySchema.safeParse(candidate.policy);
  const totalRetainedCount = parseJsonSafeNonnegativeInteger(candidate.totalRetainedCount);
  if (!policy.success || totalRetainedCount === undefined || !Array.isArray(candidate.records)) {
    return undefined;
  }

  const records: LifecyclePreviewStoredCandidate[] = [];
  const seenRecordIds = new Set<string>();
  let previousPosition = 0;
  let previousCreatedAt = Number.NEGATIVE_INFINITY;
  let previousRecordId = "";
  for (const itemCandidate of candidate.records) {
    if (!isPlainObject(itemCandidate) || !hasOnlyKeys(itemCandidate, storedCandidateKeys)) {
      return undefined;
    }
    const recordId = recordIdSchema.safeParse(itemCandidate.recordId);
    const expectedRecordRevision = revisionSchema
      .max(Number.MAX_SAFE_INTEGER)
      .safeParse(itemCandidate.expectedRecordRevision);
    const createdAt = timestampSchema.safeParse(itemCandidate.createdAt);
    const deletedAt =
      itemCandidate.deletedAt === null
        ? { success: true as const, data: null }
        : timestampSchema.safeParse(itemCandidate.deletedAt);
    const recordPosition = parseJsonSafeNonnegativeInteger(itemCandidate.recordPosition);
    if (
      !recordId.success ||
      !expectedRecordRevision.success ||
      !createdAt.success ||
      !deletedAt.success ||
      recordPosition === undefined ||
      recordPosition === 0 ||
      !["active", "soft_deleted", "removal_pending"].includes(
        String(itemCandidate.lifecycleState),
      ) ||
      (itemCandidate.lifecycleState === "active") !== (deletedAt.data === null)
    ) {
      return undefined;
    }
    const canonicalRecordId = recordId.data.toLowerCase();
    const createdAtTime = Date.parse(createdAt.data);
    if (
      seenRecordIds.has(canonicalRecordId) ||
      recordPosition > totalRetainedCount ||
      (previousPosition !== 0 && recordPosition !== previousPosition + 1) ||
      createdAtTime < previousCreatedAt ||
      (createdAtTime === previousCreatedAt && canonicalRecordId <= previousRecordId)
    ) {
      return undefined;
    }
    seenRecordIds.add(canonicalRecordId);
    previousPosition = recordPosition;
    previousCreatedAt = createdAtTime;
    previousRecordId = canonicalRecordId;
    records.push({
      recordId: recordId.data,
      expectedRecordRevision: expectedRecordRevision.data,
      createdAt: createdAt.data,
      lifecycleState: itemCandidate.lifecycleState as LifecyclePreviewStoredCandidate["lifecycleState"],
      deletedAt: deletedAt.data,
      recordPosition,
    });
  }
  if (
    (candidate.hasMore && records.length === 0) ||
    (records.length > 0 &&
      (candidate.hasMore
        ? previousPosition >= totalRetainedCount
        : previousPosition !== totalRetainedCount))
  ) {
    return undefined;
  }

  return {
    policyStatus: "available",
    policy: policy.data,
    totalRetainedCount,
    records,
    hasMore: candidate.hasMore,
  };
};

const parseCandidateProtections = (
  candidate: unknown,
  records: readonly LifecyclePreviewStoredCandidate[],
): readonly LifecycleCandidateRecord[] | undefined => {
  if (!Array.isArray(candidate) || candidate.length !== records.length) return undefined;
  const evidence = new Map<string, Readonly<{ isHeld: boolean; isProtected: boolean }>>();
  for (const item of candidate) {
    if (
      !isPlainObject(item) ||
      !hasOnlyKeys(item, protectionKeys) ||
      typeof item.isHeld !== "boolean" ||
      typeof item.isProtected !== "boolean"
    ) {
      return undefined;
    }
    const recordId = recordIdSchema.safeParse(item.recordId);
    if (!recordId.success || evidence.has(recordId.data.toLowerCase())) return undefined;
    evidence.set(recordId.data.toLowerCase(), {
      isHeld: item.isHeld,
      isProtected: item.isProtected,
    });
  }

  const resolved: LifecycleCandidateRecord[] = [];
  for (const record of records) {
    const protection = evidence.get(record.recordId.toLowerCase());
    if (protection === undefined) return undefined;
    const parsed = lifecycleCandidateRecordSchema.safeParse({
      recordId: record.recordId,
      expectedRecordRevision: record.expectedRecordRevision,
      createdAt: record.createdAt,
      isHeld: protection.isHeld,
      isProtected: protection.isProtected,
    });
    if (!parsed.success) return undefined;
    resolved.push(parsed.data);
  }
  return resolved;
};

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
  if (typeof dependencies.resolveCandidateProtections !== "function") {
    throw new Error("LIFECYCLE_PREVIEW_PROTECTION_RESOLVER_REQUIRED");
  }
  if (
    typeof dependencies.cursorCodec?.encode !== "function" ||
    typeof dependencies.cursorCodec.decode !== "function"
  ) {
    throw new Error("LIFECYCLE_PREVIEW_CURSOR_CODEC_REQUIRED");
  }

  return Object.freeze({
    async preview(
      session: IdentitySession,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<RecordLifecyclePreviewResult>> {
      const command = parseRecordLifecyclePreviewCommand(commandCandidate);
      if (command === undefined) return { kind: "unavailable" };
      let decodedCursor: LifecyclePreviewCursor | undefined;
      if (command.cursor !== undefined) {
        try {
          decodedCursor = parseDecodedLifecyclePreviewCursor(
            dependencies.cursorCodec.decode(command.cursor),
          );
        } catch {
          return { kind: "temporarily_unavailable" };
        }
        if (decodedCursor === undefined) return { kind: "unavailable" };
      }

      const selection: OrganizationSelectionCandidate =
        command.applicationRootId === null
          ? { organizationId: command.organizationId }
          : {
              organizationId: command.organizationId,
              applicationRootId: command.applicationRootId,
            };

      return requests.run(session, selection, async (transaction, scope, issuedAt) => {
        const cursor = decodedCursor;
        if (
          command.cursor !== undefined &&
          (cursor === undefined ||
            !sameIdentifier(cursor.organizationId, command.organizationId) ||
            !sameIdentifier(cursor.storageContractId, command.storageContractId) ||
            !sameNullableIdentifier(cursor.applicationRootId, command.applicationRootId))
        ) {
          throw new Error("INVALID_LIFECYCLE_PREVIEW_CURSOR");
        }

        const afterCreatedAt = cursor?.afterCreatedAt ?? null;
        const afterRecordId = cursor?.afterRecordId ?? null;

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

        const previewData = parseStoredLifecyclePreview(rows[0].result);
        if (previewData === undefined) {
          throw new Error("LIFECYCLE_PREVIEW_STORAGE_UNAVAILABLE");
        }

        if (previewData.policyStatus === "unavailable") {
          if (cursor !== undefined) throw new Error("LIFECYCLE_PREVIEW_CONTINUATION_STALE");
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

        const policy = previewData.policy;
        if (
          !sameIdentifier(policy.organizationId, scope.organizationId) ||
          !sameIdentifier(policy.organizationId, command.organizationId) ||
          !sameIdentifier(policy.storageContractId, command.storageContractId) ||
          !sameNullableIdentifier(policy.applicationRootId, command.applicationRootId) ||
          (cursor !== undefined &&
            (!sameIdentifier(cursor.policyId, policy.policyId) ||
              cursor.policyRevision !== policy.policyRevision ||
              cursor.totalRetainedCount !== previewData.totalRetainedCount))
        ) {
          throw new Error("LIFECYCLE_PREVIEW_SCOPE_OR_POLICY_MISMATCH");
        }

        const firstStoredRecord = previewData.records[0];
        const recordOffset = firstStoredRecord?.recordPosition
          ? firstStoredRecord.recordPosition - 1
          : 0;
        if (
          (cursor === undefined && firstStoredRecord !== undefined && recordOffset !== 0) ||
          (cursor === undefined &&
            firstStoredRecord === undefined &&
            previewData.totalRetainedCount !== 0) ||
          (cursor !== undefined &&
            (firstStoredRecord === undefined ||
              recordOffset !== cursor.afterRecordPosition)) ||
          (previewData.hasMore && previewData.records.length !== limit) ||
          previewData.records.length > limit
        ) {
          throw new Error("LIFECYCLE_PREVIEW_CONTINUATION_STALE");
        }

        const evaluatedAt = cursor?.evaluatedAt ?? timestampSchema.parse(issuedAt);
        const protectionCandidate = await dependencies.resolveCandidateProtections({
          transaction,
          organizationId: scope.organizationId,
          storageContractId: policy.storageContractId,
          applicationRootId: policy.applicationRootId,
          evaluatedAt,
          records: previewData.records,
        });
        const candidatesToEvaluate = parseCandidateProtections(
          protectionCandidate,
          previewData.records,
        );
        if (candidatesToEvaluate === undefined) {
          throw new Error("LIFECYCLE_PREVIEW_PROTECTION_EVIDENCE_INVALID");
        }

        const handoff = recordLifecycleHandoffSchema.parse(selectDueRecordsForLifecycleHandoff({
          policy,
          records: candidatesToEvaluate,
          evaluatedAt,
          totalRetainedCount: previewData.totalRetainedCount,
          recordOffset,
        }));

        let continuation: LifecyclePreviewContinuation;
        if (previewData.hasMore) {
          const lastStoredRecord = previewData.records.at(-1);
          if (lastStoredRecord === undefined) {
            throw new Error("LIFECYCLE_PREVIEW_STORAGE_UNAVAILABLE");
          }
          const next: LifecyclePreviewCursor = {
            afterCreatedAt: lastStoredRecord.createdAt,
            afterRecordId: lastStoredRecord.recordId,
            afterRecordPosition: lastStoredRecord.recordPosition,
            organizationId: policy.organizationId,
            storageContractId: policy.storageContractId,
            applicationRootId: policy.applicationRootId,
            policyId: policy.policyId,
            policyRevision: policy.policyRevision,
            evaluatedAt,
            totalRetainedCount: previewData.totalRetainedCount,
          };
          const nextCursor = dependencies.cursorCodec.encode(next);
          if (
            typeof nextCursor !== "string" ||
            nextCursor.length === 0 ||
            nextCursor.length > 4096
          ) {
            throw new Error("LIFECYCLE_PREVIEW_CURSOR_CODEC_UNAVAILABLE");
          }
          continuation = {
            hasMore: true,
            next,
            nextCursor,
          };
        } else {
          continuation = { hasMore: false };
        }

        return {
          policyStatus: "available" as const,
          policy,
          handoff,
          candidates: candidatesToEvaluate,
          dueRecords: handoff.dueRecords,
          blockedRecords: handoff.blockedRecords,
          totalRetainedCount: previewData.totalRetainedCount,
          continuation,
        };
      });
    },
  });
};
