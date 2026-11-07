"use client";
import { useState } from "react";
import type {
  ApplicationUsePlace,
  StudioStructureCommand,
  StudioStructureResult,
} from "@vortex/platform/schema";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import { studioNotice } from "./studio-save-state";
import { StudioPlaceList } from "./studio-used-in";

type Refusal = Readonly<{
  message: string;
  where?: readonly ApplicationUsePlace[] | undefined;
}>;

/**
 * Runs one Structure command for a control: a refusal uses the shared toast region with a way to
 * inspect references (`dialog`, drawn once by the control), and nothing changes.
 */
export function useStudioStructureRun(
  onCommand: (command: StudioStructureCommand, merge?: string) => StudioStructureResult,
) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [showReferences, setShowReferences] = useState(false);
  const run = (command: StudioStructureCommand, merge?: string): boolean => {
    const result = onCommand(command, merge);
    if (result.kind === "refused") {
      const hasReferences = result.where !== undefined && result.where.length > 0;
      studioNotice("Nothing was changed", "error", undefined, {
        id: "studio-structure-refusal",
        description: <span className="text-muted-foreground">{result.message}</span>,
        duration: Infinity,
        closeButton: true,
        action: {
          label: hasReferences ? "Show me where" : "Dismiss",
          onClick: () => {
            if (hasReferences) {
              setRefusal(result);
              setShowReferences(true);
            }
          },
        },
      });
    }
    return result.kind === "applied";
  };
  const reset = () => {
    setRefusal(null);
    setShowReferences(false);
  };
  const dialog = (
    <Dialog open={showReferences} onOpenChange={setShowReferences}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Where it is used</DialogTitle>
          <DialogDescription>{refusal?.message}</DialogDescription>
        </DialogHeader>
        <StudioPlaceList
          places={refusal?.where ?? []}
          label="Where it is used"
          onBeforeOpen={() => setShowReferences(false)}
        />
      </DialogContent>
    </Dialog>
  );
  return { run, reset, dialog };
}
