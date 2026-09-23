import "server-only";

import {
  applicationRootIdSchema,
  fieldIdSchema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  timestampSchema,
} from "@vortex/contracts";
import {
  claimRecordDeadlineRefresh,
  closeRecordDeadlineTransition,
  type ClaimedRecordDeadlineRefresh,
  type DeadlineClosureServiceDependencies,
  type PendingDeadlineTransitionV2,
} from "@vortex/record";

export const deadlineRefreshDispatchLimits = Object.freeze({
  /** Default maximum number of due records refreshed in one dispatch batch. */
  defaultBatchLimit: 25,
  /** Absolute ceiling on the batch size processed in one dispatch. */
  maximumBatchLimit: 100,
  /** Default due window duration in seconds (1 minute). */
  defaultDueWindowSeconds: 60,
  /** Maximum allowable due window duration in seconds (24 hours). */
  maximumDueWindowSeconds: 86_400,
  /** Maximum consecutive conflicts before terminating the dispatch wave to prevent spinning. */
  maximumConsecutiveConflicts: 5,
});

export const deadlineRefreshDispatchErrorCodes = [
  "INVALID_DEADLINE_REFRESH_INPUT",
  "DEADLINE_REFRESH_TRANSACTION_REQUIRED",
] as const;

export type DeadlineRefreshDispatchErrorCode =
  (typeof deadlineRefreshDispatchErrorCodes)[number];

export class DeadlineRefreshDispatchError extends Error {
  readonly code: DeadlineRefreshDispatchErrorCode;

  constructor(code: DeadlineRefreshDispatchErrorCode, message?: string) {
    super(message ?? code);
    this.name = "DeadlineRefreshDispatchError";
    this.code = code;
  }
}

/**
 * The underlying transaction type accepted by Record's deadline claim and closure operations.
 */
export type DeadlineRefreshTransaction = Parameters<typeof claimRecordDeadlineRefresh>[0];

/**
 * Runs one database transaction. Each due record claim and closure runs in its
 * own isolated transaction so completed records commit durably and stale or busy
 * records do not block or roll back progress across the batch.
 */
export type DeadlineRefreshTransactionRunner = <Result>(
  operation: (transaction: DeadlineRefreshTransaction) => Promise<Result>,
) => Promise<Result>;

export type DeadlineRefreshDispatchDependencies = Readonly<{
  /** Transaction runner for discrete, isolated transactional steps. */
  runTransaction?: DeadlineRefreshTransactionRunner;
  /** Direct transaction for executing within an existing transaction boundary. */
  transaction?: DeadlineRefreshTransaction;
  /** Optional custom Activity ID generator for deadline closure audit trail. */
  activityId?: () => string;
  /** Optional custom Event occurrence ID generator for deadline closure standard events. */
  occurrenceId?: () => string;
}>;

/**
 * Bounded due window specifying timestamp ceiling, window lookahead and batch size.
 */
export type DeadlineRefreshDueWindow = Readonly<{
  /** Maximum due timestamp ceiling (ISO 8601). Records due at or before this instant are eligible. */
  dueBefore?: string;
  /** Window lookahead duration in seconds from now. */
  windowSeconds?: number;
  /** Upper bound on records processed in this window. */
  batchLimit?: number;
  /** Optional lower bound timestamp (ISO 8601). */
  dueAfter?: string;
}>;

/**
 * Input for bounded deadline refresh dispatch: combines an existing earliest pending
 * deadline transition with a bounded due window and optional tenant/record scoping.
 */
export type DeadlineRefreshDispatchInput = Readonly<{
  /** The existing earliest pending deadline transition derived by Record. */
  earliestPendingDeadlineTransition?: PendingDeadlineTransitionV2 | null;
  /** Bounded due window. */
  dueWindow?: DeadlineRefreshDueWindow;
  /** Explicit due timestamp ceiling (ISO 8601). Defaults to dueWindow.dueBefore or statement time. */
  dueBefore?: string;
  /** Maximum number of records to process in this bounded batch. */
  batchLimit?: number;
  /** Optional organisation scope. */
  organizationId?: string;
  /** Optional application root scope. */
  applicationRootId?: string;
  /** Optional specific record target. */
  recordId?: string;
}>;

