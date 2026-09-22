import "server-only";

import {
  actorIdSchema,
  timestampSchema,
  type EventOccurrenceEnvelopeV2,
} from "@vortex/contracts";
import type { RuntimeDatabaseTransaction } from "@vortex/db";
import {
  createEventConsumerProgressRepository,
  eventConsumerProgressLimits,
  EventConsumerProgressError,
  type ClaimedEventOccurrence,
  type EventConsumerClaimResult,
  type EventConsumerProgressRepository,
} from "./consumer-progress";
import {
  createEventDeliveryRecoveryRepository,
  eventDeliveryFailureClassifications,
  eventDeliveryRecoveryLimits,
  EventDeliveryRecoveryError,
  type EventDeliveryFailureClassification,
  type EventDeliveryRecoveryRepository,
} from "./delivery-recovery";

export const eventDispatcherLimits = Object.freeze({
  defaultBatchSize: 20,
  maximumBatchSize: eventConsumerProgressLimits.maximumBatchSize,
  minimumBatchSize: 1,
  defaultLeaseSeconds: 60,
  maximumLeaseSeconds: eventConsumerProgressLimits.maximumLeaseSeconds,
  minimumLeaseSeconds: 1,
  maximumConsumerKeyLength: eventConsumerProgressLimits.maximumConsumerKeyLength,
  defaultRetryAttempts: 5,
  maximumRetryAttempts: eventDeliveryRecoveryLimits.maximumRetryAttempts,
  minimumRetryAttempts: eventDeliveryRecoveryLimits.minimumRetryAttempts,
  defaultRetryBackoffSeconds: 30,
  minimumRetryBackoffSeconds: eventDeliveryRecoveryLimits.minimumRetryBackoffSeconds,
  maximumRetryBackoffSeconds: eventDeliveryRecoveryLimits.maximumRetryBackoffSeconds,
  maximumRegisteredConsumers: 32,
});

export const eventDispatcherErrorCodes = [
  "UNAUTHENTICATED_DISPATCHER",
  "UNKNOWN_EVENT_CONSUMER",
  "INVALID_EVENT_DISPATCHER_INPUT",
  "EVENT_DISPATCHER_STORAGE_UNAVAILABLE",
  "STALE_CLAIM_CURSOR",
  "UNSAFE_EVENT_CONSUMER_OUTCOME",
  "DUPLICATE_EVENT_CONSUMER_REGISTRATION",
  "EVENT_CONSUMER_REGISTRATION_LIMIT_EXCEEDED",
] as const;

export type EventDispatcherErrorCode = (typeof eventDispatcherErrorCodes)[number];

export class EventDispatcherError extends Error {
  readonly code: EventDispatcherErrorCode;

  constructor(code: EventDispatcherErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "EventDispatcherError";
    this.code = code;
  }
}

/**
 * Authenticated system identity claiming or running dispatch.
 * Caller-asserted consumer authority or arbitrary operator overrides are strictly rejected.
 */
export type AuthenticatedDispatcherIdentity = Readonly<{
  dispatcherId?: string;
  actorId?: string;
  systemActorId?: string;
  kind?: "system" | "dispatcher";
  authenticatedAt?: string;
}>;

export type EventConsumerInvocationContext = Readonly<{
  consumerKey: string;
  occurrence: EventOccurrenceEnvelopeV2;
  causalDepth: number;
  leaseExpiresAt: string;
  claimCursor: string;
  renewLease: (leaseSeconds?: number) => Promise<boolean>;
}>;

export type EventConsumerInvocationSuccessOutcome = Readonly<{
  outcome: "completed" | "acknowledged" | "already_completed";
}>;

export type EventConsumerInvocationFailureOutcome = Readonly<{
  outcome: "failed" | "retryable_failure" | "terminal_failure";
  failureCode?: EventDeliveryFailureClassification;
  maxAttempts?: number;
  retryBackoffSeconds?: number;
}>;

export type EventConsumerInvocationResult =
  | EventConsumerInvocationSuccessOutcome
  | EventConsumerInvocationFailureOutcome;

