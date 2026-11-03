"use client";

import { createUsePuck, useGetPuck, type Overrides } from "@puckeditor/core";
import type { ReactNode } from "react";
import { StudioCanvasIframe } from "./studio-canvas-root";
import { Copy, Trash2 } from "lucide-react";
import { Button } from "../components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Icon } from "../icons";
import { StudioReasoned, studioLimitReason } from "./studio-limit";
import { studioCanvasPermissionReason } from "./studio-canvas-permissions";
import { useStudioCanvas } from "./studio-puck-provider";

const usePuckSelector = createUsePuck();

/** One selection action: unavailable with its reason as the tooltip, or disabled where Puck forbids it. */
function BarAction({
  label,
  reason,
  disabled,
  onAct,
  children,
}: Readonly<{
  label: string;
  reason: string | undefined;
  disabled: boolean;
  onAct: () => void;
  children: ReactNode;
}>) {
  if (reason !== undefined)
    return (
      <StudioReasoned reason={reason}>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={onAct}>
          {children}
        </Button>
      </StudioReasoned>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={onAct}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Selection actions live above the scaled page, never over its content. */
export function StudioCanvasActions() {
  const selected = usePuckSelector((state) => state.selectedItem);
  const getPuck = useGetPuck();
  const { input, references } = useStudioCanvas();
  if (selected === null) return null;
  const puck = getPuck();
  const permissions = puck.getPermissions({ item: selected });
  const parent = puck.getParentById(selected.props.id);
  const label = puck.config.components[selected.type]?.label ?? selected.type;
  // A full application cannot take another block: Duplicate says so instead of failing on save.
  const placed =
    input.palette?.targets.kind === "available"
      ? (input.palette.targets.targets[0]?.placed ?? 0)
      : 0;
  // The reason an action is unavailable: the application's limit, then what the draft refers to.
  const duplicateReason =
    studioLimitReason("compositionPlacements", placed) ??
    studioCanvasPermissionReason(references, selected.props.id, "duplicate");
  const deleteReason = studioCanvasPermissionReason(references, selected.props.id, "delete");
  const act = (action: "duplicate" | "remove") => {
    const current = getPuck();
    const item = current.selectedItem;
    if (item === null || item.props.id !== selected.props.id) return;
    const allowed = current.getPermissions({ item });
    if (!(action === "duplicate" ? allowed.duplicate : allowed.delete)) return;
    const selector = current.getSelectorForId(item.props.id);
    if (selector === undefined) return;
    current.dispatch(
      action === "duplicate"
        ? { type: "duplicate", sourceIndex: selector.index, sourceZone: selector.zone }
        : { type: "remove", index: selector.index, zone: selector.zone },
    );
  };
  return (
    <div
      role="toolbar"
      aria-label="Selected block actions"
      className="flex shrink-0 items-center gap-1"
    >
      <span className="mr-1 max-w-40 truncate text-sm font-medium">{label}</span>
      {parent === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Select parent block"
                onClick={() => {
                  const current = getPuck();
                  const selector = current.getSelectorForId(parent.props.id);
                  if (selector !== undefined)
                    current.dispatch({ type: "setUi", ui: { itemSelector: selector } });
                }}
              />
            }
          >
            <Icon name="arrow-up" />
          </TooltipTrigger>
          <TooltipContent>Select parent block</TooltipContent>
        </Tooltip>
      )}
      <BarAction
        label="Duplicate block"
        reason={duplicateReason}
        disabled={!permissions.duplicate}
        onAct={() => act("duplicate")}
      >
        <Copy aria-hidden="true" />
      </BarAction>
      <BarAction
        label="Delete block"
        reason={deleteReason}
        disabled={!permissions.delete}
        onAct={() => act("remove")}
      >
        <Trash2 aria-hidden="true" />
      </BarAction>
    </div>
  );
}

/** Replaces Puck's floating action bar with StudioCanvasActions, and draws the frame in the iframe. */
export const studioCanvasOverrides: Partial<Overrides> = {
  actionBar: () => <></>,
  iframe: StudioCanvasIframe,
};
