"use client";
import { useEffect, useRef, useState } from "react";
import { describeFailure } from "@vortex/platform/schema";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { Label } from "@vortex/ui/components/label";
import { StudioOptionControl, type StudioDataSelection } from "@vortex/ui/studio";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@vortex/ui/components/table";
import { readStudioDataRecords } from "../actions";
import type { StudioDataRecordsResult, StudioDataTotal } from "../../_lib/studio-data-records";
import {
  fieldTypeLabel, type StudioDataModule, type StudioDataRecordType,
} from "../_lib/studio-data-model";

/** One page of records: 40 by default, at most 200 (the list paging rule). */
const pageSizes = [5, 10, 20, 40, 100, 200] as const;

/** The schema grid: one row per field of the record type. */
function SchemaGrid({ record, selectedField }: Readonly<{ record: StudioDataRecordType; selectedField: string | undefined }>) {
  return <Table>
    <TableCaption>The fields of {record.name}. The title field names each record wherever it is linked or listed.</TableCaption>
    <TableHeader><TableRow>
      <TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Required</TableHead>
      <TableHead>Unique</TableHead><TableHead>Description</TableHead>
    </TableRow></TableHeader>
    <TableBody>{record.fields.map((field) => <TableRow key={field.key} data-state={field.key === selectedField ? "selected" : undefined}
      aria-current={field.key === selectedField ? "true" : undefined}>
      <TableCell className="font-medium">{field.label}
        {field.key === record.titleFieldKey ? <Badge variant="outline" className="ml-2">Title</Badge> : null}</TableCell>
      <TableCell>{fieldTypeLabel(field.type)}</TableCell>
      <TableCell>{field.required ? "Yes" : "No"}</TableCell>
      <TableCell>{field.unique ? "Yes" : "No"}</TableCell>
      <TableCell className="whitespace-normal text-muted-foreground">{field.description}</TableCell>
    </TableRow>)}</TableBody>
  </Table>;
}

type Page = Readonly<{ token?: string; direction?: "forward" | "backward" }>;
type Read = Readonly<{ request: string; result: StudioDataRecordsResult }>;

const notReadable = (result: StudioDataRecordsResult, plural: string, query: boolean): string | undefined => {
  switch (result.kind) {
    case "available": case "summary": return undefined;
    case "not_installed": return query ? "Preview or publish to see results. The running application does not have this query yet."
      : "Preview or publish to see records. The running application does not have this yet.";
    case "no_query": return `No list of ${plural.toLowerCase()} exists yet. Add a query that lists ${plural.toLowerCase()} to see their records here.`;
    case "query_refused": return result.reason === "input_invalid"
      ? `This query lists records for one chosen record at a time. Select ${plural} in the Data panel to see all of them.`
      : result.reason === "continuation_invalid"
        ? "The groups changed while you were paging through them. Choose another number per page to start again from the first page."
      : `Your access does not let you see these ${plural.toLowerCase()}. Ask an administrator for access to see them.`;
    case "refused": return `Your access does not let you see these ${plural.toLowerCase()}. Ask an administrator for access to see them.`;
    case "temporarily_unavailable": return "The records could not be read just now. Try again in a moment.";
  }
};

/** A summary's totals, as a list of label and value. */
function Totals({ totals }: Readonly<{ totals: readonly StudioDataTotal[] }>) {
  return totals.length === 0 ? null : <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-label="Totals">
    {totals.map((total) => <div key={total.alias} className="contents">
      <dt className="text-muted-foreground">{total.label}</dt><dd className="font-medium tabular-nums">{total.value}</dd>
    </div>)}
  </dl>;
}

/**
 * What a query that groups records or adds totals reads: its overall totals, then its groups one page
 * at a time, by keyset like records: next and previous pages, and how many groups there are in all.
 */