export interface EventConsumerAdapter {
  readonly consumerKey: string;
  readonly defaultMaxAttempts?: number;
  readonly defaultRetryBackoffSeconds?: number;
  handle(
    occurrence: EventOccurrenceEnvelopeV2,
    context: EventConsumerInvocationContext,
  ): Promise<EventConsumerInvocationResult>;
}

export interface EventDispatcherRegistry {
  register(adapter: EventConsumerAdapter): void;
  get(consumerKey: string): EventConsumerAdapter | undefined;
  has(consumerKey: string): boolean;
  list(): readonly EventConsumerAdapter[];
  listKeys(): readonly string[];
  readonly size: number;
}

export type DispatchEventsInput = Readonly<{
  dispatcherIdentity: AuthenticatedDispatcherIdentity;
  batchSize?: number;
  batchLimit?: number;
  consumerKey?: string;
  leaseSeconds?: number;
}>;

export type EventDispatchStatus =
  | "idle"
  | "completed"
  | "partial_failure"
  | "interrupted";

/**
 * Content-free result counts and safe delivery status.
 */
export type DispatchEventsResult = Readonly<{
  status: EventDispatchStatus;
  claimedCount: number;
  acknowledgedCount: number;
  retryScheduledCount: number;
  terminallyFailedCount: number;
  unprocessedCount: number;
  consumersDispatched: number;
}>;

export interface EventDispatcher {
  dispatch(input: DispatchEventsInput): Promise<DispatchEventsResult>;
  registerConsumer(adapter: EventConsumerAdapter): void;
  getRegisteredConsumer(consumerKey: string): EventConsumerAdapter | undefined;
  listRegisteredConsumers(): readonly string[];
}

export type EventDispatcherDependencies = Readonly<{
  progressRepository: EventConsumerProgressRepository;
  recoveryRepository: EventDeliveryRecoveryRepository;
  consumers?: readonly EventConsumerAdapter[] | EventDispatcherRegistry;
}>;

export type EventDispatcherDatabaseDependencies = Readonly<{
  consumers?: readonly EventConsumerAdapter[] | EventDispatcherRegistry;
}>;

const consumerKeyMatches = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= eventDispatcherLimits.maximumConsumerKeyLength &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

const uuidMatches = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "00000000-0000-0000-0000-000000000000" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const timestampMatches = (value: unknown): value is string =>
  timestampSchema.safeParse(value).success;

const deriveRecordKey = (occurrence: EventOccurrenceEnvelopeV2): string =>
  `${occurrence.organizationId}:${occurrence.installation.applicationRootId}:${occurrence.recordId}`;

const validateDispatcherIdentity = (candidate: unknown): AuthenticatedDispatcherIdentity => {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new EventDispatcherError(
      "UNAUTHENTICATED_DISPATCHER",
      "Dispatcher identity must be an authenticated object",
    );
  }

  const identity = candidate as Readonly<Record<string, unknown>>;
  const dispatcherId = identity.dispatcherId;
  const actorId = identity.actorId;
  const systemActorId = identity.systemActorId;
  const kind = identity.kind;
  const authenticatedAt = identity.authenticatedAt;

  const validDispatcherId = typeof dispatcherId === "string" && uuidMatches(dispatcherId);
  const validActorId = typeof actorId === "string" && uuidMatches(actorId);
  const validSystemActorId = typeof systemActorId === "string" && uuidMatches(systemActorId);

  if (!validDispatcherId && !validActorId && !validSystemActorId) {
    throw new EventDispatcherError(
      "UNAUTHENTICATED_DISPATCHER",
      "Dispatcher identity must include at least one valid UUID identifier (dispatcherId, actorId, or systemActorId)",
    );
  }

  if (dispatcherId !== undefined && !validDispatcherId) {
    throw new EventDispatcherError("UNAUTHENTICATED_DISPATCHER", "Invalid dispatcherId format");
  }
  if (actorId !== undefined && !validActorId) {
    throw new EventDispatcherError("UNAUTHENTICATED_DISPATCHER", "Invalid actorId format");
  }
  if (systemActorId !== undefined && !validSystemActorId) {
    throw new EventDispatcherError("UNAUTHENTICATED_DISPATCHER", "Invalid systemActorId format");
  }
  if (kind !== undefined && kind !== "system" && kind !== "dispatcher") {
    throw new EventDispatcherError("UNAUTHENTICATED_DISPATCHER", "Invalid identity kind");
  }
  if (authenticatedAt !== undefined && !timestampMatches(authenticatedAt)) {
    throw new EventDispatcherError("UNAUTHENTICATED_DISPATCHER", "Invalid authenticatedAt timestamp");
  }

  return Object.freeze({
    ...(validDispatcherId ? { dispatcherId: dispatcherId as string } : {}),
    ...(validActorId ? { actorId: actorId as string } : {}),
    ...(validSystemActorId ? { systemActorId: systemActorId as string } : {}),
    ...(kind !== undefined ? { kind: kind as "system" | "dispatcher" } : {}),
    ...(authenticatedAt !== undefined ? { authenticatedAt: authenticatedAt as string } : {}),
  });
};

