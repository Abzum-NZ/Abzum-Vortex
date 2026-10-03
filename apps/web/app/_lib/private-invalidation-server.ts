import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { withRequestDatabaseLifetime } from "@vortex/db";
import { liveInvalidationSchema, type LiveInvalidation } from "@vortex/contracts";
import {
  privateInvalidationBroadcastEvent,
  privateInvalidationTopic,
  type PrivateInvalidationAuthorizationRequest,
} from "@vortex/event";
import { getIdentityJourneyConfiguration } from "../auth/_lib/authority-configuration";
import { resolveIdentitySessionForPrivateInvalidation } from "../auth/_lib/session-server";
import { requestMatchesConfiguredSite } from "../auth/_lib/session-request-state";
import {
  createWebPrivateInvalidationChannelAuthority,
  type WebPrivateInvalidationChannelAuthority,
} from "./private-invalidation-authority";
import {
  privateInvalidationSelectorsSchema,
  privateInvalidationTransportLimits as limits,
  type WebPrivateInvalidationControl,
  type WebPrivateInvalidationScope,
  type WebPrivateInvalidationSelectors,
} from "./private-invalidation-client";
import { PrivateInvalidationTransportOwner } from "./private-invalidation-socket";
import { createOwnedNetworkLookup } from "./owned-network-lookup";

const encoder = new TextEncoder();
const streamHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
};

