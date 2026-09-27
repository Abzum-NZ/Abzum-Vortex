import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn());
const resolveIdentitySession = vi.hoisted(() => vi.fn());
const loadOrganizationLauncher = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../app/auth/_lib/session-server", () => ({ resolveIdentitySession }));
vi.mock("../app/_lib/organization-context", () => ({
  loadOrganizationLauncher,
}));
vi.mock("../app/auth/actions", () => ({ signOut: vi.fn() }));

import SignedInPage from "../app/signed-in/page";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const active = {
  kind: "active",
  session: {
    identityId: id(1),
    sessionId: id(2),
    authenticationStrength: "single_factor",
    accessTokenIssuedAt: "2026-09-05T00:00:00.000Z",
    accessTokenExpiresAt: "2026-09-05T01:00:00.000Z",
  },
};
const entry = {
  organizationId: id(3),
  tenantShortName: "example-tenant",
  organizationShortName: "example-organisation",
  tenantDisplayName: "Example tenant",
  organizationDisplayName: "Example organisation",
  accountDisplayName: "Example person",
};

describe("organisation pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveIdentitySession.mockResolvedValue(active);
    loadOrganizationLauncher.mockResolvedValue({
      kind: "available",
      entries: [entry, { ...entry, organizationId: id(4), organizationDisplayName: "Other" }],
    });
  });

  it("renders a neutral multi-organisation launcher without hidden scope fields", async () => {
    const html = renderToStaticMarkup(await SignedInPage());
    expect(html).toContain("Choose an organisation");
    expect(html).toContain("Example organisation");
    expect(html).not.toContain("accessVersion");
    expect(html).not.toContain("organizationAccountId");
  });

  it("renders a distinct signed-in empty launcher and retryable failure", async () => {
    loadOrganizationLauncher.mockResolvedValueOnce({ kind: "available", entries: [] });
    expect(renderToStaticMarkup(await SignedInPage())).toContain("No organisations available");

    loadOrganizationLauncher.mockResolvedValueOnce({ kind: "temporarily_unavailable" });
    const retry = renderToStaticMarkup(await SignedInPage());
    expect(retry).toContain("Your sign-in is still active");
    expect(retry).toContain("Try again");
  });

  it("redirects one active account to its fixed organisation route", async () => {
    loadOrganizationLauncher.mockResolvedValueOnce({ kind: "available", entries: [entry] });
    redirect.mockImplementationOnce(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(SignedInPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/example-tenant/example-organisation");
  });
});
