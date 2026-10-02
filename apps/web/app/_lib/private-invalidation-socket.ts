import "server-only";

import { Agent as HttpAgent, request as requestHttp, type ClientRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as requestHttps } from "node:https";
import { Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { finished } from "node:stream/promises";
import WebSocket from "ws";
import type { IdentityVerificationExecution } from "@vortex/identity";
import { createOwnedNetworkLookup, type OwnedNetworkLookup } from "./owned-network-lookup";

const maximumProviderBodyBytes = 65_536;
const maximumProviderRequests = 32;
const maximumSocketWrites = 32;
const maximumPhysicalWrites = 64;
const providerMilliseconds = 10_000;

const unavailable = () => new Error("PRIVATE_INVALIDATION_TRANSPORT_UNAVAILABLE");
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
};

class OwnedCloseEvent extends Event implements CloseEvent {
  readonly code: number;
  readonly reason = "";
  readonly wasClean: boolean;
  constructor(stopped: boolean) {
    super("close");
    this.code = stopped ? 1000 : 1006;
    this.wasClean = stopped;
  }
}

/**
 * One live request owns every public HTTP handshake, physical socket, body and write.
 * Native DNS runs only in the delivered clean startup context; stopping removes its
 * request callback rather than claiming that native DNS has been cancelled.
 */
export class PrivateInvalidationTransportOwner {
  private stopping = false;
  private stopped = false;
  private requestCount = 0;
  private socketConstructed = false;
  private readonly lookups = new Set<OwnedNetworkLookup>();
  private readonly physical = new Set<Socket | TLSSocket>();
  private readonly requests = new Set<ClientRequest>();
  private readonly responses = new Set<IncomingMessage>();
  private readonly websocketStops = new Set<() => void>();
  private readonly pending = new Set<Promise<void>>();
  private readonly removers = new Set<() => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly agents = new Set<HttpAgent>();
  private readonly writeRemovers = new Set<() => void>();
  private deadline: number;

  constructor(
    private readonly providerUrl: URL,
    deadline: number,
    private readonly onTerminal: () => void,
  ) {
    this.deadline = deadline;
  }

  tighten(deadline: number): void {
    this.deadline = Math.min(this.deadline, deadline);
    this.checkpoint();
  }

  readonly checkpoint = (): void => {
    if (this.stopping || Date.now() >= this.deadline) throw unavailable();
  };

  private accepting(): boolean { return !this.stopping && Date.now() < this.deadline; }

  private fail(): void {
    if (this.stopping) return;
    this.fence();
    this.onTerminal();
  }

  readonly execution: IdentityVerificationExecution = Object.freeze({
    fetch: (input: RequestInfo | URL, init?: RequestInit) => this.fetch(input, init),
    checkpoint: this.checkpoint,
  });

  track<Result>(result: Promise<Result>): Promise<Result> {
    const observed = result.then(() => undefined, () => undefined);
    this.pending.add(observed);
    void observed.then(() => this.pending.delete(observed));
    return result;
  }

  private createPhysical(secure: false, hostname: string, port: number): Socket;
  private createPhysical(secure: true, hostname: string, port: number): TLSSocket;
  private createPhysical(secure: boolean, hostname: string, port: number): Socket | TLSSocket {
    this.checkpoint();
    const lookup = createOwnedNetworkLookup();
    this.lookups.add(lookup);
    // Capture raw TCP before connect dispatch, then TLS before any HTTP/authentication write.
    const raw = new Socket();
    this.observePhysical(raw);
    const host = hostname.replace(/^\[|\]$/g, "");
    raw.connect({ host, port, lookup: lookup.lookup });
    if (!secure) return raw;
    const secured = connectTls({ socket: raw, servername: host, rejectUnauthorized: true });
    this.observePhysical(secured);
    return secured;
  }

