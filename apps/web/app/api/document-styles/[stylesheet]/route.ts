import { SERVED_STYLESHEETS } from "../../../_lib/document-styles";

export const dynamic = "force-static";
export const dynamicParams = false;

export const generateStaticParams = () =>
  SERVED_STYLESHEETS.map(({ filename }) => ({ stylesheet: filename }));

/** Only the build's public stylesheets exist; none reads a session or application data. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ stylesheet: string }> },
): Promise<Response> {
  const { stylesheet } = await params;
  const sheet = SERVED_STYLESHEETS.find(({ filename }) => filename === stylesheet);
  if (sheet === undefined) return new Response(null, { status: 404 });
  return new Response(sheet.css, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
