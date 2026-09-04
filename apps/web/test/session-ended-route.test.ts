import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET } from "../app/auth/session-ended/route";

describe("conclusive identity-session cleanup route", () => {
  beforeEach(() => {
    vi.stubEnv("VORTEX_SUPABASE_URL", "https://identity.example.test");
    vi.stubEnv("VORTEX_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test-value");
    vi.stubEnv("VORTEX_SITE_URL", "https://vortex.example.test");
  });

  it("clears the complete hosted cookie family and redirects to the fixed sign-in result", () => {
    const response = GET(
      new NextRequest("https://vortex.example.test/auth/session-ended", {
        headers: { host: "vortex.example.test" },
      }),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://vortex.example.test/auth/sign-in?status=session-ended",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(setCookie).toContain("__Host-vortex-session=");
    expect(setCookie).toContain("__Host-vortex-session.7=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
  });

  it("does not emit a cookie outside the configured site origin", () => {
    const response = GET(
      new NextRequest("https://preview.example.test/auth/session-ended", {
        headers: { host: "preview.example.test" },
      }),
    );

    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
