import "server-only";

import { z } from "zod";
import { organizationIdSchema } from "../catalogue/identifiers";
import type { createHumanOrganizationRequestService } from "./human-organization-request";
import type { IdentitySession } from "./identity-access";
import { createBuilderAuthority, readBuilderApplicationOrigin } from "./builder-authority";
import type { BuilderTargetFactsReader } from "./builder-authority";
import type { PlatformPermissionSource } from "./platform-permissions";
import { BuilderAuthorityError, requireBuilderAuthority } from "../definition/builder-authority";

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

const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) return { isSystemApplication: false };
  const origin = await readBuilderApplicationOrigin(transaction, rootId);
  if (origin === undefined) throw new Error("BACKEND_RUN_HISTORY_APPLICATION_UNKNOWN");
  return { isSystemApplication: origin === "platform_system_application" };
};

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : value);

/**
 * Reads the newest back-end runs of one application: flow, origin, source, state, failure code and
 * times, never outputs. The same builder authority Studio uses to open the application gates it.
 */
export const createBackendRunHistoryReader = (
  dependencies: Readonly<{
    requests: ReturnType<typeof createHumanOrganizationRequestService>;
    permissions: PlatformPermissionSource;
  }>,
) => ({
  async read(
    session: IdentitySession,
    organizationId: string,
    applicationRootId: string,
    limit = 50,
  ): Promise<BackendRunHistoryResult> {
    let refused = false;
    const result = await dependencies.requests.run(
      session,
      { organizationId: organizationIdSchema.parse(organizationId) },
      async (transaction, scope): Promise<readonly z.infer<typeof historyRowSchema>[]> => {
        const authority = createBuilderAuthority({
          transaction,
          scope,
          targetFacts,
          permissions: dependencies.permissions,
        });
        try {
          await requireBuilderAuthority(authority, {
            kind: "draft_change",
            rootId: applicationRootId,
          });
        } catch (error) {
          if (error instanceof BuilderAuthorityError) {
            refused = true;
            return [];
          }
          throw error;
        }
        const rows = await transaction.query`
          select * from vortex_platform.read_backend_run_history(
            ${scope.organizationId}::uuid, ${applicationRootId}::uuid, ${limit}::integer
          )
        `;
        return rows.map((row) => historyRowSchema.parse(row));
      },
    );
    if (result.kind !== "available") return { kind: "temporarily_unavailable" };
    if (refused) return { kind: "refused" };
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
