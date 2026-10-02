import "server-only";

import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { connect as connectTls, type TLSSocket } from "node:tls";

import { requestDatabaseError, type RequestDatabaseLifetimeOwner } from "./request-lifetime";

interface RequestSocketConfiguration {
  readonly hostname: string;
  readonly port: number;
  readonly transport:
    | Readonly<{ kind: "local_loopback" }>
    | Readonly<{ kind: "hosted_tls"; rootCertificate: string }>;
}

const deferred = <Value>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

/**
 * The driver receives only this public Duplex. A stopped/failed physical transport can close
 * before publication; retain its terminal state until the driver's assignment is safe.
 */
class RequestOwnedBridge extends Duplex {
  private terminal: Error | undefined;
  private assignmentScheduled = false;
  private assignmentReady = false;
  private readonly assigned = deferred<void>();
  private readonly closed = deferred<void>();
  private readonly writes = new Set<Promise<void>>();
  readonly assignment = this.assigned.promise;
  readonly closure = this.closed.promise;

  constructor(
    private readonly physical: Socket | TLSSocket,
    private readonly physicalClosure: Promise<void>,
    private readonly owner: RequestDatabaseLifetimeOwner,
  ) {
    super({ autoDestroy: true, emitClose: true });
    this.physical.pause();
    this.physical.on("data", this.receive);
    this.physical.on("error", this.failed);
    this.physical.on("end", this.ended);
    this.physical.on("close", this.physicallyClosed);
    // Register our close observer first. The driver may remove all listeners in its own close
    // handler; our terminal-delivery latch must already have observed that event.
    this.once("close", () => this.closed.resolve());
    // Public stream error observation, without logging transport/connection details.
    this.on("error", () => undefined);
  }

  override on(...arguments_: Parameters<Duplex["on"]>): this {
    super.on(...arguments_);
    // Postgres.js createSocket attaches error/close/drain BEFORE socket assignment. Its
    // connected() attaches data AFTER assignment. Wait until that synchronous stack returns,
    // so its subsequent startup-message construction cannot encounter a cleared socket.
    if (arguments_[0] === "data") this.scheduleAssignment();
    return this;
  }

  private scheduleAssignment(): void {
    if (this.assignmentScheduled) return;
    this.assignmentScheduled = true;
    queueMicrotask(() => {
      this.assignmentReady = true;
      this.assigned.resolve();
      this.deliverTerminal();
    });
  }

  private readonly receive = (data: Buffer): void => {
    if (this.owner.stopped || this.terminal !== undefined) return;
    if (!this.push(data)) this.physical.pause();
  };

  private readonly failed = (): void => this.retainTerminal();
  private readonly ended = (): void => this.retainTerminal();
  private readonly physicallyClosed = (): void => this.retainTerminal();

  stop(): void {
    this.retainTerminal();
    // Fence is already synchronous. Physical closure is immediate; bridge error/close waits
    // for the public assignment barrier rather than being lost before driver registration.
    this.physical.destroy();
  }

  private retainTerminal(): void {
    this.terminal ??= requestDatabaseError("DATABASE_OWNED_CONNECTION_CLOSED");
    // A lost dedicated transport stops the execution owner before any other transaction or
    // control query can enter. Actual callback and orchestration results still join separately.
    if (!this.owner.stopped) this.owner.stop("abort");
    this.deliverTerminal();
  }

  private deliverTerminal(): void {
    if (this.assignmentReady && this.terminal !== undefined && !this.destroyed)
      this.destroy(this.terminal);
  }

  override _read(): void {
    if (!this.owner.stopped && this.terminal === undefined) this.physical.resume();
  }

