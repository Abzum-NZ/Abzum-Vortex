"use client";
import { useState } from "react";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vortex/ui/components/select";
import type {
  StudioPageLayoutPlan,
  StudioStructureCommand,
  StudioStructureResult,
} from "@vortex/ui/studio";
import { StudioField } from "./studio-field";

/** Collect every destination before applying a layout and its blocks as one draft edit. */
export function StudioPageLayoutDialog({
  pageAlias,
  pageName,
  shellAlias,
  layoutName,
  plan,
  disabled,
  onPreview,
  onCommand,
  onClose,
}: Readonly<{
  pageAlias: string;
  pageName: string;
  shellAlias: string | null;
  layoutName: string;
  plan: StudioPageLayoutPlan;
  disabled: boolean;
  onPreview: (command: StudioStructureCommand) => StudioStructureResult;
  onCommand: (command: StudioStructureCommand) => StudioStructureResult;
  onClose: () => void;
}>) {
  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      plan.areas.flatMap((area) =>
        area.suggestedTarget === null ? [] : [[area.id, area.suggestedTarget]],
      ),
    ),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const command: StudioStructureCommand = {
    kind: "move_page",
    pageAlias,
    shellAlias,
    areaMapping: mapping,
  };
  const complete = plan.areas.every((area) =>
    area.destinations.some((target) => target.id === mapping[area.id]),
  );
  const incompatible = plan.areas.some(
    (area) =>
      area.destinations.find((target) => target.id === mapping[area.id])?.problem !== undefined,
  );
  const preview = complete && !incompatible ? onPreview(command) : null;
  const refusal = problem ?? (preview?.kind === "refused" ? preview.message : null);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Where should these blocks go?</DialogTitle>
          <DialogDescription>
            Choose an area in {layoutName} for the blocks on {pageName}.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-96 space-y-4 overflow-y-auto">
          {plan.areas.map((area) => {
            const issue = area.destinations.find(
              (target) => target.id === mapping[area.id],
            )?.problem;
            const noDestination = area.destinations.length === 0;
            return (
              <StudioField
                key={area.id}
                label={
                  <span className="flex items-center gap-2">
                    <Icon name="chevron-right" className="size-4" />
                    {area.label}
                    <span className="text-sm font-normal text-muted-foreground">
                      {area.blockCount} {area.blockCount === 1 ? "block" : "blocks"}
                    </span>
                  </span>
                }
                error={
                  noDestination
                    ? "This layout has no areas for these blocks. Keep the old layout or choose another."
                    : issue
                }
              >
                {(control) => (
                  <Select
                    value={mapping[area.id] ?? null}
                    disabled={disabled || noDestination}
                    items={area.destinations.map((target) => ({
                      value: target.id,
                      label: target.label,
                    }))}
                    onValueChange={(value) => {
                      setMapping((current) => ({ ...current, [area.id]: value ?? "" }));
                      setProblem(null);
                    }}
                  >
                    <SelectTrigger {...control}>
                      <SelectValue placeholder="Choose an area" />
                    </SelectTrigger>
                    <SelectContent>
                      {area.destinations.map((target) => (
                        <SelectItem key={target.id} value={target.id}>
                          {target.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </StudioField>
            );
          })}
        </div>
        {refusal !== null && (
          <p role="alert" className="text-sm text-destructive">
            {refusal}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Keep old layout
          </Button>
          <Button
            disabled={disabled || !complete || preview?.kind !== "applied"}
            onClick={() => {
              const result = onCommand(command);
              if (result.kind === "refused") setProblem(result.message);
              else onClose();
            }}
          >
            Change layout
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
