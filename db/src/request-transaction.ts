import "server-only";

import { sessionContextSchema, type SessionContext } from "@vortex/contracts";
import postgres, { type Row, type Sql, type TransactionSql } from "postgres";

export type DatabaseValue = string | number | boolean | Date | Uint8Array | null;
export type DatabaseRow = Readonly<Record<string, unknown>>;

export interface RequestDatabaseTransaction {
  query<ResultRow extends DatabaseRow = DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ): Promise<readonly ResultRow[]>;
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
  readonly transport:
    | Readonly<{ kind: "local_loopback" }>
    | Readonly<{ kind: "hosted_tls"; rootCertificate: string }>;
}

type RequestOperation<Result> = (transaction: RequestDatabaseTransaction) => Promise<Result>;
type RuntimeOperation<Result> = (transaction: RuntimeDatabaseTransaction) => Promise<Result>;

const databaseError = (code: string): Error => {
  const error = new Error(code);
  error.name = "VortexDatabaseError";
  return error;
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

export const createRequestTransactionRunner =
  (driver: DatabaseDriver) =>
  async <Result>(context: SessionContext, operation: RequestOperation<Result>): Promise<Result> => {
    const validated = validateContext(context);
    const serialized = JSON.stringify(validated);

    return driver.transaction(async (transaction) => {
      await transaction.query`select vortex_context.initialize(${serialized}::jsonb)`;
      await transaction.query`set local role vortex_request`;

      return operation({
        query: <ResultRow extends DatabaseRow>(
          strings: TemplateStringsArray,
          ...values: readonly DatabaseValue[]
        ) => transaction.query<ResultRow>(strings, ...values),
      });
    });
  };

export const createRuntimeTransactionRunner =
  (driver: DatabaseDriver) =>
  async <Result>(operation: RuntimeOperation<Result>): Promise<Result> =>
    driver.transaction(async (transaction) => operation(transaction));

const createTransactionDriver = (transaction: TransactionSql): TransactionDriver => ({
  query: async <ResultRow extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => {
    const rows = await transaction<ResultRow[] & Row[]>(strings, ...values);
    return rows;
  },
});

const createPostgresDriver = (client: Sql): DatabaseDriver => ({
  transaction: async <Result>(operation: (transaction: TransactionDriver) => Promise<Result>) =>
    (await client.begin(async (sql) => operation(createTransactionDriver(sql)))) as Result,
});

export const parseRuntimeDatabaseConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeDatabaseConfiguration => {
  const connectionString = environment.VORTEX_RUNTIME_DATABASE_URL;
  const rootCertificate = environment.VORTEX_RUNTIME_DATABASE_SSL_ROOT_CERT;
  const environmentName = environment.VORTEX_ENVIRONMENT;
  if (!connectionString || !environmentName) throw databaseError("DATABASE_CONFIGURATION_MISSING");

  let address: URL;
  try {
    address = new URL(connectionString);
  } catch {
    throw databaseError("DATABASE_CONFIGURATION_INVALID");
  }

  const username = decodeURIComponent(address.username);
  const localLoopback =
    environmentName === "local" &&
    address.protocol === "postgresql:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(address.hostname) &&
    address.port === "54322" &&
    address.pathname === "/postgres" &&
    username === "vortex_runtime" &&
    address.password.length > 0;
  if (localLoopback)
    return {
      connectionString,
      hostname: address.hostname,
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
  if (!validHostedAddress || !rootCertificate)
    throw databaseError("DATABASE_CONFIGURATION_INVALID");

  return {
    connectionString,
    hostname: address.hostname,
    transport: { kind: "hosted_tls", rootCertificate },
  };
};

export const createRuntimePostgresClient = (configuration: RuntimeDatabaseConfiguration): Sql =>
  postgres(configuration.connectionString, {
    prepare: false,
    max: 1,
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
  });

const loadClient = (): Sql =>
  createRuntimePostgresClient(parseRuntimeDatabaseConfiguration(process.env));

let client: Sql | undefined;
const defaultRunner = createRequestTransactionRunner({
  transaction: async <Result>(operation: (transaction: TransactionDriver) => Promise<Result>) => {
    client ??= loadClient();
    return createPostgresDriver(client).transaction(operation);
  },
});
const defaultRuntimeRunner = createRuntimeTransactionRunner({
  transaction: async <Result>(operation: (transaction: TransactionDriver) => Promise<Result>) => {
    client ??= loadClient();
    return createPostgresDriver(client).transaction(operation);
  },
});

export const withRequestTransaction = async <Result>(
  context: SessionContext,
  operation: RequestOperation<Result>,
): Promise<Result> => defaultRunner(context, operation);

export const withRuntimeTransaction = async <Result>(
  operation: RuntimeOperation<Result>,
): Promise<Result> => defaultRuntimeRunner(operation);
