"use client";

import { useEffect, useRef, useState } from "react";
import { type ConditionNode, type DefinitionValidationResult } from "@vortex/contracts";
import {
  StudioConditionControls,
  validateStudioCondition,
  type StudioConditionValidation,
} from "@vortex/studio";
import type { ModuleQueryFilterDraftContext, ModuleQueryFilterQueryChoice } from "@vortex/definition";
import type {
  StudioModuleQueryFilterResult,
  StudioModuleQueryFilterSnapshot,
} from "../_lib/studio-module-query-filter";
import { moduleQueryFilterControlsContext, sameModuleQueryFilter } from "../_lib/module-query-filter-commands";
import {
  loadModuleQueryFilter,
  saveModuleQueryFilter,
  validateModuleQueryFilter,
} from "../modules/[organizationId]/[moduleRootId]/queries/actions";

type Filter = ConditionNode | null;
type Props = Readonly<{
  organizationId: string;
  moduleRootId: string;
  initial: StudioModuleQueryFilterResult;
}>;

const buttonClass = "rounded border border-border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50";
const choiceList = (result: StudioModuleQueryFilterResult): readonly ModuleQueryFilterQueryChoice[] =>
  result.kind === "available" || result.kind === "readonly" ? result.queryChoices : [];
const initialAlias = (result: StudioModuleQueryFilterResult): string =>
  result.kind === "available" ? result.selected?.query.alias ?? ""
    : result.kind === "readonly" ? result.selectedAlias ?? "" : "";
const initialContext = (result: StudioModuleQueryFilterResult): ModuleQueryFilterDraftContext | undefined =>
  result.kind === "available" ? result.selected : undefined;
const initialSnapshot = (result: StudioModuleQueryFilterResult): StudioModuleQueryFilterSnapshot | undefined =>
  result.kind === "available" ? result.snapshot : undefined;
const sameSelection = (
  current: ModuleQueryFilterDraftContext | undefined,
  next: ModuleQueryFilterDraftContext,
): boolean => current !== undefined && current.organizationId === next.organizationId &&
  current.rootId === next.rootId && current.query.alias === next.query.alias &&
  current.query.queryId === next.query.queryId && current.draftRevision === next.draftRevision &&
  current.savedSourceFingerprint === next.savedSourceFingerprint &&
  current.resolutionFingerprint === next.resolutionFingerprint &&
  current.operandBindingFingerprint === next.operandBindingFingerprint;