  private createAgent(secure: boolean, hostname: string, port: number): HttpAgent {
    const owner = this;
    // Public Agent construction owns connection dispatch; agent:false would create
    // a default Agent and could bypass a request-level createConnection option.
    const agent = secure
      ? new class extends HttpsAgent {
          override createConnection(): TLSSocket { return owner.createPhysical(true, hostname, port); }
        }({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 })
      : new class extends HttpAgent {
          override createConnection(): Socket { return owner.createPhysical(false, hostname, port); }
        }({ keepAlive: false, maxSockets: 1 });
    this.agents.add(agent);
    return agent;
  }

  private observePhysical(socket: Socket | TLSSocket): void {
    const owner = this;
    const original = socket.write.bind(socket);
    let writes = 0;
    function write(bytes: Uint8Array | string, callback?: (error?: Error | null) => void): boolean;
    function write(bytes: Uint8Array | string, encoding?: BufferEncoding,
      callback?: (error?: Error | null) => void): boolean;
    function write(bytes: Uint8Array | string,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      suppliedCallback?: (error?: Error | null) => void): boolean {
      const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : suppliedCallback;
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      const written = deferred();
      owner.track(written.promise);
      let completed = false;
      const complete = (error?: Error | null) => {
        if (completed) return;
        completed = true;
        writes -= 1;
        try { callback?.(error); }
        catch { owner.fail(); }
        finally { written.resolve(); }
      };
      writes += 1;
      if (owner.stopping || writes > maximumPhysicalWrites) {
        queueMicrotask(() => complete(unavailable()));
        if (!owner.stopping) owner.fail();
        return false;
      }
      try { return original(bytes, encoding, complete); }
      catch {
        complete(unavailable());
        owner.fail();
        return false;
      }
    }
    // Only this newly allocated socket is adapted through its public write API.
    // Include HTTP, SDK and ws automatic close-frame callbacks, not just send().
    socket.write = write;
    this.writeRemovers.add(() => { socket.write = original; });
    const closed = deferred();
    const ignoreError = () => undefined;
    socket.on("error", ignoreError);
    socket.once("close", () => {
      socket.removeListener("error", ignoreError);
      this.physical.delete(socket);
      closed.resolve();
    });
    this.physical.add(socket);
    this.track(closed.promise);
  }

  private observeRequest(request: ClientRequest): void {
    const closed = deferred();
    const ignoreError = () => undefined;
    request.on("error", ignoreError);
    request.once("close", () => {
      request.removeListener("error", ignoreError);
      this.requests.delete(request);
      closed.resolve();
    });
    this.requests.add(request);
    this.track(closed.promise);
    this.track(finished(request, { readable: false, cleanup: true }).catch(() => undefined));
  }

