import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  applicationRootIdSchema,
  jsonValueSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  queryIdSchema,
  recordIdSchema,
  stableDefinitionReleaseVersionSchema,
  type ApplicationRootId,
  type JsonValue,
  type ModuleRootId,
  type OrganizationId,
  type QueryId,
  type RecordId,
} from "@vortex/contracts";

/**
 * Exact identity and order position an opaque continuation token carries. It
 * names the query/release/scope it belongs to and the caller's last-seen
 * position in the deterministic keyset order, never a raw database cursor,
 * row offset or storage-target identity.
 */
export const queryContinuationPositionSchema = z
  .object({
    version: z.literal(1),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    queryId: queryIdSchema,
    sortKey: z.array(jsonValueSchema),
    tiebreakerRecordId: recordIdSchema,
  })
  .strict();

export type QueryContinuationPosition = z.infer<typeof queryContinuationPositionSchema>;

export type QueryContinuationPositionInput = Readonly<{
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  moduleRootId: ModuleRootId;
  moduleReleaseVersion: string;
  queryId: QueryId;
  sortKey: readonly JsonValue[];
  tiebreakerRecordId: RecordId;
}>;

/** Signs and verifies continuation payloads; the secret never lives in this package. */
export interface QueryContinuationSigner {
  sign(payload: string): string;
}

const toBase64Url = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64url");

const fromBase64Url = (value: string): string | undefined => {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
};

export const createHmacQueryContinuationSigner = (secret: string): QueryContinuationSigner => ({
  sign: (payload: string) => createHmac("sha256", secret).update(payload).digest("hex"),
});

export class QueryContinuationTokenError extends Error {
  constructor(readonly reason: "malformed" | "tampered" | "position_invalid") {
    super(`vortex.query.continuation_token_${reason}`);
    this.name = "QueryContinuationTokenError";
  }
}

/** Encodes a validated order position into an opaque, integrity-bound token. */
export const encodeQueryContinuationToken = (
  position: QueryContinuationPositionInput,
  signer: QueryContinuationSigner,
): string => {
  const parsed = queryContinuationPositionSchema.parse({ version: 1, ...position });
  const encodedPayload = toBase64Url(JSON.stringify(parsed));
  const signature = signer.sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
};

/** Decodes and verifies a continuation token, refusing on any tamper or shape defect. */
export const decodeQueryContinuationToken = (
  token: string,
  signer: QueryContinuationSigner,
): QueryContinuationPosition => {
  const separatorIndex = token.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === token.length - 1)
    throw new QueryContinuationTokenError("malformed");
  const encodedPayload = token.slice(0, separatorIndex);
  const suppliedSignature = token.slice(separatorIndex + 1);

  const expectedSignature = signer.sign(encodedPayload);
  const expected = Buffer.from(expectedSignature, "hex");
  const supplied = Buffer.from(suppliedSignature, "hex");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    throw new QueryContinuationTokenError("tampered");

  const decodedPayload = fromBase64Url(encodedPayload);
  if (decodedPayload === undefined) throw new QueryContinuationTokenError("malformed");

  let candidate: unknown;
  try {
    candidate = JSON.parse(decodedPayload);
  } catch {
    throw new QueryContinuationTokenError("malformed");
  }

  const parsed = queryContinuationPositionSchema.safeParse(candidate);
  if (!parsed.success) throw new QueryContinuationTokenError("position_invalid");
  return parsed.data;
};
