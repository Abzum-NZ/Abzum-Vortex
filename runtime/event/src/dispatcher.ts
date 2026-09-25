import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { actorIdSchema, type EventOccurrenceEnvelopeV2 } from "@vortex/contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";
import {
  createEventConsumerProgressRepository,
  eventConsumerProgressLimits,
  type ClaimedEventOccurrence,
  type EventConsumerClaimResult,
  type EventConsumerProgressRepository,
} from "./consumer-progress";
import {
  createEventDeliveryRecoveryRepository,
  eventDeliveryFailureClassifications,
  eventDeliveryRecoveryLimits,
  type EventDeliveryFailureClassification,
  type EventDeliveryRecoveryRepository,
} from "./delivery-recovery";

export const eventDispatcherLimits = Object.freeze({
  /** Occurrences claimed by one dispatch across every selected consumer. */
  defaultBatchLimit: 20,
  maximumBatchLimit: eventConsumerProgressLimits.maximumBatchSize,
  maximumRegisteredConsumers: 32,
  defaultLeaseSeconds: 60,
  defaultMaxAttempts: 5,
  defaultRetryBackoffSeconds: 30,
  minimumCredentialLength: 32,
  maximumCredentialLength: 512,
});

export const eventDispatcherErrorCodes = [
  "INVALID_EVENT_DISPATCH_INPUT",
  "UNAUTHENTICATED_EVENT_DISPATCHER",
  "UNKNOWN_EVENT_CONSUMER",
  "INVALID_EVENT_CONSUMER_REGISTRATION",
] as const;

export type EventDispatcherErrorCode = (typeof eventDispatcherErrorCodes)[number];

export class EventDispatcherError extends Error {
  readonly code: EventDispatcherErrorCode;

  constructor(code: EventDispatcherErrorCode) {
    super(code);
    this.name = "EventDispatcherError";
    this.code = code;
  }
}

/**
 * How one registered consumer is delivered to. `leaseSeconds` is the claim
 * held for, and renewed by, each delivery; `maxAttempts` and
 * `retryBackoffSeconds` are the bounded retry policy handed to #640.
 */
export type EventConsumerDeliveryPolicy = Readonly<{
  leaseSeconds: number;
  maxAttempts: number;
  retryBackoffSeconds: number;
}>;

/**
 * One claimed occurrence handed to a consumer. Delivery is at least once: an
 * effect whose acknowledgement is lost is delivered again, so a consumer must
 * make its effect idempotent on (`consumerKey`, `occurrence.occurrenceId`).
 */
export type EventConsumerDelivery = Readonly<{
  consumerKey: string;
  occurrence: EventOccurrenceEnvelopeV2;
  causalDepth: number;
  leaseExpiresAt: string;
  /**
   * Extends this delivery's claim by the consumer's lease policy. `false` means
   * the claim is no longer held and another dispatch may reclaim it, so the
   * consumer should stop without committing its effect. It opens its own
   * runtime transaction and must not be awaited inside one the consumer holds.
   */
  renewLease: () => Promise<boolean>;
}>;

export type EventConsumerOutcome =
  | Readonly<{ outcome: "completed" }>
  | Readonly<{ outcome: "retryable_failure"; failureCode: EventDeliveryFailureClassification }>
  | Readonly<{ outcome: "terminal_failure"; failureCode: EventDeliveryFailureClassification }>;

export type EventConsumerAdapter = Readonly<{
  consumerKey: string;
  policy?: Partial<EventConsumerDeliveryPolicy>;
  deliver(delivery: EventConsumerDelivery): Promise<EventConsumerOutcome>;
}>;

/**
 * The dispatcher identity established by {@link createEventDispatcherRoute}
 * only after a verified credential and a resolved active system actor grant.
 * The actor is read from the grant, never from the request or from server
 * configuration. Only values issued by that path are accepted by a dispatch;
 * an object literal of the same shape is caller-asserted and refused.
 */
export type AuthenticatedEventDispatcher = Readonly<{
  kind: "event_dispatcher";
  systemActorId: string;
}>;

