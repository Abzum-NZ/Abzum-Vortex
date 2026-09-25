import "server-only";

import {
  actorIdSchema,
  applicationRootIdSchema,
  correlationIdSchema,
  identityAuthorityIdSchema,
  identityIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  sessionContextSchema,
  sessionIdSchema,
  tenantIdSchema,
  workflowIdSchema,
  workflowRunIdSchema,
  type IdentityAuthorityId,
  type SessionContext,
} from "@vortex/contracts";
import {
  withResolvedRequestTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
  type ResolvedRequestContext,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";
import { z } from "zod";

/**
 * #663: one Access-resolved request transaction for a verified durable workflow
 * actor context.
 *
 * The Workflow service verifies the signed run/node/attempt envelope against the
 * retained run and hands this module a purpose-bound context. This module never
 * trusts it as authority. Inside one fresh short transaction it reloads current
 * authority from storage and only then installs a request context on the
 * `durable_workflow` channel:
 *
 * - `initiating_person`: the retained initiator's identity is re-resolved
 *   through the ordinary application change scope, and the account it yields
 *   must be exactly the retained account. A person whose account is suspended,
 *   closed, removed from the organisation or from the application refuses. The
 *   context carries no authentication evidence, so no recent-authentication or
 *   human-approval gate is ever satisfied by background work.
 * - `system_with_source_authority`: the effective system actor is the holder of
 *   the one active system actor grant for this exact operation, organisation,
 *   flow and application source, resolved by Access. No run-as label, engine
 *   signature or installation names or authorises it, and the initiating person
 *   of a system-run workflow is never installed as the actor.
 *
 * The installed context expires with the verified envelope. Any unavailable,
 * expired, mismatched or unauthorised step refuses without fallback.
 */

const purposeSchema = z
  .object({
    runId: workflowRunIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    workflowId: workflowIdSchema,
    operationKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  })
  .passthrough();

/**
 * The verified context as the Workflow service produces it. Only the fields
 * this module acts on are read; extra purpose fields are ignored, never trusted.
 */
export const verifiedDurableActorContextSchema = z
  .object({
    purpose: purposeSchema,
    policy: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("initiating_person"),
          initiator: z
            .object({
              organizationAccountId: organizationAccountIdSchema,
              identityId: identityIdSchema,
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("system_with_source_authority"),
          initiatorCorrelation: z
            .object({ organizationAccountId: organizationAccountIdSchema })
            .strict()
            .optional(),
        })
        .strict(),
    ]),
    correlationId: correlationIdSchema,
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type VerifiedDurableActorRequestContext = z.input<typeof verifiedDurableActorContextSchema>;

/** The actor a durable protected operation runs as, resolved from current authority. */
export type DurableActorRequestScope = Readonly<{
  tenantId: string;
  organizationId: string;
  applicationRootId: string;
  accessVersion: number;
  actor:
    | Readonly<{ kind: "organization_account"; organizationAccountId: string }>
    | Readonly<{ kind: "system"; systemActorId: string }>;
  /** Safe correlation of the person who started a system-run workflow; never an actor. */
  initiatorCorrelation?: Readonly<{ organizationAccountId: string }>;
}>;

export type DurableActorRequestResult<Result> =
  | Readonly<{ kind: "available"; value: Result }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type ResolvedRequestTransactionRunner = <Scope, Result>(
  resolve: (transaction: RuntimeDatabaseTransaction) => Promise<ResolvedRequestContext<Scope>>,
  operation: (transaction: RequestDatabaseTransaction, scope: Scope) => Promise<Result>,
) => Promise<Result>;

export type DurableActorRequestDependencies = Readonly<{
  /** The Identity Authority the runtime is configured for; used for a person's context only. */
  identityAuthorityId: IdentityAuthorityId;
  resolvedRequestTransaction?: ResolvedRequestTransactionRunner;
  clock?: () => Date;
}>;

/** The longest the installed request context lives, however long the envelope does. */
const maximumContextLifetimeMs = 5 * 60_000;

type PersonScopeRow = DatabaseRow & {
  tenant_id: unknown;
  organization_id: unknown;
  organization_account_id: unknown;
  application_root_id: unknown;
  access_version: unknown;
};

type SystemScopeRow = DatabaseRow & {
  system_actor_id: unknown;
  tenant_id: unknown;
  organization_id: unknown;
  application_root_id: unknown;
  access_version: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

class DurableActorRefusal extends Error {
  constructor() {
    super("DURABLE_ACTOR_REFUSED");
    this.name = "DurableActorRefusal";
  }
}

const single = <Row>(rows: readonly Row[]): Row => {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === undefined) throw new DurableActorRefusal();
  return row;
};

export const createDurableActorRequestService = (dependencies: DurableActorRequestDependencies) => {
  const configuredAuthority = identityAuthorityIdSchema.parse(dependencies.identityAuthorityId);
  const runTransaction = dependencies.resolvedRequestTransaction ?? withResolvedRequestTransaction;
  const clock = dependencies.clock ?? (() => new Date());

  return Object.freeze({
    /**
     * Runs one protected operation as the durable actor. `operation` receives the
     * request-role transaction and the resolved actor scope. It runs on the
     * `durable_workflow` channel with a context that expires with the envelope.
     */
    run: async <Result>(
      verifiedCandidate: VerifiedDurableActorRequestContext,
      operation: (
        transaction: RequestDatabaseTransaction,
        scope: DurableActorRequestScope,
      ) => Promise<Result>,
    ): Promise<DurableActorRequestResult<Result>> => {
      const verified = verifiedDurableActorContextSchema.safeParse(verifiedCandidate);
      if (!verified.success) return { kind: "unavailable" };
      const { purpose, policy, correlationId } = verified.data;

      const now = clock();
      const nowMs = now.valueOf();
      const envelopeExpiresAt = Date.parse(verified.data.expiresAt);
      const envelopeIssuedAt = Date.parse(verified.data.issuedAt);
      if (
        !Number.isFinite(nowMs) ||
        !Number.isFinite(envelopeExpiresAt) ||
        !Number.isFinite(envelopeIssuedAt) ||
        envelopeExpiresAt <= nowMs
      )
        return { kind: "unavailable" };
      const issuedAt = now.toISOString();
      const expiresAt = new Date(
        Math.min(envelopeExpiresAt, nowMs + maximumContextLifetimeMs),
      ).toISOString();

      try {
        const value = await runTransaction(
          async (transaction) => {
            if (policy.kind === "initiating_person") {
              const row = single(
                await transaction.query<PersonScopeRow>`
                  select *
                  from vortex_access.resolve_human_application_change_scope(
                    ${policy.initiator.identityId}::uuid,
                    ${purpose.organizationId}::uuid,
                    ${purpose.applicationRootId}::uuid
                  )
                `,
              );
              const account = organizationAccountIdSchema.parse(row.organization_account_id);
              const organizationId = organizationIdSchema.parse(row.organization_id);
              const applicationRootId = applicationRootIdSchema.parse(row.application_root_id);
              // The person the run was started by must still be exactly this account
              // in this organisation and application; anything else refuses.
              if (
                !sameId(account, policy.initiator.organizationAccountId) ||
                !sameId(organizationId, purpose.organizationId) ||
                !sameId(applicationRootId, purpose.applicationRootId)
              )
                throw new DurableActorRefusal();
              const accessVersion = revisionSchema.parse(revision(row.access_version));
              const context: SessionContext = sessionContextSchema.parse({
                callerKind: "human",
                identityAuthorityId: configuredAuthority,
                tenantId: tenantIdSchema.parse(row.tenant_id),
                organizationId,
                organizationAccountId: account,
                applicationRootId,
                identityId: policy.initiator.identityId,
                sessionId: sessionIdSchema.parse(purpose.runId),
                authenticationStrength: "single_factor",
                issuedAt,
                expiresAt,
                accessVersion,
                correlationId,
              });
              const scope: DurableActorRequestScope = {
                tenantId: context.tenantId,
                organizationId,
                applicationRootId,
                accessVersion,
                actor: { kind: "organization_account", organizationAccountId: account },
              };
              return { context, channel: "durable_workflow" as const, scope };
            }

            const row = single(
              await transaction.query<SystemScopeRow>`
                select *
                from vortex_access.resolve_durable_system_actor_scope(
                  ${purpose.organizationId}::uuid,
                  ${purpose.applicationRootId}::uuid,
                  ${purpose.workflowId}::uuid,
                  ${purpose.operationKey}::text
                )
              `,
            );
            const organizationId = organizationIdSchema.parse(row.organization_id);
            const applicationRootId = applicationRootIdSchema.parse(row.application_root_id);
            if (
              !sameId(organizationId, purpose.organizationId) ||
              !sameId(applicationRootId, purpose.applicationRootId)
            )
              throw new DurableActorRefusal();
            const systemActorId = actorIdSchema.parse(row.system_actor_id);
            const accessVersion = revisionSchema.parse(revision(row.access_version));
            const context: SessionContext = sessionContextSchema.parse({
              callerKind: "system",
              tenantId: tenantIdSchema.parse(row.tenant_id),
              organizationId,
              applicationRootId,
              systemActorId,
              sessionId: sessionIdSchema.parse(purpose.runId),
              authenticationStrength: "service",
              issuedAt,
              expiresAt,
              accessVersion,
              correlationId,
            });
            const scope: DurableActorRequestScope = {
              tenantId: context.tenantId,
              organizationId,
              applicationRootId,
              accessVersion,
              actor: { kind: "system", systemActorId },
              ...(policy.initiatorCorrelation === undefined
                ? {}
                : { initiatorCorrelation: policy.initiatorCorrelation }),
            };
            return { context, channel: "durable_workflow" as const, scope };
          },
          (transaction, scope) => operation(transaction, scope),
        );
        return { kind: "available", value };
      } catch (error) {
        const refused = error instanceof DurableActorRefusal || databaseCode(error) === "42501";
        return refused ? { kind: "unavailable" } : { kind: "temporarily_unavailable" };
      }
    },
  });
};