  private async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.checkpoint();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (++this.requestCount > maximumProviderRequests || method.toUpperCase() !== "GET" ||
        url.origin !== this.providerUrl.origin || url.username !== "" || url.password !== "" ||
        url.search !== "" || url.hash !== "" ||
        (url.pathname !== "/auth/v1/user" && url.pathname !== "/auth/v1/.well-known/jwks.json"))
      throw unavailable();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    // Credential transport is fixed to the configured provider and never follows redirects.
    const wireHeaders: Record<string, string> = {};
    headers.forEach((value, name) => { wireHeaders[name] = value; });
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const actual = new Promise<Response>((resolve, reject) => {
      let completed = false;
      let response: IncomingMessage | undefined;
      let request: ClientRequest | undefined;
      const chunks: Buffer[] = [];
      let length = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result?: Response) => {
        if (completed) return;
        completed = true;
        if (timer !== undefined) { clearTimeout(timer); this.timers.delete(timer); }
        signal?.removeEventListener("abort", fail);
        this.removers.delete(remove);
        response?.removeListener("data", data);
        response?.removeListener("end", end);
        response?.removeListener("error", fail);
        response?.removeListener("aborted", fail);
        response?.removeListener("close", fail);
        request?.removeListener("error", fail);
        request?.removeListener("close", fail);
        chunks.length = 0;
        // A failed body/connect/timeout is terminal for this route. Drop clean
        // DNS delivery before request destruction, including pre-connect failure.
        if (result === undefined) this.fail();
        response?.destroy();
        request?.destroy();
        if (result === undefined) reject(unavailable());
        else resolve(result);
      };
      const fail = () => finish();
      const remove = () => { signal?.removeEventListener("abort", fail); };
      const data = (chunk: Buffer) => {
        length += chunk.length;
        if (length > maximumProviderBodyBytes) { fail(); return; }
        chunks.push(chunk);
      };
      const end = () => {
        try {
          this.checkpoint();
          const body = Buffer.concat(chunks, length).toString("utf8");
          const status = response?.statusCode ?? 500;
          if (status < 200 || status >= 300) { fail(); return; }
          finish(new Response(body, { status, headers: { "Content-Type": "application/json" } }));
        } catch { fail(); }
      };
      try {
        if (signal?.aborted) { fail(); return; }
        const secure = url.protocol === "https:";
        if (!secure && url.protocol !== "http:") { fail(); return; }
        request = (secure ? requestHttps : requestHttp)(url, {
          method: "GET", headers: wireHeaders,
          agent: this.createAgent(secure, url.hostname, Number(url.port || (secure ? 443 : 80))),
        }, (received) => {
          response = received;
          this.responses.add(received);
          const closed = deferred();
          received.once("close", () => { this.responses.delete(received); closed.resolve(); });
          this.track(closed.promise);
          if (this.stopping || completed) { received.destroy(); fail(); return; }
          received.on("data", data);
          received.once("end", end);
          received.once("error", fail);
          received.once("aborted", fail);
          received.once("close", fail);
        });
        this.observeRequest(request);
        request.once("error", fail);
        request.once("close", fail);
        signal?.addEventListener("abort", fail, { once: true });
        this.removers.add(remove);
        timer = setTimeout(fail, Math.max(0,
          Math.min(providerMilliseconds, this.deadline - Date.now())));
        this.timers.add(timer);
        request.end();
      } catch { fail(); }
    });
    return this.track(actual);
  }

  readonly transport = (() => {
    const owner = this;
    return class OwnedWebSocket extends EventTarget {
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readonly url: string;
      private readonly socket: WebSocket;
      private sends = 0;
      binaryType: "arraybuffer" = "arraybuffer";
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      get readyState(): number { return this.socket.readyState; }
      get protocol(): string { return this.socket.protocol; }
      get bufferedAmount(): number { return this.socket.bufferedAmount; }

      constructor(address: string, protocols?: string | string[]) {
        super();
        owner.checkpoint();
        const url = new URL(address);
        const expected = new URL(owner.providerUrl);
        expected.protocol = expected.protocol === "https:" ? "wss:" : "ws:";
        if (owner.socketConstructed || url.origin !== expected.origin ||
            url.pathname !== "/realtime/v1/websocket" || url.username || url.password || url.hash)
          throw unavailable();
        owner.socketConstructed = true; // Reconnect requires a new route admission.
        this.url = address;
        const secure = url.protocol === "wss:";
        // These documented ws 8.21.3 options are not yet in @types/ws 8.18.1.
        const socketOptions = {
          followRedirects: false, perMessageDeflate: false, maxPayload: 16_384,
          autoPong: false,
          closeTimeout: 1_000, maxBufferedChunks: 64, maxFragments: 64,
          handshakeTimeout: providerMilliseconds,
          agent: owner.createAgent(secure, url.hostname, Number(url.port || (secure ? 443 : 80))),
          finishRequest(request: ClientRequest) {
            owner.observeRequest(request);
            if (owner.stopping) { request.destroy(); return; }
            request.end();
          },
        } satisfies WebSocket.ClientOptions & {
          closeTimeout: number; maxBufferedChunks: number; maxFragments: number;
        };
        this.socket = new WebSocket(address, protocols, socketOptions);
        const closed = deferred();
        owner.track(closed.promise);
        const stop = () => this.socket.terminate();
        owner.websocketStops.add(stop);
        this.socket.on("open", () => {
          if (owner.stopping) { stop(); return; }
          const event = new Event("open");
          try { this.onopen?.(event); this.dispatchEvent(event); } catch { owner.fail(); }
        });
        this.socket.on("message", (data, binary) => {
          if (owner.stopping || binary) return;
          const event = new MessageEvent("message", { data: data.toString() });
          try { this.onmessage?.(event); this.dispatchEvent(event); } catch { owner.fail(); }
        });
        this.socket.on("ping", (data) => {
          if (owner.stopping) return;
          // Own protocol-control writes too; ws automatic pong is disabled.
          if (this.sends >= maximumSocketWrites) { owner.fail(); return; }
          const written = deferred();
          owner.track(written.promise);
          this.sends += 1;
          try {
            this.socket.pong(data, true, (error) => {
              this.sends -= 1;
              written.resolve();
              if (error) owner.fail();
            });
          } catch {
            this.sends -= 1;
            written.resolve();
            owner.fail();
          }
        });
        this.socket.on("error", () => {
          if (owner.stopping) return;
          const event = new Event("error");
          try { this.onerror?.(event); this.dispatchEvent(event); } catch { /* Neutral terminal below. */ }
          owner.fail();
        });
        this.socket.once("close", () => {
          owner.websocketStops.delete(stop);
          // Deliver the actual local close even after the dispatch fence. Phoenix
          // clears its heartbeat timers here; route callbacks already refuse output.
          // The owning route starts public disconnect before this asynchronous close.
          const event = new OwnedCloseEvent(owner.stopping);
          try { this.onclose?.(event); this.dispatchEvent(event); }
          catch { /* A terminal SDK callback cannot retain the owned closure latch. */ }
          finally {
            this.onopen = this.onmessage = this.onclose = this.onerror = null;
            this.socket.removeAllListeners();
            closed.resolve();
          }
          owner.fail();
        });
      }

      close(): void {
        owner.fail();
        this.socket.terminate();
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (!owner.accepting() || data instanceof Blob || this.sends >= maximumSocketWrites) {
          owner.fail();
          return;
        }
        const bytes = typeof data === "string" ? Buffer.from(data)
          : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : Buffer.from(new Uint8Array(data));
        if (bytes.length > 16_384) { owner.fail(); return; }
        const written = deferred();
        owner.track(written.promise);
        this.sends += 1;
        try {
          this.socket.send(bytes, { binary: false, compress: false }, (error) => {
            this.sends -= 1;
            written.resolve();
            if (error) owner.fail();
          });
        } catch {
          this.sends -= 1;
          written.resolve();
          owner.fail();
        }
      }
    };
  })();

  fence(): void {
    this.stopping = true;
    for (const lookup of this.lookups) lookup.stop();
  }

  stop(): void {
    this.fence();
    if (this.stopped) return;
    this.stopped = true;
    for (const stop of this.websocketStops) stop();
    for (const response of this.responses) response.destroy();
    for (const request of this.requests) request.destroy();
    for (const socket of this.physical) socket.destroy();
    for (const agent of this.agents) agent.destroy();
    this.agents.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const remove of this.removers) remove();
    this.removers.clear();
  }

  async settled(): Promise<void> {
    this.stop();
    if ([...this.lookups].some((lookup) => !lookup.stop()))
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    const deliverySettled = [...this.lookups].every((lookup) => lookup.lookupDeliverySettled);
    while (this.pending.size > 0) await Promise.all([...this.pending]);
    for (const remove of this.writeRemovers) remove();
    this.writeRemovers.clear();
    this.lookups.clear();
    if (!deliverySettled) throw unavailable();
  }
}
