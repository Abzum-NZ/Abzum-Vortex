"use client";
import { Button } from "@vortex/ui/components/button";

import { useEffect, useRef, useState } from "react";
import { applicationModuleKeys, type ConditionNode } from "@vortex/platform/schema";
import {
  StudioHelp,
  StudioInspectorGroup,
  StudioConditionControls,
  parseStudioApplicationConditionContext,
  projectStudioReactionEditor,
  resolveStudioReactionTarget,
  sameStudioReactionCondition,
  validateStudioReactionCondition,
  studioSemanticSelectionKey,
  studioReactionSlots,
  type StudioApplicationConditionContext,
  type StudioCompositionContext,
  type StudioConditionValidation,
  type StudioSemanticSelection,
  type StudioStoredApplicationDraft,
  type StudioReactionCommandResult,
  type StudioReactionSlot,
} from "@vortex/ui/studio";
import { resolveStudioApplicationConditionContext } from "../actions";

type Props = Readonly<{
  /** Which reaction of the item this edits: when it shows, is required, is read-only or is enabled. */
  slot: StudioReactionSlot;
  /** The current draft, which the rule is shown from and written to. */
  context: StudioCompositionContext;
  selection: StudioSemanticSelection;
  /** The saved draft, whose compiled fields the rule can name. */
  saved: StudioStoredApplicationDraft;
  disabled: boolean;
  onCommand: (
    expected: StudioCompositionContext,
    selection: StudioSemanticSelection,
    metadata: StudioApplicationConditionContext | null,
    condition: ConditionNode | undefined,
    slot: StudioReactionSlot,
  ) => StudioReactionCommandResult;
}>;
type FieldsRead = ReturnType<typeof resolveStudioApplicationConditionContext>;
const fieldReads = new Map<string, FieldsRead>();
/** The four reactions of an item read the same fields: one request serves them all. */
const readFieldsOnce = (key: string, read: () => FieldsRead): FieldsRead => {
  const known = fieldReads.get(key);
  if (known !== undefined) return known;
  const started = read();
  fieldReads.set(key, started);
  if (fieldReads.size > 20) fieldReads.delete(fieldReads.keys().next().value!);
  return started;
};
type Held = Readonly<{ value: ConditionNode | undefined; validation: StudioConditionValidation }>;

/**
 * One of the selected item's reactions (when it shows, is required, is read-only or is enabled):
 * one condition over the record's fields, the page's values and its forms' answers. The record's
 * fields it can name are read once for the saved page
 * (again when its modules change, or on Reload fields); a valid rule reaches the draft as it changes,
 * and a rule that is not valid yet stays here with its problems and never reaches the draft.
 */
