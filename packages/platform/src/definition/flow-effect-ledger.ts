import "server-only";

import type { FlowTriggerOrigin } from "../workflows/flow-contracts";
import { withRuntimeTransaction } from "../db/request-transaction";
import { z } from "zod";

/**
 * The effect ledger of flow runs: each protected effect is claimed once per run, task and
 * iteration, through private definer functions that bind every row to its run, principal and
 * organisation, so a retried request replays the recorded outcome instead of repeating the effect.
 */

/** A person, or the organisation account a back-end run acts as (recorded as the system principal). */
export type FlowEffectPrincipal = Readonly<{ kind: "person" | "system"; id: string }>;

type FlowEffectKey = Readonly<{
  runId: string;
  organizationId: string;
  principal: FlowEffectPrincipal;
  origin: FlowTriggerOrigin;
  originId: string;
  taskPath: string;
  iteration: string;
}>;

type FlowEffectClaim =
  | Readonly<{ kind: "claimed" }>
  | Readonly<{ kind: "completed"; outcome: string; outputs: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "in_progress" }>
  | Readonly<{ kind: "unavailable" }>;

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

/** Claims one run/task/iteration effect for its verified principal and trigger, once. */
export const beginFlowEffect = async (key: FlowEffectKey): Promise<FlowEffectClaim> => {
  const rows = await withRuntimeTransaction(
    (transaction) =>
      transaction.query`
      select vortex_platform.begin_flow_effect(
        ${key.runId}::uuid,
        ${key.organizationId}::uuid,
        ${key.principal.kind}::text,
        ${key.principal.id}::uuid,
        ${key.origin}::text,
        ${key.originId}::uuid,
        ${key.taskPath}::text,
        ${key.iteration}::text
      ) as result
    `,
  );
  const row = claimRowSchema.safeParse(rows[0]);
  if (rows.length !== 1 || !row.success) return { kind: "unavailable" };
  const claim = claimResultSchema.safeParse(row.data.result);
  return claim.success ? claim.data : { kind: "unavailable" };
};

/** Records the outcome of a claimed effect; false when it could not be recorded. */
export const completeFlowEffect = async (
  key: FlowEffectKey,
  outcome: string,
  outputs: Readonly<Record<string, unknown>>,
): Promise<boolean> => {
  const rows = await withRuntimeTransaction(
    (transaction) =>
      transaction.query`
      select vortex_platform.complete_flow_effect(
        ${key.runId}::uuid,
        ${key.organizationId}::uuid,
        ${key.principal.kind}::text,
        ${key.principal.id}::uuid,
        ${key.origin}::text,
        ${key.originId}::uuid,
        ${key.taskPath}::text,
        ${key.iteration}::text,
        ${outcome}::text,
        ${JSON.stringify(outputs)}::text::jsonb
      ) as completed
    `,
  );
  const row = completionRowSchema.safeParse(rows[0]);
  return rows.length === 1 && row.success && row.data.completed;
};
