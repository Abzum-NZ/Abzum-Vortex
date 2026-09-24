import "server-only";

import { platformIdSchema, timestampSchema } from "@vortex/contracts";
import {
  deadlineRefreshDispatchLimits,
  type DeadlineRefreshDispatchResult,
  type DeadlineRefreshDispatcher,
} from "./deadline-refresh-dispatch";

export const deadlineRefreshRecoveryLimits = Object.freeze({
  /** Consecutive non-advancing attempts allowed before one occurrence is terminal. */
  defaultMaximumAttempts: 5,
  /** Absolute ceiling on consecutive non-advancing attempts. */
  maximumAttempts: 20,
  minimumRetryBackoffSeconds: 1,
  maximumRetryBackoffSeconds: 86_400,
  /** Delay before retrying a stopped or interrupted occurrence. */
  defaultRetryBackoffSeconds: 30,
  /** Bounded due records one recovery dispatch refreshes when the caller names no limit. */
  defaultBatchLimit: deadlineRefreshDispatchLimits.defaultBatchLimit,
  /** Absolute ceiling on due records one recovery dispatch refreshes. */
  maximumBatchLimit: deadlineRefreshDispatchLimits.maximumBatchLimit,
});

export const deadlineRefreshRecoveryErrorCodes = [
  "INVALID_DEADLINE_REFRESH_RECOVERY_INPUT",
  "DEADLINE_REFRESH_RECOVERY_DISPATCH_REQUIRED",
] as const;

export type DeadlineRefreshRecoveryErrorCode = (typeof deadlineRefreshRecoveryErrorCodes)[number];

export class DeadlineRefreshRecoveryError extends Error {
  readonly code: DeadlineRefreshRecoveryErrorCode;

  constructor(code: DeadlineRefreshRecoveryErrorCode) {
    super(code);
    this.name = "DeadlineRefreshRecoveryError";
    this.code = code;
  }
}

/**
 * Why one occurrence was rescheduled or made terminal. The reason is stable
 * reporting metadata: it never selects records, derives a deadline or changes
 * authority.
 */
export const deadlineRefreshRecoveryReasons = [
  "pending_transition",
  "overdue_transition",
  "batch_remaining",
  "interrupted_resume",
  "stopped_retry",
  "scheduled",
  "overdue_catch_up",
  "nothing_due",
  "attempts_exhausted",
] as const;

export type DeadlineRefreshRecoveryReason = (typeof deadlineRefreshRecoveryReasons)[number];

type DeadlineRefreshDispatchStatus = DeadlineRefreshDispatchResult["status"];

const dispatchStatuses = [
  "idle",
  "drained",
  "limit_reached",
  "stopped",
] as const satisfies readonly DeadlineRefreshDispatchStatus[];

/**
 * The settled or interrupted state of the most recent attempt against one
 * occurrence. `settled` carries the exact bounded #659 dispatch status; an
 * `interrupted` attempt started but never settled, so its work is retried.
 */
export type DeadlineRefreshOccurrenceAttempt =
  | Readonly<{
      kind: "settled";
      attemptedAt: string;
      status: DeadlineRefreshDispatchStatus;
      /** Only ever set on an `idle` result; the next transition Record reported. */
      nextDueAt?: string;
    }>
  | Readonly<{ kind: "interrupted"; attemptedAt: string }>;

/**
 * One scheduled deadline-refresh occurrence's state. `occurrenceId` identifies
 * the occurrence for the caller; `scheduledAt` is when it is next due to run;
 * `attemptCount` counts consecutive non-advancing attempts; `lastAttempt` is
 * absent until the occurrence has run and is cleared again when a retry or the
 * next transition is scheduled. This state is supplied by the scheduled caller
 * and never asserts a deadline, actor or record identity.
 */
export type DeadlineRefreshOccurrenceState = Readonly<{
  occurrenceId: string;
  scheduledAt: string;
  attemptCount: number;
  lastAttempt?: DeadlineRefreshOccurrenceAttempt;
}>;

/**
 * The next occurrence: either rescheduled with the exact instant it is due
 * again, or terminal because no due work remains or the retry budget is spent.
 * `occurrence` is the state to feed the next call, so recovery resumes without
 * repeating a settled refresh. Exactly one occurrence is produced per call, so
 * a caller never fans out into per-record work.
 */
export type DeadlineRefreshOccurrenceDecision =
  | Readonly<{
      outcome: "rescheduled";
      reason: DeadlineRefreshRecoveryReason;
      nextAttemptAt: string;
      occurrence: DeadlineRefreshOccurrenceState;
    }>
  | Readonly<{
      outcome: "terminal";
      reason: DeadlineRefreshRecoveryReason;
      occurrence: DeadlineRefreshOccurrenceState;
    }>;

