import "server-only";

import { sessionContextSchema, type SessionContext } from "../access/identity-access";
import {
  protectedOperationChannelSchema,
  type ProtectedOperationChannel,
} from "../definition/application-flow-bindings";
import { isLoopbackHostname } from "../identity/loopback-hostname";
import postgres, { type Row, type Sql, type TransactionSql } from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  currentRequestDatabaseLifetimeOwner,
  invokeRequestDatabaseCallback,
  requestDatabaseError,
  type RequestDatabaseLifetimeOwner,
} from "./request-lifetime";
import { RequestOwnedSocketFactory } from "./request-owned-socket";
import {
  currentProtectedReadObserver,
  observeProtectedRead,
  withProtectedReadObserver,
  type ProtectedReadObserver,
} from "./query-attribution";

export type DatabaseValue = string | number | boolean | Date | Uint8Array | null;
export type DatabaseRow = Readonly<Record<string, unknown>>;

export interface RequestDatabaseTransaction {
  query<ResultRow extends DatabaseRow = DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ): Promise<readonly ResultRow[]>;
}

/**
 * A transaction with owned nested recovery. A consumer must await a child scope before
 * issuing parent or sibling work; raw SQL savepoints on the parent query tag do not clear its
 * remembered query error, and concurrent child scopes are not supported.
 */
