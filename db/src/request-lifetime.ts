import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

export type RequestDatabaseStopReason = "abort" | "deadline" | "completed";

export interface DatabaseResourcesSettled {
  readonly status: "database_resources_settled";
  readonly stoppedBy: RequestDatabaseStopReason;
  readonly settledAt: number;
  /** Physical local closure does not acknowledge remote rollback or query cancellation. */
  readonly remoteOutcome: "not_asserted";
}

/** Execution control only. This object supplies no identity, context, role or permission. */
export interface RequestDatabaseLifetime {
  readonly signal: AbortSignal;
  /** Absolute final deadline, including database cleanup. */
  readonly deadline: number;
  readonly database_resources_settled: Promise<DatabaseResourcesSettled>;
  checkpoint(): void;
}

export interface RequestDatabaseLifetimeOptions {
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export const requestDatabaseError = (code: string): Error => {
  const error = new Error(code);
  error.name = "VortexDatabaseError";
  return error;
};

// Stop dispatch before the final deadline so actual database cleanup has a budget. No timeout
// result replaces an actual join; a missed final deadline rejects the settlement contract.
const CLEANUP_BUDGET_MS = 1_000;
const MAXIMUM_TIMER_MS = 2_147_483_647;
const storage = new AsyncLocalStorage<RequestDatabaseLifetimeOwner>();

type DatabaseResource = Readonly<{
  stop(): void;
  settled(): Promise<void>;
}>;

/** Internal registration seam; consumers only receive the execution-only public projection. */
export class RequestDatabaseLifetimeOwner implements RequestDatabaseLifetime {
  private readonly controller = new AbortController();
  private readonly resources = new Set<DatabaseResource>();
  private readonly pending = new Set<Promise<void>>();
  private readonly signalRemovers: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private finalDeadline: number;
  private reason: RequestDatabaseStopReason | undefined;
  private settled = false;
  private join: Promise<DatabaseResourcesSettled> | undefined;
  private resolveSettlement!: (value: DatabaseResourcesSettled) => void;
  private rejectSettlement!: (error: Error) => void;
  readonly projection: RequestDatabaseLifetime;

  readonly database_resources_settled = new Promise<DatabaseResourcesSettled>((resolve, reject) => {
    this.resolveSettlement = resolve;
    this.rejectSettlement = reject;
  });

