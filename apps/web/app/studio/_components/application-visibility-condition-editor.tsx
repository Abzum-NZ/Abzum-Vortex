"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ConditionNode } from "@vortex/contracts";
import {
  StudioConditionControls, locateStudioVisibilityDraftIssue, parseStudioApplicationConditionContext,
  projectStudioVisibilityEditor, resolveStudioVisibilityTarget, sameStudioVisibilityValue, sameStudioVisibilityCondition,
  validateStudioVisibilityCondition,
  studioSemanticSelectionKey, type StudioApplicationConditionContext, type StudioCompositionContext,
  type StudioConditionValidation, type StudioSemanticSelection, type StudioStoredApplicationDraft,
  type StudioVisibilityCommandResult,
} from "@vortex/studio";
import { resolveStudioApplicationConditionContext } from "../actions";

export type StudioVisibilityWorkspaceSnapshot = Readonly<{ context: StudioCompositionContext;
  selection: StudioSemanticSelection; saved: StudioStoredApplicationDraft }>;
type Props = Readonly<{
  context: StudioCompositionContext; selection: StudioSemanticSelection; saved: StudioStoredApplicationDraft;
  disabled: boolean; busy: boolean;
  readSnapshot: () => StudioVisibilityWorkspaceSnapshot | null;
  onPendingChange: (pending: boolean) => void;
  onCommand: (expected: StudioCompositionContext, selection: StudioSemanticSelection,
    metadata: StudioApplicationConditionContext, condition: ConditionNode | undefined,
    isCurrentResponse: () => boolean) => StudioVisibilityCommandResult;
}>;
type Response = Readonly<{ metadata: StudioApplicationConditionContext;
  snapshot: StudioVisibilityWorkspaceSnapshot; generation: number }>;
type Buffer = Readonly<{ value: ConditionNode | undefined; validation: StudioConditionValidation;
  response: Response }>;
const buttonClass = "rounded border border-border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50";
const sameSnapshot = (left: StudioVisibilityWorkspaceSnapshot, right: StudioVisibilityWorkspaceSnapshot): boolean =>
  left.context.source === right.context.source && left.context.organizationId === right.context.organizationId &&
  left.context.rootId === right.context.rootId && left.context.key === right.context.key &&
  left.context.draftRevision === right.context.draftRevision && left.context.localLifetime === right.context.localLifetime &&
  studioSemanticSelectionKey(left.selection) === studioSemanticSelectionKey(right.selection) &&
  left.saved === right.saved;

