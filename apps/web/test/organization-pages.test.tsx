import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn());
const resolveIdentitySession = vi.hoisted(() => vi.fn());
const loadOrganizationLauncher = vi.hoisted(() => vi.fn());
const loadSelectedOrganization = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../app/auth/_lib/session-server", () => ({ resolveIdentitySession }));
vi.mock("../app/_lib/organization-context", () => ({
  loadOrganizationLauncher,
  loadSelectedOrganization,
}));
vi.mock("../app/auth/actions", () => ({ signOut: vi.fn() }));

import OrganizationPage from "../app/organizations/[organizationId]/page";
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
    loadSelectedOrganization.mockResolvedValue({ kind: "available", entry });
  });

  it("renders a neutral multi-organisation launcher without hidden scope fields", async () => {
    const html = renderToStaticMarkup(await SignedInPage());
    expect(html).toContain("Choose an organisation");
    expect(html).toContain("Example organisation");
    expect(html).toContain(`/organizations/${id(3)}`);
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
    expect(redirect).toHaveBeenCalledWith(`/organizations/${id(3)}`);
  });

  it("awaits the dynamic route and renders only safe selected labels", async () => {
    const html = renderToStaticMarkup(
      await OrganizationPage({ params: Promise.resolve({ organizationId: id(3) }) }),
    );
    expect(loadSelectedOrganization).toHaveBeenCalledWith(active.session, id(3));
    expect(html).toContain("Example tenant");
    expect(html).toContain("Example organisation");
    expect(html).toContain("Example person");
    expect(html).toContain("Switch organisation");
  });

  it("uses one neutral unavailable page for refused selections", async () => {
    loadSelectedOrganization.mockResolvedValueOnce({ kind: "unavailable" });
    const html = renderToStaticMarkup(
      await OrganizationPage({ params: Promise.resolve({ organizationId: id(99) }) }),
    );
    expect(html).toContain("Organisation unavailable");
    expect(html).not.toContain(id(99));
  });

  it("keeps a selected-organisation dependency failure retryable", async () => {
    loadSelectedOrganization.mockResolvedValueOnce({ kind: "temporarily_unavailable" });
    const html = renderToStaticMarkup(
      await OrganizationPage({ params: Promise.resolve({ organizationId: id(3) }) }),
    );
    expect(html).toContain("Organisation is temporarily unavailable");
    expect(html).toContain("Your sign-in is still active");
  });
});
