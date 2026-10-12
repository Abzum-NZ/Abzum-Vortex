import "server-only";

import type { DatabaseRow } from "@vortex/db";
import { withRuntimeTransaction } from "@vortex/db";
import {
  createEventDispatcherRoute,
  type EventDispatchResult,
  type EventDispatcherRefusalReason,
  type EventDispatcherRouteDependencies,
  type EventDispatcherTransactionRunner,
} from "./dispatcher";

/**
 * The two mutually exclusive wake-up callers. A database webhook hint fires
 * after a committed outbox append; a scheduled recovery tick re-runs the same
 * bounded dispatch after a missed hint. The source is a caller-supplied label
 * only: it never selects consumers and never changes authority.
 */
export const eventDispatcherWakeupSources = ["database_webhook", "scheduled_recovery"] as const;

export type EventDispatcherWakeupSource = (typeof eventDispatcherWakeupSources)[number];

export const eventDispatcherWakeupLimits = Object.freeze({
  /** Request body ceiling for the protected route. */
  maximumRequestBodyLength: 4096,
  /** A pending occurrence older than this is reported as a stalled backlog. */
  stalledBacklogAgeSeconds: 300,
  /** Bounded ceiling on a reported oldest-pending age, about 30 days. */
  maximumBacklogAgeSeconds: 2_592_000,
  /** Bounded ceiling on a reported terminal failure count. */
  maximumBacklogFailureCount: 1_000_000,
});

export const eventDispatcherBacklogStatuses = [
  "clear",
  "pending",
  "stalled",
  "failed",
  "unavailable",
] as const;

export type EventDispatcherBacklogStatus = (typeof eventDispatcherBacklogStatuses)[number];

/**
 * Content-free delivery backlog: the age, since append, of the oldest claimed
 * occurrence that is neither acknowledged nor terminally failed, and the count
 * of exhausted claims. It carries no occurrence identity,
 * consumer identity or payload, and "unavailable" reports a status that could
 * not be read rather than inventing one.
 */
export type EventDispatcherBacklog = Readonly<{
  status: EventDispatcherBacklogStatus;
  oldestPendingAgeSeconds: number | null;
  terminalFailureCount: number | null;
}>;

export type EventDispatcherWakeupRequest = Readonly<{
  /** The request's `Authorization` header value. */
  authorization: string | null | undefined;
  /** Optional parsed JSON body; it may carry only the `source` label. */
  body?: unknown;
}>;

export type EventDispatcherWakeupResponse =
  | Readonly<{
      outcome: "refused";
      reason: EventDispatcherRefusalReason;
      source: EventDispatcherWakeupSource | null;
    }>
  | Readonly<{
      outcome: "invalid_request";
      code: "INVALID_EVENT_DISPATCH_INPUT" | "UNKNOWN_EVENT_CONSUMER";
      source: EventDispatcherWakeupSource | null;
    }>
  | Readonly<{
      outcome: "dispatched";
      source: EventDispatcherWakeupSource;
      result: EventDispatchResult;
      backlog: EventDispatcherBacklog;
    }>;

export interface EventDispatcherWakeup {
  handle(request: EventDispatcherWakeupRequest): Promise<EventDispatcherWakeupResponse>;
}

/** Reads one bounded, content-free backlog snapshot. */
export interface EventDispatcherBacklogReader {
  read(): Promise<EventDispatcherBacklog>;
}

export type EventDispatcherWakeupDependencies = EventDispatcherRouteDependencies &
  Readonly<{ backlog?: EventDispatcherBacklogReader }>;

type BacklogRow = DatabaseRow & { readonly result: unknown };

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const exactRecord = <Key extends string>(
  value: unknown,
  keys: readonly Key[],
): Readonly<Record<Key, unknown>> | undefined => {
  const candidate = record(value);
  if (
    candidate === undefined ||
    Object.keys(candidate).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(candidate, key))
  )
    return undefined;
  return candidate as Readonly<Record<Key, unknown>>;
};

const boundedInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;

const wakeupSourceMatches = (value: unknown): value is EventDispatcherWakeupSource =>
  typeof value === "string" && (eventDispatcherWakeupSources as readonly string[]).includes(value);

type ParsedWakeupRequest =
  | Readonly<{ kind: "accepted"; source: EventDispatcherWakeupSource }>
  | Readonly<{ kind: "invalid"; source: null }>;

/**
 * Reads the advisory source label. An absent body, empty object or absent
 * label is the database-webhook path. Any other field, including batch or
 * consumer tuning, or an unknown label is refused closed before any dispatch,
 * so a caller can never tune the bounded operation.
 */
