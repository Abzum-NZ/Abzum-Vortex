/**
 * Component refresh subscriber for the private invalidation channels (#615,
 * part A).
 *
 * #614 publishes a bounded, content-free notice on one private Supabase
 * Realtime Broadcast topic per organisation and application. This module is the
 * subscriber half: it accepts a received Broadcast message, strictly parses the
 * notice envelope, maps the notice's target identity to the mounted placements
 * that declared they read that target, and reports the ones that are now stale.
 *
 * It does exactly one thing: it converges notices and tells a caller which
 * placements must re-read. It never runs a query, never re-renders, never
 * reloads a page, and never uses a notice value as data or as evidence of
 * access. A notice is only a routing signal; the ordinary authorised server read
 * remains the sole source of truth, and it belongs to later integration.
 *
 * The module deliberately has no runtime dependency on the server-only channel
 * barrel: the scope type is imported type-only and the strict envelope schema is
 * the same canonical contract the server parse uses, taken from the shared
 * contracts package. That keeps the convergence core free of `server-only`, so a
 * browser bundle can use it once a client-safe package entry exists (part B).
 */

import {
  applicationRootIdSchema,
  liveInvalidationSchema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  type LiveInvalidation,
  type RecordId,
  type RecordTypeId,
} from "@vortex/contracts";
import type { PrivateInvalidationTopicScope } from "./invalidation-channel";

/**
 * Only a bound is needed for a placement identity; the resolved composition
 * owns the exact spelling.
 */
export const privateInvalidationSubscriberLimits = Object.freeze({
  maximumPlacementIdLength: 200,
});

export const privateInvalidationSubscriberErrorCodes = [
  "INVALID_INVALIDATION_SUBSCRIBER",
  "INVALID_INVALIDATION_WATCH",
] as const;

export type PrivateInvalidationSubscriberErrorCode =
  (typeof privateInvalidationSubscriberErrorCodes)[number];

export class PrivateInvalidationSubscriberError extends Error {
  readonly code: PrivateInvalidationSubscriberErrorCode;

  constructor(code: PrivateInvalidationSubscriberErrorCode) {
    super(code);
    this.name = "PrivateInvalidationSubscriberError";
    this.code = code;
  }
}

/**
 * One declared read of a placement: the placement is affected when a notice
 * names this record type, and, when the declaration pins a record, this exact
 * record. A declaration with no `recordId` is a collection read (for example a
 * list block) and is affected by any record of that type. A notice without a
 * `recordId` is deliberately broad (for example an access change) and affects
 * every declaration of that type.
 */
export type PrivateInvalidationPlacementWatch = Readonly<{
  placementId: string;
  recordTypeId: RecordTypeId;
  recordId?: RecordId;
}>;

/**
 * The client transport that carries the private Broadcast messages this
 * subscriber consumes. The concrete Supabase Realtime channel binding is part
 * B; here it is only a port, and its callback receives the raw message so this
 * module can strip Realtime's transport metadata before strict parsing.
 */
export interface PrivateInvalidationSubscriptionSource {
  subscribe(onMessage: (message: unknown) => void): () => void;
}

export type PrivateInvalidationSubscriberDependencies = Readonly<{
  /** Organisation and application of the private topic this subscriber holds. */
  scope: PrivateInvalidationTopicScope;
  /** Transport to subscribe for messages; its channel is already scoped. */
  source: PrivateInvalidationSubscriptionSource;
  /** Called once per accepted notice with the placements that became stale. */
  onStale: (placementIds: readonly string[]) => void;
}>;

export interface PrivateInvalidationSubscriber {
  /**
   * Declares that one placement reads one target identity. The returned
   * function removes the declaration and forgets its convergence state once no
   * other declaration of the same placement and record type remains.
   */
  registerWatch(watch: PrivateInvalidationPlacementWatch): () => void;
  /**
   * Consumes one received Broadcast message and reports the placements it made
   * stale. A malformed, foreign-scope, duplicate or older message reports none.
   */
  receive(message: unknown): readonly string[];
  /** Subscribes through the transport; idempotent. */
  start(): void;
  /** Closes the subscription opened by {@link start}; idempotent. */
  stop(): void;
}

const emptyStalePlacements: readonly string[] = Object.freeze([]);

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/**
 * Realtime wraps a Broadcast payload and adds a transport `id` that is not part
 * of the content-free envelope. The strict schema refuses extra content, so that
 * one transport field is removed; nothing else is accepted.
 */
const withoutTransportMetadata = (
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const content: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (key !== "id") content[key] = entry;
  return content;
};

/**
 * Strictly parses one received message against the canonical content-free
 * envelope. It accepts either the bare envelope or Realtime's wrapping object
 * with a `payload`, and strips the transport `id` in both cases. Anything that
 * does not parse is ignored rather than surfaced, so a hostile or malformed
 * message can never disturb an open page.
 */
const readChannelEnvelope = (message: unknown): LiveInvalidation | undefined => {
  const received = asRecord(message);
  if (received === undefined) return undefined;
  const wrapped =
    received.payload === undefined ? received : asRecord(received.payload);
  if (wrapped === undefined) return undefined;
  const parsed = liveInvalidationSchema.safeParse(withoutTransportMetadata(wrapped));
  return parsed.success ? parsed.data : undefined;
};

const scopeMatches = (
  envelope: LiveInvalidation,
  scope: PrivateInvalidationTopicScope,
): boolean =>
  envelope.organizationId.toLowerCase() === scope.organizationId.toLowerCase() &&
  envelope.applicationRootId.toLowerCase() === scope.applicationRootId.toLowerCase();

