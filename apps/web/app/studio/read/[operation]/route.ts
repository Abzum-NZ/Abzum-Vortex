import type { NextRequest} from "next/server";
import { NextResponse } from "next/server";
import {
  reopenStudioApplication, readStudioCanvasRecords, readStudioDataRecords,
  resolveStudioApplicationConditionContext, resolveStudioApplicationTheme,
} from "../../../_lib/studio-read-operations";
import { mapWebError } from "../../../_lib/web-error-mapper";

export const dynamic = "force-dynamic";

/** Each operation resolves its own current session and authority; no read provisions a preview. */
export async function GET(request: NextRequest, context: { params: Promise<{ operation: string }> }) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
  try {
    const { operation } = await context.params;
    const organizationId = request.nextUrl.searchParams.get("organizationId") ?? "";
    const candidate: unknown = JSON.parse(request.nextUrl.searchParams.get("request") ?? "null");
    let result: unknown;
    switch (operation) {
      case "draft": result = await reopenStudioApplication(organizationId, typeof candidate === "string" ? candidate : ""); break;
      case "canvas-records": result = await readStudioCanvasRecords(organizationId, candidate); break;
      case "data-records": result = await readStudioDataRecords(organizationId, candidate); break;
      case "condition-context": result = await resolveStudioApplicationConditionContext(organizationId, candidate); break;
      case "theme": result = await resolveStudioApplicationTheme(organizationId, candidate); break;
      default: return NextResponse.json({ kind: "refused" }, { status: 404, headers });
    }
    return NextResponse.json(result, { headers });
  } catch (cause) {
    return NextResponse.json(mapWebError(cause, { route: "studio/read", operation: "read",
      code: "STUDIO_READ_FAILED", fallback: { kind: "temporarily_unavailable" } }), { headers });
  }
}
