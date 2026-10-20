"use client";

import { useState, type ReactElement } from "react";
import type {
  RecordsTableBulkActionContract,
  RecordsTableBulkRefusalReason,
} from "@vortex/platform/schema";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/alert-dialog";
import { Badge } from "../../components/badge";
import { Button } from "../../components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/dropdown-menu";
import { Progress } from "../../components/progress";
import { Spinner } from "../../components/spinner";
import type { TableBulkRun, TableSelectionScope } from "../projected-grid-features";
import type { GridFeatureContext, GridFeatureModule, GridFeaturePointProps } from "./registry";

const numberFormat = new Intl.NumberFormat();
const records = (count: number): string =>
  count === 1 ? "1 record" : `${numberFormat.format(count)} records`;

/** How a refused record is described in a run's summary, grouped by reason. */
const refusalWords: Readonly<Record<RecordsTableBulkRefusalReason, string>> = {
  not_applicable: "the action does not apply to them in their current state",
  not_permitted: "you may not run it on them",
  changed: "they changed after you selected them",
  removed: "they were removed or you can no longer see them",
  refused: "their change was refused",
};

/** The number of records the selection holds now: the page's rows, or every matching record. */
const selectedCount = (context: GridFeatureContext): number => {
  const scope = context.selection.selectionScope;
  return scope?.kind === "matching"
    ? Math.max(0, scope.count - scope.excluded)
    : context.selectedRecordIds.length;
};

/** Aggregate only the server's decisions for the exact displayed revisions of this selection. */
const availabilityFor = (
  context: GridFeatureContext,
  action: string,
): Readonly<{ eligible: number; reason?: string }> | undefined => {
  const availability = context.selection.actionAvailability;
  const unchecked = {
    eligible: 0,
    reason: "availability could not be checked; select the records again",
  };
  if (availability === "unavailable") return unchecked;
  if (availability === undefined) return undefined;
  let eligible = 0;
  const reasons = new Set<RecordsTableBulkRefusalReason>();
  for (const recordId of context.selectedRecordIds) {
    const row = context.rows.find((candidate) => candidate.recordId === recordId);
    if (row === undefined) {
      reasons.add("removed");
      continue;
    }
    const record = availability.find(
      (candidate) => candidate.recordId === recordId && candidate.revision === row.revision,
    );
    // No decision for the displayed revision: never guess; the person selects again.
    const decision = record?.actions.find((candidate) => candidate.action === action);
    if (decision === undefined) return unchecked;
    if (decision.eligible) eligible += 1;
    else reasons.add(decision.reason);
  }
  return {
    eligible,
    ...(reasons.size === 0
      ? {}
      : { reason: [...reasons].map((reason) => refusalWords[reason]).join("; ") }),
  };
};

/**
 * Every declared bulk action as one Dropdown Menu. An action runs on the rows selected on this
 * page, or on every matching record once the person selected them all; the page runs it on the
 * server and follows its progress. An action that asks first, and every run over all matching
 * records, confirms with the exact number of records before it starts.
 */
