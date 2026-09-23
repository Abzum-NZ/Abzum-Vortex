import "server-only";

import {
  applicationRootIdSchema,
  fieldIdSchema,
  organizationIdSchema,
  recordIdSchema,
  timestampSchema,
} from "@vortex/contracts";
import {
  claimRecordDeadlineRefresh,
  closeRecordDeadlineTransition,
  type ClaimRecordDeadlineRefreshInput,
  type DeadlineClosureConflictReasonCode,
  type DeadlineClosureRefusalReasonCode,
  type DeadlineClosureServiceDependencies,
  type DeadlineRefreshConflictReasonCode,
  type DeadlineRefreshRefusalReasonCode,
  type PendingDeadlineTransitionV2,
} from "@vortex/record";

export const deadlineRefreshDispatchLimits = Object.freeze({
  /** Due records refreshed by one dispatch when the caller names no limit. */
  defaultBatchLimit: 25,
  /** Absolute ceiling on due records refreshed by one dispatch. */
  maximumBatchLimit: 100,
});

export const deadlineRefreshDispatchErrorCodes = [
  "INVALID_DEADLINE_REFRESH_INPUT",
  "DEADLINE_REFRESH_WORKER_TRANSACTION_REQUIRED",
] as const;

export type DeadlineRefreshDispatchErrorCode =
  (typeof deadlineRefreshDispatchErrorCodes)[number];

export class DeadlineRefreshDispatchError extends Error {
  readonly code: DeadlineRefreshDispatchErrorCode;

  constructor(code: DeadlineRefreshDispatchErrorCode) {
    super(code);
    this.name = "DeadlineRefreshDispatchError";
    this.code = code;
  }
}

/** The transaction Record's deadline claim and closure operations run in. */
export type DeadlineRefreshTransaction = Parameters<typeof claimRecordDeadlineRefresh>[0];

/**
 * Opens one fresh transaction on the configured deadline worker connection and
 * commits it when `operation` resolves (rolls back when it throws).
 *
 * Record binds each claim to the worker's login role (`session_user`) and
 * establishes one immutable System context per transaction, so every call must
 * be a new transaction on that worker login. A human request transaction or a
 * reused transaction already carries a context and every claim in it returns
 * `context_already_established`.
 */
export type DeadlineRefreshWorkerTransactionRunner = <Result>(
  operation: (transaction: DeadlineRefreshTransaction) => Promise<Result>,
) => Promise<Result>;

export type DeadlineRefreshDispatchDependencies = Readonly<{
  runWorkerTransaction: DeadlineRefreshWorkerTransactionRunner;
}> &
  DeadlineClosureServiceDependencies;

export type DeadlineRefreshDueWindow = Readonly<{
  /**
   * Records whose transition is at or before this instant are due. A ceiling
   * that is not yet in the past is replaced by the database's own statement
   * time, so a dispatch never claims a transition before it is due.
   */
  dueBefore?: string;
  /** Maximum due records refreshed by this dispatch. */
  batchLimit?: number;
}>;

/**
 * Omit every scope to process all due work assigned to the worker login.
 * `organizationId` alone selects that organisation's shared records;
 * add `applicationRootId` for one Application's contained records and
 * `recordId` for one record.
 */
export type DeadlineRefreshDispatchInput = Readonly<{
  /**
   * Record's earliest pending transition for the dispatched scope, when the
   * caller knows it. `null` means nothing is pending; a transition after the
   * due ceiling means nothing is due yet. Neither case touches the database.
   */
  earliestPendingDeadlineTransition?: PendingDeadlineTransitionV2 | null;
  dueWindow?: DeadlineRefreshDueWindow;
  organizationId?: string;
  applicationRootId?: string;
  recordId?: string;
}>;

/** Exact due and revision identity Record claimed for one record. */
export type DeadlineRefreshItemIdentity = Readonly<{
  organizationId: string;
  applicationRootId?: string;
  storageContractId: string;
  recordTypeId: string;
  recordId: string;
  claimedConcurrencyNumber: number;
  calculationFieldId: string;
  transitionAt: string;
  effectId: string;
}>;

