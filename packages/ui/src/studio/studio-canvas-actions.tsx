"use client";

import { createUsePuck, useGetPuck } from "@puckeditor/core";
import { createPortal } from "react-dom";
import { Copy, Trash2 } from "lucide-react";
import { Button } from "../components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Icon } from "../icons";

const usePuckSelector = createUsePuck();

/** Selection actions live outside the scaled page, never over its content. */
export function StudioCanvasActions({ host }: Readonly<{ host: HTMLElement | null }>) {
  const selected = usePuckSelector((state) => state.selectedItem);
  const getPuck = useGetPuck();
  if (host === null || selected === null) return null;
  const puck = getPuck();
  const permissions = puck.getPermissions({ item: selected });
  const parent = puck.getParentById(selected.props.id);
  const label = puck.config.components[selected.type]?.label ?? selected.type;
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
  return createPortal(
    <div
      role="toolbar"
      aria-label="Selected block actions"
      className="flex min-h-9 min-w-0 items-center gap-1"
    >
      <span className="mr-auto truncate text-sm font-medium">{label}</span>
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
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Duplicate block"
              disabled={!permissions.duplicate}
              onClick={() => act("duplicate")}
            />
          }
        >
          <Copy aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>Duplicate block</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Delete block"
              disabled={!permissions.delete}
              onClick={() => act("remove")}
            />
          }
        >
          <Trash2 aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>Delete block</TooltipContent>
      </Tooltip>
    </div>,
    host,
  );
}

/** Replaces Puck's floating action bar with StudioCanvasActions. */
export const studioCanvasOverrides = { actionBar: () => <></> };