function SummaryResults({ result, onPage }: Readonly<{
  result: Extract<StudioDataRecordsResult, { kind: "summary" }>;
  onPage: (page: Page) => void;
}>) {
  const totalColumns = result.totals.map((total) => ({ alias: total.alias, label: total.label }));
  return <div className="space-y-3">
    <p role="status" className="text-sm">{result.totalRowCount} {result.totalRowCount === 1 ? "record" : "records"} in all.</p>
    <Totals totals={result.totals} />
    {result.groupColumns.length === 0 ? null : <Table>
      <TableCaption>One row for each group, with its number of records and its totals.</TableCaption>
      <TableHeader><TableRow>
        {result.groupColumns.map((column) => <TableHead key={column.key}>{column.label}</TableHead>)}
        <TableHead>Records</TableHead>
        {totalColumns.map((column) => <TableHead key={column.alias}>{column.label}</TableHead>)}
      </TableRow></TableHeader>
      <TableBody>{result.groups.length === 0
        ? <TableRow><TableCell colSpan={result.groupColumns.length + 1 + totalColumns.length} className="text-muted-foreground">No records yet.</TableCell></TableRow>
        : result.groups.map((group) => <TableRow key={group.key}>
          {group.values.map((value, index) => <TableCell key={index} className="whitespace-normal">{value}</TableCell>)}
          <TableCell className="tabular-nums">{group.count}</TableCell>
          {group.totals.map((total) => <TableCell key={total.alias} className="tabular-nums">{total.value}</TableCell>)}
        </TableRow>)}</TableBody>
    </Table>}
    {result.groupColumns.length === 0 ? null : <div className="flex items-center justify-between gap-2">
      <p role="status" className="text-xs text-muted-foreground">{result.groups.length} of {result.groupCount} {result.groupCount === 1 ? "group" : "groups"} on this page</p>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" disabled={result.previous === undefined}
          onClick={() => onPage({ token: result.previous!, direction: "backward" })}>Previous</Button>
        <Button type="button" size="sm" variant="outline" disabled={result.next === undefined}
          onClick={() => onPage({ token: result.next!, direction: "forward" })}>Next</Button>
      </div>
    </div>}
  </div>;
}

/**
 * The live records of the selected record type or query, read with the builder's own access through
 * the running application. Paging is keyset paging: next and previous pages, never a page count.
 */