  constructor(options: RequestDatabaseLifetimeOptions) {
    this.finalDeadline = options.deadline;
    const owner = this;
    this.projection = Object.freeze({
      get signal() {
        return owner.signal;
      },
      get deadline() {
        return owner.deadline;
      },
      database_resources_settled: this.database_resources_settled,
      checkpoint: () => owner.checkpoint(),
    });
    // Observe rejections even if an enclosing caller is still running unsupported non-DB work.
    void this.database_resources_settled.catch(() => undefined);
    this.tighten(options);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get deadline(): number {
    return this.finalDeadline;
  }

  get stopped(): boolean {
    return this.reason !== undefined;
  }

  checkpoint(): void {
    if (!this.stopped && Date.now() >= this.finalDeadline - CLEANUP_BUDGET_MS)
      this.stop("deadline");
    if (this.stopped) throw requestDatabaseError("DATABASE_REQUEST_STOPPED");
  }

  /** Nested scopes retain the same owner and may only shorten its lifetime. */
  tighten(options: RequestDatabaseLifetimeOptions): void {
    if (
      !Number.isSafeInteger(options.deadline) ||
      options.deadline <= 0 ||
      options.deadline - Date.now() > MAXIMUM_TIMER_MS
    )
      throw requestDatabaseError("DATABASE_REQUEST_DEADLINE_INVALID");
    this.finalDeadline = Math.min(this.finalDeadline, options.deadline);
    const abort = () => this.stop("abort");
    if (options.signal.aborted) abort();
    else {
      options.signal.addEventListener("abort", abort, { once: true });
      this.signalRemovers.push(() => options.signal.removeEventListener("abort", abort));
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (!this.stopped)
      this.timer = setTimeout(
        () => this.stop("deadline"),
        Math.max(0, this.finalDeadline - CLEANUP_BUDGET_MS - Date.now()),
      );
  }

  registerResource(resource: DatabaseResource): void {
    this.checkpoint();
    this.resources.add(resource);
  }

  /** Track the actual result, never a cancellation race or a fabricated timeout result. */
  track<Result>(result: PromiseLike<Result>): Promise<Result> {
    if (this.settled) throw requestDatabaseError("DATABASE_REGISTRATION_CLOSED");
    const actual = Promise.resolve(result);
    const observed = actual.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(observed);
    void observed.then(() => this.pending.delete(observed));
    return actual;
  }

  stop(reason: RequestDatabaseStopReason): void {
    if (this.stopped) return;
    this.reason = reason;
    // The synchronous fence precedes every end/close request and every await.
    this.controller.abort();
    for (const resource of this.resources) resource.stop();
    this.join ??= this.joinResources();
    void this.join.then(this.resolveSettlement, this.rejectSettlement);
  }

  private async joinResources(): Promise<DatabaseResourcesSettled> {
    // Resource joins include the known late initial factory turn. They must complete before
    // the registration set can become closed. Callbacks/native results are joined separately.
    const resources = await Promise.allSettled(
      [...this.resources].map((resource) => resource.settled()),
    );
    while (this.pending.size > 0) await Promise.all([...this.pending]);
    this.settled = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const remove of this.signalRemovers) remove();
    this.signalRemovers.length = 0;
    if (resources.some((result) => result.status === "rejected"))
      throw requestDatabaseError("DATABASE_RESOURCE_SETTLEMENT_FAILED");
    const settledAt = Date.now();
    if (settledAt > this.finalDeadline)
      throw requestDatabaseError("DATABASE_CLEANUP_DEADLINE_EXCEEDED");
    return {
      status: "database_resources_settled",
      stoppedBy: this.reason ?? "completed",
      settledAt,
      remoteOutcome: "not_asserted",
    };
  }
}

export const currentRequestDatabaseLifetimeOwner = (): RequestDatabaseLifetimeOwner | undefined =>
  storage.getStore();

/**
 * Only registered DB I/O, checkpoints and finite synchronous work are supported in callbacks
 * passed to database runners inside this scope. An arbitrary/provider/DNS/crypto promise is
 * unsupported; it is never raced away or described as settled. The enclosing operation itself
 * is not part of database_resources_settled. A caller still owns its complete request lifetime.
 */
export const withRequestDatabaseLifetime = async <Result>(
  options: RequestDatabaseLifetimeOptions,
  operation: (lifetime: RequestDatabaseLifetime) => Promise<Result>,
): Promise<Result> => {
  const enclosing = storage.getStore();
  if (enclosing !== undefined) {
    enclosing.checkpoint();
    enclosing.tighten(options);
    enclosing.checkpoint();
    const result = await operation(enclosing.projection);
    enclosing.checkpoint();
    return result;
  }
  const owner = new RequestDatabaseLifetimeOwner(options);
  return storage.run(owner, async () => {
    try {
      owner.checkpoint();
      const result = await operation(owner.projection);
      owner.checkpoint();
      return result;
    } finally {
      owner.stop("completed");
      await owner.database_resources_settled;
    }
  });
};

/** Register actual resolver/operation/savepoint callback results independently of orchestration. */
export const invokeRequestDatabaseCallback = async <Result>(
  operation: () => Promise<Result>,
): Promise<Result> => {
  const owner = storage.getStore();
  if (owner === undefined) return operation();
  owner.checkpoint();
  // Invocation occurs before Promise assimilation, and synchronous failures are actual results.
  let result: Promise<Result>;
  try {
    result = operation();
  } catch (error) {
    result = Promise.reject(error);
  }
  const value = await owner.track(result);
  owner.checkpoint();
  return value;
};
