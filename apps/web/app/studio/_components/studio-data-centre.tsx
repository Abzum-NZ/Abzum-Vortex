"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  applicationUses,
  type ApplicationSourceDocument,
  describeFailure,
} from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@vortex/ui/components/empty";
import { Popover, PopoverContent, PopoverTrigger } from "@vortex/ui/components/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@vortex/ui/components/tabs";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { StudioPlaceList } from "./studio-used-in";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { Label } from "@vortex/ui/components/label";
import {
  StudioOptionControl,
  StudioFieldTypeIcon,
  type StudioDataSelection,
} from "@vortex/ui/studio";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vortex/ui/components/table";
import { readStudioDataRecords } from "../_lib/studio-reads";
import type { StudioDataRecordsResult, StudioDataTotal } from "../../_lib/studio-data-records";
import {
  fieldTypeLabel,
  type StudioDataModule,
  type StudioDataRecordType,
} from "../_lib/studio-data-model";

/** One page of records: 40 by default, at most 200 (the list paging rule). */
const pageSizes = [5, 10, 20, 40, 100, 200] as const;

/** One selectable schema table for owned and read-only record types. */
function SchemaGrid({
  source,
  moduleKey,
  record,
  selectedField,
  onSelect,
}: Readonly<{
  source: ApplicationSourceDocument;
  moduleKey: string;
  record: StudioDataRecordType;
  selectedField: string | undefined;
  onSelect: (selection: StudioDataSelection) => void;
}>) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <Table containerClassName="border-0">
        <TableCaption className="sr-only">Fields of {record.pluralName}</TableCaption>
        <TableHeader className="sticky top-0 bg-muted/50">
          <TableRow>
            <TableHead className="normal-case text-xs text-foreground">Name</TableHead>
            <TableHead className="normal-case text-xs text-foreground">Type</TableHead>
            <TableHead className="normal-case w-20 text-center text-xs text-foreground">
              Required
            </TableHead>
            <TableHead className="normal-case w-20 text-center text-xs text-foreground">
              Used in
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {record.fields.map((field) => {
            const choose = () =>
              onSelect({ kind: "field", moduleKey, recordKey: record.key, fieldKey: field.key });
            const places = applicationUses(source, {
              kind: "field",
              moduleKey,
              recordKey: record.key,
              fieldKey: field.key,
            });
            return (
              <TableRow
                key={field.key}
                className="h-11 cursor-pointer hover:bg-muted/40"
                data-state={field.key === selectedField ? "selected" : undefined}
                onClick={choose}
              >
                <TableCell className="font-medium">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      choose();
                    }}
                    aria-current={field.key === selectedField ? "true" : undefined}
                    aria-label={`Open ${field.label}`}
                    className="min-h-6 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {field.label}
                  </button>
                  {field.key === record.titleFieldKey ? (
                    <Badge variant="outline" className="ml-2">
                      Title
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-2">
                    <StudioFieldTypeIcon type={field.type} />
                    {fieldTypeLabel(field.type)}
                  </span>
                </TableCell>
                <TableCell className="text-center">{field.required ? "Yes" : "No"}</TableCell>
                <TableCell
                  className="text-center tabular-nums"
                  onClick={(event) => event.stopPropagation()}
                >
                  {places.length === 0 ? (
                    <span aria-label={`${field.label} is not used`}>0</span>
                  ) : (
                    <Popover>
                      <PopoverTrigger
                        render={
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="dark:text-foreground dark:underline"
                            aria-label={`Where ${field.label} is used`}
                          />
                        }
                      >
                        {places.length}
                      </PopoverTrigger>
                      <PopoverContent className="space-y-3 text-sm">
                        <p className="font-medium">Used in</p>
                        <StudioPlaceList places={places} label={`Where ${field.label} is used`} />
                      </PopoverContent>
                    </Popover>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function StudioDataEmpty({
  title = "No record type selected",
  description = "Pick a record type to see its fields and records.",
  onCreate,
}: Readonly<{
  title?: string;
  description?: string;
  onCreate?: () => void;
}>) {
  return (
    <Empty className="min-h-80 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon name="database" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {onCreate === undefined ? null : (
        <EmptyContent>
          <Button type="button" variant="outline" onClick={onCreate}>
            <Icon name="plus" />
            Record type
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

type Page = Readonly<{ token?: string; direction?: "forward" | "backward" }>;
type Read = Readonly<{ request: string; result: StudioDataRecordsResult }>;

const notReadable = (
  result: StudioDataRecordsResult,
  plural: string,
  query: boolean,
): string | undefined => {
  switch (result.kind) {
    case "available":
    case "summary":
      return undefined;
    case "not_saved":
      return query
        ? "Results show once this query is saved, in a moment."
        : "Records show once this is saved, in a moment.";
    case "conflict":
      return "The saved draft changed. Its records follow in a moment.";
    case "following":
      return "Your preview is catching up with the saved draft. Its records follow in a moment.";
    case "no_query":
      return `No list of ${plural.toLowerCase()} exists yet. Add a query that lists ${plural.toLowerCase()} to see their records here.`;
    case "query_refused":
      return result.reason === "input_invalid"
        ? `This query lists records for one chosen record at a time. Select ${plural} in the Data panel to see all of them.`
        : result.reason === "continuation_invalid"
          ? "The groups changed while you were paging through them. Choose another number per page to start again from the first page."
          : `Your access does not let you see these ${plural.toLowerCase()}. Ask an administrator for access to see them.`;
    case "refused":
      return `Seeing these ${plural.toLowerCase()} here needs permission to preview this application. Ask an administrator for access.`;
    case "temporarily_unavailable":
      return "The records could not be read just now. Try again in a moment.";
  }
};

/** A summary's totals, as a list of label and value. */
function Totals({ totals }: Readonly<{ totals: readonly StudioDataTotal[] }>) {
  return totals.length === 0 ? null : (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-label="Totals">
      {totals.map((total) => (
        <div key={total.alias} className="contents">
          <dt className="text-muted-foreground">{total.label}</dt>
          <dd className="font-medium tabular-nums">{total.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What a query that groups records or adds totals reads: its overall totals, then its groups one page
 * at a time, by keyset like records: next and previous pages, and how many groups there are in all.
 */
function SummaryResults({
  result,
  onPage,
}: Readonly<{
  result: Extract<StudioDataRecordsResult, { kind: "summary" }>;
  onPage: (page: Page) => void;
}>) {
  const totalColumns = result.totals.map((total) => ({ alias: total.alias, label: total.label }));
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm">
        {result.totalRowCount} {result.totalRowCount === 1 ? "record" : "records"} in all.
      </p>
      <Totals totals={result.totals} />
      {result.groupColumns.length === 0 ? null : (
        <Table>
          <TableCaption>
            One row for each group, with its number of records and its totals.
          </TableCaption>
          <TableHeader>
            <TableRow>
              {result.groupColumns.map((column) => (
                <TableHead key={column.key} className="normal-case">
                  {column.label}
                </TableHead>
              ))}
              <TableHead className="normal-case">Records</TableHead>
              {totalColumns.map((column) => (
                <TableHead key={column.alias} className="normal-case">
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.groups.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={result.groupColumns.length + 1 + totalColumns.length}
                  className="text-muted-foreground"
                >
                  No records yet.
                </TableCell>
              </TableRow>
            ) : (
              result.groups.map((group) => (
                <TableRow key={group.key}>
                  {group.values.map((value, index) => (
                    <TableCell key={index} className="whitespace-normal">
                      {value}
                    </TableCell>
                  ))}
                  <TableCell className="tabular-nums">{group.count}</TableCell>
                  {group.totals.map((total) => (
                    <TableCell key={total.alias} className="tabular-nums">
                      {total.value}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}
      {result.groupColumns.length === 0 ? null : (
        <div className="flex items-center justify-between gap-2">
          <p role="status" className="text-sm text-muted-foreground">
            {result.groups.length} of {result.groupCount}{" "}
            {result.groupCount === 1 ? "group" : "groups"} on this page
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={result.previous === undefined}
              onClick={() => onPage({ token: result.previous!, direction: "backward" })}
            >
              Previous
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={result.next === undefined}
              onClick={() => onPage({ token: result.next!, direction: "forward" })}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The records of the selected record type or query, read from the builder's preview of the saved
 * draft revision with their preview access. Paging is keyset paging: next and previous pages,
 * never a page count.
 */
function PreviewResults({
  organizationId,
  rootId,
  moduleKey,
  recordKey,
  plural,
  queryKey,
  draftRevision,
}: Readonly<{
  organizationId: string;
  rootId: string;
  moduleKey: string;
  recordKey: string;
  plural: string;
  queryKey: string | undefined;
  /** The saved, compiled draft revision whose preview the records are read from. */
  draftRevision: number;
}>) {
  const [pageSize, setPageSize] = useState<number>(40);
  // A page token belongs to one record type or query, page size and saved revision: any other
  // starts on its first page.
  const scope = JSON.stringify({ rootId, moduleKey, recordKey, queryKey, pageSize, draftRevision });
  const [paged, setPaged] = useState<Page & { scope?: string }>({});
  const page: Page = paged.scope === scope ? paged : {};
  const setPage = (next: Page) => setPaged({ ...next, scope });
  const [read, setRead] = useState<Read | null>(null);
  const latest = useRef("");
  const request = JSON.stringify({ scope, page });
  // A preview still moving to this revision is read again shortly; what it showed stays meanwhile.
  const [followed, setFollowed] = useState<Readonly<{ request: string; count: number }>>({
    request: "",
    count: 0,
  });
  const followUp = followed.request === request ? followed.count : 0;
  useEffect(() => {
    if (read?.request !== request) return;
    const result = read.result;
    const behind =
      result.kind === "following" ||
      ((result.kind === "available" || result.kind === "summary") && result.behind);
    if (!behind || followUp >= 30) return;
    const timer = setTimeout(() => setFollowed({ request, count: followUp + 1 }), 1500);
    return () => clearTimeout(timer);
  }, [read, request, followUp]);
  useEffect(() => {
    latest.current = request;
    const controller = new AbortController();
    void (async () => {
      let result: StudioDataRecordsResult;
      try {
        result = await readStudioDataRecords(
          organizationId,
          {
            rootId,
            draftRevision,
            moduleKey,
            recordKey,
            ...(queryKey === undefined ? {} : { queryKey }),
            pageSize,
            ...(page.token === undefined
              ? {}
              : { continuationToken: page.token, pageDirection: page.direction }),
          },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("[studio] reading data records failed", describeFailure(error));
        result = { kind: "temporarily_unavailable" };
      }
      if (!controller.signal.aborted && latest.current === request) setRead({ request, result });
    })();
    return () => controller.abort();
  }, [
    organizationId,
    rootId,
    draftRevision,
    moduleKey,
    recordKey,
    queryKey,
    pageSize,
    page.token,
    page.direction,
    request,
    followUp,
  ]);
  const current = read?.request === request ? read.result : null;
  const problem =
    current === null ? undefined : notReadable(current, plural, queryKey !== undefined);
  return (
    <section aria-labelledby="studio-data-results" className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id="studio-data-results" className="text-sm font-semibold">
            Records
          </h3>
          <p className="text-sm text-muted-foreground">
            {current?.kind === "available" || current?.kind === "summary"
              ? `From your preview of the saved draft, through its query ${current.queryLabel}, with your preview access.`
              : "From your preview of the saved draft, with your preview access."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="studio-data-page-size" className="text-sm">
            Per page
          </Label>
          <StudioOptionControl
            id="studio-data-page-size"
            value={String(pageSize)}
            disabled={false}
            options={pageSizes.map((size) => ({ value: String(size), label: String(size) }))}
            onChange={(next) => {
              setPageSize(Number(next));
              setPage({});
            }}
          />
        </div>
      </div>
      {current === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reading records…
        </p>
      ) : problem !== undefined ? (
        <p role="status" className="text-sm">
          {problem}
        </p>
      ) : current.kind === "summary" ? (
        <SummaryResults result={current} onPage={setPage} />
      ) : (
        current.kind === "available" && (
          <>
            <div className="overflow-hidden rounded-xl border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    {current.columns.map((column) => (
                      <TableHead key={column.key} className="normal-case">
                        {column.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {current.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={Math.max(current.columns.length, 1)}>
                        <StudioDataEmpty
                          title="No records yet"
                          description="Records created in this application will appear here."
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    current.rows.map((row) => (
                      <TableRow key={row.id} className="h-11 hover:bg-muted/40">
                        {current.columns.map((column) => (
                          <TableCell key={column.key} className="whitespace-normal">
                            {row.cells[column.key]}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p role="status" className="text-sm text-muted-foreground">
                {current.rows.length} {current.rows.length === 1 ? "record" : "records"} on this
                page
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={current.previous === undefined}
                  onClick={() => setPage({ token: current.previous!, direction: "backward" })}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={current.next === undefined}
                  onClick={() => setPage({ token: current.next!, direction: "forward" })}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )
      )}
    </section>
  );
}

/** The record type's canvas: the schema and live records share one tabbed workspace. */
export function StudioDataCentre({
  section,
  onSectionChange,
  organizationId,
  rootId,
  modules,
  source,
  selection,
  unsaved,
  draftRevision,
  onSelect,
  onCreate,
  onAddField,
  relationships,
  rules,
  pipelines,
  search,
}: Readonly<{
  section: string;
  onSectionChange: (section: string) => void;
  organizationId: string;
  rootId: string;
  modules: readonly StudioDataModule[];
  source: ApplicationSourceDocument;
  selection: StudioDataSelection | null;
  unsaved: boolean;
  draftRevision: number;
  onSelect: (selection: StudioDataSelection) => void;
  onCreate: () => void;
  onAddField: (() => void) | undefined;
  relationships: ReactNode;
  rules: ReactNode;
  pipelines: ReactNode;
  search: ReactNode;
}>) {
  const module =
    selection === null ? undefined : modules.find((item) => item.key === selection.moduleKey);
  if (selection === null || module === undefined) return <StudioDataEmpty onCreate={onCreate} />;
  if (selection.kind === "module")
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 px-8 py-6">
        <h2 className="text-xl font-semibold tracking-tight">{module.name}</h2>
        {module.recordTypes.length === 0 ? (
          <StudioDataEmpty onCreate={onCreate} />
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="normal-case text-xs text-foreground">Record type</TableHead>
                  <TableHead className="normal-case w-20 text-center text-xs text-foreground">
                    Fields
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {module.recordTypes.map((record) => (
                  <TableRow key={record.key} className="h-11 hover:bg-muted/40">
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          onSelect({
                            kind: "record_type",
                            moduleKey: module.key,
                            recordKey: record.key,
                          })
                        }
                      >
                        <Icon name="database" />
                        {record.pluralName}
                      </Button>
                    </TableCell>
                    <TableCell className="text-center tabular-nums">
                      {record.fields.length}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    );
  const query =
    selection.kind === "query"
      ? module.queries.find((item) => item.key === selection.queryKey)
      : undefined;
  const recordKey = selection.kind === "query" ? query?.recordKey : selection.recordKey;
  const record = module.recordTypes.find((item) => item.key === recordKey);
  if (record === undefined)
    return (
      <StudioDataEmpty title="Item removed" description="Choose another record type in Data." />
    );
  const results = unsaved ? (
    <p role="status" className="text-sm">
      Records will appear when this draft is saved.
    </p>
  ) : (
    <PreviewResults
      organizationId={organizationId}
      rootId={rootId}
      moduleKey={module.key}
      recordKey={record.key}
      plural={record.pluralName}
      queryKey={query?.key}
      draftRevision={draftRevision}
    />
  );
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-8 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold tracking-tight">
          {query?.label ?? record.pluralName}
        </h2>
        {module.ownerApplication === undefined ? null : (
          <Badge variant="outline">
            <Icon name="shield" />
            Read-only
          </Badge>
        )}
      </div>
      {module.ownerApplication === undefined ? null : (
        <Alert variant="info">
          <AlertTitle>Read-only record type</AlertTitle>
          <AlertDescription>
            Owned by {module.name}. Change its definition in the owning application.
          </AlertDescription>
        </Alert>
      )}
      {query !== undefined ? (
        results
      ) : (
        <Tabs
          key={`${module.key}:${record.key}`}
          value={section}
          onValueChange={(value) => onSectionChange(String(value))}
          className="gap-6"
        >
          <TabsList
            variant="line"
            aria-label={`${record.pluralName} sections`}
            className="max-w-full overflow-x-auto"
          >
            <TabsTrigger value="fields">Fields</TabsTrigger>
            <TabsTrigger value="records">Records</TabsTrigger>
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
            <TabsTrigger value="search">Search</TabsTrigger>
          </TabsList>
          <TabsContent value="fields" className="space-y-6">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold">
                Fields <Badge variant="secondary">{record.fields.length}</Badge>
              </h3>
              {onAddField === undefined ? null : (
                <Button type="button" onClick={onAddField}>
                  <Icon name="plus" />
                  Field
                </Button>
              )}
            </div>
            <SchemaGrid
              source={source}
              moduleKey={module.key}
              record={record}
              selectedField={selection.kind === "field" ? selection.fieldKey : undefined}
              onSelect={onSelect}
            />
            {relationships}
          </TabsContent>
          <TabsContent value="records">{section === "records" && results}</TabsContent>
          <TabsContent value="rules">
            {rules ?? (
              <StudioDataEmpty
                title="Rules are read-only"
                description="Open the owning application to change its record rules."
              />
            )}
          </TabsContent>
          <TabsContent value="pipelines">
            {pipelines ?? (
              <StudioDataEmpty
                title="Pipelines are read-only"
                description="Open the owning application to change its pipelines."
              />
            )}
          </TabsContent>
          <TabsContent value="search">{search}</TabsContent>
        </Tabs>
      )}
    </div>
  );
}
