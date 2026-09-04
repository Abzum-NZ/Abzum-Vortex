import "server-only";

import type { SessionContext } from "@vortex/contracts";
import {
  withRequestTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "@vortex/db";
import type { DefinitionHistoryRepository } from "./definition-history";

type DefinitionTransactionRunner = <Result>(
  context: SessionContext,
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

type HistoryRow = DatabaseRow & { release_history: unknown };
type MetadataRow = DatabaseRow & { release_history_entry: unknown };
type RestoreEvidenceRow = DatabaseRow & { restore_evidence: unknown };
type RestoredDraftRow = DatabaseRow & { restored_draft: unknown };

const one = <Row extends DatabaseRow>(rows: readonly Row[], message: string): Row => {
  if (rows.length !== 1) throw new Error(message);
  return rows[0]!;
};

/**
 * All restore reads and the conditional mutation share one request transaction.
 * The verification callback receives evidence only inside that transaction and
 * returns service-derived data that the database checks against its release row.
 */
export const createDatabaseDefinitionHistoryRepository = (
  runInTransaction: DefinitionTransactionRunner = withRequestTransaction,
): DefinitionHistoryRepository => ({
  async list(context, command) {
    return runInTransaction(context, async (transaction) => {
      const rows = await transaction.query<HistoryRow>`
        select vortex_definition.list_release_history(
          ${command.kind},
          ${command.rootId},
          ${command.pageSize},
          ${command.beforeReleaseRevision ?? null}
        ) as release_history
      `;
      const row = one(rows, "DEFINITION_HISTORY_STORAGE_INVALID");
      return row.release_history === null ? undefined : row.release_history;
    });
  },

  async readMetadata(context, command) {
    return runInTransaction(context, async (transaction) => {
      const rows = await transaction.query<MetadataRow>`
        select vortex_definition.read_release_history_entry(
          ${command.kind},
          ${command.rootId},
          ${command.releaseRevision}
        ) as release_history_entry
      `;
      const row = one(rows, "DEFINITION_HISTORY_STORAGE_INVALID");
      return row.release_history_entry === null ? undefined : row.release_history_entry;
    });
  },

  async restore(context, command, verify) {
    return runInTransaction(context, async (transaction) => {
      const evidenceRows = await transaction.query<RestoreEvidenceRow>`
        select vortex_definition.read_restore_release_evidence(
          ${command.kind},
          ${command.rootId},
          ${command.targetReleaseRevision}
        ) as restore_evidence
      `;
      const evidence = one(evidenceRows, "DEFINITION_RESTORE_STORAGE_INVALID").restore_evidence;
      if (evidence === null) return { outcome: "not_found" } as const;
      const verified = await verify(evidence);
      const restoredRows = await transaction.query<RestoredDraftRow>`
        select vortex_definition.restore_release_draft(
          ${command.kind},
          ${command.rootId},
          ${command.targetReleaseRevision},
          ${command.expectedDraftRevision},
          ${verified.sourceFingerprint},
          ${JSON.stringify(verified.identityRequirements)}
        ) as restored_draft
      `;
      const restored = one(restoredRows, "DEFINITION_RESTORE_STORAGE_INVALID").restored_draft;
      return restored === null
        ? ({ outcome: "stale" } as const)
        : ({ outcome: "restored", draft: restored } as const);
    });
  },
});
