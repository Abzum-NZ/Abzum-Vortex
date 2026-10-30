import "server-only";

import { z } from "zod";
import { organizationIdSchema } from "../catalogue/identifiers";
import type { createHumanOrganizationRequestService } from "./human-organization-request";
import type { IdentitySession } from "./identity-access";

const historyRowSchema = z.object({
  backend_run_id: z.uuid(),
  flow_id: z.uuid(),
  origin_kind: z.enum(["backend_run", "event"]),
  source_key: z.string(),
  state: z.enum(["pending", "running", "succeeded", "refused", "failed"]),
  failure_code: z.string().nullable(),
  created_at: z.union([z.date(), z.string()]),
  finished_at: z.union([z.date(), z.string()]).nullable(),
});

type BackendRunHistoryEntry = Readonly<{
  backendRunId: string;
  flowId: string;
  origin: "backend_run" | "event";
  source: string;
  state: "pending" | "running" | "succeeded" | "refused" | "failed";
  failureCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}>;

type BackendRunHistoryResult =
  | Readonly<{ kind: "available"; runs: readonly BackendRunHistoryEntry[] }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : value);

/**
 * Reads the newest back-end runs of one application: flow, origin, source, state, failure code and
 * times, never outputs. The database function decides authority from the caller's own request
 * context (definition-draft management, as Studio requires to open the application).
 */
export const createBackendRunHistoryReader = (
  dependencies: Readonly<{ requests: ReturnType<typeof createHumanOrganizationRequestService> }>,
) => ({
  async read(
    session: IdentitySession,
    organizationId: string,
    applicationRootId: string,
    limit = 50,
  ): Promise<BackendRunHistoryResult> {
    const result = await dependencies.requests.run(
      session,
      { organizationId: organizationIdSchema.parse(organizationId) },
      async (transaction): Promise<readonly z.infer<typeof historyRowSchema>[]> => {
        const rows = await transaction.query`
          select * from vortex_platform.read_backend_run_history(
            ${applicationRootId}::uuid, ${limit}::integer
          )
        `;
        return rows.map((row) => historyRowSchema.parse(row));
      },
    );
    if (result.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
    if (result.kind !== "available") return { kind: "refused" };
    return {
      kind: "available",
      runs: result.value.map((row) => ({
        backendRunId: row.backend_run_id,
        flowId: row.flow_id,
        origin: row.origin_kind,
        source: row.source_key,
        state: row.state,
        failureCode: row.failure_code,
        createdAt: iso(row.created_at),
        finishedAt: row.finished_at === null ? null : iso(row.finished_at),
      })),
    };
  },
});