export interface SavepointRequestDatabaseTransaction extends RequestDatabaseTransaction {
  withSavepoint<Result>(
    operation: (child: SavepointRequestDatabaseTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export type RuntimeDatabaseTransaction = RequestDatabaseTransaction;

interface TransactionDriver {
  query<ResultRow extends DatabaseRow = DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ): Promise<readonly ResultRow[]>;
}

interface DatabaseDriver {
  transaction<Result>(
    operation: (transaction: TransactionDriver) => Promise<Result>,
  ): Promise<Result>;
}

interface RuntimeDatabaseConfiguration {
  readonly connectionString: string;
  readonly hostname: string;
  readonly poolSize: number;
  readonly transport:
    | Readonly<{ kind: "local_loopback" }>
    | Readonly<{ kind: "hosted_tls"; rootCertificate: string }>;
}

type RuntimeOperation<Result> = (transaction: RequestDatabaseTransaction) => Promise<Result>;
export type ResolvedRequestContext<Scope> = Readonly<{
  context: SessionContext;
  /**
   * The channel the trusted entry point reached this request through. It is installed in the
   * request context, never read from client input; when absent `vortex_platform.channel()` reads
   * it as `web`.
   */
  channel?: ProtectedOperationChannel;
  scope: Scope;
}>;
type RequestContextResolver<Scope> = (
  transaction: RequestDatabaseTransaction,
) => Promise<ResolvedRequestContext<Scope>>;
type ResolvedRequestOperation<Scope, Result> = (
  transaction: RequestDatabaseTransaction,
  scope: Scope,
) => Promise<Result>;

const DEFAULT_POOL_SIZE = 5;
const DEFAULT_LOCAL_POOL_SIZE = 10;
const MAXIMUM_POOL_SIZE = 20;

const logDatabaseNotice = (notice: postgres.Notice): void => {
  if (notice.severity === "NOTICE") return;
  // Invalidation payloads contain identifiers only. Retain their failure cause without
  // exposing arbitrary database notice text, which may contain record values.
  const invalidationFailure =
    typeof notice.message === "string" &&
    /^(RECORD_INVALIDATION_FAILED|(?:Error|Warn)SendingBroadcastMessage)\b/.test(notice.message);
  console.warn(
    `[db] server ${String(notice.severity)} ${String(notice.code)}${invalidationFailure ? ` ${notice.message}` : ""}`,
  );
};

const databaseError = (code: string): Error => {
  const error = new Error(code);
  error.name = "VortexDatabaseError";
  return error;
};

type SavepointOperation = SavepointRequestDatabaseTransaction["withSavepoint"];

const getSavepointOperation = (
  transaction: RequestDatabaseTransaction,
): SavepointOperation | undefined => {
  try {
    const operation = (transaction as Partial<SavepointRequestDatabaseTransaction>).withSavepoint;
    return typeof operation === "function" ? operation : undefined;
  } catch {
    return undefined;
  }
};

const wrapRequestTransaction = (
  transaction: TransactionDriver,
  observer?: ProtectedReadObserver,
): RequestDatabaseTransaction => {
  const queryOnly: RequestDatabaseTransaction = {
    query: <ResultRow extends DatabaseRow>(
      strings: TemplateStringsArray,
      ...values: readonly DatabaseValue[]
    ) =>
      observer === undefined
        ? transaction.query<ResultRow>(strings, ...values)
        : observeProtectedRead<ResultRow>(observer, strings, values, (strings, ...values) =>
            transaction.query<ResultRow>(strings, ...values),
          ),
  };
  const withSavepoint = getSavepointOperation(transaction);
  if (withSavepoint === undefined) return queryOnly;

  const capable: SavepointRequestDatabaseTransaction = {
    ...queryOnly,
    withSavepoint: <Result>(
      operation: (child: SavepointRequestDatabaseTransaction) => Promise<Result>,
    ) =>
      (withSavepoint<Result>).call(
        transaction,
        async (child) =>
          await operation(
            requireRequestSavepoint(
              observer === undefined ? child : wrapRequestTransaction(child, observer),
            ),
          ),
      ),
  };
  return capable;
};

/**
 * Require child-scope support without widening query-only transaction projections.
 * The returned method forwards with the original transaction as its receiver.
 */
export const requireRequestSavepoint = (
  transaction: RequestDatabaseTransaction,
): SavepointRequestDatabaseTransaction => {
  const wrapped = wrapRequestTransaction(transaction);
  if (getSavepointOperation(wrapped) === undefined)
    throw databaseError("DATABASE_SAVEPOINT_UNAVAILABLE");
  return wrapped as SavepointRequestDatabaseTransaction;
};

const validateContext = (candidate: SessionContext): SessionContext => {
  const parsed = sessionContextSchema.safeParse(candidate);
  if (!parsed.success) throw databaseError("INVALID_REQUEST_CONTEXT");

  const issuedAt = Date.parse(parsed.data.issuedAt);
  const expiresAt = Date.parse(parsed.data.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw databaseError("INVALID_REQUEST_CONTEXT_TIME");
  }
  if (expiresAt <= Date.now()) throw databaseError("EXPIRED_REQUEST_CONTEXT");

  return parsed.data;
};

// Bound idle callbacks as well as lock queues and statements. An owned request lifetime
// already bounds compilation between queries; other callers need a database idle backstop.
// LOCAL settings disappear at commit/rollback before the pooled connection is reused.
const setRequestTimeouts = async (transaction: TransactionDriver): Promise<void> => {
  await transaction.query`
    select pg_catalog.set_config('lock_timeout', '5s', true),
      pg_catalog.set_config('statement_timeout', '60s', true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',
        ${currentRequestDatabaseLifetimeOwner() === undefined ? "60s" : "0"}, true)
  `;
};

const createRuntimeTransactionRunner =
  (driver: DatabaseDriver) =>
  async <Result>(operation: RuntimeOperation<Result>): Promise<Result> =>
    driver.transaction(async (transaction) => {
      await setRequestTimeouts(transaction);
      return invokeRequestDatabaseCallback(() => operation(transaction));
    });

const createResolvedRequestTransactionRunner =
  (driver: DatabaseDriver) =>
  async <Scope, Result>(
    resolve: RequestContextResolver<Scope>,
    operation: ResolvedRequestOperation<Scope, Result>,
  ): Promise<Result> => {
    // Capture before the driver callback, which may run outside the caller's async context.
    const observer = currentProtectedReadObserver();
    return driver.transaction(async (transaction) => {
      await setRequestTimeouts(transaction);
      const resolved = await invokeRequestDatabaseCallback(() => resolve(transaction));
      const validated = validateContext(resolved.context);
      const parsedChannel =
        resolved.channel === undefined
          ? undefined
          : protectedOperationChannelSchema.safeParse(resolved.channel);
      if (parsedChannel !== undefined && !parsedChannel.success)
        throw databaseError("INVALID_REQUEST_CONTEXT_CHANNEL");
      const serialized = JSON.stringify({
        ...validated,
        ...(parsedChannel === undefined ? {} : { channel: parsedChannel.data }),
      });

      await transaction.query`select vortex_platform.initialize(${serialized}::text::jsonb)`;
      await transaction.query`set local role vortex_request`;

      const run = () =>
        invokeRequestDatabaseCallback(() =>
          operation(wrapRequestTransaction(transaction, observer), resolved.scope),
        );
      return observer === undefined ? run() : withProtectedReadObserver(observer, run);
    });
  };

/** A request's abort signal and deadline, applied to pooled-runner queries made under it. */
export type PooledRequestLifetime = Readonly<{ signal: AbortSignal; deadline: number }>;

const pooledLifetimeStorage = new AsyncLocalStorage<PooledRequestLifetime>();

/**
 * Runs `operation` so that every pooled-runner query it starts honours the request's signal and
 * deadline: a query is refused once either has ended, and a query in flight when the request is
 * aborted or the deadline passes is cancelled on the server. The cancelled statement fails, its
 * transaction rolls back and the pooled connection is released, so a hung read never holds it.
 */
export const withPooledRequestLifetime = <Result>(
  lifetime: PooledRequestLifetime,
  operation: () => Promise<Result>,
): Promise<Result> => pooledLifetimeStorage.run(lifetime, operation);

const createTransactionDriver = (
  transaction: TransactionSql,
  lifetime: PooledRequestLifetime | undefined,
): SavepointRequestDatabaseTransaction => ({
  query: async <ResultRow extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => {
    if (lifetime === undefined) return await transaction<ResultRow[] & Row[]>(strings, ...values);
    if (lifetime.signal.aborted || Date.now() >= lifetime.deadline)
      throw requestDatabaseError("DATABASE_REQUEST_STOPPED");
    const pending = transaction<ResultRow[] & Row[]>(strings, ...values);
    const cancel = () => {
      void Promise.resolve(pending.cancel()).catch(() => undefined);
    };
    lifetime.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, Math.max(0, lifetime.deadline - Date.now()));
    try {
      return await pending;
    } finally {
      clearTimeout(timer);
      lifetime.signal.removeEventListener("abort", cancel);
    }
  },
  // Use postgres.js' child TransactionSql so rejected queries poison only that child's scope;
  // the native promise settles (including rollback failures) before this method settles.
  withSavepoint: async <Result>(
    operation: (child: SavepointRequestDatabaseTransaction) => Promise<Result>,
  ): Promise<Result> => {
    // Box the callback value so postgres.js does not reinterpret an array result as query work.
    const settled = await transaction.savepoint(async (childSql) => ({
      value: await operation(createTransactionDriver(childSql, lifetime)),
    }));
    return settled.value;
  },
});

const createPostgresDriver = (client: Sql): DatabaseDriver => ({
  transaction: async <Result>(operation: (transaction: TransactionDriver) => Promise<Result>) => {
    // Captured in the caller's context: postgres.js may enter the callback from another one.
    const lifetime = pooledLifetimeStorage.getStore();
    if (lifetime !== undefined && (lifetime.signal.aborted || Date.now() >= lifetime.deadline))
      throw requestDatabaseError("DATABASE_REQUEST_STOPPED");
    return (await client.begin(async (sql) =>
      operation(createTransactionDriver(sql, lifetime)),
    )) as Result;
  },
});

const MAXIMUM_QUEUED_DATABASE_WORK = 64;

interface QueuedDatabaseWork {
  run(): Promise<void>;
  reject(): void;
}

/** FIFO ownership precedes native PendingQuery construction; no native private queue access. */
class RequestDatabaseQueue {
  private readonly waiting: QueuedDatabaseWork[] = [];
  private active: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly owner: RequestDatabaseLifetimeOwner) {}

  enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.owner.checkpoint();
    if (this.stopped) throw requestDatabaseError("DATABASE_REQUEST_STOPPED");
    if (this.waiting.length >= MAXIMUM_QUEUED_DATABASE_WORK)
      throw requestDatabaseError("DATABASE_REQUEST_QUEUE_FULL");
    let resolve!: (value: Result | PromiseLike<Result>) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<Result>((accept, refuse) => {
      resolve = accept;
      reject = refuse;
    });
    const work: QueuedDatabaseWork = {
      reject: () => reject(requestDatabaseError("DATABASE_REQUEST_STOPPED")),
      run: async () => {
        try {
          this.owner.checkpoint();
          const value = await operation();
          this.owner.checkpoint();
          resolve(value);
        } catch (error) {
          reject(error);
        }
      },
    };
    this.waiting.push(work);
    const registered = this.owner.track(result);
    this.pump();
    return registered;
  }

  stop(): void {
    this.stopped = true;
    for (const work of this.waiting.splice(0)) work.reject();
  }

  async settled(): Promise<void> {
    while (this.active !== undefined) await this.active;
  }

  private pump(): void {
    if (this.active !== undefined) return;
    const work = this.waiting.shift();
    if (work === undefined) return;
    if (this.stopped || this.owner.stopped) {
      work.reject();
      this.stop();
      return;
    }
    this.active = work.run();
    void this.active.then(() => {
      this.active = undefined;
      this.pump();
    });
  }
}