const parseWakeupRequest = (body: unknown): ParsedWakeupRequest => {
  if (body === undefined || body === null)
    return { kind: "accepted", source: "database_webhook" };
  const fields = record(body);
  if (fields === undefined || Object.keys(fields).some((key) => key !== "source"))
    return { kind: "invalid", source: null };
  const source = fields.source;
  if (source === undefined) return { kind: "accepted", source: "database_webhook" };
  if (!wakeupSourceMatches(source)) return { kind: "invalid", source: null };
  return { kind: "accepted", source };
};

const deriveBacklogStatus = (
  oldestPendingAgeSeconds: number | null,
  terminalFailureCount: number,
): EventDispatcherBacklogStatus => {
  if (terminalFailureCount > 0) return "failed";
  if (oldestPendingAgeSeconds === null) return "clear";
  return oldestPendingAgeSeconds >= eventDispatcherWakeupLimits.stalledBacklogAgeSeconds
    ? "stalled"
    : "pending";
};

export const eventDispatcherUnavailableBacklog: EventDispatcherBacklog = Object.freeze({
  status: "unavailable",
  oldestPendingAgeSeconds: null,
  terminalFailureCount: null,
});

const parseBacklog = (candidate: unknown): EventDispatcherBacklog => {
  const value = exactRecord(candidate, ["oldestPendingAgeSeconds", "terminalFailureCount"]);
  const age = value?.oldestPendingAgeSeconds;
  const failures = value?.terminalFailureCount;
  if (
    value === undefined ||
    !(
      age === null ||
      boundedInteger(age, 0, eventDispatcherWakeupLimits.maximumBacklogAgeSeconds)
    ) ||
    !boundedInteger(failures, 0, eventDispatcherWakeupLimits.maximumBacklogFailureCount)
  )
    throw new Error("EVENT_DISPATCH_BACKLOG_UNAVAILABLE");
  const oldestPendingAgeSeconds: number | null = age === null ? null : (age as number);
  const terminalFailureCount = failures as number;
  return Object.freeze({
    status: deriveBacklogStatus(oldestPendingAgeSeconds, terminalFailureCount),
    oldestPendingAgeSeconds,
    terminalFailureCount,
  });
};

/**
 * Reads the event-owned backlog status through the server-only runtime
 * transaction. Any missing configuration, missing function or malformed result
 * becomes "unavailable" instead of an exception or a fabricated status, so no
 * payload, consumer identity or internal error text can leak.
 */
export const createEventDispatchBacklogReader = (
  run: EventDispatcherTransactionRunner,
): EventDispatcherBacklogReader =>
  Object.freeze({
    async read(): Promise<EventDispatcherBacklog> {
      try {
        const rows = await run((transaction) =>
          transaction.query<BacklogRow>`
            select vortex_event.event_dispatch_backlog_status() as result
          `,
        );
        const first = rows[0];
        if (rows.length !== 1 || first === undefined) return eventDispatcherUnavailableBacklog;
        return parseBacklog(first.result);
      } catch {
        return eventDispatcherUnavailableBacklog;
      }
    },
  });

/**
 * Wake-up and recovery entry over the same bounded #641 dispatcher route. Both
 * a database webhook hint and a scheduled recovery tick authenticate with the
 * same configured dispatcher credential and run the identical claim, deliver,
 * acknowledge and retry operation; this module adds only the advisory source
 * label and a bounded, content-free backlog status. It never claims, settles or
 * mutates the durable outbox itself.
 */
export const createEventDispatcherWakeup = (
  dependencies: EventDispatcherWakeupDependencies,
): EventDispatcherWakeup => {
  const route = createEventDispatcherRoute(dependencies);
  const run: EventDispatcherTransactionRunner =
    dependencies.runtimeTransaction ?? withRuntimeTransaction;
  const backlog = dependencies.backlog ?? createEventDispatchBacklogReader(run);
  return Object.freeze({
    async handle(request: EventDispatcherWakeupRequest): Promise<EventDispatcherWakeupResponse> {
      const parsed = parseWakeupRequest(request.body);
      if (parsed.kind === "invalid")
        return {
          outcome: "invalid_request",
          code: "INVALID_EVENT_DISPATCH_INPUT",
          source: null,
        };

      const dispatch = await route.handle({ authorization: request.authorization });
      if (dispatch.outcome === "refused")
        return { outcome: "refused", reason: dispatch.reason, source: parsed.source };
      if (dispatch.outcome === "invalid_request")
        return { outcome: "invalid_request", code: dispatch.code, source: parsed.source };
      return {
        outcome: "dispatched",
        source: parsed.source,
        result: dispatch.result,
        backlog: await backlog.read(),
      };
    },
  });
};