/** One local query buffer. Only an explicit Save reaches the protected Module draft writer. */
export function ModuleQueryFilterEditor({ organizationId, moduleRootId, initial }: Props) {
  const [queryChoices, setQueryChoices] = useState(choiceList(initial));
  const [selectedAlias, setSelectedAlias] = useState(initialAlias(initial));
  const [context, setContext] = useState(initialContext(initial));
  const [snapshot, setSnapshot] = useState(initialSnapshot(initial));
  const [baseline, setBaseline] = useState<Filter>(initialContext(initial)?.filter ?? null);
  const [applied, setApplied] = useState<Filter>(initialContext(initial)?.filter ?? null);
  const [working, setWorking] = useState<Filter>(initialContext(initial)?.filter ?? null);
  const [undoStack, setUndoStack] = useState<readonly Filter[]>([]);
  const [redoStack, setRedoStack] = useState<readonly Filter[]>([]);
  const [controlValidation, setControlValidation] = useState<StudioConditionValidation | null>(null);
  const [remoteValidation, setRemoteValidation] = useState<DefinitionValidationResult | null>(
    initial.kind === "validation_failed" ? initial.validation : null,
  );
  const [busy, setBusy] = useState(false);
  const [contextInvalidated, setContextInvalidated] = useState(false);
  const [message, setMessage] = useState(
    initial.kind === "available" ? "Choose a Module Query to inspect its saved filter."
      : initial.kind === "readonly" ? "This Query is read-only for the current editor."
        : initial.kind === "validation_failed" ? "The saved Module definition needs correction before filters can be edited."
          : "The Module query editor is unavailable. Reopen it after checking your current access.",
  );
  const [readonlyReason, setReadonlyReason] = useState(
    initial.kind === "readonly" ? initial.reason : undefined,
  );
  const active = useRef(false);
  const selectionEpoch = useRef(0);
  const requestEpoch = useRef(0);
  const bufferEpoch = useRef(0);
  const contextRef = useRef(context);
  const selectedAliasRef = useRef(selectedAlias);
  const appliedRef = useRef(applied);
  contextRef.current = context;
  selectedAliasRef.current = selectedAlias;
  appliedRef.current = applied;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      selectionEpoch.current += 1;
      requestEpoch.current += 1;
    };
  }, []);

  const controlsContext = context === undefined ? undefined : moduleQueryFilterControlsContext(context);
  const computedValidation = controlsContext === undefined
    ? null
    : validateStudioCondition(working ?? undefined, controlsContext);
  const localValidation = controlValidation ?? computedValidation;
  const staged = !sameModuleQueryFilter(working, applied);
  const dirty = !sameModuleQueryFilter(applied, baseline);
  const selectedChoice = queryChoices.find((choice) => choice.alias === selectedAlias);

  const clearLocalHistory = () => {
    setUndoStack([]);
    setRedoStack([]);
  };

  const setLoadedContext = (
    result: StudioModuleQueryFilterResult,
    requestedAlias: string,
    selectedEpoch: number,
  ): void => {
    if (!active.current || selectedEpoch !== selectionEpoch.current) return;
    setQueryChoices(choiceList(result));
    if (result.kind === "available") {
      if (requestedAlias !== "" && (result.selected === undefined || result.selected.query.alias !== requestedAlias)) {
        setContext(undefined);
          setContextInvalidated(true);
        setSnapshot(result.snapshot);
        setReadonlyReason(result.kind === "available"
          ? result.queryChoices.find((choice) => choice.alias === requestedAlias)?.reason ?? "query_target_unsupported"
          : undefined);
        setMessage("This Query is read-only for the current editor. No draft changes were saved.");
        return;
      }
      setContext(result.selected);
      setContextInvalidated(false);
      setSnapshot(result.snapshot);
      setReadonlyReason(undefined);
      if (result.selected !== undefined) {
        setBaseline(result.selected.filter);
        setApplied(result.selected.filter);
        setWorking(result.selected.filter);
        appliedRef.current = result.selected.filter;
        clearLocalHistory();
        setMessage(`Loaded saved filter at Module draft revision ${result.snapshot.draftRevision}.`);
      } else {
        setMessage("Choose a Module Query to inspect its saved filter.");
      }
      setControlValidation(null);
      setRemoteValidation(null);
      return;
    }
    if (result.kind === "readonly") {
      setContext(undefined);
      setContextInvalidated(true);
      setReadonlyReason(result.reason);
      setMessage("This Query is read-only for the current editor. No draft changes were saved.");
      return;
    }
    setContext(undefined);
    setContextInvalidated(true);
    setMessage(result.kind === "conflict" ? "The saved Module draft changed. Reopen explicitly before editing."
      : result.kind === "refused" ? "Current access does not allow this Query filter operation."
        : result.kind === "validation_failed" ? "The saved Module definition needs correction before filters can be edited."
          : "The Query filter context could not be verified. No draft changes were saved.");
    setRemoteValidation(result.kind === "validation_failed" ? result.validation : null);
  };

  const chooseQuery = async (nextAlias: string) => {
    if (busy || nextAlias === selectedAlias) return;
    if ((dirty || staged) && !window.confirm(
      "Discard the pending filter changes and switch Query? Choose OK to discard or Cancel to keep editing this Query.",
    )) return;
    const selectedEpoch = ++selectionEpoch.current;
    const requestId = ++requestEpoch.current;
    setSelectedAlias(nextAlias);
    setContext(undefined);
    setContextInvalidated(false);
    setSnapshot(undefined);
    setBaseline(null);
    setApplied(null);
    setWorking(null);
    appliedRef.current = null;
    clearLocalHistory();
    setControlValidation(null);
    setReadonlyReason(undefined);
    setRemoteValidation(null);
    setBusy(true);
    setMessage(nextAlias === "" ? "Refreshing current Query choices…" : "Loading this Query from the current Module draft…");
    bufferEpoch.current += 1;
    try {
      const result = await loadModuleQueryFilter(organizationId, moduleRootId, nextAlias || undefined);
      if (!active.current || selectedEpoch !== selectionEpoch.current || requestId !== requestEpoch.current) return;
      setLoadedContext(result, nextAlias, selectedEpoch);
    } catch {
      if (active.current && selectedEpoch === selectionEpoch.current && requestId === requestEpoch.current)
        setMessage("The Query could not be loaded. No filter changes were saved.");
    } finally {
      if (active.current && selectedEpoch === selectionEpoch.current && requestId === requestEpoch.current) setBusy(false);
    }
  };

  const updateWorking = (next: ConditionNode | undefined, validation: StudioConditionValidation) => {
    if (context === undefined || busy) return;
    setWorking(next ?? null);
    setControlValidation(validation);
    setRemoteValidation(null);
    bufferEpoch.current += 1;
    setMessage(staged ? "Apply the pending condition edits before validation or saving." : "Condition edits are local until you apply them.");
  };

  const apply = () => {
    if (context === undefined || localValidation === null || !localValidation.isValid || !staged) return;
    setUndoStack((current) => [...current, applied]);
    setRedoStack([]);
    setApplied(working);
    appliedRef.current = working;
    bufferEpoch.current += 1;
    setRemoteValidation(null);
    setMessage("Applied locally. Save explicitly to update the Module draft.");
  };

  const clearFilter = () => {
    if (context === undefined || busy || working === null) return;
    setWorking(null);
    setControlValidation(null);
    setRemoteValidation(null);
    bufferEpoch.current += 1;
    setMessage("Filter cleared locally. Apply, then save explicitly to remove it from the Module draft.");
  };

  const undo = () => {
    if (busy) return;
    if (staged) {
      setWorking(applied);
      setControlValidation(null);
      setRemoteValidation(null);
      bufferEpoch.current += 1;
      setMessage("Unapplied condition edits were reverted locally.");
      return;
    }
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    if (previous === undefined) return;
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current, applied]);
    setApplied(previous);
    setWorking(previous);
    appliedRef.current = previous;
    setControlValidation(null);
    setRemoteValidation(null);
    bufferEpoch.current += 1;
  };

  const redo = () => {
    if (busy || staged || redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    if (next === undefined) return;
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current, applied]);
    setApplied(next);
    setWorking(next);
    appliedRef.current = next;
    setControlValidation(null);
    setRemoteValidation(null);
    bufferEpoch.current += 1;
  };

  const requestBody = (activeContext: ModuleQueryFilterDraftContext, condition: Filter) => ({
    rootId: activeContext.rootId,
    queryAlias: activeContext.query.alias,
    expectedDraftRevision: activeContext.draftRevision,
    expectedSavedSourceFingerprint: activeContext.savedSourceFingerprint,
    expectedResolutionFingerprint: activeContext.resolutionFingerprint,
    expectedOperandBindingFingerprint: activeContext.operandBindingFingerprint,
    condition,
  });

  const validate = async () => {
    const activeContext = contextRef.current;
    if (activeContext === undefined || staged || localValidation?.isValid !== true || busy) return;
    const selectedEpoch = selectionEpoch.current;
    const requestId = ++requestEpoch.current;
    const capturedBuffer = bufferEpoch.current;
    const submitted = appliedRef.current;
    setBusy(true);
    setRemoteValidation(null);
    setMessage("Validating this filter against the current Module draft and dependencies…");
    try {
      const result = await validateModuleQueryFilter(
        organizationId,
        requestBody(activeContext, submitted),
      );
      if (!active.current || selectedEpoch !== selectionEpoch.current || requestId !== requestEpoch.current ||
          contextRef.current === undefined || !sameSelection(contextRef.current, activeContext)) return;
      if (bufferEpoch.current !== capturedBuffer) return;
      if (result.kind === "valid") {
        setContextInvalidated(false);
        setMessage("This filter passed current Module validation. Save explicitly to write it.");
        return;
      }
      if (result.kind !== "validation_failed") setContextInvalidated(true);
      if (result.kind === "validation_failed") setRemoteValidation(result.validation);
      setMessage(result.kind === "validation_failed"
        ? "The filter needs correction. Your local condition is preserved."
        : result.kind === "readonly" ? "This Query became read-only. Your local condition is preserved."
          : result.kind === "conflict" ? "The saved draft changed. Reopen explicitly; your local condition is preserved."
            : result.kind === "refused" ? "Current access does not allow validation. Your local condition is preserved."
              : "Validation could not be verified. Your local condition is preserved.");
    } catch {
      if (active.current && selectedEpoch === selectionEpoch.current && requestId === requestEpoch.current &&
          bufferEpoch.current === capturedBuffer) {
        setContextInvalidated(true);
        setMessage("Validation could not be verified. Your local condition is preserved.");
      }
    } finally {
      if (active.current && selectedEpoch === selectionEpoch.current && requestId === requestEpoch.current) setBusy(false);
    }
  };

  const save = async () => {
    const activeContext = contextRef.current;
    if (activeContext === undefined || staged || !dirty || localValidation?.isValid !== true || busy) return;
    const selectedEpoch = selectionEpoch.current;
    const requestId = ++requestEpoch.current;
    const capturedBuffer = bufferEpoch.current;
    const submitted = appliedRef.current;
    setBusy(true);
    setRemoteValidation(null);
    setMessage("Saving this filter with the current Module revision and permission…");
    try {
      const result = await saveModuleQueryFilter(organizationId, requestBody(activeContext, submitted));
      if (!active.current || selectedEpoch !== selectionEpoch.current || requestId !== requestEpoch.current ||
          contextRef.current === undefined || !sameSelection(contextRef.current, activeContext)) return;
      if (result.kind === "saved" || result.kind === "unchanged") {
        if (result.snapshot.rootId !== moduleRootId || result.snapshot.organizationId !== organizationId ||
            result.selected.query.alias !== activeContext.query.alias ||
            result.selected.query.queryId !== activeContext.query.queryId ||
            result.selected.draftRevision !== result.snapshot.draftRevision ||
            result.selected.savedSourceFingerprint !== result.snapshot.sourceFingerprint) {
          setContextInvalidated(true);
          setMessage("The save receipt did not match this Query. Your local condition is preserved.");
          return;
        }
        setSnapshot(result.snapshot);
        setContext(result.selected);
        setContextInvalidated(false);
        if (bufferEpoch.current === capturedBuffer) {
          setBaseline(result.selected.filter);
          setApplied(result.selected.filter);
          setWorking(result.selected.filter);
          appliedRef.current = result.selected.filter;
          clearLocalHistory();
          setControlValidation(null);
          setRemoteValidation(null);
        } else {
          setMessage("The submitted filter was saved. Newer local edits remain unsaved.");
          return;
        }
        setMessage(result.kind === "saved"
          ? `Saved at Module draft revision ${result.snapshot.draftRevision}.`
          : `No source change was needed at Module draft revision ${result.snapshot.draftRevision}.`);
        return;
      }
      if (result.kind !== "validation_failed") setContextInvalidated(true);
      if (result.kind === "validation_failed") setRemoteValidation(result.validation);
      setMessage(result.kind === "validation_failed"
        ? "The filter needs correction. Your local condition is preserved."
        : result.kind === "readonly" ? "This Query became read-only. Your local condition is preserved."
          : result.kind === "conflict" ? "The saved draft changed. Reopen explicitly; your local condition is preserved."
            : result.kind === "refused" ? "Current access does not allow saving. Your local condition is preserved."
              : "The save could not be verified. Your local condition is preserved.");
    } catch {
      if (active.current && selectedEpoch === selectionEpoch.current && requestId === requestEpoch.current) {
        setContextInvalidated(true);
        setMessage("The save could not be verified. Your local condition is preserved.");
      }
    } finally {
      if (active.current && selectedEpoch === selectionEpoch.current && requestId === requestEpoch.current) setBusy(false);
    }
  };

  const reopen = async () => {
    if (busy) return;
    if ((dirty || staged) && !window.confirm(
      "Discard the pending filter changes and reopen the saved Module draft? Choose OK to discard or Cancel to keep editing.",
    )) return;
    const selectedEpoch = ++selectionEpoch.current;
    const requestId = ++requestEpoch.current;
    const requestedAlias = selectedAliasRef.current;
    setBusy(true);
    setMessage("Reopening the current saved Module draft…");
    try {
      const result = await loadModuleQueryFilter(organizationId, moduleRootId, requestedAlias || undefined);
      if (!active.current || selectedEpoch !== selectionEpoch.current || requestId !== requestEpoch.current) return;
      setQueryChoices(choiceList(result));
      if (result.kind === "available") {
        if (requestedAlias !== "" && result.selected === undefined) {
          const choice = result.queryChoices.find((entry) => entry.alias === requestedAlias);
          setContext(undefined);
          setContextInvalidated(true);
          setReadonlyReason(choice?.reason ?? "query_target_unsupported");
          setMessage("This Query is read-only. The pending filter is preserved.");
          return;
        }
        setSnapshot(result.snapshot);
        setContext(result.selected);
        setContextInvalidated(false);
        setReadonlyReason(undefined);
        if (result.selected !== undefined) {
          setBaseline(result.selected.filter);
          setApplied(result.selected.filter);
          setWorking(result.selected.filter);
          appliedRef.current = result.selected.filter;
          clearLocalHistory();
          setControlValidation(null);
          setRemoteValidation(null);
          setMessage(`Reopened persisted Module draft revision ${result.snapshot.draftRevision}.`);
        } else setMessage("Choose a Module Query to inspect its saved filter.");
        return;
      }
      setContext(undefined);
      setContextInvalidated(true);
      if (result.kind === "validation_failed") setRemoteValidation(result.validation);
      if (result.kind === "readonly") setReadonlyReason(result.reason);
      setMessage(result.kind === "conflict" ? "The saved draft changed. Reopen again after reviewing the current selection."
        : result.kind === "refused" ? "Current access does not allow reopening. Your pending filter is preserved."
          : result.kind === "validation_failed" ? "The saved Module definition needs correction before filters can be edited."
            : "The saved Query could not be reopened. Your pending filter is preserved.");
    } catch {
      if (active.current && selectedEpoch === selectionEpoch.current && requestId === requestEpoch.current) {
        setContext(undefined);
        setContextInvalidated(true);
        setMessage("The saved Query could not be reopened. Your pending filter is preserved.");
      }
    } finally {
      if (active.current && selectedEpoch === selectionEpoch.current && requestId === requestEpoch.current) setBusy(false);
    }
  };

  const localIssues = localValidation?.issues ?? [];
  const canEdit = context !== undefined && readonlyReason === undefined && !contextInvalidated;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6" aria-busy={busy}>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Module query filters</h1>
        <p>Author a local Module Query filter in the saved draft. Saving does not publish, install, or run the query.</p>
        {snapshot !== undefined && (
          <dl className="break-all text-sm">
            <div><dt className="inline font-medium">Module key: </dt><dd className="inline">{snapshot.key}</dd></div>
            <div><dt className="inline font-medium">Draft revision: </dt><dd className="inline">{snapshot.draftRevision}</dd></div>
            <div><dt className="inline font-medium">Published revision: </dt><dd className="inline">{snapshot.publishedRevision ?? "None"}</dd></div>
          </dl>
        )}
      </header>

      <section className="space-y-3" aria-label="Query selection">
        <label className="block space-y-1">
          <span>Module Query</span>
          <select className="w-full rounded border border-border bg-background px-3 py-2" value={selectedAlias}
            onChange={(event) => void chooseQuery(event.target.value)} disabled={busy}>
            <option value="">Choose a Query</option>
            {queryChoices.map((choice) => (
              <option key={choice.alias} value={choice.alias}>
                {choice.label ?? choice.key} ({choice.eligible ? "editable" : "read-only"})
              </option>
            ))}
          </select>
        </label>
        {selectedChoice !== undefined && !selectedChoice.eligible && (
          <p role="status">This Query is read-only because its target, operands, or retained filter is outside this editor’s supported scope.</p>
        )}
      </section>

      {canEdit && controlsContext !== undefined && (
        <section className="space-y-4" aria-label="Filter editor">
          <fieldset disabled={busy}>
            <legend className="sr-only">Condition controls</legend>
            <StudioConditionControls
              key={`${context.savedSourceFingerprint}:${context.operandBindingFingerprint}`}
              value={working ?? undefined}
              context={controlsContext}
              label="Query filter condition"
              onChange={updateWorking}
            />
          </fieldset>
          {localIssues.length > 0 && (
            <div role="alert" aria-live="polite">
              <h2 className="font-medium">Condition needs correction</h2>
              <ul className="list-disc pl-6">
                {localIssues.map((issue, index) => <li key={`${issue.pointer}:${issue.code}:${index}`}>
                  {issue.pointer || "Condition"}: {issue.message}
                </li>)}
              </ul>
            </div>
          )}
          {remoteValidation !== null && (
            <div role="alert" aria-live="polite">
              <h2 className="font-medium">Current Module validation</h2>
              <ul className="list-disc pl-6">
                {remoteValidation.errors.map((error, index) => <li key={`${error.code}:${index}`}>
                  {error.message} {error.guidance}
                </li>)}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={apply}
              disabled={busy || !staged || localValidation?.isValid !== true}>Apply</button>
            <button type="button" className={buttonClass} onClick={undo} disabled={busy || (!staged && undoStack.length === 0)}>Undo</button>
            <button type="button" className={buttonClass} onClick={redo} disabled={busy || staged || redoStack.length === 0}>Redo</button>
            <button type="button" className={buttonClass} onClick={clearFilter} disabled={busy || working === null}>Clear filter</button>
            <button type="button" className={buttonClass} onClick={() => void validate()}
              disabled={busy || staged || localValidation?.isValid !== true}>Validate</button>
            <button type="button" className={buttonClass} onClick={() => void save()}
              disabled={busy || !dirty || staged || localValidation?.isValid !== true}>Save</button>
            <button type="button" className={buttonClass} onClick={() => void reopen()} disabled={busy}>Reopen</button>
          </div>
          <p aria-live="polite" role="status">{message}</p>
          <p className="text-sm">{dirty ? "Applied filter changes are not saved." : "The applied filter matches the saved draft."}</p>
        </section>
      )}

      {!canEdit && (
        <section className="space-y-3" aria-label="Read-only filter status">
          <p role="status">{message}</p>
          {remoteValidation !== null && <ul className="list-disc pl-6" role="alert">
            {remoteValidation.errors.map((error, index) => <li key={`${error.code}:${index}`}>
              {error.message} {error.guidance}
            </li>)}
          </ul>}
          <button type="button" className={buttonClass} onClick={() => void reopen()} disabled={busy}>Reopen</button>
        </section>
      )}
    </main>
  );
}