class ScopedTransactionDriver implements SavepointRequestDatabaseTransaction {
  private accepting = true;
  private childActive = false;
  private firstQueryFailure: { readonly error: unknown } | undefined;
  private readonly acceptedQueries = new Set<Promise<void>>();
  private readonly children = new Set<Promise<void>>();

  constructor(
    private readonly driver: RequestOwnedPostgresDriver,
    private readonly owner: RequestDatabaseLifetimeOwner,
  ) {}

  private checkpoint(): void {
    this.owner.checkpoint();
    if (!this.accepting) throw requestDatabaseError("DATABASE_TRANSACTION_SCOPE_CLOSED");
    if (this.childActive) throw requestDatabaseError("DATABASE_SAVEPOINT_SCOPE_BUSY");
  }

  private rememberQueryFailure(error: unknown): void {
    this.firstQueryFailure ??= { error };
  }

  private acceptQuery<Result>(dispatch: () => Promise<Result>): Promise<Result> {
    let result: Promise<Result>;
    try {
      result = dispatch();
    } catch (error) {
      this.rememberQueryFailure(error);
      throw error;
    }
    // Record failure even when the caller catches it or does not await its public projection.
    // The observation itself is retained until that exact accepted result settles.
    const observed = result.then(
      () => undefined,
      (error: unknown) => this.rememberQueryFailure(error),
    );
    this.acceptedQueries.add(observed);
    void observed.then(() => this.acceptedQueries.delete(observed));
    return result;
  }

  private async drainQueries(): Promise<void> {
    while (this.acceptedQueries.size > 0) await Promise.all([...this.acceptedQueries]);
  }

