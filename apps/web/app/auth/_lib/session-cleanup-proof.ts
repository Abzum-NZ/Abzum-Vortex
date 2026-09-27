import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { identitySessionCookieProfile, type SessionCookie } from "./session-cookie";

const proofLifetimeSeconds = 30;
const proofPurpose = "vortex-session-ended-v1";

const sessionKey = (cookies: readonly SessionCookie[], siteUrl: string): string | undefined => {
  const name = identitySessionCookieProfile(siteUrl).name;
  const sessionCookies = cookies
    .filter((cookie) => cookie.name === name || cookie.name.startsWith(`${name}.`))
    .sort((left, right) => left.name.localeCompare(right.name));
  return sessionCookies.length > 0 ? JSON.stringify(sessionCookies) : undefined;
};

const signature = (key: string, siteUrl: string, issuedAt: string, nonce: string): Buffer =>
  createHmac("sha256", key)
    .update(`${proofPurpose}:${new URL(siteUrl).origin}:${issuedAt}:${nonce}`)
    .digest();

/** A proof is useful only with the same browser's session cookies and expires after 30 seconds. */
export const issueSessionCleanupProof = (
  cookies: readonly SessionCookie[],
  siteUrl: string,
): string | undefined => {
  const key = sessionKey(cookies, siteUrl);
  if (key === undefined) return undefined;
  const issuedAt = String(Math.floor(Date.now() / 1_000));
  const nonce = randomBytes(16).toString("hex");
  return `${issuedAt}.${nonce}.${signature(key, siteUrl, issuedAt, nonce).toString("hex")}`;
};

export const verifiesSessionCleanupProof = (
  proof: string | null,
  cookies: readonly SessionCookie[],
  siteUrl: string,
): boolean => {
  if (proof === null || !/^[0-9]{10}\.[0-9a-f]{32}\.[0-9a-f]{64}$/u.test(proof)) return false;
  const [issuedAt, nonce, supplied] = proof.split(".");
  if (issuedAt === undefined || nonce === undefined || supplied === undefined) return false;
  const age = Math.floor(Date.now() / 1_000) - Number(issuedAt);
  if (age < 0 || age > proofLifetimeSeconds) return false;
  const key = sessionKey(cookies, siteUrl);
  if (key === undefined) return false;
  return timingSafeEqual(Buffer.from(supplied, "hex"), signature(key, siteUrl, issuedAt, nonce));
};
