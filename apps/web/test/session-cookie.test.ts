import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createSessionCookieStage,
  identitySessionCookieDeletions,
  identitySessionCookieProfile,
  inspectIdentitySessionCookies,
  sessionCookieChunkSize,
  sessionCookieMaximumChunks,
} from "../app/auth/_lib/session-cookie";

describe("server-only identity-session cookies", () => {
  it("uses a valid host prefix only for secure hosted sites", () => {
    expect(identitySessionCookieProfile("https://vortex.example.test")).toEqual({
      name: "__Host-vortex-session",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      priority: "high",
    });
    expect(identitySessionCookieProfile("http://127.0.0.1:3000")).toMatchObject({
      name: "vortex-local-session",
      secure: false,
    });
    expect(() => identitySessionCookieProfile("http://example.test")).toThrow();
    expect(() => identitySessionCookieProfile("https://example.test/path")).toThrow();
  });

  it("accepts only one base value or one canonical bounded chunk sequence", () => {
    const profile = identitySessionCookieProfile("https://vortex.example.test");
    expect(inspectIdentitySessionCookies([], profile).kind).toBe("missing");
    expect(
      inspectIdentitySessionCookies([{ name: profile.name, value: "value" }], profile).kind,
    ).toBe("valid");
    expect(
      inspectIdentitySessionCookies(
        [
          { name: `${profile.name}.0`, value: "first" },
          { name: `${profile.name}.1`, value: "second" },
        ],
        profile,
      ).kind,
    ).toBe("valid");

    for (const cookies of [
      [
        { name: profile.name, value: "base" },
        { name: `${profile.name}.0`, value: "chunk" },
      ],
      [{ name: `${profile.name}.1`, value: "gap" }],
      [{ name: `${profile.name}.01`, value: "non-canonical" }],
      [{ name: `${profile.name}.x`, value: "not-decimal" }],
      [{ name: `${profile.name}.${sessionCookieMaximumChunks}`, value: "too-many" }],
      [
        { name: `${profile.name}.0`, value: "duplicate-a" },
        { name: `${profile.name}.0`, value: "duplicate-b" },
      ],
      [{ name: profile.name, value: "x".repeat(sessionCookieChunkSize + 1) }],
    ])
      expect(inspectIdentitySessionCookies(cookies, profile).kind).toBe("invalid");
  });

  it("overrides every security attribute and strips Domain for set and removal", () => {
    const profile = identitySessionCookieProfile("https://vortex.example.test");
    const stage = createSessionCookieStage([], profile);
    stage.setAll(
      [
        {
          name: profile.name,
          value: "value",
          options: {
            domain: "example.test",
            secure: false,
            httpOnly: false,
            sameSite: "none",
            path: "/unsafe",
          },
        },
      ],
      { "Cache-Control": "private, no-store" },
    );

    expect(stage.snapshot()).toMatchObject({
      refused: false,
      headers: { "Cache-Control": "private, no-store" },
      mutations: [
        {
          name: profile.name,
          options: {
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            path: "/",
            priority: "high",
          },
        },
      ],
    });
    expect(stage.snapshot().mutations[0]?.options).not.toHaveProperty("domain");
    expect(identitySessionCookieDeletions(profile)).toHaveLength(sessionCookieMaximumChunks + 1);
    expect(identitySessionCookieDeletions(profile)[0]).toMatchObject({
      value: "",
      options: { maxAge: 0, secure: true, httpOnly: true, path: "/" },
    });
  });

  it("refuses a library write outside the family or beyond the chunk bound", () => {
    const profile = identitySessionCookieProfile("https://vortex.example.test");
    const wrongName = createSessionCookieStage([], profile);
    wrongName.setAll([{ name: "another-cookie", value: "value", options: {} }]);
    expect(wrongName.snapshot()).toMatchObject({ refused: true, mutations: [] });

    const tooLarge = createSessionCookieStage([], profile);
    tooLarge.setAll([
      { name: profile.name, value: "x".repeat(sessionCookieChunkSize + 1), options: {} },
    ]);
    expect(tooLarge.snapshot()).toMatchObject({ refused: true, mutations: [] });
  });
});
