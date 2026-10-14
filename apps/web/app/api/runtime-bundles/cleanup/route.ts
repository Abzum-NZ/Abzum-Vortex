import { describeFailure } from "@vortex/platform/schema";
import type { NextRequest, NextResponse } from "next/server";
import {
  authenticateRuntimeBundleCleanup,
  runScheduledPreviewInstallationExpiry,
  runScheduledRuntimeBundleCleanup,
} from "@vortex/platform/server";
import { privateJsonResponse } from "../../../_lib/private-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authentication = authenticateRuntimeBundleCleanup(request.headers.get("authorization"));
  if (authentication.outcome === "refused")
    return privateJsonResponse(
      { outcome: "refused", reason: authentication.reason },
      authentication.reason === "cleanup_not_configured" ? 503 : 401,
    );

  const [bundles, previews] = await Promise.allSettled([
    runScheduledRuntimeBundleCleanup(),
    runScheduledPreviewInstallationExpiry(),
  ]);
  const reasons: string[] = [];
  if (bundles.status === "rejected") {
    reasons.push("RUNTIME_BUNDLE_CLEANUP_UNAVAILABLE");
    console.error(
      `[runtime-bundles] scheduled cleanup failed RUNTIME_BUNDLE_CLEANUP_UNAVAILABLE: ${describeFailure(bundles.reason)}`,
    );
  }
  if (previews.status === "rejected") {
    reasons.push("PREVIEW_EXPIRY_UNAVAILABLE");
    console.error(
      `[runtime-bundles] scheduled preview expiry failed PREVIEW_EXPIRY_UNAVAILABLE: ${describeFailure(previews.reason)}`,
    );
  }

  const result = {
    runtimeBundles: bundles.status === "fulfilled" ? bundles.value : null,
    previewsExpired: previews.status === "fulfilled" ? previews.value : null,
  };
  return reasons.length > 0
    ? privateJsonResponse({ outcome: "unavailable", reasons, result }, 503)
    : privateJsonResponse({ outcome: "cleaned", result }, 200);
}
