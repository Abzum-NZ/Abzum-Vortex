import { DOCUMENT_STYLESHEETS } from "../../../_lib/document-styles";

/**
 * Only the build's public stylesheets exist; none reads a session or application data. The sheets
 * are in-memory constants named by their content hash, so each response is cached by its headers.
 * The route is not pre-rendered: two sheets requested at once on a cold dev server raced each
 * other's static-params cache file and one of them answered 500.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ stylesheet: string }> },
): Promise<Response> {
  const { stylesheet } = await params;
  const sheet = Object.values(DOCUMENT_STYLESHEETS).find(({ filename }) => filename === stylesheet);
  if (sheet === undefined) return new Response(null, { status: 404 });
  return new Response(sheet.css, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
