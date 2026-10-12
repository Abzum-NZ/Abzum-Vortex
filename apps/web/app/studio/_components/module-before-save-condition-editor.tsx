"use client";
import { Button } from "@vortex/ui/components/button";
import { NativeSelect } from "@vortex/ui/components/native-select";

import { useEffect, useRef, useState } from "react";
import { canonicalJson, type ConditionNode, type DefinitionValidationResult } from "@vortex/contracts";
import { StudioConditionControls, validateStudioCondition, type StudioConditionValidation } from "@vortex/studio";
import type { ModuleBeforeSaveConditionDraftContext, ModuleBeforeSaveConditionFlowChoice } from "@vortex/definition";
import type { StudioModuleBeforeSaveConditionResult, StudioModuleBeforeSaveConditionSnapshot } from "../../_lib/studio-module-before-save-condition";
import { moduleBeforeSaveConditionControlsContext, sameModuleBeforeSaveCondition } from "../_lib/module-before-save-condition-commands";
import { loadModuleBeforeSaveCondition, saveModuleBeforeSaveCondition, validateModuleBeforeSaveCondition } from "../modules/[organizationId]/[moduleRootId]/before-save/actions";

type Buffer = ConditionNode | null;
type Props = Readonly<{ organizationId: string; moduleRootId: string; initial: StudioModuleBeforeSaveConditionResult }>;
const selectionKey = (alias: string, taskId: string): string => JSON.stringify([alias, taskId]);
const contextKey = (context: ModuleBeforeSaveConditionDraftContext): string => selectionKey(context.flow.alias, context.task.id);
const choicesFor = (result: StudioModuleBeforeSaveConditionResult): readonly ModuleBeforeSaveConditionFlowChoice[] =>
  result.kind === "available" || result.kind === "readonly" ? result.flowChoices : [];
const contextFor = (result: StudioModuleBeforeSaveConditionResult) => result.kind === "available" ? result.selected : undefined;
const sameSelection = (left: ModuleBeforeSaveConditionDraftContext | undefined, right: ModuleBeforeSaveConditionDraftContext): boolean =>
  left !== undefined && canonicalJson(left) === canonicalJson(right);
const sameIdentity = (left: ModuleBeforeSaveConditionDraftContext, right: ModuleBeforeSaveConditionDraftContext): boolean =>
  canonicalJson({ org: left.organizationId, root: left.rootId, key: left.definitionKey, resolution: left.resolutionFingerprint,
    flow: left.flow, trigger: left.trigger, task: left.task, fields: left.fields }) ===
  canonicalJson({ org: right.organizationId, root: right.rootId, key: right.definitionKey, resolution: right.resolutionFingerprint,
    flow: right.flow, trigger: right.trigger, task: right.task, fields: right.fields });
const buttonClass = "";

