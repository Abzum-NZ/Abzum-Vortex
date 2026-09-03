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
const email = `local-proof-${randomUUID()}@example.test`;
const password = `${randomUUID()}aA7!`;
const replacementPassword = `${randomUUID()}bB8!`;

const submitForm = async (pathname, values) => {
  const pageResponse = await globalThis.fetch(`${siteUrl}${pathname}`);
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
    headers: { origin: siteUrl },
    redirect: "manual",
  });
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
    throw new Error("The Local identity journey returned an unexpected destination");
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

const verificationLink = (message, pathname, type) => {
  const match = message.match(/https?:\/\/[^\s<>"']+\/auth\/[^\s<>"']+#[^\s<>"']+/);
  if (!match) throw new Error("The Local identity message has no verification link");
  const link = new URL(match[0].replaceAll("&amp;", "&"));
  const fragment = new globalThis.URLSearchParams(link.hash.slice(1));
  if (
    link.origin !== "http://127.0.0.1:3000" ||
    link.pathname !== pathname ||
    fragment.get("type") !== type ||
    !fragment.get("token_hash")
  )
    throw new Error("The Local identity message contains an unexpected verification destination");
  return link;
};

expectRedirect(
  await submitForm("/auth/register", { email, password }),
  "/auth/check-email",
  "?purpose=confirmation",
);

const unconfirmedSignIn = await client.auth.signInWithPassword({ email, password });
if (!unconfirmedSignIn.error || unconfirmedSignIn.data.session)
  throw new Error("Local Auth allowed an unconfirmed identity to sign in");

const confirmationLink = verificationLink(await waitForMessage("email"), "/auth/confirm", "email");
expectRedirect(
  await submitForm(confirmationLink.pathname, {
    token_hash: new globalThis.URLSearchParams(confirmationLink.hash.slice(1)).get("token_hash"),
    type: "email",
  }),
  "/auth/success",
  "?state=email-confirmed",
);

expectRedirect(
  await submitForm("/auth/sign-in", { email, password }),
  "/auth/success",
  "?state=signed-in",
);

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

await delay(5_100);
expectRedirect(
  await submitForm("/auth/recover", { email }),
  "/auth/check-email",
  "?purpose=recovery",
);

const recoveryLink = verificationLink(
  await waitForMessage("recovery"),
  "/auth/update-password",
  "recovery",
);
const recoveryFragment = new globalThis.URLSearchParams(recoveryLink.hash.slice(1));
expectRedirect(
  await submitForm(recoveryLink.pathname, {
    token_hash: recoveryFragment.get("token_hash"),
    password: replacementPassword,
  }),
  "/auth/success",
  "?state=password-updated",
);

const freshClient = () =>
  createClient(apiUrl, publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
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
  "Local Auth proof passed through the App Router: ES256 JWKS, confirmation, Vortex verification, neutral recovery, password update, and old/new password checks.\n",
);
