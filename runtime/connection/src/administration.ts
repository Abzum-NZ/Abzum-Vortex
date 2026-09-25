import "server-only";

import {
  activityIdSchema,
  applicationRootIdSchema,
  archiveDestinationReferenceSchema,
  connectionInstanceIdSchema,
  connectionTypeIdSchema,
  organizationIdSchema,
  semanticVersionSchema,
  timestampSchema,
  type ConnectionInstanceId,
  type ConnectionTypeId,
  type OrganizationId,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { assertDestinationFingerprint, assertSafeIntegerRevision } from "./connection-instance-state";

/**
 * Typed administration commands over the request-callable
 * `vortex_connection.*_for_administration` writers. Each writer accepts only a human request
 * context, and the `*_internal` writer it delegates to re-checks the organisation, the
 * `platform.organization.connections.manage` authority, the expected revision and every
 * application grant from that context on every direct call. Nothing in a command is accepted as
 * authority: the organisation is always the request context's own. This module validates shape,
 * applies the command and returns a safe outcome.
 *
 * Secrets are write-only. They reach the injected server-only secret store and nowhere else: they
 * are never returned, logged, placed in an error or copied into activity.
 */

/** Server-only secret boundary supplied by trusted wiring. It never reads a secret back. */
export interface ConnectionSecretStore {
  writeSecret(
    request: Readonly<{
      organizationId: OrganizationId;
      connectionInstanceId: ConnectionInstanceId;
      secret: string;
    }>,
  ): Promise<void>;
}

const maximumSecretLength = 16384;

type CommandBase = Readonly<{
  connectionInstanceId: ConnectionInstanceId;
  administratorActivityId: string;
}>;

export type ConnectionAdministrationCommand =
  | (CommandBase &
      Readonly<{
        command: "configure";
        connectionTypeId: ConnectionTypeId;
        connectionTypeVersion: string;
        destinationKey: string;
        destinationFingerprint: string;
        tokenExpiresAt?: string;
        secret: string;
      }>)
  | (CommandBase &
      Readonly<{
        command: "health_check";
        expectedRevision: number;
        healthOutcome: "healthy" | "unhealthy";
      }>)
  | (CommandBase & Readonly<{ command: "disable"; expectedRevision: number }>)
  | (CommandBase &
      Readonly<{
        command: "application_grant";
        applicationRootId: string;
        change: "grant" | "revoke";
      }>)
  | (CommandBase &
      Readonly<{
        command: "rotate_credential";
        expectedRevision: number;
        destinationFingerprint?: string;
        tokenExpiresAt?: string;
        secret: string;
      }>);

/** The closed set of reasons an administration command may be refused. */
export const connectionAdministrationRefusalCodes = [
  "invalid_parameters",
  "not_authorized",
  "connection_unavailable",
  "secret_store_unavailable",
  "administration_unavailable",
] as const;

export type ConnectionAdministrationRefusalCode =
  (typeof connectionAdministrationRefusalCodes)[number];

export type ConnectionAdministrationResult =
  | Readonly<{
      outcome: "applied";
      command: ConnectionAdministrationCommand["command"];
      connectionInstanceId: ConnectionInstanceId;
      /** The authority revision after the command; absent for a grant change. */
      revision?: number;
    }>
  | Readonly<{
      outcome: "refused";
      reasonCode: ConnectionAdministrationRefusalCode;
      message: string;
    }>;

const refusalMessages: Readonly<Record<ConnectionAdministrationRefusalCode, string>> = Object.freeze({
  invalid_parameters: "Connection administration parameters are invalid",
  not_authorized: "Connection administration is unavailable",
  connection_unavailable: "The connection is unavailable or has changed",
  secret_store_unavailable: "The connection secret could not be stored",
  administration_unavailable: "Connection administration is unavailable",
});

const refuse = (reasonCode: ConnectionAdministrationRefusalCode): ConnectionAdministrationResult =>
  Object.freeze({ outcome: "refused", reasonCode, message: refusalMessages[reasonCode] });

class SecretStoreFailure extends Error {}

/** Maps a database failure to a fixed code by SQLSTATE only; the message is never read. */
const refusalForFailure = (error: unknown): ConnectionAdministrationRefusalCode => {
  if (error instanceof SecretStoreFailure) return "secret_store_unavailable";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  if (code === "42501") return "not_authorized";
  // Missing, foreign or stale connection; a missing or foreign application; a duplicate
  // registration. The writers make these indistinguishable, and so does this code.
  if (code === "P0002" || code === "23503" || code === "23505") return "connection_unavailable";
  if (code === "22023" || code === "22003") return "invalid_parameters";
  return "administration_unavailable";
};

type WriteRow = DatabaseRow & { readonly revision: unknown; readonly organization_id: unknown };

/** Reads the writer's single row: the new revision and the request context's organisation. */
const readWrite = (
  rows: readonly WriteRow[],
): Readonly<{ revision: number; organizationId: OrganizationId }> => {
  const row = rows.length === 1 ? rows[0] : undefined;
  return {
    revision: assertSafeIntegerRevision(row?.revision, "Connection administration"),
    organizationId: organizationIdSchema.parse(row?.organization_id),
  };
};

const applied = (
  command: ConnectionAdministrationCommand["command"],
  connectionInstanceId: ConnectionInstanceId,
  revision?: number,
): ConnectionAdministrationResult =>
  Object.freeze({
    outcome: "applied",
    command,
    connectionInstanceId,
    ...(revision === undefined ? {} : { revision }),
  });

const validSecret = (secret: unknown): secret is string =>
  typeof secret === "string" && secret.length > 0 && secret.length <= maximumSecretLength;

const validOptionalTimestamp = (value: unknown): boolean =>
  value === undefined || timestampSchema.safeParse(value).success;

const validOptionalFingerprint = (value: unknown): boolean => {
  if (value === undefined) return true;
  try {
    assertDestinationFingerprint(value as string);
    return true;
  } catch {
    return false;
  }
};

const validRevision = (value: unknown): boolean => {
  try {
    assertSafeIntegerRevision(value, "Connection administration");
    return typeof value === "number";
  } catch {
    return false;
  }
};

/** Shape validation only: authority is decided by the SQL writers. */
const commandIsValid = (input: ConnectionAdministrationCommand): boolean => {
  if (
    input === null ||
    typeof input !== "object" ||
    !connectionInstanceIdSchema.safeParse(input.connectionInstanceId).success ||
    !activityIdSchema.safeParse(input.administratorActivityId).success
  ) {
    return false;
  }
  switch (input.command) {
    case "configure":
      return (
        connectionTypeIdSchema.safeParse(input.connectionTypeId).success &&
        semanticVersionSchema.safeParse(input.connectionTypeVersion).success &&
        archiveDestinationReferenceSchema.safeParse(input.destinationKey).success &&
        input.destinationFingerprint !== undefined &&
        validOptionalFingerprint(input.destinationFingerprint) &&
        validOptionalTimestamp(input.tokenExpiresAt) &&
        validSecret(input.secret)
      );
    case "health_check":
      return (
        validRevision(input.expectedRevision) &&
        (input.healthOutcome === "healthy" || input.healthOutcome === "unhealthy")
      );
    case "disable":
      return validRevision(input.expectedRevision);
    case "application_grant":
      return (
        applicationRootIdSchema.safeParse(input.applicationRootId).success &&
        (input.change === "grant" || input.change === "revoke")
      );
    case "rotate_credential":
      return (
        validRevision(input.expectedRevision) &&
        validOptionalFingerprint(input.destinationFingerprint) &&
        validOptionalTimestamp(input.tokenExpiresAt) &&
        validSecret(input.secret)
      );
    default:
      return false;
  }
};

async function writeSecret(
  secretStore: ConnectionSecretStore,
  organizationId: OrganizationId,
  connectionInstanceId: ConnectionInstanceId,
  secret: string,
): Promise<void> {
  try {
    await secretStore.writeSecret({ organizationId, connectionInstanceId, secret });
  } catch {
    // The store's own error may carry the secret or its location: drop it entirely.
    throw new SecretStoreFailure("secret_store_unavailable");
  }
}

async function applyCommand(
  transaction: RequestDatabaseTransaction,
  secretStore: ConnectionSecretStore,
  input: ConnectionAdministrationCommand,
): Promise<ConnectionAdministrationResult> {
  switch (input.command) {
    case "configure": {
      const rows = await transaction.query<WriteRow>`
        select
          vortex_connection.register_connection_instance_for_administration(
            ${input.connectionInstanceId}::uuid,
            ${input.connectionTypeId}::uuid,
            ${input.connectionTypeVersion}::text,
            ${input.destinationKey}::text,
            ${input.destinationFingerprint}::text,
            ${input.administratorActivityId}::uuid,
            ${input.tokenExpiresAt ?? null}::timestamptz
          ) as revision,
          vortex_context.organization_id() as organization_id
      `;
      const { revision, organizationId } = readWrite(rows);
      await writeSecret(secretStore, organizationId, input.connectionInstanceId, input.secret);
      return applied(input.command, input.connectionInstanceId, revision);
    }
    case "health_check": {
      const rows = await transaction.query<WriteRow>`
        select
          vortex_connection.record_connection_health_check_for_administration(
            ${input.connectionInstanceId}::uuid,
            ${input.expectedRevision}::bigint,
            ${input.healthOutcome}::text,
            ${input.administratorActivityId}::uuid
          ) as revision,
          vortex_context.organization_id() as organization_id
      `;
      return applied(input.command, input.connectionInstanceId, readWrite(rows).revision);
    }
    case "disable": {
      const rows = await transaction.query<WriteRow>`
        select
          vortex_connection.revoke_connection_instance_for_administration(
            ${input.connectionInstanceId}::uuid,
            ${input.expectedRevision}::bigint,
            ${input.administratorActivityId}::uuid
          ) as revision,
          vortex_context.organization_id() as organization_id
      `;
      return applied(input.command, input.connectionInstanceId, readWrite(rows).revision);
    }
    case "application_grant": {
      if (input.change === "grant") {
        await transaction.query`
          select vortex_connection.grant_connection_application_for_administration(
            ${input.connectionInstanceId}::uuid,
            ${input.applicationRootId}::uuid,
            ${input.administratorActivityId}::uuid
          )
        `;
      } else {
        await transaction.query`
          select vortex_connection.revoke_connection_application_for_administration(
            ${input.connectionInstanceId}::uuid,
            ${input.applicationRootId}::uuid,
            ${input.administratorActivityId}::uuid
          )
        `;
      }
      return applied(input.command, input.connectionInstanceId);
    }
    case "rotate_credential": {
      // The writer locks the row, checks organisation, administrator and expected revision and
      // advances the revision, so concurrent rotations and token refreshes serialise there; the
      // secret is stored only after that check succeeds, under the context's organisation.
      const rows = await transaction.query<WriteRow>`
        select
          vortex_connection.reauthorize_connection_instance_for_administration(
            ${input.connectionInstanceId}::uuid,
            ${input.expectedRevision}::bigint,
            ${input.administratorActivityId}::uuid,
            ${input.destinationFingerprint ?? null}::text,
            ${input.tokenExpiresAt ?? null}::timestamptz
          ) as revision,
          vortex_context.organization_id() as organization_id
      `;
      const { revision, organizationId } = readWrite(rows);
      await writeSecret(secretStore, organizationId, input.connectionInstanceId, input.secret);
      return applied(input.command, input.connectionInstanceId, revision);
    }
  }
}

/**
 * Applies one administration command inside the caller's human request transaction.
 *
 * The command runs behind a savepoint. Any failure, including a refused SQL writer or a secret
 * store failure after a successful write, rolls back to that savepoint, so a refused command
 * leaves no connection change or Activity behind and the caller's transaction stays usable.
 * `configure` and `rotate_credential` store the secret last, after the SQL writer's organisation,
 * administrator and revision checks succeed, so a connection is never changed without its secret.
 * Every failure is returned as a fixed safe refusal and never throws.
 */
export async function administerConnection(
  transaction: RequestDatabaseTransaction,
  secretStore: ConnectionSecretStore,
  input: ConnectionAdministrationCommand,
): Promise<ConnectionAdministrationResult> {
  if (!commandIsValid(input)) return refuse("invalid_parameters");

  try {
    await transaction.query`savepoint connection_administration`;
  } catch {
    return refuse("administration_unavailable");
  }

  try {
    const result = await applyCommand(transaction, secretStore, input);
    await transaction.query`release savepoint connection_administration`;
    return result;
  } catch (error) {
    try {
      await transaction.query`rollback to savepoint connection_administration`;
      await transaction.query`release savepoint connection_administration`;
    } catch {
      // The caller's transaction is no longer usable; its runner rolls it back.
    }
    return refuse(refusalForFailure(error));
  }
}
