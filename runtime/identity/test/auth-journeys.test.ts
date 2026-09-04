import { beforeEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  getUser: vi.fn(),
  setSession: vi.fn(),
  updateUser: vi.fn(),
}));

const createClient = vi.hoisted(() => vi.fn(() => ({ auth: authority })));

vi.mock("@supabase/supabase-js", () => ({ createClient }));

vi.mock("server-only", () => ({}));

import {
  completePasswordRecovery,
  confirmEmail,
  requestPasswordRecovery,
  requestRegistration,
  signInWithPassword,
  type IdentityJourneyConfiguration,
} from "../src/auth-journeys";

const configuration: IdentityJourneyConfiguration = {
  supabaseUrl: "https://authority.example.test",
  publishableKey: "sb_publishable_test-value",
  siteUrl: "https://vortex.example.test",
};

describe("identity authority journeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authority.signUp.mockResolvedValue({ data: {}, error: null });
    authority.signInWithPassword.mockResolvedValue({
      data: {
        session: {
          access_token: `${"a".repeat(32)}.${"b".repeat(32)}.${"c".repeat(32)}`,
          refresh_token: "verified-refresh-token",
        },
      },
      error: null,
    });
    authority.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    authority.getUser.mockResolvedValue({ data: { user: { id: "identity-id" } }, error: null });
    authority.setSession.mockResolvedValue({ data: { session: {} }, error: null });
    authority.updateUser.mockResolvedValue({ data: {}, error: null });
  });

  it("uses fixed confirmation and recovery destinations", async () => {
    await requestRegistration(configuration, "person@example.test", "secure-pass-1");
    await requestPasswordRecovery(configuration, "person@example.test");

    expect(authority.signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { emailRedirectTo: "https://vortex.example.test/auth/confirm" },
      }),
    );
    expect(authority.resetPasswordForEmail).toHaveBeenCalledWith("person@example.test", {
      redirectTo: "https://vortex.example.test/auth/update-password",
    });
  });

  it("returns the same recovery acknowledgement for unknown and unavailable identities", async () => {
    authority.resetPasswordForEmail
      .mockResolvedValueOnce({ data: {}, error: { message: "not found" } })
      .mockRejectedValueOnce(new Error("authority unavailable"));

    await expect(requestPasswordRecovery(configuration, "unknown@example.test")).resolves.toEqual({
      ok: true,
    });
    await expect(requestPasswordRecovery(configuration, "unknown@example.test")).resolves.toEqual({
      ok: true,
    });
  });

  it("returns one request-local credential pair only after password sign-in", async () => {
    await expect(
      signInWithPassword(configuration, "person@example.test", "secure-pass-1"),
    ).resolves.toEqual({
      ok: true,
      accessToken: `${"a".repeat(32)}.${"b".repeat(32)}.${"c".repeat(32)}`,
      refreshToken: "verified-refresh-token",
    });

    authority.signInWithPassword.mockResolvedValueOnce({
      data: { session: null },
      error: { message: "invalid" },
    });
    await expect(
      signInWithPassword(configuration, "person@example.test", "secure-pass-1"),
    ).resolves.toEqual({ ok: false, code: "vortex.identity.invalid_credentials" });
  });

  it("requires a letter and number only when creating or replacing a password", async () => {
    await expect(
      requestRegistration(configuration, "person@example.test", "letters-only"),
    ).resolves.toEqual({ ok: false, code: "vortex.identity.invalid_input" });
    await expect(
      completePasswordRecovery(
        configuration,
        `${"a".repeat(32)}.${"b".repeat(32)}.${"c".repeat(32)}`,
        "refresh-token-value",
        "12345678",
      ),
    ).resolves.toEqual({ ok: false, code: "vortex.identity.invalid_input" });
    await expect(
      signInWithPassword(configuration, "person@example.test", "legacy-pass"),
    ).resolves.toMatchObject({ ok: true, refreshToken: "verified-refresh-token" });

    expect(authority.signUp).not.toHaveBeenCalled();
    expect(authority.setSession).not.toHaveBeenCalled();
  });

  it("confirms email and completes recovery without persisting a session", async () => {
    const accessToken = `${"a".repeat(32)}.${"b".repeat(32)}.${"c".repeat(32)}`;
    const refreshToken = "refresh-token-value";

    await expect(confirmEmail(configuration, accessToken)).resolves.toEqual({ ok: true });
    await expect(
      completePasswordRecovery(configuration, accessToken, refreshToken, "new-secure-pass-2"),
    ).resolves.toEqual({ ok: true });

    expect(authority.getUser).toHaveBeenCalledWith(accessToken);
    expect(authority.setSession).toHaveBeenCalledWith({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    expect(authority.updateUser).toHaveBeenCalledWith({ password: "new-secure-pass-2" });
    expect(createClient).toHaveBeenCalledWith(
      configuration.supabaseUrl,
      configuration.publishableKey,
      expect.objectContaining({
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
      }),
    );
  });

  it("refuses malformed or provider-refused callback credentials", async () => {
    await expect(confirmEmail(configuration, "not-a-token")).resolves.toEqual({
      ok: false,
      code: "vortex.identity.invalid_or_expired_link",
    });
    expect(authority.getUser).not.toHaveBeenCalled();

    const accessToken = `${"a".repeat(32)}.${"b".repeat(32)}.${"c".repeat(32)}`;
    authority.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "refused" },
    });
    authority.setSession.mockResolvedValueOnce({
      data: { session: null },
      error: { message: "refused" },
    });

    await expect(confirmEmail(configuration, accessToken)).resolves.toEqual({
      ok: false,
      code: "vortex.identity.invalid_or_expired_link",
    });
    await expect(
      completePasswordRecovery(configuration, accessToken, "refresh-token", "new-secure-pass-2"),
    ).resolves.toEqual({ ok: false, code: "vortex.identity.invalid_or_expired_link" });
    expect(authority.updateUser).not.toHaveBeenCalled();
  });

  it.each([
    {
      ...configuration,
      supabaseUrl: "https://user:password@authority.example.test",
    },
    { ...configuration, publishableKey: "eyJlegacy.payload.signature" },
    { ...configuration, publishableKey: "sb_secret_not-allowed" },
    { ...configuration, publishableKey: "service_role_not-allowed" },
    { ...configuration, siteUrl: "https://vortex.example.test/unapproved" },
  ])("fails closed for an unsafe authority configuration", async (unsafeConfiguration) => {
    await expect(
      signInWithPassword(unsafeConfiguration, "person@example.test", "secure-pass-1"),
    ).resolves.toEqual({ ok: false, code: "vortex.identity.authority_unavailable" });
    expect(authority.signInWithPassword).not.toHaveBeenCalled();
  });
});
