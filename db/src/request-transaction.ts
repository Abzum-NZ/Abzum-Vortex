import "server-only";

import {
  isLoopbackHostname,
  protectedOperationChannelSchema,
  sessionContextSchema,
  type ProtectedOperationChannel,
  type SessionContext,
} from "@vortex/contracts";
import postgres, { type Row, type Sql, type TransactionSql } from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  currentRequestDatabaseLifetimeOwner,
  invokeRequestDatabaseCallback,
  requestDatabaseError,
  type RequestDatabaseLifetimeOwner,
} from "./request-lifetime";
import { RequestOwnedSocketFactory } from "./request-owned-socket";

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
   * request context, never read from client input; when absent `vortex_context.channel()` reads
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
const MAXIMUM_POOL_SIZE = 20;

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

const wrapRequestTransaction = (transaction: TransactionDriver): RequestDatabaseTransaction => {
  const queryOnly: RequestDatabaseTransaction = {
    query: <ResultRow extends DatabaseRow>(
      strings: TemplateStringsArray,
      ...values: readonly DatabaseValue[]
    ) => transaction.query<ResultRow>(strings, ...values),
  };
  const withSavepoint = getSavepointOperation(transaction);
  if (withSavepoint === undefined) return queryOnly;

  const capable: SavepointRequestDatabaseTransaction = {
    ...queryOnly,
    withSavepoint: <Result>(
      operation: (child: SavepointRequestDatabaseTransaction) => Promise<Result>,
    ) =>
      (withSavepoint<Result>).call(transaction, async (child) =>
        await operation(requireRequestSavepoint(child)),
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

export const createRuntimeTransactionRunner =
  (driver: DatabaseDriver) =>
  async <Result>(operation: RuntimeOperation<Result>): Promise<Result> =>
    driver.transaction(async (transaction) =>
      invokeRequestDatabaseCallback(() => operation(transaction)),
    );

export const createResolvedRequestTransactionRunner =
  (driver: DatabaseDriver) =>
  async <Scope, Result>(
    resolve: RequestContextResolver<Scope>,
    operation: ResolvedRequestOperation<Scope, Result>,
  ): Promise<Result> =>
    driver.transaction(async (transaction) => {
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

      await transaction.query`select vortex_context.initialize(${serialized}::text::jsonb)`;
      await transaction.query`set local role vortex_request`;

      return invokeRequestDatabaseCallback(() =>
        operation(wrapRequestTransaction(transaction), resolved.scope),
      );
    });

const createTransactionDriver = (
  transaction: TransactionSql,
): SavepointRequestDatabaseTransaction => ({
  query: async <ResultRow extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => {
    const rows = await transaction<ResultRow[] & Row[]>(strings, ...values);
    return rows;
  },
  // Use postgres.js' child TransactionSql so rejected queries poison only that child's scope;
  // the native promise settles (including rollback failures) before this method settles.
  withSavepoint: async <Result>(
    operation: (child: SavepointRequestDatabaseTransaction) => Promise<Result>,
  ): Promise<Result> => {
    // Box the callback value so postgres.js does not reinterpret an array result as query work.
    const settled = await transaction.savepoint(async (childSql) => ({
      value: await operation(createTransactionDriver(childSql)),
    }));
    return settled.value;
  },
});

const createPostgresDriver = (client: Sql): DatabaseDriver => ({
  transaction: async <Result>(operation: (transaction: TransactionDriver) => Promise<Result>) =>
    (await client.begin(async (sql) => operation(createTransactionDriver(sql)))) as Result,
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
      host: [hostname],
      idle_timeout: 0,
      max_lifetime: null,
      connect_timeout: 10,
      ssl: false as const,
      socket: this.sockets.open,
      connection: { application_name: "vortex-runtime" },
      onnotice: (notice: postgres.Notice) => {
        if (notice.severity !== "NOTICE")
          console.warn(`[db] server ${String(notice.severity)} ${String(notice.code)}`);
      },
    };
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
    let endFailed = false;
    await this.ended?.catch(() => {
      endFailed = true;
    });
    await this.sockets.settled();
    if (endFailed) throw requestDatabaseError("DATABASE_CLIENT_END_FAILED");
  }

  private async settled(): Promise<void> {
    let transportFailed = false;
    await this.transportSettled().catch(() => {
      transportFailed = true;
    });
    await this.queries.settled();
    await this.transactions.settled();
    if (transportFailed) throw requestDatabaseError("DATABASE_CLIENT_END_FAILED");
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

const parsePoolSize = (candidate: string | undefined): number => {
  const value = candidate?.trim();
  if (!value) return DEFAULT_POOL_SIZE;
  if (!/^[0-9]{1,2}$/.test(value)) throw databaseError("DATABASE_POOL_SIZE_INVALID");
  const size = Number(value);
  if (size < 1 || size > MAXIMUM_POOL_SIZE) throw databaseError("DATABASE_POOL_SIZE_INVALID");
  return size;
};

export const parseRuntimeDatabaseConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeDatabaseConfiguration => {
  const connectionString = environment.VORTEX_RUNTIME_DATABASE_URL;
  const rootCertificate = environment.VORTEX_RUNTIME_DATABASE_SSL_ROOT_CERT;
  const environmentName = environment.VORTEX_ENVIRONMENT;
  if (!connectionString || !environmentName) throw databaseError("DATABASE_CONFIGURATION_MISSING");
  const poolSize = parsePoolSize(environment.VORTEX_RUNTIME_DATABASE_POOL_SIZE);

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
    address.port === "54322" &&
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

export const createRuntimePostgresClient = (configuration: RuntimeDatabaseConfiguration): Sql =>
  postgres(configuration.connectionString, {
    prepare: false,
    max: configuration.poolSize,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 300,
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
    // reported by severity and code alone, and real errors still reject the query.
    onnotice: (notice) => {
      if (notice.severity !== "NOTICE")
        console.warn(`[db] server ${String(notice.severity)} ${String(notice.code)}`);
    },
  });

const loadClient = (): Sql =>
  createRuntimePostgresClient(parseRuntimeDatabaseConfiguration(process.env));

let client: Sql | undefined;
const defaultRuntimeRunner = createRuntimeTransactionRunner({
  transaction: async <Result>(operation: (transaction: TransactionDriver) => Promise<Result>) => {
    client ??= loadClient();
    return createPostgresDriver(client).transaction(operation);
  },
});
const defaultResolvedRequestRunner = createResolvedRequestTransactionRunner({
  transaction: async <Result>(operation: (transaction: TransactionDriver) => Promise<Result>) => {
    client ??= loadClient();
    return createPostgresDriver(client).transaction(operation);
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