export function ApplicationReactionConditionEditor(props: Props) {
  const [metadata, setMetadata] = useState<StudioApplicationConditionContext | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const [status, setStatus] = useState("Reading the fields this page can use…");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const slotInfo = studioReactionSlots.find((entry) => entry.slot === props.slot)!;
  const latest = useRef(props);
  latest.current = props;
  const selectionKey = studioSemanticSelectionKey(props.selection);
  // The fields can be read once the page and the same modules are in the saved draft.
  const target = resolveStudioReactionTarget(props.context.source, props.selection);
  const savedTarget = resolveStudioReactionTarget(props.saved.source, props.selection);
  const modules = JSON.stringify(applicationModuleKeys(props.context.source));
  // A page without a record offers page values and form answers only: nothing to read from the server.
  const needsFields = target !== undefined && target.top && target.recordReference !== "";
  const readable =
    target !== undefined &&
    (!needsFields ||
      (savedTarget !== undefined &&
        target.pageAlias === savedTarget.pageAlias &&
        target.recordReference === savedTarget.recordReference &&
        modules === JSON.stringify(applicationModuleKeys(props.saved.source))));

  useEffect(() => {
    if (!needsFields) return;
    if (!readable) {
      setStatus(
        "A condition on a record page needs the same modules as the saved draft. Waiting for your latest change to save…",
      );
      return;
    }
    let current = true;
    const { context, saved, selection } = latest.current;
    const page = resolveStudioReactionTarget(saved.source, selection);
    if (page === undefined) return;
    setStatus(metadata === null ? "Reading the fields this page can use…" : "");
    void readFieldsOnce(
      `${context.organizationId}:${context.rootId}:${saved.draftRevision}:${page.pageAlias}:${reload}`,
      () =>
        resolveStudioApplicationConditionContext(context.organizationId, {
          rootId: context.rootId,
          draftRevision: saved.draftRevision,
          pageAlias: page.pageAlias,
        }),
    )
      .then((result) => {
        if (!current) return;
        const parsed =
          result.kind === "available"
            ? parseStudioApplicationConditionContext(result.context)
            : undefined;
        if (parsed === undefined) {
          if (result.kind !== "conflict")
            console.error(
              `[studio] the fields for a visibility rule were not read: STUDIO_VISIBILITY_FIELDS_${result.kind.toUpperCase()}`,
            );
          setStatus(
            result.kind === "conflict"
              ? "The saved draft changed while the fields were read. Choose Reload fields."
              : result.kind === "refused"
                ? "The fields for this rule are not available with your access."
                : "The fields for this rule are temporarily unavailable. Choose Reload fields.",
          );
          return;
        }
        setMetadata(parsed);
        setStatus("");
      })
      .catch((error: unknown) => {
        console.error("[studio] reading the fields for a visibility rule failed", error);
        if (current)
          setStatus("The fields for this rule are temporarily unavailable. Choose Reload fields.");
      });
    return () => {
      current = false;
    };
  }, [selectionKey, readable, modules, reload]);

  const model =
    target === undefined || (needsFields && metadata === null)
      ? null
      : projectStudioReactionEditor(props.context, props.selection, metadata, props.slot);
  // The draft changing under held input (Undo, Redo, another edit of this item) drops it.
  const shown = model?.kind === "available" ? JSON.stringify(model.condition ?? null) : "";
  useEffect(() => {
    setHeld(null);
  }, [shown, selectionKey]);

  const update = (value: ConditionNode | undefined, validation: StudioConditionValidation) => {
    if (latest.current.disabled || model?.kind !== "available") return;
    const scalarValidation = validateStudioReactionCondition(value, model.metadata, model.extra);
    const combined = {
      ...validation,
      issues: [
        ...validation.issues,
        ...scalarValidation.issues.filter(
          (issue) =>
            !validation.issues.some(
              (existing) => existing.code === issue.code && existing.pointer === issue.pointer,
            ),
        ),
      ],
      isValid: validation.isValid && scalarValidation.isValid,
    };
    // A rule that is not valid yet stays here; a valid one goes to the draft at once.
    if (!combined.isValid) {
      setHeld({ value, validation: combined });
      setMessage("");
      return;
    }
    if (sameStudioReactionCondition(value, model.condition)) {
      setHeld(null);
      return;
    }
    const result = props.onCommand(
      latest.current.context,
      latest.current.selection,
      metadata,
      value,
      props.slot,
    );
    if (result.kind === "applied" || result.kind === "noop") {
      setHeld(null);
      setMessage(result.kind === "applied" ? `${slotInfo.title} changed.` : "");
    } else {
      setHeld({ value, validation: combined });
      setMessage(
        result.kind === "invalid"
          ? result.issues.map((issue) => issue.message).join(" ")
          : result.kind === "stale"
            ? "The draft or its fields changed while the rule was checked. Choose Reload fields, then change it again."
            : "This rule cannot be changed here.",
      );
    }
  };
  const value =
    held === null ? (model?.kind === "available" ? model.condition : undefined) : held.value;
  return (
    <StudioInspectorGroup title={slotInfo.title}>
      <StudioHelp hint={slotInfo.help} />
      {needsFields && status && (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      )}
      {model?.kind === "unsupported" && (
        <p role="status">
          This condition uses values this page cannot offer. Change it with Import from source in
          the Releases tab.
        </p>
      )}
      {model?.kind === "stale" && (
        <p role="status">The page or its modules changed. Reload the fields before editing.</p>
      )}
      {model?.kind === "available" && (
        <fieldset disabled={props.disabled} className="space-y-3">
          <StudioConditionControls
            {...(value === undefined ? {} : { value })}
            context={model.controls}
            label={slotInfo.title}
            onChange={update}
          />
        </fieldset>
      )}
      {needsFields && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          disabled={props.disabled}
          onClick={() => setReload((count) => count + 1)}
        >
          Reload fields
        </Button>
      )}
      {held !== null && held.validation.issues.length > 0 && (
        <ul role="alert" className="text-sm text-destructive">
          {held.validation.issues.map((issue, index) => (
            <li key={`${issue.pointer}:${index}`}>
              {slotInfo.title}: {issue.message}
            </li>
          ))}
        </ul>
      )}
      <p role="status" aria-live="polite">
        {message}
      </p>
    </StudioInspectorGroup>
  );
}
