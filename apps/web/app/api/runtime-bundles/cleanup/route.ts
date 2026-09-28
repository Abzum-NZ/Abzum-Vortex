import { NextResponse, type NextRequest } from "next/server";
import {
  authenticateRuntimeBundleCleanup,
  runScheduledRuntimeBundleCleanup,
} from "@vortex/module";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateResponse = (body: unknown, status: number): NextResponse => {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authentication = authenticateRuntimeBundleCleanup(
    request.headers.get("authorization"),
  );
  if (authentication.outcome === "refused")
    return privateResponse(
      { outcome: "refused", reason: authentication.reason },
      authentication.reason === "cleanup_not_configured" ? 503 : 401,
    );

  try {
    const result = await runScheduledRuntimeBundleCleanup();
    return privateResponse({ outcome: "cleaned", result }, 200);
  } catch {
    return privateResponse({ outcome: "unavailable" }, 503);
  }
}
