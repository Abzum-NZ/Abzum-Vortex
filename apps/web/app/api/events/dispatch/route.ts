import type { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { logRefusal } from "@vortex/platform/schema";
import {
  authenticateEventDispatcher,
  createEventDispatcherWakeup,
  createDerivedFieldBackfillConsumer,
  createSearchEventConsumer,
  createSearchIndexDependencies,
  eventDispatcherWakeupLimits,
} from "@vortex/platform/server";
import { readBoundedRequestText } from "../../_lib/bounded-request-body";
import { privateJsonResponse as privateResponse } from "../../../_lib/private-response";

// One protected wake-up endpoint serves both callers: a database webhook hint
// and a scheduled Kestra recovery tick. Both authenticate with the same
// configured dispatcher bearer credential and run the same bounded dispatcher.
const wakeup = createEventDispatcherWakeup({
  consumers: [
    createDerivedFieldBackfillConsumer(),
    createSearchEventConsumer(createSearchIndexDependencies()),
  ],
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type ReadBodyResult =
  | Readonly<{ ok: true; body?: unknown }>
  | Readonly<{ ok: false; status: number; code: string; cause?: unknown }>;

// A rejected caller credential is 401. A missing server configuration or a
// missing, ambiguous or unavailable system actor grant is 503: no credential
// the caller could present would succeed.
const credentialRefusals: ReadonlySet<string> = new Set([
  "credential_missing",
  "credential_rejected",
]);

const readBody = async (request: NextRequest): Promise<ReadBodyResult> => {
  const read = await readBoundedRequestText(
    request,
    eventDispatcherWakeupLimits.maximumRequestBodyLength,
  );
  if (read.kind === "too_large") return { ok: false, status: 413, code: "body_too_large" };
  if (read.kind === "unreadable") return { ok: false, status: 400, code: "body_unreadable" };
  const text = read.text;
  if (text.length === 0) return { ok: true };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch (error) {
    return { ok: false, status: 400, code: "body_not_json", cause: error };
  }
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (process.env.VORTEX_EVENT_DELIVERY_MODE !== "external") {
    logRefusal("events-dispatch", "wake-up", "external_delivery_disabled");
    return privateResponse(
      { outcome: "refused", reason: "External event delivery is not enabled for this deployment." },
      409,
    );
  }
  const authentication = authenticateEventDispatcher(request.headers.get("authorization"));
  if (authentication.outcome === "refused") {
    logRefusal("events-dispatch", "wake-up", `authentication_${authentication.reason}`);
    return privateResponse(
      { outcome: "refused", reason: authentication.reason },
      credentialRefusals.has(authentication.reason) ? 401 : 503,
    );
  }

  const body = await readBody(request);
  if (!body.ok) {
    logRefusal("events-dispatch", "wake-up", body.code, body.cause);
    return privateResponse({ outcome: "invalid_request", code: body.code }, body.status);
  }

  let response: Awaited<ReturnType<typeof wakeup.handle>>;
  try {
    response = await wakeup.handle({
      authorization: request.headers.get("authorization"),
      ...(body.body === undefined ? {} : { body: body.body }),
    });
  } catch (error) {
    // Any unexpected dispatcher failure fails closed without internal detail in the response.
    logRefusal("events-dispatch", "wake-up", "dispatcher_failed", error);
    return privateResponse({ outcome: "unavailable" }, 503);
  }

  if (response.outcome === "refused") {
    logRefusal("events-dispatch", "wake-up", `dispatcher_${response.reason}`);
    return privateResponse(
      { outcome: "refused", reason: response.reason },
      credentialRefusals.has(response.reason) ? 401 : 503,
    );
  }
  if (response.outcome === "invalid_request") {
    logRefusal("events-dispatch", "wake-up", `request_${response.code}`);
    return privateResponse({ outcome: "invalid_request", code: response.code }, 400);
  }
  return privateResponse(
    {
      outcome: "dispatched",
      source: response.source,
      result: response.result,
      backlog: response.backlog,
    },
    200,
  );
}
