import { type NextRequest, NextResponse } from "next/server";
import { getIdentityJourneyConfiguration } from "./app/auth/_lib/authority-configuration";
import {
  createIdentitySessionClient,
  readIdentitySessionProvider,
} from "./app/auth/_lib/supabase-session-client";
import { mapWebError } from "./app/_lib/web-error-mapper";
import { identitySessionCookieDeletions } from "./app/auth/_lib/session-cookie";
import {
  forwardedIdentitySessionHeaders,
  requestMatchesConfiguredSite,
  type IdentitySessionProxyState,
} from "./app/auth/_lib/session-request-state";
import { privateResponse } from "./app/_lib/private-response";
import { requestAddressHeader, requestAddressOf } from "./app/_lib/request-address";

export async function proxy(request: NextRequest) {
  const isPage = !/^\/api(?:\/|$)/.test(request.nextUrl.pathname);
  let policy: string | undefined;
  if (isPage) {
    const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
    const supabaseOrigin = process.env.VORTEX_SUPABASE_URL
      ? new URL(process.env.VORTEX_SUPABASE_URL).origin
      : undefined;
    const componentOrigin = process.env.VORTEX_COMPONENT_BUNDLE_ORIGIN
      ? new URL(process.env.VORTEX_COMPONENT_BUNDLE_ORIGIN).origin
      : undefined;
    policy = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self'${supabaseOrigin ? ` ${supabaseOrigin}` : ""}`,
      `frame-src 'self'${componentOrigin ? ` ${componentOrigin}` : ""}`,
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join("; ");
  }
  const responseFor = (state: IdentitySessionProxyState): NextResponse => {
    const headers = forwardedIdentitySessionHeaders(request.headers, state);
    // The application frame layout projects the frame of the page this request addresses.
    headers.set(requestAddressHeader, requestAddressOf(request.nextUrl));
    if (policy !== undefined) headers.set("Content-Security-Policy", policy);
    const response = NextResponse.next({ request: { headers } });
    if (policy !== undefined) response.headers.set("Content-Security-Policy", policy);
    return response;
  };

  // A sign-in submission supersedes whatever session the browser still holds. Contacting the
  // provider with that old pair would try to refresh a token that no longer exists (for example
  // after a database reset) and would only add a deletion of the cookies the action is about to
  // replace, so the submission is forwarded without touching the provider.
  if (request.method === "POST" && request.nextUrl.pathname === "/auth/sign-in")
    return privateResponse(responseFor("missing"));

  // These mutations own their cookie rotation. Running refresh here as well would race it.
  if (request.nextUrl.pathname === "/auth/session" && request.method !== "GET")
    return privateResponse(responseFor("missing"));

  // The cleanup route verifies its own first-party proof against the original cookies.
  // Processing them here could delete or rotate the cookie before that verification.
  if (request.nextUrl.pathname === "/auth/session-ended")
    return privateResponse(responseFor("missing"));

  let response = responseFor("temporarily_unavailable");
  let boundary: ReturnType<typeof createIdentitySessionClient>;
  try {
    const configuration = getIdentityJourneyConfiguration();
    if (!requestMatchesConfiguredSite(request.headers, request.nextUrl, configuration.siteUrl))
      return privateResponse(response);
    boundary = createIdentitySessionClient(
      request.cookies.getAll().map(({ name, value }) => ({ name, value })),
    );
  } catch (error) {
    return mapWebError(error, {
      route: "auth/session",
      operation: "create-proxy-session-client",
      code: "SESSION_CLIENT_UNAVAILABLE",
      fallback: privateResponse(response),
    });
  }

  if (boundary.stage.initialState.kind === "invalid") {
    response = responseFor("invalid");
    for (const mutation of identitySessionCookieDeletions(boundary.profile))
      response.cookies.set(mutation.name, mutation.value, mutation.options);
    return privateResponse(response);
  }
  if (boundary.stage.initialState.kind === "missing") return responseFor("missing");

  // One retry absorbs a transient provider or key-set fetch failure so the first load after
  // sign-in is not shown as unavailable; a second failure is still reported as unavailable.
  const claims = await readIdentitySessionProvider(
    "get-claims",
    () => boundary.client.auth.getClaims(),
    true,
  );
  const staged = boundary.stage.snapshot();
  if (staged.refused || (claims.ok ? !claims.data : claims.state === "invalid")) {
    response = responseFor("invalid");
    for (const mutation of identitySessionCookieDeletions(boundary.profile))
      response.cookies.set(mutation.name, mutation.value, mutation.options);
    return privateResponse(response);
  }
  if (!claims.ok) return privateResponse(responseFor("temporarily_unavailable"));
  if (staged.mutations.length > 0) {
    // Make the refreshed pair visible to Server Components in this same request,
    // then emit the identical mutations to the browser response.
    for (const mutation of staged.mutations) {
      if (mutation.value.length === 0 || mutation.options.maxAge === 0)
        request.cookies.delete(mutation.name);
      else request.cookies.set(mutation.name, mutation.value);
    }
    response = responseFor("verified");
    for (const mutation of staged.mutations)
      response.cookies.set(mutation.name, mutation.value, mutation.options);
    for (const [name, value] of Object.entries(staged.headers)) response.headers.set(name, value);
    return privateResponse(response);
  }
  return privateResponse(responseFor("verified"));
}

export const config = {
  // Static Next assets, immutable component bundles, content-addressed document styles (only the
  // exact `<name>-<16 hex>.css` shape; never widen it to the whole folder), images and the public
  // health check bypass the session proxy; keep application paths covered even when a tenant is
  // named "api" or "health".
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/components/|api/document-styles/[a-z]+-[a-f0-9]{16}\\.css$|health$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
