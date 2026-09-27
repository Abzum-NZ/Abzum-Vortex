import "server-only";

import { workflowRunIdSchema, type WorkflowExecutionReference } from "@vortex/contracts";
import { withRuntimeTransaction, type DatabaseRow } from "@vortex/db";
import { z } from "zod";
import {
  protectedNodeRunRecordSchema,
  type ProtectedNodeRunRecord,
  type ProtectedNodeRunStore,
  type ProtectedNodeEffectLedger,
} from "./protected-node-execution";

type RunRecordRow = DatabaseRow & { readonly run_record: unknown };
type RunWriteRow = DatabaseRow & { readonly written: unknown };
type RunRefreshRow = DatabaseRow & { readonly refreshed: unknown };

const objectResult = z.object({ written: z.boolean() });
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

/**
 * The private retained-run store for #664. The writer is exposed for the #666
 * start path to call after Kestra accepts one exact run mapping; callbacks only
 * receive the reader and the safe status cache operation.
 */
export const createDatabaseProtectedNodeRunStore = (): ProtectedNodeRunStore =>
  Object.freeze({
    async write(candidate: unknown): Promise<boolean> {
      const parsed = protectedNodeRunRecordSchema.safeParse(candidate);
      if (!parsed.success) return false;
      const record: ProtectedNodeRunRecord = parsed.data;
      const identityId =
        record.authority.runAs === "initiating_person"
          ? (record.authority.initiator?.identityId ?? null)
          : null;
      const rows = await withRuntimeTransaction((transaction) =>
        transaction.query<RunWriteRow>`
          select vortex_workflow.write_protected_workflow_run(
            ${record.authority.runId}::uuid,
            ${record.authority.organizationId}::uuid,
            ${identityId}::uuid,
            ${asJson(record)}::text::jsonb
          ) as written
        `,
      );
      const row = rows.length === 1 ? objectResult.safeParse({ written: rows[0]?.written }) : undefined;
      return row?.success === true && row.data.written;
    },

    async read(runId: string): Promise<unknown | undefined> {
      const parsedRunId = workflowRunIdSchema.safeParse(runId);
      if (!parsedRunId.success) return undefined;
      const rows = await withRuntimeTransaction((transaction) =>
        transaction.query<RunRecordRow>`
          select vortex_workflow.read_protected_workflow_run(
            ${parsedRunId.data}::uuid
          ) as run_record
        `,
      );
      if (rows.length !== 1) return undefined;
      const row = rows[0];
      return row?.run_record === null ? undefined : row?.run_record;
    },

    async refreshLastKnownState(
      runId: string,
      state: WorkflowExecutionReference["lastKnownState"],
      refreshedAt: string,
    ): Promise<void> {
      const parsedRunId = workflowRunIdSchema.safeParse(runId);
      const parsedState = z
        .enum(["queued", "running", "waiting", "completed", "cancelled", "failed"])
        .safeParse(state);
      const parsedAt = z.iso.datetime({ offset: true }).safeParse(refreshedAt);
      if (!parsedRunId.success || !parsedState.success || !parsedAt.success) return;
      const rows = await withRuntimeTransaction((transaction) =>
        transaction.query<RunRefreshRow>`
          select vortex_workflow.refresh_protected_workflow_run_state(
            ${parsedRunId.data}::uuid,
            ${parsedState.data}::text,
            ${parsedAt.data}::timestamptz
          ) as refreshed
        `,
      );
      const row = rows.length === 1 ? refreshResult.safeParse({ refreshed: rows[0]?.refreshed }) : undefined;
      if (row?.success !== true || !row.data.refreshed) return;
    },
  });

/** The callback ledger runs on the durable actor's owning request transaction. */
export const createDatabaseProtectedNodeEffectLedger = (): ProtectedNodeEffectLedger =>
  Object.freeze({
    async replay(key, operationKey) {
      const rows = await withRuntimeTransaction((transaction) =>
        transaction.query<DatabaseRow & { result: unknown }>`
          select vortex_workflow.read_protected_node_effect(
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
    },
    async begin(transaction, key, operationKey) {
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
    },
    async complete(transaction, key, outcome, outputs) {
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
    },
  });
