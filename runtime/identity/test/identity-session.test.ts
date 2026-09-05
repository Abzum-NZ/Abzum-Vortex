import {
  identityProjectionSchema,
  verifiedIdentitySchema,
  type CorrelationId,
  type IdentityProjection,
  type VerifiedIdentity,
} from "@vortex/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityVerificationError, createIdentitySessionService } from "../src";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const now = new Date("2026-09-05T01:00:00.000Z");

const identity = (overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity =>
  verifiedIdentitySchema.parse({
    identityId: id(1),
    verifiedPrimaryEmail: "person@example.test",
    issuer: "https://identity.example.test/auth/v1",
    audience: "authenticated",
    sessionId: id(2),
    issuedAt: "2026-09-05T00:30:00.000Z",
    expiresAt: "2026-09-05T01:30:00.000Z",
    authenticationStrength: "single_factor",
    keyId: "key-1",
    ...overrides,
  });

const projection = (state: IdentityProjection["state"] = "active"): IdentityProjection =>
  identityProjectionSchema.parse({
    identityId: id(1),
    state,
    createdAt: "2026-09-05T00:00:00.000Z",
    stateChangedAt: "2026-09-05T00:00:00.000Z",
    stateChangedBy: id(1),
    stateChangeCorrelationId: id(3),
    revision: 1,
  });

describe("identity-session service", () => {
  const verifyAccessToken = vi.fn();
  const ensureProjection = vi.fn();
  const readProjection = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    verifyAccessToken.mockResolvedValue(identity());
    ensureProjection.mockResolvedValue(projection());
    readProjection.mockResolvedValue(projection());
  });

  const service = () =>
    createIdentitySessionService({
      verifyAccessToken,
      ensureProjection,
      readProjection,
      clock: () => now,
    });

  it("bootstraps through ensure and keeps an evidence-free ordinary session shape", async () => {
    const result = await service().bootstrap("access-token", id(3) as CorrelationId);

    expect(result).toEqual({
      kind: "active",
      session: {
        identityId: id(1),
        sessionId: id(2),
        authenticationStrength: "single_factor",
        accessTokenIssuedAt: "2026-09-05T00:30:00.000Z",
        accessTokenExpiresAt: "2026-09-05T01:30:00.000Z",
      },
    });
    expect(ensureProjection).toHaveBeenCalledWith(identity(), { correlationId: id(3) });
    expect(readProjection).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("person@example.test");
  });

  it("propagates exact verified times without treating fresh token issuance as authentication", async () => {
    verifyAccessToken.mockResolvedValueOnce(
      identity({
        issuedAt: "2026-09-05T00:59:00.000Z",
        authenticationStrength: "multi_factor",
        primaryAuthenticatedAt: "2026-09-04T23:00:00.000Z",
        multiFactorAuthenticatedAt: "2026-09-05T00:10:00.000Z",
      }),
    );

    const result = await service().resolve("freshly-refreshed-access-token");
    expect(result).toEqual({
      kind: "active",
      session: {
        identityId: id(1),
        sessionId: id(2),
        authenticationStrength: "multi_factor",
        accessTokenIssuedAt: "2026-09-05T00:59:00.000Z",
        accessTokenExpiresAt: "2026-09-05T01:30:00.000Z",
        primaryAuthenticatedAt: "2026-09-04T23:00:00.000Z",
        multiFactorAuthenticatedAt: "2026-09-05T00:10:00.000Z",
      },
    });
    expect(JSON.stringify(result)).not.toContain("person@example.test");
    expect(result).not.toEqual(
      expect.objectContaining({ multiFactorAuthenticatedAt: "2026-09-05T00:59:00.000Z" }),
    );
  });

  it("resolves through the non-mutating projection read", async () => {
    await expect(service().resolve("access-token")).resolves.toMatchObject({ kind: "active" });
    expect(readProjection).toHaveBeenCalledWith(identity());
    expect(ensureProjection).not.toHaveBeenCalled();
  });

  it.each(["suspended", "closed"] as const)(
    "refuses a %s local projection without changing the authority",
    async (state) => {
      readProjection.mockResolvedValueOnce(projection(state));
      await expect(service().resolve("access-token")).resolves.toEqual({
        kind: "cluster_identity_inactive",
      });
    },
  );

  it("refuses a missing or mismatched projection", async () => {
    readProjection.mockResolvedValueOnce(undefined);
    await expect(service().resolve("access-token")).resolves.toEqual({
      kind: "cluster_identity_inactive",
    });

    readProjection.mockResolvedValueOnce({ ...projection(), identityId: id(9) });
    await expect(service().resolve("access-token")).resolves.toEqual({
      kind: "cluster_identity_inactive",
    });
  });

  it("returns missing without invoking authority or storage", async () => {
    await expect(service().resolve("  ")).resolves.toEqual({ kind: "missing" });
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(readProjection).not.toHaveBeenCalled();
  });

  it("coarsens typed verifier outcomes without provider details", async () => {
    verifyAccessToken.mockRejectedValueOnce(
      new IdentityVerificationError("vortex.identity.authority_unavailable"),
    );
    await expect(service().resolve("access-token")).resolves.toEqual({
      kind: "temporarily_unavailable",
    });

    verifyAccessToken.mockRejectedValueOnce(
      new IdentityVerificationError("vortex.identity.expired_access_token"),
    );
    await expect(service().resolve("access-token")).resolves.toEqual({
      kind: "expired_or_revoked",
    });

    verifyAccessToken.mockRejectedValueOnce(
      new IdentityVerificationError("vortex.identity.untrusted_issuer"),
    );
    await expect(service().resolve("access-token")).resolves.toEqual({
      kind: "invalid_session_state",
    });
  });

  it("coarsens unexpected verifier and projection failures", async () => {
    verifyAccessToken.mockRejectedValueOnce(new Error("unsafe verifier detail"));
    await expect(service().resolve("access-token")).resolves.toEqual({
      kind: "invalid_session_state",
    });

    readProjection.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(service().resolve("access-token")).resolves.toEqual({
      kind: "temporarily_unavailable",
    });
  });

  it("never returns an active session at or after token expiry", async () => {
    verifyAccessToken.mockResolvedValueOnce(identity({ expiresAt: now.toISOString() }));
    await expect(service().resolve("access-token")).resolves.toEqual({
      kind: "expired_or_revoked",
    });
  });

  it("treats an invalid clock as temporary unavailability", async () => {
    const invalidClockService = createIdentitySessionService({
      verifyAccessToken,
      ensureProjection,
      readProjection,
      clock: () => new Date(Number.NaN),
    });
    await expect(invalidClockService.resolve("access-token")).resolves.toEqual({
      kind: "temporarily_unavailable",
    });
  });
});
