import "server-only";

import {
  identitySessionResolutionSchema,
  type IdentityProjection,
  type IdentitySessionResolution,
  type VerifiedIdentity,
} from "../access/identity-access";
import type { CorrelationId } from "../catalogue/common";
import { describeFailure } from "../catalogue/runtime-primitives";
import {
  IdentityVerificationError,
  type IdentityVerificationRefusalCode,
} from "./identity-verification-error";
import type { IdentityVerifier } from "./identity-verifier";
import { ensureIdentityProjection, readIdentityProjection } from "./organization-accounts";

type VerifyAccessToken = (accessToken: string) => Promise<VerifiedIdentity>;
type EnsureProjection = (
  verifiedIdentity: VerifiedIdentity,
  command: Readonly<{ correlationId: CorrelationId }>,
) => Promise<IdentityProjection>;
type ReadProjection = (
  verifiedIdentity: VerifiedIdentity,
) => Promise<IdentityProjection | undefined>;

export type IdentitySessionServiceDependencies = Readonly<{
  verifyAccessToken: VerifyAccessToken;
  ensureProjection: EnsureProjection;
  readProjection: ReadProjection;
  clock?: () => Date;
  checkpoint?(): void;
}>;

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
  if (code === "vortex.identity.expired_access_token")
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

export const createIdentitySessionService = (dependencies: IdentitySessionServiceDependencies) => {
  const clock = dependencies.clock ?? (() => new Date());

  const verify = async (
    accessToken: string,
  ): Promise<
    | Readonly<{ ok: true; identity: VerifiedIdentity }>
    | Readonly<{ ok: false; result: IdentitySessionResolution }>
  > => {
    if (accessToken.trim().length === 0) return { ok: false, result: closed({ kind: "missing" }) };
    try {
      dependencies.checkpoint?.();
      const identity = await dependencies.verifyAccessToken(accessToken);
      dependencies.checkpoint?.();
      return { ok: true, identity };
    } catch (error) {
      return { ok: false, result: verificationFailure(error) };
    }
  };

  const resolveVerified = async (
    accessToken: string,
  ): Promise<
    Readonly<{ resolution: IdentitySessionResolution; verifiedPrimaryEmail?: string }>
  > => {
    const verified = await verify(accessToken);
    if (!verified.ok) return { resolution: verified.result };
    try {
      dependencies.checkpoint?.();
      const projection = await dependencies.readProjection(verified.identity);
      dependencies.checkpoint?.();
      const resolution = activeResult(verified.identity, projection, clock);
      return resolution.kind === "active"
        ? { resolution, verifiedPrimaryEmail: verified.identity.verifiedPrimaryEmail }
        : { resolution };
    } catch (error) {
      return { resolution: projectionFailure(error) };
    }
  };

  return Object.freeze({
    async bootstrap(
      accessToken: string,
      correlationId: CorrelationId,
    ): Promise<IdentitySessionResolution> {
      const verified = await verify(accessToken);
      if (!verified.ok) return verified.result;
      try {
        dependencies.checkpoint?.();
        const projection = await dependencies.ensureProjection(verified.identity, {
          correlationId,
        });
        dependencies.checkpoint?.();
        return activeResult(verified.identity, projection, clock);
      } catch (error) {
        return projectionFailure(error);
      }
    },

    async resolve(accessToken: string): Promise<IdentitySessionResolution> {
      return (await resolveVerified(accessToken)).resolution;
    },

    /** The resolution with the email of the very identity that was verified, for the account menu. */
    resolveVerified,
  });
};

export const createDefaultIdentitySessionService = (verifier: IdentityVerifier) =>
  createIdentitySessionService({
    verifyAccessToken: verifier.verifyAccessToken,
    ensureProjection: ensureIdentityProjection,
    readProjection: readIdentityProjection,
    ...(verifier.checkpoint === undefined ? {} : { checkpoint: verifier.checkpoint }),
  });