const validateDispatchInput = (inputCandidate: unknown): DispatchEventsInput => {
  if (typeof inputCandidate !== "object" || inputCandidate === null || Array.isArray(inputCandidate)) {
    throw new EventDispatcherError("INVALID_EVENT_DISPATCHER_INPUT", "Input must be an object");
  }

  const input = inputCandidate as Readonly<Record<string, unknown>>;

  // Refuse caller-asserted consumer authority
  if (
    "consumerAuthority" in input ||
    "callerAuthority" in input ||
    "operatorAuthority" in input ||
    "operatorToken" in input ||
    "consumerCredentials" in input
  ) {
    throw new EventDispatcherError(
      "INVALID_EVENT_DISPATCHER_INPUT",
      "Caller-asserted consumer authority is not accepted",
    );
  }

  const dispatcherIdentity = validateDispatcherIdentity(input.dispatcherIdentity);

  const rawBatch = input.batchLimit ?? input.batchSize;
  let batchSize = eventDispatcherLimits.defaultBatchSize;
  if (rawBatch !== undefined) {
    if (
      !Number.isInteger(rawBatch) ||
      (rawBatch as number) < eventDispatcherLimits.minimumBatchSize ||
      (rawBatch as number) > eventDispatcherLimits.maximumBatchSize
    ) {
      throw new EventDispatcherError(
        "INVALID_EVENT_DISPATCHER_INPUT",
        `Batch limit must be an integer between ${eventDispatcherLimits.minimumBatchSize} and ${eventDispatcherLimits.maximumBatchSize}`,
      );
    }
    batchSize = rawBatch as number;
  }

  let leaseSeconds = eventDispatcherLimits.defaultLeaseSeconds;
  if (input.leaseSeconds !== undefined) {
    if (
      !Number.isInteger(input.leaseSeconds) ||
      (input.leaseSeconds as number) < eventDispatcherLimits.minimumLeaseSeconds ||
      (input.leaseSeconds as number) > eventDispatcherLimits.maximumLeaseSeconds
    ) {
      throw new EventDispatcherError(
        "INVALID_EVENT_DISPATCHER_INPUT",
        `Lease seconds must be an integer between ${eventDispatcherLimits.minimumLeaseSeconds} and ${eventDispatcherLimits.maximumLeaseSeconds}`,
      );
    }
    leaseSeconds = input.leaseSeconds as number;
  }

  let consumerKey: string | undefined;
  if (input.consumerKey !== undefined) {
    if (!consumerKeyMatches(input.consumerKey)) {
      throw new EventDispatcherError("INVALID_EVENT_DISPATCHER_INPUT", "Invalid consumerKey");
    }
    consumerKey = input.consumerKey;
  }

  return Object.freeze({
    dispatcherIdentity,
    batchSize,
    leaseSeconds,
    ...(consumerKey !== undefined ? { consumerKey } : {}),
  });
};

