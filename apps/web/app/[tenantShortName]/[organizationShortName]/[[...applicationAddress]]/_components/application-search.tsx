import Link from "next/link";
import type { ApplicationSearchView } from "../../../../_lib/application-search";

export function ApplicationSearch({ view, pageSubject }: { view: ApplicationSearchView; pageSubject?: string | undefined }) {
  if (view.kind === "disabled") return null;
  return <section aria-label="Application search" className="space-y-3 rounded-lg border p-4">
    <form method="get" className="flex gap-2">
      {/* Preserve the ordinary Page subject; it supplies no Search field or Application authority. */}
      {pageSubject === undefined ? null : <input type="hidden" name="record_id" value={pageSubject} />}
      <label className="flex-1">Search
        <input name="q" type="search" maxLength={2_000} defaultValue={view.kind === "available" ? view.expression : ""}
          className="w-full rounded border px-3 py-2" placeholder="Search this application" />
      </label>
      <button type="submit" className="self-end rounded border px-3 py-2">Search</button>
    </form>
    {view.kind === "unavailable" ? <p role="status">Search is unavailable. Try again.</p> :
      view.expression === "" ? null : <>
        {view.results.length === 0 ? <p role="status">No results.</p> : <ul className="space-y-2">
          {view.results.map((result) => <li key={result.href}>
            <Link href={result.href} className="font-medium underline">{result.title}</Link>
            {result.subtitle === undefined ? null : <p>{result.subtitle}</p>}
          </li>)}
        </ul>}
        {view.more ? <p>More results are available. Refine your search.</p> : null}
      </>}
  </section>;
}
