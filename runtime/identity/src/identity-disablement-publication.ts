import "server-only";

import { identityIdSchema } from "@vortex/contracts";
import type { RequestDatabaseTransaction, RuntimeDatabaseTransaction } from "@vortex/db";

/**
 * Live disablement checks for named sensitive operations.
 *
 * #755 disables an identity environment-wide and #963 publishes that fact to
 * the cluster-local identity projections. These checks additionally read the
 * recorded disablement inside the operation's own transaction, so an identity
 * whose access token is still unexpired is refused immediately at the sensitive
 * operation. Ordinary reads keep the documented token-expiry policy and never
 * call these. Identity reads only its own records here and imports no Access.
 *
 * A disabled or invalid identity makes the database refuse with SQLSTATE 42501,
 * which each caller already maps to its own safe "unavailable"/context-refused
 * result; no provider detail or identity state leaves this boundary.
 */

/**
 * Refuses the explicit acting identity of a trusted runtime command (the
 * identity of its checked session) when that identity is disabled.
 */
export const requireIdentityNotDisabled = async (
  transaction: RuntimeDatabaseTransaction,
  identityId: string,
): Promise<void> => {
  const verified = identityIdSchema.parse(identityId);
  await transaction.query`select vortex_identity.require_identity_not_disabled(${verified}::uuid)`;
};

/**
 * Refuses the person named by the current protected request context (its
 * `identityId`) when that person is disabled, and refuses any context that
 * names no person.
 */
export const requireRequestIdentityNotDisabled = async (
  transaction: RequestDatabaseTransaction,
): Promise<void> => {
  await transaction.query`select vortex_identity.require_request_identity_not_disabled()`;
};
