import "server-only";

import { platformIdSchema, timestampSchema } from "@vortex/contracts";
import {
  createDeadlineRefreshDispatcher,
  deadlineRefreshDispatchLimits,
  type DeadlineRefreshDispatchDependencies,
  type DeadlineRefreshDispatchResult,
  type DeadlineRefreshWorkerTransactionRunner,
} from "./deadline-refresh-dispatch";

export const deadlineRefreshRecoveryLimits = Object.freeze({
  /** Consecutive non-advancing attempts allowed before one occurrence is terminal. */
  defaultMaximumAttempts: 5,
  /** Absolute ceiling on consecutive non-advancing attempts. */
  maximumAttempts: 20,
  minimumRetryBackoffSeconds: 1,
  maximumRetryBackoffSeconds: 86_400,
  /** Delay before retrying a stopped, interrupted, or locked-due occurrence. */
  defaultRetryBackoffSeconds: 30,
  /** Bounded due records one recovery dispatch refreshes when the caller names no limit. */
  defaultBatchLimit: deadlineRefreshDispatchLimits.defaultBatchLimit,
  /** Absolute ceiling on due records one recovery dispatch refreshes. */
  maximumBatchLimit: deadlineRefreshDispatchLimits.maximumBatchLimit,
});

export const deadlineRefreshRecoveryErrorCodes = [
  "INVALID_DEADLINE_REFRESH_RECOVERY_INPUT",
  "DEADLINE_REFRESH_RECOVERY_WORKER_TRANSACTION_REQUIRED",
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
  "due_row_retry",
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
      /** Set on `idle` or `drained` from the live worker-scoped due lookup. */
      nextDueAt?: string;
      /** Required on `stopped`: a prior item was successfully closed. */
      progressed?: boolean;
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
  /** Delay before retrying a stopped, interrupted, or locked-due occurrence. */
  retryBackoffSeconds?: number;
  /** Due records refreshed by one recovery dispatch, within the #659 ceiling. */
  batchLimit?: number;
}>;