export type DeadlineRefreshItemResult = DeadlineRefreshItemIdentity &
  (
    | Readonly<{ outcome: "refreshed"; concurrencyNumber: number; replayed: boolean }>
    | Readonly<{ outcome: "conflict"; reasonCode: DeadlineClosureConflictReasonCode }>
    | Readonly<{ outcome: "refused"; reasonCode: DeadlineClosureRefusalReasonCode }>
  );

/**
 * Why a dispatch stopped before draining its due set or reaching its limit.
 * Claims select the earliest due row, so the row that stopped this dispatch
 * would be selected again; the next scheduled dispatch retries it.
 */
export type DeadlineRefreshStop =
  | Readonly<{ stage: "claim"; outcome: "conflict"; reasonCode: DeadlineRefreshConflictReasonCode }>
  | Readonly<{
      stage: "claim";
      outcome: "refused";
      reasonCode: DeadlineRefreshRefusalReasonCode;
      state?: "disabled" | "revoked";
    }>
  | Readonly<{ stage: "closure"; outcome: "conflict" | "refused" }>
  | Readonly<{ stage: "repeated_claim" }>;

export type DeadlineRefreshDispatchResult =
  | Readonly<{
      /** Nothing was due; `nextDueAt` is set when a later transition is pending. */
      status: "idle";
      nextDueAt?: string;
      items: readonly DeadlineRefreshItemResult[];
    }>
  | Readonly<{ status: "drained"; items: readonly DeadlineRefreshItemResult[] }>
  | Readonly<{
      /** The batch limit was reached; more due work may remain. */
      status: "limit_reached";
      items: readonly DeadlineRefreshItemResult[];
    }>
  | Readonly<{
      status: "stopped";
      stop: DeadlineRefreshStop;
      items: readonly DeadlineRefreshItemResult[];
    }>;

export interface DeadlineRefreshDispatcher {
  dispatch(inputCandidate?: unknown): Promise<DeadlineRefreshDispatchResult>;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const invalidInput = (): DeadlineRefreshDispatchError =>
  new DeadlineRefreshDispatchError("INVALID_DEADLINE_REFRESH_INPUT");

/** Epoch milliseconds of a validated timestamp; sub-millisecond digits are truncated. */
const instantMilliseconds = (timestamp: string): number =>
  Date.parse(timestamp.replace(/(\.\d{3})\d+/, "$1"));

const parseTimestamp = (candidate: unknown): string => {
  const parsed = timestampSchema.safeParse(candidate);
  if (!parsed.success || !Number.isFinite(instantMilliseconds(parsed.data))) throw invalidInput();
  return parsed.data;
};

const parseEarliestTransition = (candidate: unknown): PendingDeadlineTransitionV2 | null => {
  if (candidate === null) return null;
  if (!isObject(candidate) || !hasOnlyKeys(candidate, ["calculationFieldId", "transitionAt"]))
    throw invalidInput();
  const calculationFieldId = fieldIdSchema.safeParse(candidate.calculationFieldId);
  if (!calculationFieldId.success) throw invalidInput();
  return {
    calculationFieldId: calculationFieldId.data,
    transitionAt: parseTimestamp(candidate.transitionAt),
  };
};

const parseBatchLimit = (candidate: unknown): number => {
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > deadlineRefreshDispatchLimits.maximumBatchLimit
  )
    throw invalidInput();
  return candidate;
};

type ValidatedDispatchInput = Readonly<{
  earliestPendingDeadlineTransition?: PendingDeadlineTransitionV2 | null;
  dueBefore?: string;
  batchLimit: number;
  organizationId?: string;
  applicationRootId?: string;
  recordId?: string;
}>;

