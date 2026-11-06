"use client";

import { Puck } from "@puckeditor/core";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/empty";
import { Spinner } from "../components/spinner";
import { Icon } from "../icons";
import { studioPuckStyle } from "./studio-puck-style";
import { useStudioCanvasStatus } from "./studio-canvas-status";

/**
 * Puck's outline in a region of Studio's own: the Puck colour map, an accessible name, a height of
 * its own (Puck's outline scrolls its rows in its own wrapper and draws only the rows in view, so
 * it needs the panel's height less what is drawn below it), and inert while the draft takes no
 * edits, so the outline, the canvas and the bar agree. Puck's rows are native buttons: Tab and
 * Enter reach and select them. Arrow-key movement, one tab stop and tree roles have no public Puck
 * route (accepted 3 Nov).
 */
export function StudioOutlineRegion({ children }: Readonly<{ children: ReactNode }>) {
  const inert = useStudioCanvasStatus().disabled;
  return (
    <div
      role="region"
      aria-label="Outline of the canvas blocks"
      inert={inert}
      style={studioPuckStyle}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", inert && "opacity-60")}
    >
      {children}
    </div>
  );
}

/**
 * The Outline tab's body: Puck's outline of the blocks Puck holds, a loading state while the canvas
 * waits for its compile (Puck holds no data then), or the empty state when no page is open.
 */
export function StudioPuckOutline({ open }: Readonly<{ open: boolean }>) {
  const { ready } = useStudioCanvasStatus();
  if (!open)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon name="list-tree" />
          </EmptyMedia>
          <EmptyTitle>No page open</EmptyTitle>
          <EmptyDescription>
            Choose a page or layout in Structure to see its blocks.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  if (!ready)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Waiting for the canvas</EmptyTitle>
          <EmptyDescription>The blocks appear after the latest changes compile.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return <Puck.Outline />;
}
