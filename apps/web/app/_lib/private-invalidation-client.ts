import {
  applicationRootIdSchema,
  builderKeySchema,
  liveInvalidationSchema,
  namespacedKeySchema,
  organizationIdSchema,
} from "@vortex/contracts";
import type { PrivateInvalidationSubscriptionSource } from "@vortex/event/client";
import { z } from "zod";

/** Shared, content-free wire contract; this module has no server imports. */
export const privateInvalidationSelectorsSchema = z.object({
  tenantShortName: builderKeySchema,
  organizationShortName: builderKeySchema,
  applicationKey: namespacedKeySchema,
  pageKey: builderKeySchema,
  targetApplicationKey: namespacedKeySchema,
}).strict();

export const privateInvalidationScopeSchema = z.object({
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
}).strict();

export const privateInvalidationControlSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), scope: privateInvalidationScopeSchema }).strict(),
  z.object({ kind: z.literal("gap") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);

export const privateInvalidationTransportLimits = Object.freeze({
  maximumFrameBytes: 8192,
  maximumQueryLength: 2048,
  maximumPendingNotices: 32,
  joinMilliseconds: 10_000,
  authorityMilliseconds: 10_000,
  maximumStreamMilliseconds: 300_000,
  subscriberMilliseconds: 10_000,
  reconnectDelaysMilliseconds: Object.freeze([250, 1000, 3000]),
});

export type WebPrivateInvalidationSelectors = z.infer<typeof privateInvalidationSelectorsSchema>;
export type WebPrivateInvalidationScope = Readonly<z.infer<typeof privateInvalidationScopeSchema>>;
export type WebPrivateInvalidationControl = z.infer<typeof privateInvalidationControlSchema>;

export type WebPrivateInvalidationConnection =
  | Readonly<{ kind: "ready"; scope: WebPrivateInvalidationScope; reconnected: boolean }>
  | Readonly<{ kind: "gap" | "unavailable" | "disposed" }>;

export type WebPrivateInvalidationSourceResult =
  | Readonly<{ kind: "available"; scope: WebPrivateInvalidationScope;
      source: PrivateInvalidationSubscriptionSource; dispose(): void }>
  | Readonly<{ kind: "unavailable" }>;

const sameScope = (left: WebPrivateInvalidationScope, right: WebPrivateInvalidationScope) =>
  left.organizationId.toLowerCase() === right.organizationId.toLowerCase() &&
  left.applicationRootId.toLowerCase() === right.applicationRootId.toLowerCase();

/**
 * Acquires routing scope before constructing Event's scoped subscriber. Exactly
 * one subscribe registration owns this stream; stop is terminal for this source.
 * Connection callbacks ask the future owner for an ordinary protected reread.
 * Neither a ready scope nor a notice is evidence of permission or display data.
 */
export const openWebPrivateInvalidationSource = (
  selectorsInput: unknown,
  options: Readonly<{
    onConnection(connection: WebPrivateInvalidationConnection): void;
    signal?: AbortSignal;
  }>,
): Promise<WebPrivateInvalidationSourceResult> => {
  const unavailable = Object.freeze({ kind: "unavailable" as const });
  let selectors: WebPrivateInvalidationSelectors;
  try {
    const parsed = privateInvalidationSelectorsSchema.safeParse(selectorsInput);
    if (!parsed.success || typeof options.onConnection !== "function" ||
        typeof EventSource === "undefined" || options.signal?.aborted)
      return Promise.resolve(unavailable);
    selectors = parsed.data;
  } catch {
    return Promise.resolve(unavailable);
  }

  const query = new URLSearchParams(selectors).toString();
  if (query.length > privateInvalidationTransportLimits.maximumQueryLength)
    return Promise.resolve(unavailable);
  const url = `/api/private-invalidation?${query}`;

  return new Promise((resolve) => {
    let closed = false;
    let settled = false;
    let registered = false;
    let ready = false;
    let gapPending = false;
    let scope: WebPrivateInvalidationScope | undefined;
    let receiver: ((message: unknown) => void) | undefined;
    let socket: EventSource | undefined;
    let attemptTimer: ReturnType<typeof setTimeout> | undefined;
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let subscriberTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let notify = options.onConnection;
    const signal = options.signal;

    const report = (state: WebPrivateInvalidationConnection): void => {
      try { notify(state); } catch { /* Consumer failures reveal no transport details. */ }
    };
    const clearAttempt = (): void => {
      if (attemptTimer !== undefined) clearTimeout(attemptTimer);
      attemptTimer = undefined;
    };
    const closeSocket = (): void => {
      clearAttempt();
      if (connectionTimer !== undefined) clearTimeout(connectionTimer);
      connectionTimer = undefined;
      const previous = socket;
      socket = undefined;
      ready = false;
      if (previous !== undefined) {
        previous.onopen = null;
        previous.onerror = null;
        previous.onmessage = null;
        previous.removeEventListener("control", onControl);
        previous.removeEventListener("invalidation", onInvalidation);
        previous.close(); // Stops EventSource's unbounded built-in reconnect.
      }
    };
    const finish = (kind: "unavailable" | "disposed"): void => {
      if (closed) return;
      closed = true;
      closeSocket();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (subscriberTimer !== undefined) clearTimeout(subscriberTimer);
      retryTimer = subscriberTimer = undefined;
      signal?.removeEventListener("abort", onAbort);
      receiver = undefined;
      report({ kind });
      notify = () => undefined;
      if (!settled) { settled = true; resolve(unavailable); }
    };
    const onAbort = (): void => finish("disposed");
    const reportGap = (): void => {
      gapPending = true;
      report({ kind: "gap" });
    };
    const retry = (): void => {
      if (closed || retryTimer !== undefined) return;
      closeSocket();
      reportGap();
      if (closed) return; // A consumer may dispose from its callback.
      const delay = privateInvalidationTransportLimits.reconnectDelaysMilliseconds[retries++];
      if (delay === undefined) { finish("unavailable"); return; }
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, delay);
    };
    const parseData = (event: Event): unknown => {
      if (!(event instanceof MessageEvent) || typeof event.data !== "string" ||
          event.data.length > privateInvalidationTransportLimits.maximumFrameBytes)
        return undefined;
      if (new TextEncoder().encode(event.data).byteLength >
          privateInvalidationTransportLimits.maximumFrameBytes) return undefined;
      try { return JSON.parse(event.data) as unknown; } catch { return undefined; }
    };
    const source: PrivateInvalidationSubscriptionSource = Object.freeze({
      subscribe(onMessage: (message: unknown) => void): () => void {
        if (closed) throw new Error("PRIVATE_INVALIDATION_SOURCE_UNAVAILABLE");
        if (registered || typeof onMessage !== "function")
          throw new Error("INVALID_PRIVATE_INVALIDATION_REGISTRATION");
        registered = true;
        if (subscriberTimer !== undefined) clearTimeout(subscriberTimer);
        subscriberTimer = undefined;
        if (!closed) {
          receiver = onMessage;
          if (gapPending) report({ kind: "gap" });
        }
        return () => finish("disposed");
      },
    });
    function onControl(event: Event): void {
      if (closed || event.currentTarget !== socket) return;
      const parsed = privateInvalidationControlSchema.safeParse(parseData(event));
      if (!parsed.success) { finish("unavailable"); return; }
      if (parsed.data.kind === "unavailable") { finish("unavailable"); return; }
      if (parsed.data.kind === "gap") { retry(); return; }
      if (ready) { finish("unavailable"); return; }
      const next = Object.freeze(parsed.data.scope);
      if (scope !== undefined && !sameScope(scope, next)) { finish("unavailable"); return; }
      const reconnected = scope !== undefined;
      scope = scope ?? next;
      ready = true;
      clearAttempt();
      // A lost FIN or half-open network must not retain this source forever.
      connectionTimer = setTimeout(retry,
        privateInvalidationTransportLimits.maximumStreamMilliseconds +
        privateInvalidationTransportLimits.joinMilliseconds);
      if (!settled) {
        settled = true;
        subscriberTimer = setTimeout(() => finish("disposed"),
          privateInvalidationTransportLimits.subscriberMilliseconds);
        resolve(Object.freeze({ kind: "available", scope, source,
          dispose: () => finish("disposed") }));
      }
      report({ kind: "ready", scope, reconnected });
    }
    function onInvalidation(event: Event): void {
      if (closed || !ready || scope === undefined || event.currentTarget !== socket) return;
      const parsed = liveInvalidationSchema.safeParse(parseData(event));
      if (!parsed.success || !sameScope(scope, parsed.data)) return;
      if (receiver === undefined) { reportGap(); return; }
      try { receiver(parsed.data); } catch { reportGap(); }
    }
    function connect(): void {
      if (closed) return;
      try {
        socket = new EventSource(url); // Fixed same-origin path; only selectors in its query.
        socket.addEventListener("control", onControl);
        socket.addEventListener("invalidation", onInvalidation);
        socket.onerror = retry;
        socket.onmessage = () => finish("unavailable");
        attemptTimer = setTimeout(retry, privateInvalidationTransportLimits.joinMilliseconds);
      } catch { retry(); }
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else connect();
  });
};