const validateDispatchInput = (candidate: unknown): ValidatedDispatchInput => {
  if (candidate === undefined)
    return { batchLimit: deadlineRefreshDispatchLimits.defaultBatchLimit };
  if (
    !isObject(candidate) ||
    !hasOnlyKeys(candidate, [
      "earliestPendingDeadlineTransition",
      "dueWindow",
      "organizationId",
      "applicationRootId",
      "recordId",
    ])
  )
    throw invalidInput();

  const dueWindow = candidate.dueWindow;
  if (
    dueWindow !== undefined &&
    (!isObject(dueWindow) || !hasOnlyKeys(dueWindow, ["dueBefore", "batchLimit"]))
  )
    throw invalidInput();

  const parseId = (
    schema: { safeParse(value: unknown): { success: boolean } },
    value: unknown,
  ): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !schema.safeParse(value).success) throw invalidInput();
    return value;
  };
  const organizationId = parseId(organizationIdSchema, candidate.organizationId);
  const applicationRootId = parseId(applicationRootIdSchema, candidate.applicationRootId);
  const recordId = parseId(recordIdSchema, candidate.recordId);
  if ((recordId !== undefined || applicationRootId !== undefined) && organizationId === undefined)
    throw invalidInput();

  const earliestPendingDeadlineTransition =
    candidate.earliestPendingDeadlineTransition === undefined
      ? undefined
      : parseEarliestTransition(candidate.earliestPendingDeadlineTransition);
  const dueBefore =
    dueWindow?.dueBefore === undefined ? undefined : parseTimestamp(dueWindow.dueBefore);
  const batchLimit =
    dueWindow?.batchLimit === undefined
      ? deadlineRefreshDispatchLimits.defaultBatchLimit
      : parseBatchLimit(dueWindow.batchLimit);

  return {
    ...(earliestPendingDeadlineTransition === undefined
      ? {}
      : { earliestPendingDeadlineTransition }),
    ...(dueBefore === undefined ? {} : { dueBefore }),
    batchLimit,
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(applicationRootId === undefined ? {} : { applicationRootId }),
    ...(recordId === undefined ? {} : { recordId }),
  };
};

type StepResult =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "stop"; stop: DeadlineRefreshStop; item?: DeadlineRefreshItemResult }>
  | Readonly<{ kind: "refreshed"; item: DeadlineRefreshItemResult }>;

/**
 * Refreshes due records one at a time, each claimed and closed by Record's
 * owning deadline operations in its own worker transaction. Record supplies
 * every identity and revision and revalidates them under lock, so a record
 * changed since its due row was written is refused as stale rather than
 * refreshed. Each closed record commits before the next claim; a conflict or
 * refusal stops the dispatch with everything already committed intact, and an
 * unexpected failure rolls back only the current record's transaction before
 * it propagates.
 */
