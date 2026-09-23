import { type NextRequest } from "next/server";
import { handleFileApiRequest } from "../../_lib/file-route-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await context.params;
  return handleFileApiRequest(request, fileId, { forcedPurpose: "preview" });
}
