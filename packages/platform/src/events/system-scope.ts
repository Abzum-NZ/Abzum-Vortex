import "server-only";
import { randomUUID } from "node:crypto";
import { sessionContextSchema, type SessionContext } from "../access/identity-access";
import {
  applicationRootIdSchema,
  actorIdSchema,
  revisionSchema,
  tenantIdSchema,
} from "../catalogue/identifiers";
import {
  withResolvedRequestTransaction,
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "../db/request-transaction";

export const inEventConsumerScope = async <Result>(
  organizationId: string,
  applicationRootId: string,
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
): Promise<Result> => {
  const scopes = await withRuntimeTransaction(
    (transaction) =>
      transaction.query<DatabaseRow>`
      select system_actor_id, tenant_id, access_version
      from vortex_access.resolve_event_consumer_scope(${organizationId}::uuid, ${applicationRootId}::uuid)
    `,
  );
  const scope = scopes[0];
  if (scopes.length !== 1 || scope === undefined)
    throw new Error("EVENT_CONSUMER_SCOPE_UNAVAILABLE");
  const now = Date.now();
  const context: SessionContext = sessionContextSchema.parse({
    callerKind: "system",
    tenantId: tenantIdSchema.parse(scope.tenant_id),
    organizationId,
    applicationRootId: applicationRootIdSchema.parse(applicationRootId),
    systemActorId: actorIdSchema.parse(scope.system_actor_id),
    sessionId: randomUUID(),
    authenticationStrength: "service",
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    accessVersion: revisionSchema.parse(Number(scope.access_version)),
    correlationId: randomUUID(),
  });
  return withResolvedRequestTransaction(
    async () => ({ context, channel: "system" as const, scope: undefined }),
    (transaction) => operation(transaction),
  );
};