/** Existing top-level predicates only. Apply and history are local; Save is an explicit Human operation. */
export function ModuleBeforeSaveConditionEditor({ organizationId, moduleRootId, initial }: Props) {
  const [choices, setChoices] = useState(choicesFor(initial));
  const [context, setContext] = useState(contextFor(initial));
  const [selected, setSelected] = useState(contextFor(initial) === undefined ? "" : contextKey(contextFor(initial)!));
  const [snapshot, setSnapshot] = useState<StudioModuleBeforeSaveConditionSnapshot | undefined>(initial.kind === "available" ? initial.snapshot : undefined);
  const [baseline, setBaseline] = useState<Buffer>(contextFor(initial)?.condition ?? null);
  const [applied, setApplied] = useState<Buffer>(contextFor(initial)?.condition ?? null);
  const [working, setWorking] = useState<Buffer>(contextFor(initial)?.condition ?? null);
  const [undoStack, setUndoStack] = useState<readonly Buffer[]>([]);
  const [redoStack, setRedoStack] = useState<readonly Buffer[]>([]);
  const [controlValidation, setControlValidation] = useState<StudioConditionValidation | null>(null);
  const [remoteValidation, setRemoteValidation] = useState<DefinitionValidationResult | null>(initial.kind === "validation_failed" ? initial.validation : null);
  const [busy, setBusy] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const [message, setMessage] = useState(initial.kind === "available"
    ? "Choose an existing BeforeSave If predicate from the saved Module draft."
    : "The BeforeSave editor is unavailable. Reopen after checking the saved draft and current access.");
  const active = useRef(false);
  const selectionEpoch = useRef(0);
  const requestEpoch = useRef(0);
  const bufferEpoch = useRef(0);
  const contextRef = useRef(context);
  const selectedRef = useRef(selected);
  const appliedRef = useRef(applied);
  contextRef.current = context; selectedRef.current = selected; appliedRef.current = applied;
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; selectionEpoch.current += 1; requestEpoch.current += 1; bufferEpoch.current += 1; };
  }, []);
  const controls = context === undefined ? undefined : moduleBeforeSaveConditionControlsContext(context);
  const localValidation = controlValidation ?? (controls === undefined ? null : validateStudioCondition(working ?? undefined, controls));
  const valid = working !== null && localValidation?.isValid === true;
  const staged = !sameModuleBeforeSaveCondition(working, applied);
  const dirty = !sameModuleBeforeSaveCondition(applied, baseline);
  const canEdit = context !== undefined && !invalidated;
  const currentResponse = (selection: number, request: number) => active.current &&
    selection === selectionEpoch.current && request === requestEpoch.current;
  const resetBuffer = (next: ModuleBeforeSaveConditionDraftContext) => {
    setBaseline(next.condition); setApplied(next.condition); setWorking(next.condition); appliedRef.current = next.condition;
    setUndoStack([]); setRedoStack([]); setControlValidation(null); setRemoteValidation(null); bufferEpoch.current += 1;
  };
  const load = async (nextSelection: string, reopening: boolean) => {
    if (busy) return;
    if ((dirty || staged) && !window.confirm("Discard pending condition edits and load the saved draft? Choose Cancel to keep editing.")) return;
    const selectedEpoch = ++selectionEpoch.current;
    const requestId = ++requestEpoch.current;
    const choice = choices.find((entry) => selectionKey(entry.alias, entry.taskId) === nextSelection);
    if (nextSelection !== "" && choice === undefined) { setInvalidated(true); setMessage("The selected predicate is no longer available. Reopen the current draft."); return; }
    setBusy(true); setSelected(nextSelection); selectedRef.current = nextSelection;
    setRemoteValidation(null); setMessage(reopening ? "Reopening the saved Module draft..." : "Loading the current predicate...");
    try {
      const result = await loadModuleBeforeSaveCondition(organizationId, moduleRootId, choice?.alias, choice?.taskId);
      if (!currentResponse(selectedEpoch, requestId) || selectedRef.current !== nextSelection) return;
      setChoices(choicesFor(result));
      if (result.kind === "available") {
        if (result.snapshot.organizationId !== organizationId || result.snapshot.rootId !== moduleRootId ||
            (result.selected !== undefined && (result.selected.organizationId !== organizationId ||
              result.selected.rootId !== moduleRootId || result.selected.definitionKey !== result.snapshot.key ||
              result.selected.draftRevision !== result.snapshot.draftRevision ||
              result.selected.savedSourceFingerprint !== result.snapshot.sourceFingerprint))) {
          setInvalidated(true); setContext(undefined); setMessage("The loaded draft identity could not be verified. Your local condition is preserved."); return;
        }
        if (nextSelection !== "" && (result.selected === undefined || contextKey(result.selected) !== nextSelection)) {
          setContext(undefined); setInvalidated(true); setMessage("This retained predicate is read-only. Your pending condition is preserved."); return;
        }
        setSnapshot(result.snapshot); setContext(result.selected); setInvalidated(false);
        if (result.selected !== undefined) { resetBuffer(result.selected); setMessage(`Loaded saved Module draft revision ${result.snapshot.draftRevision}.`); }
        else { setBaseline(null); setApplied(null); setWorking(null); appliedRef.current = null; setUndoStack([]); setRedoStack([]); setControlValidation(null); bufferEpoch.current += 1; setMessage("Choose an existing BeforeSave If predicate."); }
        return;
      }
      setContext(undefined); setInvalidated(true);
      if (result.kind === "validation_failed") setRemoteValidation(result.validation);
      setMessage(result.kind === "readonly" ? "The retained predicate is outside this editor's supported scope. It was preserved."
        : result.kind === "conflict" ? "The saved draft changed. Reopen explicitly; your local condition is preserved."
          : result.kind === "validation_failed" ? "The complete saved Module needs correction before editing."
            : "The saved predicate could not be verified. Your local condition is preserved.");
    } catch {
      if (currentResponse(selectedEpoch, requestId)) { setInvalidated(true); setMessage("The saved predicate could not be loaded. Your local condition is preserved."); }
    } finally { if (currentResponse(selectedEpoch, requestId)) setBusy(false); }
  };
  const update = (next: ConditionNode | undefined, validation: StudioConditionValidation) => {
    if (!canEdit || busy) return;
    setWorking(next ?? null); setControlValidation(validation); setRemoteValidation(null); bufferEpoch.current += 1;
    setMessage(next === undefined ? "This If condition is required. Repair it or Undo; absence cannot be applied or saved." : "Condition edits are local until Apply and explicit Save.");
  };
  const apply = () => {
    if (!canEdit || busy || !valid || !staged) return;
    setUndoStack((previous) => [...previous, applied]); setRedoStack([]); setApplied(working); appliedRef.current = working;
    setRemoteValidation(null); bufferEpoch.current += 1; setMessage("Applied locally. Save explicitly to update the Module draft.");
  };
  const undo = () => {
    if (!canEdit || busy) return;
    if (staged) { setWorking(applied); setControlValidation(null); setRemoteValidation(null); bufferEpoch.current += 1; return; }
    const previous = undoStack.at(-1);
    if (previous === undefined) return;
    setUndoStack((values) => values.slice(0, -1)); setRedoStack((values) => [...values, applied]);
    setApplied(previous); appliedRef.current = previous; setWorking(previous); setControlValidation(null); setRemoteValidation(null); bufferEpoch.current += 1;
  };
  const redo = () => {
    if (!canEdit || busy || staged) return;
    const next = redoStack.at(-1);
    if (next === undefined) return;
    setRedoStack((values) => values.slice(0, -1)); setUndoStack((values) => [...values, applied]);
    setApplied(next); appliedRef.current = next; setWorking(next); setControlValidation(null); setRemoteValidation(null); bufferEpoch.current += 1;
  };
  const submit = async (saving: boolean) => {
    const captured = contextRef.current;
    const submitted = appliedRef.current;
    if (!canEdit || captured === undefined || submitted === null || busy || staged || !valid || (saving && !dirty)) return;
    const selectedEpoch = selectionEpoch.current;
    const requestId = ++requestEpoch.current;
    const buffer = bufferEpoch.current;
    const selectedKey = selectedRef.current;
    const request = { rootId: captured.rootId, flowAlias: captured.flow.alias, taskId: captured.task.id,
      expectedDraftRevision: captured.draftRevision, expectedSavedSourceFingerprint: captured.savedSourceFingerprint,
      expectedResolutionFingerprint: captured.resolutionFingerprint, expectedOperandBindingFingerprint: captured.operandBindingFingerprint,
      condition: submitted };
    setBusy(true); setRemoteValidation(null); setMessage(saving ? "Saving with the current draft revision and Human permission..." : "Validating the current Module and dependencies...");
    try {
      const result = saving ? await saveModuleBeforeSaveCondition(organizationId, request) : await validateModuleBeforeSaveCondition(organizationId, request);
      if (!currentResponse(selectedEpoch, requestId) || selectedRef.current !== selectedKey || !sameSelection(contextRef.current, captured) || bufferEpoch.current !== buffer) return;
      if (result.kind === "valid") { setMessage("Current Module validation passed. Save explicitly to write the condition."); return; }
      if (result.kind === "saved" || result.kind === "unchanged") {
        if (result.snapshot.organizationId !== organizationId || result.snapshot.rootId !== moduleRootId ||
            !sameIdentity(captured, result.selected) || result.selected.draftRevision !== result.snapshot.draftRevision ||
            result.selected.savedSourceFingerprint !== result.snapshot.sourceFingerprint ||
            !sameModuleBeforeSaveCondition(result.selected.condition, submitted) ||
            result.snapshot.draftRevision !== captured.draftRevision + (result.kind === "saved" ? 1 : 0)) {
          setInvalidated(true); setMessage("The save receipt did not match this predicate. Your local condition is preserved."); return;
        }
        setSnapshot(result.snapshot); setContext(result.selected); resetBuffer(result.selected); setInvalidated(false);
        setMessage(`Saved predicate at Module draft revision ${result.snapshot.draftRevision}.`); return;
      }
      if (result.kind === "validation_failed") setRemoteValidation(result.validation);
      else setInvalidated(true);
      setMessage(result.kind === "validation_failed" ? "The condition needs correction. Your local input is preserved."
        : "The current draft or access could not be verified. Reopen explicitly; your local condition is preserved.");
    } catch {
      if (currentResponse(selectedEpoch, requestId) && bufferEpoch.current === buffer) { setInvalidated(true); setMessage("The operation could not be verified. Your local condition is preserved."); }
    } finally { if (currentResponse(selectedEpoch, requestId)) setBusy(false); }
  };
  const validationErrors = remoteValidation === null ? null : <div role="alert" aria-live="polite">
    <h2 className="font-medium">Current Module validation</h2>
    <ul className="list-disc pl-6">{remoteValidation.errors.map((error, index) => <li key={`${error.code}:${index}`}>
      {error.location === undefined ? `Module ${snapshot?.key ?? "draft"}`
        : [error.location.documentKey, ...error.location.segments.map((segment) =>
          `${segment.kind.replaceAll("_", " ")} ${segment.key}`)].join(" / ")}: {error.message} {error.guidance}
    </li>)}</ul>
  </div>;
  return <main className="mx-auto max-w-4xl space-y-6 p-6" aria-busy={busy}>
    <header className="space-y-2"><h1 className="text-2xl font-semibold">BeforeSave If conditions</h1>
      <p>Edit the current-field condition of an existing If task. Its branches and actions stay fixed. Save updates the draft.</p>
      {snapshot !== undefined && <p>Module {snapshot.key}, draft revision {snapshot.draftRevision}, published revision {snapshot.publishedRevision ?? "None"}.</p>}
    </header>
    <label className="block space-y-1"><span>Existing BeforeSave If task</span>
      <NativeSelect value={selected} disabled={busy}
        onChange={(event) => void load(event.target.value, false)}>
        <option value="">Choose an If task</option>
        {choices.map((choice) => <option key={selectionKey(choice.alias, choice.taskId)} value={selectionKey(choice.alias, choice.taskId)}>
          {choice.key} / {choice.taskId} ({choice.eligible ? "editable" : "read-only"})
        </option>)}
      </NativeSelect>
    </label>
    {canEdit && controls !== undefined && <section className="space-y-4" aria-label="BeforeSave condition editor">
      <fieldset disabled={busy}><legend className="sr-only">Condition controls</legend>
        <StudioConditionControls key={`${context.savedSourceFingerprint}:${context.operandBindingFingerprint}`}
          {...(working === null ? {} : { value: working })} context={controls} label="Required If condition" onChange={update} />
      </fieldset>
      {working === null && <p role="alert">This If condition is required. Repair it or Undo before Apply or Save.</p>}
      {(localValidation?.issues.length ?? 0) > 0 && <ul role="alert" className="list-disc pl-6">
        {localValidation!.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.pointer || "Condition"}: {issue.message}</li>)}
      </ul>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" className={buttonClass} onClick={apply} disabled={busy || !staged || !valid}>Apply</Button>
        <Button type="button" variant="outline" size="sm" className={buttonClass} onClick={undo} disabled={busy || (!staged && undoStack.length === 0)}>Undo</Button>
        <Button type="button" variant="outline" size="sm" className={buttonClass} onClick={redo} disabled={busy || staged || redoStack.length === 0}>Redo</Button>
        <Button type="button" variant="outline" size="sm" className={buttonClass} onClick={() => void submit(false)} disabled={busy || staged || !valid}>Validate</Button>
        <Button type="button" variant="outline" size="sm" className={buttonClass} onClick={() => void submit(true)} disabled={busy || staged || !dirty || !valid}>Save</Button>
      </div>
      <p>{dirty ? "Applied changes are not saved." : "The applied condition matches the saved draft."}</p>
    </section>}
    {validationErrors}
    <p aria-live="polite" role="status">{message}</p>
    <Button type="button" variant="outline" size="sm" className={buttonClass} onClick={() => void load(selectedRef.current, true)} disabled={busy}>Reopen</Button>
  </main>;
}
