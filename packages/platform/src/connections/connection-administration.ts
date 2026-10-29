import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import { PLATFORM_CONNECTION_TYPE_RELEASES } from "./platform-connection-type-catalogue";

const destination = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
const identifier = z.guid();
const revision = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const commandId = identifier;

export const createConnectionCommandSchema = z
  .object({
    commandId,
    connectionTypeId: identifier,
    connectionTypeVersion: z.string().min(1).max(80),
    destinationKey: destination,
    secretReferenceId: identifier,
  })
  .strict();
export const editConnectionCommandSchema = z
  .object({
    commandId,
    connectionInstanceId: identifier,
    expectedRevision: revision,
    destinationKey: destination,
    secretReferenceId: identifier.optional(),
  })
  .strict();
export const revokeConnectionCommandSchema = z
  .object({
    commandId,
    connectionInstanceId: identifier,
    expectedRevision: revision,
  })
  .strict();

export type ConnectionCommand =
  | Readonly<{ operation: "create"; command: z.output<typeof createConnectionCommandSchema> }>
  | Readonly<{ operation: "edit"; command: z.output<typeof editConnectionCommandSchema> }>
  | Readonly<{ operation: "revoke"; command: z.output<typeof revokeConnectionCommandSchema> }>;

const resultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("conflict") }).strict(),
  z
    .object({
      outcome: z.literal("completed"),
      connectionInstanceId: identifier,
      revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);
type ResultRow = DatabaseRow & { readonly result: unknown };

/** Execute one authorised, revision-checked instance change inside the caller's transaction. */
export async function changeConnectionInstance(
  transaction: RequestDatabaseTransaction,
  change: ConnectionCommand,
): Promise<z.output<typeof resultSchema>> {
  if (
    change.operation === "create" &&
    !PLATFORM_CONNECTION_TYPE_RELEASES.some(
      (release) =>
        release.rootId.toLowerCase() === change.command.connectionTypeId.toLowerCase() &&
        release.releaseVersion === change.command.connectionTypeVersion,
    )
  )
    throw new Error("Connection type release is unavailable");
  const id = change.operation === "create" ? randomUUID() : change.command.connectionInstanceId;
  const key = change.operation === "revoke" ? null : change.command.destinationKey;
  const fingerprint =
    key === null ? null : createHash("sha256").update(`${id}:${key}`).digest("hex");
  const typeId = change.operation === "create" ? change.command.connectionTypeId : null;
  const version = change.operation === "create" ? change.command.connectionTypeVersion : null;
  const expected = change.operation === "create" ? null : change.command.expectedRevision;
  const secretReference =
    change.operation === "revoke" ? null : (change.command.secretReferenceId ?? null);
  const activityId = randomUUID();
  const rows = await transaction.query<ResultRow>`
    select vortex_platform.change_connection_instance(
      ${change.operation}::text, ${id}::uuid, ${expected}::bigint,
      ${typeId}::uuid, ${version}::text, ${key}::text, ${fingerprint}::text,
      ${secretReference}::uuid, ${activityId}::uuid, ${change.command.commandId}::uuid
    ) as result
  `;
  if (rows.length !== 1) throw new Error("Connection change returned an invalid row count");
  return resultSchema.parse(rows[0]?.result);
}

export const healthConnectionCommandSchema = z
  .object({
    commandId,
    connectionInstanceId: identifier,
    expectedRevision: revision,
  })
  .strict();
