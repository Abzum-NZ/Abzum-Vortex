import type { NextRequest} from "next/server";
import { NextResponse } from "next/server";
import { provisionStudioApplicationPreview, readStudioPreviewStatus } from "../../_lib/studio-application-preview";
import { resolveIdentitySession } from "../../auth/_lib/session-server";
import { mapWebError } from "../../_lib/web-error-mapper";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

/** Status observes an authorised revision without compiling or changing the preview. */
export async function GET(request: NextRequest) {
  try {
    const resolved = await resolveIdentitySession();
    const result = resolved.kind !== "active" ? { kind: "refused", reason: "permission_refused" }
      : await readStudioPreviewStatus(resolved.session, request.nextUrl.searchParams.get("organizationId") ?? "",
        JSON.parse(request.nextUrl.searchParams.get("request") ?? "null"));
    return NextResponse.json(result, { headers });
  } catch (cause) {
    return NextResponse.json(mapWebError(cause, { route: "studio/preview", operation: "status",
      code: "STUDIO_PREVIEW_STATUS_FAILED", fallback: { kind: "temporarily_unavailable" } }), { headers });
  }
}

/** Preparation is an explicit same-origin mutation, independent of canvas compilation. */
export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return NextResponse.json({ kind: "refused", reason: "permission_refused" }, { status: 403, headers });
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return NextResponse.json({ kind: "refused", reason: "permission_refused" }, { headers });
    const body = await request.json();
    return NextResponse.json(await provisionStudioApplicationPreview(resolved.session,
      typeof body.organizationId === "string" ? body.organizationId : "", body.request), { headers });
  } catch (cause) {
    return NextResponse.json(mapWebError(cause, { route: "studio/preview", operation: "prepare",
      code: "STUDIO_PREVIEW_PREPARATION_FAILED", fallback: { kind: "temporarily_unavailable" } }), { headers });
  }
}
