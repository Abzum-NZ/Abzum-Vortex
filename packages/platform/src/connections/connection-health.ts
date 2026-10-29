import "server-only";

import { z } from "zod";
import type { SelectedOrganizationScope } from "../access/identity-access";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import { createRequestBoundConnectionExecution } from "../identity/tenant-governance-request-bound";
import { healthConnectionCommandSchema } from "./connection-administration";
import { connectionProviderAdapters, executeConnectionOperation } from "./outbound-executor";
import { PLATFORM_CONNECTION_TYPE_RELEASES } from "./platform-connection-type-catalogue";

const healthOutcome = z.enum(["healthy", "unhealthy", "unknown", "no_adapter"]);
const result = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("conflict") }).strict(),
  z
    .object({
      outcome: z.literal("completed"),
      revision: z.number().int().positive(),
      healthOutcome,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("available"),
      ticket: z.guid(),
      connectionTypeId: z.guid(),
      connectionTypeVersion: z.string(),
    })
    .strict(),
]);
type ResultRow = DatabaseRow & { readonly result: unknown };

/** Execute a health check from a ticket issued under the current request's authority. */
export async function checkConnectionHealth(
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: z.output<typeof healthConnectionCommandSchema>,
) {
  const rows = await transaction.query<ResultRow>`
    select vortex_platform.issue_connection_execution_ticket(
      ${command.connectionInstanceId}::uuid, ${command.expectedRevision}::bigint,
      ${"health_check"}::text, ${command.commandId}::uuid
    ) as result
  `;
  if (rows.length !== 1) throw new Error("Connection ticket returned an invalid row count");
  const ticket = result.parse(rows[0]?.result);
  if (ticket.outcome !== "available") return ticket;
  const release = PLATFORM_CONNECTION_TYPE_RELEASES.find(
    (entry) =>
      entry.rootId.toLowerCase() === ticket.connectionTypeId.toLowerCase() &&
      entry.releaseVersion === ticket.connectionTypeVersion,
  );
  if (release === undefined) throw new Error("Connection type release is unavailable");
  const adapter = connectionProviderAdapters.get(
    `${release.rootId.toLowerCase()}@${release.releaseVersion}`,
  );
  const runtime = createRequestBoundConnectionExecution(transaction, scope);
  let outcome: z.output<typeof healthOutcome> = "no_adapter";
  if (adapter !== undefined) {
    const type = release.source.body;
    const operation = type.operations.find((entry) => entry.key === type.health_operation);
    if (operation === undefined || operation.timeout_seconds > 50)
      throw new Error("Connection health operation is unavailable");
    const execution = await executeConnectionOperation(
      type,
      operation,
      adapter,
      async () => {
        const credentialRows = await runtime.readCredential(ticket.ticket);
        if (credentialRows.length !== 1)
          throw new Error("Connection credential row count is invalid");
        return z.string().min(1).parse(credentialRows[0]?.read_connection_credential_for_execution);
      },
      {},
    );
    outcome =
      execution.outcome === "success"
        ? "healthy"
        : execution.outcome === "terminal"
          ? "unhealthy"
          : "unknown";
  }
  const written = await runtime.recordHealth(ticket.ticket, outcome);
  if (written.length !== 1) throw new Error("Connection health row count is invalid");
  const completed = result.parse(written[0]?.record_connection_health_result);
  if (completed.outcome !== "completed") throw new Error("Connection health result is invalid");
  return completed;
}