function BulkActionsMenu({
  context,
}: Readonly<{ context: GridFeatureContext }>): ReactElement | null {
  const actions = context.features.bulkActions ?? [];
  const onBulkAction = context.events?.bulk_action;
  const [confirming, setConfirming] = useState<RecordsTableBulkActionContract | undefined>();
  if (onBulkAction === undefined || actions.length === 0) return null;
  const count = selectedCount(context);
  const scope = context.selection.selectionScope;
  const matching = scope?.kind === "matching";
  const running = context.selection.bulkRun?.status === "running";
  const ready = count > 0 && !running && scope?.kind !== "counting";
  const run = (action: RecordsTableBulkActionContract): void => {
    void onBulkAction({ event: "bulk_action", action: action.action });
  };
  const capped = confirming !== undefined && matching && count > confirming.maxRecords;
  const confirmedAvailability =
    confirming === undefined || matching ? undefined : availabilityFor(context, confirming.action);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              aria-label={`Bulk actions for ${context.accessibleName}`}
              disabled={!ready}
              aria-busy={running}
            />
          }
        >
          {running ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
          Bulk actions
          {count > 0 ? <Badge variant="secondary">{numberFormat.format(count)}</Badge> : null}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {actions.map((action) => {
            const availability = matching ? undefined : availabilityFor(context, action.action);
            const partial =
              availability !== undefined &&
              availability.eligible > 0 &&
              availability.eligible < count;
            const description = matching
              ? "Decided per record when run"
              : availability === undefined
                ? "Checking availability…"
                : availability.eligible === count
                  ? "Available for all selected records"
                  : partial
                    ? `${numberFormat.format(availability.eligible)} of ${numberFormat.format(count)} can use this action. All selected records must be eligible.`
                    : `Unavailable: ${availability.reason}`;
            return (
              <DropdownMenuItem
                key={action.action}
                disabled={
                  !ready ||
                  (!matching &&
                    (count > action.maxRecords ||
                      availability === undefined ||
                      availability.eligible !== count))
                }
                onClick={() => {
                  if (action.confirm || matching) setConfirming(action);
                  else run(action);
                }}
              >
                <span className="flex max-w-72 flex-col gap-1 whitespace-normal">
                  <span>{action.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {!matching && count > action.maxRecords
                      ? `Select at most ${records(action.maxRecords)}`
                      : description}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.label} for {records(capped ? confirming!.maxRecords : count)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {capped
                ? `${records(count)} match, and this action changes at most ${records(confirming!.maxRecords)} at a time: the first ${numberFormat.format(confirming!.maxRecords)} in the table's order are changed. `
                : `This changes ${records(count)}. `}
              {matching
                ? "Records it does not apply to, or that you may not change, are left as they are and reported when it finishes."
                : "All selected records must allow this action. If any record cannot change, none of them change."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                !ready ||
                (!matching &&
                  confirming !== undefined &&
                  (count > confirming.maxRecords || confirmedAvailability?.eligible !== count))
              }
              onClick={() => {
                if (confirming !== undefined) run(confirming);
                setConfirming(undefined);
              }}
            >
              {confirming?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The sentence of a finished run, its drift and what it left unchanged. */
function RunSummary({ run }: Readonly<{ run: Extract<TableBulkRun, { status: "finished" }> }>) {
  const { summary } = run;
  const refused = summary.refused.reduce((sum, item) => sum + item.count, 0);
  const drift = summary.total - run.selected;
  return (
    <span className="min-w-0">
      {run.label}: {records(summary.done)} of {numberFormat.format(summary.total)} changed.
      {!summary.limited && drift !== 0 && run.selected > 0
        ? ` ${numberFormat.format(Math.abs(drift))} ${drift > 0 ? "more matched" : "fewer matched"} than when you selected them.`
        : ""}
      {refused > 0
        ? ` ${records(refused)} not changed: ${summary.refused
            .map(
              (item) => `${numberFormat.format(item.count)} because ${refusalWords[item.reason]}`,
            )
            .join("; ")}.`
        : ""}
      {summary.notProcessed > 0
        ? ` ${records(summary.notProcessed)} not reached${refused > 0 && summary.done === 0 ? ", so nothing was changed" : ""}.`
        : ""}
      {summary.limited ? " More records matched than the action's limit." : ""}
    </span>
  );
}

const scopeMessage = (scope: TableSelectionScope | undefined): string | undefined => {
  if (scope?.kind === "counting") return "Counting the matching records...";
  if (scope?.kind !== "not_counted") return undefined;
  return scope.reason === "too_many"
    ? "More than 100,000 records match; narrow the filter."
    : scope.reason === "search_not_counted"
      ? "Clear the search to select every matching record; filters can stay."
      : "The matching records could not be counted. Try again.";
};

/**
 * The selection band under the toolbar: how many records are selected, the offer to select every
 * matching record once the whole page is selected, a run's progress and its summary.
 */
function SelectionBand({
  context,
}: Readonly<{ context: GridFeatureContext }>): ReactElement | null {
  const onScope = context.events?.selection_scope_changed;
  const { selectionScope: scope, selectionToken, bulkRun: run } = context.selection;
  const pageCount = context.rows.length;
  const selected = context.selectedRecordIds.length;
  const clear =
    onScope === undefined ? null : (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void onScope({ event: "selection_scope_changed", scope: "cleared" })}
      >
        {run?.status === "finished" || run?.status === "failed" ? "Done" : "Clear selection"}
      </Button>
    );
  let body: ReactElement | null = null;
  if (run?.status === "running") {
    const percent =
      run.total === undefined || run.total === 0
        ? null
        : Math.round((run.processed / run.total) * 100);
    body = (
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span>
          {run.label}:{" "}
          {run.total === undefined
            ? "finding the records..."
            : `${numberFormat.format(run.processed)} of ${records(run.total)} done`}
        </span>
        <Progress value={percent} aria-label={`${run.label} progress`} />
      </div>
    );
  } else if (run?.status === "finished") body = <RunSummary run={run} />;
  else if (run?.status === "failed")
    body = (
      <span>
        {run.label} could not finish. Records it reached may have changed; the table shows them as
        they are now.
      </span>
    );
  else if (scope?.kind === "matching")
    body = (
      <span>
        {scope.count === 1
          ? "The 1 matching record is selected"
          : `All ${numberFormat.format(scope.count)} matching records are selected`}
        {scope.excluded > 0 ? `, except ${numberFormat.format(scope.excluded)} you unticked` : ""}.
      </span>
    );
  else if (scope !== undefined) body = <span>{scopeMessage(scope)}</span>;
  else if (selected > 0 && selected === pageCount && context.paged && selectionToken !== undefined)
    body = (
      <span>
        All {numberFormat.format(pageCount)} on this page are selected.{" "}
        {onScope === undefined ? null : (
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => void onScope({ event: "selection_scope_changed", scope: "matching" })}
          >
            Select all matching records
          </Button>
        )}
      </span>
    );
  else if (selected > 0) body = <span>{records(selected)} selected.</span>;
  if (body === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="order-last flex basis-full flex-wrap items-center gap-2 bg-muted/50 px-3 py-2 text-sm text-foreground"
    >
      {scope?.kind === "counting" ? <Spinner aria-hidden="true" /> : null}
      {body}
      {run?.status === "running" ? null : <span className="ms-auto">{clear}</span>}
    </div>
  );
}

/** Bulk actions: the action menu over the selection and the selection band. */
function BulkSelectionBanner({ context }: GridFeaturePointProps): ReactElement | null {
  if ((context.features.bulkActions ?? []).length === 0) return null;
  return (
    <>
      <BulkActionsMenu context={context} />
      <SelectionBand context={context} />
    </>
  );
}

export const gridFeature: GridFeatureModule = { SelectionBanner: BulkSelectionBanner };
