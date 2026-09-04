import { sessionContextSchema, type SessionContext } from "@vortex/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createResolvedRequestTransactionRunner,
  createRuntimeTransactionRunner,
  type DatabaseRow,
  type DatabaseValue,
} from "./request-transaction";

const context = (): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "human",
    identityAuthorityId: "80000000-0000-4000-8000-000000000001",
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

  it("resolves scope, establishes its context, and performs protected work in one transaction", async () => {
    const calls: string[] = [];
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
            calls.push(statementText(strings));
            return [] as readonly Row[];
          },
        }),
    };

    const result = await createResolvedRequestTransactionRunner(driver)(
      async (transaction) => {
        await transaction.query`select ${"candidate"}::text`;
        return { context: context(), scope: { organizationId: context().organizationId } };
      },
      async (transaction, scope) => {
        await transaction.query`select vortex_context.current_context()`;
        return scope.organizationId;
      },
    );

    expect(result).toBe(context().organizationId);
    expect(calls).toEqual([
      "select $value::text",
      "select vortex_context.initialize($value::text::jsonb)",
      "set local role vortex_request",
      "select vortex_context.current_context()",
    ]);
  });

  it("refuses a resolver's invalid context before initialization or protected work", async () => {
    const queries = vi.fn(async () => []);
    let transactionCalls = 0;
    const transaction = async <Result>(
      operation: (transaction: {
        query<Row extends DatabaseRow>(
          strings: TemplateStringsArray,
          ...values: readonly DatabaseValue[]
        ): Promise<readonly Row[]>;
      }) => Promise<Result>,
    ): Promise<Result> => {
      transactionCalls += 1;
      return operation({ query: queries });
    };
    const protectedOperation = vi.fn();
    const invalid = { ...context(), organizationId: "browser-value" } as unknown as SessionContext;

    await expect(
      createResolvedRequestTransactionRunner({ transaction })(
        async () => ({ context: invalid, scope: undefined }),
        protectedOperation,
      ),
    ).rejects.toThrow("INVALID_REQUEST_CONTEXT");
    expect(transactionCalls).toBe(1);
    expect(queries).not.toHaveBeenCalled();
    expect(protectedOperation).not.toHaveBeenCalled();
  });

  it("refuses a resolver's expired context before initialization or protected work", async () => {
    const queries = vi.fn(async () => []);
    let transactionCalls = 0;
    const transaction = async <Result>(
      operation: (transaction: {
        query<Row extends DatabaseRow>(
          strings: TemplateStringsArray,
          ...values: readonly DatabaseValue[]
        ): Promise<readonly Row[]>;
      }) => Promise<Result>,
    ): Promise<Result> => {
      transactionCalls += 1;
      return operation({ query: queries });
    };
    const protectedOperation = vi.fn();
    const expired = {
      ...context(),
      issuedAt: new Date(Date.now() - 2_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };

    await expect(
      createResolvedRequestTransactionRunner({ transaction })(
        async () => ({ context: expired, scope: undefined }),
        protectedOperation,
      ),
    ).rejects.toThrow("EXPIRED_REQUEST_CONTEXT");
    expect(transactionCalls).toBe(1);
    expect(queries).not.toHaveBeenCalled();
    expect(protectedOperation).not.toHaveBeenCalled();
  });

  it("leaves rollback to the transaction driver when protected work fails", async () => {
    const failure = new Error("controlled failure");
    const transaction = vi.fn(async () => {
      throw failure;
    });

    await expect(
      createResolvedRequestTransactionRunner({ transaction })(
        async () => ({ context: context(), scope: undefined }),
        async () => undefined,
      ),
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
    const runner = createResolvedRequestTransactionRunner(driver);
    const resolve = async () => ({ context: context(), scope: undefined });

    await expect(
      runner(resolve, async (transaction) => {
        await transaction.query`select ${"first"}::text`;
        throw new Error("OPERATION_FAILED");
      }),
    ).rejects.toThrow("OPERATION_FAILED");
    await expect(runner(resolve, async () => "second")).resolves.toBe("second");

    expect(
      statements.filter((statement) => statement.startsWith("select vortex_context.initialize")),
    ).toHaveLength(2);
    expect(contextEstablished).toBe(false);
  });
});
