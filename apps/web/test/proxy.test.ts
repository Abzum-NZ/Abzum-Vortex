import { AuthRetryableFetchError } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getClaims = vi.hoisted(() => vi.fn());
const createIdentitySessionClient = vi.hoisted(() => vi.fn());
vi.mock("../app/auth/_lib/supabase-session-client", () => ({ createIdentitySessionClient }));

import { proxy } from "../proxy";
import { identitySessionProxyHeader } from "../app/auth/_lib/session-request-state";

const profile = {
  name: "__Host-vortex-session",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  priority: "high",
} as const;

const boundary = (
  initialState: Readonly<{ kind: "missing" | "valid" | "invalid" }>,
  snapshot: () => Readonly<{
    refused: boolean;
    mutations: ReadonlyArray<{
      name: string;
      value: string;
      options: Record<string, unknown>;
    }>;
    headers: Readonly<Record<string, string>>;
  }>,
) => ({
  client: { auth: { getClaims } },
  profile,
  stage: { initialState, snapshot },
});

const request = (cookie = "__Host-vortex-session=original") =>
  new NextRequest("https://vortex.example.test/signed-in", {
    headers: {
      host: "vortex.example.test",
      cookie,
      [identitySessionProxyHeader]: "verified",
    },
  });

const forwardedState = (response: Response): string | null =>
  response.headers.get(`x-middleware-request-${identitySessionProxyHeader}`);

describe("Next.js identity-session Proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VORTEX_SUPABASE_URL", "https://identity.example.test");
    vi.stubEnv("VORTEX_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test-value");
    vi.stubEnv("VORTEX_SITE_URL", "https://vortex.example.test");
  });

  it("verifies a valid cookie on each matching request and prevents shared caching", async () => {
    getClaims.mockResolvedValue({ data: { claims: {} }, error: null });
    createIdentitySessionClient.mockReturnValue(
      boundary({ kind: "valid" }, () => ({ refused: false, mutations: [], headers: {} })),
    );

    const response = await proxy(request());

    expect(getClaims).toHaveBeenCalledOnce();
    expect(forwardedState(response)).toBe("verified");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("deletes stale chunks from the same request during a chunked-to-base rotation", async () => {
    const incoming = request("__Host-vortex-session.0=old-0; __Host-vortex-session.1=old-1");
    const options = {
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      priority: "high",
    } as const;
    getClaims.mockResolvedValue({ data: { claims: {} }, error: null });
    createIdentitySessionClient.mockReturnValue(
      boundary({ kind: "valid" }, () => ({
        refused: false,
        mutations: [
          { name: profile.name, value: "rotated-base", options },
          { name: `${profile.name}.0`, value: "", options: { ...options, maxAge: 0 } },
          { name: `${profile.name}.1`, value: "", options: { ...options, maxAge: 0 } },
        ],
        headers: {},
      })),
    );

    const response = await proxy(incoming);

    expect(incoming.cookies.get(profile.name)?.value).toBe("rotated-base");
    expect(incoming.cookies.get(`${profile.name}.0`)).toBeUndefined();
    expect(incoming.cookies.get(`${profile.name}.1`)).toBeUndefined();
    expect(forwardedState(response)).toBe("verified");
  });

  it("makes a provider rotation visible to this request and emits the same secure cookie", async () => {
    const incoming = request();
    const mutation = {
      name: profile.name,
      value: "rotated",
      options: {
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        priority: "high",
      },
    } as const;
    getClaims.mockResolvedValue({ data: { claims: {} }, error: null });
    createIdentitySessionClient.mockReturnValue(
      boundary({ kind: "valid" }, () => ({
        refused: false,
        mutations: [mutation],
        headers: { "Cache-Control": "private, no-store", "X-Auth-Refresh": "present" },
      })),
    );

    const response = await proxy(incoming);

    expect(incoming.cookies.get(profile.name)?.value).toBe("rotated");
    expect(response.headers.get("x-auth-refresh")).toBe("present");
    expect(response.headers.get("set-cookie")).toContain("__Host-vortex-session=rotated");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("preserves the original cookie on a retryable provider failure before rotation", async () => {
    getClaims.mockResolvedValue({
      data: null,
      error: new AuthRetryableFetchError("temporary", 503),
    });
    createIdentitySessionClient.mockReturnValue(
      boundary({ kind: "valid" }, () => ({ refused: false, mutations: [], headers: {} })),
    );

    const response = await proxy(request());

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(forwardedState(response)).toBe("temporarily_unavailable");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    {
      name: "a conclusive provider refusal",
      initial: { kind: "valid" } as const,
      claims: { data: null, error: new Error("invalid") },
      refused: false,
    },
    {
      name: "non-canonical cookie state",
      initial: { kind: "invalid" } as const,
      claims: undefined,
      refused: false,
    },
    {
      name: "a refused library cookie mutation",
      initial: { kind: "valid" } as const,
      claims: { data: { claims: {} }, error: null },
      refused: true,
    },
  ])("clears the complete cookie family for $name", async ({ initial, claims, refused }) => {
    if (claims) getClaims.mockResolvedValue(claims);
    createIdentitySessionClient.mockReturnValue(
      boundary(initial, () => ({ refused, mutations: [], headers: {} })),
    );

    const response = await proxy(request());
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(setCookie).toContain("__Host-vortex-session=");
    expect(setCookie).toContain("__Host-vortex-session.7=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(forwardedState(response)).toBe("invalid");
  });

  it("refuses an actual request origin outside the configured site", async () => {
    vi.stubEnv("VORTEX_SITE_URL", "http://127.0.0.1:3000");
    const response = await proxy(
      new NextRequest("http://192.0.2.10:3000/signed-in", {
        headers: { host: "192.0.2.10:3000", cookie: "vortex-local-session=credential" },
      }),
    );

    expect(createIdentitySessionClient).not.toHaveBeenCalled();
    expect(forwardedState(response)).toBe("temporarily_unavailable");
  });
});