export const createEventDispatcherRegistry = (
  initialAdapters?: readonly EventConsumerAdapter[],
): EventDispatcherRegistry => {
  const adapters = new Map<string, EventConsumerAdapter>();

  const register = (adapter: EventConsumerAdapter): void => {
    if (typeof adapter !== "object" || adapter === null) {
      throw new EventDispatcherError("INVALID_EVENT_DISPATCHER_INPUT", "Adapter must be an object");
    }
    if (!consumerKeyMatches(adapter.consumerKey)) {
      throw new EventDispatcherError("INVALID_EVENT_DISPATCHER_INPUT", "Invalid consumerKey on adapter");
    }
    if (typeof adapter.handle !== "function") {
      throw new EventDispatcherError("INVALID_EVENT_DISPATCHER_INPUT", "Adapter must provide a handle function");
    }
    if (adapters.has(adapter.consumerKey)) {
      throw new EventDispatcherError(
        "DUPLICATE_EVENT_CONSUMER_REGISTRATION",
        `Consumer key already registered: ${adapter.consumerKey}`,
      );
    }
    if (adapters.size >= eventDispatcherLimits.maximumRegisteredConsumers) {
      throw new EventDispatcherError(
        "EVENT_CONSUMER_REGISTRATION_LIMIT_EXCEEDED",
        `Registration limit of ${eventDispatcherLimits.maximumRegisteredConsumers} exceeded`,
      );
    }
    if (
      adapter.defaultMaxAttempts !== undefined &&
      (!Number.isInteger(adapter.defaultMaxAttempts) ||
        adapter.defaultMaxAttempts < eventDeliveryRecoveryLimits.minimumRetryAttempts ||
        adapter.defaultMaxAttempts > eventDeliveryRecoveryLimits.maximumRetryAttempts)
    ) {
      throw new EventDispatcherError("INVALID_EVENT_DISPATCHER_INPUT", "Invalid defaultMaxAttempts");
    }
    if (
      adapter.defaultRetryBackoffSeconds !== undefined &&
      (!Number.isInteger(adapter.defaultRetryBackoffSeconds) ||
        adapter.defaultRetryBackoffSeconds < eventDeliveryRecoveryLimits.minimumRetryBackoffSeconds ||
        adapter.defaultRetryBackoffSeconds > eventDeliveryRecoveryLimits.maximumRetryBackoffSeconds)
    ) {
      throw new EventDispatcherError("INVALID_EVENT_DISPATCHER_INPUT", "Invalid defaultRetryBackoffSeconds");
    }

    adapters.set(adapter.consumerKey, Object.freeze({ ...adapter }));
  };

  if (initialAdapters) {
    for (const adapter of initialAdapters) {
      register(adapter);
    }
  }

  return Object.freeze({
    register,
    get: (key: string) => adapters.get(key),
    has: (key: string) => adapters.has(key),
    list: () => Object.freeze(Array.from(adapters.values())),
    listKeys: () => Object.freeze(Array.from(adapters.keys())),
    get size() {
      return adapters.size;
    },
  });
};

