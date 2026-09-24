import { handleFileReadRequest } from "../../_lib/file-read-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Authenticated private download, including single byte-range requests. */
export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string; fileId: string }> },
): Promise<Response> {
  return handleFileReadRequest(request, await context.params, "download");
}