export type DeadlineRefreshRecoveryDependencies = DeadlineRefreshDispatchDependencies & Readonly<{
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

const parseTimestamp = (candidate: unknown): string => {
  const parsed = timestampSchema.safeParse(candidate);
  if (!parsed.success || !Number.isFinite(instantMilliseconds(parsed.data))) throw invalidInput();
  return parsed.data;
};

const validClockInstant = (candidate: unknown): candidate is number =>
  typeof candidate === "number" &&
  Number.isFinite(candidate) &&
  Math.abs(candidate) <= 8_640_000_000_000_000;

const isDispatchStatus = (candidate: unknown): candidate is DeadlineRefreshDispatchStatus =>
  typeof candidate === "string" && (dispatchStatuses as readonly string[]).includes(candidate);

const parseAttempt = (candidate: unknown): DeadlineRefreshOccurrenceAttempt => {
  if (!isObject(candidate) || typeof candidate.kind !== "string") throw invalidInput();
  const attemptedAt = parseTimestamp(candidate.attemptedAt);

  if (candidate.kind === "interrupted") {
    if (!hasOnlyKeys(candidate, ["kind", "attemptedAt"])) throw invalidInput();
    return { kind: "interrupted", attemptedAt };
  }
  if (
    candidate.kind !== "settled" ||
    !hasOnlyKeys(candidate, ["kind", "attemptedAt", "status", "nextDueAt", "progressed"])
  )
    throw invalidInput();
  const status = candidate.status;
  if (!isDispatchStatus(status)) throw invalidInput();

  if (status === "stopped") {
    if (candidate.nextDueAt !== undefined || typeof candidate.progressed !== "boolean")
      throw invalidInput();
    return { kind: "settled", attemptedAt, status, progressed: candidate.progressed };
  }
  if (candidate.progressed !== undefined) throw invalidInput();

  if (candidate.nextDueAt !== undefined) {
    // Only an idle or drained dispatch can leave a known next transition.
    if (status !== "idle" && status !== "drained") throw invalidInput();
    const nextDueAt = parseTimestamp(candidate.nextDueAt);
    return { kind: "settled", attemptedAt, status, nextDueAt };
  }
  return { kind: "settled", attemptedAt, status };
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
  const scheduledAt = parseTimestamp(candidate.scheduledAt);
  const attemptCount = candidate.attemptCount;
  if (
    !occurrenceId.success ||
    !boundedInteger(attemptCount, 0, deadlineRefreshRecoveryLimits.maximumAttempts)
  )
    throw invalidInput();
  const lastAttempt =
    candidate.lastAttempt === undefined ? undefined : parseAttempt(candidate.lastAttempt);
  return {
    occurrenceId: occurrenceId.data,
    scheduledAt,
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

const retryAt = (nowMs: number, backoffSeconds: number): string => {
  const nextMs = nowMs + backoffSeconds * 1_000;
  if (!validClockInstant(nextMs)) throw invalidInput();
  return new Date(nextMs).toISOString();
};

/**
 * The one pure recovery decision. It reads only the occurrence state and the
 * current instant: a pending future transition schedules there, overdue work
 * runs now, a reached batch limit continues immediately, and a stopped or
 * interrupted attempt retries after a bounded backoff. An idle or drained
 * attempt uses the live worker-scoped next due time, or becomes terminal when
 * none remains. An exhausted retry budget is terminal. A scheduled retry drops
 * its prior attempt so it can re-run, and nothing here derives a deadline,
 * claims a record or repeats a completed refresh.
 */
const planOccurrence = (
  state: DeadlineRefreshOccurrenceState,
  configuration: RecoveryConfiguration,
  nowMs: number,
): OccurrencePlan => {
  const { scheduledAt, attemptCount, lastAttempt } = state;
  const nowIso = new Date(nowMs).toISOString();

  if (lastAttempt === undefined) {
    if (attemptCount >= configuration.maximumAttempts)
      return { outcome: "terminal", reason: "attempts_exhausted", occurrence: state };
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
  if (lastAttempt.status === "idle" && instantMilliseconds(nextDueAt) <= nowMs) {
    // Another worker may hold the row that the live lookup sees. Do not turn
    // an empty claim into an immediate, unbounded series of scheduled calls.
    if (attemptCount >= configuration.maximumAttempts)
      return { outcome: "terminal", reason: "attempts_exhausted", occurrence: state };
    return {
      outcome: "rescheduled",
      reason: "due_row_retry",
      occurrence: nextOccurrence(
        state,
        retryAt(nowMs, configuration.retryBackoffSeconds),
        attemptCount,
      ),
    };
  }
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
  if (now !== undefined && typeof now !== "function") throw invalidInput();
  const nowMs = now === undefined ? Date.now() : now();
  if (!validClockInstant(nowMs)) throw invalidInput();
  return toDecision(
    planOccurrence(parseDeadlineRefreshOccurrenceState(inputCandidate), configuration, nowMs),
  );
};

const settledAttempt = (
  result: DeadlineRefreshDispatchResult,
  attemptedAt: string,
  nextDueAt?: string,
): DeadlineRefreshOccurrenceAttempt =>
  result.status === "idle" || result.status === "drained"
    ? {
        kind: "settled",
        attemptedAt,
        status: result.status,
        ...(nextDueAt === undefined ? {} : { nextDueAt }),
      }
    : result.status === "stopped"
      ? {
          kind: "settled",
          attemptedAt,
          status: "stopped",
          progressed: result.items.some((item) => item.outcome === "refreshed"),
        }
      : { kind: "settled", attemptedAt, status: result.status };

/**
 * A stopped or interrupted attempt consumes one retry unless work advanced.
 * An idle batch with a still-overdue row also consumes one retry, since another
 * worker may hold that row. Progress resets the budget.
 */
const nextAttemptCount = (
  attempt: DeadlineRefreshOccurrenceAttempt,
  previousCount: number,
  finishedAtMs: number,
): number => {
  if (attempt.kind === "interrupted") return previousCount + 1;
  if (attempt.status === "stopped" && !attempt.progressed) return previousCount + 1;
  if (
    attempt.status === "idle" &&
    attempt.nextDueAt !== undefined &&
    instantMilliseconds(attempt.nextDueAt) <= finishedAtMs
  )
    return previousCount + 1;
  return 0;
};

type NextDueRow = Readonly<{ nextDueAt: unknown }>;

/** Reads only the next timestamp through a fresh deadline-worker transaction. */
const readNextDueAt = async (
  runWorkerTransaction: DeadlineRefreshWorkerTransactionRunner,
): Promise<string | undefined> =>
  runWorkerTransaction(async (transaction) => {
    await transaction.query`set local role vortex_runtime`;
    const rows = await transaction.query<NextDueRow>`
      select pg_catalog.to_char(
        pg_catalog.timezone('UTC', vortex_record.next_deadline_refresh_due_at()),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) as "nextDueAt"
    `;
    if (rows.length !== 1 || rows[0] === undefined)
      throw new Error("DEADLINE_REFRESH_NEXT_DUE_RESULT_INVALID");
    const value = rows[0].nextDueAt;
    if (value === null) return undefined;
    const parsed = timestampSchema.safeParse(value);
    if (!parsed.success || !Number.isFinite(instantMilliseconds(parsed.data)))
      throw new Error("DEADLINE_REFRESH_NEXT_DUE_RESULT_INVALID");
    return parsed.data;
  });

/**
 * Creates the recovery coordinator over the existing bounded #659 dispatcher.
 * `recover` validates the occurrence state, plans exactly one next occurrence,
 * and when that occurrence is due now runs one bounded dispatch before it
 * replans from the fresh result. Each call refreshes at most one batch through
 * the dispatcher's own claim/closure operations, so recovery advances through
 * due work without per-record work or duplicate effects, and it never derives a
 * deadline or writes a record itself.
 *
 * `runWorkerTransaction` must open each transaction on the configured deadline
 * worker login, never a human request connection. A terminal `nothing_due`
 * occurrence ends recovery; the scheduled caller starts a fresh occurrence on
 * its own cadence, which then catches up any work written since.
 */
export const createDeadlineRefreshRecovery = (
  dependencies: DeadlineRefreshRecoveryDependencies,
): DeadlineRefreshRecovery => {
  if (typeof dependencies?.runWorkerTransaction !== "function")
    throw new DeadlineRefreshRecoveryError(
      "DEADLINE_REFRESH_RECOVERY_WORKER_TRANSACTION_REQUIRED",
    );
  const configuration = resolvePolicy(dependencies.policy);
  if (dependencies.now !== undefined && typeof dependencies.now !== "function")
    throw invalidInput();
  const now = dependencies.now ?? (() => Date.now());
  const dispatcher = createDeadlineRefreshDispatcher(dependencies);

  return Object.freeze({
    async recover(stateCandidate: unknown): Promise<DeadlineRefreshOccurrenceDecision> {
      const state = parseDeadlineRefreshOccurrenceState(stateCandidate);
      const nowMs = now();
      if (!validClockInstant(nowMs)) throw invalidInput();

      const plan = planOccurrence(state, configuration, nowMs);
      if (
        plan.outcome === "terminal" ||
        instantMilliseconds(plan.occurrence.scheduledAt) > nowMs
      )
        return toDecision(plan);

      const attemptedAt = new Date(nowMs).toISOString();
      let attempt: DeadlineRefreshOccurrenceAttempt;
      try {
        const result = await dispatcher.dispatch(
          configuration.batchLimit === undefined
            ? {}
            : { dueWindow: { batchLimit: configuration.batchLimit } },
        );
        const nextDueAt =
          result.status === "idle" || result.status === "drained"
            ? await readNextDueAt(dependencies.runWorkerTransaction)
            : undefined;
        attempt = settledAttempt(result, attemptedAt, nextDueAt);
      } catch {
        // Dispatch or the following due lookup may fail after some records
        // committed. Record closes each item before the next claim, so a retry
        // selects remaining due rows without repeating a completed effect.
        attempt = { kind: "interrupted", attemptedAt };
      }

      const finishedAtMs = now();
      if (!validClockInstant(finishedAtMs)) throw invalidInput();
      const nextState: DeadlineRefreshOccurrenceState = {
        occurrenceId: state.occurrenceId,
        scheduledAt: state.scheduledAt,
        attemptCount: nextAttemptCount(attempt, state.attemptCount, finishedAtMs),
        lastAttempt: attempt,
      };
      return toDecision(planOccurrence(nextState, configuration, finishedAtMs));
    },
  });
};

/** Runs one bounded recovery occurrence on the configured deadline worker. */
export const recoverDeadlineRefreshOccurrence = async (
  dependencies: DeadlineRefreshRecoveryDependencies,
  stateCandidate: unknown,
): Promise<DeadlineRefreshOccurrenceDecision> =>
  createDeadlineRefreshRecovery(dependencies).recover(stateCandidate);