  setKeepAlive(enabled?: boolean, initialDelay?: number): this {
    if (!this.owner.stopped && !this.physical.destroyed)
      this.physical.setKeepAlive(enabled, initialDelay);
    return this;
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    complete: (error?: Error | null) => void,
  ): void {
    // A driver write is also public proof that its socket is assigned. Do not emit terminal
    // events inside the driver stack; the microtask barrier remains mandatory.
    this.scheduleAssignment();
    if (this.owner.stopped || this.terminal !== undefined) {
      this.retainTerminal();
      complete(requestDatabaseError("DATABASE_REQUEST_STOPPED"));
      return;
    }
    const written = deferred<void>();
    this.writes.add(written.promise);
    try {
      this.physical.write(chunk, encoding, (error) => {
        if (error !== undefined && error !== null) this.retainTerminal();
        complete(error ? requestDatabaseError("DATABASE_OWNED_CONNECTION_CLOSED") : undefined);
        written.resolve();
        this.writes.delete(written.promise);
      });
    } catch {
      this.retainTerminal();
      complete(requestDatabaseError("DATABASE_OWNED_CONNECTION_CLOSED"));
      written.resolve();
      this.writes.delete(written.promise);
    }
  }

  override _final(complete: (error?: Error | null) => void): void {
    this.scheduleAssignment();
    // A dedicated client end is a local teardown request, not remote rollback evidence.
    this.retainTerminal();
    this.physical.destroy();
    void this.physicalClosure.then(() => complete());
  }

  override _destroy(error: Error | null, complete: (error?: Error | null) => void): void {
    this.physical.destroy();
    void this.physicalClosure.then(async () => {
      while (this.writes.size > 0) await Promise.all([...this.writes]);
      this.physical.removeListener("data", this.receive);
      this.physical.removeListener("error", this.failed);
      this.physical.removeListener("end", this.ended);
      this.physical.removeListener("close", this.physicallyClosed);
      complete(error);
    });
  }
}

interface SocketAttempt {
  readonly physical: Set<Socket | TLSSocket>;
  readonly closures: Promise<void>[];
  readonly writes: Promise<void>[];
  bridge?: RequestOwnedBridge;
}

/** Owner-created TCP/SSLRequest/TLS; no database startup or authentication precedes TLS. */
export class RequestOwnedSocketFactory {
  private readonly attempts = new Set<SocketAttempt>();
  private readonly factories = new Set<Promise<void>>();
  private readonly firstEntry = deferred<void>();
  private initialEntryExpected = false;
  private entered = false;
  private stopped = false;

  constructor(
    private readonly configuration: RequestSocketConfiguration,
    private readonly owner: RequestDatabaseLifetimeOwner,
  ) {}

  /** Arm in the first admitted BEGIN execute turn, never for refused or lazy queued work. */
  expectInitialEntry(): void {
    this.initialEntryExpected = true;
  }

  readonly open = (): Promise<Duplex> => {
    this.entered = true;
    const result = this.establish();
    const observed = result.then(
      () => undefined,
      () => undefined,
    );
    this.factories.add(observed);
    void observed.then(() => this.factories.delete(observed));
    // Latch actual entry AFTER its attempt promise is registered. The driver can schedule its
    // first factory after end0; a stopped late entry refuses before allocating any socket.
    this.firstEntry.resolve();
    return this.owner.track(result);
  };

  stop(): void {
    this.stopped = true;
    for (const attempt of this.attempts) {
      attempt.bridge?.stop();
      for (const physical of attempt.physical) physical.destroy();
    }
  }

  async settled(): Promise<void> {
    if (this.initialEntryExpected && !this.entered) await this.firstEntry.promise;
    while (this.factories.size > 0) await Promise.all([...this.factories]);
    for (const attempt of this.attempts) {
      await Promise.all(attempt.closures);
      await Promise.all(attempt.writes);
      if (attempt.bridge !== undefined) {
        await attempt.bridge.assignment;
        await attempt.bridge.closure;
      }
    }
  }

  private registerPhysical(attempt: SocketAttempt, socket: Socket | TLSSocket): Promise<void> {
    const closed = deferred<void>();
    const error = () => undefined;
    socket.on("error", error);
    socket.once("close", () => {
      socket.removeListener("error", error);
      closed.resolve();
    });
    attempt.physical.add(socket);
    attempt.closures.push(closed.promise);
    return closed.promise;
  }

