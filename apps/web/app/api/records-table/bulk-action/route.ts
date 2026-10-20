import { NextResponse, type NextRequest } from "next/server";
import {
  logRefusal,
  recordsTableBulkActionRequestSchema,
  type RecordsTableBulkRunLine,
} from "@vortex/platform/schema";
import { privateResponse } from "../../../_lib/private-response";
import { recordsTableBulkService, resolveBulkRequest } from "../_lib/bulk-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const route = "/api/records-table/bulk-action";

/**
 * Runs one declared bulk named action of a Records table over a selection: the rows the person
 * selected, or every record the table matches. The response streams one JSON line after every
 * batch (progress) and ends with the summary, so the person sees the run advance in one request;
 * the browser loops over nothing.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const resolved = await resolveBulkRequest(request, route, recordsTableBulkActionRequestSchema);
    if (resolved.kind === "response") return resolved.response;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: RecordsTableBulkRunLine): void => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          } catch {
            // The person left the page; the batches already running still finish on the server.
          }
        };
        try {
          await recordsTableBulkService().run(
            resolved.session,
            resolved.address,
            resolved.body,
            send,
          );
        } catch (error) {
          logRefusal(route, "records table bulk action", "bulk_action_failed", error);
          send({ kind: "unavailable" });
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed by the person leaving the page.
          }
        }
      },
    });
    return privateResponse(
      new NextResponse(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      }),
    );
  } catch (error) {
    logRefusal(route, "records table bulk action", "bulk_action_failed", error);
    return privateResponse(NextResponse.json({ kind: "unavailable" }, { status: 503 }));
  }
}