export type DeadlineRefreshRecordOutcome =
  | "refreshed"
  | "conflict"
  | "refused"
  | "skipped_duplicate";

export type DeadlineRefreshItemResult = Readonly<{
  recordId?: string;
  recordTypeId?: string;
  storageContractId?: string;
  organizationId?: string;
  applicationRootId?: string;
  concurrencyNumber?: number;
  calculationFieldId?: string;
  transitionAt?: string;
  outcome: DeadlineRefreshRecordOutcome;
  replayed?: boolean;
  nextDeadline?: PendingDeadlineTransitionV2 | null;
  reasonCode?: string;
}>;

export type DeadlineRefreshDispatchStatus =
  | "completed"
  | "idle"
  | "partial_conflict"
  | "refused";

export type DeadlineRefreshDispatchResult = Readonly<{
  status: DeadlineRefreshDispatchStatus;
  claimedCount: number;
  refreshedCount: number;
  conflictCount: number;
  refusedCount: number;
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

const parsePendingDeadlineTransition = (
  candidate: unknown,
): PendingDeadlineTransitionV2 | null | undefined => {
  if (candidate === undefined) return undefined;
  if (candidate === null) return null;
  if (!isObject(candidate)) return undefined;
  if (!hasOnlyKeys(candidate, ["calculationFieldId", "transitionAt"])) return undefined;

  const calculationFieldId = fieldIdSchema.safeParse(candidate.calculationFieldId);
  const transitionAt = timestampSchema.safeParse(candidate.transitionAt);
  if (!calculationFieldId.success || !transitionAt.success) return undefined;

  return Object.freeze({
    calculationFieldId: calculationFieldId.data,
    transitionAt: transitionAt.data,
  });
};

const parseDueWindow = (candidate: unknown): DeadlineRefreshDueWindow | undefined => {
  if (candidate === undefined) return undefined;
  if (!isObject(candidate)) return undefined;
  if (!hasOnlyKeys(candidate, ["dueBefore", "dueAfter", "windowSeconds", "batchLimit"]))
    return undefined;

  let dueBefore: string | undefined;
  let dueAfter: string | undefined;
  let windowSeconds: number | undefined;
  let batchLimit: number | undefined;

  if (candidate.dueBefore !== undefined) {
    const parsed = timestampSchema.safeParse(candidate.dueBefore);
    if (!parsed.success) return undefined;
    dueBefore = parsed.data;
  }
  if (candidate.dueAfter !== undefined) {
    const parsed = timestampSchema.safeParse(candidate.dueAfter);
    if (!parsed.success) return undefined;
    dueAfter = parsed.data;
  }
  if (candidate.windowSeconds !== undefined) {
    if (
      typeof candidate.windowSeconds !== "number" ||
      !Number.isSafeInteger(candidate.windowSeconds) ||
      candidate.windowSeconds < 1 ||
      candidate.windowSeconds > deadlineRefreshDispatchLimits.maximumDueWindowSeconds
    )
      return undefined;
    windowSeconds = candidate.windowSeconds;
  }
  if (candidate.batchLimit !== undefined) {
    if (
      typeof candidate.batchLimit !== "number" ||
      !Number.isSafeInteger(candidate.batchLimit) ||
      candidate.batchLimit < 1 ||
      candidate.batchLimit > deadlineRefreshDispatchLimits.maximumBatchLimit
    )
      return undefined;
    batchLimit = candidate.batchLimit;
  }

  return Object.freeze({
    ...(dueBefore !== undefined ? { dueBefore } : {}),
    ...(dueAfter !== undefined ? { dueAfter } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(batchLimit !== undefined ? { batchLimit } : {}),
  });
};

type ValidatedDispatchInput = Readonly<{
  earliestPendingDeadlineTransition?: PendingDeadlineTransitionV2 | null;
  dueBefore: string;
  batchLimit: number;
  organizationId?: string;
  applicationRootId?: string;
  recordId?: string;
}>;

const validateDispatchInput = (candidate: unknown): ValidatedDispatchInput => {
  if (candidate === undefined || candidate === null) {
    return {
      dueBefore: new Date().toISOString(),
      batchLimit: deadlineRefreshDispatchLimits.defaultBatchLimit,
    };
  }
  if (!isObject(candidate)) {
    throw new DeadlineRefreshDispatchError("INVALID_DEADLINE_REFRESH_INPUT");
  }

  const allowedKeys = [
    "earliestPendingDeadlineTransition",
    "dueWindow",
    "dueBefore",
    "batchLimit",
    "organizationId",
    "applicationRootId",
    "recordId",
  ];
  if (!hasOnlyKeys(candidate, allowedKeys)) {
    throw new DeadlineRefreshDispatchError("INVALID_DEADLINE_REFRESH_INPUT");
  }

  const earliestPendingDeadlineTransition =
    candidate.earliestPendingDeadlineTransition !== undefined
      ? parsePendingDeadlineTransition(candidate.earliestPendingDeadlineTransition)
      : undefined;
  if (
    candidate.earliestPendingDeadlineTransition !== undefined &&
    earliestPendingDeadlineTransition === undefined
  ) {
    throw new DeadlineRefreshDispatchError("INVALID_DEADLINE_REFRESH_INPUT");
  }

  const dueWindow =
    candidate.dueWindow !== undefined ? parseDueWindow(candidate.dueWindow) : undefined;
  if (candidate.dueWindow !== undefined && dueWindow === undefined) {
    throw new DeadlineRefreshDispatchError("INVALID_DEADLINE_REFRESH_INPUT");
  }

  let explicitDueBefore: string | undefined;
  if (candidate.dueBefore !== undefined) {
    const parsed = timestampSchema.safeParse(candidate.dueBefore);
    if (!parsed.success) {
      throw new DeadlineRefreshDispatchError("INVALID_DEADLINE_REFRESH_INPUT");
    }
    explicitDueBefore = parsed.data;
  }

  let explicitBatchLimit: number | undefined;
  if (candidate.batchLimit !== undefined) {
    if (
      typeof candidate.batchLimit !== "number" ||
      !Number.isSafeInteger(candidate.batchLimit) ||
      candidate.batchLimit < 1 ||
      candidate.batchLimit > deadlineRefreshDispatchLimits.maximumBatchLimit
    ) {
      throw new DeadlineRefreshDispatchError("INVALID_DEADLINE_REFRESH_INPUT");
    }
    explicitBatchLimit = candidate.batchLimit;
  }

  let organizationId: string | undefined;
  if (candidate.organizationId !== undefined) {
    const parsed = organizationIdSchema.safeParse(candidate.organizationId);
    if (!parsed.success) {
      throw new DeadlineRefreshDispatchError("INVALID_DEADLINE_REFRESH_INPUT");
    }
    organizationId = parsed.data;
  }

  let applicationRootId: string | undefined;
  if (candidate.applicationRootId !== undefined) {
    const parsed = applicationRootIdSchema.safeParse(candidate.applicationRootId);
    if (!parsed.success) {
      throw new DeadlineRefreshDispatchError("INVALID_DEADLINE_REFRESH_INPUT");
    }
    applicationRootId = parsed.data;
  }

  let recordId: string | undefined;
  if (candidate.recordId !== undefined) {
    const parsed = recordIdSchema.safeParse(candidate.recordId);
    if (!parsed.success) {
      throw new DeadlineRefreshDispatchError("INVALID_DEADLINE_REFRESH_INPUT");
    }
    recordId = parsed.data;
  }

  if ((recordId !== undefined || applicationRootId !== undefined) && organizationId === undefined) {
    throw new DeadlineRefreshDispatchError("INVALID_DEADLINE_REFRESH_INPUT");
  }

  const batchLimit =
    explicitBatchLimit ?? dueWindow?.batchLimit ?? deadlineRefreshDispatchLimits.defaultBatchLimit;

  let dueBefore: string;
  if (explicitDueBefore !== undefined) {
    dueBefore = explicitDueBefore;
  } else if (dueWindow?.dueBefore !== undefined) {
    dueBefore = dueWindow.dueBefore;
  } else if (dueWindow?.windowSeconds !== undefined) {
    dueBefore = new Date(Date.now() + dueWindow.windowSeconds * 1000).toISOString();
  } else if (
    earliestPendingDeadlineTransition !== undefined &&
    earliestPendingDeadlineTransition !== null
  ) {
    const nowIso = new Date().toISOString();
    dueBefore =
      earliestPendingDeadlineTransition.transitionAt > nowIso
        ? earliestPendingDeadlineTransition.transitionAt
        : nowIso;
  } else {
    dueBefore = new Date().toISOString();
  }

  return Object.freeze({
    ...(earliestPendingDeadlineTransition !== undefined
      ? { earliestPendingDeadlineTransition }
      : {}),
    dueBefore,
    batchLimit,
    ...(organizationId !== undefined ? { organizationId } : {}),
    ...(applicationRootId !== undefined ? { applicationRootId } : {}),
    ...(recordId !== undefined ? { recordId } : {}),
  });
};

/**
 * Private bounded due selector that claims and executes one stable call per due record
 * to the #48 owning refresh operation with exact due/revision identity.
 */
class BoundedDueRefreshExecutor {
  private readonly dependencies: DeadlineRefreshDispatchDependencies;
  private readonly closureDeps: DeadlineClosureServiceDependencies;

  constructor(dependencies: DeadlineRefreshDispatchDependencies) {
    if (dependencies.runTransaction === undefined && dependencies.transaction === undefined) {
      throw new DeadlineRefreshDispatchError("DEADLINE_REFRESH_TRANSACTION_REQUIRED");
    }
    this.dependencies = dependencies;
    this.closureDeps = Object.freeze({
      ...(dependencies.activityId !== undefined ? { activityId: dependencies.activityId } : {}),
      ...(dependencies.occurrenceId !== undefined
        ? { occurrenceId: dependencies.occurrenceId }
        : {}),
    });
  }

  private async runStep<T>(
    operation: (transaction: DeadlineRefreshTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.dependencies.runTransaction !== undefined) {
      return this.dependencies.runTransaction(operation);
    }
    if (this.dependencies.transaction !== undefined) {
      const tx = this.dependencies.transaction;
      await tx.query`savepoint vortex_deadline_refresh_step`;
      try {
        const result = await operation(tx);
        await tx.query`release savepoint vortex_deadline_refresh_step`;
        return result;
      } catch (error) {
        await tx.query`rollback to savepoint vortex_deadline_refresh_step`;
        throw error;
      }
    }
    throw new DeadlineRefreshDispatchError("DEADLINE_REFRESH_TRANSACTION_REQUIRED");
  }

  async execute(input: ValidatedDispatchInput): Promise<DeadlineRefreshDispatchResult> {
    // If the caller provided an earliest pending deadline transition and that transition
    // is strictly after the bounded dueBefore window, no records are due in this window.
    if (
      input.earliestPendingDeadlineTransition !== undefined &&
      input.earliestPendingDeadlineTransition !== null &&
      input.earliestPendingDeadlineTransition.transitionAt > input.dueBefore
    ) {
      return Object.freeze({
        status: "idle",
        claimedCount: 0,
        refreshedCount: 0,
        conflictCount: 0,
        refusedCount: 0,
        items: Object.freeze([]),
      });
    }

    const items: DeadlineRefreshItemResult[] = [];
    const currentWork = new Set<string>();
    let claimedCount = 0;
    let refreshedCount = 0;
    let conflictCount = 0;
    let refusedCount = 0;
    let consecutiveConflicts = 0;

    while (claimedCount < input.batchLimit) {
      if (
        consecutiveConflicts >= deadlineRefreshDispatchLimits.maximumConsecutiveConflicts
      ) {
        break;
      }

      type StepOutcome =
        | Readonly<{ kind: "none" }>
        | Readonly<{ kind: "conflict"; reasonCode: string }>
        | Readonly<{ kind: "refused"; reasonCode: string }>
        | Readonly<{ kind: "skipped_duplicate"; recordId: string }>
        | Readonly<{ kind: "item"; item: DeadlineRefreshItemResult }>;

      const step = await this.runStep<StepOutcome>(async (transaction) => {
        const claimResult = await claimRecordDeadlineRefresh(transaction, {
          ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
          ...(input.applicationRootId !== undefined
            ? { applicationRootId: input.applicationRootId }
            : {}),
          ...(input.recordId !== undefined ? { recordId: input.recordId } : {}),
          dueBefore: input.dueBefore,
        });

        if (claimResult.outcome === "none") {
          return { kind: "none" };
        }

        if (claimResult.outcome === "conflict") {
          return { kind: "conflict", reasonCode: claimResult.reasonCode };
        }

        if (claimResult.outcome === "refused") {
          return { kind: "refused", reasonCode: claimResult.reasonCode };
        }

        const claimed: ClaimedRecordDeadlineRefresh = claimResult;
        const recordKey = `${claimed.root.organizationId}:${claimed.root.recordId}`;

        // Dependency-aware current work tracking: ensure one stable call per due record
        // within the current batch wave.
        if (currentWork.has(recordKey)) {
          return { kind: "skipped_duplicate", recordId: claimed.root.recordId };
        }
        currentWork.add(recordKey);

        const closeResult = await closeRecordDeadlineTransition(
          transaction,
          claimed,
          this.closureDeps,
        );

        if (closeResult.outcome === "closed") {
          return {
            kind: "item",
            item: Object.freeze({
              recordId: claimed.root.recordId,
              recordTypeId: claimed.root.recordTypeId,
              storageContractId: claimed.root.storageContractId,
              organizationId: claimed.root.organizationId,
              ...(claimed.root.applicationRootId !== undefined
                ? { applicationRootId: claimed.root.applicationRootId }
                : {}),
              concurrencyNumber: closeResult.concurrencyNumber,
              calculationFieldId: claimed.effect.calculationFieldId,
              transitionAt: claimed.effect.transitionAt,
              outcome: "refreshed",
              replayed: closeResult.replayed,
              nextDeadline: claimed.recalculatedDeadline ?? null,
            }),
          };
        }

        if (closeResult.outcome === "conflict") {
          return {
            kind: "item",
            item: Object.freeze({
              recordId: claimed.root.recordId,
              recordTypeId: claimed.root.recordTypeId,
              storageContractId: claimed.root.storageContractId,
              organizationId: claimed.root.organizationId,
              ...(claimed.root.applicationRootId !== undefined
                ? { applicationRootId: claimed.root.applicationRootId }
                : {}),
              concurrencyNumber: claimed.root.concurrencyNumber,
              calculationFieldId: claimed.effect.calculationFieldId,
              transitionAt: claimed.effect.transitionAt,
              outcome: "conflict",
              reasonCode: closeResult.reasonCode,
            }),
          };
        }

        return {
          kind: "item",
          item: Object.freeze({
            recordId: claimed.root.recordId,
            recordTypeId: claimed.root.recordTypeId,
            storageContractId: claimed.root.storageContractId,
            organizationId: claimed.root.organizationId,
            ...(claimed.root.applicationRootId !== undefined
              ? { applicationRootId: claimed.root.applicationRootId }
              : {}),
            concurrencyNumber: claimed.root.concurrencyNumber,
            calculationFieldId: claimed.effect.calculationFieldId,
            transitionAt: claimed.effect.transitionAt,
            outcome: "refused",
            reasonCode: closeResult.reasonCode,
          }),
        };
      });

      if (step.kind === "none") {
        break;
      }

      if (step.kind === "conflict") {
        conflictCount += 1;
        consecutiveConflicts += 1;
        items.push(
          Object.freeze({
            outcome: "conflict",
            reasonCode: step.reasonCode,
          }),
        );
        continue;
      }

      if (step.kind === "refused") {
        refusedCount += 1;
        items.push(
          Object.freeze({
            outcome: "refused",
            reasonCode: step.reasonCode,
          }),
        );
        break;
      }

      if (step.kind === "skipped_duplicate") {
        items.push(
          Object.freeze({
            recordId: step.recordId,
            outcome: "skipped_duplicate",
          }),
        );
        break;
      }

      claimedCount += 1;
      consecutiveConflicts = 0;
      items.push(step.item);

      if (step.item.outcome === "refreshed") {
        refreshedCount += 1;
      } else if (step.item.outcome === "conflict") {
        conflictCount += 1;
        consecutiveConflicts += 1;
      } else if (step.item.outcome === "refused") {
        refusedCount += 1;
        break;
      }
    }

    let status: DeadlineRefreshDispatchStatus;
    if (claimedCount === 0 && conflictCount === 0 && refusedCount === 0) {
      status = "idle";
    } else if (refusedCount > 0 && refreshedCount === 0) {
      status = "refused";
    } else if (conflictCount > 0 || refusedCount > 0) {
      status = "partial_conflict";
    } else {
      status = "completed";
    }

    return Object.freeze({
      status,
      claimedCount,
      refreshedCount,
      conflictCount,
      refusedCount,
      items: Object.freeze(items),
    });
  }
}

/**
 * Creates a bounded deadline refresh dispatcher service.
 */
export const createDeadlineRefreshDispatcher = (
  dependencies: DeadlineRefreshDispatchDependencies,
): DeadlineRefreshDispatcher => {
  const executor = new BoundedDueRefreshExecutor(dependencies);
  return Object.freeze({
    async dispatch(inputCandidate: unknown = {}): Promise<DeadlineRefreshDispatchResult> {
      const input = validateDispatchInput(inputCandidate);
      return executor.execute(input);
    },
  });
};

const isTransaction = (value: unknown): value is DeadlineRefreshTransaction =>
  isObject(value) && typeof value.query === "function";

const isDependencies = (value: unknown): value is DeadlineRefreshDispatchDependencies =>
  isObject(value) && (typeof value.runTransaction === "function" || isTransaction(value.transaction));

/**
 * Dispatches a bounded batch of due deadline refreshes.
 *
 * Supports flexible invocations:
 * - dispatchDeadlineRefresh(dependencies, input)
 * - dispatchDeadlineRefresh(input, dependencies)
 * - dispatchDeadlineRefresh(transaction, input)
 */
export const dispatchDeadlineRefresh = async (
  first: unknown,
  second?: unknown,
): Promise<DeadlineRefreshDispatchResult> => {
  let dependencies: DeadlineRefreshDispatchDependencies;
  let inputCandidate: unknown;

  if (isTransaction(first)) {
    dependencies = { transaction: first };
    inputCandidate = second;
  } else if (isDependencies(first)) {
    dependencies = first;
    inputCandidate = second;
  } else if (isDependencies(second)) {
    dependencies = second;
    inputCandidate = first;
  } else if (isTransaction(second)) {
    dependencies = { transaction: second };
    inputCandidate = first;
  } else {
    throw new DeadlineRefreshDispatchError("DEADLINE_REFRESH_TRANSACTION_REQUIRED");
  }

  return createDeadlineRefreshDispatcher(dependencies).dispatch(inputCandidate);
};
