import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry) throw new Error("Run this proof through `pnpm auth:testing:proof`");

const requiredEnvironmentValue = (name) => {
  const value = process.env[name];
  if (!value || value.trim().length === 0)
    throw new Error(`Missing required Testing proof configuration: ${name}`);
  return value;
};

const apiUrl = requiredEnvironmentValue("VORTEX_TESTING_AUTH_API_URL");
const publishableKey = requiredEnvironmentValue("VORTEX_TESTING_AUTH_PUBLISHABLE_KEY");
const siteUrl = requiredEnvironmentValue("VORTEX_TESTING_SITE_URL");
const emailTemplate = requiredEnvironmentValue("VORTEX_TESTING_AUTH_EMAIL");
const mailtrapApiToken = requiredEnvironmentValue("VORTEX_TESTING_MAILTRAP_API_TOKEN");
const mailtrapAccountId = requiredEnvironmentValue("VORTEX_TESTING_MAILTRAP_ACCOUNT_ID");
const mailtrapInboxId = requiredEnvironmentValue("VORTEX_TESTING_MAILTRAP_INBOX_ID");
const productionApiUrl = requiredEnvironmentValue("VORTEX_PRODUCTION_AUTH_API_URL");
const expectedTestingApiUrl = "https://abflfptnguasinoussws.supabase.co";
const expectedTestingSiteUrl = "https://abzum-vortex-git-testing-abzumdevteam.vercel.app";
const expectedProductionApiUrl = "https://nkvcbtwsjhkgqhosqeib.supabase.co";

const uniqueEmail = (template) => {
  const proofId = randomUUID();
  if (template.includes("{proof_id}")) return template.replace("{proof_id}", proofId);
  const separator = template.lastIndexOf("@");
  if (separator <= 0) throw new Error("Testing proof email is invalid");
  return `${template.slice(0, separator)}+${proofId}@${template.slice(separator + 1)}`;
};
const email = uniqueEmail(emailTemplate);

if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))
  throw new Error("Testing proof requires the modern public publishable key");
if (siteUrl !== expectedTestingSiteUrl)
  throw new Error("The hosted proof is not using the exact Testing site");
if (apiUrl !== expectedTestingApiUrl)
  throw new Error("The hosted proof is not using the exact Testing authority");
if (productionApiUrl !== expectedProductionApiUrl)
  throw new Error("The hosted proof is not using the exact Production authority metadata");

const healthResponse = await globalThis.fetch(`${siteUrl}/health`).catch(() => undefined);
if (!healthResponse?.ok) throw new Error("The hosted Testing Vortex application is unavailable");

const jwksResponse = await globalThis.fetch(`${apiUrl}/auth/v1/.well-known/jwks.json`);
if (!jwksResponse.ok) throw new Error("The Testing Auth JWKS endpoint is unavailable");
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
  throw new Error("Testing Auth is not publishing a public P-256 ES256 signing key");

const client = createClient(apiUrl, publishableKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const password = `${randomUUID()}aA7!`;
const replacementPassword = `${randomUUID()}bB8!`;

const submitForm = async (pathname, values) => {
  const pageResponse = await globalThis.fetch(`${siteUrl}${pathname}`);
  if (!pageResponse.ok) throw new Error("The hosted Testing identity journey page is unavailable");
  const page = await pageResponse.text();
  const actionName = page.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
  if (!actionName) throw new Error("The Testing identity journey has no progressive form action");

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
    throw new Error("The Testing identity journey did not complete with a safe redirect");
  return new URL(location, siteUrl);
};

const expectRedirect = (location, pathname, expectedSearch) => {
  if (
    location.origin !== siteUrl ||
    location.pathname !== pathname ||
    (expectedSearch && location.search !== expectedSearch)
  )
    throw new Error("The Testing identity journey returned an unexpected destination");
};

const mailtrapHeaders = Object.freeze({ "Api-Token": mailtrapApiToken });
const mailtrapPath = (suffix) =>
  `https://mailtrap.io/api/accounts/${encodeURIComponent(mailtrapAccountId)}/inboxes/${encodeURIComponent(mailtrapInboxId)}${suffix}`;

const readMailtrapBody = async (messageId) => {
  for (const extension of ["body.txt", "body.html"]) {
    const response = await globalThis.fetch(
      mailtrapPath(`/messages/${encodeURIComponent(messageId)}/${extension}`),
      { headers: mailtrapHeaders },
    );
    if (response.ok) return response.text();
  }
  throw new Error("Mailtrap did not expose the captured Testing message body");
};

const waitForMessage = async (expectedType) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await globalThis.fetch(mailtrapPath("/messages"), {
      headers: mailtrapHeaders,
    });
    if (!response.ok) throw new Error("Mailtrap Testing inbox is unavailable");
    const messages = await response.json();
    if (!Array.isArray(messages)) throw new Error("Mailtrap returned an invalid message list");
    for (const message of messages) {
      const recipients = JSON.stringify(message?.to_email ?? message?.to ?? "");
      if (!recipients.includes(email) || message?.id === undefined) continue;
      const body = await readMailtrapBody(message.id);
      if (body.includes(`type=${expectedType}`)) return body;
    }
    await delay(500);
  }
  throw new Error("Mailtrap did not capture the expected Testing identity message");
};