/** A local buffer mounted in the real selected-placement workspace; Save is the sole writer. */
export function ApplicationVisibilityConditionEditor(props: Props) {
  const [response, setResponse] = useState<Response | null>(null);
  const [buffer, setBuffer] = useState<Buffer | null>(null);
  const [status, setStatus] = useState("Reading saved field metadata…");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const [controlsEpoch, setControlsEpoch] = useState(0);
  const generation = useRef(0);
  const latestProps = useRef(props);
  latestProps.current = props;
  const selectionKey = studioSemanticSelectionKey(props.selection);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    setResponse(null);
    if (props.busy) { setStatus("Waiting for the saved draft operation."); return; }
    const snapshot = props.readSnapshot();
    const target = snapshot === null ? undefined : resolveStudioVisibilityTarget(snapshot.context.source, snapshot.selection);
    const savedTarget = snapshot === null ? undefined : resolveStudioVisibilityTarget(snapshot.saved.source, snapshot.selection);
    if (snapshot === null || target === undefined || savedTarget === undefined ||
      target.pageAlias !== savedTarget.pageAlias || target.recordReference !== savedTarget.recordReference ||
      snapshot.saved.organizationId !== snapshot.context.organizationId || snapshot.saved.rootId !== snapshot.context.rootId ||
      snapshot.saved.key !== snapshot.context.key || snapshot.saved.draftRevision !== snapshot.context.draftRevision ||
      JSON.stringify(snapshot.context.source.body.module_bindings) !== JSON.stringify(snapshot.saved.source.body.module_bindings)) {
      setStatus("This placement needs an existing saved detail page and unchanged saved Module bindings. Its source is preserved.");
      return;
    }
    setStatus("Reading saved field metadata…");
    void resolveStudioApplicationConditionContext(snapshot.context.organizationId, {
      rootId: snapshot.context.rootId, draftRevision: snapshot.context.draftRevision, pageAlias: target.pageAlias,
    }).then((result) => {
      const current = latestProps.current.readSnapshot();
      if (requestGeneration !== generation.current || current === null || !sameSnapshot(snapshot, current)) return;
      const metadata = result.kind === "available" ? parseStudioApplicationConditionContext(result.context) : undefined;
      if (metadata === undefined) {
        setStatus(result.kind === "conflict" ? "The saved draft changed. Reopen explicitly; your inputs are preserved."
          : result.kind === "refused" ? "Saved field metadata is unavailable with current permissions. Your inputs are preserved."
            : "Saved field metadata is temporarily unavailable. Your inputs are preserved.");
        return;
      }
      if (metadata.sourceFingerprint !== snapshot.saved.sourceFingerprint ||
        metadata.publishedRevision !== (snapshot.saved.publishedRevision ?? null) ||
        metadata.createdAt !== snapshot.saved.createdAt || metadata.updatedAt !== snapshot.saved.updatedAt ||
        projectStudioVisibilityEditor(snapshot.context, snapshot.selection, metadata).kind === "stale") {
        setStatus("The saved context changed. Reopen explicitly; your inputs are preserved.");
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
        setStatus("Saved field metadata is temporarily unavailable. Your inputs are preserved.");
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
    const meaningful = !validation.isValid || !sameStudioVisibilityCondition(value, model.condition);
    props.onPendingChange(meaningful);
    setBuffer(meaningful ? { value, validation, response: activeResponse ?? response } : null);
    setMessage("");
  };
  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (latestProps.current.disabled || buffer === null || !isCurrentResponse()) {
      setMessage("The draft, selection or field context changed. Your inputs are preserved.");
      return;
    }
    if (!buffer.validation.isValid) { setMessage("Resolve the located condition issues before applying."); return; }
    const result = props.onCommand(buffer.response.snapshot.context, buffer.response.snapshot.selection,
      buffer.response.metadata, buffer.value, isCurrentResponse);
    if (result.kind === "applied" || result.kind === "noop") {
      props.onPendingChange(false);
      setBuffer(null);
      setControlsEpoch((value) => value + 1);
      setMessage(result.kind === "applied" ? "Visibility condition applied to one local history entry. Save to persist it."
        : "The visibility condition is unchanged.");
    } else if (result.kind === "invalid") {
      setMessage(result.issues.map((issue) => `${issue.path.join("/")}: ${issue.message}`).join(" "));
    } else setMessage("The condition could not be applied. Your inputs and source are preserved.");
  };
  const discard = () => {
    if (latestProps.current.busy) return;
    props.onPendingChange(false);
    setBuffer(null);
    setControlsEpoch((value) => value + 1);
    setMessage("Unapplied visibility edits discarded.");
  };
  const unsupported = model?.kind === "unsupported";
  const value = buffer === null ? model?.kind === "available" ? model.condition : undefined : buffer.value;
  const target = model?.kind === "available" ? model.target : resolveStudioVisibilityTarget(props.context.source, props.selection);
  return <section className="space-y-3 rounded border border-border p-4" aria-label="Placement visibility condition">
    <h3 className="font-semibold">Visibility condition</h3>
    <p className="text-sm">Use fields from this detail page's saved Module release. Visibility controls presentation; permissions remain separate.</p>
    {status && <p role="status">{status}</p>}
    {buffer !== null && !isCurrentResponse() &&
      <p role="status">Your unapplied condition remains visible. Apply is held until its saved context is current.</p>}
    <button type="button" className={buttonClass} disabled={props.busy}
      onClick={() => setReload((value) => value + 1)}>Reload field metadata</button>
    {unsupported && <p role="status">This existing condition or placement is unsupported. Its source is preserved and read-only.</p>}
    {model?.kind === "stale" && <p role="status">The saved page or Module bindings changed. Save and reload field metadata before editing.</p>}
    {model?.kind === "available" && <form onSubmit={apply} className="space-y-3">
      <fieldset disabled={props.disabled || !isCurrentResponse()} className="space-y-3" onInputCapture={() => {
        if (latestProps.current.disabled || response === null || !isCurrentResponse()) return;
        // Numeric inputs in the shared controls commit on blur. Hold all reciprocal commands
        // synchronously from the first input event; the shared onChange resolves this draft.
        props.onPendingChange(true);
        setBuffer((current) => ({ value: current === null ? model.condition : current.value, response: current?.response ?? response,
          validation: { condition: current === null ? model.condition : current.value,
            issues: current?.validation.issues ?? [], isValid: false } }));
      }}>
        <StudioConditionControls key={controlsEpoch} value={value} context={model.controls}
          label="Placement visibility controls" onChange={update} />
        <button type="button" className={buttonClass} disabled={value === undefined}
          onClick={() => update(undefined, { condition: undefined, issues: [], isValid: true })}>Remove condition</button>
        <button type="submit" className={buttonClass} disabled={buffer === null || !buffer.validation.isValid}>Apply visibility condition</button>
      </fieldset>
    </form>}
    {buffer !== null && <>
      {buffer.validation.issues.length > 0 && <ul role="status" aria-live="polite">
        {buffer.validation.issues.map((issue, index) => <li key={`${issue.pointer}:${index}`}>
          {[...(target?.path ?? []), "visibility_condition",
            ...locateStudioVisibilityDraftIssue(issue.path, buffer.value,
              target?.placement.visibility_condition, buffer.response.metadata)].join("/")}: {issue.message}
        </li>)}
      </ul>}
      <button type="button" className={buttonClass} disabled={props.busy} onClick={discard}>Discard visibility edits</button>
    </>}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
