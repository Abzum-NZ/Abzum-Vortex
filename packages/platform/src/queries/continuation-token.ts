import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  applicationRootIdSchema,
  moduleRootIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  queryIdSchema,
  recordIdSchema,
  revisionSchema,
} from "../catalogue/identifiers";
import { canonicalJson } from "../definition/canonical-json";
import { openToken, sealToken } from "./sealed-token";

/**
 * What a continuation token carries: the exact actor, installation, query,
 * release, inputs, declared sort and pushed fields it was issued for, and the last keyset position the
 * database reader reached. The sort key holds only values of fields the reader
 * is guaranteed to see, so it never carries a hidden field value; the record
 * identifier may still name a row the reader cannot read, so the whole payload
 * is encrypted as well as authenticated: the token is opaque, not merely
 * tamper-evident. An empty sort key is valid when the reader may not safely
 * order on any declared sort field, and the scan then orders by record identity.
 */
const queryContinuationSchema = z
  .object({
    version: z.literal(1),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    moduleRootId: moduleRootIdSchema,
    queryId: queryIdSchema,
    moduleReleaseRevision: revisionSchema,
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    direction: z.enum(["forward", "backward"]),
    sort: z
      .array(
        z
          .object({
            fieldId: z.string().uuid(),
            direction: z.enum(["ascending", "descending"]),
            pushed: z.boolean(),
          })
          .strict(),
      )
      .max(20),
    /**
     * Exact typed values of the readable sort fields, as canonical database
     * text; never parsed as numbers here. Empty when none may be pushed.
     */
    sortKey: z.array(z.string().max(16_384).nullable()).max(20),
    phase: z.enum(["null", "value"]),
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

const purpose = "vortex.query.continuation.v1";

export const fingerprintQueryInputs = (inputValues: Readonly<Record<string, unknown>>): string =>
  createHash("sha256").update(canonicalJson(inputValues), "utf8").digest("hex");

/** Encrypts and authenticates one validated continuation (AES-256-GCM). */
export const encodeQueryContinuationToken = (
  continuation: QueryContinuation,
  key: QueryContinuationKey,
): string => sealToken(key, purpose, queryContinuationSchema.parse(continuation));

/** Decrypts and verifies a token; any tamper, foreign key or shape defect is one error. */
export const decodeQueryContinuationToken = (
  token: string,
  key: QueryContinuationKey,
): QueryContinuation => {
  const opening = openToken(key, purpose, token);
  if (opening.kind === "refused") throw new QueryContinuationTokenError();
  const parsed = queryContinuationSchema.safeParse(opening.payload);
  if (!parsed.success) throw new QueryContinuationTokenError();
  return parsed.data;
};