export const eventDispatcherRefusalReasons = [
  "dispatcher_not_configured",
  "credential_missing",
  "credential_rejected",
  "dispatcher_grant_missing",
  "dispatcher_grant_ambiguous",
  "dispatcher_grant_unavailable",
] as const;

export type EventDispatcherRefusalReason = (typeof eventDispatcherRefusalReasons)[number];

/** The credential check outcome; the system actor is resolved from the grant afterwards. */
export type EventDispatcherAuthentication =
  | Readonly<{ outcome: "authenticated" }>
  | Readonly<{ outcome: "refused"; reason: EventDispatcherRefusalReason }>;

/**
 * The active platform-wide system actor grant that authorises dispatch,
 * resolved by Access for the fixed dispatcher operation. `systemActorId` is
 * the granted actor; every other result refuses.
 */
export type EventDispatcherGrantAuthority =
  | Readonly<{ outcome: "authorised"; systemActorId: string }>
  | Readonly<{ outcome: "refused"; reason: EventDispatcherRefusalReason }>;

export interface EventDispatcherGrantReader {
  resolve(): Promise<EventDispatcherGrantAuthority>;
}

export type DispatchEventsInput = Readonly<{
  dispatcher: AuthenticatedEventDispatcher;
  batchLimit?: number;
  /** Restricts this dispatch to one registered consumer. */
  consumerKey?: string;
}>;

export type EventDispatchStatus = "idle" | "completed" | "partial_failure" | "interrupted";

/**
 * Content-free outcome of one bounded dispatch. `interruptedCount` counts
 * claimed occurrences this dispatch did not settle; their leases lapse and
 * they are reclaimed in order by a later dispatch, so no work is lost.
 */
export type EventDispatchResult = Readonly<{
  status: EventDispatchStatus;
  claimedCount: number;
  acknowledgedCount: number;
  retryScheduledCount: number;
  terminallyFailedCount: number;
  interruptedCount: number;
  consumersDispatched: number;
  consumersUnavailable: number;
}>;

export interface EventDispatcher {
  dispatch(input: DispatchEventsInput): Promise<EventDispatchResult>;
}

export type EventDispatcherTransactionRunner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

export type EventDispatcherDependencies = Readonly<{
  consumers: readonly EventConsumerAdapter[];
  /**
   * Runs one storage step. Every claim, renewal, acknowledgement and failure
   * report commits in its own transaction, so leases are visible to concurrent
   * dispatches and no consumer runs inside a dispatcher transaction.
   */
  runtimeTransaction?: EventDispatcherTransactionRunner;
}>;

export type EventDispatchRouteRequest = Readonly<{
  /** The request's `Authorization` header value. */
  authorization: string | null | undefined;
  batchLimit?: unknown;
  consumerKey?: unknown;
}>;

export type EventDispatchRouteResponse =
  | Readonly<{ outcome: "refused"; reason: EventDispatcherRefusalReason }>
  | Readonly<{
      outcome: "invalid_request";
      code: "INVALID_EVENT_DISPATCH_INPUT" | "UNKNOWN_EVENT_CONSUMER";
    }>
  | Readonly<{ outcome: "dispatched"; result: EventDispatchResult }>;

export type EventDispatcherRouteDependencies = EventDispatcherDependencies &
  Readonly<{
    environment?: Readonly<Record<string, string | undefined>>;
    grant?: EventDispatcherGrantReader;
  }>;

export interface EventDispatcherRoute {
  handle(request: EventDispatchRouteRequest): Promise<EventDispatchRouteResponse>;
}

const consumerKeyMatches = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= eventConsumerProgressLimits.maximumConsumerKeyLength &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