  private async establish(): Promise<Duplex> {
    this.owner.checkpoint();
    if (this.stopped) throw requestDatabaseError("DATABASE_REQUEST_STOPPED");
    const attempt: SocketAttempt = { physical: new Set(), closures: [], writes: [] };
    this.attempts.add(attempt);
    const raw = new Socket();
    const rawClosure = this.registerPhysical(attempt, raw);
    try {
      await this.waitFor(raw, "connect", () => {
        raw.connect({ host: this.configuration.hostname, port: this.configuration.port });
      });
      this.owner.checkpoint();
      let transport: Socket | TLSSocket = raw;
      let transportClosure = rawClosure;
      if (this.configuration.transport.kind === "hosted_tls") {
        await this.negotiateTls(attempt, raw);
        this.owner.checkpoint();
        const secured = connectTls({
          socket: raw,
          ca: this.configuration.transport.rootCertificate,
          rejectUnauthorized: true,
          servername: this.configuration.hostname,
        });
        transportClosure = this.registerPhysical(attempt, secured);
        transport = secured;
        await this.waitFor(secured, "secureConnect", () => undefined);
        this.owner.checkpoint();
        if (!secured.authorized) throw requestDatabaseError("DATABASE_TLS_NOT_AUTHORIZED");
      }
      this.owner.checkpoint();
      const bridge = new RequestOwnedBridge(transport, transportClosure, this.owner);
      attempt.bridge = bridge;
      if (this.stopped || this.owner.stopped) bridge.stop();
      return bridge;
    } catch {
      for (const socket of attempt.physical) socket.destroy();
      if (!this.owner.stopped) this.owner.stop("abort");
      await Promise.all(attempt.closures);
      await Promise.all(attempt.writes);
      throw requestDatabaseError("DATABASE_OWNED_CONNECTION_UNAVAILABLE");
    }
  }

  private waitFor(
    socket: Socket | TLSSocket,
    event: "connect" | "secureConnect",
    start: () => void,
  ): Promise<void> {
    return this.owner.track(this.phase(socket, (complete, fail) => {
      const ready = () => complete();
      socket.once(event, ready);
      try {
        start();
      } catch {
        fail();
      }
      return () => socket.removeListener(event, ready);
    }));
  }

  private negotiateTls(attempt: SocketAttempt, socket: Socket): Promise<void> {
    return this.owner.track(this.phase(socket, (complete, fail) => {
      const response = (bytes: Buffer) => {
        // SSLRequest response must be exactly S. No plaintext fallback or speculative startup.
        if (bytes.length === 1 && bytes[0] === 83) complete();
        else fail();
      };
      socket.once("data", response);
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      const written = deferred<void>();
      attempt.writes.push(written.promise);
      try {
        socket.write(request, (error) => {
          if (error) fail();
          written.resolve();
        });
      } catch {
        fail();
        written.resolve();
      }
      return () => socket.removeListener("data", response);
    }));
  }

  private phase(
    socket: Socket | TLSSocket,
    install: (complete: () => void, fail: () => void) => () => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      let removePhase: () => void = () => undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (success: boolean) => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        socket.removeListener("error", fail);
        socket.removeListener("close", fail);
        this.owner.signal.removeEventListener("abort", fail);
        removePhase();
        if (success) resolve();
        else {
          socket.destroy();
          reject(requestDatabaseError("DATABASE_OWNED_CONNECTION_UNAVAILABLE"));
        }
      };
      const fail = () => finish(false);
      socket.once("error", fail);
      socket.once("close", fail);
      this.owner.signal.addEventListener("abort", fail, { once: true });
      if (this.stopped || this.owner.stopped) {
        fail();
        return;
      }
      timer = setTimeout(fail, Math.max(0, Math.min(10_000, this.owner.deadline - Date.now())));
      removePhase = install(() => finish(true), fail);
      // A public operation may fail synchronously while installing its phase. Remove the
      // just-installed phase listener too; it must not survive a completed/rejected promise.
      if (finished) removePhase();
    });
  }
}
