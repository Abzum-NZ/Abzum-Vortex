import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { QueryContinuationKey } from "./continuation-token";

const tokenVersion = 1;
const nonceLength = 12;
const tagLength = 16;

const cipherKey = (key: QueryContinuationKey): Buffer => {
  if (!(key.key instanceof Uint8Array) || key.key.byteLength !== 32)
    throw new Error("SEALED_TOKEN_KEY_INVALID");
  return Buffer.from(key.key);
};

/**
 * Encrypts and authenticates one JSON payload (AES-256-GCM) for one purpose. The purpose is the
 * authenticated associated data, so a token sealed for one purpose never opens as another, and the
 * browser holds an opaque token it can neither read nor edit. Every sealed token the platform hands
 * out (query and activity continuations, account choices, record selections, pivot positions) is
 * sealed here.
 */
export const sealToken = (key: QueryContinuationKey, purpose: string, payload: unknown): string => {
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(key), nonce, { authTagLength: tagLength });
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([tokenVersion]),
    nonce,
    cipher.getAuthTag(),
    encrypted,
  ]).toString("base64url");
};

type SealedTokenOpening =
  | Readonly<{ kind: "opened"; payload: unknown }>
  | Readonly<{ kind: "refused"; cause: "token_malformed" | "token_not_authentic" }>;

/**
 * Opens a token sealed for the same purpose with the same key. A malformed, tampered, foreign-key
 * or other-purpose token is refused with its cause; the caller validates the payload's shape.
 */
export const openToken = (
  key: QueryContinuationKey,
  purpose: string,
  token: string,
): SealedTokenOpening => {
  const secret = cipherKey(key);
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return { kind: "refused", cause: "token_malformed" };
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length <= 1 + nonceLength + tagLength || bytes[0] !== tokenVersion)
    return { kind: "refused", cause: "token_malformed" };
  try {
    const decipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(1, 1 + nonceLength), {
      authTagLength: tagLength,
    });
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(bytes.subarray(1 + nonceLength, 1 + nonceLength + tagLength));
    const text = Buffer.concat([
      decipher.update(bytes.subarray(1 + nonceLength + tagLength)),
      decipher.final(),
    ]).toString("utf8");
    return { kind: "opened", payload: JSON.parse(text) };
    // guard-allow: silent-catch Any decryption or parse failure means the token is not authentic and is refused.
  } catch {
    return { kind: "refused", cause: "token_not_authentic" };
  }
};
