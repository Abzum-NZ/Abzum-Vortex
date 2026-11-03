import "server-only";

import {
  identitySessionResolutionSchema,
  type IdentityProjection,
  type IdentitySessionResolution,
  type VerifiedIdentity,
} from "../access/identity-access";
import type { CorrelationId } from "../catalogue/common";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import { describeFailure } from "../catalogue/runtime-primitives";
import { databaseErrorCode } from "../definition/definition-error";
import {
  IdentityVerificationError,
  type IdentityVerificationRefusalCode,
} from "./identity-verification-error";
import type { IdentityVerifier } from "./identity-verifier";
import { ensureIdentityProjection, readIdentityProjection } from "./organization-accounts";

// Transient failures are read once more before the failure is mapped and logged: a refusal that
// says the authority could not be reached, and a database serialization failure, deadlock, admin
// shutdown or connection exception (SQLSTATE 40001, 40P01, 57P01, class 08). Nothing else is
// repeated. A read inside a request transaction (a failed statement leaves it aborted) and a read
// bounded by an execution deadline (a passed deadline never recovers) is never repeated.
const isTransientVerification = (error: unknown): boolean =>
  error instanceof IdentityVerificationError &&
  error.refusalCode === "vortex.identity.authority_unavailable";

const isTransientRead = (error: unknown): boolean => {
  const code = databaseErrorCode(
    error instanceof Error && error.cause !== undefined ? error.cause : error,
  );
  return (
    code === "40001" || code === "40P01" || code === "57P01" || code?.startsWith("08") === true
  );
};

const closed = (result: IdentitySessionResolution): IdentitySessionResolution =>
  identitySessionResolutionSchema.parse(result);

// Refusals of a bad token are expected; an unexpected exception (or a refusal that carries one as
// its cause) is a platform defect and is logged once with its safe description.
const verificationFailure = (error: unknown): IdentitySessionResolution => {
  if (!(error instanceof IdentityVerificationError)) {
    console.error(`[identity] session verification failed: ${describeFailure(error)}`);
    return closed({ kind: "invalid_session_state" });
  }
  if (error.cause !== undefined)
    console.error(`[identity] session verification failed: ${describeFailure(error)}`);
  const code: IdentityVerificationRefusalCode = error.refusalCode;
  if (code === "vortex.identity.authority_unavailable")
    return closed({ kind: "temporarily_unavailable" });
  if (code === "vortex.identity.expired_access_token" || code === "vortex.identity.session_ended")
    return closed({ kind: "expired_or_revoked" });
  return closed({ kind: "invalid_session_state" });
};

const projectionFailure = (error: unknown): IdentitySessionResolution => {
  console.error(`[identity] session projection failed: ${describeFailure(error)}`);
  return closed({ kind: "temporarily_unavailable" });
};

const activeResult = (
  verifiedIdentity: VerifiedIdentity,
  projection: IdentityProjection | undefined,
  clock: () => Date,
): IdentitySessionResolution => {
  if (
    !projection ||
    projection.identityId !== verifiedIdentity.identityId ||
    projection.state !== "active"
  )
    return closed({ kind: "cluster_identity_inactive" });

  let now: number;
  try {
    now = clock().getTime();
  } catch (error) {
    console.error(`[identity] session clock failed: ${describeFailure(error)}`);
    return closed({ kind: "temporarily_unavailable" });
  }
  if (!Number.isFinite(now)) {
    console.error("[identity] session clock returned a non-finite time");
    return closed({ kind: "temporarily_unavailable" });
  }
  if (Date.parse(verifiedIdentity.expiresAt) <= now) return closed({ kind: "expired_or_revoked" });

  return closed({
    kind: "active",
    session: {
      identityId: verifiedIdentity.identityId,
      sessionId: verifiedIdentity.sessionId,
      authenticationStrength: verifiedIdentity.authenticationStrength,
      accessTokenIssuedAt: verifiedIdentity.issuedAt,
      accessTokenExpiresAt: verifiedIdentity.expiresAt,
      ...(verifiedIdentity.primaryAuthenticatedAt === undefined
        ? {}
        : { primaryAuthenticatedAt: verifiedIdentity.primaryAuthenticatedAt }),
      ...(verifiedIdentity.multiFactorAuthenticatedAt === undefined
        ? {}
        : { multiFactorAuthenticatedAt: verifiedIdentity.multiFactorAuthenticatedAt }),
    },
  });
};

export const createIdentitySessionService = (verifier: IdentityVerifier) => {
  const clock = () => new Date();

  const verify = async (
    accessToken: string,
    transaction?: RequestDatabaseTransaction,
  ): Promise<
    | Readonly<{ ok: true; identity: VerifiedIdentity }>
    | Readonly<{ ok: false; result: IdentitySessionResolution }>
  > => {
    if (accessToken.trim().length === 0) return { ok: false, result: closed({ kind: "missing" }) };
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        verifier.checkpoint?.();
        const identity = await verifier.verifyAccessToken(accessToken, transaction);
        verifier.checkpoint?.();
        return { ok: true, identity };
      } catch (error) {
        failure = error;
        if (
          transaction !== undefined ||
          verifier.checkpoint !== undefined ||
          !isTransientVerification(error)
        )
          break;
      }
    }
    return { ok: false, result: verificationFailure(failure) };
  };

  const resolveVerified = async (
    accessToken: string,
    transaction?: RequestDatabaseTransaction,
  ): Promise<Readonly<{ resolution: IdentitySessionResolution; identity?: VerifiedIdentity }>> => {
    const verified = await verify(accessToken, transaction);
    if (!verified.ok) return { resolution: verified.result };
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        verifier.checkpoint?.();
        const projection = await readIdentityProjection(verified.identity, transaction);
        verifier.checkpoint?.();
        const resolution = activeResult(verified.identity, projection, clock);
        return resolution.kind === "active"
          ? { resolution, identity: verified.identity }
          : { resolution };
      } catch (error) {
        failure = error;
        if (
          transaction !== undefined ||
          verifier.checkpoint !== undefined ||
          !isTransientRead(error)
        )
          break;
      }
    }
    return { resolution: projectionFailure(failure) };
  };

  return Object.freeze({
    async bootstrap(
      accessToken: string,
      correlationId: CorrelationId,
    ): Promise<IdentitySessionResolution> {
      const verified = await verify(accessToken);
      if (!verified.ok) return verified.result;
      try {
        verifier.checkpoint?.();
        const projection = await ensureIdentityProjection(verified.identity, {
          correlationId,
        });
        verifier.checkpoint?.();
        return activeResult(verified.identity, projection, clock);
      } catch (error) {
        return projectionFailure(error);
      }
    },

    async resolve(accessToken: string): Promise<IdentitySessionResolution> {
      return (await resolveVerified(accessToken)).resolution;
    },

    /**
     * The resolution with the very identity that was verified (its email for the account menu,
     * the whole identity for actions taken before an organisation exists, such as joining one).
     */
    resolveVerified,
  });
};