export type DeadlineRefreshRecoveryPolicy = Readonly<{
  /** Consecutive non-advancing attempts allowed before the occurrence is terminal. */
  maximumAttempts?: number;
  /** Delay before retrying a stopped or interrupted occurrence, in seconds. */
  retryBackoffSeconds?: number;
  /** Due records refreshed by one recovery dispatch, within the #659 ceiling. */
  batchLimit?: number;
}>;

export type DeadlineRefreshRecoveryDependencies = Readonly<{
  /** The existing bounded #659 dispatcher a due recovery occurrence runs. */
  dispatcher: DeadlineRefreshDispatcher;
  policy?: DeadlineRefreshRecoveryPolicy;
  /** Reads the current instant in epoch milliseconds; defaults to `Date.now`. */
  now?: () => number;
}>;

export interface DeadlineRefreshRecovery {
  recover(stateCandidate: unknown): Promise<DeadlineRefreshOccurrenceDecision>;
}

type OccurrencePlan =
  | Readonly<{
      outcome: "rescheduled";
      reason: DeadlineRefreshRecoveryReason;
      occurrence: DeadlineRefreshOccurrenceState;
    }>
  | Readonly<{
      outcome: "terminal";
      reason: DeadlineRefreshRecoveryReason;
      occurrence: DeadlineRefreshOccurrenceState;
    }>;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const invalidInput = (): DeadlineRefreshRecoveryError =>
  new DeadlineRefreshRecoveryError("INVALID_DEADLINE_REFRESH_RECOVERY_INPUT");

const boundedInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;

/** Epoch milliseconds of a validated timestamp; sub-millisecond digits are truncated. */
const instantMilliseconds = (timestamp: string): number =>
  Date.parse(timestamp.replace(/(\.\d{3})\d+/, "$1"));

const isDispatchStatus = (candidate: unknown): candidate is DeadlineRefreshDispatchStatus =>
  typeof candidate === "string" && (dispatchStatuses as readonly string[]).includes(candidate);

const parseAttempt = (candidate: unknown): DeadlineRefreshOccurrenceAttempt => {
  if (!isObject(candidate) || typeof candidate.kind !== "string") throw invalidInput();
  const attemptedAt = timestampSchema.safeParse(candidate.attemptedAt);
  if (!attemptedAt.success) throw invalidInput();

  if (candidate.kind === "interrupted") {
    if (!hasOnlyKeys(candidate, ["kind", "attemptedAt"])) throw invalidInput();
    return { kind: "interrupted", attemptedAt: attemptedAt.data };
  }
  if (
    candidate.kind !== "settled" ||
    !hasOnlyKeys(candidate, ["kind", "attemptedAt", "status", "nextDueAt"])
  )
    throw invalidInput();
  const status = candidate.status;
  if (!isDispatchStatus(status)) throw invalidInput();

  if (candidate.nextDueAt !== undefined) {
    // A next transition only exists on an idle result; any other status is invalid.
    if (status !== "idle") throw invalidInput();
    const nextDueAt = timestampSchema.safeParse(candidate.nextDueAt);
    if (!nextDueAt.success) throw invalidInput();
    return { kind: "settled", attemptedAt: attemptedAt.data, status, nextDueAt: nextDueAt.data };
  }
  return { kind: "settled", attemptedAt: attemptedAt.data, status };
};

/** Validates one occurrence state; every missing or fabricated field is refused. */
export const parseDeadlineRefreshOccurrenceState = (
  candidate: unknown,
): DeadlineRefreshOccurrenceState => {
  if (
    !isObject(candidate) ||
    !hasOnlyKeys(candidate, ["occurrenceId", "scheduledAt", "attemptCount", "lastAttempt"])
  )
    throw invalidInput();
  const occurrenceId = platformIdSchema.safeParse(candidate.occurrenceId);
  const scheduledAt = timestampSchema.safeParse(candidate.scheduledAt);
  const attemptCount = candidate.attemptCount;
  if (
    !occurrenceId.success ||
    !scheduledAt.success ||
    !boundedInteger(attemptCount, 0, deadlineRefreshRecoveryLimits.maximumAttempts)
  )
    throw invalidInput();
  const lastAttempt =
    candidate.lastAttempt === undefined ? undefined : parseAttempt(candidate.lastAttempt);
  return {
    occurrenceId: occurrenceId.data,
    scheduledAt: scheduledAt.data,
    attemptCount,
    ...(lastAttempt === undefined ? {} : { lastAttempt }),
  };
};

type RecoveryConfiguration = Readonly<{
  maximumAttempts: number;
  retryBackoffSeconds: number;
  batchLimit?: number;
}>;