const verificationLink = (message, pathname, type) => {
  const match = message.match(/https?:\/\/[^\s<>"']+\/auth\/[^\s<>"']+#[^\s<>"']+/);
  if (!match) throw new Error("The Testing identity message has no verification link");
  const link = new URL(match[0].replaceAll("&amp;", "&"));
  const fragment = new globalThis.URLSearchParams(link.hash.slice(1));
  if (
    link.origin !== siteUrl ||
    link.pathname !== pathname ||
    fragment.get("type") !== type ||
    !fragment.get("token_hash")
  )
    throw new Error("The Testing identity message contains an unexpected verification destination");
  return link;
};

expectRedirect(
  await submitForm("/auth/register", { email, password }),
  "/auth/check-email",
  "?purpose=confirmation",
);

const unconfirmedSignIn = await client.auth.signInWithPassword({ email, password });
if (!unconfirmedSignIn.error || unconfirmedSignIn.data.session)
  throw new Error("Testing Auth allowed an unconfirmed identity to sign in");

const confirmationLink = verificationLink(await waitForMessage("email"), "/auth/confirm", "email");
expectRedirect(
  await submitForm(confirmationLink.pathname, {
    token_hash: new globalThis.URLSearchParams(confirmationLink.hash.slice(1)).get("token_hash"),
    type: "email",
  }),
  "/auth/success",
  "?state=email-confirmed",
);

const signin = await client.auth.signInWithPassword({ email, password });
if (signin.error || !signin.data.session?.access_token)
  throw new Error("Testing password sign-in failed after email confirmation");

expectRedirect(
  await submitForm("/auth/sign-in", { email, password }),
  "/auth/success",
  "?state=signed-in",
);

const verifierProof = spawnSync(
  process.execPath,
  [
    pnpmEntry,
    "exec",
    "vitest",
    "run",
    "runtime/identity/test/testing-verifier.integration.test.ts",
  ],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      VORTEX_TESTING_AUTH_API_URL: apiUrl,
      VORTEX_TESTING_AUTH_PUBLISHABLE_KEY: publishableKey,
      VORTEX_TESTING_AUTH_ACCESS_TOKEN: signin.data.session.access_token,
      VORTEX_TESTING_AUTH_EXPECTED_IDENTITY_ID: signin.data.user.id,
      VORTEX_TESTING_AUTH_EXPECTED_EMAIL: email,
      VORTEX_PRODUCTION_AUTH_API_URL: productionApiUrl,
    },
  },
);
if (verifierProof.status !== 0)
  throw new Error("The Vortex verifier did not accept the Testing identity safely");

await delay(61_000);
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
expectRedirect(
  await submitForm(recoveryLink.pathname, {
    token_hash: new globalThis.URLSearchParams(recoveryLink.hash.slice(1)).get("token_hash"),
    password: replacementPassword,
  }),
  "/auth/success",
  "?state=password-updated",
);

const freshClient = () =>
  createClient(apiUrl, publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
if (!(await freshClient().auth.signInWithPassword({ email, password })).error)
  throw new Error("The old Testing password remained valid after recovery");
if ((await freshClient().auth.signInWithPassword({ email, password: replacementPassword })).error)
  throw new Error("The replacement Testing password did not sign in");

await delay(61_000);
expectRedirect(
  await submitForm("/auth/recover", { email: `unknown-${randomUUID()}@example.test` }),
  "/auth/check-email",
  "?purpose=recovery",
);

process.stdout.write(
  "Hosted Testing Auth proof passed: ES256 JWKS, Mailtrap confirmation and recovery, independent Vortex verification, cross-environment refusal, neutral recovery, and password replacement.\n",
);
