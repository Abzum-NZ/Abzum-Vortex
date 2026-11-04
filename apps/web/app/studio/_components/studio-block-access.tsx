"use client";
import { useMemo, useState, type ReactNode } from "react";
import type { ConditionNode } from "@vortex/platform/schema";
import {
  describeCondition,
  describeStudioCompositionGate,
  projectStudioReactionEditor,
  resolveStudioReactionTarget,
  StudioDialog,
  studioReactionSlots,
  type StudioAccessFieldValue,
  type StudioApplicationConditionContext,
  type StudioCompositionContext,
  type StudioReactionCommandResult,
  type StudioReactionSlot,
  type StudioSemanticSelection,
  type StudioStoredApplicationDraft,
} from "@vortex/ui/studio";
import {
  ApplicationReactionConditionEditor,
  useStudioReactionFields,
} from "./application-reaction-condition-editor";

/**
 * Who sees the selected block and when: its permission gate and its four conditions (when it shows,
 * is required, is read-only and is enabled). The inspector draws them as fields of the Visibility
 * and access group; this gives the fields their values and the conditions their dialog, where a
 * valid rule reaches the draft as it changes.
 */
export function useStudioBlockAccess({
  context,
  selection,
  saved,
  disabled,
  onGate,
  onReaction,
}: Readonly<{
  context: StudioCompositionContext;
  selection: StudioSemanticSelection;
  /** The saved draft, whose compiled fields a condition can name. */
  saved: StudioStoredApplicationDraft;
  disabled: boolean;
  /** Sets the block's permission gate (null clears it); answers whether the draft took it. */
  onGate: (permission: string | null) => boolean;
  onReaction: (
    expected: StudioCompositionContext,
    selection: StudioSemanticSelection,
    metadata: StudioApplicationConditionContext | null,
    condition: ConditionNode | undefined,
    slot: StudioReactionSlot,
  ) => StudioReactionCommandResult;
}>): Readonly<{ access: StudioAccessFieldValue; dialog: ReactNode }> {
  const gate = useMemo(
    () => describeStudioCompositionGate(context, selection),
    [context, selection],
  );
  const target = resolveStudioReactionTarget(context.source, selection);
  const [slot, setSlot] = useState<StudioReactionSlot>("visibility_condition");
  const [editing, setEditing] = useState(false);
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
  const access: StudioAccessFieldValue = {
    summary: summary.length === 0 ? "Visible to everyone, always" : summary.join(" · "),
    gate:
      gate.kind === "available"
        ? {
            kind: "available",
            source: context.source,
            permission: gate.permission ?? "",
            onChange: (next) => !disabled && onGate(next),
          }
        : { kind: "refused", reason: gate.reason },
    conditions:
      target === undefined
        ? { kind: "refused", reason: "This block's conditions can't be changed here." }
        : {
            kind: "available",
            rows: studioReactionSlots.map((entry) => ({
              slot: entry.slot,
              title: entry.title,
              words: words.get(entry.slot) ?? "",
              onEdit: () => {
                setSlot(entry.slot);
                setEditing(true);
              },
            })),
          },
  };
  const dialog = (
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
  );
  return { access, dialog };
}
