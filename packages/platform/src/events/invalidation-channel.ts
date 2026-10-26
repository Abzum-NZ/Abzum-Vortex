import "server-only";

import {
  applicationRootIdSchema,
  organizationIdSchema,
  type ApplicationRootId,
  type OrganizationId,
} from "../catalogue/identifiers";

/**
 * Private content-free invalidation channels.
 *
 * An open page learns that relevant data may have changed through one private
 * Supabase Realtime Broadcast topic per organisation and application. The
 * payload is only identifiers, versions and a closed change kind: it never
 * carries a field value, file address, permission result or readable label, and
 * it is never evidence of access. The client re-runs an ordinary authorised
 * query after receiving it.
 *
 * This module owns the runtime half of the contract. The SQL half lives in
 * `supabase/migrations/20260924380000_private_invalidation_channels.sql`, which
 * parses the same topic string and derives the organisation from the verified
 * identity rather than from the topic. This module exposes the deterministic topic and
 * the authorise/reauthorise decision.
 */

/** The Broadcast event name for one invalidation; the SQL publisher emits the same name. */
export const privateInvalidationBroadcastEvent = "invalidation";

/** Topic prefix shared verbatim with the SQL policy's parser. */
export const privateInvalidationTopicPrefix = "vortex:invalidation";

export const privateInvalidationChannelLimits = Object.freeze({
  /** Supabase Realtime refuses a channel topic longer than 100 characters. */
  maximumTopicLength: 100,
});

export const privateInvalidationChannelErrorCodes = [
  "INVALID_INVALIDATION_ENVELOPE",
  "INVALID_INVALIDATION_TOPIC",
  "INVALID_INVALIDATION_PUBLISHER",
  "INVALIDATION_PUBLISH_MISMATCH",
] as const;

export type PrivateInvalidationChannelErrorCode =
  (typeof privateInvalidationChannelErrorCodes)[number];

export class PrivateInvalidationChannelError extends Error {
  readonly code: PrivateInvalidationChannelErrorCode;

  constructor(code: PrivateInvalidationChannelErrorCode) {
    super(code);
    this.name = "PrivateInvalidationChannelError";
    this.code = code;
  }
}

/** The exact organisation and application one private topic is scoped to. */
export type PrivateInvalidationTopicScope = Readonly<{
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
}>;

const positiveSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

/**
 * The deterministic private topic for one organisation and application. Both
 * identifiers are validated as platform UUIDs and lower-cased to match the SQL
 * topic byte for byte, and the result is checked against the Realtime topic
 * length bound.
 */
export const privateInvalidationTopic = (scope: {
  organizationId: string;
  applicationRootId: string;
}): string => {
  const organizationId = organizationIdSchema.safeParse(scope.organizationId);
  const applicationRootId = applicationRootIdSchema.safeParse(scope.applicationRootId);
  if (!organizationId.success || !applicationRootId.success)
    throw new PrivateInvalidationChannelError("INVALID_INVALIDATION_TOPIC");
  const topic = `${privateInvalidationTopicPrefix}:${organizationId.data.toLowerCase()}:${applicationRootId.data.toLowerCase()}`;
  if (topic.length > privateInvalidationChannelLimits.maximumTopicLength)
    throw new PrivateInvalidationChannelError("INVALID_INVALIDATION_TOPIC");
  return topic;
};

/**
 * The current, identity-derived state of one organisation account and its open
 * application. It is read by a protected server path, never from the topic.
 */
export type PrivateInvalidationChannelAccess = Readonly<{
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  /** Current organisation Access version. */
  accessVersion: number;
  /** The account is active in an active organisation and tenant. */
  accountAvailable: boolean;
  /** The application is actively installed for that organisation and may be opened. */
  applicationAvailable: boolean;
}>;

/**
 * Reads the current access for the one verified identity this reader is bound
 * to. It never accepts an identity or organisation from the topic.
 */