/**
 * The convergence key is the placement and the record type, not the record: a
 * notice's `dataVersion` is the data version of its record type (see the query
 * cache dependency contract), so a newer version of one record type supersedes
 * every older notice the same placement received for that type, while a
 * different record type advances independently.
 */
const convergenceKey = (placementId: string, recordTypeId: string): string =>
  JSON.stringify([placementId, recordTypeId.toLowerCase()]);

const watchKey = (watch: PrivateInvalidationPlacementWatch): string =>
  JSON.stringify([
    watch.placementId,
    watch.recordTypeId.toLowerCase(),
    watch.recordId?.toLowerCase() ?? null,
  ]);

const parseWatch = (candidate: unknown): PrivateInvalidationPlacementWatch => {
  const value = asRecord(candidate);
  if (value === undefined)
    throw new PrivateInvalidationSubscriberError("INVALID_INVALIDATION_WATCH");
  const placementId = value.placementId;
  if (
    typeof placementId !== "string" ||
    placementId.trim().length === 0 ||
    placementId.length > privateInvalidationSubscriberLimits.maximumPlacementIdLength
  )
    throw new PrivateInvalidationSubscriberError("INVALID_INVALIDATION_WATCH");
  const recordTypeId = recordTypeIdSchema.safeParse(value.recordTypeId);
  if (!recordTypeId.success)
    throw new PrivateInvalidationSubscriberError("INVALID_INVALIDATION_WATCH");
  if (value.recordId === undefined)
    return Object.freeze({ placementId, recordTypeId: recordTypeId.data });
  const recordId = recordIdSchema.safeParse(value.recordId);
  if (!recordId.success)
    throw new PrivateInvalidationSubscriberError("INVALID_INVALIDATION_WATCH");
  return Object.freeze({
    placementId,
    recordTypeId: recordTypeId.data,
    recordId: recordId.data,
  });
};

/**
 * Creates the subscriber. The scope is validated once; a watch is validated on
 * registration, and a received message is never trusted beyond the strict
 * envelope and the declared scope.
 */
export const createPrivateInvalidationSubscriber = (
  dependencies: unknown,
): PrivateInvalidationSubscriber => {
  const input = asRecord(dependencies);
  if (input === undefined)
    throw new PrivateInvalidationSubscriberError("INVALID_INVALIDATION_SUBSCRIBER");
  const scopeInput = asRecord(input.scope);
  const source = asRecord(input.source);
  if (
    scopeInput === undefined ||
    source === undefined ||
    typeof source.subscribe !== "function" ||
    typeof input.onStale !== "function"
  )
    throw new PrivateInvalidationSubscriberError("INVALID_INVALIDATION_SUBSCRIBER");
  const organizationId = organizationIdSchema.safeParse(scopeInput.organizationId);
  const applicationRootId = applicationRootIdSchema.safeParse(scopeInput.applicationRootId);
  if (!organizationId.success || !applicationRootId.success)
    throw new PrivateInvalidationSubscriberError("INVALID_INVALIDATION_SUBSCRIBER");
  const scope: PrivateInvalidationTopicScope = Object.freeze({
    organizationId: organizationId.data,
    applicationRootId: applicationRootId.data,
  });
  const onStale = input.onStale as (placementIds: readonly string[]) => void;
  const subscriptionSource = source as unknown as PrivateInvalidationSubscriptionSource;

  const watches = new Map<string, PrivateInvalidationPlacementWatch>();
  const versions = new Map<string, number>();
  let stopSubscription: (() => void) | undefined;

  const receive = (message: unknown): readonly string[] => {
    const envelope = readChannelEnvelope(message);
    if (envelope === undefined || !scopeMatches(envelope, scope)) return emptyStalePlacements;
    const recordTypeKey = envelope.recordTypeId.toLowerCase();
    const noticeRecordKey = envelope.recordId?.toLowerCase();
    const stalePlacements = new Set<string>();
    const advanced = new Map<string, number>();
    for (const watch of watches.values()) {
      if (watch.recordTypeId.toLowerCase() !== recordTypeKey) continue;
      if (
        noticeRecordKey !== undefined &&
        watch.recordId !== undefined &&
        watch.recordId.toLowerCase() !== noticeRecordKey
      )
        continue;
      const key = convergenceKey(watch.placementId, watch.recordTypeId);
      if (envelope.dataVersion <= (versions.get(key) ?? 0)) continue;
      advanced.set(key, envelope.dataVersion);
      stalePlacements.add(watch.placementId);
    }
    if (stalePlacements.size === 0) return emptyStalePlacements;
    for (const [key, version] of advanced) versions.set(key, version);
    const placementIds: readonly string[] = Object.freeze([...stalePlacements].sort());
    onStale(placementIds);
    return placementIds;
  };

  return Object.freeze({
    registerWatch(candidate: unknown): () => void {
      const watch = parseWatch(candidate);
      const key = watchKey(watch);
      watches.set(key, watch);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (watches.get(key) === watch) watches.delete(key);
        const stillWatched = [...watches.values()].some(
          (entry) =>
            entry.placementId === watch.placementId &&
            entry.recordTypeId.toLowerCase() === watch.recordTypeId.toLowerCase(),
        );
        if (!stillWatched) versions.delete(convergenceKey(watch.placementId, watch.recordTypeId));
      };
    },
    receive,
    start(): void {
      if (stopSubscription !== undefined) return;
      const dispose = subscriptionSource.subscribe(receive);
      if (typeof dispose !== "function")
        throw new PrivateInvalidationSubscriberError("INVALID_INVALIDATION_SUBSCRIBER");
      stopSubscription = dispose;
    },
    stop(): void {
      if (stopSubscription === undefined) return;
      const dispose = stopSubscription;
      stopSubscription = undefined;
      dispose();
    },
  });
};
