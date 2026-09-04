import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry) throw new Error("Run this proof through `pnpm auth:local:proof`");

const statusResult = spawnSync(
  process.execPath,
  [pnpmEntry, "exec", "supabase", "status", "--output", "json"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
);
let status;
try {
  status = JSON.parse(statusResult.stdout);
} catch {
  throw new Error("The Local Supabase Auth services are not running");
}
const apiUrl = status.API_URL;
const publishableKey = status.PUBLISHABLE_KEY;
const mailpitUrl = status.MAILPIT_URL;
const siteUrl = "http://127.0.0.1:3000";
if (![apiUrl, publishableKey, mailpitUrl].every((value) => typeof value === "string" && value))
  throw new Error("Local Supabase status did not provide the required public endpoints and key");

const healthResponse = await globalThis.fetch(`${siteUrl}/health`).catch(() => undefined);
if (!healthResponse?.ok)
  throw new Error("Start the Local Vortex web application before running the identity proof");

const jwksResponse = await globalThis.fetch(`${apiUrl}/auth/v1/.well-known/jwks.json`);
if (!jwksResponse.ok) throw new Error("The Local Auth JWKS endpoint is unavailable");
const jwks = await jwksResponse.json();
if (
  !Array.isArray(jwks.keys) ||
  !jwks.keys.some(
    (key) =>
      key?.alg === "ES256" &&
      key?.kty === "EC" &&
      key?.crv === "P-256" &&
      typeof key?.kid === "string" &&
      !("d" in key),
  )
)
  throw new Error("Local Auth is not publishing a public P-256 ES256 signing key");

const client = createClient(apiUrl, publishableKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const freshClient = () =>
  createClient(apiUrl, publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
const email = `local-proof-${randomUUID()}@example.test`;
const password = `${randomUUID()}aA7!`;
const replacementPassword = `${randomUUID()}bB8!`;

const sessionCookies = new Map();
let lastSetCookieLines = [];
const cookieHeader = (jar) =>
  [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
const applySetCookies = (response, jar) => {
  const lines = response.headers.getSetCookie();
  for (const line of lines) {
    const match = line.match(/^([^=;]+)=([^;]*)/u);
    if (!match) throw new Error("The Local application returned a malformed session cookie");
    if (/;\s*Max-Age=0(?:;|$)/iu.test(line)) jar.delete(match[1]);
    else jar.set(match[1], match[2]);
  }
  return lines;
};

const submitForm = async (pathname, values, jar = new Map()) => {
  const cookie = cookieHeader(jar);
  const pageResponse = await globalThis.fetch(`${siteUrl}${pathname}`, {
    headers: cookie ? { cookie } : undefined,
  });
  if (!pageResponse.ok) throw new Error("The Local identity journey page is unavailable");
  const page = await pageResponse.text();
  const actionName = page.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
  if (!actionName) throw new Error("The Local identity journey has no progressive form action");

  const form = new globalThis.FormData();
  form.set(actionName, "");
  for (const [name, value] of Object.entries(values)) form.set(name, value);

  const response = await globalThis.fetch(`${siteUrl}${pathname}`, {
    method: "POST",
    body: form,
    headers: { origin: siteUrl, ...(cookie ? { cookie } : {}) },
    redirect: "manual",
  });
  lastSetCookieLines = applySetCookies(response, jar);
  const location = response.headers.get("location");
  if (response.status !== 303 || !location)
    throw new Error("The Local identity journey did not complete with a safe redirect");
  return new URL(location, siteUrl);
};

const expectRedirect = (location, pathname, expectedSearch) => {
  if (
    location.origin !== siteUrl ||
    location.pathname !== pathname ||
    (expectedSearch && location.search !== expectedSearch)
  )
    throw new Error(
      `The Local identity journey returned an unexpected destination: ${location.pathname}${location.search}`,
    );
};

const waitForMessage = async (expectedType) => {
  const deadline = Date.now() + 15_000;
  const query = encodeURIComponent(`to:${email}`);
  while (Date.now() < deadline) {
    const response = await globalThis.fetch(`${mailpitUrl}/view/latest.txt?query=${query}`);
    if (response.ok) {
      const text = await response.text();
      if (text.includes(`type=${expectedType}`)) return text;
    }
    await delay(250);
  }
  throw new Error(`Mailpit did not capture the expected Local identity message`);
};

const verificationSession = async (message, pathname, type) => {
  const match = message.match(/https?:\/\/[^\s<>"']+\/auth\/v1\/verify\?[^\s<>"']+/);
  if (!match) throw new Error("The Local identity message has no verification link");
  const link = new URL(match[0].replaceAll("&amp;", "&"));
  if (
    link.origin !== new URL(apiUrl).origin ||
    link.pathname !== "/auth/v1/verify" ||
    link.searchParams.get("type") !== type
  )
    throw new Error("The Local identity message contains an unexpected verification authority");

  const response = await globalThis.fetch(link, { redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || !location)
    throw new Error("The Local identity authority did not return a safe application redirect");

  const sessionUrl = new URL(location, siteUrl);
  const fragment = new globalThis.URLSearchParams(sessionUrl.hash.slice(1));
  if (
    sessionUrl.origin !== siteUrl ||
    sessionUrl.pathname !== pathname ||
    fragment.get("type") !== type ||
    !fragment.get("access_token") ||
    !fragment.get("refresh_token")
  )
    throw new Error("The Local identity authority returned an unexpected session destination");
  return sessionUrl;
};

expectRedirect(
  await submitForm("/auth/register", { email, password }),
  "/auth/check-email",
  "?purpose=confirmation",
);

const unconfirmedSignIn = await client.auth.signInWithPassword({ email, password });
if (!unconfirmedSignIn.error || unconfirmedSignIn.data.session)
  throw new Error("Local Auth allowed an unconfirmed identity to sign in");

const confirmationLink = await verificationSession(
  await waitForMessage("signup"),
  "/auth/confirm",
  "signup",
);
const confirmationFragment = new globalThis.URLSearchParams(confirmationLink.hash.slice(1));
const confirmationCookies = new Map();
expectRedirect(
  await submitForm(
    confirmationLink.pathname,
    {
      access_token: confirmationFragment.get("access_token"),
      type: "signup",
    },
    confirmationCookies,
  ),
  "/auth/success",
  "?state=email-confirmed",
);
if (confirmationCookies.size !== 0)
  throw new Error("Email confirmation persisted a Local browser session");

expectRedirect(
  await submitForm("/auth/sign-in", { email, password }, sessionCookies),
  "/signed-in",
);
if (
  lastSetCookieLines.length === 0 ||
  !lastSetCookieLines.every(
    (line) =>
      line.startsWith("vortex-local-session") &&
      /;\s*HttpOnly/iu.test(line) &&
      /;\s*SameSite=Lax/iu.test(line) &&
      /;\s*Path=\//iu.test(line) &&
      !/;\s*Secure/iu.test(line) &&
      !/;\s*Domain=/iu.test(line),
  )
)
  throw new Error("The Local identity session did not use the exact server-cookie profile");

const secondBrowserCookies = new Map();
expectRedirect(
  await submitForm("/auth/sign-in", { email, password }, secondBrowserCookies),
  "/signed-in",
);
const signedInPage = await globalThis.fetch(`${siteUrl}/signed-in`, {
  headers: { cookie: cookieHeader(sessionCookies) },
});
if (!signedInPage.ok || !(await signedInPage.text()).includes("No organisations available"))
  throw new Error("The Local protected identity-session page was unavailable");

expectRedirect(
  await submitForm("/signed-in", {}, sessionCookies),
  "/auth/sign-in",
  "?status=signed-out",
);
if (sessionCookies.size !== 0)
  throw new Error("Local sign-out did not clear the complete browser cookie family");
const independentBrowser = await globalThis.fetch(`${siteUrl}/signed-in`, {
  headers: { cookie: cookieHeader(secondBrowserCookies) },
});
if (
  !independentBrowser.ok ||
  !(await independentBrowser.text()).includes("No organisations available")
)
  throw new Error("Signing out one Local browser ended an independent browser session");

const signin = await client.auth.signInWithPassword({ email, password });
if (signin.error || !signin.data.session?.access_token)
  throw new Error("Local password sign-in failed after email confirmation");
const verified = await client.auth.getClaims(signin.data.session.access_token);
if (
  verified.error ||
  !verified.data ||
  verified.data.header.alg !== "ES256" ||
  typeof verified.data.header.kid !== "string" ||
  verified.data.claims.email !== email ||
  verified.data.claims.sub !== signin.data.user.id ||
  verified.data.claims.aud !== "authenticated" ||
  verified.data.claims.role !== "authenticated" ||
  verified.data.claims.is_anonymous !== false
)
  throw new Error("The official client did not verify the expected closed Local identity inputs");

const verifierProof = spawnSync(
  process.execPath,
  [pnpmEntry, "exec", "vitest", "run", "runtime/identity/test/local-verifier.integration.test.ts"],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      VORTEX_LOCAL_AUTH_API_URL: apiUrl,
      VORTEX_LOCAL_AUTH_PUBLISHABLE_KEY: publishableKey,
      VORTEX_LOCAL_AUTH_ACCESS_TOKEN: signin.data.session.access_token,
      VORTEX_LOCAL_AUTH_EXPECTED_IDENTITY_ID: signin.data.user.id,
      VORTEX_LOCAL_AUTH_EXPECTED_EMAIL: email,
    },
  },
);
if (verifierProof.status !== 0)
  throw new Error("The Vortex verifier did not accept the expected Local identity");

const refreshed = await client.auth.refreshSession(signin.data.session);
if (refreshed.error || !refreshed.data.session)
  throw new Error("The Local authority did not rotate an ordinary session");
const refreshedClaims = await client.auth.getClaims(refreshed.data.session.access_token);
if (
  refreshedClaims.error ||
  !refreshedClaims.data ||
  refreshedClaims.data.claims.sub !== verified.data.claims.sub ||
  refreshedClaims.data.claims.session_id !== verified.data.claims.session_id
)
  throw new Error("Ordinary Local refresh changed the verified identity or session identifier");

const parallelRefreshes = await Promise.all([
  freshClient().auth.refreshSession(signin.data.session),
  freshClient().auth.refreshSession(signin.data.session),
]);
const usableParallelSessions = parallelRefreshes
  .filter((result) => !result.error && result.data.session)
  .map((result) => result.data.session);
if (usableParallelSessions.length === 0)
  throw new Error("Concurrent Local refresh did not converge to any usable provider session");
for (const session of usableParallelSessions) {
  const claims = await freshClient().auth.getClaims(session.access_token);
  if (
    claims.error ||
    !claims.data ||
    claims.data.claims.sub !== verified.data.claims.sub ||
    claims.data.claims.session_id !== verified.data.claims.session_id
  )
    throw new Error("Concurrent Local refresh crossed an identity or session boundary");
}

await delay(5_100);
expectRedirect(
  await submitForm("/auth/recover", { email }),
  "/auth/check-email",
  "?purpose=recovery",
);

const recoveryLink = await verificationSession(
  await waitForMessage("recovery"),
  "/auth/update-password",
  "recovery",
);
const recoveryFragment = new globalThis.URLSearchParams(recoveryLink.hash.slice(1));
const recoveryCookies = new Map();
expectRedirect(
  await submitForm(
    recoveryLink.pathname,
    {
      access_token: recoveryFragment.get("access_token"),
      refresh_token: recoveryFragment.get("refresh_token"),
      password: replacementPassword,
    },
    recoveryCookies,
  ),
  "/auth/success",
  "?state=password-updated",
);
if (recoveryCookies.size !== 0)
  throw new Error("Password recovery persisted a Local browser session");

const oldPasswordSignIn = await freshClient().auth.signInWithPassword({ email, password });
if (!oldPasswordSignIn.error)
  throw new Error("The old Local password remained valid after recovery");
const newPasswordSignIn = await freshClient().auth.signInWithPassword({
  email,
  password: replacementPassword,
});
if (newPasswordSignIn.error || !newPasswordSignIn.data.session)
  throw new Error("The replacement Local password did not sign in");

await delay(5_100);
expectRedirect(
  await submitForm("/auth/recover", { email: `unknown-${randomUUID()}@example.test` }),
  "/auth/check-email",
  "?purpose=recovery",
);

process.stdout.write(
  "Local Auth proof passed through the App Router: ES256 JWKS, confirmation, verified server-only sessions, ordinary and concurrent refresh continuity, browser-isolated sign-out, neutral recovery, password update, and old/new password checks.\n",
);