const integerWithin = (value: unknown, minimum: number, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;

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

const failureClassificationMatches = (
  value: unknown,
): value is EventDeliveryFailureClassification =>
  typeof value === "string" &&
  (eventDeliveryFailureClassifications as readonly string[]).includes(value);

// Dispatcher identities are only ever minted by mintAuthenticatedDispatcher,
// after both the credential and the grant are verified, so membership proves
// authenticity rather than shape.
const authenticatedDispatchers = new WeakSet<AuthenticatedEventDispatcher>();

type DispatcherConfiguration = Readonly<{ credentialDigest: Buffer }>;

/**
 * Only the SHA-256 digest of the dispatcher's bearer credential comes from
 * server configuration; the credential itself is held by the wake-up and
 * recovery callers. The dispatcher's system actor is never configured: it is
 * read from the active system actor grant at dispatch time.
 */
const dispatcherConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
): DispatcherConfiguration | undefined => {
  const digest = environment.VORTEX_EVENT_DISPATCHER_CREDENTIAL_SHA256;
  if (digest === undefined || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
  return Object.freeze({ credentialDigest: Buffer.from(digest, "hex") });
};

const bearerCredential = (authorization: unknown): string | undefined => {
  if (typeof authorization !== "string") return undefined;
  const match = /^Bearer ([\x21-\x7e]+)$/.exec(authorization);
  const credential = match?.[1];
  return credential !== undefined &&
    credential.length >= eventDispatcherLimits.minimumCredentialLength &&
    credential.length <= eventDispatcherLimits.maximumCredentialLength
    ? credential
    : undefined;
};

const verifyCredential = (
  configuration: DispatcherConfiguration | undefined,
  authorization: unknown,
): EventDispatcherAuthentication => {
  if (configuration === undefined)
    return { outcome: "refused", reason: "dispatcher_not_configured" };
  const credential = bearerCredential(authorization);
  if (credential === undefined) return { outcome: "refused", reason: "credential_missing" };
  const presented = createHash("sha256").update(credential, "utf8").digest();
  if (!timingSafeEqual(presented, configuration.credentialDigest))
    return { outcome: "refused", reason: "credential_rejected" };
  return { outcome: "authenticated" };
};

const mintAuthenticatedDispatcher = (systemActorId: string): AuthenticatedEventDispatcher => {
  const dispatcher: AuthenticatedEventDispatcher = Object.freeze({
    kind: "event_dispatcher",
    systemActorId,
  });
  authenticatedDispatchers.add(dispatcher);
  return dispatcher;
};

/**
 * Authenticates the dispatcher route's caller from its `Authorization: Bearer`
 * credential against the configured credential digest, in constant time. A
 * successful result only proves the credential; the system actor is resolved
 * separately from the active system actor grant, so nothing the caller sends
 * can name or elevate it. Unconfigured dispatch refuses closed.
 */
export const authenticateEventDispatcher = (
  authorization: string | null | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): EventDispatcherAuthentication =>
  verifyCredential(dispatcherConfiguration(environment), authorization);

type GrantRow = DatabaseRow & { readonly result: unknown };

// Storage may only answer with a grant refusal; a credential or configuration
// reason from it would be misreported to the caller, so it is unusable.
const grantRefusalReasons: readonly EventDispatcherRefusalReason[] = [
  "dispatcher_grant_missing",
  "dispatcher_grant_ambiguous",
  "dispatcher_grant_unavailable",
];

const grantRefusalReasonMatches = (value: unknown): value is EventDispatcherRefusalReason =>
  typeof value === "string" && (grantRefusalReasons as readonly string[]).includes(value);

const parseGrantAuthority = (candidate: unknown): EventDispatcherGrantAuthority => {
  const authorised = exactRecord(candidate, ["outcome", "systemActorId"]);
  if (
    authorised?.outcome === "authorised" &&
    actorIdSchema.safeParse(authorised.systemActorId).success
  )
    return { outcome: "authorised", systemActorId: authorised.systemActorId as string };
  const refused = exactRecord(candidate, ["outcome", "reason"]);
  if (refused?.outcome === "refused" && grantRefusalReasonMatches(refused.reason))
    return { outcome: "refused", reason: refused.reason };
  return { outcome: "refused", reason: "dispatcher_grant_unavailable" };
};

/**
 * Resolves the dispatcher's system actor through Access for the fixed
 * `dispatch_event_occurrences` operation. Dispatch claims occurrences of every
 * organisation, so the runtime function returns the granted actor only when
 * exactly one active platform-wide grant (no organisation, flow or scope
 * subject) exists; every other answer, a missing function, or an unusable
 * result refuses closed. The actor is read from the grant, never from the
 * request.
 */
export const createEventDispatcherGrantReader = (
  run: EventDispatcherTransactionRunner,
): EventDispatcherGrantReader =>
  Object.freeze({
    async resolve(): Promise<EventDispatcherGrantAuthority> {
      try {
        const rows = await run((transaction) =>
          transaction.query<GrantRow>`
            select vortex_access.resolve_event_dispatcher_actor() as result
          `,
        );
        const first = rows[0];
        if (rows.length !== 1 || first === undefined)
          return { outcome: "refused", reason: "dispatcher_grant_unavailable" };
        return parseGrantAuthority(first.result);
      } catch {
        return { outcome: "refused", reason: "dispatcher_grant_unavailable" };
      }
    },
  });

type RegisteredConsumer = Readonly<{
  consumerKey: string;
  policy: EventConsumerDeliveryPolicy;
  deliver: (delivery: EventConsumerDelivery) => Promise<EventConsumerOutcome>;
}>;

const registrationInvalid = (): never => {
  throw new EventDispatcherError("INVALID_EVENT_CONSUMER_REGISTRATION");
};

const registerConsumers = (
  adapters: readonly EventConsumerAdapter[],
): ReadonlyMap<string, RegisteredConsumer> => {
  if (!Array.isArray(adapters) || adapters.length > eventDispatcherLimits.maximumRegisteredConsumers)
    return registrationInvalid();
  const registered = new Map<string, RegisteredConsumer>();
  for (const adapter of adapters) {
    const candidate = record(adapter);
    const policy: Readonly<Record<string, unknown>> | undefined =
      candidate?.policy === undefined ? {} : record(candidate.policy);
    const consumerKey = candidate?.consumerKey;
    const deliver = candidate?.deliver;
    if (
      candidate === undefined ||
      policy === undefined ||
      !consumerKeyMatches(consumerKey) ||
      typeof deliver !== "function" ||
      registered.has(consumerKey)
    )
      return registrationInvalid();
    const leaseSeconds = policy.leaseSeconds ?? eventDispatcherLimits.defaultLeaseSeconds;
    const maxAttempts = policy.maxAttempts ?? eventDispatcherLimits.defaultMaxAttempts;
    const retryBackoffSeconds =
      policy.retryBackoffSeconds ?? eventDispatcherLimits.defaultRetryBackoffSeconds;
    if (
      !integerWithin(leaseSeconds, 1, eventConsumerProgressLimits.maximumLeaseSeconds) ||
      !integerWithin(
        maxAttempts,
        eventDeliveryRecoveryLimits.minimumRetryAttempts,
        eventDeliveryRecoveryLimits.maximumRetryAttempts,
      ) ||
      !integerWithin(
        retryBackoffSeconds,
        eventDeliveryRecoveryLimits.minimumRetryBackoffSeconds,
        eventDeliveryRecoveryLimits.maximumRetryBackoffSeconds,
      )
    )
      return registrationInvalid();
    registered.set(
      consumerKey,
      Object.freeze({
        consumerKey,
        policy: Object.freeze({ leaseSeconds, maxAttempts, retryBackoffSeconds }),
        // Bound once so a later mutation of the adapter cannot change what runs.
        deliver: (deliver as EventConsumerAdapter["deliver"]).bind(adapter),
      }),
    );
  }
  return registered;
};

type ValidatedDispatch = Readonly<{ batchLimit: number; consumerKey: string | undefined }>;

const validateDispatchInput = (candidate: unknown): ValidatedDispatch => {
  const input = record(candidate);
  if (input === undefined) throw new EventDispatcherError("INVALID_EVENT_DISPATCH_INPUT");
  const dispatcher = input.dispatcher;
  if (
    typeof dispatcher !== "object" ||
    dispatcher === null ||
    !authenticatedDispatchers.has(dispatcher as AuthenticatedEventDispatcher)
  )
    throw new EventDispatcherError("UNAUTHENTICATED_EVENT_DISPATCHER");
  if (
    Object.keys(input).some(
      (key) => key !== "dispatcher" && key !== "batchLimit" && key !== "consumerKey",
    ) ||
    (input.batchLimit !== undefined &&
      !integerWithin(input.batchLimit, 1, eventDispatcherLimits.maximumBatchLimit)) ||
    (input.consumerKey !== undefined && !consumerKeyMatches(input.consumerKey))
  )
    throw new EventDispatcherError("INVALID_EVENT_DISPATCH_INPUT");
  return {
    batchLimit: (input.batchLimit as number | undefined) ?? eventDispatcherLimits.defaultBatchLimit,
    consumerKey: input.consumerKey as string | undefined,
  };
};

type ConsumerOutcome =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "failed"; terminal: boolean; failureCode: EventDeliveryFailureClassification }>;

