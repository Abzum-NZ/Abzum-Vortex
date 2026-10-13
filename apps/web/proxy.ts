import { isAuthRefreshDiscardedError, isAuthRetryableFetchError } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { getIdentityJourneyConfiguration } from "./app/auth/_lib/authority-configuration";
import { createIdentitySessionClient } from "./app/auth/_lib/supabase-session-client";
import { identitySessionCookieDeletions } from "./app/auth/_lib/session-cookie";
import {
  forwardedIdentitySessionHeaders,
  requestMatchesConfiguredSite,
  type IdentitySessionProxyState,
} from "./app/auth/_lib/session-request-state";
import { privateResponse } from "./app/_lib/private-response";

export async function proxy(request: NextRequest) {
  const responseFor = (state: IdentitySessionProxyState): NextResponse =>
    NextResponse.next({
      request: { headers: forwardedIdentitySessionHeaders(request.headers, state) },
    });

  // A sign-in submission supersedes whatever session the browser still holds. Contacting the
  // provider with that old pair would try to refresh a token that no longer exists (for example
  // after a database reset) and would only add a deletion of the cookies the action is about to
  // replace, so the submission is forwarded without touching the provider.
  if (request.method === "POST" && request.nextUrl.pathname === "/auth/sign-in")
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
  } catch {
    return privateResponse(response);
  }

  if (boundary.stage.initialState.kind === "invalid") {
    response = responseFor("invalid");
    for (const mutation of identitySessionCookieDeletions(boundary.profile))
      response.cookies.set(mutation.name, mutation.value, mutation.options);
    return privateResponse(response);
  }
  if (boundary.stage.initialState.kind === "missing") return responseFor("missing");

  let claims = await boundary.client.auth.getClaims();
  // One retry absorbs a transient provider or key-set fetch failure so the first load after
  // sign-in is not shown as unavailable; a second failure is still reported as unavailable.
  if (claims.error && isAuthRetryableFetchError(claims.error))
    claims = await boundary.client.auth.getClaims();
  const staged = boundary.stage.snapshot();
  if (staged.refused) {
    response = responseFor("invalid");
    for (const mutation of identitySessionCookieDeletions(boundary.profile))
      response.cookies.set(mutation.name, mutation.value, mutation.options);
    return privateResponse(response);
  }
  if (
    (!claims.data && !claims.error) ||
    (claims.error &&
      !isAuthRetryableFetchError(claims.error) &&
      !isAuthRefreshDiscardedError(claims.error))
  ) {
    response = responseFor("invalid");
    for (const mutation of identitySessionCookieDeletions(boundary.profile))
      response.cookies.set(mutation.name, mutation.value, mutation.options);
    return privateResponse(response);
  }
  if (claims.error) return privateResponse(responseFor("temporarily_unavailable"));
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
  // Static Next assets, immutable component bundles, images and the exact public health check
  // bypass the session proxy; keep application paths covered even when a tenant is named "api"
  // or "health". The install manifest stays covered: it needs the verified session header.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/components/|health$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
