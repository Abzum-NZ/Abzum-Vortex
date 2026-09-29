import "server-only";

import {
  identitySessionSchema,
  selectedOrganizationScopeSchema,
  sessionContextSchema,
  type IdentitySession,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
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
  request_context: unknown;
};

type TransactionInvocationState = {
  queue: Promise<void>;
  activeMethod?: TenantGovernanceMethod;
  runtimeCallUsed: boolean;
  identityQueryUsed: boolean;
  savepointActive: boolean;
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
    savepointActive: false,
  };
  invocationStates.set(transaction, created);
  return created;
};

const failure = (code: string) => new Error(code);

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
  const state = invocationStateFor(transaction);

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

  const readBoundHumanContext = async () => {
    const rows = await transaction.query<BoundRequestRow>`
      select
        current_user::text as current_role,
        session_user::text as session_role,
        pg_catalog.pg_has_role(session_user, 'vortex_runtime', 'SET') as can_set_runtime,
        vortex_context.current_context() as request_context
    `;
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined) throw failure("TENANT_GOVERNANCE_REQUEST_CONTEXT_UNAVAILABLE");
    const context = sessionContextSchema.safeParse(row.request_context);
    if (
      row.current_role !== "vortex_request" ||
      !isRuntimeSessionRole(row.session_role) ||
      row.can_set_runtime !== true ||
      !context.success
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
    return resolved;
  };

  const rollbackInvocationSavepoint = async (): Promise<void> => {
    await transaction.query`rollback to savepoint tenant_governance_request_bound`;
    const rows = await transaction.query<DatabaseRow & { current_role: unknown }>`
      select current_user::text as current_role
    `;
    if (rows.length !== 1 || rows[0]?.current_role !== "vortex_request")
      throw failure("TENANT_GOVERNANCE_ROLE_RECOVERY_FAILED");
  };

  const releaseInvocationSavepoint = async (): Promise<void> => {
    await transaction.query`release savepoint tenant_governance_request_bound`;
    state.savepointActive = false;
  };

  const isRefusedResult = (result: unknown): boolean =>
    typeof result === "object" &&
    result !== null &&
    "outcome" in result &&
    result.outcome === "refused";

  const runOneIdentityMethod = async <Result>(
    operation: (requestTransaction: RequestDatabaseTransaction) => Promise<Result>,
  ): Promise<Result> => {
    if (state.activeMethod === undefined || state.runtimeCallUsed || !state.savepointActive) {
      state.poisonedTransaction = failure("TENANT_GOVERNANCE_METHOD_BOUNDARY_VIOLATION");
      throw state.poisonedTransaction;
    }
    const expectedFunction = identityFunctionForMethod[state.activeMethod];
    state.runtimeCallUsed = true;
    state.identityQueryUsed = false;

    try {
      await readBoundHumanContext();
    } catch {
      state.poisonedTransaction = failure("TENANT_GOVERNANCE_REQUEST_CONTEXT_UNAVAILABLE");
      throw state.poisonedTransaction;
    }

    try {
      await transaction.query`set local role vortex_runtime`;
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
          ) {
            state.poisonedTransaction = failure("TENANT_GOVERNANCE_METHOD_BOUNDARY_VIOLATION");
            throw state.poisonedTransaction;
          }
          state.identityQueryUsed = true;
          return transaction.query<ResultRow>(strings, ...values);
        },
      };
      const result = await operation(identityTransaction);
      if (!state.identityQueryUsed) {
        state.poisonedTransaction = failure("TENANT_GOVERNANCE_METHOD_BOUNDARY_VIOLATION");
        throw state.poisonedTransaction;
      }

      try {
        await transaction.query`set local role vortex_request`;
        const rows = await transaction.query<DatabaseRow & { current_role: unknown }>`
          select current_user::text as current_role
        `;
        if (rows.length !== 1 || rows[0]?.current_role !== "vortex_request")
          throw failure("TENANT_GOVERNANCE_ROLE_RESTORE_FAILED");
      } catch (error) {
        state.poisonedTransaction = failure("TENANT_GOVERNANCE_ROLE_RESTORE_FAILED");
        throw error;
      }

      return result;
    } catch (error) {
      try {
        await rollbackInvocationSavepoint();
      } catch {
        state.poisonedTransaction = failure("TENANT_GOVERNANCE_SAVEPOINT_RECOVERY_FAILED");
        throw state.poisonedTransaction;
      }
      if (state.poisonedTransaction !== undefined) throw state.poisonedTransaction;
      throw error;
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
      const context = await readBoundHumanContext();
      const identity = identitySessionSchema.safeParse(session);
      if (!identity.success || identity.data.identityId !== context.identityId)
        throw failure("TENANT_GOVERNANCE_ACTOR_MISMATCH");

      state.activeMethod = method;
      state.runtimeCallUsed = false;
      state.identityQueryUsed = false;
      try {
        await transaction.query`savepoint tenant_governance_request_bound`;
        state.savepointActive = true;
      } catch {
        state.poisonedTransaction = failure("TENANT_GOVERNANCE_SAVEPOINT_CREATE_FAILED");
        throw state.poisonedTransaction;
      }
      try {
        const result = await operation();
        if (state.poisonedTransaction !== undefined) throw state.poisonedTransaction;
        if (!state.runtimeCallUsed && !isRefusedResult(result)) {
          state.poisonedTransaction = failure("TENANT_GOVERNANCE_METHOD_BOUNDARY_VIOLATION");
          throw state.poisonedTransaction;
        }
        if (isRefusedResult(result)) await rollbackInvocationSavepoint();
        try {
          await releaseInvocationSavepoint();
        } catch {
          state.poisonedTransaction = failure("TENANT_GOVERNANCE_SAVEPOINT_RELEASE_FAILED");
          throw state.poisonedTransaction;
        }
        return result;
      } catch (error) {
        if (state.savepointActive) {
          try {
            await rollbackInvocationSavepoint();
            await releaseInvocationSavepoint();
          } catch {
            state.poisonedTransaction = failure("TENANT_GOVERNANCE_SAVEPOINT_RECOVERY_FAILED");
          }
        }
        if (state.poisonedTransaction !== undefined) throw state.poisonedTransaction;
        throw error;
      } finally {
        state.activeMethod = undefined;
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
