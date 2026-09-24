import { handleFileReadRequest } from "../../../_lib/file-read-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Authenticated inline preview of passive media or an isolated rendition. */
export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string; fileId: string }> },
): Promise<Response> {
  return handleFileReadRequest(request, await context.params, "preview");
}