const resolvePolicy = (policy: unknown): RecoveryConfiguration => {
  const candidate = policy === undefined ? {} : policy;
  if (
    !isObject(candidate) ||
    !hasOnlyKeys(candidate, ["maximumAttempts", "retryBackoffSeconds", "batchLimit"])
  )
    throw invalidInput();

  const maximumAttempts =
    candidate.maximumAttempts ?? deadlineRefreshRecoveryLimits.defaultMaximumAttempts;
  const retryBackoffSeconds =
    candidate.retryBackoffSeconds ?? deadlineRefreshRecoveryLimits.defaultRetryBackoffSeconds;
  const batchLimit = candidate.batchLimit;
  if (
    !boundedInteger(maximumAttempts, 1, deadlineRefreshRecoveryLimits.maximumAttempts) ||
    !boundedInteger(
      retryBackoffSeconds,
      deadlineRefreshRecoveryLimits.minimumRetryBackoffSeconds,
      deadlineRefreshRecoveryLimits.maximumRetryBackoffSeconds,
    )
  )
    throw invalidInput();
  if (batchLimit !== undefined) {
    if (!boundedInteger(batchLimit, 1, deadlineRefreshRecoveryLimits.maximumBatchLimit))
      throw invalidInput();
  }

  return {
    maximumAttempts,
    retryBackoffSeconds,
    ...(batchLimit === undefined ? {} : { batchLimit }),
  };
};

/** The next occurrence with no settled attempt, so its own run dispatches. */
const nextOccurrence = (
  state: DeadlineRefreshOccurrenceState,
  scheduledAt: string,
  attemptCount: number,
): DeadlineRefreshOccurrenceState => ({
  occurrenceId: state.occurrenceId,
  scheduledAt,
  attemptCount,
});

const retryAt = (nowMs: number, backoffSeconds: number): string =>
  new Date(nowMs + backoffSeconds * 1_000).toISOString();

/**
 * The one pure recovery decision. It reads only the occurrence state and the
 * current instant: a pending future transition schedules there, overdue work
 * runs now, a reached batch limit continues immediately, and a stopped or
 * interrupted attempt retries after a bounded backoff. Drained work and an
 * exhausted retry budget are terminal. A scheduled retry drops its prior
 * attempt so the retry re-runs, and nothing here derives a deadline, claims a
 * record or repeats a completed refresh.
 */
const planOccurrence = (
  state: DeadlineRefreshOccurrenceState,
  configuration: RecoveryConfiguration,
  nowMs: number,
): OccurrencePlan => {
  const { scheduledAt, attemptCount, lastAttempt } = state;
  const nowIso = new Date(nowMs).toISOString();

  if (lastAttempt === undefined) {
    return instantMilliseconds(scheduledAt) > nowMs
      ? { outcome: "rescheduled", reason: "scheduled", occurrence: state }
      : {
          outcome: "rescheduled",
          reason: "overdue_catch_up",
          occurrence: { ...state, scheduledAt: nowIso },
        };
  }

  if (lastAttempt.kind === "interrupted") {
    if (attemptCount >= configuration.maximumAttempts)
      return { outcome: "terminal", reason: "attempts_exhausted", occurrence: state };
    return {
      outcome: "rescheduled",
      reason: "interrupted_resume",
      occurrence: nextOccurrence(
        state,
        retryAt(nowMs, configuration.retryBackoffSeconds),
        attemptCount,
      ),
    };
  }

  if (lastAttempt.status === "stopped") {
    if (attemptCount >= configuration.maximumAttempts)
      return { outcome: "terminal", reason: "attempts_exhausted", occurrence: state };
    return {
      outcome: "rescheduled",
      reason: "stopped_retry",
      occurrence: nextOccurrence(
        state,
        retryAt(nowMs, configuration.retryBackoffSeconds),
        attemptCount,
      ),
    };
  }

  if (lastAttempt.status === "limit_reached")
    return {
      outcome: "rescheduled",
      reason: "batch_remaining",
      occurrence: nextOccurrence(state, nowIso, 0),
    };

  // idle or drained: an idle result with no next transition means nothing is due.
  const nextDueAt = lastAttempt.nextDueAt;
  if (nextDueAt === undefined)
    return {
      outcome: "terminal",
      reason: "nothing_due",
      occurrence: nextOccurrence(state, scheduledAt, 0),
    };
  return instantMilliseconds(nextDueAt) > nowMs
    ? {
        outcome: "rescheduled",
        reason: "pending_transition",
        occurrence: nextOccurrence(state, nextDueAt, 0),
      }
    : {
        outcome: "rescheduled",
        reason: "overdue_transition",
        occurrence: nextOccurrence(state, nowIso, 0),
      };
};

const toDecision = (plan: OccurrencePlan): DeadlineRefreshOccurrenceDecision =>
  plan.outcome === "rescheduled"
    ? {
        outcome: "rescheduled",
        reason: plan.reason,
        nextAttemptAt: plan.occurrence.scheduledAt,
        occurrence: plan.occurrence,
      }
    : { outcome: "terminal", reason: plan.reason, occurrence: plan.occurrence };

