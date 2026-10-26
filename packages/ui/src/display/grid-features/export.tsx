"use client";

import { useEffect, useRef, type ReactElement } from "react";
import {
  recordsTableExportFormatLabels,
  type RecordsTableExportFormat,
} from "@vortex/platform/schema";
import { Button } from "../../components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../components/dropdown-menu";
import { toast } from "../../components/sonner";
import { Spinner } from "../../components/spinner";
import { Icon } from "../../icons/icon";
import type { DisplayTableExportRun, DisplayTableExportScope } from "../projected-data";
import type {
  GridFeatureContext,
  GridFeatureModule,
  GridFeaturePointProps,
  GridFeatureScopeProps,
} from "./registry";

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

const request = (
  context: GridFeatureContext,
  scope: DisplayTableExportScope,
  format: RecordsTableExportFormat,
): void => {
  void context.events?.export_requested?.({ event: "export_requested", scope, format });
};

/** Each scope offers only the file formats the installed table authored for this viewer. */
function ExportScopeItem({
  context,
  scope,
  label,
}: Readonly<{
  context: GridFeatureContext;
  scope: DisplayTableExportScope;
  label: string;
}>): ReactElement {
  const formats = context.features.export?.formats ?? [];
  if (formats.length === 1)
    return (
      <DropdownMenuItem onClick={() => request(context, scope, formats[0]!)}>
        {label}
      </DropdownMenuItem>
    );
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {context.features.export?.formats.map((format) => (
          <DropdownMenuItem key={format} onClick={() => request(context, scope, format)}>
            {recordsTableExportFormatLabels[format]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** The one sentence of a finished, stopped or refused export, shown once as a toast. */
function useExportToast(run: DisplayTableExportRun | undefined): void {
  const announced = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (run === undefined || run.status === "running" || announced.current === run.runId) return;
    announced.current = run.runId;
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
  const formats = context.features.export?.formats ?? [];
  if (formats.length === 1 && selected === 0 && !(matching !== undefined && matching > 0))
    return (
      <DropdownMenuItem onClick={() => request(context, "view", formats[0]!)}>
        Export
      </DropdownMenuItem>
    );
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Export</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <ExportScopeItem context={context} scope="view" label="Export this view" />
        {selected > 0 ? (
          <ExportScopeItem
            context={context}
            scope="selected"
            label={`Export selected (${numberFormat.format(selected)})`}
          />
        ) : null}
        {matching !== undefined && matching > 0 ? (
          <ExportScopeItem
            context={context}
            scope="matching"
            label={`Export all ${numberFormat.format(matching)} matching`}
          />
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * Export beside the selection: the rows ticked on this page, or every matching record once they
 * are all selected, in an authored file format. The server decides everything again.
 */
function ExportSelectionBanner({ context }: GridFeaturePointProps): ReactElement | null {
  const run = context.selection.exportRun;
  if (context.events?.export_requested === undefined || run?.status === "running") return null;
  const { matching, selected } = selectionOf(context);
  const allMatching = matching !== undefined && matching > 0;
  if (!allMatching && selected === 0) return null;
  const label = allMatching
    ? `Export all ${numberFormat.format(matching)} matching`
    : `Export selected (${numberFormat.format(selected)})`;
  const formats = context.features.export?.formats ?? [];
  if (formats.length === 1)
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => request(context, allMatching ? "matching" : "selected", formats[0]!)}
      >
        {label}
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        {label}
        <Icon name="chevron-down" data-icon="inline-end" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {context.features.export?.formats.map((format) => (
          <DropdownMenuItem
            key={format}
            onClick={() => request(context, allMatching ? "matching" : "selected", format)}
          >
            {recordsTableExportFormatLabels[format]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const gridFeature: GridFeatureModule = {
  Scope: function ExportScope({ context, children }: GridFeatureScopeProps): ReactElement {
    useExportToast(context.selection.exportRun);
    return <>{children}</>;
  },
  OverflowItems: ExportToolbarItems,
  SelectionBanner: ExportSelectionBanner,
};
