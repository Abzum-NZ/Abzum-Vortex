import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createProtectedSiteFetch } from "../tooling/protected-site-request.mjs";

const listen = async (server: ReturnType<typeof createServer>): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

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
    expect(init.redirect).toBe("manual");
  });

  it("does not follow a cross-origin redirect with the bypass header", async () => {
    const bypassSecret = "redirect-bound-secret";
    let secondOriginRequestCount = 0;
    let leakedHeader: string | undefined;
    const secondOrigin = createServer((request, response) => {
      secondOriginRequestCount += 1;
      leakedHeader = request.headers["x-vercel-protection-bypass"];
      response.writeHead(204).end();
    });
    const secondOriginUrl = await listen(secondOrigin);
    const firstOrigin = createServer((_request, response) => {
      response.writeHead(302, { location: `${secondOriginUrl}/capture` }).end();
    });
    const firstOriginUrl = await listen(firstOrigin);

    try {
      const fetchProtectedSite = createProtectedSiteFetch(
        globalThis.fetch,
        firstOriginUrl,
        bypassSecret,
      );
      const response = await fetchProtectedSite("/redirect", { redirect: "follow" });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`${secondOriginUrl}/capture`);
      expect(secondOriginRequestCount).toBe(0);
      expect(leakedHeader).toBeUndefined();
    } finally {
      await Promise.all([close(firstOrigin), close(secondOrigin)]);
    }
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
