"use client";

import type { ReactElement } from "react";
import type { RecordsTableActionContract } from "@vortex/platform/schema";
import { Button } from "../../components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/dropdown-menu";
import { Spinner } from "../../components/spinner";
import { usePendingGesture } from "../../controls/pending-gesture";
import type { DisplayEventHandlers } from "../projected-data";
import type { GridFeatureModule, GridFeaturePointProps } from "./registry";

/**
 * Every bulk command over the current selection, as one Dropdown Menu bound to the declared
 * `bulk_action` event. A command is unavailable until at least one row is selected, and unavailable
 * while any selected row lacks the record action capability the command declares. It sends the
 * selected record identities as a bounded list, never an implicit first record.
 */
function BulkActionsMenu({
  accessibleName,
  actions,
  recordIds,
  canRun,
  events,
}: Readonly<{
  accessibleName: string;
  actions: readonly RecordsTableActionContract[];
  recordIds: readonly string[];
  canRun: (action: RecordsTableActionContract) => boolean;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  // The chosen command's flow keeps the menu's button busy until it settles.
  const gesture = usePendingGesture();
  const onBulkAction = events?.bulk_action;
  if (onBulkAction === undefined) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={`Bulk actions for ${accessibleName}`}
            disabled={gesture.pending}
            aria-busy={gesture.pending}
          />
        }
      >
        {gesture.pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
        Bulk actions
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.eventId}
            disabled={recordIds.length === 0 || !canRun(action)}
            onClick={() => {
              if (gesture.running()) return;
              gesture.track(
                onBulkAction({
                  event: "bulk_action",
                  eventId: action.eventId,
                  recordIds: [...recordIds],
                }),
              );
            }}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Bulk actions: the commands over the selected rows. A command that declares a capability stays
 * disabled unless every selected row reports it; the server re-checks every record it changes.
 */
function BulkSelectionBanner({ context }: GridFeaturePointProps): ReactElement | null {
  const actions = context.features.bulkActions ?? [];
  if (actions.length === 0 || context.rows.length === 0) return null;
  const canRun = (action: RecordsTableActionContract): boolean =>
    action.capability === undefined ||
    (context.selectedRecordIds.length > 0 &&
      context.selectedRecordIds.every(
        (recordId) =>
          context.rows
            .find((row) => row.recordId === recordId)
            ?.capabilities?.actions.includes(action.capability!) === true,
      ));
  return (
    <BulkActionsMenu
      accessibleName={context.accessibleName}
      actions={actions}
      recordIds={context.selectedRecordIds}
      canRun={canRun}
      events={context.events}
    />
  );
}

export const gridFeature: GridFeatureModule = { SelectionBanner: BulkSelectionBanner };
