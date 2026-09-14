import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { requestMatchesConfiguredSite } from "../app/auth/_lib/session-request-state";

const siteUrl = "https://vortex.example.test";
const requestUrl = new URL("https://vortex.example.test/signed-in");
const internalRequestUrl = new URL("http://vortex.example.test/signed-in");

describe("requestMatchesConfiguredSite (issue #410 finding 4: pinned, unchanged)", () => {
  it("accepts a matching host with no forwarded headers", () => {
    expect(
      requestMatchesConfiguredSite(
        new Headers({ host: "vortex.example.test" }),
        requestUrl,
        siteUrl,
      ),
    ).toBe(true);
  });

  it("honours a single x-forwarded-proto value over the request URL's own protocol", () => {
    expect(
      requestMatchesConfiguredSite(
        new Headers({ host: "vortex.example.test", "x-forwarded-proto": "https" }),
        internalRequestUrl,
        siteUrl,
      ),
    ).toBe(true);
  });

  it("takes only the first value of a comma-separated x-forwarded-proto list", () => {
    expect(
      requestMatchesConfiguredSite(
        new Headers({ host: "vortex.example.test", "x-forwarded-proto": "https, http" }),
        internalRequestUrl,
        siteUrl,
      ),
    ).toBe(true);
    expect(
      requestMatchesConfiguredSite(
        new Headers({ host: "vortex.example.test", "x-forwarded-proto": "http, https" }),
        internalRequestUrl,
        siteUrl,
      ),
    ).toBe(false);
  });

  it("rejects a mismatched host", () => {
    expect(
      requestMatchesConfiguredSite(
        new Headers({ host: "attacker.example.test" }),
        requestUrl,
        siteUrl,
      ),
    ).toBe(false);
  });

  it("does not let a differing x-forwarded-host change the outcome", () => {
    // Deliberate position (issue #410, finding 4): requestMatchesConfiguredSite reads only
    // the "host" header. Trusting "x-forwarded-host" would accept a client-settable header,
    // so it stays unread here until a proxy or CDN is actually placed in front of the app.
    const withoutForwardedHost = requestMatchesConfiguredSite(
      new Headers({ host: "vortex.example.test" }),
      requestUrl,
      siteUrl,
    );
    const withDifferingForwardedHost = requestMatchesConfiguredSite(
      new Headers({
        host: "vortex.example.test",
        "x-forwarded-host": "attacker.example.test",
      }),
      requestUrl,
      siteUrl,
    );

    expect(withoutForwardedHost).toBe(true);
    expect(withDifferingForwardedHost).toBe(withoutForwardedHost);
  });
});
