"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactElement } from "react";
import {
  formatBytes,
  formatCount,
  recordsPhrase,
  recordsTableExportFormatLabels,
  recordsTableExportValues,
  recordsTableExportValuesLabels,
  type RecordsTableExportFormat,
  type RecordsTableExportValues,
} from "@vortex/platform/schema";
import { Button } from "../../components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../components/dropdown-menu";
import { toast } from "../../components/sonner";
import { Icon } from "../../icons/icon";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/tooltip";
import type { DisplayTableExportRun, DisplayTableExportScope } from "../projected-data";
import type {
  GridFeatureContext,
  GridFeatureModule,
  GridFeaturePointProps,
  GridFeatureScopeProps,
} from "./registry";

/** What a selection means to an export, from the page's own selection state. */
const selectionOf = (
  context: GridFeatureContext,
): Readonly<{ matching: number | undefined; selected: number }> => {
  const scope = context.selection.selectionScope;
  return scope?.kind === "matching"
    ? { matching: Math.max(0, scope.count - scope.excluded), selected: 0 }
    : { matching: undefined, selected: context.selectedRecordIds.length };
};

/** How the person chose to hold values in the next file; every table starts as shown. */
const ExportValuesContext = createContext<
  | Readonly<{ values: RecordsTableExportValues; choose: (next: RecordsTableExportValues) => void }>
  | undefined
>(undefined);

const useExportValues = () => {
  const held = useContext(ExportValuesContext);
  if (held === undefined) throw new Error("Export menus are drawn inside the Export scope");
  return held;
};

const request = (
  context: GridFeatureContext,
  scope: DisplayTableExportScope,
  format: RecordsTableExportFormat,
  values: RecordsTableExportValues,
): void => {
  void context.events?.export_requested?.({ event: "export_requested", scope, format, values });
};

/** The one choice beside the formats: the file holds values as shown (default) or as stored. */
function ExportValuesChoice({ rawColumns }: Readonly<{ rawColumns: boolean }>): ReactElement {
  const { values, choose } = useExportValues();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="flex items-center gap-1">
        Values
        {rawColumns ? (
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} aria-label="About values" />}>
              <Info className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Some columns always download their stored value</TooltipContent>
          </Tooltip>
        ) : null}
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={values}
        onValueChange={(next) => {
          const chosen = recordsTableExportValues.find((candidate) => candidate === next);
          if (chosen !== undefined) choose(chosen);
        }}
      >
        {recordsTableExportValues.map((choice) => (
          <DropdownMenuRadioItem key={choice} value={choice} closeOnClick={false}>
            {recordsTableExportValuesLabels[choice]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
    </DropdownMenuGroup>
  );
}

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
  const { values } = useExportValues();
  const formats = context.features.export?.formats ?? [];
  if (formats.length === 1)
    return (
      <DropdownMenuItem onClick={() => request(context, scope, formats[0]!, values)}>
        {label}
      </DropdownMenuItem>
    );
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {context.features.export?.formats.map((format) => (
          <DropdownMenuItem key={format} onClick={() => request(context, scope, format, values)}>
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
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-[var(--vortex-space-sm)] text-sm"
      >
        <span>
          Exporting{run.expected === undefined ? "" : ` ${recordsPhrase(run.expected)}`}…{" "}
          {formatBytes(run.bytes)} received
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
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Export</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <ExportValuesChoice rawColumns={context.features.export?.rawColumns === true} />
        <ExportScopeItem context={context} scope="view" label="Export this view" />
        {selected > 0 ? (
          <ExportScopeItem
            context={context}
            scope="selected"
            label={`Export selected (${formatCount(selected)})`}
          />
        ) : null}
        {matching !== undefined && matching > 0 ? (
          <ExportScopeItem
            context={context}
            scope="matching"
            label={`Export all ${formatCount(matching)} matching`}
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
    ? `Export all ${formatCount(matching)} matching`
    : `Export selected (${formatCount(selected)})`;
  const { values } = useExportValues();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        {label}
        <Icon name="chevron-down" data-icon="inline-end" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <ExportValuesChoice rawColumns={context.features.export?.rawColumns === true} />
        {context.features.export?.formats.map((format) => (
          <DropdownMenuItem
            key={format}
            onClick={() => request(context, allMatching ? "matching" : "selected", format, values)}
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
    const [values, choose] = useState<RecordsTableExportValues>("shown");
    return (
      <ExportValuesContext.Provider value={{ values, choose }}>
        {children}
      </ExportValuesContext.Provider>
    );
  },
  OverflowItems: ExportToolbarItems,
  SelectionBanner: ExportSelectionBanner,
};