  readonly query = <ResultRow extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ): Promise<readonly ResultRow[]> => {
    this.checkpoint();
    // Scope sealing prevents new admission; previously accepted identities may still drain.
    return this.acceptQuery(() => this.driver.query<ResultRow>(strings, values));
  };

  async run<Result>(
    operation: (transaction: SavepointRequestDatabaseTransaction) => Promise<Result>,
  ): Promise<Result> {
    let value!: Result;
    let failed = false;
    let failure: unknown;
    try {
      value = await invokeRequestDatabaseCallback(() => {
        let actual: Promise<Result>;
        try {
          actual = operation(this);
        } catch (error) {
          this.accepting = false;
          throw error;
        }
        // Close admission at the actual callback-result boundary, before outer checkpoint
        // wrappers resume. Keep both that actual result and the sealing continuation joined.
        return this.owner.track(actual).then(
          (result) => {
            this.accepting = false;
            return result;
          },
          (error: unknown) => {
            this.accepting = false;
            throw error;
          },
        );
      });
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      // Seal immediately after the actual callback, before waiting for its accepted work.
      this.accepting = false;
      await this.drainQueries();
      while (this.children.size > 0) await Promise.all([...this.children]);
      if (this.owner.stopped) await this.driver.transportSettled();
    }
    this.owner.checkpoint();
    if (failed) {
      // Match native recovery's preference for the first query failure over a later 25P02.
      if (
        failure instanceof postgres.PostgresError &&
        failure.code === "25P02" &&
        this.firstQueryFailure !== undefined
      )
        throw this.firstQueryFailure.error;
      throw failure;
    }
    if (this.firstQueryFailure !== undefined) throw this.firstQueryFailure.error;
    return value;
  }

  readonly withSavepoint = <Result>(
    operation: (child: SavepointRequestDatabaseTransaction) => Promise<Result>,
  ): Promise<Result> => {
    this.checkpoint();
    this.childActive = true;
    const result = this.runSavepoint(operation);
    const observed = result.then(
      () => undefined,
      () => undefined,
    );
    this.children.add(observed);
    void observed.then(() => this.children.delete(observed));
    return this.owner.track(result);
  };

  private async runSavepoint<Result>(
    operation: (child: SavepointRequestDatabaseTransaction) => Promise<Result>,
  ): Promise<Result> {
    try {
      // Parent work admitted before the child reservation completes before SAVEPOINT.
      await this.drainQueries();
      this.owner.checkpoint();
      const name = this.driver.nextSavepoint();
      // Creation failure belongs to the parent: there is no recoverable child scope yet.
      await this.acceptQuery(() => this.driver.control(`SAVEPOINT ${name}`));
      const child = new ScopedTransactionDriver(this.driver, this.owner);
      try {
        const value = await this.owner.track(child.run(operation));
        this.owner.checkpoint();
        return value;
      } catch (error) {
        if (!this.owner.stopped) {
          try {
            // Acknowledged child recovery stays local and does not poison its parent.
            await this.driver.control(`ROLLBACK TO SAVEPOINT ${name}`);
          } catch (rollbackError) {
            // Failed recovery makes the dedicated connection unusable for any outer scope.
            this.owner.stop("abort");
            throw rollbackError;
          }
        }
        throw error;
      }
    } finally {
      // Recursive stopped unwinds join transport only; they construct no automatic rollback.
      if (this.owner.stopped) await this.driver.transportSettled();
      this.childActive = false;
    }
  }
}

const ownedTransactionStorage = new AsyncLocalStorage<RequestOwnedPostgresDriver>();

class RequestOwnedPostgresDriver implements DatabaseDriver {
  private readonly transactions: RequestDatabaseQueue;
  private readonly queries: RequestDatabaseQueue;
  private readonly sockets: RequestOwnedSocketFactory;
  private readonly client: Sql | undefined;
  private ended: Promise<void> | undefined;
  private firstBegin = true;
  private savepointSequence = 0;

