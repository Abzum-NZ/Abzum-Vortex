import { z } from "zod";
import { containedComponentIdSchema } from "./identifiers";

/**
 * One home for the run-as vocabularies that stored definitions and their
 * consumers read, together with the mapping each of them has to the single
 * canonical flow run-as vocabulary defined by `flowRunAsSchema` in
 * `flow-contracts.ts` (`initiator`, `saver`, `specified_account`, `system`).
 *
 * These schemas keep their values exactly as stored, so existing definitions,
 * compiled releases and consumers keep the same meaning. Conversion onto the
 * canonical flow vocabulary belongs to #1086 (move background workflows onto
 * the flow contract); this module exists so no vocabulary is duplicated or
 * drifts before that conversion.
 *
 * Canonical mapping:
 * - `initiating_person` (node-and-edge workflow) -> `initiator`
 * - `triggering_account` (authored workflow) -> `initiator`
 * - `current_user` (frontend-flow node) -> `initiator`
 * - `specified_user` (frontend-flow node) -> `specified_account`
 * - `system_with_source_authority` (workflow and authored workflow) -> `system`
 * - `system` (frontend-flow node) -> `system`
 * - `saver` is canonical-only: a transaction flow runs under the actor of the
 *   save or named action that owns the transaction.
 */

/** The node-and-edge workflow run-as vocabulary (`automation-contracts.ts`). */
export const workflowRunAsSchema = z.enum(["initiating_person", "system_with_source_authority"]);
export type WorkflowRunAs = z.infer<typeof workflowRunAsSchema>;

/** The authored workflow run-as vocabulary (`application-source-contracts.ts`). */
export const sourceWorkflowRunAsSchema = z.enum([
  "triggering_account",
  "system_with_source_authority",
]);
export type SourceWorkflowRunAs = z.infer<typeof sourceWorkflowRunAsSchema>;

/**
 * The frontend-flow node run-as vocabulary (`application-flow-bindings.ts`):
 * `current_user` always means the original verified initiator, never the actor
 * of the preceding overridden node. The other modes name Access-owned
 * execution bindings.
 */
export const flowNodeRunAsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current_user") }).strict(),
  z
    .object({
      kind: z.literal("specified_user"),
      executionBindingId: containedComponentIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("system"), executionBindingId: containedComponentIdSchema }).strict(),
]);
export type FlowNodeRunAs = z.infer<typeof flowNodeRunAsSchema>;
