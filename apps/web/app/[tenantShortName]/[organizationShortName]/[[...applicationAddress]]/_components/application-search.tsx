import Link from "next/link";
import { Button } from "@vortex/ui/components/button";
import { Card, CardContent } from "@vortex/ui/components/card";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import type { ApplicationSearchView } from "../../../../_lib/application-search";

export function ApplicationSearch({ view, pageSubject }: { view: ApplicationSearchView; pageSubject?: string | undefined }) {
  if (view.kind === "disabled") return null;
  return <section aria-label="Application search" className="flex min-w-0 flex-col gap-3">
    <form method="get" className="flex max-w-xl items-center gap-2">
      {/* Preserve the ordinary Page subject; it supplies no Search field or Application authority. */}
      {pageSubject === undefined ? null : <input type="hidden" name="record_id" value={pageSubject} />}
      <Label htmlFor="application-search-query" className="sr-only">Search</Label>
      <Input id="application-search-query" name="q" type="search" maxLength={2_000}
        defaultValue={view.kind === "available" ? view.expression : ""} placeholder="Search this application" />
      <Button type="submit" variant="outline">Search</Button>
    </form>
    {view.kind === "unavailable" ? <p role="status" className="text-sm text-muted-foreground">Search is unavailable. Try again.</p> :
      view.expression === "" ? null : <Card size="sm"><CardContent className="flex flex-col gap-2 text-sm">
        {view.results.length === 0 ? <p role="status" className="text-muted-foreground">No results.</p> : <ul className="flex flex-col gap-2">
          {view.results.map((result) => <li key={result.href}>
            <Link href={result.href} className="font-medium underline-offset-4 hover:underline">{result.title}</Link>
            {result.subtitle === undefined ? null : <p className="text-muted-foreground">{result.subtitle}</p>}
          </li>)}
        </ul>}
        {view.more ? <p className="text-muted-foreground">More results are available. Refine your search.</p> : null}
      </CardContent></Card>}
  </section>;
}
