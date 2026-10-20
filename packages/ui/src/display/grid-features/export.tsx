"use client";

import { useEffect, useRef, type ReactElement } from "react";
import { Button } from "../../components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/dropdown-menu";
import { toast } from "../../components/sonner";
import { Spinner } from "../../components/spinner";
import { Icon } from "../../icons/icon";
import type { TableExportRun, TableExportScope } from "../projected-grid-features";
import type { GridFeatureContext, GridFeatureModule, GridFeaturePointProps } from "./registry";

const numberFormat = new Intl.NumberFormat();
const records = (count: number): string =>
  count === 1 ? "1 record" : `${numberFormat.format(count)} records`;

/** The bytes received so far, in the words of a file size. */
const size = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${numberFormat.format(Math.round(bytes / 1024))} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** What a selection means to an export, from the page's own selection state. */
const selectionOf = (
  context: GridFeatureContext,
): Readonly<{ matching: number | undefined; selected: number }> => {
  const scope = context.selection.selectionScope;
  return scope?.kind === "matching"
    ? { matching: Math.max(0, scope.count - scope.excluded), selected: 0 }
    : { matching: undefined, selected: context.selectedRecordIds.length };
};

const request = (context: GridFeatureContext, scope: TableExportScope): void => {
  void context.events?.export_requested?.({ event: "export_requested", scope });
};

/** The one sentence of a finished, stopped or refused export, shown once as a toast. */
function useExportToast(run: TableExportRun | undefined): void {
  const announced = useRef<TableExportRun | undefined>(undefined);
  useEffect(() => {
    if (run === undefined || run.status === "running" || announced.current === run) return;
    announced.current = run;
    // The file holds the records still readable now, so the count is never promised here.
    if (run.status === "finished") toast.success(`Export saved as ${run.filename}`);
    else if (run.status === "refused") toast.error(run.message);
    else if (run.status === "cancelled") toast("Export cancelled. No file was saved.");
    else
      toast.error(
        "The export stopped before it finished, so no file was saved. Nothing in the table changed; try again.",
      );
  }, [run]);
}

/**
 * Export in the toolbar: a menu of what to download, the running export with its honest progress
 * (bytes received, never a made-up percentage) and a Cancel that stops the server reading.
 */
function ExportToolbarItems({ context }: GridFeaturePointProps): ReactElement | null {
  const run = context.selection.exportRun;
  useExportToast(run);
  const onCancel = context.events?.export_cancelled;
  if (context.events?.export_requested === undefined) return null;
  if (run?.status === "running")
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm">
        <Spinner aria-hidden="true" />
        <span>
          Exporting{run.expected === undefined ? "" : ` ${records(run.expected)}`}…{" "}
          {size(run.bytes)} received
        </span>
        {onCancel === undefined ? null : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onCancel({ event: "export_cancelled" })}
          >
            Cancel export
          </Button>
        )}
      </div>
    );
  const { matching, selected } = selectionOf(context);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" aria-label={`Export ${context.accessibleName}`} />
        }
      >
        Export
        <Icon name="chevron-down" data-icon="inline-end" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => request(context, "view")}>
          <span className="flex max-w-72 flex-col gap-1 whitespace-normal">
            <span>Export this view</span>
            <span className="text-xs text-muted-foreground">
              A CSV file of the records that match the view, in the columns shown. Records are
              listed flat: groups and totals are not exported.
            </span>
          </span>
        </DropdownMenuItem>
        {selected > 0 ? (
          <DropdownMenuItem onClick={() => request(context, "selected")}>
            Export selected ({numberFormat.format(selected)})
          </DropdownMenuItem>
        ) : null}
        {matching !== undefined && matching > 0 ? (
          <DropdownMenuItem onClick={() => request(context, "matching")}>
            Export all {numberFormat.format(matching)} matching
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Export beside the selection: the rows ticked on this page, or every matching record once they
 * are all selected, as a CSV file in the columns shown. The server decides everything again.
 */
function ExportSelectionBanner({ context }: GridFeaturePointProps): ReactElement | null {
  const run = context.selection.exportRun;
  if (context.events?.export_requested === undefined || run?.status === "running") return null;
  const { matching, selected } = selectionOf(context);
  if (matching !== undefined && matching > 0)
    return (
      <Button variant="outline" size="sm" onClick={() => request(context, "matching")}>
        Export all {numberFormat.format(matching)} matching
      </Button>
    );
  if (selected === 0) return null;
  return (
    <Button variant="outline" size="sm" onClick={() => request(context, "selected")}>
      Export selected ({numberFormat.format(selected)})
    </Button>
  );
}

export const gridFeature: GridFeatureModule = {
  ToolbarItems: ExportToolbarItems,
  SelectionBanner: ExportSelectionBanner,
};
