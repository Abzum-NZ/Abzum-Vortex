"use client";
import { useMemo, useState } from "react";
import type { ConditionNode } from "@vortex/platform/schema";
import {
  describeStudioCompositionGate,
  resolveStudioReactionTarget,
  StudioDialog,
  StudioHelp,
  StudioEditButton,
  StudioInspectorGroup,
  studioReactionSlots,
  type StudioApplicationConditionContext,
  type StudioCompositionCommand,
  type StudioCompositionContext,
  type StudioCompositionOutcome,
  type StudioReactionCommandResult,
  type StudioReactionSlot,
  type StudioSemanticSelection,
  type StudioStoredApplicationDraft,
} from "@vortex/ui/studio";
import { StudioGateSelect } from "./studio-gate-select";
import { ApplicationReactionConditionEditor } from "./application-reaction-condition-editor";

/** How many comparisons a stored condition holds, however deeply they are nested. */
const comparisonsIn = (node: unknown): number =>
  typeof node !== "object" || node === null
    ? 0
    : "operator" in node
      ? 1
      : Object.values(node).reduce<number>((total, child) => total + comparisonsIn(child), 0);

const conditionSummary = (condition: unknown): string => {
  if (condition === undefined) return "Always";
  const count = comparisonsIn(condition);
  return count === 1 ? "1 comparison" : `${count} comparisons`;
};

/**
 * Who sees the selected block and when: its permission gate and its four conditions (when it shows,
 * is required, is read-only and is enabled). Each condition is one row with its summary; Edit opens
 * it in a dialog, and a valid rule reaches the draft as it changes.
 */
export function StudioBlockVisibility({
  context,
  selection,
  saved,
  disabled,
  onCommand,
  onReaction,
}: Readonly<{
  context: StudioCompositionContext;
  selection: StudioSemanticSelection;
  /** The saved draft, whose compiled fields a condition can name. */
  saved: StudioStoredApplicationDraft;
  disabled: boolean;
  onCommand: (
    expected: StudioCompositionContext,
    selection: StudioSemanticSelection,
    command: StudioCompositionCommand,
  ) => StudioCompositionOutcome;
  onReaction: (
    expected: StudioCompositionContext,
    selection: StudioSemanticSelection,
    metadata: StudioApplicationConditionContext | null,
    condition: ConditionNode | undefined,
    slot: StudioReactionSlot,
  ) => StudioReactionCommandResult;
}>) {
  const gate = useMemo(
    () => describeStudioCompositionGate(context, selection),
    [context, selection],
  );
  const target = resolveStudioReactionTarget(context.source, selection);
  const [feedback, setFeedback] = useState<StudioCompositionOutcome | null>(null);
  const [editing, setEditing] = useState<StudioReactionSlot | null>(null);
  const change = (next: string | null): boolean => {
    if (disabled) return false;
    const result = onCommand(context, selection, { kind: "gate", gate: next });
    setFeedback(result);
    return result.kind === "applied";
  };
  const permissionLabel =
    gate.kind === "available" && gate.permission !== null
      ? (context.source.body.permissions.find((item) => item.key === gate.permission)?.label ??
        context.source.body.modules
          .flatMap((module) => module.permissions)
          .find((item) => item.key === gate.permission)?.label ??
        gate.permission)
      : undefined;
  const set = studioReactionSlots.filter(
    ({ slot }) => target !== undefined && target.placement[slot] !== undefined,
  );
  const summary = [
    permissionLabel === undefined ? undefined : `Needs ${permissionLabel}`,
    set.length === 0 ? undefined : set.map(({ title }) => title).join(", "),
  ].filter((part) => part !== undefined);
  const slotInfo = studioReactionSlots.find((entry) => entry.slot === editing);
  return (
    <StudioInspectorGroup
      title="Visibility and access"
      defaultOpen={false}
      summary={summary.length === 0 ? "Visible to everyone, always" : summary.join(" · ")}
    >
      <div className="space-y-2">
        <p className="flex items-center gap-1 text-sm font-medium">
          Permission gate
          <StudioHelp hint="Show this block only to people who hold its permission. Page and menu permissions still apply. Clearing this gate adds no block permission requirement." />
        </p>
        {gate.kind === "available" ? (
          <StudioGateSelect
            source={context.source}
            value={gate.permission ?? ""}
            label="Who can see this block"
            disabled={disabled}
            onGate={(next) => next.kind === "existing" && change(next.key)}
            onClear={() => change(null)}
            allowCreate={false}
          />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {gate.reason}
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
      </div>
      {target === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          This block&apos;s conditions can&apos;t be changed here.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Conditions">
          {studioReactionSlots.map(({ slot, title }) => (
            <li key={slot} className="flex items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="block text-sm">{title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {conditionSummary(target.placement[slot])}
                </span>
              </span>
              <StudioEditButton
                label={`Edit ${title.toLowerCase()} condition`}
                disabled={disabled}
                onClick={() => setEditing(slot)}
              />
            </li>
          ))}
        </ul>
      )}
      {slotInfo !== undefined && (
        <StudioDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          title="Edit condition"
          description={`${slotInfo.title}. ${slotInfo.help}`}
          closeLabel="Done"
        >
          <ApplicationReactionConditionEditor
            slot={slotInfo.slot}
            context={context}
            selection={selection}
            saved={saved}
            disabled={disabled}
            onCommand={onReaction}
          />
        </StudioDialog>
      )}
    </StudioInspectorGroup>
  );
}