export interface PrivateInvalidationChannelAccessReader {
  readCurrent(
    request: PrivateInvalidationTopicScope,
  ): Promise<PrivateInvalidationChannelAccess | undefined>;
}

export type PrivateInvalidationAuthorizationRequest = Readonly<{
  /** Organisation from the verified session, never from the topic string. */
  organizationId: OrganizationId;
  /** Application currently open for that session. */
  applicationRootId: ApplicationRootId;
  /** Topic the connection currently holds or is joining. */
  topic: string;
  /** Organisation Access version the connection was admitted with. */
  boundAccessVersion: number;
}>;

export const privateInvalidationAuthorizationRefusalReasons = [
  "scope_mismatch",
  "account_unavailable",
  "application_unavailable",
  "invalid_access_version",
] as const;

export type PrivateInvalidationAuthorizationRefusalReason =
  (typeof privateInvalidationAuthorizationRefusalReasons)[number];

export type PrivateInvalidationAuthorization =
  | Readonly<{ outcome: "authorized"; topic: string; accessVersion: number }>
  | Readonly<{
      outcome: "reauthorization_required";
      topic: string;
      accessVersion: number;
    }>
  | Readonly<{ outcome: "refused"; reason: PrivateInvalidationAuthorizationRefusalReason }>;

export type PrivateInvalidationChannelAuthorizerDependencies = Readonly<{
  accessReader: PrivateInvalidationChannelAccessReader;
}>;

export type PrivateInvalidationChannelAuthorizer = Readonly<{
  authorize(
    request: PrivateInvalidationAuthorizationRequest,
  ): Promise<PrivateInvalidationAuthorization>;
}>;

const refused = (
  reason: PrivateInvalidationAuthorizationRefusalReason,
): PrivateInvalidationAuthorization => ({ outcome: "refused", reason });

/**
 * Decides whether one open private channel may connect or renew. The topic must
 * match the organisation and application of the verified session, the account
 * and application must be currently available, and the connection's Access
 * version must equal the current one. A revision change yields
 * `reauthorization_required`, so a revoked account cannot retain a channel by
 * renewing with its old version.
 */
export const createPrivateInvalidationChannelAuthorizer = (
  dependencies: PrivateInvalidationChannelAuthorizerDependencies,
): PrivateInvalidationChannelAuthorizer =>
  Object.freeze({
    async authorize(
      request: PrivateInvalidationAuthorizationRequest,
    ): Promise<PrivateInvalidationAuthorization> {
      let expectedTopic: string;
      try {
        expectedTopic = privateInvalidationTopic({
          organizationId: request.organizationId,
          applicationRootId: request.applicationRootId,
        });
        // guard-allow: silent-catch A scope that cannot name a topic is refused as a scope mismatch.
      } catch {
        return refused("scope_mismatch");
      }
      if (request.topic !== expectedTopic) return refused("scope_mismatch");
      if (!positiveSafeInteger(request.boundAccessVersion))
        return refused("invalid_access_version");

      const access = await dependencies.accessReader.readCurrent(
        Object.freeze({
          organizationId: request.organizationId,
          applicationRootId: request.applicationRootId,
        }),
      );
      if (
        access === undefined ||
        access.organizationId.toLowerCase() !== request.organizationId.toLowerCase() ||
        access.applicationRootId.toLowerCase() !== request.applicationRootId.toLowerCase()
      )
        return refused("scope_mismatch");
      if (!access.accountAvailable) return refused("account_unavailable");
      if (!access.applicationAvailable) return refused("application_unavailable");
      if (!positiveSafeInteger(access.accessVersion)) return refused("invalid_access_version");
      if (access.accessVersion !== request.boundAccessVersion)
        return {
          outcome: "reauthorization_required",
          topic: expectedTopic,
          accessVersion: access.accessVersion,
        };
      return {
        outcome: "authorized",
        topic: expectedTopic,
        accessVersion: access.accessVersion,
      };
    },
  });
