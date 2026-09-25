import { NextResponse, type NextRequest } from "next/server";
import { createEventDispatcherWakeup, eventDispatcherWakeupLimits } from "@vortex/event";

// One protected wake-up endpoint serves both callers: a database webhook hint
// and a scheduled Kestra recovery tick. Both authenticate with the same
// configured dispatcher bearer credential and run the same bounded dispatcher.
const wakeup = createEventDispatcherWakeup({ consumers: [] });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateResponse = (body: unknown, status: number): NextResponse => {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
};

type ReadBodyResult =
  | Readonly<{ ok: true; body?: unknown }>
  | Readonly<{ ok: false; status: number }>;

// A rejected caller credential is 401. A missing server configuration or a
// missing, ambiguous, unavailable or inactive-organisation system actor grant
// is 503: no credential the caller could present would succeed.
const credentialRefusals: ReadonlySet<string> = new Set([
  "credential_missing",
  "credential_rejected",
]);

const readBody = async (request: NextRequest): Promise<ReadBodyResult> => {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > eventDispatcherWakeupLimits.maximumRequestBodyLength)
    return { ok: false, status: 413 };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400 };
  }
  if (text.length > eventDispatcherWakeupLimits.maximumRequestBodyLength)
    return { ok: false, status: 413 };
  if (text.length === 0) return { ok: true };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await readBody(request);
  if (!body.ok) return privateResponse({ outcome: "invalid_request" }, body.status);

  let response: Awaited<ReturnType<typeof wakeup.handle>>;
  try {
    response = await wakeup.handle({
      authorization: request.headers.get("authorization"),
      ...(body.body === undefined ? {} : { body: body.body }),
    });
  } catch {
    // Any unexpected dispatcher failure fails closed without internal detail.
    return privateResponse({ outcome: "unavailable" }, 503);
  }

  if (response.outcome === "refused")
    return privateResponse(
      { outcome: "refused", reason: response.reason },
      credentialRefusals.has(response.reason) ? 401 : 503,
    );
  if (response.outcome === "invalid_request")
    return privateResponse({ outcome: "invalid_request", code: response.code }, 400);
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
