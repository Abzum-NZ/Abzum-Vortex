"use client";

import { MoreHorizontal } from "lucide-react";
import { useMemo, useRef, type ReactNode } from "react";
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
import { registerStudioActionBarMore } from "./studio-action-bar-focus";
import type { StudioBlockActions, StudioBlockDialogKind } from "./studio-puck-provider";

export type StudioMoreChoice = StudioBlockDialogKind | "remove";

type MoreProps = Readonly<{
  id: string;
  actions: StudioBlockActions;
  /** Why Move to, Wrap and Remove are unavailable (the screen, Puck permissions and the draft references). */
  reasons: Readonly<{
    move: string | undefined;
    wrap: string | undefined;
    remove: string | undefined;
  }>;
  tooltip: ReasonedTooltipProps;
  /** The toolbar's roving tab stop, as the bar's other buttons have. */
  stop: boolean;
  onStop: () => void;
  onChoose: (choice: StudioMoreChoice) => void;
}>;

/**
 * One entry: its label, and below it the reason while it is unavailable. The reason stays at full
 * strength (a disabled item is dimmed as a whole); the label alone is muted.
 */
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
      className="items-start data-disabled:opacity-100"
      onClick={onChoose}
    >
      <span className="flex min-w-0 flex-col items-start">
        <span className={reason === undefined ? undefined : "text-muted-foreground"}>{label}</span>
        {reason === undefined ? null : (
          <span className="max-w-64 text-xs whitespace-normal text-foreground">{reason}</span>
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
  const available = useMemo(() => actions.availability(id), [actions, id]);
  return (
    <>
      <MoreEntry
        label="Move to…"
        reason={reasons.move ?? available.move}
        onChoose={() => onChoose("move")}
      />
      <MoreEntry
        label="Wrap in container…"
        reason={reasons.wrap ?? available.wrap}
        onChoose={() => onChoose("wrap")}
      />
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
  const chosen = useRef<StudioMoreChoice | null>(null);
  // Set once an entry is chosen, until the menu opens again (`chosen` is cleared when it acts).
  const picked = useRef(false);
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) picked.current = false;
      }}
      // The choice acts once the menu has closed; the menu gives up its own focus return then
      // (`finalFocus` below), so a dialog or the neighbour's bar keeps the focus it takes.
      onOpenChangeComplete={(open) => {
        const choice = chosen.current;
        if (open || choice === null) return;
        chosen.current = null;
        onChoose(choice);
      }}
    >
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
                  // The dialogs this menu opens give the focus back to this button.
                  ref={(button) =>
                    button === null ? undefined : registerStudioActionBarMore(id, button)
                  }
                />
              }
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent {...tooltip}>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="min-w-44"
        // Studio's chrome is in sentence case: the canvas frame holds the menu outside the Studio
        // surface, under the application's style, so the menu carries the surface marker itself.
        data-vortex-surface="studio"
        // A choice takes the focus where it belongs (a dialog, the neighbour's bar after a removal);
        // the menu gives it back to its button only when nothing was chosen.
        finalFocus={() => !picked.current}
        style={{ ...tooltip.style, transformOrigin: "top right" }}
      >
        <MoreEntries
          id={id}
          actions={actions}
          reasons={reasons}
          onChoose={(choice) => {
            chosen.current = choice;
            picked.current = true;
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
