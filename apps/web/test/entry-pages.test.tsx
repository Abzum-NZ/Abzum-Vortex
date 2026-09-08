import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn());
const requestHeaders = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("next/headers", () => ({ headers: vi.fn(async () => requestHeaders) }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../app/auth/actions", () => ({ signIn: vi.fn() }));

import FoundationPage from "../app/page";
import SignInPage from "../app/auth/sign-in/page";

const renderHome = async (): Promise<string> => renderToStaticMarkup(await FoundationPage());
const renderSignIn = async (status?: string): Promise<string> =>
  renderToStaticMarkup(
    await SignInPage({ searchParams: Promise.resolve(status ? { status } : {}) }),
  );

describe("session-aware entry pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers the protected launcher from the homepage for a verified session", async () => {
    requestHeaders.get.mockReturnValue("verified");

    const html = await renderHome();

    expect(html).toContain('href="/signed-in"');
    expect(html).toContain("Continue to Vortex");
    expect(html).not.toContain("Secure sign in");
  });

  it.each(["missing", "invalid"])(
    "retains secure sign-in entry for a %s session marker",
    async (state) => {
      requestHeaders.get.mockReturnValue(state);

      const html = await renderHome();

      expect(html).toContain('href="/auth/sign-in"');
      expect(html).toContain("Secure sign in");
      expect(html).not.toContain("Continue to Vortex");
    },
  );

  it.each(["temporarily_unavailable", "unexpected", null])(
    "keeps homepage account access neutral for marker %s",
    async (state) => {
      requestHeaders.get.mockReturnValue(state);

      const html = await renderHome();

      expect(html).toContain('href="/auth/sign-in"');
      expect(html).toContain("Account access");
      expect(html).not.toContain("Secure sign in");
      expect(html).not.toContain("Continue to Vortex");
    },
  );

  it("redirects a verified sign-in page request to the protected launcher", async () => {
    requestHeaders.get.mockReturnValue("verified");
    redirect.mockImplementationOnce(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(renderSignIn()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/signed-in");
  });

  it.each(["missing", "invalid"])(
    "retains the password form for a %s session marker",
    async (state) => {
      requestHeaders.get.mockReturnValue(state);

      const html = await renderSignIn("invalid_credentials");

      expect(html).toContain("Sign in");
      expect(html).toContain('name="email"');
      expect(html).toContain('name="password"');
      expect(html).toContain("The email address or password was not accepted.");
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it.each(["temporarily_unavailable", "unexpected", null])(
    "shows neutral retry without a password form for marker %s",
    async (state) => {
      requestHeaders.get.mockReturnValue(state);

      const html = await renderSignIn();

      expect(html).toContain("Account access is temporarily unavailable");
      expect(html).toContain("could not confirm this browser session");
      expect(html).toContain('href="/auth/sign-in"');
      expect(html).toContain("Try again");
      expect(html).not.toContain('name="password"');
      expect(html).not.toContain("signed out");
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it("uses a fresh document request when retrying unavailable verification", async () => {
    requestHeaders.get.mockReturnValue("temporarily_unavailable");

    const page = await SignInPage({ searchParams: Promise.resolve({}) });
    if (!isValidElement<{ children?: ReactNode }>(page)) throw new Error("Expected page element");
    const retry = page.props.children;
    if (!isValidElement<{ href?: string }>(retry)) throw new Error("Expected retry element");

    expect(retry.type).toBe("a");
    expect(retry.props.href).toBe("/auth/sign-in");
  });
});
