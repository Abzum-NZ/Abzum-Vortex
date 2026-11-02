import "server-only";

import { z } from "zod";
import { organizationIdSchema } from "../catalogue/identifiers";
import type { createHumanOrganizationRequestService } from "./human-organization-request";
import type { IdentitySession } from "./identity-access";

const historyRowSchema = z.object({
  backend_run_id: z.uuid(),
  flow_id: z.uuid().nullable(),
  origin_kind: z.enum(["backend_run", "event"]),
  source_key: z.string(),
  state: z.enum(["pending", "running", "succeeded", "refused", "failed"]),
  failure_code: z.string().nullable(),
  created_at: z.union([z.date(), z.string()]),
  created_at_cursor: z.string(),
  finished_at: z.union([z.date(), z.string()]).nullable(),
});

type BackendRunHistoryEntry = Readonly<{
  backendRunId: string;
  /** Null on an occurrence refused before its subscribers could be listed. */
  flowId: string | null;
  origin: "backend_run" | "event";
  source: string;
  state: "pending" | "running" | "succeeded" | "refused" | "failed";
  failureCode: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Where a page that starts or ends at this run continues from. */
  cursor: BackendRunHistoryCursor;
}>;

/** The position of one run: its creation time as the database wrote it, and its identity. */
export type BackendRunHistoryCursor = Readonly<{ createdAt: string; runId: string }>;

/** Which page to read: the newest, or the one older or newer than a run already shown. */
export type BackendRunHistoryRequest =
  | Readonly<{ kind: "newest" }>
  | Readonly<{ kind: "older" | "newer"; cursor: BackendRunHistoryCursor }>;

type BackendRunHistoryResult =
  | Readonly<{
      kind: "available";
      runs: readonly BackendRunHistoryEntry[];
      /** Whether an older or a newer page exists. */
      hasOlder: boolean;
      hasNewer: boolean;
    }>
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
    request: BackendRunHistoryRequest = { kind: "newest" },
    pageSize = 40,
  ): Promise<BackendRunHistoryResult> {
    const direction = request.kind === "newer" ? "newer" : "older";
    const cursor = request.kind === "newest" ? undefined : request.cursor;
    const result = await dependencies.requests.run(
      session,
      { organizationId: organizationIdSchema.parse(organizationId) },
      async (transaction): Promise<readonly z.infer<typeof historyRowSchema>[]> => {
        const rows = await transaction.query`
          select * from vortex_platform.read_backend_run_history(
            ${applicationRootId}::uuid, ${pageSize}::integer,
            ${cursor?.createdAt ?? null}::timestamptz, ${cursor?.runId ?? null}::uuid,
            ${direction}::text
          )
        `;
        return rows.map((row) => historyRowSchema.parse(row));
      },
    );
    if (result.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
    if (result.kind !== "available") return { kind: "refused" };
    // The database returns one run more than the page, newest first: the extra is the farthest
    // one in the direction read, and it only says that a further page exists.
    const more = result.value.length > pageSize;
    const page =
      direction === "newer" ? result.value.slice(more ? 1 : 0) : result.value.slice(0, pageSize);
    return {
      kind: "available",
      hasOlder: direction === "newer" ? true : more,
      hasNewer: direction === "newer" ? more : cursor !== undefined,
      runs: page.map((row) => ({
        cursor: { createdAt: row.created_at_cursor, runId: row.backend_run_id },
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