// Anything other than an exact, known outcome is unsafe: it is never taken as
// completion, and is reported to #640 as an unclassified retryable failure.
const unsafeOutcome: ConsumerOutcome = Object.freeze({
  kind: "failed",
  terminal: false,
  failureCode: "unclassified",
});

const parseConsumerOutcome = (candidate: unknown): ConsumerOutcome => {
  if (exactRecord(candidate, ["outcome"])?.outcome === "completed") return { kind: "completed" };
  const failed = exactRecord(candidate, ["outcome", "failureCode"]);
  if (
    (failed?.outcome === "retryable_failure" || failed?.outcome === "terminal_failure") &&
    failureClassificationMatches(failed.failureCode)
  )
    return {
      kind: "failed",
      terminal: failed.outcome === "terminal_failure",
      failureCode: failed.failureCode,
    };
  return unsafeOutcome;
};

type Settlement = "acknowledged" | "retry_scheduled" | "terminally_failed" | "interrupted";

type Tally = {
  claimedCount: number;
  acknowledgedCount: number;
  retryScheduledCount: number;
  terminallyFailedCount: number;
  interruptedCount: number;
  consumersDispatched: number;
  consumersUnavailable: number;
};

const tallySettlement = (tally: Tally, settlement: Settlement): void => {
  if (settlement === "acknowledged") tally.acknowledgedCount += 1;
  else if (settlement === "retry_scheduled") tally.retryScheduledCount += 1;
  else if (settlement === "terminally_failed") tally.terminallyFailedCount += 1;
  else tally.interruptedCount += 1;
};

