import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  applicationRootIdSchema,
  moduleRootIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  queryIdSchema,
  recordIdSchema,
} from "@vortex/contracts";

/**
 * What a continuation token carries: the exact actor, installation, query,
 * release and inputs it was issued for, and the last keyset position the
 * database reader reached. The position may belong to a row the caller cannot
 * read (a scan budget can end on one), so the whole payload is encrypted as
 * well as authenticated: the token is opaque, not merely tamper-evident.
 */
export const queryContinuationSchema = z
  .object({
    version: z.literal(1),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    moduleRootId: moduleRootIdSchema,
    queryId: queryIdSchema,
    moduleReleaseRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    /** Exact typed sort values as canonical database text; never parsed as numbers here. */
    sortKey: z.array(z.string().max(16_384).nullable()).min(1).max(20),
    recordId: recordIdSchema,
  })
  .strict();
export type QueryContinuation = z.infer<typeof queryContinuationSchema>;

/** A server-held 256-bit key; the secret never lives in this package or in a token. */
export type QueryContinuationKey = Readonly<{ key: Uint8Array }>;

export class QueryContinuationTokenError extends Error {
  constructor() {
    super("vortex.query.continuation_token_invalid");
    this.name = "QueryContinuationTokenError";
  }
}

const tokenVersion = 1;
const nonceLength = 12;
const tagLength = 16;
const associatedData = Buffer.from("vortex.query.continuation.v1", "utf8");

const cipherKey = (key: QueryContinuationKey): Buffer => {
  if (!(key.key instanceof Uint8Array) || key.key.byteLength !== 32)
    throw new Error("QUERY_CONTINUATION_KEY_INVALID");
  return Buffer.from(key.key);
};

/** Deterministic, key-order-independent JSON used to bind a token to its exact inputs. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

export const fingerprintQueryInputs = (inputValues: Readonly<Record<string, unknown>>): string =>
  createHash("sha256").update(canonicalJson(inputValues), "utf8").digest("hex");

/** Encrypts and authenticates one validated continuation (AES-256-GCM). */
export const encodeQueryContinuationToken = (
  continuation: QueryContinuation,
  key: QueryContinuationKey,
): string => {
  const payload = Buffer.from(JSON.stringify(queryContinuationSchema.parse(continuation)), "utf8");
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(key), nonce, { authTagLength: tagLength });
  cipher.setAAD(associatedData);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([
    Buffer.from([tokenVersion]),
    nonce,
    cipher.getAuthTag(),
    encrypted,
  ]).toString("base64url");
};

/** Decrypts and verifies a token; any tamper, foreign key or shape defect is one error. */
export const decodeQueryContinuationToken = (
  token: string,
  key: QueryContinuationKey,
): QueryContinuation => {
  const secret = cipherKey(key);
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new QueryContinuationTokenError();
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length <= 1 + nonceLength + tagLength || bytes[0] !== tokenVersion)
      throw new QueryContinuationTokenError();
    const nonce = bytes.subarray(1, 1 + nonceLength);
    const tag = bytes.subarray(1 + nonceLength, 1 + nonceLength + tagLength);
    const encrypted = bytes.subarray(1 + nonceLength + tagLength);
    const decipher = createDecipheriv("aes-256-gcm", secret, nonce, { authTagLength: tagLength });
    decipher.setAAD(associatedData);
    decipher.setAuthTag(tag);
    const payload = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const parsed = queryContinuationSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) throw new QueryContinuationTokenError();
    return parsed.data;
  } catch {
    throw new QueryContinuationTokenError();
  }
};
