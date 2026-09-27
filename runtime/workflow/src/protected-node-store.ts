import "server-only";

import { workflowRunIdSchema, type WorkflowExecutionReference } from "@vortex/contracts";
import { withRuntimeTransaction, type DatabaseRow } from "@vortex/db";
import { z } from "zod";
import {
  protectedNodeRunRecordSchema,
  type ProtectedNodeRunRecord,
  type ProtectedNodeRunStore,
} from "./protected-node-execution";

type RunRecordRow = DatabaseRow & { readonly run_record: unknown };
type RunWriteRow = DatabaseRow & { readonly written: unknown };
type RunRefreshRow = DatabaseRow & { readonly refreshed: unknown };

const objectResult = z.object({ written: z.boolean() });
const refreshResult = z.object({ refreshed: z.boolean() });
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
