"use client";
import { useMemo, useState } from "react";
import type { ConditionNode } from "@vortex/platform/schema";
import {
  describeCondition,
  describeStudioCompositionGate,
  projectStudioReactionEditor,
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
import {
  ApplicationReactionConditionEditor,
  useStudioReactionFields,
} from "./application-reaction-condition-editor";

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
  const [slot, setSlot] = useState<StudioReactionSlot>("visibility_condition");
  const [editing, setEditing] = useState(false);
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
  const isSet = (name: StudioReactionSlot) =>
    target !== undefined && target.placement[name] !== undefined;
  const anySet = studioReactionSlots.some((entry) => isSet(entry.slot));
  // The condition in words needs the fields it names; they are read only when a condition is set.
  const fields = useStudioReactionFields({ context, selection, saved }, anySet);
  const wordsOf = (name: StudioReactionSlot): string => {
    if (!isSet(name)) return "Always";
    const model = projectStudioReactionEditor(context, selection, fields.metadata, name);
    return model.kind === "available" && model.condition !== undefined
      ? describeCondition(model.condition, model.controls)
      : fields.needsFields && fields.metadata === null
        ? "Reading the fields…"
        : "Set";
  };
  // Read each condition once per render: the words are shown in its row and in the summary.
  const words = new Map(studioReactionSlots.map((entry) => [entry.slot, wordsOf(entry.slot)]));
  const summary = [
    permissionLabel === undefined ? undefined : `Needs ${permissionLabel}`,
    ...studioReactionSlots
      .filter((entry) => isSet(entry.slot))
      .map((entry) => `${entry.title} ${words.get(entry.slot)}`),
  ].filter((part) => part !== undefined);
  const slotInfo = studioReactionSlots.find((entry) => entry.slot === slot)!;
  return (
    <StudioInspectorGroup
      title="Visibility and access"
      defaultOpen={false}
      summary={summary.length === 0 ? "Visible to everyone, always" : summary.join(" · ")}
    >
      <div className="space-y-2">
        <p className="flex items-center gap-1 text-sm font-medium">
          Permission gate
          <StudioHelp hint="Show this block only to people who hold its permission. Page and menu permissions still apply. Clearing this gate adds no block permission requirement. Create permissions in Access." />
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
          {studioReactionSlots.map((entry) => (
            <li key={entry.slot} className="flex items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="block text-sm">{entry.title}</span>
                <span
                  className="block truncate text-xs text-muted-foreground"
                  title={words.get(entry.slot)}
                >
                  {words.get(entry.slot)}
                </span>
              </span>
              <StudioEditButton
                label={`Edit ${entry.title.toLowerCase()} condition`}
                disabled={disabled}
                onClick={() => {
                  setSlot(entry.slot);
                  setEditing(true);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <StudioDialog
        open={editing}
        onOpenChange={setEditing}
        title={slotInfo.title}
        description={slotInfo.help}
        closeLabel="Done"
      >
        {editing && (
          <ApplicationReactionConditionEditor
            slot={slot}
            context={context}
            selection={selection}
            saved={saved}
            disabled={disabled}
            onCommand={onReaction}
          />
        )}
      </StudioDialog>
    </StudioInspectorGroup>
  );
}
