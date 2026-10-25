"use client";
import { useMemo, useState } from "react";
import {
  describeStudioCompositionGate,
  StudioHelp,
  StudioInspectorGroup,
  type StudioCompositionCommand,
  type StudioCompositionContext,
  type StudioCompositionOutcome,
  type StudioSemanticSelection,
} from "@vortex/ui/studio";
import { StudioGateSelect } from "./studio-gate-select";

/** Edits only the selected block's gate through the shared composition history. */
export function StudioBlockGate({
  context,
  selection,
  disabled,
  onCommand,
}: Readonly<{
  context: StudioCompositionContext;
  selection: StudioSemanticSelection;
  disabled: boolean;
  onCommand: (
    expected: StudioCompositionContext,
    selection: StudioSemanticSelection,
    command: StudioCompositionCommand,
  ) => StudioCompositionOutcome;
}>) {
  const model = useMemo(
    () => describeStudioCompositionGate(context, selection),
    [context, selection],
  );
  const [feedback, setFeedback] = useState<StudioCompositionOutcome | null>(null);
  const change = (gate: string | null): boolean => {
    if (disabled) return false;
    const result = onCommand(context, selection, { kind: "gate", gate });
    setFeedback(result);
    return result.kind === "applied";
  };
  return (
    <StudioInspectorGroup title="Permission gate">
      <StudioHelp hint="Show this block only to people who hold its permission. Page and menu permissions still apply. Clearing this gate adds no block permission requirement." />
      {model.kind === "available" ? (
        <StudioGateSelect
          source={context.source}
          value={model.permission ?? ""}
          label="Who can see this block"
          disabled={disabled}
          onGate={(gate) => gate.kind === "existing" && change(gate.key)}
          onClear={() => change(null)}
          allowCreate={false}
        />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {model.reason}
        </p>
      )}
      {feedback !== null && (
        <p role="status" aria-live="polite" className="text-sm">
          {feedback.kind === "applied"
            ? "Block permission gate changed."
            : feedback.kind === "stale"
              ? "The draft or your selection changed. Try again."
              : (feedback.reason ??
                "This block's permission gate could not be changed. Nothing was changed.")}
        </p>
      )}
    </StudioInspectorGroup>
  );
}
