import "server-only";

import { parseComponentBootstrapTarget, renderComponentBootstrapDocument } from "@vortex/file";
import {
  configuredComponentOrigin,
  configuredSiteOrigin,
  isComponentOriginRequest,
} from "../_lib/component-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Vortex-owned bootstrap document for one custom component bundle, served at
 * `/api/components/bootstrap` on the dedicated component origin. It answers only on that origin,
 * validates the content address, relative entry file and declared hosts it is asked for, and
 * returns the document with the application packages appendix's Content-Security-Policy. The URL
 * carries no organisation, record or person identifier, and the document loads exactly the bundle
 * entry with the Subresource Integrity digest recorded for its content address.
 */

const refusal = (status: number): Response =>
  new Response(status === 400 ? "The bootstrap request is malformed" : "Not found", {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

export async function GET(request: Request): Promise<Response> {
  if (!isComponentOriginRequest(request)) return refusal(404);

  let componentOrigin: string;
  let siteOrigin: string;
  try {
    componentOrigin = configuredComponentOrigin();
    siteOrigin = configuredSiteOrigin();
  } catch {
    return refusal(404);
  }

  const target = parseComponentBootstrapTarget(new URL(request.url).searchParams);
  if (target === undefined) return refusal(400);

  const document = renderComponentBootstrapDocument({ target, componentOrigin, siteOrigin });
  return new Response(Buffer.from(document.body), {
    status: 200,
    headers: document.headers,
  });
}
