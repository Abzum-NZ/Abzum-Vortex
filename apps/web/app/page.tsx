import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { identitySessionNavigationHint } from "./auth/_lib/session-request-state";

export const dynamic = "force-dynamic";

/**
 * The public root is not a page of its own. A verified session continues to the organisation
 * chooser; every other state goes to sign-in, so no runtime inventory is exposed here.
 */
export default async function HomePage() {
  const sessionState = identitySessionNavigationHint(await headers());
  redirect(sessionState === "verified" ? "/signed-in" : "/auth/sign-in");
}
