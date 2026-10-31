import "server-only";

import type { NextRequest } from "next/server";
import type { z } from "zod";
import { getIdentityJourneyConfiguration } from "../../auth/_lib/authority-configuration";
import { readBoundedRequestText } from "./bounded-request-body";

/**
 * The one admission gate for a JSON POST that must come from this site: a same-origin `Origin`
 * header and a JSON media type. Every JSON POST route checks exactly this before it reads a body,
 * so no route is looser than another about the request it accepts.
 */
export const isOwnSiteJsonRequest = (request: NextRequest): boolean => {
  const origin = request.headers.get("origin");
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    origin !== null &&
    origin === new URL(getIdentityJourneyConfiguration().siteUrl).origin &&
    mediaType === "application/json"
  );
};

/** One bounded JSON body read through its schema, with the cause of every refusal. */
export type JsonRequestBody<Value> =
  | Readonly<{ kind: "read"; value: Value }>
  | Readonly<{ kind: "too_large" }>
  | Readonly<{ kind: "unreadable" }>
  | Readonly<{ kind: "invalid"; error: z.ZodError }>;

/**
 * Reads one bounded JSON body and validates it against the request schema. A body over the limit
 * is `too_large`, a body that is not JSON is `unreadable`, and a body that does not match the
 * schema is `invalid`; a route answers the first two with their own status and every other refusal
 * with 400.
 */
export const readJsonBody = async <Value>(
  request: NextRequest,
  maximumBytes: number,
  schema: z.ZodType<Value>,
): Promise<JsonRequestBody<Value>> => {
  const read = await readBoundedRequestText(request, maximumBytes);
  if (read.kind !== "read") return read;
  let candidate: unknown;
  try {
    candidate = JSON.parse(read.text);
  } catch {
    return { kind: "unreadable" };
  }
  const parsed = schema.safeParse(candidate);
  return parsed.success
    ? { kind: "read", value: parsed.data }
    : { kind: "invalid", error: parsed.error };
};
