"use client";
import { Button } from "@vortex/ui/components/button";

import { useEffect, useRef, useState } from "react";
import { applicationModuleKeys, type ConditionNode } from "@vortex/platform/schema";
import {
  StudioConditionControls, parseStudioApplicationConditionContext,
  projectStudioVisibilityEditor, resolveStudioVisibilityTarget, sameStudioVisibilityValue, sameStudioVisibilityCondition,
  validateStudioVisibilityCondition,
  studioSemanticSelectionKey, type StudioApplicationConditionContext, type StudioCompositionContext,
  type StudioConditionValidation, type StudioSemanticSelection, type StudioStoredApplicationDraft,
  type StudioVisibilityCommandResult,
} from "@vortex/ui/studio";
import { resolveStudioApplicationConditionContext } from "../actions";

export type StudioVisibilityWorkspaceSnapshot = Readonly<{ context: StudioCompositionContext;
  selection: StudioSemanticSelection; saved: StudioStoredApplicationDraft }>;
type Props = Readonly<{
  context: StudioCompositionContext; selection: StudioSemanticSelection; saved: StudioStoredApplicationDraft;
  disabled: boolean; busy: boolean;
  readSnapshot: () => StudioVisibilityWorkspaceSnapshot | null;
  onCommand: (expected: StudioCompositionContext, selection: StudioSemanticSelection,
    metadata: StudioApplicationConditionContext, condition: ConditionNode | undefined,
    isCurrentResponse: () => boolean) => StudioVisibilityCommandResult;
}>;
type Response = Readonly<{ metadata: StudioApplicationConditionContext;
  snapshot: StudioVisibilityWorkspaceSnapshot; generation: number }>;
type Buffer = Readonly<{ value: ConditionNode | undefined; validation: StudioConditionValidation;
  response: Response }>;
const sameSnapshot = (left: StudioVisibilityWorkspaceSnapshot, right: StudioVisibilityWorkspaceSnapshot): boolean =>
  left.context.source === right.context.source && left.context.organizationId === right.context.organizationId &&
  left.context.rootId === right.context.rootId && left.context.key === right.context.key &&
  left.context.draftRevision === right.context.draftRevision && left.context.localLifetime === right.context.localLifetime &&
  studioSemanticSelectionKey(left.selection) === studioSemanticSelectionKey(right.selection) &&
  left.saved === right.saved;

/**
 * The selected item's visibility rule. A valid rule reaches the draft as it changes; a rule that is
 * not valid yet stays here with its problems and never reaches the draft.
 */
