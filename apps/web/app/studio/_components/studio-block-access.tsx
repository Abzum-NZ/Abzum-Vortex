"use client";
import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  canonicalJson,
  type ApplicationAudience,
  type ConditionNode,
  describeStudioCompositionGate,
  type StudioCompositionContext,
  type StudioSemanticSelection,
  type StudioStoredApplicationDraft,
  describeCondition,
  projectStudioReactionEditor,
  resolveStudioReactionTarget,
  studioReactionSlots,
  type StudioApplicationConditionContext,
  type StudioReactionCommandResult,
  type StudioReactionSlot,
} from "@vortex/platform/schema";
import { StudioDialog, type StudioAccessFieldValue, useStudioSameByKey } from "@vortex/ui/studio";
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
  problems,
  onGate,
  onUse,
  onAudience,
  onReaction,
}: Readonly<{
  context: StudioCompositionContext;
  selection: StudioSemanticSelection;
  /** The saved draft, whose compiled fields a condition can name. */
  saved: StudioStoredApplicationDraft;
  disabled: boolean;
  /** Why the draft refused the last change of each; shown at its field until the draft changes. */
  problems: Readonly<{
    gate?: string | undefined;
    use?: string | undefined;
    audience?: string | undefined;
  }>;
  /** Sets the block's permission gate (null clears it); answers whether the draft took it. */
  onGate: (permission: string | null) => boolean;
  /** Sets the permission that lets people use the block (null clears it). */
  onUse: (permission: string | null) => boolean;
  /** Sets who the block is offered to (null is everyone). */
  onAudience: (audience: ApplicationAudience | null) => boolean;
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
  const target = useMemo(
    () => resolveStudioReactionTarget(context.source, selection),
    [context.source, selection],
  );
  const [slot, setSlot] = useState<StudioReactionSlot>("visibility_condition");
  const [editing, setEditing] = useState(false);
  const isSet = (name: StudioReactionSlot) =>
    target !== undefined && target.placement[name] !== undefined;
  const anySet = studioReactionSlots.some((entry) => isSet(entry.slot));
  // The condition in words needs the fields it names; they are read only when a condition is set.
  const fields = useStudioReactionFields({ context, selection, saved }, anySet);
  // The words are shown in each row and in the summary: read once per change of the draft.
  const words = useMemo(() => {
    const wordsOf = (name: StudioReactionSlot): string => {
      if (target?.placement[name] === undefined) return "Always";
      const model = projectStudioReactionEditor(context, selection, fields.metadata, name);
      return model.kind === "available" && model.condition !== undefined
        ? describeCondition(model.condition, model.controls)
        : fields.needsFields && fields.metadata === null
          ? "Reading the fields…"
          : "Set";
    };
    return new Map(studioReactionSlots.map((entry) => [entry.slot, wordsOf(entry.slot)]));
  }, [context, selection, target, fields.metadata, fields.needsFields]);
  // The gate callback reads the latest handler, so the field values keep their identity between renders.
  const handlers = useRef({ onGate, onUse, onAudience });
  handlers.current = { onGate, onUse, onAudience };
  // The permission picker reads the permissions, the roles that hold them and the modules' own
  // permissions: the source it is handed stays the same object while those are unchanged.
  const gateSourceKey = useMemo(
    () =>
      canonicalJson([
        context.source.body.permissions,
        context.source.body.roles,
        context.source.body.modules.map((module) => module.permissions),
      ]),
    [context.source],
  );
  const gateSource = useStudioSameByKey(context.source, gateSourceKey);
  const hasTarget = target !== undefined;
  const slotsSet = studioReactionSlots
    .filter((entry) => target?.placement[entry.slot] !== undefined)
    .map((entry) => entry.slot)
    .join(",");
  const wordsKey = JSON.stringify([...words]);
  const gatePermission = gate.kind === "available" ? (gate.permission ?? "") : "";
  const gateUse = gate.kind === "available" ? (gate.use ?? "") : "";
  const useOffered = gate.kind === "available" && gate.useOffered;
  const gateAudience = gate.kind === "available" ? (gate.audience ?? "") : "";
  const gateReason = gate.kind === "available" ? "" : gate.reason;
  // What the fields draw is a handful of values: the value keeps its identity until one changes.
  const access = useMemo<StudioAccessFieldValue>(() => {
    const labelOf = (key: string) =>
      gateSource.body.permissions.find((item) => item.key === key)?.label ??
      gateSource.body.modules
        .flatMap((module) => module.permissions)
        .find((item) => item.key === key)?.label ??
      key;
    const summary = [
      gatePermission === "" ? undefined : `Needs ${labelOf(gatePermission)}`,
      gateUse === "" ? undefined : `Use needs ${labelOf(gateUse)}`,
      gateAudience === "" ? undefined : `Offered to ${gateAudience}`,
      ...studioReactionSlots
        .filter((entry) => target?.placement[entry.slot] !== undefined)
        .map((entry) => `${entry.title} ${words.get(entry.slot)}`),
    ].filter((part) => part !== undefined);
    return {
      summary: summary.length === 0 ? "Visible to everyone, always" : summary.join(" · "),
      gate:
        gate.kind === "available"
          ? {
              kind: "available",
              source: gateSource,
              permission: gate.permission ?? "",
              onChange: (next) => !disabled && handlers.current.onGate(next),
              problem: problems.gate,
              use: gateUse,
              useOffered,
              onUse: (next) => !disabled && handlers.current.onUse(next),
              useProblem: problems.use,
              audience: gateAudience,
              onAudience: (next) => !disabled && handlers.current.onAudience(next),
              audienceProblem: problems.audience,
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
    // The values that decide the field's content are the keys below.
  }, [
    gateSource,
    gatePermission,
    gateUse,
    useOffered,
    gateAudience,
    gateReason,
    hasTarget,
    slotsSet,
    wordsKey,
    disabled,
    problems.gate,
    problems.use,
    problems.audience,
  ]);
  const slotInfo = studioReactionSlots.find((entry) => entry.slot === slot)!;
  const dialog = (
    <StudioDialog
      open={editing}
      onOpenChange={setEditing}
      title={slotInfo.title}
      description={slotInfo.help}
      closeLabel="Done"
      focusDialog
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