const dispatchStatus = (tally: Tally): EventDispatchStatus => {
  if (tally.interruptedCount > 0 || tally.consumersUnavailable > 0) return "interrupted";
  if (tally.retryScheduledCount > 0 || tally.terminallyFailedCount > 0) return "partial_failure";
  return tally.claimedCount > 0 ? "completed" : "idle";
};

/**
 * Bounded dispatcher over #639 claims and #640 failure recovery. Only the
 * consumers registered at construction can be invoked. One dispatch claims at
 * most `batchLimit` occurrences in total, shared across the selected
 * consumers, and invokes each consumer strictly in claim order.
 *
 * Per-record sequence is enforced by #639 storage: a claim never contains an
 * occurrence whose earlier record sequence is unacknowledged, and a failed or
 * interrupted occurrence is never acknowledged here, so later occurrences for
 * that record stay withheld until it is delivered or recovered. Every claim is
 * renewed immediately before its consumer runs, so a claim whose lease lapsed
 * (and may have been reclaimed by a concurrent dispatch) is never invoked.
 */
export const createEventDispatcher = (dependencies: EventDispatcherDependencies): EventDispatcher => {
  const consumers = registerConsumers(dependencies.consumers);
  const run: EventDispatcherTransactionRunner =
    dependencies.runtimeTransaction ?? withRuntimeTransaction;
  const progress = <Result>(
    operation: (repository: EventConsumerProgressRepository) => Promise<Result>,
  ): Promise<Result> =>
    run((transaction) => operation(createEventConsumerProgressRepository(transaction)));
  const recovery = <Result>(
    operation: (repository: EventDeliveryRecoveryRepository) => Promise<Result>,
  ): Promise<Result> =>
    run((transaction) => operation(createEventDeliveryRecoveryRepository(transaction)));

  const renew = async (
    consumer: RegisteredConsumer,
    ackCursor: string,
    occurrenceId: string,
  ): Promise<string | undefined> => {
    try {
      const renewal = await progress((repository) =>
        repository.renewLease({
          consumerKey: consumer.consumerKey,
          ackCursor,
          occurrenceId,
          leaseSeconds: consumer.policy.leaseSeconds,
        }),
      );
      return renewal.outcome === "renewed" ? renewal.leaseExpiresAt : undefined;
    } catch {
      return undefined;
    }
  };

  const settle = async (
    consumer: RegisteredConsumer,
    ackCursor: string,
    occurrenceId: string,
    outcome: ConsumerOutcome,
  ): Promise<Settlement> => {
    try {
      if (outcome.kind === "completed") {
        const acknowledgement = await progress((repository) =>
          repository.acknowledge({ consumerKey: consumer.consumerKey, ackCursor, occurrenceId }),
        );
        return acknowledgement.outcome === "claim_unavailable" ? "interrupted" : "acknowledged";
      }
      const report = await recovery((repository) =>
        repository.reportFailure({
          consumerKey: consumer.consumerKey,
          occurrenceId,
          claimCursor: ackCursor,
          failureCode: outcome.failureCode,
          // A budget of one makes this reported failure terminal in #640.
          maxAttempts: outcome.terminal
            ? eventDeliveryRecoveryLimits.minimumRetryAttempts
            : consumer.policy.maxAttempts,
          retryBackoffSeconds: consumer.policy.retryBackoffSeconds,
        }),
      );
      switch (report.outcome) {
        case "retry_scheduled":
          return "retry_scheduled";
        case "terminal_failure":
          return "terminally_failed";
        case "already_acknowledged":
          return "acknowledged";
        default:
          return "interrupted";
      }
    } catch {
      // Unsettled work keeps its lease, which lapses into an ordinary reclaim.
      return "interrupted";
    }
  };

  const deliver = async (
    consumer: RegisteredConsumer,
    ackCursor: string,
    claimed: ClaimedEventOccurrence,
  ): Promise<Settlement> => {
    const occurrenceId = claimed.occurrence.occurrenceId;
    const leaseExpiresAt = await renew(consumer, ackCursor, occurrenceId);
    if (leaseExpiresAt === undefined) return "interrupted";

    const delivery: EventConsumerDelivery = Object.freeze({
      consumerKey: consumer.consumerKey,
      occurrence: claimed.occurrence,
      causalDepth: claimed.causalDepth,
      leaseExpiresAt,
      renewLease: async () => (await renew(consumer, ackCursor, occurrenceId)) !== undefined,
    });
    let outcome: ConsumerOutcome;
    try {
      outcome = parseConsumerOutcome(await consumer.deliver(delivery));
    } catch {
      outcome = unsafeOutcome;
    }
    return settle(consumer, ackCursor, occurrenceId, outcome);
  };

  const dispatchConsumer = async (
    consumer: RegisteredConsumer,
    batchSize: number,
    tally: Tally,
  ): Promise<void> => {
    let claim: EventConsumerClaimResult;
    try {
      claim = await progress((repository) =>
        repository.claim({
          consumerKey: consumer.consumerKey,
          batchSize,
          leaseSeconds: consumer.policy.leaseSeconds,
        }),
      );
    } catch {
      tally.consumersUnavailable += 1;
      return;
    }
    tally.consumersDispatched += 1;
    const { ackCursor, occurrences } = claim;
    if (ackCursor === undefined) return;
    tally.claimedCount += occurrences.length;

    // Storage never claims two occurrences of one record together; this guard
    // only keeps that guarantee local if it were ever violated.
    const unsettledRecords = new Set<string>();
    for (const claimed of occurrences) {
      const recordKey = `${claimed.occurrence.organizationId}:${claimed.occurrence.recordId}`;
      const settlement = unsettledRecords.has(recordKey)
        ? "interrupted"
        : await deliver(consumer, ackCursor, claimed);
      if (settlement !== "acknowledged") unsettledRecords.add(recordKey);
      tallySettlement(tally, settlement);
    }
  };

  return Object.freeze({
    async dispatch(candidate: DispatchEventsInput): Promise<EventDispatchResult> {
      const input = validateDispatchInput(candidate);
      let selected: readonly RegisteredConsumer[];
      if (input.consumerKey === undefined) selected = [...consumers.values()];
      else {
        const consumer = consumers.get(input.consumerKey);
        if (consumer === undefined) throw new EventDispatcherError("UNKNOWN_EVENT_CONSUMER");
        selected = [consumer];
      }

      const tally: Tally = {
        claimedCount: 0,
        acknowledgedCount: 0,
        retryScheduledCount: 0,
        terminallyFailedCount: 0,
        interruptedCount: 0,
        consumersDispatched: 0,
        consumersUnavailable: 0,
      };
      for (const [index, consumer] of selected.entries()) {
        // An even share of what remains, so capacity one consumer leaves
        // unused passes to the consumers after it and the total stays bounded.
        const share = Math.ceil(
          (input.batchLimit - tally.claimedCount) / (selected.length - index),
        );
        if (share < 1) break;
        await dispatchConsumer(consumer, share, tally);
      }
      return Object.freeze({ status: dispatchStatus(tally), ...tally });
    },
  });
};

