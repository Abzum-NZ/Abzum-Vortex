"use client";
import { useEffect, useRef, useState } from "react";
import { describeFailure } from "@vortex/platform/schema";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { Label } from "@vortex/ui/components/label";
import { StudioOptionControl, type StudioDataSelection } from "@vortex/ui/studio";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@vortex/ui/components/table";
import { readStudioDataRecords } from "../actions";
import type { StudioDataRecordsResult } from "../../_lib/studio-data-records";
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

const notReadable = (result: StudioDataRecordsResult, plural: string): string | undefined => {
  switch (result.kind) {
    case "available": return undefined;
    case "not_installed": return "Preview or publish to see records. The running application does not have this yet.";
    case "no_query": return `No list of ${plural.toLowerCase()} exists yet. Add a query that lists ${plural.toLowerCase()} to see their records here.`;
    case "query_refused": return result.reason === "input_invalid"
      ? `This query lists records for one chosen record at a time. Select ${plural} in the Data panel to see all of them.`
      : `Your access does not let you see these ${plural.toLowerCase()}. Ask an administrator for access to see them.`;
    case "refused": return `Your access does not let you see these ${plural.toLowerCase()}. Ask an administrator for access to see them.`;
    case "temporarily_unavailable": return "The records could not be read just now. Try again in a moment.";
  }
};

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
  const problem = current === null ? undefined : notReadable(current, plural);
  return <section aria-labelledby="studio-data-results" className="space-y-2">
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h3 id="studio-data-results" className="text-sm font-semibold">Records</h3>
        <p className="text-xs text-muted-foreground">{current?.kind === "available"
          ? `From the running application, through the query ${current.queryLabel}, with your access.`
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
  /** Whether the selected record type or query exists only in the unsaved or unpublished draft. */
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
      ? <p role="status" className="text-sm">Preview or publish to see records. {query === undefined ? "This record type" : "This query"} is only in the draft so far.</p>
      : <LiveResults organizationId={organizationId} rootId={rootId} moduleKey={module.key} recordKey={record.key} plural={record.pluralName}
        queryKey={query?.key} refresh={refresh} />}
  </div>;
}
