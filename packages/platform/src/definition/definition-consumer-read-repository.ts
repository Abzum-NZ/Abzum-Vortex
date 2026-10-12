import "server-only";

import type { DefinitionConsumerReadCommand, SessionContext } from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import type { DefinitionConsumerReadRepository } from "./definition-consumer-read-definition";

type ConsumerReleaseRow = DatabaseRow & { consumer_release: unknown };

export const createDatabaseDefinitionConsumerReadRepository = (
  transaction: RequestDatabaseTransaction,
): DefinitionConsumerReadRepository => ({
  async read(_context: SessionContext, command: DefinitionConsumerReadCommand) {
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
  },
});
