import { isAuthRefreshDiscardedError, isAuthRetryableFetchError } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { getIdentityJourneyConfiguration } from "./app/auth/_lib/authority-configuration";
import { createIdentitySessionClient } from "./app/auth/_lib/supabase-session-client";
import { identitySessionCookieDeletions } from "./app/auth/_lib/session-cookie";

const privateResponse = (response: NextResponse): NextResponse => {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
};

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  let boundary: ReturnType<typeof createIdentitySessionClient>;
  try {
    getIdentityJourneyConfiguration();
    boundary = createIdentitySessionClient(
      request.cookies.getAll().map(({ name, value }) => ({ name, value })),
    );
  } catch {
    return privateResponse(response);
  }

  if (boundary.stage.initialState.kind === "invalid") {
    for (const mutation of identitySessionCookieDeletions(boundary.profile))
      response.cookies.set(mutation.name, mutation.value, mutation.options);
    return privateResponse(response);
  }
  if (boundary.stage.initialState.kind === "missing") return response;

  const claims = await boundary.client.auth.getClaims();
  const staged = boundary.stage.snapshot();
  if (staged.refused) {
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
    for (const mutation of identitySessionCookieDeletions(boundary.profile))
      response.cookies.set(mutation.name, mutation.value, mutation.options);
    return privateResponse(response);
  }
  if (staged.mutations.length > 0) {
    // Make the refreshed pair visible to Server Components in this same request,
    // then emit the identical mutations to the browser response.
    for (const mutation of staged.mutations) request.cookies.set(mutation.name, mutation.value);
    response = NextResponse.next({ request });
    for (const mutation of staged.mutations)
      response.cookies.set(mutation.name, mutation.value, mutation.options);
    for (const [name, value] of Object.entries(staged.headers)) response.headers.set(name, value);
    return privateResponse(response);
  }
  return privateResponse(response);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