  constructor(
    private readonly owner: RequestDatabaseLifetimeOwner,
    configuration: RuntimeDatabaseConfiguration,
  ) {
    const address = new URL(configuration.connectionString);
    const hostname = configuration.hostname.replace(/^\[|\]$/g, "");
    this.transactions = new RequestDatabaseQueue(owner);
    this.queries = new RequestDatabaseQueue(owner);
    this.sockets = new RequestOwnedSocketFactory(
      { hostname, port: Number(address.port), transport: configuration.transport },
      owner,
    );
    // The custom socket is documented by Postgres.js but omitted from its public .d.ts. Pass a
    // structurally typed options value; do not cast/mutate any private driver object or field.
    const options = {
      prepare: false,
      max: 1,
      host: hostname,
      idle_timeout: 0,
      max_lifetime: null,
      connect_timeout: 10,
      ssl: false,
      socket: this.sockets.open,
      connection: { application_name: "vortex-runtime" },
      onnotice: logDatabaseNotice,
    } satisfies postgres.Options<{}> & { socket: RequestOwnedSocketFactory["open"] };
    owner.registerResource({ stop: () => this.stop(), settled: () => this.settled() });
    this.client = postgres(configuration.connectionString, options);
  }

  readonly transaction = <Result>(
    operation: (transaction: TransactionDriver) => Promise<Result>,
  ): Promise<Result> => {
    if (ownedTransactionStorage.getStore() === this)
      throw requestDatabaseError("DATABASE_NESTED_TRANSACTION_UNSUPPORTED");
    return this.transactions.enqueue(async () => {
      try {
        this.owner.checkpoint();
        await this.control("BEGIN", true);
        return await ownedTransactionStorage.run(this, async () => {
          const transaction = new ScopedTransactionDriver(this, this.owner);
          try {
            const value = await this.owner.track(transaction.run(operation));
            this.owner.checkpoint();
            await this.control("COMMIT");
            this.owner.checkpoint();
            return value;
          } catch (error) {
            if (!this.owner.stopped) {
              try {
                await this.control("ROLLBACK");
              } catch (rollbackError) {
                this.owner.stop("abort");
                throw rollbackError;
              }
            }
            throw error;
          }
        });
      } finally {
        // Includes a stopped initial BEGIN, before any supported callback has been entered.
        if (this.owner.stopped) await this.transportSettled();
      }
    });
  };

  nextSavepoint(): string {
    this.owner.checkpoint();
    if (this.savepointSequence >= Number.MAX_SAFE_INTEGER)
      throw requestDatabaseError("DATABASE_SAVEPOINT_LIMIT_EXCEEDED");
    // Generated finite ASCII identifier, never a caller-provided SQL identifier or value.
    return `vortex_request_sp_${this.savepointSequence++}`;
  }

  query<ResultRow extends DatabaseRow>(
    strings: TemplateStringsArray,
    values: readonly DatabaseValue[],
  ): Promise<readonly ResultRow[]> {
    return this.dispatch<ResultRow>((sql) => sql<ResultRow[] & Row[]>(strings, ...values));
  }

  control(statement: string, initialBegin = false): Promise<readonly Row[]> {
    return this.dispatch<Row>((sql) => sql.unsafe<Row[]>(statement), initialBegin);
  }

  private dispatch<ResultRow extends DatabaseRow>(
    construct: (sql: Sql) => postgres.PendingQuery<ResultRow[] & Row[]>,
    initialBegin = false,
  ): Promise<readonly ResultRow[]> {
    return this.queries.enqueue(async () => {
      this.owner.checkpoint();
      const client = this.client;
      if (client === undefined) throw requestDatabaseError("DATABASE_CLIENT_UNAVAILABLE");
      const native = construct(client);
      // Construction precedes latch arming. execute() enters the public deferred handler in
      // this guarded turn, before tracking/assimilation/await or any concurrent end0 turn.
      if (initialBegin && this.firstBegin) {
        this.firstBegin = false;
        this.sockets.expectInitialEntry();
      }
      native.execute();
      const rows = await this.owner.track(native);
      this.owner.checkpoint();
      return rows;
    });
  }

