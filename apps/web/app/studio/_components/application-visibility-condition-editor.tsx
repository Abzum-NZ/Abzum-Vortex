"use client";
import { Button } from "@vortex/ui/components/button";

import { useEffect, useRef, useState } from "react";
import { applicationModuleKeys, type ConditionNode } from "@vortex/platform/schema";
import {
  StudioConditionControls, parseStudioApplicationConditionContext,
  projectStudioVisibilityEditor, resolveStudioVisibilityTarget, sameStudioVisibilityCondition,
  validateStudioVisibilityCondition,
  studioSemanticSelectionKey, type StudioApplicationConditionContext, type StudioCompositionContext,
  type StudioConditionValidation, type StudioSemanticSelection, type StudioStoredApplicationDraft,
  type StudioVisibilityCommandResult,
} from "@vortex/ui/studio";
import { resolveStudioApplicationConditionContext } from "../actions";

type Props = Readonly<{
  /** The current draft, which the rule is shown from and written to. */
  context: StudioCompositionContext; selection: StudioSemanticSelection;
  /** The saved draft, whose compiled fields the rule can name. */
  saved: StudioStoredApplicationDraft;
  disabled: boolean;
  onCommand: (expected: StudioCompositionContext, selection: StudioSemanticSelection,
    metadata: StudioApplicationConditionContext, condition: ConditionNode | undefined) => StudioVisibilityCommandResult;
}>;
type Held = Readonly<{ value: ConditionNode | undefined; validation: StudioConditionValidation }>;

/**
 * The selected item's visibility rule. The fields it can name are read once for the saved page
 * (again when its modules change, or on Reload fields); a valid rule reaches the draft as it changes,
 * and a rule that is not valid yet stays here with its problems and never reaches the draft.
 */
export function ApplicationVisibilityConditionEditor(props: Props) {
  const [metadata, setMetadata] = useState<StudioApplicationConditionContext | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const [status, setStatus] = useState("Reading the fields this page can use…");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const latest = useRef(props);
  latest.current = props;
  const selectionKey = studioSemanticSelectionKey(props.selection);
  // The fields can be read once the page and the same modules are in the saved draft.
  const target = resolveStudioVisibilityTarget(props.context.source, props.selection);
  const savedTarget = resolveStudioVisibilityTarget(props.saved.source, props.selection);
  const modules = JSON.stringify(applicationModuleKeys(props.context.source));
  const readable = target !== undefined && savedTarget !== undefined && target.pageAlias === savedTarget.pageAlias &&
    target.recordReference === savedTarget.recordReference && modules === JSON.stringify(applicationModuleKeys(props.saved.source));

  useEffect(() => {
    if (!readable) { setStatus("A visibility rule needs a saved detail page with the same modules as the saved draft. Waiting for your latest change to save…"); return; }
    let current = true;
    const { context, saved, selection } = latest.current;
    const page = resolveStudioVisibilityTarget(saved.source, selection);
    if (page === undefined) return;
    setStatus(metadata === null ? "Reading the fields this page can use…" : "");
    void resolveStudioApplicationConditionContext(context.organizationId, {
      rootId: context.rootId, draftRevision: saved.draftRevision, pageAlias: page.pageAlias,
    }).then((result) => {
      if (!current) return;
      const parsed = result.kind === "available" ? parseStudioApplicationConditionContext(result.context) : undefined;
      if (parsed === undefined) {
        if (result.kind !== "conflict") console.error(`[studio] the fields for a visibility rule were not read: STUDIO_VISIBILITY_FIELDS_${result.kind.toUpperCase()}`);
        setStatus(result.kind === "conflict" ? "The saved draft changed while the fields were read. Choose Reload fields."
          : result.kind === "refused" ? "The fields for this rule are not available with your access."
            : "The fields for this rule are temporarily unavailable. Choose Reload fields.");
        return;
      }
      setMetadata(parsed);
      setStatus("");
    }).catch((error: unknown) => {
      console.error("[studio] reading the fields for a visibility rule failed", error);
      if (current) setStatus("The fields for this rule are temporarily unavailable. Choose Reload fields.");
    });
    return () => { current = false; };
  }, [selectionKey, readable, modules, reload]);

  const model = metadata === null ? null : projectStudioVisibilityEditor(props.context, props.selection, metadata);
  // The draft changing under held input (Undo, Redo, another edit of this item) drops it.
  const shown = model?.kind === "available" ? JSON.stringify(model.condition ?? null) : "";
  useEffect(() => { setHeld(null); }, [shown, selectionKey]);

  const update = (value: ConditionNode | undefined, validation: StudioConditionValidation) => {
    if (latest.current.disabled || metadata === null || model?.kind !== "available") return;
    const scalarValidation = validateStudioVisibilityCondition(value, metadata);
    const combined = { ...validation, issues: [...validation.issues, ...scalarValidation.issues.filter((issue) =>
      !validation.issues.some((existing) => existing.code === issue.code && existing.pointer === issue.pointer))],
    isValid: validation.isValid && scalarValidation.isValid };
    // A rule that is not valid yet stays here; a valid one goes to the draft at once.
    if (!combined.isValid) { setHeld({ value, validation: combined }); setMessage(""); return; }
    if (sameStudioVisibilityCondition(value, model.condition)) { setHeld(null); return; }
    const result = props.onCommand(latest.current.context, latest.current.selection, metadata, value);
    if (result.kind === "applied" || result.kind === "noop") {
      setHeld(null);
      setMessage(result.kind === "applied" ? "Visibility rule changed." : "");
    } else {
      setHeld({ value, validation: combined });
      setMessage(result.kind === "invalid" ? result.issues.map((issue) => issue.message).join(" ")
        : result.kind === "stale" ? "The draft or its fields changed while the rule was checked. Choose Reload fields, then change it again."
          : "This rule cannot be changed here.");
    }
  };
  const value = held === null ? model?.kind === "available" ? model.condition : undefined : held.value;
  return <section className="space-y-3 rounded-xl border bg-card text-card-foreground border-border p-4" aria-label="Visibility rule">
    <h3 className="font-semibold">Visibility rule</h3>
    <p className="text-sm">Show this item only when a field on this page has a chosen value. This only hides or shows the item; who may open the page is set separately.</p>
    {status && <p role="status">{status}</p>}
    <Button type="button" variant="outline" size="sm" disabled={props.disabled}
      onClick={() => setReload((count) => count + 1)}>Reload fields</Button>
    {model?.kind === "unsupported" && <p role="status">This rule cannot be edited here. It is kept as it is.</p>}
    {model?.kind === "stale" && <p role="status">The page or its modules changed. Reload the fields before editing.</p>}
    {model?.kind === "available" && <fieldset disabled={props.disabled} className="space-y-3">
      <StudioConditionControls {...(value === undefined ? {} : { value })} context={model.controls}
        label="Visibility rule" onChange={update} />
      <Button type="button" variant="outline" size="sm" disabled={value === undefined}
        onClick={() => update(undefined, { condition: undefined, issues: [], isValid: true })}>Remove rule</Button>
    </fieldset>}
    {held !== null && held.validation.issues.length > 0 && <ul role="alert" className="text-sm text-destructive">
      {held.validation.issues.map((issue, index) => <li key={`${issue.pointer}:${index}`}>
        Visibility rule: {issue.message}
      </li>)}
    </ul>}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