function LiveResults({ organizationId, rootId, moduleKey, recordKey, plural, queryKey, refresh }: Readonly<{
  organizationId: string; rootId: string; moduleKey: string; recordKey: string; plural: string; queryKey: string | undefined;
  /** Changes when the saved draft or the installation may have changed. */
  refresh: number;
}>) {
  const [pageSize, setPageSize] = useState<number>(40);
  const [page, setPage] = useState<Page>({});
  const [read, setRead] = useState<Read | null>(null);
  const latest = useRef("");
  const request = JSON.stringify({ rootId, moduleKey, recordKey, queryKey, pageSize, page, refresh });
  useEffect(() => {
    latest.current = request;
    void (async () => {
      let result: StudioDataRecordsResult;
      try {
        result = await readStudioDataRecords(organizationId, {
          rootId, moduleKey, recordKey, ...(queryKey === undefined ? {} : { queryKey }), pageSize,
          ...(page.token === undefined ? {} : { continuationToken: page.token, pageDirection: page.direction }),
        });
      } catch (error) {
        console.error("[studio] reading data records failed", describeFailure(error));
        result = { kind: "temporarily_unavailable" };
      }
      if (latest.current === request) setRead({ request, result });
    })();
  }, [organizationId, rootId, moduleKey, recordKey, queryKey, pageSize, page, request]);
  // A new record type or query starts on its first page.
  useEffect(() => { setPage({}); }, [moduleKey, recordKey, queryKey]);
  const current = read?.request === request ? read.result : null;
  const problem = current === null ? undefined : notReadable(current, plural, queryKey !== undefined);
  return <section aria-labelledby="studio-data-results" className="space-y-2">
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h3 id="studio-data-results" className="text-sm font-semibold">Records</h3>
        <p className="text-xs text-muted-foreground">{current?.kind === "available" || current?.kind === "summary"
          ? `From the running application, through its published query ${current.queryLabel}, with your access.`
          : "From the running application, with your access."}</p>
      </div>
      <div className="flex items-center gap-2">
        <Label htmlFor="studio-data-page-size" className="text-xs">Per page</Label>
        <StudioOptionControl id="studio-data-page-size" value={String(pageSize)} disabled={false}
          options={pageSizes.map((size) => ({ value: String(size), label: String(size) }))}
          onChange={(next) => { setPageSize(Number(next)); setPage({}); }} />
      </div>
    </div>
    {current === null ? <p role="status" className="text-sm text-muted-foreground">Reading records…</p>
      : problem !== undefined ? <p role="status" className="text-sm">{problem}</p>
        : current.kind === "summary" ? <SummaryResults result={current} onPage={setPage} />
        : current.kind === "available" && <>
          <Table>
            <TableHeader><TableRow>{current.columns.map((column) => <TableHead key={column.key}>{column.label}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{current.rows.length === 0
              ? <TableRow><TableCell colSpan={Math.max(current.columns.length, 1)} className="text-muted-foreground">No records yet.</TableCell></TableRow>
              : current.rows.map((row) => <TableRow key={row.id}>{current.columns.map((column) =>
                <TableCell key={column.key} className="whitespace-normal">{row.cells[column.key]}</TableCell>)}</TableRow>)}</TableBody>
          </Table>
          <div className="flex items-center justify-between gap-2">
            <p role="status" className="text-xs text-muted-foreground">{current.rows.length} {current.rows.length === 1 ? "record" : "records"} on this page</p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={current.previous === undefined}
                onClick={() => setPage({ token: current.previous!, direction: "backward" })}>Previous</Button>
              <Button type="button" size="sm" variant="outline" disabled={current.next === undefined}
                onClick={() => setPage({ token: current.next!, direction: "forward" })}>Next</Button>
            </div>
          </div>
        </>}
  </section>;
}

/** The Data tab's centre: the selected record type's schema grid and its live records. */
export function StudioDataCentre({ organizationId, rootId, modules, selection, draftOnly, refresh }: Readonly<{
  organizationId: string; rootId: string;
  /** Owned and used modules, as the tree shows them. */
  modules: readonly StudioDataModule[];
  selection: StudioDataSelection | null;
  /** Whether the selected record type or query is new in the draft, not saved yet. */
  draftOnly: boolean;
  refresh: number;
}>) {
  const module = selection === null ? undefined : modules.find((item) => item.key === selection.moduleKey);
  if (selection === null || module === undefined)
    return <p className="text-sm text-muted-foreground">Choose a record type in the Data panel to see its fields and records.</p>;
  if (selection.kind === "module")
    return <section className="space-y-3" aria-label={module.name}>
      <h2 className="text-lg font-semibold">{module.name}</h2>
      <p className="text-sm text-muted-foreground">{module.ownerApplication === undefined
        ? "A module this application owns. Its record types are saved and published with the application."
        : "A module this application uses. It is read-only here."}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm">{module.recordTypes.map((record) =>
        <li key={record.key}>{record.pluralName}: {record.fields.length} fields</li>)}</ul>
    </section>;
  const query = selection.kind === "query" ? module.queries.find((item) => item.key === selection.queryKey) : undefined;
  const recordKey = selection.kind === "query" ? query?.recordKey : selection.recordKey;
  const record = module.recordTypes.find((item) => item.key === recordKey);
  if (record === undefined)
    return <p role="status" className="text-sm">This is not in the application any more. Choose another item in the Data panel.</p>;
  return <div className="space-y-6">
    <section className="space-y-2" aria-labelledby="studio-data-schema">
      <h2 id="studio-data-schema" className="text-lg font-semibold">{query === undefined ? record.pluralName : `${query.label} (${record.pluralName})`}</h2>
      <SchemaGrid record={record} selectedField={selection.kind === "field" ? selection.fieldKey : undefined} />
    </section>
    {draftOnly
      ? <p role="status" className="text-sm">{query === undefined
        ? "Preview or publish to see records. This record type is only in the draft so far."
        : "Preview or publish to see results. This query is only in the draft so far."}</p>
      : <LiveResults organizationId={organizationId} rootId={rootId} moduleKey={module.key} recordKey={record.key} plural={record.pluralName}
        queryKey={query?.key} refresh={refresh} />}
  </div>;
}
