import "server-only";

import type { DefinitionConsumerReadCommand, SessionContext } from "@vortex/contracts";
import {
  withRequestTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "@vortex/db";
import type { DefinitionConsumerReadRepository } from "./definition-consumer-read";

type DefinitionTransactionRunner = <Result>(
  context: SessionContext,
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

type ConsumerReleaseRow = DatabaseRow & { consumer_release: unknown };

export const createDatabaseDefinitionConsumerReadRepository = (
  runInTransaction: DefinitionTransactionRunner = withRequestTransaction,
): DefinitionConsumerReadRepository => ({
  async read(context: SessionContext, command: DefinitionConsumerReadCommand) {
    return runInTransaction(context, async (transaction) => {
      const revision =
        command.selector.selection === "revision" ? command.selector.releaseRevision : null;
      const rows = await transaction.query<ConsumerReleaseRow>`
        select vortex_definition.read_consumer_release(
          ${command.kind},
          ${command.rootId},
          ${revision}
        ) as consumer_release
      `;
      if (rows.length !== 1) throw new Error("DEFINITION_READ_STORAGE_INVALID");
      return rows[0]!.consumer_release === null ? undefined : rows[0]!.consumer_release;
    });
  },
});