/**
 * Pure recovery planning for one occurrence state: returns exactly one
 * rescheduled or terminal occurrence and never touches the database. `now`
 * defaults to the system clock and is injectable for deterministic callers.
 */
export const planDeadlineRefreshRecovery = (
  inputCandidate: unknown,
  options?: Readonly<{ policy?: DeadlineRefreshRecoveryPolicy; now?: () => number }>,
): DeadlineRefreshOccurrenceDecision => {
  if (options !== undefined && !isObject(options)) throw invalidInput();
  const configuration = resolvePolicy(options?.policy);
  const now = options?.now;
  const nowMs = now === undefined ? Date.now() : now();
  if (!Number.isFinite(nowMs)) throw invalidInput();
  return toDecision(
    planOccurrence(parseDeadlineRefreshOccurrenceState(inputCandidate), configuration, nowMs),
  );
};

const settledAttempt = (
  result: DeadlineRefreshDispatchResult,
  attemptedAt: string,
): DeadlineRefreshOccurrenceAttempt =>
  result.status === "idle"
    ? {
        kind: "settled",
        attemptedAt,
        status: "idle",
        ...(result.nextDueAt === undefined ? {} : { nextDueAt: result.nextDueAt }),
      }
    : { kind: "settled", attemptedAt, status: result.status };

/**
 * A stopped or interrupted attempt consumes one retry; a settled attempt that
 * advanced work (idle, drained or a reached batch limit) resets the budget, so
 * steady progress can never be made terminal by the attempt ceiling.
 */
const nextAttemptCount = (
  attempt: DeadlineRefreshOccurrenceAttempt,
  previousCount: number,
): number =>
  attempt.kind === "interrupted"
    ? previousCount + 1
    : attempt.status === "stopped"
      ? previousCount + 1
      : 0;

/**
 * Creates the recovery coordinator over the existing bounded #659 dispatcher.
 * `recover` validates the occurrence state, plans exactly one next occurrence,
 * and when that occurrence is due now runs one bounded dispatch before it
 * replans from the fresh result. Each call refreshes at most one batch through
 * the dispatcher's own claim/closure operations, so recovery advances through
 * due work without per-record work or duplicate effects, and it never derives a
 * deadline or writes a record itself.
 */
export const createDeadlineRefreshRecovery = (
  dependencies: DeadlineRefreshRecoveryDependencies,
): DeadlineRefreshRecovery => {
  const dispatcher = dependencies?.dispatcher;
  if (typeof dispatcher?.dispatch !== "function")
    throw new DeadlineRefreshRecoveryError("DEADLINE_REFRESH_RECOVERY_DISPATCH_REQUIRED");
  const configuration = resolvePolicy(dependencies.policy);
  const now = dependencies.now ?? (() => Date.now());
  const dispatch = dispatcher.dispatch.bind(dispatcher);

  return Object.freeze({
    async recover(stateCandidate: unknown): Promise<DeadlineRefreshOccurrenceDecision> {
      const state = parseDeadlineRefreshOccurrenceState(stateCandidate);
      const nowMs = now();
      if (!Number.isFinite(nowMs)) throw invalidInput();

      const plan = planOccurrence(state, configuration, nowMs);
      if (
        plan.outcome === "terminal" ||
        instantMilliseconds(plan.occurrence.scheduledAt) > nowMs
      )
        return toDecision(plan);

      const attemptedAt = new Date(nowMs).toISOString();
      let attempt: DeadlineRefreshOccurrenceAttempt;
      try {
        const result = await dispatch(
          configuration.batchLimit === undefined
            ? {}
            : { dueWindow: { batchLimit: configuration.batchLimit } },
        );
        attempt = settledAttempt(result, attemptedAt);
      } catch {
        // An unsettled attempt keeps no partial claim: Record commits each
        // closed record before the next, so the retry resumes from the earliest
        // remaining due row without repeating a completed refresh.
        attempt = { kind: "interrupted", attemptedAt };
      }

      const nextState: DeadlineRefreshOccurrenceState = {
        occurrenceId: state.occurrenceId,
        scheduledAt: state.scheduledAt,
        attemptCount: nextAttemptCount(attempt, state.attemptCount),
        lastAttempt: attempt,
      };
      return toDecision(planOccurrence(nextState, configuration, nowMs));
    },
  });
};

/** Runs one bounded recovery occurrence over the supplied #659 dispatcher. */
export const recoverDeadlineRefreshOccurrence = async (
  dependencies: DeadlineRefreshRecoveryDependencies,
  stateCandidate: unknown,
): Promise<DeadlineRefreshOccurrenceDecision> =>
  createDeadlineRefreshRecovery(dependencies).recover(stateCandidate);
