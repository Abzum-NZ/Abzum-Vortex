"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  isRecord,
  type RecordsTableBulkRefusalReason,
  type RecordsTableActionContract,
} from "@vortex/platform/schema";
import { Button } from "../../components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/tooltip";
import { Spinner } from "../../components/spinner";
import { toast } from "../../components/sonner";
import { Icon } from "../../icons/icon";
import { usePendingGesture } from "../../controls/pending-gesture";
import { rowName } from "../context";
import type {
  GridFeatureCommandProps,
  GridFeatureInteractionProps,
  GridFeatureModule,
} from "./registry";

const reasons: Readonly<Record<RecordsTableBulkRefusalReason, string>> = {
  not_applicable: "This action does not apply to the record in its current state.",
  not_permitted: "You do not have permission to run this action on this record.",
  changed: "This record changed. Refresh before trying again.",
  removed: "This record was removed or you can no longer read it.",
  refused: "This action cannot run on this record.",
};

/** One control set shared by desktop rows and phone cards, using only the server's decisions. */
function RowCommands({ context, row }: GridFeatureCommandProps): ReactElement | null {
  const gesture = usePendingGesture();
  const [open, setOpen] = useState(false);
  const [allInMenu, setAllInMenu] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const projection = context.features.rowActions;
  const handler = context.events?.row_action;
  if (projection === undefined || handler === undefined || row.revision === undefined) return null;
  const current = projection.availability.find(
    (item) => item.recordId === row.recordId && item.revision === row.revision,
  );
  const commands = projection.actions.map((action) => {
    const decision = current?.actions.find((item) => item.action === action.eventId);
    return {
      action,
      reason:
        decision?.eligible === true
          ? undefined
          : decision?.eligible === false
            ? reasons[decision.reason]
            : "Refresh to check whether this action is available.",
    };
  });
  const inline =
    context.presentation === "cards"
      ? []
      : commands.filter(({ action }) => action.placement === "inline").slice(0, 3);
  // The menu also holds inline commands so a context-menu gesture can always reach every action.
  const overflow = commands.filter((command) => !inline.includes(command));
  const menu =
    allInMenu || context.presentation === "cards" || overflow.length === 0 ? commands : overflow;
  const name = rowName(row, context.columns[0]?.key);
  const run = (action: RecordsTableActionContract): void => {
    if (gesture.running()) return;
    const pending = Promise.resolve(
      handler({
        event: "row_action",
        eventId: action.eventId,
        recordId: row.recordId,
        revision: row.revision!,
      }),
    )
      .then((result) => {
        // A gesture ignored while another flow is busy has no outcome. Every returned outcome is
        // ours, so a malformed one is logged and shown as an error rather than quietly discarded.
        if (result === undefined) return;
        if (!isRecord(result) || typeof result.confirmed !== "boolean")
          throw new Error("ROW_ACTION_OUTCOME_INVALID");
        const notice =
          isRecord(result.notice) && typeof result.notice.text === "string"
            ? result.notice.text
            : undefined;
        if (result.confirmed === true) toast.success(`${action.label} completed`);
        else if (notice !== undefined) toast.error(notice);
      })
      .catch((error: unknown) => {
        console.error("[display] row action failed", error);
        toast.error("The action could not be completed. Try again.");
      });
    gesture.track(pending);
  };
  return (
    <span className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
      {inline.map(({ action, reason }) => (
        <Tooltip key={action.eventId}>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`${action.label}: ${name}`}
              disabled={gesture.pending || reason !== undefined}
              aria-busy={gesture.pending}
              onClick={() => run(action)}
            >
              {gesture.pending ? <Spinner aria-hidden="true" /> : <Icon name={action.icon} />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {reason === undefined ? action.label : `${action.label}: ${reason}`}
          </TooltipContent>
        </Tooltip>
      ))}
      <DropdownMenu
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setAllInMenu(triggerRef.current?.dataset.rowActionMenuAll === "true");
            if (triggerRef.current !== null) delete triggerRef.current.dataset.rowActionMenuAll;
          }
          setOpen(nextOpen);
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              ref={triggerRef}
              data-row-action-menu=""
              aria-label={`Actions for ${name}`}
              disabled={gesture.pending}
              aria-busy={gesture.pending}
            />
          }
        >
          {gesture.pending ? <Spinner aria-hidden="true" /> : <Icon name="more-horizontal" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent onClick={(event) => event.stopPropagation()}>
          {menu.map(({ action, reason }) => (
            <DropdownMenuItem
              key={action.eventId}
              disabled={gesture.pending || reason !== undefined}
              onClick={() => run(action)}
              className="items-start data-disabled:opacity-100"
            >
              <Icon name={action.icon} />
              <span className="flex min-w-0 flex-col">
                <span>{action.label}</span>
                {reason === undefined ? null : (
                  <span className="max-w-64 text-xs text-muted-foreground whitespace-normal">
                    {reason}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/** One listener per grid, never one per row; Enter/F2 already use the grid's cell control mode. */
function GridInteraction({ surface }: GridFeatureInteractionProps): null {
  const { rootRef } = surface;
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const open = (event: KeyboardEvent | MouseEvent): void => {
      if (
        event instanceof KeyboardEvent &&
        !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      )
        return;
      if (!(event.target instanceof Element)) return;
      const row = event.target.closest("[data-vortex-record-id]");
      const trigger = row?.querySelector<HTMLButtonElement>("[data-row-action-menu]");
      if (trigger === null || trigger === undefined || trigger.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      trigger.dataset.rowActionMenuAll = "true";
      trigger.focus();
      trigger.click();
    };
    root.addEventListener("keydown", open, true);
    root.addEventListener("contextmenu", open);
    return () => {
      root.removeEventListener("keydown", open, true);
      root.removeEventListener("contextmenu", open);
    };
  }, [rootRef]);
  return null;
}

export const gridFeature: GridFeatureModule = { RowCommands, GridInteraction };
