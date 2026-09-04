import { AuthRetryableFetchError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sessionService = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  resolve: vi.fn(),
}));
const createIdentityVerifier = vi.hoisted(() => vi.fn(() => ({ verifyAccessToken: vi.fn() })));
const createDefaultIdentitySessionService = vi.hoisted(() => vi.fn(() => sessionService));
vi.mock("@vortex/identity", () => ({
  createIdentityVerifier,
  createDefaultIdentitySessionService,
}));

const cookieStore = vi.hoisted(() => ({ getAll: vi.fn(), set: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));

const auth = vi.hoisted(() => ({
  setSession: vi.fn(),
  getUser: vi.fn(),
  getSession: vi.fn(),
  signOut: vi.fn(),
}));
const createServerClient = vi.hoisted(() =>
  vi.fn((...arguments_: unknown[]) => {
    void arguments_;
    return { auth };
  }),
);
vi.mock("@supabase/ssr", () => ({ createServerClient }));

import {
  bootstrapIdentitySession,
  endIdentitySession,
  resolveIdentitySession,
} from "../app/auth/_lib/session-server";
import { createIdentitySessionClient } from "../app/auth/_lib/supabase-session-client";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const accessToken = `${"a".repeat(32)}.${"b".repeat(32)}.${"c".repeat(32)}`;
const refreshToken = "refresh-token";
const active = {
  kind: "active",
  session: {
    identityId: id(1),
    sessionId: id(2),
    authenticationStrength: "single_factor",
    accessTokenIssuedAt: "2026-09-05T00:00:00.000Z",
    accessTokenExpiresAt: "2026-09-05T01:00:00.000Z",
  },
} as const;

describe("Next.js identity-session server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VORTEX_SUPABASE_URL", "https://identity.example.test");
    vi.stubEnv("VORTEX_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test-value");
    vi.stubEnv("VORTEX_SITE_URL", "https://vortex.example.test");
    vi.stubEnv("VORTEX_ENVIRONMENT", "testing");
    vi.stubEnv("VORTEX_IDENTITY_AUTHORITY_ID", id(9));
    cookieStore.getAll.mockReturnValue([]);
    auth.setSession.mockResolvedValue({
      data: { session: { access_token: accessToken, refresh_token: refreshToken } },
      error: null,
    });
    auth.getUser.mockResolvedValue({ data: { user: { ignored: true } }, error: null });
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: accessToken, refresh_token: refreshToken } },
      error: null,
    });
    auth.signOut.mockResolvedValue({ error: null });
    sessionService.bootstrap.mockResolvedValue(active);
    sessionService.resolve.mockResolvedValue(active);
  });

  it("creates a fresh official server client with tokens-only secure cookie behavior", () => {
    createIdentitySessionClient([]);
    createIdentitySessionClient([]);

    expect(createServerClient).toHaveBeenCalledTimes(2);
    expect(createServerClient).toHaveBeenLastCalledWith(
      "https://identity.example.test",
      "sb_publishable_test-value",
      expect.objectContaining({
        cookieEncoding: "base64url",
        cookieOptions: expect.objectContaining({
          name: "__Host-vortex-session",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          priority: "high",
        }),
        cookies: expect.objectContaining({ encode: "tokens-only" }),
      }),
    );
  });

  it("commits staged cookies only after live provider and local projection checks", async () => {
    createServerClient.mockImplementationOnce((...arguments_: unknown[]) => {
      const options = arguments_[2] as {
        cookies: {
          setAll: (
            cookies: ReadonlyArray<{
              name: string;
              value: string;
              options: Record<string, unknown>;
            }>,
            headers: Record<string, string>,
          ) => void;
        };
      };
      return {
        auth: {
          ...auth,
          setSession: vi.fn(async () => {
            await options.cookies.setAll(
              [
                {
                  name: "__Host-vortex-session",
                  value: "encoded-session",
                  options: { domain: "unsafe.example", httpOnly: false, secure: false },
                },
              ],
              { "Cache-Control": "private, no-store" },
            );
            return {
              data: { session: { access_token: accessToken, refresh_token: refreshToken } },
              error: null,
            };
          }),
        },
      };
    });

    await expect(
      bootstrapIdentitySession({ ok: true, accessToken, refreshToken }),
    ).resolves.toEqual(active);
    expect(sessionService.bootstrap).toHaveBeenCalledWith(accessToken, expect.any(String));
    expect(cookieStore.set).toHaveBeenCalledWith(
      "__Host-vortex-session",
      "encoded-session",
      expect.objectContaining({
        secure: true,
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      }),
    );
    expect(cookieStore.set.mock.calls[0]?.[2]).not.toHaveProperty("domain");
  });

  it("does not commit a newly staged pair when cluster eligibility fails", async () => {
    sessionService.bootstrap.mockResolvedValueOnce({ kind: "cluster_identity_inactive" });

    await expect(
      bootstrapIdentitySession({ ok: true, accessToken, refreshToken }),
    ).resolves.toEqual({ kind: "cluster_identity_inactive" });
    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("preserves a valid prior browser session when a replacement sign-in bootstrap fails", async () => {
    cookieStore.getAll.mockReturnValue([{ name: "__Host-vortex-session", value: "prior-session" }]);
    sessionService.bootstrap.mockResolvedValueOnce({ kind: "cluster_identity_inactive" });

    await expect(
      bootstrapIdentitySession({ ok: true, accessToken, refreshToken }),
    ).resolves.toEqual({ kind: "cluster_identity_inactive" });

    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("preserves the original jar when the provider is temporarily unavailable before rotation", async () => {
    cookieStore.getAll.mockReturnValue([{ name: "__Host-vortex-session", value: "prior-session" }]);
    auth.setSession.mockResolvedValueOnce({
      data: { session: null },
      error: new AuthRetryableFetchError("temporary", 503),
    });

    await expect(
      bootstrapIdentitySession({ ok: true, accessToken, refreshToken }),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });

    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("resolves the post-Proxy access token without trusting the provider user", async () => {
    cookieStore.getAll.mockReturnValue([
      { name: "__Host-vortex-session", value: "encoded-session" },
    ]);

    await expect(resolveIdentitySession()).resolves.toEqual(active);
    expect(sessionService.resolve).toHaveBeenCalledWith(accessToken);
  });

  it("coarsens a retryable resolution failure without clearing the original jar", async () => {
    cookieStore.getAll.mockReturnValue([
      { name: "__Host-vortex-session", value: "encoded-session" },
    ]);
    auth.getSession.mockResolvedValueOnce({
      data: { session: null },
      error: new AuthRetryableFetchError("temporary", 503),
    });

    await expect(resolveIdentitySession()).resolves.toEqual({ kind: "temporarily_unavailable" });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("clears every local cookie chunk even when provider sign-out fails", async () => {
    cookieStore.getAll.mockReturnValue([
      { name: "__Host-vortex-session", value: "encoded-session" },
    ]);
    auth.signOut.mockRejectedValueOnce(new Error("provider unavailable"));

    await endIdentitySession();

    expect(cookieStore.set).toHaveBeenCalledTimes(9);
    for (const call of cookieStore.set.mock.calls)
      expect(call).toEqual([
        expect.stringMatching(/^__Host-vortex-session(?:\.[0-7])?$/u),
        "",
        expect.objectContaining({ maxAge: 0, secure: true, httpOnly: true, path: "/" }),
      ]);
  });
});
