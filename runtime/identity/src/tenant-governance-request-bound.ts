import "server-only";

import {
  identitySessionSchema,
  protectedOperationChannelSchema,
  selectedOrganizationScopeSchema,
  sessionContextSchema,
  type IdentitySession,
  type ProtectedOperationChannel,
  type SessionContext,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import {
  requireRequestSavepoint,
  type DatabaseRow,
  type DatabaseValue,
  type RequestDatabaseTransaction,
  type SavepointRequestDatabaseTransaction,
} from "@vortex/db";
import { createTenantGovernanceService } from "./tenant-governance";

type TenantGovernanceMethod =
  | "createOrganization"
  | "renameOrganization"
  | "suspendOrganization"
  | "reactivateOrganization";

export type RequestBoundTenantGovernanceService = Pick<
  ReturnType<typeof createTenantGovernanceService>,
  TenantGovernanceMethod
>;

type BoundRequestRow = DatabaseRow & {
  current_role: unknown;
  session_role: unknown;
  can_set_runtime: unknown;
  request_channel: unknown;
  request_context: unknown;
};

type BoundHumanRequest = Readonly<{
  context: Extract<SessionContext, { callerKind: "human" | "federated" }>;
  channel: ProtectedOperationChannel;
}>;

type TransactionInvocationState = {
  queue: Promise<void>;
  activeMethod?: TenantGovernanceMethod;
  runtimeCallUsed: boolean;
  identityQueryUsed: boolean;
  invocationTransaction?: SavepointRequestDatabaseTransaction;
  boundRequest?: BoundHumanRequest;
  poisonedTransaction?: Error;
};

const invocationStates = new WeakMap<RequestDatabaseTransaction, TransactionInvocationState>();

const invocationStateFor = (transaction: RequestDatabaseTransaction) => {
  const existing = invocationStates.get(transaction);
  if (existing !== undefined) return existing;
  const created: TransactionInvocationState = {
    queue: Promise.resolve(),
    runtimeCallUsed: false,
    identityQueryUsed: false,
  };
  invocationStates.set(transaction, created);
  return created;
};

const failure = (code: string) => new Error(code);

class TypedMethodRefusalRollback extends Error {
  constructor(readonly result: unknown) {
    super("TENANT_GOVERNANCE_TYPED_REFUSAL_ROLLBACK");
  }
}

const mappedIdentitySqlErrorCodes = new Set([
  // Keep these aligned with tenant-governance.ts: only its known database refusals may reach it
  // after the native exact-call child has settled and request context/role restoration is proven.
  "V3001",
  "V3101",
  "V3102",
  "V3103",
  "42501",
  "23503",
  "23505",
  "23514",
  "40001",
  "22023",
]);

const databaseCode = (error: unknown): string | undefined => {
  try {
    return typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  } catch {
    return undefined;
  }
};

const isMappedIdentitySqlError = (error: unknown): boolean => {
  const code = databaseCode(error);
  return code !== undefined && mappedIdentitySqlErrorCodes.has(code);
};

const isRuntimeSessionRole = (role: unknown): role is string =>
  role === "vortex_runtime" ||
  (typeof role === "string" && /^vortex_runtime\.[a-z0-9]{20}$/.test(role));

const identityFunctionForMethod: Readonly<Record<TenantGovernanceMethod, string>> = {
  createOrganization: "vortex_identity.create_tenant_organization",
  renameOrganization: "vortex_identity.rename_tenant_organization",
  suspendOrganization: "vortex_identity.suspend_tenant_organization",
  reactivateOrganization: "vortex_identity.reactivate_tenant_organization",
};

/**
 * Binds the four organization-governance methods to an already-resolved human request transaction.
 * The runtime role is entered only around the existing typed Identity method call; callers receive
 * neither a role-switch function nor a general elevated query callback.
 */
export const createRequestBoundTenantGovernanceService = (
  transaction: RequestDatabaseTransaction,
  scopeCandidate: SelectedOrganizationScope,
): RequestBoundTenantGovernanceService => {
  const parsedScope = selectedOrganizationScopeSchema.safeParse(scopeCandidate);
  if (!parsedScope.success) throw failure("TENANT_GOVERNANCE_SCOPE_UNAVAILABLE");
  const scope = parsedScope.data;
  const parentTransaction = requireRequestSavepoint(transaction);
  const state = invocationStateFor(transaction);

  const poison = (code: string): Error => {
    state.poisonedTransaction ??= failure(code);
    return state.poisonedTransaction;
  };

  const serialized = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const previous = state.queue;
    let release!: () => void;
    state.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (state.poisonedTransaction !== undefined) throw state.poisonedTransaction;
      return await operation();
    } finally {
      release();
    }
  };

  const readBoundHumanContext = async (
    readTransaction: RequestDatabaseTransaction = parentTransaction,
  ): Promise<BoundHumanRequest> => {
    // The stored context also carries the trusted channel. Validate that separately from the
    // strict SessionContext shape without changing the context installed on the transaction.
    const rows = await readTransaction.query<BoundRequestRow>`
      select
        current_user::text as current_role,
        session_user::text as session_role,
        pg_catalog.pg_has_role(session_user, 'vortex_runtime', 'SET') as can_set_runtime,
        vortex_context.current_context() - 'channel' as request_context,
        vortex_context.channel() as request_channel
    `;
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined) throw failure("TENANT_GOVERNANCE_REQUEST_CONTEXT_UNAVAILABLE");
    const context = sessionContextSchema.safeParse(row.request_context);
    const channel = protectedOperationChannelSchema.safeParse(row.request_channel);
    if (
      row.current_role !== "vortex_request" ||
      !isRuntimeSessionRole(row.session_role) ||
      row.can_set_runtime !== true ||
      !context.success ||
      !channel.success
    )
      throw failure("TENANT_GOVERNANCE_REQUEST_CONTEXT_UNAVAILABLE");
    const resolved = context.data;
    if (
      (resolved.callerKind !== "human" && resolved.callerKind !== "federated") ||
      resolved.tenantId !== scope.tenantId ||
      resolved.organizationId !== scope.organizationId ||
      resolved.organizationAccountId !== scope.organizationAccountId ||
      resolved.applicationRootId !== scope.applicationRootId ||
      resolved.accessVersion !== scope.accessVersion
    )
      throw failure("TENANT_GOVERNANCE_REQUEST_CONTEXT_UNAVAILABLE");
    return { context: resolved, channel: channel.data };
  };

  const assertBoundHumanContext = async (
    readTransaction: RequestDatabaseTransaction,
    expected: BoundHumanRequest,
  ): Promise<void> => {
    const actual = await readBoundHumanContext(readTransaction);
    if (
      JSON.stringify(actual.context) !== JSON.stringify(expected.context) ||
      actual.channel !== expected.channel
    )
      throw failure("TENANT_GOVERNANCE_REQUEST_CONTEXT_CHANGED");
  };

  const isRefusedResult = (result: unknown): boolean =>
    typeof result === "object" &&
    result !== null &&
    "outcome" in result &&
    result.outcome === "refused";

  const runOneIdentityMethod = async <Result>(
    operation: (requestTransaction: RequestDatabaseTransaction) => Promise<Result>,
  ): Promise<Result> => {
    const invocationTransaction = state.invocationTransaction;
    const boundRequest = state.boundRequest;
    if (
      state.activeMethod === undefined ||
      state.runtimeCallUsed ||
      invocationTransaction === undefined ||
      boundRequest === undefined
    )
      throw poison("TENANT_GOVERNANCE_METHOD_BOUNDARY_VIOLATION");

    const expectedFunction = identityFunctionForMethod[state.activeMethod];
    state.runtimeCallUsed = true;
    state.identityQueryUsed = false;

    try {
      await assertBoundHumanContext(invocationTransaction, boundRequest);
    } catch {
      throw poison("TENANT_GOVERNANCE_REQUEST_CONTEXT_UNAVAILABLE");
    }

    let identitySqlFailureObserved = false;
    let identitySqlFailure: unknown;
    try {
      return await invocationTransaction.withSavepoint(async identityTransactionScope => {
        await identityTransactionScope.query`set local role vortex_runtime`;

        const identityTransaction: RequestDatabaseTransaction = {
          query: async <ResultRow extends DatabaseRow>(
            strings: TemplateStringsArray,
            ...values: readonly DatabaseValue[]
          ) => {
            const statement = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();
            if (
              state.identityQueryUsed ||
              !statement.startsWith(`select * from ${expectedFunction}(`) ||
              !statement.endsWith(")") ||
              statement.includes(";")
            )
              throw poison("TENANT_GOVERNANCE_METHOD_BOUNDARY_VIOLATION");

            state.identityQueryUsed = true;
            try {
              return await identityTransactionScope.query<ResultRow>(strings, ...values);
            } catch (error) {
              identitySqlFailureObserved = true;
              identitySqlFailure = error;
              throw error;
            }
          },
        };

        const result = await operation(identityTransaction);
        if (!state.identityQueryUsed)
          throw poison("TENANT_GOVERNANCE_METHOD_BOUNDARY_VIOLATION");

        // Restore and verify the least-privileged request role before the exact-call child settles.
        await identityTransactionScope.query`set local role vortex_request`;
        await assertBoundHumanContext(identityTransactionScope, boundRequest);
        return result;
      });
    } catch (error) {
      try {
        // The native exact-call child has now settled. Its rollback must leave the parent request
        // role, actor context and trusted channel intact before a known SQL refusal is mapped.
        await assertBoundHumanContext(invocationTransaction, boundRequest);
      } catch {
        throw poison("TENANT_GOVERNANCE_SAVEPOINT_RECOVERY_FAILED");
      }

      if (state.poisonedTransaction !== undefined) throw state.poisonedTransaction;
      if (
        identitySqlFailureObserved &&
        error === identitySqlFailure &&
        isMappedIdentitySqlError(error)
      )
        throw error;

      // Do not let rollback, role restoration, boundary or unknown transport errors become the
      // Identity service's broad safe-refusal mapping. invoke() observes this poison and aborts.
      throw poison("TENANT_GOVERNANCE_SAVEPOINT_RECOVERY_FAILED");
    }
  };

  const service = createTenantGovernanceService({
    runtimeTransaction: runOneIdentityMethod,
  });

  const invoke = <Result>(
    method: TenantGovernanceMethod,
    session: IdentitySession,
    operation: () => Promise<Result>,
  ): Promise<Result> =>
    serialized(async () => {
      if (state.poisonedTransaction !== undefined) throw state.poisonedTransaction;
      const boundRequest = await readBoundHumanContext();
      const identity = identitySessionSchema.safeParse(session);
      if (!identity.success || identity.data.identityId !== boundRequest.context.identityId)
        throw failure("TENANT_GOVERNANCE_ACTOR_MISMATCH");

      state.activeMethod = method;
      state.runtimeCallUsed = false;
      state.identityQueryUsed = false;
      state.boundRequest = boundRequest;
      try {
        const result = await parentTransaction.withSavepoint(async invocationTransaction => {
          state.invocationTransaction = invocationTransaction;
          try {
            const methodResult = await operation();
            if (state.poisonedTransaction !== undefined) throw state.poisonedTransaction;
            if (!state.runtimeCallUsed && !isRefusedResult(methodResult))
              throw poison("TENANT_GOVERNANCE_METHOD_BOUNDARY_VIOLATION");
            if (isRefusedResult(methodResult)) {
              // This includes typed/parser refusals after SQL succeeded. Throwing inside the
              // invocation child forces all method effects to roll back before the refusal returns.
              throw new TypedMethodRefusalRollback(methodResult);
            }
            return methodResult;
          } finally {
            delete state.invocationTransaction;
          }
        });

        await assertBoundHumanContext(parentTransaction, boundRequest);
        return result;
      } catch (error) {
        if (error instanceof TypedMethodRefusalRollback) {
          try {
            // The error can reach here only after the native invocation child rolled back.
            await assertBoundHumanContext(parentTransaction, boundRequest);
          } catch {
            throw poison("TENANT_GOVERNANCE_SAVEPOINT_RECOVERY_FAILED");
          }
          return error.result as Result;
        }

        // Any other child settlement failure (including unknown transport/rollback outcomes)
        // poisons this parent so the durable callback/effect transaction cannot commit.
        throw poison("TENANT_GOVERNANCE_SAVEPOINT_RECOVERY_FAILED");
      } finally {
        delete state.activeMethod;
        delete state.invocationTransaction;
        delete state.boundRequest;
        state.runtimeCallUsed = false;
        state.identityQueryUsed = false;
      }
    });

  return Object.freeze({
    createOrganization: (
      session: IdentitySession,
      command: Parameters<typeof service.createOrganization>[1],
    ) =>
      invoke("createOrganization", session, () => service.createOrganization(session, command)),
    renameOrganization: (
      session: IdentitySession,
      command: Parameters<typeof service.renameOrganization>[1],
    ) =>
      invoke("renameOrganization", session, () => service.renameOrganization(session, command)),
    suspendOrganization: (
      session: IdentitySession,
      command: Parameters<typeof service.suspendOrganization>[1],
    ) =>
      invoke("suspendOrganization", session, () => service.suspendOrganization(session, command)),
    reactivateOrganization: (
      session: IdentitySession,
      command: Parameters<typeof service.reactivateOrganization>[1],
    ) =>
      invoke("reactivateOrganization", session, () =>
        service.reactivateOrganization(session, command),
      ),
  });
};
