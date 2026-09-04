import { describe, expect, it, vi } from "vitest";
import { createProtectedSiteFetch } from "../tooling/protected-site-request.mjs";

describe("hosted identity proof protected-site requests", () => {
  it("sends the automation bypass only as a request header", async () => {
    const bypassSecret = "proof-only-secret-value";
    const fetchImplementation = vi.fn(async () => new Response(null, { status: 204 }));
    const fetchProtectedSite = createProtectedSiteFetch(
      fetchImplementation,
      "https://vortex-testing.abzum.com",
      bypassSecret,
    );

    await fetchProtectedSite("/auth/sign-in?state=safe", {
      headers: { origin: "https://vortex-testing.abzum.com" },
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [requestUrl, init] = fetchImplementation.mock.calls[0]!;
    expect(requestUrl.toString()).toBe("https://vortex-testing.abzum.com/auth/sign-in?state=safe");
    expect(requestUrl.toString()).not.toContain(bypassSecret);
    expect(init.headers.get("x-vercel-protection-bypass")).toBe(bypassSecret);
    expect(init.headers.get("origin")).toBe("https://vortex-testing.abzum.com");
  });

  it("refuses cross-origin and non-origin site inputs", async () => {
    const fetchImplementation = vi.fn();
    const fetchProtectedSite = createProtectedSiteFetch(
      fetchImplementation,
      "https://vortex-testing.abzum.com",
      "proof-secret",
    );

    await expect(fetchProtectedSite("//example.com/auth/sign-in")).rejects.toThrow(
      "cannot leave the configured origin",
    );
    expect(() =>
      createProtectedSiteFetch(
        fetchImplementation,
        "https://vortex-testing.abzum.com/auth",
        "proof-secret",
      ),
    ).toThrow("must contain only its origin");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
