import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimePostgresClient,
  parseRuntimeDatabaseConfiguration,
} from "./request-transaction";

vi.mock("postgres", () => ({ default: vi.fn(() => ({ kind: "test-client" })) }));

const validEnvironment = {
  VORTEX_ENVIRONMENT: "testing",
  VORTEX_RUNTIME_DATABASE_URL:
    "postgresql://vortex_runtime.abcdefghijklmnopqrst:encoded-password@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres",
  VORTEX_RUNTIME_DATABASE_SSL_ROOT_CERT: "test-root-certificate",
} as const;

describe("runtime database configuration", () => {
  it("accepts only the restricted runtime role over the Supavisor transaction endpoint", () => {
    expect(parseRuntimeDatabaseConfiguration(validEnvironment)).toEqual({
      connectionString: validEnvironment.VORTEX_RUNTIME_DATABASE_URL,
      hostname: "aws-0-ap-southeast-2.pooler.supabase.com",
      transport: { kind: "hosted_tls", rootCertificate: "test-root-certificate" },
    });
  });

  it.each([
    [
      "owner role",
      "postgresql://postgres.abcdefghijklmnopqrst:password@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres",
    ],
    [
      "session pooler",
      "postgresql://vortex_runtime.abcdefghijklmnopqrst:password@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres",
    ],
    [
      "unverified host",
      "postgresql://vortex_runtime.abcdefghijklmnopqrst:password@database.example.com:6543/postgres",
    ],
    [
      "wrong database",
      "postgresql://vortex_runtime.abcdefghijklmnopqrst:password@aws-0-ap-southeast-2.pooler.supabase.com:6543/tenant",
    ],
    [
      "missing password",
      "postgresql://vortex_runtime.abcdefghijklmnopqrst@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres",
    ],
  ])("refuses a %s connection", (_description, connectionString) => {
    expect(() =>
      parseRuntimeDatabaseConfiguration({
        ...validEnvironment,
        VORTEX_RUNTIME_DATABASE_URL: connectionString,
      }),
    ).toThrow("DATABASE_CONFIGURATION_INVALID");
  });

  it("requires both the connection and trusted root certificate", () => {
    expect(() => parseRuntimeDatabaseConfiguration({})).toThrow("DATABASE_CONFIGURATION_MISSING");
  });

  it("accepts only the restricted runtime role on the exact Local Supabase loopback endpoint", () => {
    const connectionString =
      "postgresql://vortex_runtime:local-only-password@127.0.0.1:54322/postgres";
    expect(
      parseRuntimeDatabaseConfiguration({
        VORTEX_ENVIRONMENT: "local",
        VORTEX_RUNTIME_DATABASE_URL: connectionString,
      }),
    ).toEqual({
      connectionString,
      hostname: "127.0.0.1",
      transport: { kind: "local_loopback" },
    });
  });

  it.each([
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "postgresql://vortex_runtime:password@database.example.test:54322/postgres",
    "postgresql://vortex_runtime:password@127.0.0.1:6543/postgres",
  ])("refuses an unsafe Local database address", (connectionString) => {
    expect(() =>
      parseRuntimeDatabaseConfiguration({
        VORTEX_ENVIRONMENT: "local",
        VORTEX_RUNTIME_DATABASE_URL: connectionString,
      }),
    ).toThrow("DATABASE_CONFIGURATION_INVALID");
  });

  it("disables prepared statements, limits the pool, and verifies TLS", () => {
    const configuration = parseRuntimeDatabaseConfiguration(validEnvironment);

    createRuntimePostgresClient(configuration);

    expect(postgres).toHaveBeenCalledWith(configuration.connectionString, {
      prepare: false,
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      max_lifetime: 300,
      ssl: {
        ca:
          configuration.transport.kind === "hosted_tls"
            ? configuration.transport.rootCertificate
            : undefined,
        rejectUnauthorized: true,
        servername: configuration.hostname,
      },
      connection: { application_name: "vortex-runtime" },
    });
  });

  it("disables TLS only for the exact Local loopback profile", () => {
    const configuration = parseRuntimeDatabaseConfiguration({
      VORTEX_ENVIRONMENT: "local",
      VORTEX_RUNTIME_DATABASE_URL:
        "postgresql://vortex_runtime:local-only-password@127.0.0.1:54322/postgres",
    });

    createRuntimePostgresClient(configuration);

    expect(postgres).toHaveBeenLastCalledWith(
      configuration.connectionString,
      expect.objectContaining({ ssl: false }),
    );
  });
});
