import "server-only";

import type { QueryContinuationKey } from "@vortex/query";

const environmentName = "VORTEX_QUERY_CONTINUATION_KEY";
const keyByteLength = 32;

/**
 * The server-held key that makes Query continuation tokens opaque and bound. It is read only on the
 * server from `VORTEX_QUERY_CONTINUATION_KEY` (base64, exactly 32 bytes) and is never generated,
 * defaulted, logged or exposed to the browser. A missing or invalid value is a configuration error,
 * so no page can read data with a guessable token key.
 */
export const getQueryContinuationKey = (): QueryContinuationKey => {
  const encoded = process.env[environmentName]?.trim();
  if (!encoded) throw new Error(`Missing required server configuration: ${environmentName}`);
  // 32 bytes encode to exactly 43 base64 characters plus one padding character.
  const key = Buffer.from(encoded, "base64");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || key.length !== keyByteLength)
    throw new Error(`Invalid server configuration: ${environmentName} must be 32 bytes, base64 encoded`);
  return { key: new Uint8Array(key) };
};
