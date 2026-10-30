import "server-only";

import { createClient } from "@supabase/supabase-js";
import { correlationIdSchema } from "../catalogue/common";
import { identityIdSchema, platformIdSchema } from "../catalogue/identifiers";
import { databaseCode, describeFailure } from "../catalogue/runtime-primitives";
import { isLoopbackHostname } from "./loopback-hostname";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "../db/request-transaction";

/**
 * The fixed server-only Identity Authority disable/revoke adapter.
 *
 * It disables one identity environment-wide through the provider's Admin API,
 * revokes that identity's provider sessions and records an attributable command
 * with an append-only history of every attempt (actor, subject, command
 * identity, correlation, outcome; never a credential). It performs
 * no authorisation: the caller (the App coordination operation) has already
 * verified the operator's permission through Access, and Identity never imports
 * Access. It is never exposed to a browser.
 *
 * Disabling bans the identity so the provider refuses sign-in and refresh, and
 * deletes its provider sessions. An access token that was already issued stays
 * valid until its own expiry unless a named sensitive operation performs a live
 * check; this adapter never claims otherwise.
 */

export const identityDisablementFailureCodes = [
  "invalid_command",
  "self_disablement",
  "command_conflict",
  "subject_not_found",
  "authority_unavailable",
] as const;

export type IdentityDisablementFailureCode = (typeof identityDisablementFailureCodes)[number];

export type IdentityDisablementCommand = Readonly<{
  commandId: string;
  actorIdentityId: string;
  subjectIdentityId: string;
  correlationId: string;
}>;

const parseCommand = (candidate: unknown): IdentityDisablementCommand | undefined => {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const value = candidate as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  const commandId = platformIdSchema.safeParse(value.commandId);
  const actorIdentityId = identityIdSchema.safeParse(value.actorIdentityId);
  const subjectIdentityId = identityIdSchema.safeParse(value.subjectIdentityId);
  const correlationId = correlationIdSchema.safeParse(value.correlationId);
  return keys === "actorIdentityId,commandId,correlationId,subjectIdentityId" &&
    commandId.success &&
    actorIdentityId.success &&
    subjectIdentityId.success &&
    correlationId.success
    ? {
        commandId: commandId.data,
        actorIdentityId: actorIdentityId.data,
        subjectIdentityId: subjectIdentityId.data,
        correlationId: correlationId.data,
      }
    : undefined;
};

export type IdentityDisablementResult =
  | Readonly<{
      outcome: "disabled";
      commandId: string;
      subjectIdentityId: string;
      sessionsRevoked: number;
      correlationId: string;
      /** True when a retry returned the already recorded result. */
      replayed: boolean;
    }>
  | Readonly<{ outcome: "refused"; code: IdentityDisablementFailureCode }>;

export type IdentityAuthorityDisablementConfiguration = Readonly<{
  supabaseUrl: string;
  /** Privileged provider key; server-only, never logged, stored or returned. */
  secretKey: string;
}>;

export interface IdentityAuthorityDisablementDependencies {
  readonly configuration: IdentityAuthorityDisablementConfiguration;
  readonly runtimeTransaction?: <Result>(
    operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
  ) => Promise<Result>;
}

type BeginRow = DatabaseRow & {
  outcome: unknown;
  sessions_revoked: unknown;
  correlation_id: unknown;
  subject_identity_id: unknown;
};
type CompleteRow = DatabaseRow & { outcome: unknown; sessions_revoked: unknown };

/** One hundred years: the provider has no permanent ban, only a duration. */
const disabledBanDuration = "876000h";

const validateConfiguration = (configuration: IdentityAuthorityDisablementConfiguration): void => {
  const url = new URL(configuration.supabaseUrl);
  const loopback = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (
    (!loopback && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname !== "/"
  )
    throw new Error("Invalid Identity Authority URL");
  if (!configuration.secretKey.startsWith("sb_secret_"))
    throw new Error("Identity Authority disablement requires the privileged provider key");
};

const count = (value: unknown): number | undefined => {
  const parsed = typeof value === "bigint" ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
};

const single = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined)
    throw new Error("Identity disablement record mismatch");
  return row;
};