const frame = (event: "control" | "invalidation", content: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(content)}\n\n`);

const neutralResponse = (): Response => new Response(
  frame("control", { kind: "unavailable" }), { headers: streamHeaders },
);

const readSelectors = (url: URL): WebPrivateInvalidationSelectors | undefined => {
  if (url.search.length > limits.maximumQueryLength) return undefined;
  const allowed = ["tenantShortName", "organizationShortName", "applicationKey",
    "pageKey", "targetApplicationKey"] as const;
  const candidate: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.some((name) => name === key) || Object.hasOwn(candidate, key))
      return undefined;
    candidate[key] = value;
  }
  const parsed = privateInvalidationSelectorsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

/** Match the existing subscriber normalization: unwrap payload and remove only id. */
const readNotice = (message: unknown): LiveInvalidation | undefined => {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const outer = message as Record<string, unknown>;
  const payload = outer.payload === undefined ? outer : outer.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const candidate: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  // Stop inspecting hostile objects after the canonical key bound. Do not
  // allocate Object.entries over an arbitrary received object's entire shape.
  let count = 0;
  for (const key in payload) {
    if (!Object.hasOwn(payload, key)) continue;
    if (++count > 13) return undefined;
    if (key !== "id") {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > limits.maximumFrameBytes) return undefined;
      candidate[key] = value;
    }
  }
  const parsed = liveInvalidationSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

/**
 * One live route request owns one server-authenticated private Broadcast socket.
 * Capture public Node async context now, before stream/SDK callbacks are created;
 * every protected read runs in this request, never in a detached service context.
 */
export const createWebPrivateInvalidationResponse = (request: Request): Response => {
  let selectors: WebPrivateInvalidationSelectors;
  let configuration: ReturnType<typeof getIdentityJourneyConfiguration>;
  try {
    const url = new URL(request.url);
    configuration = getIdentityJourneyConfiguration();
    const origin = request.headers.get("origin");
    if (request.method !== "GET" ||
        !requestMatchesConfiguredSite(request.headers, url, configuration.siteUrl) ||
        (origin !== null && origin !== new URL(configuration.siteUrl).origin) ||
        request.signal.aborted)
      return neutralResponse();
    const parsed = readSelectors(url);
    if (parsed === undefined) return neutralResponse();
    selectors = parsed;
  } catch { return neutralResponse(); }

  // No private Next stores, cross-request session cache, or refreshed credential.
  let runInRequest: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined =
    AsyncLocalStorage.snapshot();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let client: SupabaseClient | undefined;
  let channel: ReturnType<SupabaseClient["channel"]> | undefined;
  let authority: WebPrivateInvalidationChannelAuthority | undefined;
  let verifiedToken: string | undefined;
  let authorizationRequest: PrivateInvalidationAuthorizationRequest | undefined;
  let scope: WebPrivateInvalidationScope | undefined;
  let expiresAt = 0;
  const stopController = new AbortController();
  const transport = new PrivateInvalidationTransportOwner(
    new URL(configuration.supabaseUrl), Date.now() + limits.maximumStreamMilliseconds,
    () => { void finish(ready ? "gap" : "unavailable"); },
  );
  const operations = new Set<Promise<void>>();
  let stopping = false;
  let disposal: Promise<void> | undefined;
  let joined = false;
  let ready = false;
  let pumping = false;
  const pending: LiveInvalidation[] = [];
  let joinTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let workTimer: ReturnType<typeof setTimeout> | undefined;

  const live = (): boolean => !stopping && !request.signal.aborted &&
    expiresAt > Date.now();

  const track = (operation: Promise<void>): void => {
    const observed = operation.catch(() => { finish("unavailable"); });
    operations.add(observed);
    void observed.then(() => operations.delete(observed));
  };

  const finish = (control?: "gap" | "unavailable"): Promise<void> => {
    if (disposal !== undefined) return disposal;
    stopping = true;
    stopController.abort();
    request.signal.removeEventListener("abort", onAbort);
    if (joinTimer !== undefined) clearTimeout(joinTimer);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    if (workTimer !== undefined) clearTimeout(workTimer);
    joinTimer = expiryTimer = workTimer = undefined;
    pending.length = 0;
    let previous = client;
    client = undefined;
    transport.fence();
    let cleanupFailed = false;
    // Phoenix must mark this disconnect clean before our physical close can
    // reach its onclose callback; otherwise it schedules a reconnect timer.
    const disconnected = previous?.realtime.disconnect().catch(() => { cleanupFailed = true; });
    transport.stop();
    // Start channel teardown immediately too. A socket already closing can make
    // disconnect return early; unsubscribe's local close and subsequent disconnect
    // still reset Phoenix's reconnect work while provider/crypto operations drain.
    const removed = previous?.removeAllChannels().catch(() => {
      cleanupFailed = true;
    }).finally(() => {
      try { channel?.teardown(); } catch { cleanupFailed = true; }
      channel = undefined;
    });
    // Fence first; join actual accepted operations and physical closure before
    // declaring disposal or releasing this route's captured request context.
    disposal = (async () => {
      while (operations.size > 0) await Promise.all([...operations]);
      await transport.settled().catch(() => { cleanupFailed = true; });
      await disconnected;
      await removed;
      if (previous !== undefined) {
        // Now the exact socket is closed, so this call cannot take the SDK's
        // early "already closing" branch. It resets any late reconnect attempt.
        await previous.realtime.disconnect().catch(() => { cleanupFailed = true; });
        // Channel leave/teardown has now settled, so clearing auth cannot create
        // channel updates. The accessToken callback has been fenced to null.
        await previous.realtime.setAuth(null).catch(() => { cleanupFailed = true; });
        // Pinned realtime-js 2.116.0 SocketAdapter.disconnect installs an
        // uncleared 10s timer before Phoenix disconnect. All disconnect/leave
        // calls above have returned and no callback can dispatch a new one.
        // This later timer drains that known timer; it replaces no I/O join.
        await delay(limits.sdkDisconnectDrainMilliseconds);
      }
      // Public teardown cancels channel work; releasing the final client reference
      // also releases its inert socket send buffer without private SDK inspection.
      previous = undefined;
      verifiedToken = undefined;
      authority = undefined;
      authorizationRequest = undefined;
      scope = undefined;
      runInRequest = undefined;
      const output = controller;
      controller = undefined;
      if (output !== undefined) {
        try {
          if (control !== undefined && (output.desiredSize ?? 0) > 0)
            output.enqueue(frame("control", { kind: control }));
          output.close();
        } catch { /* Cancelled readers need no output or error details. */ }
      }
      if (cleanupFailed) throw new Error("PRIVATE_INVALIDATION_SETTLEMENT_FAILED");
    })();
    void disposal.catch(() => {
      // Failed settlement remains a failure; it never certifies resource disposal.
      const output = controller;
      controller = undefined;
      try { output?.close(); } catch { /* Reader already cancelled. */ }
    });
    return disposal;
  };
  const onAbort = (): void => { void finish(); };

  const emit = (event: "control" | "invalidation", value: WebPrivateInvalidationControl | LiveInvalidation): boolean => {
    if (!live()) { finish("unavailable"); return false; }
    const output = controller;
    const bytes = frame(event, value);
    if (output === undefined || bytes.byteLength > limits.maximumFrameBytes ||
        (output.desiredSize ?? 0) <= 0) {
      finish("gap");
      return false;
    }
    try { output.enqueue(bytes); return true; } catch { finish(); return false; }
  };

  const inRequest = async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
    const context = runInRequest;
    if (stopping || context === undefined) return undefined;
    workTimer = setTimeout(() => { void finish("unavailable"); }, limits.authorityMilliseconds);
    try {
      const result = await context(() => withRequestDatabaseLifetime({
        signal: stopController.signal,
        deadline: Math.min(Date.now() + limits.authorityMilliseconds,
          expiresAt || Date.now() + limits.authorityMilliseconds),
        createOwnedLookup: createOwnedNetworkLookup,
      }, async (lifetime) => {
        transport.checkpoint();
        lifetime.checkpoint();
        const result = await operation();
        transport.checkpoint();
        lifetime.checkpoint();
        return result;
      }));
      return stopping ? undefined : result;
    } finally {
      if (workTimer !== undefined) clearTimeout(workTimer);
      workTimer = undefined;
    }
  };

  const authorizeFresh = async (): Promise<boolean> => {
    if (!live() || authority === undefined || authorizationRequest === undefined)
      return false;
    const currentAuthority = authority;
    const bound = authorizationRequest;
    const result = await inRequest(async () => {
      const identity = await resolveIdentitySessionForPrivateInvalidation(transport.execution);
      if (!live() || identity.resolution.kind !== "active" ||
          identity.accessToken === undefined || identity.accessToken !== verifiedToken ||
          Date.parse(identity.resolution.session.accessTokenExpiresAt) !== expiresAt)
        return false;
      const decision = await currentAuthority.authorizer.authorize(bound);
      return live() && decision.outcome === "authorized" &&
        decision.topic === bound.topic && decision.accessVersion === bound.boundAccessVersion;
    });
    return result === true && live();
  };

  const pump = async (): Promise<void> => {
    if (pumping || stopping || !joined) return;
    pumping = true;
    try {
      if (!ready) {
        if (!await authorizeFresh()) { finish("unavailable"); return; }
        if (scope === undefined || !emit("control", { kind: "ready", scope })) return;
        ready = true;
        if (joinTimer !== undefined) clearTimeout(joinTimer);
        joinTimer = undefined;
      }
      while (!stopping && pending.length > 0) {
        const notice = pending.shift();
        if (notice === undefined) break;
        if (!await authorizeFresh()) { finish("unavailable"); return; }
        if (!emit("invalidation", notice)) return;
      }
    } catch { finish("unavailable"); }
    finally { pumping = false; }
  };

  const initialize = async (): Promise<void> => {
    try {
      const identity = await inRequest(() =>
        resolveIdentitySessionForPrivateInvalidation(transport.execution));
      if (stopping || identity === undefined || identity.resolution.kind !== "active" ||
          identity.accessToken === undefined) { finish("unavailable"); return; }
      expiresAt = Date.parse(identity.resolution.session.accessTokenExpiresAt);
      if (!live()) { finish("unavailable"); return; }
      verifiedToken = identity.accessToken;
      const remaining = expiresAt - Date.now();
      transport.tighten(Math.min(expiresAt, Date.now() + limits.maximumStreamMilliseconds));
      expiryTimer = setTimeout(() => finish(
        remaining <= limits.maximumStreamMilliseconds ? "unavailable" : "gap",
      ), Math.min(remaining, limits.maximumStreamMilliseconds));
      const { targetApplicationKey, ...pageAddress } = selectors;
      authority = createWebPrivateInvalidationChannelAuthority(
        pageAddress, targetApplicationKey, transport.execution,
      );
      const initialAuthority = authority;
      const initial = await inRequest(() => initialAuthority.readInitial());
      if (!live() || initial === undefined || "kind" in initial ||
          Date.parse(initial.accessTokenExpiresAt) !== expiresAt) {
        finish("unavailable"); return;
      }
      scope = Object.freeze({ organizationId: initial.access.organizationId,
        applicationRootId: initial.access.applicationRootId });
      authorizationRequest = Object.freeze({ ...scope, topic: privateInvalidationTopic(scope),
        boundAccessVersion: initial.access.accessVersion });
      if (!await authorizeFresh()) { finish("unavailable"); return; }
      if (!live() || verifiedToken === undefined || authorizationRequest === undefined) return;
      client = createClient(configuration.supabaseUrl, configuration.publishableKey, {
        // This callback supplies the original verified JWT only. It cannot
        // refresh it or fall back to an unrelated empty Auth client's session.
        accessToken: async () => live() ? verifiedToken ?? null : null,
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: transport.execution.fetch },
        realtime: {
          transport: transport.transport,
          timeout: limits.joinMilliseconds,
          disconnectOnEmptyChannelsAfterMs: 0,
          accessToken: async () => live() ? verifiedToken ?? null : null,
          logger: () => undefined,
        },
      });
      const ownedClient = client;
      await ownedClient.realtime.setAuth(verifiedToken);
      if (!live() || authorizationRequest === undefined) { finish("unavailable"); return; }
      channel = ownedClient.channel(authorizationRequest.topic, { config: { private: true } });
      channel
        .on("broadcast", { event: privateInvalidationBroadcastEvent }, (message: unknown) => {
          if (!live() || scope === undefined) return;
          try {
            const notice = readNotice(message);
            if (notice === undefined ||
                notice.organizationId.toLowerCase() !== scope.organizationId.toLowerCase() ||
                notice.applicationRootId.toLowerCase() !== scope.applicationRootId.toLowerCase())
              return;
            if (frame("invalidation", notice).byteLength > limits.maximumFrameBytes) {
              finish("gap"); return;
            }
            if (pending.length >= limits.maximumPendingNotices) { finish("gap"); return; }
            pending.push(notice);
            track(pump());
          } catch { /* Malformed Broadcast input is never forwarded or logged. */ }
        })
        .subscribe((status) => {
          if (stopping) return;
          if (status !== "SUBSCRIBED") { finish(ready ? "gap" : "unavailable"); return; }
          if (joined) { finish("gap"); return; }
          joined = true;
          track(pump());
        }, limits.joinMilliseconds);
    } catch { finish("unavailable"); }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      controller = output;
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) { finish(); return; }
      joinTimer = setTimeout(() => finish("unavailable"), limits.joinMilliseconds);
      track(initialize());
    },
    cancel() { return finish(); },
  }, { highWaterMark: 1, size: () => 1 });
  return new Response(stream, { headers: streamHeaders });
};