  private stop(): void {
    this.transactions.stop();
    this.queries.stop();
    this.sockets.stop();
    // Public end is tracked independently. It is not proof of physical close or callback join.
    this.ended ??= this.owner.track(this.client?.end({ timeout: 0 }) ?? Promise.resolve());
    void this.ended.catch(() => undefined);
  }

  async transportSettled(): Promise<void> {
    let endFailure: unknown;
    await this.ended?.catch((error: unknown) => {
      endFailure = error ?? new Error("Client end rejected without a reason");
    });
    await this.sockets.settled();
    if (endFailure !== undefined)
      throw requestDatabaseError("DATABASE_CLIENT_END_FAILED", endFailure);
  }

  private async settled(): Promise<void> {
    let transportFailure: unknown;
    await this.transportSettled().catch((error: unknown) => {
      transportFailure = error;
    });
    await this.queries.settled();
    await this.transactions.settled();
    if (transportFailure !== undefined)
      throw requestDatabaseError("DATABASE_CLIENT_END_FAILED", transportFailure);
  }
}

const ownedDrivers = new WeakMap<RequestDatabaseLifetimeOwner, RequestOwnedPostgresDriver>();
const currentOwnedDriver = (): RequestOwnedPostgresDriver | undefined => {
  const owner = currentRequestDatabaseLifetimeOwner();
  if (owner === undefined) return undefined;
  owner.checkpoint();
  let driver = ownedDrivers.get(owner);
  if (driver === undefined) {
    driver = new RequestOwnedPostgresDriver(owner, parseRuntimeDatabaseConfiguration(process.env));
    ownedDrivers.set(owner, driver);
  }
  return driver;
};

const parsePoolSize = (candidate: string | undefined, environmentName: string): number => {
  const value = candidate?.trim();
  if (!value) return environmentName === "local" ? DEFAULT_LOCAL_POOL_SIZE : DEFAULT_POOL_SIZE;
  if (!/^[0-9]{1,2}$/.test(value)) throw databaseError("DATABASE_POOL_SIZE_INVALID");
  const size = Number(value);
  if (size < 1 || size > MAXIMUM_POOL_SIZE) throw databaseError("DATABASE_POOL_SIZE_INVALID");
  return size;
};

const parseRuntimeDatabaseConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeDatabaseConfiguration => {
  const connectionString = environment.VORTEX_RUNTIME_DATABASE_URL;
  const rootCertificate = environment.VORTEX_RUNTIME_DATABASE_SSL_ROOT_CERT;
  const environmentName = environment.VORTEX_ENVIRONMENT;
  if (!connectionString || !environmentName) throw databaseError("DATABASE_CONFIGURATION_MISSING");
  const poolSize = parsePoolSize(environment.VORTEX_RUNTIME_DATABASE_POOL_SIZE, environmentName);

  let address: URL;
  try {
    address = new URL(connectionString);
  } catch {
    throw databaseError("DATABASE_ADDRESS_UNPARSEABLE");
  }

  const username = decodeURIComponent(address.username);
  const localLoopback =
    environmentName === "local" &&
    address.protocol === "postgresql:" &&
    isLoopbackHostname(address.hostname) &&
    // The main Local Supabase stack listens on 54322; a worker's database lane on its own port.
    /^[0-9]+$/.test(address.port) &&
    address.pathname === "/postgres" &&
    username === "vortex_runtime" &&
    address.password.length > 0;
  if (localLoopback)
    return {
      connectionString,
      hostname: address.hostname,
      poolSize,
      transport: { kind: "local_loopback" },
    };

  const validHostedAddress =
    (environmentName === "testing" || environmentName === "production") &&
    address.protocol === "postgresql:" &&
    /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(address.hostname) &&
    address.port === "6543" &&
    address.pathname === "/postgres" &&
    /^vortex_runtime\.[a-z0-9]{20}$/.test(username) &&
    address.password.length > 0;
  if (!validHostedAddress) throw databaseError("DATABASE_ADDRESS_NOT_ACCEPTED");
  if (!rootCertificate) throw databaseError("DATABASE_ROOT_CERTIFICATE_MISSING");

  return {
    connectionString,
    hostname: address.hostname,
    poolSize,
    transport: { kind: "hosted_tls", rootCertificate },
  };
};

