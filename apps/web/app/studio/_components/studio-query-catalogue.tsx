"use client";
import { useState, type ReactNode } from "react";
import {
  applicationUses,
  setInlineQueryExposure,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import type { StudioDataSelection, StudioQueryInput } from "@vortex/ui/studio";
import { Icon } from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@vortex/ui/components/popover";
import { Switch } from "@vortex/ui/components/switch";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vortex/ui/components/table";
import { StudioPlaceList } from "./studio-used-in";
import { queryInputTypeLabel } from "./studio-query-editor";
import type { StudioModuleOwnerApplication } from "./module-fields-editor";
import {
  studioEditProblem,
  type StudioDataEdit,
  type StudioDataModule,
  type StudioDataQuery,
} from "../_lib/studio-data-model";

/** One row of the catalogue: a query and the module that holds it. */
type Row = Readonly<{ module: StudioDataModule; query: StudioDataQuery }>;

const headClass = "normal-case text-xs text-foreground";

/** The inputs a query asks for: name, type and whether it needs a value. */
function Inputs({ inputs }: Readonly<{ inputs: readonly StudioQueryInput[] }>) {
  if (inputs.length === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <ul className="list-none space-y-1">
      {inputs.map((input) => (
        <li key={input.key}>
          {input.label}{" "}
          <span className="text-muted-foreground">
            {queryInputTypeLabel(input.type)}, {input.required ? "required" : "optional"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Where this application uses a query: a count that opens the places. */
function UsedIn({
  source,
  moduleKey,
  query,
}: Readonly<{ source: ApplicationSourceDocument; moduleKey: string; query: StudioDataQuery }>) {
  const places = applicationUses(source, { kind: "query", moduleKey, queryKey: query.key });
  if (places.length === 0) return <span aria-label={`${query.label} is not used`}>0</span>;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="link"
            size="sm"
            className="dark:text-foreground dark:underline"
            aria-label={`Where ${query.label} is used`}
          />
        }
      >
        {places.length}
      </PopoverTrigger>
      <PopoverContent className="space-y-3 text-sm">
        <p className="font-medium">Used in</p>
        <StudioPlaceList places={places} label={`Where ${query.label} is used`} />
      </PopoverContent>
    </Popover>
  );
}

/** One section of the catalogue: its queries in a table, each opening in the inspector. */
function QueryTable({
  caption,
  rows,
  source,
  selected,
  onSelect,
  last,
}: Readonly<{
  caption: string;
  rows: readonly Row[];
  source: ApplicationSourceDocument;
  selected: StudioDataSelection | null;
  onSelect: (selection: StudioDataSelection) => void;
  /** The last column: the Expose switch of an owned query, or the application that owns a used one. */
  last: Readonly<{ title: string; cell: (row: Row) => ReactNode }>;
}>) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <Table containerClassName="border-0">
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className={headClass}>Query</TableHead>
            <TableHead className={headClass}>Records</TableHead>
            <TableHead className={headClass}>Inputs</TableHead>
            <TableHead className={`${headClass} w-20 text-center`}>Used in</TableHead>
            <TableHead className={`${headClass} w-36`}>{last.title}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ module, query }) => {
            const selection = {
              kind: "query",
              moduleKey: module.key,
              queryKey: query.key,
            } as const;
            const current =
              selected?.kind === "query" &&
              selected.moduleKey === module.key &&
              selected.queryKey === query.key;
            const record = module.recordTypes.find((item) => item.key === query.recordKey);
            return (
              <TableRow
                key={`${module.key}:${query.key}`}
                className="h-11 align-top"
                data-state={current ? "selected" : undefined}
              >
                <TableCell className="font-medium">
                  <button
                    type="button"
                    onClick={() => onSelect(selection)}
                    aria-current={current ? "true" : undefined}
                    aria-label={`Open ${query.label}`}
                    className="min-h-6 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {query.label}
                  </button>
                  {query.summary ? (
                    <Badge variant="outline" className="ml-2">
                      Summary
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>{record?.pluralName ?? query.recordKey}</TableCell>
                <TableCell>
                  <Inputs inputs={query.inputs} />
                </TableCell>
                <TableCell className="text-center tabular-nums">
                  <UsedIn source={source} moduleKey={module.key} query={query} />
                </TableCell>
                <TableCell className="whitespace-nowrap">{last.cell({ module, query })}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The application's query catalogue in the Data tab: "This app", the queries of the modules it
 * owns, each with whether it is exposed to the applications that use its module and a switch to
 * change that; and "From other apps", the exposed queries of the modules it uses, read-only and
 * named by the application that owns them. Each shows its records, its inputs and where this
 * application uses it. "New query" opens the query sheet.
 */
export function StudioQueryCatalogue({
  source,
  owned,
  used,
  applications,
  selected,
  disabled,
  edit,
  onSelect,
  onNew,
}: Readonly<{
  source: ApplicationSourceDocument;
  owned: readonly StudioDataModule[];
  /** The modules the application uses, as their installed release defines them; null while unknown. */
  used: readonly StudioDataModule[] | null;
  applications: readonly StudioModuleOwnerApplication[];
  selected: StudioDataSelection | null;
  disabled: boolean;
  edit: StudioDataEdit;
  onSelect: (selection: StudioDataSelection) => void;
  onNew: () => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const [problem, setProblem] = useState("");
  const own = owned.flatMap((module) => module.queries.map((query) => ({ module, query })));
  const borrowed = (used ?? []).flatMap((module) =>
    module.queries.map((query) => ({ module, query })),
  );
  const ownerName = (key: string | undefined) =>
    applications.find((application) => application.key === key)?.name ??
    key ??
    "Another application";
  const expose = async ({ module, query }: Row, exposed: boolean) => {
    setProblem("");
    if (
      !exposed &&
      !(await confirm({
        title: `Make ${query.label} private?`,
        description:
          "Only this application reads a private query. Applications that read it today keep reading it from the release they published; their next publish is refused until they choose another query.",
        confirmLabel: "Make private",
      }))
    )
      return;
    const result = edit((current) =>
      setInlineQueryExposure(current, module.key, query.key, exposed ? "exposed" : "private"),
    );
    const refused = studioEditProblem(result);
    if (refused !== undefined) setProblem(refused);
  };
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-8 py-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Queries</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            The data pages and blocks read. Expose a query to let the applications that use its
            module read it too.
          </p>
        </div>
        <Button type="button" size="sm" onClick={onNew} disabled={disabled}>
          <Icon name="plus" />
          New query
        </Button>
      </header>
      {problem === "" ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <section className="space-y-3" aria-labelledby="queries-this-app">
        <h3 id="queries-this-app" className="text-sm font-medium">
          This app <span className="text-muted-foreground tabular-nums">{own.length}</span>
        </h3>
        {own.length === 0 ? (
          <p className="text-sm text-muted-foreground">No queries yet. Add one with New query.</p>
        ) : (
          <QueryTable
            caption="Queries of this application"
            rows={own}
            source={source}
            selected={selected}
            onSelect={onSelect}
            last={{
              title: "Exposed",
              cell: (row) => (
                <span className="inline-flex items-center gap-2">
                  <Switch
                    checked={row.query.exposure === "exposed"}
                    disabled={disabled}
                    aria-label={`Expose ${row.query.label} to other applications`}
                    onCheckedChange={(checked) => {
                      void expose(row, checked);
                    }}
                  />
                  {row.query.exposure === "exposed" ? (
                    <Badge variant="secondary">Exposed</Badge>
                  ) : (
                    <span className="text-muted-foreground">Private</span>
                  )}
                </span>
              ),
            }}
          />
        )}
      </section>
      <section className="space-y-3" aria-labelledby="queries-other-apps">
        <h3 id="queries-other-apps" className="text-sm font-medium">
          From other apps{" "}
          <span className="text-muted-foreground tabular-nums">{borrowed.length}</span>
        </h3>
        {used === null ? (
          <p className="text-sm text-muted-foreground">
            The queries of the applications this one uses are listed after the draft is compiled.
          </p>
        ) : borrowed.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The applications this one uses expose no queries.
          </p>
        ) : (
          <QueryTable
            caption="Exposed queries of the applications this one uses"
            rows={borrowed}
            source={source}
            selected={selected}
            onSelect={onSelect}
            last={{
              title: "Owned by",
              cell: (row) => (
                <span className="inline-flex items-center gap-2">
                  <Icon name="blocks" className="size-4 text-muted-foreground" />
                  {ownerName(row.module.ownerApplication)}
                </span>
              ),
            }}
          />
        )}
      </section>
      {confirmDialog}
    </div>
  );
}
