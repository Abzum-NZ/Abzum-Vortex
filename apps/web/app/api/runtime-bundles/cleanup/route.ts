import { describeFailure } from "@vortex/platform/schema";
import type { NextRequest, NextResponse } from "next/server";
import {
  authenticateRuntimeBundleCleanup,
  runScheduledRuntimeBundleCleanup,
} from "@vortex/platform/server";
import { privateJsonResponse } from "../../../_lib/private-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authentication = authenticateRuntimeBundleCleanup(
    request.headers.get("authorization"),
  );
  if (authentication.outcome === "refused")
    return privateJsonResponse(
      { outcome: "refused", reason: authentication.reason },
      authentication.reason === "cleanup_not_configured" ? 503 : 401,
    );

  try {
    const result = await runScheduledRuntimeBundleCleanup();
    return privateJsonResponse({ outcome: "cleaned", result }, 200);
  } catch (error) {
    console.error(`[runtime-bundles] scheduled cleanup failed: ${describeFailure(error)}`);
    return privateJsonResponse({ outcome: "unavailable" }, 503);
  }
}
