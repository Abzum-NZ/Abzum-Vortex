import { beforeEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  verifyOtp: vi.fn(),
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
      data: { session: { access_token: "verified-access-token" } },
      error: null,
    });
    authority.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    authority.verifyOtp.mockResolvedValue({ data: { session: {} }, error: null });
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

  it("returns a transient access token only after password sign-in", async () => {
    await expect(
      signInWithPassword(configuration, "person@example.test", "secure-pass-1"),
    ).resolves.toEqual({ ok: true, accessToken: "verified-access-token" });

    authority.signInWithPassword.mockResolvedValueOnce({
      data: { session: null },
      error: { message: "invalid" },
    });
    await expect(
      signInWithPassword(configuration, "person@example.test", "secure-pass-1"),
    ).resolves.toEqual({ ok: false, code: "vortex.identity.invalid_credentials" });
  });

  it("confirms email and completes recovery without persisting a session", async () => {
    const tokenHash = "a".repeat(64);

    await expect(confirmEmail(configuration, tokenHash)).resolves.toEqual({ ok: true });
    await expect(
      completePasswordRecovery(configuration, tokenHash, "new-secure-pass-2"),
    ).resolves.toEqual({ ok: true });

    expect(authority.verifyOtp).toHaveBeenNthCalledWith(1, {
      token_hash: tokenHash,
      type: "email",
    });
    expect(authority.verifyOtp).toHaveBeenNthCalledWith(2, {
      token_hash: tokenHash,
      type: "recovery",
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
