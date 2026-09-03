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
if (![apiUrl, publishableKey, mailpitUrl].every((value) => typeof value === "string" && value))
  throw new Error("Local Supabase status did not provide the required public endpoints and key");

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

const waitForMessage = async (kind) => {
  const deadline = Date.now() + 15_000;
  const query = encodeURIComponent(`to:${email}`);
  while (Date.now() < deadline) {
    const response = await globalThis.fetch(`${mailpitUrl}/view/latest.txt?query=${query}`);
    if (response.ok) {
      const text = await response.text();
      if (text.includes(`type=${kind}`)) return text;
    }
    await delay(250);
  }
  throw new Error(`Mailpit did not capture the Local ${kind} message`);
};

const verificationLink = (message, kind) => {
  const match = message.match(/https?:\/\/[^\s<>"']+\/auth\/v1\/verify\?[^\s<>"']+/);
  if (!match) throw new Error(`The Local ${kind} message has no verification link`);
  const link = new URL(match[0].replaceAll("&amp;", "&"));
  if (
    link.origin !== new URL(apiUrl).origin ||
    link.pathname !== "/auth/v1/verify" ||
    link.searchParams.get("type") !== kind
  )
    throw new Error(`The Local ${kind} message contains an unexpected verification destination`);
  return link;
};

const followVerificationLink = async (link, kind) => {
  const response = await globalThis.fetch(link, { redirect: "manual" });
  if (response.status < 300 || response.status >= 400)
    throw new Error(`Local Auth refused the ${kind} verification link`);
};

const signup = await client.auth.signUp({ email, password });
if (signup.error)
  throw new Error(`Local email-and-password signup failed (${signup.error.code ?? "unknown"})`);
if (signup.data.session !== null)
  throw new Error("Local email-and-password signup did not await confirmation");
await followVerificationLink(verificationLink(await waitForMessage("signup"), "signup"), "signup");

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

await delay(5_100);
const recovery = await client.auth.resetPasswordForEmail(email, {
  redirectTo: "http://127.0.0.1:3000",
});
if (recovery.error) throw new Error("Local password recovery request failed");
await followVerificationLink(
  verificationLink(await waitForMessage("recovery"), "recovery"),
  "recovery",
);

process.stdout.write(
  "Local Auth proof passed: ES256 JWKS, confirmation, password sign-in, getClaims, and recovery.\n",
);
