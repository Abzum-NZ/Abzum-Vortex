"use client";

import { Drawer } from "@puckeditor/core";
import { useId, useMemo, useState } from "react";
import { Button } from "../components/button";
import { Input } from "../components/input";
import { Label } from "../components/label";
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import type { StudioCompositionAddTarget, StudioCompositionDestination } from "./application-composition-commands";
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
  message,
  onAdd,
}: Readonly<{
  /** The places of the content area the canvas shows. */
  targets: readonly StudioCompositionAddTarget[];
  /** Whether the canvas takes edits now (desktop, not busy, stored data readable). */
  editable: boolean;
  message: string;
  onAdd: (request: StudioCanvasAddRequest) => void;
}>) {
  const [search, setSearch] = useState("");
  const [targetId, setTargetId] = useState("");
  const searchId = useId();
  const targetSelectId = useId();
  const target = targets.find((candidate) => candidate.id === targetId) ?? targets[0];
  const groups = useMemo(() => groupStudioPaletteChoices(target?.choices ?? [], search), [target, search]);
  if (target === undefined)
    return <p role="status" className="text-sm text-muted-foreground">This page has no place for new blocks.</p>;
  const add = (choice: StudioPaletteChoice) =>
    onAdd({ area: target.area, destination: target.destination, index: END_OF_SLOT, rendererKey: choice.rendererKey });

  return (
    <div className="space-y-3" data-vortex-studio-palette="">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={searchId}>Search blocks</Label>
        <Input id={searchId} type="search" value={search} placeholder="Name, description or group"
          onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={targetSelectId}>Add to</Label>
        <NativeSelect id={targetSelectId} className="w-full" value={target.id}
          onChange={(event) => setTargetId(event.target.value)}>
          {targets.map((candidate) => (
            <NativeSelectOption key={candidate.id} value={candidate.id}>
              {`${"  ".repeat(candidate.depth)}${candidate.label}`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">
          Drag a block onto any place on the page, or use Add to put it at the end of this place.
        </p>
      </div>
      {message.length === 0 ? null : <p role="status" aria-live="polite" className="text-sm">{message}</p>}
      {groups.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {search.trim().length > 0 ? "No block matches this search." : "This place takes no new blocks."}
        </p>
      ) : (
        <Drawer>
          {groups.map((group) => (
            <section key={group.group} aria-label={group.label} className="space-y-2">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{group.label}</h3>
              <ul className="space-y-2">
                {group.choices.map((choice) => {
                  const available = choice.unavailable === undefined;
                  return (
                    <li key={choice.id} className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <Drawer.Item name={choice.rendererKey} label={choice.name}
                          isDragDisabled={!editable || !available}>
                          {() => (
                            <div className="rounded-lg border border-border bg-card p-2 text-card-foreground">
                              <p className="text-sm font-medium">{choice.name}</p>
                              <p className="text-xs text-muted-foreground">{choice.description}</p>
                              {available ? null : <p className="text-xs text-muted-foreground">{choice.unavailable}</p>}
                            </div>
                          )}
                        </Drawer.Item>
                      </div>
                      <Button type="button" variant="outline" size="sm" disabled={!editable || !available}
                        aria-label={`Add ${choice.name} to ${target.label}`} onClick={() => add(choice)}>
                        Add
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </Drawer>
      )}
    </div>
  );
}