export function ApplicationVisibilityConditionEditor(props: Props) {
  const [response, setResponse] = useState<Response | null>(null);
  const [buffer, setBuffer] = useState<Buffer | null>(null);
  const [status, setStatus] = useState("Reading the fields this page can use…");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const latestProps = useRef(props);
  latestProps.current = props;
  const selectionKey = studioSemanticSelectionKey(props.selection);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    setResponse(null);
    if (props.busy) { setStatus("Waiting for the save to finish."); return; }
    const snapshot = props.readSnapshot();
    const target = snapshot === null ? undefined : resolveStudioVisibilityTarget(snapshot.context.source, snapshot.selection);
    const savedTarget = snapshot === null ? undefined : resolveStudioVisibilityTarget(snapshot.saved.source, snapshot.selection);
    if (snapshot === null || target === undefined || savedTarget === undefined ||
      target.pageAlias !== savedTarget.pageAlias || target.recordReference !== savedTarget.recordReference ||
      snapshot.saved.organizationId !== snapshot.context.organizationId || snapshot.saved.rootId !== snapshot.context.rootId ||
      snapshot.saved.key !== snapshot.context.key || snapshot.saved.draftRevision !== snapshot.context.draftRevision ||
      JSON.stringify(applicationModuleKeys(snapshot.context.source)) !== JSON.stringify(applicationModuleKeys(snapshot.saved.source))) {
      setStatus("A visibility rule needs a saved detail page with the same modules as the saved draft. Waiting for your latest change to save…");
      return;
    }
    setStatus("Reading the fields this page can use…");
    void resolveStudioApplicationConditionContext(snapshot.context.organizationId, {
      rootId: snapshot.context.rootId, draftRevision: snapshot.context.draftRevision, pageAlias: target.pageAlias,
    }).then((result) => {
      const current = latestProps.current.readSnapshot();
      if (requestGeneration !== generation.current || current === null || !sameSnapshot(snapshot, current)) return;
      const metadata = result.kind === "available" ? parseStudioApplicationConditionContext(result.context) : undefined;
      if (metadata === undefined) {
        setStatus(result.kind === "conflict" ? "The saved draft changed while the fields were read. Choose Reload fields."
          : result.kind === "refused" ? "The fields for this rule are not available with your access. What you typed is kept."
            : "The fields for this rule are temporarily unavailable. What you typed is kept.");
        return;
      }
      if (metadata.sourceFingerprint !== snapshot.saved.sourceFingerprint ||
        metadata.publishedRevision !== (snapshot.saved.publishedRevision ?? null) ||
        metadata.createdAt !== snapshot.saved.createdAt || metadata.updatedAt !== snapshot.saved.updatedAt ||
        projectStudioVisibilityEditor(snapshot.context, snapshot.selection, metadata).kind === "stale") {
        setStatus("The saved draft changed while the fields were read. Choose Reload fields.");
        return;
      }
      const nextResponse = { metadata, snapshot, generation: requestGeneration };
      setResponse(nextResponse);
      // A failed Save/Reopen retains the local draft. Rebind only to identical refreshed evidence.
      setBuffer((currentBuffer) => currentBuffer !== null &&
        sameSnapshot(currentBuffer.response.snapshot, snapshot) &&
        sameStudioVisibilityValue(currentBuffer.response.metadata, metadata)
        ? { ...currentBuffer, response: nextResponse } : currentBuffer);
      setStatus("");
    }).catch(() => {
      if (requestGeneration === generation.current)
        setStatus("The fields for this rule are temporarily unavailable. What you typed is kept.");
    });
    return () => { generation.current += 1; };
  }, [props.context, selectionKey, props.saved, props.busy, reload]);

  // Keep the controls mounted during an unsuccessful saved-draft operation. In particular, the
  // unchanged shared controls own uncommitted numeric text and located literal draft issues.
  const displayResponse = buffer?.response ?? response;
  const model = displayResponse === null ? null :
    projectStudioVisibilityEditor(displayResponse.snapshot.context, displayResponse.snapshot.selection, displayResponse.metadata);
  const activeResponse = buffer?.response ?? response;
  const isCurrentResponse = (): boolean => {
    const current = latestProps.current.readSnapshot();
    return activeResponse !== null && response === activeResponse && current !== null &&
      activeResponse.generation === generation.current && sameSnapshot(activeResponse.snapshot, current);
  };
  const update = (value: ConditionNode | undefined, validation: StudioConditionValidation) => {
    if (latestProps.current.disabled || response === null || model?.kind !== "available" || !isCurrentResponse()) return;
    const scalarValidation = validateStudioVisibilityCondition(value, response.metadata);
    validation = { ...validation, issues: [...validation.issues, ...scalarValidation.issues.filter((issue) =>
      !validation.issues.some((existing) => existing.code === issue.code && existing.pointer === issue.pointer))],
      isValid: validation.isValid && scalarValidation.isValid };
    const current = activeResponse ?? response;
    // A rule that is not valid yet stays here; a valid one goes to the draft at once.
    if (!validation.isValid) { setBuffer({ value, validation, response: current }); setMessage(""); return; }
    if (sameStudioVisibilityCondition(value, model.condition)) { setBuffer(null); return; }
    const result = props.onCommand(current.snapshot.context, current.snapshot.selection, current.metadata, value, isCurrentResponse);
    if (result.kind === "applied" || result.kind === "noop") {
      setBuffer(null);
      setMessage(result.kind === "applied" ? "Visibility rule changed." : "");
    } else {
      setBuffer({ value, validation, response: current });
      setMessage(result.kind === "invalid" ? result.issues.map((issue) => issue.message).join(" ")
        : "The draft or your selection changed while the rule was checked. Change it again.");
    }
  };
  const unsupported = model?.kind === "unsupported";
  const value = buffer === null ? model?.kind === "available" ? model.condition : undefined : buffer.value;
  return <section className="space-y-3 rounded-xl border bg-card text-card-foreground border-border p-4" aria-label="Visibility rule">
    <h3 className="font-semibold">Visibility rule</h3>
    <p className="text-sm">Show this item only when a field on this page has a chosen value. This only hides or shows the item; who may open the page is set separately.</p>
    {status && <p role="status">{status}</p>}
    {buffer !== null && !isCurrentResponse() &&
      <p role="status">Your rule is still shown. It goes to the draft once the page is up to date.</p>}
    <Button type="button" variant="outline" size="sm" disabled={props.busy}
      onClick={() => setReload((value) => value + 1)}>Reload fields</Button>
    {unsupported && <p role="status">This rule cannot be edited here. It is kept as it is.</p>}
    {model?.kind === "stale" && <p role="status">The saved page or its modules changed. Reload the fields before editing.</p>}
    {model?.kind === "available" && <fieldset disabled={props.disabled || !isCurrentResponse()} className="space-y-3">
      <StudioConditionControls {...(value === undefined ? {} : { value })} context={model.controls}
        label="Visibility rule" onChange={update} />
      <Button type="button" variant="outline" size="sm" disabled={value === undefined}
        onClick={() => update(undefined, { condition: undefined, issues: [], isValid: true })}>Remove rule</Button>
    </fieldset>}
    {buffer !== null && buffer.validation.issues.length > 0 && <ul role="alert" className="text-sm text-destructive">
      {buffer.validation.issues.map((issue, index) => <li key={`${issue.pointer}:${index}`}>
        Visibility rule: {issue.message}
      </li>)}
    </ul>}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
