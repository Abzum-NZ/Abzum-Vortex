import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
  let authority: WebPrivateInvalidationChannelAuthority | undefined;
  let verifiedToken: string | undefined;
  let authorizationRequest: PrivateInvalidationAuthorizationRequest | undefined;
  let scope: WebPrivateInvalidationScope | undefined;
  let expiresAt = 0;
  let disposed = false;
  let joined = false;
  let ready = false;
  let pumping = false;
  const pending: LiveInvalidation[] = [];
  let joinTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let workTimer: ReturnType<typeof setTimeout> | undefined;

  const live = (): boolean => !disposed && !request.signal.aborted &&
    expiresAt > Date.now();

  const finish = (control?: "gap" | "unavailable"): void => {
    if (disposed) return;
    disposed = true;
    request.signal.removeEventListener("abort", onAbort);
    if (joinTimer !== undefined) clearTimeout(joinTimer);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    if (workTimer !== undefined) clearTimeout(workTimer);
    joinTimer = expiryTimer = workTimer = undefined;
    pending.length = 0;
    verifiedToken = undefined;
    authority = undefined;
    authorizationRequest = undefined;
    scope = undefined;
    runInRequest = undefined;
    const previous = client;
    client = undefined;
    if (previous !== undefined) {
      // Disconnect the entire owned client, not just its channel. In particular,
      // heartbeat/reconnect work is stopped through the public cleanup APIs.
      // SDK socket-close settlement is asynchronous and has its own finite bound.
      // removeAllChannels also tears down every channel and disconnects this
      // entire socket. Fall back to whole-socket disconnect on cleanup failure.
      void previous.removeAllChannels()
        .catch(() => previous.realtime.disconnect())
        .catch(() => undefined);
      // The callback now returns null. Clear the SDK's original JWT as well;
      // no refresh, provider sign-out, cookie mutation or private SDK access.
      void previous.realtime.setAuth(null).catch(() => undefined);
    }
    const output = controller;
    controller = undefined;
    if (output !== undefined) {
      try {
        // At most one queued frame. On backpressure, EOF is itself a gap to the
        // client; do not grow the queue merely to enqueue a terminal control.
        if (control !== undefined && (output.desiredSize ?? 0) > 0)
          output.enqueue(frame("control", { kind: control }));
        output.close();
      } catch { /* Cancelled readers need no output or error details. */ }
    }
  };
  const onAbort = (): void => finish();

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
    if (disposed || context === undefined) return undefined;
    // The unchanged protected reader has no cancellation argument. An in-flight
    // read may settle after disposal; no continuation may schedule or emit then.
    workTimer = setTimeout(() => finish("unavailable"), limits.authorityMilliseconds);
    try {
      const result = await context(operation);
      return disposed ? undefined : result;
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
      const identity = await resolveIdentitySessionForPrivateInvalidation();
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
    if (pumping || disposed || !joined) return;
    pumping = true;
    try {
      if (!ready) {
        if (!await authorizeFresh()) { finish("unavailable"); return; }
        if (scope === undefined || !emit("control", { kind: "ready", scope })) return;
        ready = true;
        if (joinTimer !== undefined) clearTimeout(joinTimer);
        joinTimer = undefined;
      }
      while (!disposed && pending.length > 0) {
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
      const identity = await inRequest(resolveIdentitySessionForPrivateInvalidation);
      if (disposed || identity === undefined || identity.resolution.kind !== "active" ||
          identity.accessToken === undefined) { finish("unavailable"); return; }
      expiresAt = Date.parse(identity.resolution.session.accessTokenExpiresAt);
      if (!live()) { finish("unavailable"); return; }
      verifiedToken = identity.accessToken;
      const remaining = expiresAt - Date.now();
      expiryTimer = setTimeout(() => finish(
        remaining <= limits.maximumStreamMilliseconds ? "unavailable" : "gap",
      ), Math.min(remaining, limits.maximumStreamMilliseconds));
      const { targetApplicationKey, ...pageAddress } = selectors;
      authority = createWebPrivateInvalidationChannelAuthority(pageAddress, targetApplicationKey);
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
        realtime: {
          timeout: limits.joinMilliseconds,
          disconnectOnEmptyChannelsAfterMs: 0,
          accessToken: async () => live() ? verifiedToken ?? null : null,
          logger: () => undefined,
        },
      });
      const ownedClient = client;
      await ownedClient.realtime.setAuth(verifiedToken);
      if (!live() || authorizationRequest === undefined) { finish("unavailable"); return; }
      ownedClient.channel(authorizationRequest.topic, { config: { private: true } })
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
            void pump();
          } catch { /* Malformed Broadcast input is never forwarded or logged. */ }
        })
        .subscribe((status) => {
          if (disposed) return;
          if (status !== "SUBSCRIBED") { finish(ready ? "gap" : "unavailable"); return; }
          if (joined) { finish("gap"); return; }
          joined = true;
          void pump();
        }, limits.joinMilliseconds);
    } catch { finish("unavailable"); }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      controller = output;
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) { finish(); return; }
      joinTimer = setTimeout(() => finish("unavailable"), limits.joinMilliseconds);
      void initialize();
    },
    cancel() { finish(); },
  }, { highWaterMark: 1, size: () => 1 });
  return new Response(stream, { headers: streamHeaders });
};