const isUserNotFound = (
  error: Readonly<{ status: number | undefined; code: string | undefined }>,
): boolean => error.status === 404 || error.code === "user_not_found";

export const createIdentityAuthorityDisablement = (
  dependencies: IdentityAuthorityDisablementDependencies,
) => {
  validateConfiguration(dependencies.configuration);
  const run = dependencies.runtimeTransaction ?? withRuntimeTransaction;
  const client = createClient(
    dependencies.configuration.supabaseUrl,
    dependencies.configuration.secretKey,
    { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } },
  );

  const complete = async (
    command: IdentityDisablementCommand,
    outcome: "disabled" | "subject_not_found" | "provider_unavailable",
  ): Promise<CompleteRow> =>
    run(async (transaction) =>
      single(
        await transaction.query<CompleteRow>`
          select * from vortex_identity.complete_identity_disablement(
            ${command.commandId}::uuid, ${command.correlationId}::uuid, ${outcome}::text
          )
        `,
      ),
    );

  return Object.freeze({
    async disable(candidate: IdentityDisablementCommand): Promise<IdentityDisablementResult> {
      const command = parseCommand(candidate);
      if (command === undefined) return { outcome: "refused", code: "invalid_command" };

      try {
        // 1. Record the command before the provider is called.
        const begun = await run(async (transaction) =>
          single(
            await transaction.query<BeginRow>`
              select * from vortex_identity.begin_identity_disablement(
                ${command.actorIdentityId}::uuid,
                ${command.subjectIdentityId}::uuid,
                ${command.commandId}::uuid,
                ${command.correlationId}::uuid
              )
            `,
          ),
        );
        const recordedCorrelationId = correlationIdSchema.safeParse(begun.correlation_id);
        const recordedSubjectId = identityIdSchema.safeParse(begun.subject_identity_id);
        if (!recordedCorrelationId.success || !recordedSubjectId.success)
          throw new Error("Identity disablement record mismatch");
        const recordedCommand = {
          ...command,
          subjectIdentityId: recordedSubjectId.data,
          correlationId: recordedCorrelationId.data,
        };
        if (begun.outcome === "replayed") {
          const sessionsRevoked = count(begun.sessions_revoked);
          if (sessionsRevoked === undefined)
            throw new Error("Identity disablement record mismatch");
          return {
            outcome: "disabled",
            commandId: command.commandId,
            subjectIdentityId: recordedCommand.subjectIdentityId,
            sessionsRevoked,
            correlationId: recordedCorrelationId.data,
            replayed: true,
          };
        }
        if (begun.outcome !== "started") throw new Error("Identity disablement record mismatch");

        // 2. Ban the identity at the provider (idempotent for a retry).
        const { error } = await client.auth.admin.updateUserById(
          recordedCommand.subjectIdentityId,
          {
            ban_duration: disabledBanDuration,
          },
        );
        if (error) {
          if (isUserNotFound(error)) {
            await complete(recordedCommand, "subject_not_found");
            return { outcome: "refused", code: "subject_not_found" };
          }
          await complete(recordedCommand, "provider_unavailable");
          return { outcome: "refused", code: "authority_unavailable" };
        }

        // 3. Revoke the subject's provider sessions and record the outcome together.
        const finished = await complete(recordedCommand, "disabled");
        const sessionsRevoked = count(finished.sessions_revoked);
        if (finished.outcome !== "disabled" || sessionsRevoked === undefined)
          throw new Error("Identity disablement record mismatch");
        return {
          outcome: "disabled",
          commandId: command.commandId,
          subjectIdentityId: recordedCommand.subjectIdentityId,
          sessionsRevoked,
          correlationId: recordedCorrelationId.data,
          replayed: false,
        };
      } catch (error) {
        // No provider message, key or database detail leaves this boundary; the log carries only
        // the safe description.
        console.error(`[identity] authority disablement failed: ${describeFailure(error)}`);
        if (databaseCode(error) === "V3191")
          return { outcome: "refused", code: "self_disablement" };
        if (databaseCode(error) === "V3001")
          return { outcome: "refused", code: "command_conflict" };
        return { outcome: "refused", code: "authority_unavailable" };
      }
    },
  });
};

export type IdentityAuthorityDisablement = ReturnType<typeof createIdentityAuthorityDisablement>;
