import "server-only";

import { withRuntimeTransaction } from "@vortex/db";
import { z } from "zod";

/**
 * The server-side storage behind the flow orchestrator: suspended run state (a continuation) and
 * the effect ledger. Both are reached only through the private definer functions of migration
 * `20260925180000_flow_continuations.sql`, which bind every row to its run, initiator, organisation
 * and exact flow release, expire continuations, and hand a continuation back once.
 *
 * The orchestrator depends on the two small ports below, never on the database, so the run logic
 * has no storage of its own. The token the page holds is random and unguessable and only its hash
 * is stored, but it is never the only guard: the row is bound to the initiator, organisation and
 * release, and consuming it is one atomic single-use step in the database.
 */

export type FlowContinuationBinding = Readonly<{
  organizationId: string;
  identityId: string;
  flowId: string;
  /** The exact release of the flow set the run is bound to. */
  releaseKey: string;
}>;

export type FlowContinuationStore = Readonly<{
  /** Stores the run state under the hash of a fresh token; false when it could not be stored. */
  issue: (
    input: FlowContinuationBinding &
      Readonly<{
        tokenHash: string;
        runId: string;
        state: Readonly<Record<string, unknown>>;
        elapsedMilliseconds: number;
        lifetimeSeconds: number;
      }>,
  ) => Promise<Readonly<{ expiresAt: string }> | undefined>;
  /**
   * Returns the stored run once. Unknown, expired, already used, foreign and wrong-release tokens
   * are all `undefined`.
   */
  consume: (
    input: FlowContinuationBinding & Readonly<{ tokenHash: string }>,
  ) => Promise<
    | Readonly<{ runId: string; state: unknown; elapsedMilliseconds: number }>
    | undefined
  >;
}>;

export type FlowEffectKey = Readonly<{
  runId: string;
  organizationId: string;
  identityId: string;
  taskPath: string;
  iteration: string;
}>;

export type FlowEffectClaim =
  | Readonly<{ kind: "claimed" }>
  | Readonly<{ kind: "completed"; outcome: string; outputs: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "in_progress" }>
  | Readonly<{ kind: "unavailable" }>;

/** Duplicate protection for protected effects: (run id, task path, iteration). */
export type FlowEffectLedger = Readonly<{
  begin: (key: FlowEffectKey) => Promise<FlowEffectClaim>;
  complete: (
    key: FlowEffectKey,
    outcome: string,
    outputs: Readonly<Record<string, unknown>>,
  ) => Promise<boolean>;
}>;

const expiryRowSchema = z.object({ expires_at: z.union([z.date(), z.string()]) });
const consumeRowSchema = z.object({ result: z.unknown() });
const consumeResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable") }),
  z.object({
    kind: z.literal("available"),
    runId: z.uuid(),
    state: z.record(z.string(), z.unknown()),
    elapsedMilliseconds: z.number().int().min(0),
  }),
]);
const claimResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claimed") }),
  z.object({
    kind: z.literal("completed"),
    outcome: z.string(),
    outputs: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal("in_progress") }),
  z.object({ kind: z.literal("unavailable") }),
]);
const claimRowSchema = z.object({ result: z.unknown() });
const completionRowSchema = z.object({ completed: z.boolean() });

const asJson = (value: unknown): string => JSON.stringify(value);

/** The database-backed continuation store and effect ledger. */
export const createDatabaseFlowStores = (): Readonly<{
  continuations: FlowContinuationStore;
  ledger: FlowEffectLedger;
}> =>
  Object.freeze({
    continuations: Object.freeze({
      async issue(input) {
        const rows = await withRuntimeTransaction((transaction) =>
          transaction.query`
            select vortex_workflow.issue_flow_continuation(
              ${input.tokenHash}::text,
              ${input.runId}::uuid,
              ${input.organizationId}::uuid,
              ${input.identityId}::uuid,
              ${input.flowId}::uuid,
              ${input.releaseKey}::text,
              ${asJson(input.state)}::text::jsonb,
              ${input.elapsedMilliseconds}::integer,
              ${input.lifetimeSeconds}::integer
            ) as expires_at
          `,
        );
        const row = expiryRowSchema.safeParse(rows[0]);
        if (rows.length !== 1 || !row.success) return undefined;
        const expiresAt =
          row.data.expires_at instanceof Date
            ? row.data.expires_at.toISOString()
            : row.data.expires_at;
        return { expiresAt };
      },
      async consume(input) {
        const rows = await withRuntimeTransaction((transaction) =>
          transaction.query`
            select vortex_workflow.consume_flow_continuation(
              ${input.tokenHash}::text,
              ${input.organizationId}::uuid,
              ${input.identityId}::uuid,
              ${input.flowId}::uuid,
              ${input.releaseKey}::text
            ) as result
          `,
        );
        const row = consumeRowSchema.safeParse(rows[0]);
        if (rows.length !== 1 || !row.success) return undefined;
        const result = consumeResultSchema.safeParse(row.data.result);
        if (!result.success || result.data.kind !== "available") return undefined;
        return {
          runId: result.data.runId,
          state: result.data.state,
          elapsedMilliseconds: result.data.elapsedMilliseconds,
        };
      },
    }),
    ledger: Object.freeze({
      async begin(key) {
        const rows = await withRuntimeTransaction((transaction) =>
          transaction.query`
            select vortex_workflow.begin_flow_effect(
              ${key.runId}::uuid,
              ${key.organizationId}::uuid,
              ${key.identityId}::uuid,
              ${key.taskPath}::text,
              ${key.iteration}::text
            ) as result
          `,
        );
        const row = claimRowSchema.safeParse(rows[0]);
        if (rows.length !== 1 || !row.success) return { kind: "unavailable" };
        const claim = claimResultSchema.safeParse(row.data.result);
        return claim.success ? claim.data : { kind: "unavailable" };
      },
      async complete(key, outcome, outputs) {
        const rows = await withRuntimeTransaction((transaction) =>
          transaction.query`
            select vortex_workflow.complete_flow_effect(
              ${key.runId}::uuid,
              ${key.organizationId}::uuid,
              ${key.identityId}::uuid,
              ${key.taskPath}::text,
              ${key.iteration}::text,
              ${outcome}::text,
              ${asJson(outputs)}::text::jsonb
            ) as completed
          `,
        );
        const row = completionRowSchema.safeParse(rows[0]);
        return rows.length === 1 && row.success && row.data.completed;
      },
    }),
  });