const runDispatch = async (
  dependencies: DeadlineRefreshDispatchDependencies,
  closureDependencies: DeadlineClosureServiceDependencies,
  input: ValidatedDispatchInput,
): Promise<DeadlineRefreshDispatchResult> => {
  const now = Date.now();
  const requestedCeiling =
    input.dueBefore === undefined ? undefined : instantMilliseconds(input.dueBefore);
  const pastCeiling =
    requestedCeiling !== undefined && requestedCeiling < now ? input.dueBefore : undefined;
  const ceiling = Math.min(requestedCeiling ?? now, now);

  const earliest = input.earliestPendingDeadlineTransition;
  if (earliest === null) return { status: "idle", items: [] };
  if (earliest !== undefined && instantMilliseconds(earliest.transitionAt) > ceiling)
    return { status: "idle", nextDueAt: earliest.transitionAt, items: [] };

  const claimInput: ClaimRecordDeadlineRefreshInput = {
    ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
    ...(input.applicationRootId === undefined
      ? {}
      : { applicationRootId: input.applicationRootId }),
    ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
    ...(pastCeiling === undefined ? {} : { dueBefore: pastCeiling }),
  };

  const items: DeadlineRefreshItemResult[] = [];
  const claimedEffects = new Set<string>();

  while (items.length < input.batchLimit) {
    const step = await dependencies.runWorkerTransaction<StepResult>(async (transaction) => {
      const claim = await claimRecordDeadlineRefresh(transaction, claimInput);
      if (claim.outcome === "none") return { kind: "none" };
      if (claim.outcome === "conflict")
        return {
          kind: "stop",
          stop: { stage: "claim", outcome: "conflict", reasonCode: claim.reasonCode },
        };
      if (claim.outcome === "refused")
        return {
          kind: "stop",
          stop: {
            stage: "claim",
            outcome: "refused",
            reasonCode: claim.reasonCode,
            ...(claim.state === undefined ? {} : { state: claim.state }),
          },
        };

      // A closed transition retires its due row, so claiming the same effect
      // again means this dispatch would only repeat itself.
      if (claimedEffects.has(claim.effectIdentity))
        return { kind: "stop", stop: { stage: "repeated_claim" } };
      claimedEffects.add(claim.effectIdentity);

      const identity: DeadlineRefreshItemIdentity = {
        organizationId: claim.root.organizationId,
        ...(claim.root.applicationRootId === undefined
          ? {}
          : { applicationRootId: claim.root.applicationRootId }),
        storageContractId: claim.root.storageContractId,
        recordTypeId: claim.root.recordTypeId,
        recordId: claim.root.recordId,
        claimedConcurrencyNumber: claim.root.concurrencyNumber,
        calculationFieldId: claim.effect.calculationFieldId,
        transitionAt: claim.effect.transitionAt,
        effectId: claim.effectId,
      };
      const closure = await closeRecordDeadlineTransition(
        transaction,
        claim,
        closureDependencies,
      );
      if (closure.outcome === "closed")
        return {
          kind: "refreshed",
          item: {
            ...identity,
            outcome: "refreshed",
            concurrencyNumber: closure.concurrencyNumber,
            replayed: closure.replayed,
          },
        };
      return {
        kind: "stop",
        stop: { stage: "closure", outcome: closure.outcome },
        item:
          closure.outcome === "conflict"
            ? { ...identity, outcome: "conflict", reasonCode: closure.reasonCode }
            : { ...identity, outcome: "refused", reasonCode: closure.reasonCode },
      };
    });

    if (step.kind === "none")
      return items.length === 0 ? { status: "idle", items } : { status: "drained", items };
    if (step.kind === "stop") {
      if (step.item !== undefined) items.push(step.item);
      return { status: "stopped", stop: step.stop, items };
    }
    items.push(step.item);
  }

  return { status: "limit_reached", items };
};

/**
 * Creates the bounded deadline refresh dispatcher for the configured deadline
 * worker. It never derives identities, revisions or authority itself.
 */
export const createDeadlineRefreshDispatcher = (
  dependencies: DeadlineRefreshDispatchDependencies,
): DeadlineRefreshDispatcher => {
  if (!isObject(dependencies) || typeof dependencies.runWorkerTransaction !== "function")
    throw new DeadlineRefreshDispatchError("DEADLINE_REFRESH_WORKER_TRANSACTION_REQUIRED");
  const closureDependencies: DeadlineClosureServiceDependencies = {
    ...(dependencies.activityId === undefined ? {} : { activityId: dependencies.activityId }),
    ...(dependencies.occurrenceId === undefined
      ? {}
      : { occurrenceId: dependencies.occurrenceId }),
  };
  return Object.freeze({
    async dispatch(inputCandidate?: unknown): Promise<DeadlineRefreshDispatchResult> {
      return runDispatch(dependencies, closureDependencies, validateDispatchInput(inputCandidate));
    },
  });
};

/** Dispatches one bounded batch of due deadline refreshes. */
export const dispatchDeadlineRefresh = async (
  dependencies: DeadlineRefreshDispatchDependencies,
  inputCandidate?: unknown,
): Promise<DeadlineRefreshDispatchResult> =>
  createDeadlineRefreshDispatcher(dependencies).dispatch(inputCandidate);
