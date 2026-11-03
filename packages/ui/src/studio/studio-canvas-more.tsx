"use client";

import { MoreHorizontal } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Button } from "../components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import type { ReasonedTooltipProps } from "../components/reasoned";
import type { StudioBlockActions, StudioBlockDialogKind } from "./studio-puck-provider";

export type StudioMoreChoice = StudioBlockDialogKind | "remove";

type MoreProps = Readonly<{
  id: string;
  actions: StudioBlockActions;
  /** Why Move to and Remove are unavailable (Puck's permissions and the draft's references). */
  reasons: Readonly<{ move: string | undefined; remove: string | undefined }>;
  tooltip: ReasonedTooltipProps;
  /** The toolbar's roving tab stop, as the bar's other buttons have. */
  stop: boolean;
  onStop: () => void;
  onChoose: (choice: StudioMoreChoice) => void;
}>;

/** One entry: its label, and below it the reason while it is unavailable. */
function MoreEntry({
  label,
  reason,
  destructive,
  onChoose,
}: Readonly<{
  label: string;
  reason: string | undefined;
  destructive?: boolean;
  onChoose: () => void;
}>): ReactNode {
  return (
    <DropdownMenuItem
      disabled={reason !== undefined}
      variant={destructive === true ? "destructive" : "default"}
      onClick={onChoose}
    >
      <span className="flex min-w-0 flex-col items-start">
        <span>{label}</span>
        {reason === undefined ? null : (
          <span className="max-w-64 text-xs text-muted-foreground">{reason}</span>
        )}
      </span>
    </DropdownMenuItem>
  );
}

/** The entries, read from the draft when the menu opens (they are mounted only while it is open). */
function MoreEntries({
  id,
  actions,
  reasons,
  onChoose,
}: Pick<MoreProps, "id" | "actions" | "reasons" | "onChoose">) {
  const wrap = useMemo(() => actions.availability(id).wrap, [actions, id]);
  return (
    <>
      <MoreEntry label="Move to…" reason={reasons.move} onChoose={() => onChoose("move")} />
      <MoreEntry label="Wrap in container…" reason={wrap} onChoose={() => onChoose("wrap")} />
      <MoreEntry label="Used in…" reason={undefined} onChoose={() => onChoose("usedIn")} />
      <DropdownMenuSeparator />
      <MoreEntry
        label="Remove"
        reason={reasons.remove}
        destructive
        onChoose={() => onChoose("remove")}
      />
    </>
  );
}

/**
 * The bar's More menu: Move to, Wrap in container, Used in and Remove. Each entry that is not
 * allowed is disabled and says why. It is the bar's last button, in the bar's arrow-key order.
 */
export function StudioCanvasMore({
  id,
  actions,
  reasons,
  tooltip,
  stop,
  onStop,
  onChoose,
}: MoreProps) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="More actions"
                  tabIndex={stop ? 0 : -1}
                  onFocus={onStop}
                />
              }
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent {...tooltip}>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-44">
        <MoreEntries id={id} actions={actions} reasons={reasons} onChoose={onChoose} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
