import "server-only";

import {
  identitySessionResolutionSchema,
  type CorrelationId,
  type IdentityProjection,
  type IdentitySessionResolution,
  type VerifiedIdentity,
} from "@vortex/contracts";
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
}>;

const closed = (result: IdentitySessionResolution): IdentitySessionResolution =>
  identitySessionResolutionSchema.parse(result);

const verificationFailure = (error: unknown): IdentitySessionResolution => {
  if (!(error instanceof IdentityVerificationError))
    return closed({ kind: "invalid_session_state" });
  const code: IdentityVerificationRefusalCode = error.refusalCode;
  if (code === "vortex.identity.authority_unavailable")
    return closed({ kind: "temporarily_unavailable" });
  if (code === "vortex.identity.expired_access_token")
    return closed({ kind: "expired_or_revoked" });
  return closed({ kind: "invalid_session_state" });
};

const projectionFailure = (): IdentitySessionResolution =>
  closed({ kind: "temporarily_unavailable" });

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
  } catch {
    return closed({ kind: "temporarily_unavailable" });
  }
  if (!Number.isFinite(now)) return closed({ kind: "temporarily_unavailable" });
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
      return { ok: true, identity: await dependencies.verifyAccessToken(accessToken) };
    } catch (error) {
      return { ok: false, result: verificationFailure(error) };
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
        const projection = await dependencies.ensureProjection(verified.identity, {
          correlationId,
        });
        return activeResult(verified.identity, projection, clock);
      } catch {
        return projectionFailure();
      }
    },

    async resolve(accessToken: string): Promise<IdentitySessionResolution> {
      const verified = await verify(accessToken);
      if (!verified.ok) return verified.result;
      try {
        return activeResult(
          verified.identity,
          await dependencies.readProjection(verified.identity),
          clock,
        );
      } catch {
        return projectionFailure();
      }
    },
  });
};

export const createDefaultIdentitySessionService = (verifier: IdentityVerifier) =>
  createIdentitySessionService({
    verifyAccessToken: verifier.verifyAccessToken,
    ensureProjection: ensureIdentityProjection,
    readProjection: readIdentityProjection,
  });
