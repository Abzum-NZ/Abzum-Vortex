/** Unmatched Studio addresses must not fall through to tenant application routing. */
export function GET(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}
