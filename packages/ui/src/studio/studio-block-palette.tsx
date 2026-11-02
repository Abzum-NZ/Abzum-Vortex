"use client";

import { Icon, resolveVortexIconName } from "../icons";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "../components/empty";
import { Drawer } from "@puckeditor/core";
import { useId, useMemo, useState } from "react";
import { studioPuckStyle } from "./studio-puck-style";
import { Button } from "../components/button";
import { Input } from "../components/input";
import { Label } from "../components/label";
import { Alert, AlertDescription } from "../components/alert";
import { definitionLimitMessage, definitionLimitReached } from "@vortex/platform/schema";
import { StudioLimitNote, StudioReasoned } from "./studio-limit";
import { StudioOptionControl } from "./studio-setting-basic-controls";
import type {
  StudioCompositionAddTarget,
  StudioCompositionDestination,
} from "./application-composition-commands";
import { groupStudioPaletteChoices, type StudioPaletteChoice } from "./contextual-palette";

/** A new block for one place on the page, from a drop on the canvas or the palette's Add button. */
export type StudioCanvasAddRequest = Readonly<{
  area: string;
  destination: StudioCompositionDestination;
  /** The position in the slot; a position past its end adds the block last. */
  index: number;
  /** The Puck component the person dragged or chose: the block's renderer key. */
  rendererKey: string;
}>;

/** The end of a slot, for the keyboard add: the add command adds a block past the end last. */
const END_OF_SLOT = Number.MAX_SAFE_INTEGER;

/**
 * The block palette, drawn in Studio's Blocks panel but inside the canvas's Puck editor, so a block
 * is dragged with Puck's own drag and drop. Every block is a Puck drawer item named by its renderer
 * key; its Add button adds it at the end of the chosen place, for keyboard users. Both reach Studio's
 * one add command.
 */
export function StudioBlockPalette({
  targets,
  editable,
  owner,
  message,
  onAdd,
}: Readonly<{
  /** The places of the content area the canvas shows. */
  targets: readonly StudioCompositionAddTarget[];
  /** Whether the canvas takes edits now (desktop, not busy, stored data readable). */
  editable: boolean;
  /** A page's blocks also drag onto the canvas; a layout's blocks are added with Add. */
  owner: "page" | "layout";
  message: string;
  onAdd: (request: StudioCanvasAddRequest) => void;
}>) {
  const [search, setSearch] = useState("");
  const [targetId, setTargetId] = useState("");
  const searchId = useId();
  const limitId = useId();
  const targetSelectId = useId();
  const target = targets.find((candidate) => candidate.id === targetId) ?? targets[0];
  // The place is full when the application holds every block it may, or the place nests as deep as
  // a block may: said once here, not on every row.
  const limitReason =
    target === undefined
      ? undefined
      : definitionLimitReached("compositionPlacements", target.placed)
        ? definitionLimitMessage("compositionPlacements")
        : definitionLimitReached("compositionDepth", target.depth)
          ? definitionLimitMessage("compositionDepth")
          : undefined;
  const groups = useMemo(
    () => groupStudioPaletteChoices(target?.choices ?? [], search),
    [target, search],
  );
  if (target === undefined)
    return (
      <Empty role="status">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon name="blocks" />
          </EmptyMedia>
          <EmptyTitle>No block targets</EmptyTitle>
          <EmptyDescription>
            {owner === "layout"
              ? "This layout has no place for new blocks."
              : "This page has no place for new blocks."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  const add = (choice: StudioPaletteChoice) =>
    onAdd({
      area: target.area,
      destination: target.destination,
      index: END_OF_SLOT,
      rendererKey: choice.rendererKey,
    });

  return (
    <div className="space-y-3" data-vortex-studio-palette="" style={studioPuckStyle}>
      <div className="flex flex-col gap-2">
        <Label htmlFor={targetSelectId}>Add to</Label>
        <StudioOptionControl
          id={targetSelectId}
          value={target.id}
          disabled={false}
          options={targets.map((candidate) => ({
            value: candidate.id,
            label:
              candidate.depth === 0
                ? candidate.label
                : `${candidate.label} (level ${candidate.depth + 1})`,
          }))}
          onChange={(value) => setTargetId(value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={searchId}>Search blocks</Label>
        <Input
          id={searchId}
          type="search"
          value={search}
          placeholder="Find a block"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {/* The answer to an Add is announced, not drawn: a line that comes and goes would move the list. */}
      <p role="status" aria-live="polite" className="sr-only">
        {message}
      </p>
      {limitReason === undefined ? (
        <>
          <StudioLimitNote
            limit="compositionPlacements"
            used={target.placed}
            label="Blocks in the application"
          />
          <StudioLimitNote limit="compositionDepth" used={target.depth} label="Levels above here" />
        </>
      ) : (
        <Alert role="status" id={limitId}>
          <AlertDescription>{limitReason}</AlertDescription>
        </Alert>
      )}
      {groups.length === 0 ? (
        <Empty role="status">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon name="search" />
            </EmptyMedia>
            <EmptyTitle>No blocks found</EmptyTitle>
            <EmptyDescription>
              {search.trim().length > 0
                ? "Try another name or group."
                : "This place takes no new blocks."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Drawer>
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.group} aria-label={group.label} className="space-y-2">
                <h3 className="text-sm font-medium text-foreground">{group.label}</h3>
                <div className="space-y-1">
                  {group.choices.map((choice) => {
                    const available = choice.unavailable === undefined;
                    return (
                      <div
                        key={choice.id}
                        className="group flex min-w-0 items-center gap-2 rounded-md py-2 hover:bg-accent focus-within:bg-accent"
                      >
                        <Drawer.Item
                          name={choice.rendererKey}
                          label={choice.name}
                          isDragDisabled={!editable || !available || owner === "layout"}
                        >
                          {() => (
                            <div className="flex min-w-0 items-start gap-2">
                              <Icon
                                name={resolveVortexIconName(choice.icon) ?? "blocks"}
                                className="mt-1 size-5 shrink-0"
                              />
                              <div className="min-w-0">
                                <span className="block text-sm font-medium">{choice.name}</span>
                                <span className="line-clamp-1 text-sm text-muted-foreground group-hover:text-accent-foreground group-focus-within:text-accent-foreground">
                                  {choice.unavailable === limitReason
                                    ? choice.description
                                    : (choice.unavailable ?? choice.description)}
                                </span>
                              </div>
                            </div>
                          )}
                        </Drawer.Item>
                        <StudioReasoned
                          reason={choice.unavailable}
                          describedBy={choice.unavailable === limitReason ? limitId : undefined}
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="ml-auto shrink-0"
                            disabled={!editable}
                            aria-label={`Add ${choice.name} to ${target.label}`}
                            onClick={() => add(choice)}
                          >
                            <Icon name="plus" />
                          </Button>
                        </StudioReasoned>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </Drawer>
      )}
    </div>
  );
}