/**
 * The runtime connection-pool size of this instance: the one number every concurrent database
 * reader caps its parallelism at, so work never queues behind a pool smaller than its fan-out.
 */
export const runtimeDatabasePoolSize = (): number =>
  parseRuntimeDatabaseConfiguration(process.env).poolSize;

const createRuntimePostgresClient = (configuration: RuntimeDatabaseConfiguration): Sql =>
  postgres(configuration.connectionString, {
    prepare: false,
    max: configuration.poolSize,
    // A new connection is a new database server process, which compiles every database function
    // it calls again and rebuilds its catalogue caches: the first page read on it costs seconds
    // instead of milliseconds. Local loopback connections are therefore kept between page changes
    // (a person reading a page for a minute would otherwise find every connection closed and cold).
    // Hosted connections reach the transaction pooler, whose server connections stay warm on their
    // own, so they keep the short client-side lifetimes.
    idle_timeout: configuration.transport.kind === "local_loopback" ? 0 : 20,
    connect_timeout: 10,
    max_lifetime: configuration.transport.kind === "local_loopback" ? 3_600 : 300,
    ssl:
      configuration.transport.kind === "hosted_tls"
        ? {
            ca: configuration.transport.rootCertificate,
            rejectUnauthorized: true,
            servername: configuration.hostname,
          }
        : false,
    connection: { application_name: "vortex-runtime" },
    // The driver would print every server message as an error-shaped object. Only NOTICE-level
    // messages (for example an idempotent "already exists, skipping") are dropped; a warning is
    // reported with its invalidation cause when available; real errors still reject the query.
    onnotice: logDatabaseNotice,
  });

// Next's instrumentation and page bundles have separate module caches in one Node process.
// They share the ordinary connection pool; request context is still installed per transaction,
// and request-owned connections keep their separate abortable lifetime above.
const runtimeDatabaseClientKey = Symbol.for("vortex.runtimeDatabaseClient");
const processDatabase = globalThis as typeof globalThis & {
  [runtimeDatabaseClientKey]?: Sql;
};
const loadClient = (): Sql =>
  (processDatabase[runtimeDatabaseClientKey] ??= createRuntimePostgresClient(
    parseRuntimeDatabaseConfiguration(process.env),
  ));

const defaultRuntimeRunner = createRuntimeTransactionRunner({
  transaction: async <Result>(operation: (transaction: TransactionDriver) => Promise<Result>) => {
    return createPostgresDriver(loadClient()).transaction(operation);
  },
});
const defaultResolvedRequestRunner = createResolvedRequestTransactionRunner({
  transaction: async <Result>(operation: (transaction: TransactionDriver) => Promise<Result>) => {
    return createPostgresDriver(loadClient()).transaction(operation);
  },
});

export const withRuntimeTransaction = async <Result>(
  operation: RuntimeOperation<Result>,
): Promise<Result> => {
  const owned = currentOwnedDriver();
  return owned === undefined
    ? defaultRuntimeRunner(operation)
    : createRuntimeTransactionRunner(owned)(operation);
};

export const withResolvedRequestTransaction = async <Scope, Result>(
  resolve: RequestContextResolver<Scope>,
  operation: ResolvedRequestOperation<Scope, Result>,
): Promise<Result> => {
  const owned = currentOwnedDriver();
  return owned === undefined
    ? defaultResolvedRequestRunner(resolve, operation)
    : createResolvedRequestTransactionRunner(owned)(resolve, operation);
};