/**
 * The protected dispatcher route: verifies the caller's credential, resolves
 * the dispatcher's system actor from an active system actor grant, then runs
 * one bounded dispatch. Webhook wake-ups and scheduled recovery both call this
 * same operation. Responses carry only refusal reasons, safe error codes and
 * counts; a missing, ambiguous or unavailable grant refuses closed before
 * any occurrence is claimed.
 */
export const createEventDispatcherRoute = (
  dependencies: EventDispatcherRouteDependencies,
): EventDispatcherRoute => {
  const configuration = dispatcherConfiguration(dependencies.environment ?? process.env);
  const dispatcher = createEventDispatcher(dependencies);
  const run: EventDispatcherTransactionRunner =
    dependencies.runtimeTransaction ?? withRuntimeTransaction;
  const grant = dependencies.grant ?? createEventDispatcherGrantReader(run);
  return Object.freeze({
    async handle(request: EventDispatchRouteRequest): Promise<EventDispatchRouteResponse> {
      const authentication = verifyCredential(configuration, request.authorization);
      if (authentication.outcome === "refused") return authentication;
      const authority = await grant.resolve();
      if (authority.outcome === "refused") return authority;
      // The granted actor is revalidated here so an injected reader cannot mint
      // an identity from an unusable value.
      if (!actorIdSchema.safeParse(authority.systemActorId).success)
        return { outcome: "refused", reason: "dispatcher_grant_unavailable" };
      const dispatcherIdentity = mintAuthenticatedDispatcher(authority.systemActorId);
      try {
        const result = await dispatcher.dispatch({
          dispatcher: dispatcherIdentity,
          ...(request.batchLimit === undefined ? {} : { batchLimit: request.batchLimit as number }),
          ...(request.consumerKey === undefined
            ? {}
            : { consumerKey: request.consumerKey as string }),
        });
        return { outcome: "dispatched", result };
      } catch (error) {
        if (
          error instanceof EventDispatcherError &&
          (error.code === "INVALID_EVENT_DISPATCH_INPUT" || error.code === "UNKNOWN_EVENT_CONSUMER")
        )
          return { outcome: "invalid_request", code: error.code };
        throw error;
      }
    },
  });
};
