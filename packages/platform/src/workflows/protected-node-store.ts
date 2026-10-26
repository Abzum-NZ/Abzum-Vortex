import "server-only";

import { workflowRunIdSchema } from "../catalogue/identifiers";
import type { WorkflowExecutionReference } from "../rules/automation-contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "../db/request-transaction";
import { z } from "zod";
import {
  protectedNodeRegisteredRunSchema,
  type ProtectedNodeRegisteredRun,
  type ProtectedNodeEffectClaim,
  type ProtectedNodeEffectKey,
  type ProtectedNodeEffectReplay,
  ProtectedNodeRunStoreError,
} from "./protected-node-execution";

type RunRecordRow = DatabaseRow & { readonly run_record: unknown };
type RunRefreshRow = DatabaseRow & { readonly refreshed: unknown };

const refreshResult = z.object({ refreshed: z.boolean() });
const effectClaimResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claimed") }),
  z.object({ kind: z.literal("completed"), outcome: z.string(), outputs: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("in_progress") }),
  z.object({ kind: z.literal("unavailable") }),
]);
const effectReplayResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }),
  z.object({ kind: z.literal("completed"), outcome: z.string(), outputs: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("in_progress") }),
  z.object({ kind: z.literal("unavailable") }),
]);
const asJson = (value: unknown): string => JSON.stringify(value);

/*
 * The private retained-run store and callback effect ledger. Kestra identifiers remain private to
 * this server-side store.
 */

/** Reads one retained run with its exact registration and release proof. */
export const readProtectedNodeRun = async (
  runId: string,
): Promise<ProtectedNodeRegisteredRun | undefined> => {
  const parsedRunId = workflowRunIdSchema.safeParse(runId);
  if (!parsedRunId.success) return undefined;
  const rows = await withRuntimeTransaction((transaction) =>
    transaction.query<RunRecordRow>`
      select vortex_platform.read_protected_workflow_run_registration(
        ${parsedRunId.data}::uuid
      ) as run_record
    `,
  );
  if (rows.length !== 1)
    throw new ProtectedNodeRunStoreError("PROTECTED_WORKFLOW_RUN_ROW_COUNT_INVALID", {
      cause: new Error("PROTECTED_WORKFLOW_RUN_ROW_COUNT_INVALID"),
    });
  const row = rows[0];
  if (row === undefined || row.run_record === undefined)
    throw new ProtectedNodeRunStoreError("PROTECTED_WORKFLOW_RUN_VALUE_MISSING", {
      cause: new Error("PROTECTED_WORKFLOW_RUN_VALUE_MISSING"),
    });
  if (row.run_record === null) return undefined;
  const registeredRun = protectedNodeRegisteredRunSchema.safeParse(row.run_record);
  if (!registeredRun.success)
    throw new ProtectedNodeRunStoreError("PROTECTED_WORKFLOW_RUN_MALFORMED", {
      cause: registeredRun.error,
    });
  if (registeredRun.data.runRecord.authority.runId.toLowerCase() !== parsedRunId.data.toLowerCase())
    throw new ProtectedNodeRunStoreError("PROTECTED_WORKFLOW_RUN_IDENTITY_MISMATCH", {
      cause: new Error("PROTECTED_WORKFLOW_RUN_IDENTITY_MISMATCH"),
    });
  return registeredRun.data;
};

/** Caches the safe last known state of one run. */
export const refreshProtectedNodeRunState = async (
  runId: string,
  state: WorkflowExecutionReference["lastKnownState"],
  refreshedAt: string,
): Promise<void> => {
  const parsedRunId = workflowRunIdSchema.safeParse(runId);
  const parsedState = z
    .enum(["queued", "running", "waiting", "completed", "cancelled", "failed"])
    .safeParse(state);
  const parsedAt = z.iso.datetime({ offset: true }).safeParse(refreshedAt);
  if (!parsedRunId.success || !parsedState.success || !parsedAt.success) return;
  const rows = await withRuntimeTransaction((transaction) =>
    transaction.query<RunRefreshRow>`
      select vortex_platform.refresh_protected_workflow_run_state(
        ${parsedRunId.data}::uuid,
        ${parsedState.data}::text,
        ${parsedAt.data}::timestamptz
      ) as refreshed
    `,
  );
  if (rows.length !== 1 || rows[0] === undefined)
    throw new ProtectedNodeRunStoreError("PROTECTED_WORKFLOW_RUN_REFRESH_ROW_INVALID", {
      cause: new Error("PROTECTED_WORKFLOW_RUN_REFRESH_ROW_INVALID"),
    });
  const row = refreshResult.safeParse({ refreshed: rows[0].refreshed });
  if (!row.success)
    throw new ProtectedNodeRunStoreError("PROTECTED_WORKFLOW_RUN_REFRESH_RESULT_MALFORMED", {
      cause: row.error,
    });
};

/** Replays one committed callback effect, outside the owning transaction. */
export const replayProtectedNodeEffect = async (
  key: ProtectedNodeEffectKey,
  operationKey: string,
): Promise<ProtectedNodeEffectReplay> => {
  const rows = await withRuntimeTransaction((transaction) =>
    transaction.query<DatabaseRow & { result: unknown }>`
      select vortex_platform.read_protected_node_effect(
        ${key.runId}::uuid,
        ${key.organizationId}::uuid,
        ${key.identityId}::uuid,
        ${key.taskPath}::text,
        ${key.iteration}::text,
        ${operationKey}::text
      ) as result
    `,
  );
  const result = rows.length === 1 ? effectReplayResult.safeParse(rows[0]?.result) : undefined;
  return result?.success === true ? result.data : { kind: "unavailable" as const };
};

/** Claims one callback effect on the durable actor's owning request transaction. */
export const beginProtectedNodeEffect = async (
  transaction: RequestDatabaseTransaction,
  key: ProtectedNodeEffectKey,
  operationKey: string,
): Promise<ProtectedNodeEffectClaim> => {
  const rows = await transaction.query<DatabaseRow & { result: unknown }>`
    select vortex_access.begin_protected_node_effect(
      ${key.runId}::uuid,
      ${key.organizationId}::uuid,
      ${key.identityId}::uuid,
      ${key.taskPath}::text,
      ${key.iteration}::text,
      ${operationKey}::text
    ) as result
  `;
  const result = rows.length === 1 ? effectClaimResult.safeParse(rows[0]?.result) : undefined;
  return result?.success === true ? result.data : { kind: "unavailable" as const };
};

/** Records a claimed callback effect's outcome on the same owning transaction. */
export const completeProtectedNodeEffect = async (
  transaction: RequestDatabaseTransaction,
  key: ProtectedNodeEffectKey,
  outcome: string,
  outputs: Readonly<Record<string, unknown>>,
): Promise<boolean> => {
  const rows = await transaction.query<DatabaseRow & { completed: unknown }>`
    select vortex_access.complete_protected_node_effect(
      ${key.runId}::uuid,
      ${key.organizationId}::uuid,
      ${key.identityId}::uuid,
      ${key.taskPath}::text,
      ${key.iteration}::text,
      ${outcome}::text,
      ${asJson(outputs)}::text::jsonb
    ) as completed
  `;
  return rows.length === 1 && rows[0]?.completed === true;
};
