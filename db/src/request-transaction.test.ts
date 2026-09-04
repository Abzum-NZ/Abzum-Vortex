import { sessionContextSchema, type SessionContext } from "@vortex/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createRequestTransactionRunner,
  createRuntimeTransactionRunner,
  type DatabaseRow,
  type DatabaseValue,
} from "./request-transaction";

const context = (): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "human",
    tenantId: "10000000-0000-4000-8000-000000000001",
    organizationId: "20000000-0000-4000-8000-000000000001",
    applicationRootId: "30000000-0000-4000-8000-000000000001",
    identityId: "40000000-0000-4000-8000-000000000001",
    organizationAccountId: "50000000-0000-4000-8000-000000000001",
    sessionId: "60000000-0000-4000-8000-000000000001",
    authenticationStrength: "multi_factor",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    accessVersion: 1,
    correlationId: "70000000-0000-4000-8000-000000000001",
  });

const statementText = (strings: TemplateStringsArray): string => strings.join("$value");

describe("request database transaction", () => {
  it("runs pre-context trusted work in one transaction without inventing request context", async () => {
    const statements: string[] = [];
    const driver = {
      transaction: async <Result>(
        operation: (transaction: {
          query<Row extends DatabaseRow>(
            strings: TemplateStringsArray,
            ...values: readonly DatabaseValue[]
          ): Promise<readonly Row[]>;
        }) => Promise<Result>,
      ): Promise<Result> =>
        operation({
          query: async <Row extends DatabaseRow>(strings: TemplateStringsArray) => {
            statements.push(statementText(strings));
            return [] as readonly Row[];
          },
        }),
    };

    await expect(
      createRuntimeTransactionRunner(driver)(async (transaction) => {
        await transaction.query`select pg_catalog.current_role`;
        return "complete";
      }),
    ).resolves.toBe("complete");

    expect(statements).toEqual(["select pg_catalog.current_role"]);
    expect(statements).not.toContain("set local role vortex_request");
  });

  it("establishes context, enters the request role, and then runs the operation", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const driver = {
      transaction: async <Result>(
        operation: (transaction: {
          query<Row extends DatabaseRow>(
            strings: TemplateStringsArray,
            ...values: readonly DatabaseValue[]
          ): Promise<readonly Row[]>;
        }) => Promise<Result>,
      ): Promise<Result> =>
        operation({
          query: async <Row extends DatabaseRow>(
            strings: TemplateStringsArray,
            ...values: readonly DatabaseValue[]
          ) => {
            calls.push({ text: statementText(strings), values });
            return [] as readonly Row[];
          },
        }),
    };
    const operation = vi.fn(async (transaction) => {
      await transaction.query`select ${"safe-value"}::text as value`;
      return "complete";
    });

    await expect(createRequestTransactionRunner(driver)(context(), operation)).resolves.toBe(
      "complete",
    );
    expect(calls.map(({ text }) => text)).toEqual([
      "select vortex_context.initialize($value::jsonb)",
      "set local role vortex_request",
      "select $value::text as value",
    ]);
    expect(JSON.parse(String(calls[0]?.values[0]))).toMatchObject({ callerKind: "human" });
    expect(calls[2]?.values).toEqual(["safe-value"]);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("refuses an invalid context before opening a transaction", async () => {
    const transaction = vi.fn();
    const invalid = { ...context(), organizationId: "browser-value" } as unknown as SessionContext;

    await expect(
      createRequestTransactionRunner({ transaction })(invalid, async () => undefined),
    ).rejects.toThrow("INVALID_REQUEST_CONTEXT");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses an expired context before opening a transaction", async () => {
    const transaction = vi.fn();
    const expired = {
      ...context(),
      issuedAt: new Date(Date.now() - 2_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };

    await expect(
      createRequestTransactionRunner({ transaction })(expired, async () => undefined),
    ).rejects.toThrow("EXPIRED_REQUEST_CONTEXT");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("leaves rollback to the transaction driver when protected work fails", async () => {
    const failure = new Error("controlled failure");
    const transaction = vi.fn(async () => {
      throw failure;
    });

    await expect(
      createRequestTransactionRunner({ transaction })(context(), async () => undefined),
    ).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("starts clean on connection reuse after protected work fails", async () => {
    const statements: string[] = [];
    let contextEstablished = false;
    const driver = {
      transaction: async <Result>(
        operation: (transaction: {
          query<Row extends DatabaseRow>(
            strings: TemplateStringsArray,
            ...values: readonly DatabaseValue[]
          ): Promise<readonly Row[]>;
        }) => Promise<Result>,
      ): Promise<Result> => {
        try {
          return await operation({
            query: async <Row extends DatabaseRow>(strings: TemplateStringsArray) => {
              const statement = statementText(strings);
              statements.push(statement);
              if (statement.startsWith("select vortex_context.initialize")) {
                if (contextEstablished) throw new Error("CONTEXT_REUSED");
                contextEstablished = true;
              }
              return [] as readonly Row[];
            },
          });
        } finally {
          contextEstablished = false;
        }
      },
    };
    const runner = createRequestTransactionRunner(driver);

    await expect(
      runner(context(), async (transaction) => {
        await transaction.query`select ${"first"}::text`;
        throw new Error("OPERATION_FAILED");
      }),
    ).rejects.toThrow("OPERATION_FAILED");
    await expect(runner(context(), async () => "second")).resolves.toBe("second");

    expect(
      statements.filter((statement) => statement.startsWith("select vortex_context.initialize")),
    ).toHaveLength(2);
    expect(contextEstablished).toBe(false);
  });
});