export const createEventDispatcher = (
  dependencies: EventDispatcherDependencies,
): EventDispatcher => {
  const registry: EventDispatcherRegistry =
    dependencies.consumers && "register" in dependencies.consumers
      ? dependencies.consumers
      : createEventDispatcherRegistry(dependencies.consumers as readonly EventConsumerAdapter[] | undefined);

  const dispatchForConsumer = async (
    adapter: EventConsumerAdapter,
    batchSize: number,
    leaseSeconds: number,
  ): Promise<{
    claimedCount: number;
    acknowledgedCount: number;
    retryScheduledCount: number;
    terminallyFailedCount: number;
    unprocessedCount: number;
    staleCount: number;
  }> => {
    const consumerKey = adapter.consumerKey;

    let claimResult: EventConsumerClaimResult;
    try {
      claimResult = await dependencies.progressRepository.claim({
        consumerKey,
        batchSize,
        leaseSeconds,
      });
    } catch (error) {
      if (error instanceof EventConsumerProgressError) {
        if (error.code === "INVALID_EVENT_CONSUMER_PROGRESS_INPUT") {
          throw new EventDispatcherError("INVALID_EVENT_DISPATCHER_INPUT");
        }
        throw new EventDispatcherError("EVENT_DISPATCHER_STORAGE_UNAVAILABLE");
      }
      throw new EventDispatcherError("EVENT_DISPATCHER_STORAGE_UNAVAILABLE");
    }

    const { ackCursor, occurrences } = claimResult;
    if (!ackCursor || occurrences.length === 0) {
      return {
        claimedCount: 0,
        acknowledgedCount: 0,
        retryScheduledCount: 0,
        terminallyFailedCount: 0,
        unprocessedCount: 0,
        staleCount: 0,
      };
    }

    let acknowledgedCount = 0;
    let retryScheduledCount = 0;
    let terminallyFailedCount = 0;
    let unprocessedCount = 0;
    let staleCount = 0;

    const blockedRecords = new Set<string>();

    for (const claimed of occurrences) {
      const { occurrence } = claimed;
      const occurrenceId = occurrence.occurrenceId;
      const recordKey = deriveRecordKey(occurrence);

      // Preserve per-record sequence: do not advance an occurrence if an earlier
      // occurrence for the same record encountered a failure in this batch.
      if (blockedRecords.has(recordKey)) {
        unprocessedCount++;
        continue;
      }

      const context: EventConsumerInvocationContext = Object.freeze({
        consumerKey,
        occurrence,
        causalDepth: claimed.causalDepth,
        leaseExpiresAt: claimed.leaseExpiresAt,
        claimCursor: ackCursor,
        async renewLease(extensionSeconds?: number): Promise<boolean> {
          try {
            const renewSecs = extensionSeconds ?? leaseSeconds;
            const result = await dependencies.progressRepository.renewLease({
              consumerKey,
              ackCursor,
              occurrenceId,
              leaseSeconds: renewSecs,
            });
            return result.outcome === "renewed";
          } catch {
            return false;
          }
        },
      });

      let invocationResult: EventConsumerInvocationResult;
      try {
        const rawResult = await adapter.handle(occurrence, context);
        if (
          typeof rawResult !== "object" ||
          rawResult === null ||
          typeof (rawResult as any).outcome !== "string"
        ) {
          invocationResult = {
            outcome: "failed",
            failureCode: "unclassified",
          };
        } else {
          invocationResult = rawResult;
        }
      } catch {
        invocationResult = {
          outcome: "failed",
          failureCode: "unclassified",
        };
      }

      if (
        invocationResult.outcome === "completed" ||
        invocationResult.outcome === "acknowledged" ||
        invocationResult.outcome === "already_completed"
      ) {
        try {
          const ackResult = await dependencies.progressRepository.acknowledge({
            consumerKey,
            ackCursor,
            occurrenceId,
          });

          if (
            ackResult.outcome === "acknowledged" ||
            ackResult.outcome === "already_acknowledged"
          ) {
            acknowledgedCount++;
          } else {
            // Claim unavailable: lease expired or mismatched
            staleCount++;
            blockedRecords.add(recordKey);
          }
        } catch {
          staleCount++;
          blockedRecords.add(recordKey);
        }
      } else if (
        invocationResult.outcome === "failed" ||
        invocationResult.outcome === "retryable_failure" ||
        invocationResult.outcome === "terminal_failure"
      ) {
        const failureCode =
          invocationResult.failureCode &&
          (eventDeliveryFailureClassifications as readonly string[]).includes(
            invocationResult.failureCode,
          )
            ? invocationResult.failureCode
            : "unclassified";

        const maxAttempts =
          invocationResult.maxAttempts ??
          adapter.defaultMaxAttempts ??
          eventDispatcherLimits.defaultRetryAttempts;

        const retryBackoffSeconds =
          invocationResult.retryBackoffSeconds ??
          adapter.defaultRetryBackoffSeconds ??
          eventDispatcherLimits.defaultRetryBackoffSeconds;

        try {
          const failureReport =
            await dependencies.recoveryRepository.reportFailure({
              consumerKey,
              occurrenceId,
              claimCursor: ackCursor,
              failureCode,
              maxAttempts,
              retryBackoffSeconds,
            });

          if (failureReport.outcome === "retry_scheduled") {
            retryScheduledCount++;
            blockedRecords.add(recordKey);
          } else if (failureReport.outcome === "terminal_failure") {
            terminallyFailedCount++;
            blockedRecords.add(recordKey);
          } else if (failureReport.outcome === "already_acknowledged") {
            acknowledgedCount++;
          } else {
            // claim_unavailable or mismatched
            staleCount++;
            blockedRecords.add(recordKey);
          }
        } catch {
          staleCount++;
          blockedRecords.add(recordKey);
        }
      } else {
        // Unsafe unrecognized outcome: delegate retry to #640 without acknowledging
        try {
          await dependencies.recoveryRepository.reportFailure({
            consumerKey,
            occurrenceId,
            claimCursor: ackCursor,
            failureCode: "unclassified",
            maxAttempts:
              adapter.defaultMaxAttempts ??
              eventDispatcherLimits.defaultRetryAttempts,
            retryBackoffSeconds:
              adapter.defaultRetryBackoffSeconds ??
              eventDispatcherLimits.defaultRetryBackoffSeconds,
          });
        } catch {
          // preserve unacknowledged state
        }
        retryScheduledCount++;
        blockedRecords.add(recordKey);
      }
    }

    return {
      claimedCount: occurrences.length,
      acknowledgedCount,
      retryScheduledCount,
      terminallyFailedCount,
      unprocessedCount,
      staleCount,
    };
  };

  return Object.freeze({
    async dispatch(inputCandidate: DispatchEventsInput): Promise<DispatchEventsResult> {
      const validated = validateDispatchInput(inputCandidate);

      let consumersToDispatch: readonly EventConsumerAdapter[];
      if (validated.consumerKey !== undefined) {
        const adapter = registry.get(validated.consumerKey);
        if (!adapter) {
          throw new EventDispatcherError(
            "UNKNOWN_EVENT_CONSUMER",
            `Unknown or unregistered event consumer: ${validated.consumerKey}`,
          );
        }
        consumersToDispatch = [adapter];
      } else {
        consumersToDispatch = registry.list();
      }

      if (consumersToDispatch.length === 0) {
        return Object.freeze({
          status: "idle",
          claimedCount: 0,
          acknowledgedCount: 0,
          retryScheduledCount: 0,
          terminallyFailedCount: 0,
          unprocessedCount: 0,
          consumersDispatched: 0,
        });
      }

      let totalClaimed = 0;
      let totalAcknowledged = 0;
      let totalRetryScheduled = 0;
      let totalTerminallyFailed = 0;
      let totalUnprocessed = 0;
      let totalStale = 0;
      let consumersDispatched = 0;

      for (const adapter of consumersToDispatch) {
        const result = await dispatchForConsumer(
          adapter,
          validated.batchSize ?? eventDispatcherLimits.defaultBatchSize,
          validated.leaseSeconds ?? eventDispatcherLimits.defaultLeaseSeconds,
        );

        totalClaimed += result.claimedCount;
        totalAcknowledged += result.acknowledgedCount;
        totalRetryScheduled += result.retryScheduledCount;
        totalTerminallyFailed += result.terminallyFailedCount;
        totalUnprocessed += result.unprocessedCount;
        totalStale += result.staleCount;
        consumersDispatched++;
      }

      let status: EventDispatchStatus;
      if (totalClaimed === 0) {
        status = "idle";
      } else if (totalStale > 0) {
        status = "interrupted";
      } else if (
        totalRetryScheduled > 0 ||
        totalTerminallyFailed > 0 ||
        totalUnprocessed > 0
      ) {
        status = totalAcknowledged > 0 ? "partial_failure" : "interrupted";
      } else {
        status = "completed";
      }

      return Object.freeze({
        status,
        claimedCount: totalClaimed,
        acknowledgedCount: totalAcknowledged,
        retryScheduledCount: totalRetryScheduled,
        terminallyFailedCount: totalTerminallyFailed,
        unprocessedCount: totalUnprocessed,
        consumersDispatched,
      });
    },

    registerConsumer(adapter: EventConsumerAdapter): void {
      registry.register(adapter);
    },

    getRegisteredConsumer(consumerKey: string): EventConsumerAdapter | undefined {
      return registry.get(consumerKey);
    },

    listRegisteredConsumers(): readonly string[] {
      return registry.listKeys();
    },
  });
};

/**
 * Event-owned runtime adapter creating a protected bounded dispatcher wired to
 * a server-only runtime database transaction.
 */
export const createDatabaseEventDispatcher = (
  transaction: RuntimeDatabaseTransaction,
  dependencies?: EventDispatcherDatabaseDependencies,
): EventDispatcher =>
  createEventDispatcher({
    progressRepository: createEventConsumerProgressRepository(transaction),
    recoveryRepository: createEventDeliveryRecoveryRepository(transaction),
    consumers: dependencies?.consumers,
  });
