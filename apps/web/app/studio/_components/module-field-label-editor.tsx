"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { canonicalJson, labelSchema, sameId, storedModuleDefinitionDraftSchema } from "@vortex/contracts";
import type { StoredModuleDefinitionDraft } from "@vortex/definition";
import type { StudioModuleFieldDescriptor, StudioModuleFieldLabelResult } from "../../_lib/studio-module-field-label";
import { reopenModuleFieldLabel, saveModuleFieldLabel } from "../module-field-label-actions";

const inputClass = "w-full rounded border border-border bg-background px-3 py-2 text-foreground";
const buttonClass = "rounded border border-border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50";
const selectionKey = (field: StudioModuleFieldDescriptor) => JSON.stringify([field.recordAlias, field.fieldAlias]);
const descriptorsFor = (draft: StoredModuleDefinitionDraft): readonly StudioModuleFieldDescriptor[] =>
  draft.source.body.record_types.flatMap((record) => record.fields.map((field) => ({
    recordAlias: record.id, recordKey: record.key, recordName: record.name,
    fieldAlias: field.id, fieldKey: field.key, label: field.label, type: field.type,
  })));

/** One semantic field buffer; only a verified response replaces the persisted baseline. */
export function ModuleFieldLabelEditor({ draft, fields }: {
  draft: StoredModuleDefinitionDraft; fields: readonly StudioModuleFieldDescriptor[];
}) {
  const [baseline, setBaseline] = useState(draft);
  const [choices, setChoices] = useState(fields);
  const [selectedKey, setSelectedKey] = useState(() => fields[0] === undefined ? "" : selectionKey(fields[0]));
  const [label, setLabel] = useState(fields[0]?.label ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [validation, setValidation] = useState<Extract<StudioModuleFieldLabelResult, { kind: "validation_failed" }> | null>(null);
  const active = useRef(false);
  const lifetime = useRef(0);
  const generation = useRef(0);
  const pending = useRef(false);
  const buffer = useRef({ baseline, selectedKey, label });
  const selected = choices.find((field) => selectionKey(field) === selectedKey);
  const dirty = selected !== undefined && label !== selected.label;

  useEffect(() => {
    active.current = true; lifetime.current += 1;
    return () => { active.current = false; lifetime.current += 1; generation.current += 1; };
  }, []);

  const replaceBuffer = (next: StoredModuleDefinitionDraft, nextChoices: readonly StudioModuleFieldDescriptor[], key: string) => {
    const choice = nextChoices.find((field) => selectionKey(field) === key) ?? nextChoices[0];
    const nextKey = choice === undefined ? "" : selectionKey(choice);
    const nextLabel = choice?.label ?? "";
    buffer.current = { baseline: next, selectedKey: nextKey, label: nextLabel };
    generation.current += 1;
    setBaseline(next); setChoices(nextChoices); setSelectedKey(nextKey); setLabel(nextLabel); setValidation(null);
  };

  const responseDraft = (result: Extract<StudioModuleFieldLabelResult, { kind: "available" }>) => {
    const parsed = storedModuleDefinitionDraftSchema.safeParse(result.draft);
    if (!parsed.success || !sameId(parsed.data.organizationId, draft.organizationId) || !sameId(parsed.data.rootId, draft.rootId) ||
        parsed.data.key !== draft.key || parsed.data.source.root_alias !== draft.source.root_alias ||
        parsed.data.createdAt !== draft.createdAt || !sameId(parsed.data.createdBy, draft.createdBy) ||
        canonicalJson(result.fields) !== canonicalJson(descriptorsFor(parsed.data))) return null;
    return parsed.data;
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!active.current || pending.current || selected === undefined || !dirty) return;
    const captured = buffer.current;
    const capturedField = selected;
    const epoch = ++generation.current;
    const mounted = lifetime.current;
    const isCurrent = () => active.current && mounted === lifetime.current && epoch === generation.current &&
      buffer.current.baseline === captured.baseline && buffer.current.selectedKey === captured.selectedKey && buffer.current.label === captured.label;
    pending.current = true; setBusy(true); setValidation(null); setMessage("Saving the selected Module field label…");
    try {
      const result = await saveModuleFieldLabel(captured.baseline.organizationId, {
        rootId: captured.baseline.rootId, expectedDraftRevision: captured.baseline.draftRevision,
        expectedSavedSourceFingerprint: captured.baseline.sourceFingerprint,
        recordAlias: capturedField.recordAlias, fieldAlias: capturedField.fieldAlias, label: captured.label,
      });
      if (!isCurrent()) return;
      if (result.kind === "available") {
        const saved = responseDraft(result);
        const parsedLabel = labelSchema.safeParse(captured.label);
        const expected = structuredClone(captured.baseline.source);
        const expectedRecord = expected.body.record_types.filter((record) => record.id === capturedField.recordAlias);
        const expectedFields = expectedRecord[0]?.fields.filter((field) => field.id === capturedField.fieldAlias);
        const expectedField = expectedFields?.[0];
        if (saved === null || !parsedLabel.success || expectedRecord.length !== 1 || expectedFields?.length !== 1 || expectedField === undefined) {
          setMessage("The saved result could not be verified. Your pending label is preserved."); return;
        }
        expectedField.label = parsedLabel.data;
        if (saved.draftRevision !== captured.baseline.draftRevision + 1 || canonicalJson(saved.source) !== canonicalJson(expected) ||
            saved.publishedRevision !== captured.baseline.publishedRevision || Date.parse(saved.updatedAt) < Date.parse(captured.baseline.updatedAt) ||
            saved.restoredAt !== undefined || saved.restoredBy !== undefined || saved.restoredFromReleaseRevision !== undefined ||
            saved.restoredFromSourceFingerprint !== undefined || saved.restoreCorrelationId !== undefined) {
          setMessage("The saved result could not be verified. Your pending label is preserved."); return;
        }
        replaceBuffer(saved, result.fields, captured.selectedKey);
        setMessage(`Saved Module draft revision ${saved.draftRevision}. Reopen to read the persisted draft again.`);
      } else if (result.kind === "validation_failed") {
        setValidation(result); setMessage("The label could not be saved. Correct the located validation feedback; your pending label is preserved.");
      } else setMessage(result.kind === "conflict"
        ? "The Module draft changed. Your pending label is preserved. Reopen explicitly before retrying."
        : result.kind === "refused" ? "This save was refused. Your pending label is preserved."
          : "The save could not be verified. Your pending label is preserved.");
    } catch {
      if (isCurrent()) setMessage("The save could not be verified. Your pending label is preserved.");
    } finally {
      pending.current = false;
      if (active.current && mounted === lifetime.current) setBusy(false);
    }
  };

  const reopen = async () => {
    if (!active.current || pending.current) return;
    if (dirty && !window.confirm("Discard the pending label and reopen this Module's saved draft?")) return;
    const captured = buffer.current;
    const epoch = ++generation.current;
    const mounted = lifetime.current;
    const isCurrent = () => active.current && mounted === lifetime.current && epoch === generation.current &&
      buffer.current.baseline === captured.baseline && buffer.current.selectedKey === captured.selectedKey && buffer.current.label === captured.label;
    pending.current = true; setBusy(true); setValidation(null); setMessage("Reading the saved Module draft with current permissions…");
    try {
      const result = await reopenModuleFieldLabel(captured.baseline.organizationId, captured.baseline.rootId);
      if (!isCurrent()) return;
      const reopened = result.kind === "available" ? responseDraft(result) : null;
      if (reopened === null || result.kind !== "available" || reopened.draftRevision < captured.baseline.draftRevision ||
          (reopened.draftRevision === captured.baseline.draftRevision &&
            (reopened.sourceFingerprint !== captured.baseline.sourceFingerprint || canonicalJson(reopened.source) !== canonicalJson(captured.baseline.source)))) {
        setMessage("The Module draft could not be reopened. Your pending label is preserved."); return;
      }
      replaceBuffer(reopened, result.fields, captured.selectedKey);
      setMessage(`Reopened persisted Module draft revision ${reopened.draftRevision}.`);
    } catch {
      if (isCurrent()) setMessage("The Module draft could not be reopened. Your pending label is preserved.");
    } finally {
      pending.current = false;
      if (active.current && mounted === lifetime.current) setBusy(false);
    }
  };

  return <main className="mx-auto max-w-3xl space-y-6 p-6" aria-busy={busy}>
    <header className="space-y-2"><h1 className="text-2xl font-semibold">Module draft: {baseline.source.body.name}</h1>
      <dl className="break-all text-sm">
        <div><dt className="inline font-medium">Organization: </dt><dd className="inline">{baseline.organizationId}</dd></div>
        <div><dt className="inline font-medium">Module root: </dt><dd className="inline">{baseline.rootId}</dd></div>
        <div><dt className="inline font-medium">Module key: </dt><dd className="inline">{baseline.key}</dd></div>
        <div><dt className="inline font-medium">Module draft revision: </dt><dd className="inline">{baseline.draftRevision}</dd></div>
        <div><dt className="inline font-medium">Saved source fingerprint: </dt><dd className="inline">{baseline.sourceFingerprint}</dd></div>
      </dl>
      <p>Edit one authored field label. Save explicitly updates this Module's draft revision.</p>
    </header>
    <form className="space-y-4" onSubmit={save}>
      <label className="block space-y-1"><span>Module field</span>
        <select className={inputClass} value={selectedKey} disabled={busy || choices.length === 0} onChange={(event) => {
          if (pending.current) return;
          const next = choices.find((field) => selectionKey(field) === event.target.value);
          if (next === undefined || (dirty && !window.confirm("Discard the pending label and select another field?"))) return;
          buffer.current = { baseline, selectedKey: selectionKey(next), label: next.label };
          generation.current += 1; setSelectedKey(selectionKey(next)); setLabel(next.label); setValidation(null); setMessage("");
        }}>
          {choices.map((field) => <option key={selectionKey(field)} value={selectionKey(field)}>
            {field.recordName} / {field.label} ({field.recordAlias}.{field.fieldAlias})</option>)}
        </select></label>
      {selected !== undefined ? <>
        <p className="break-all text-sm">Field type: {selected.type}. Authored path: body.record_types[{selected.recordAlias}].fields[{selected.fieldAlias}].label</p>
        <label className="block space-y-1"><span>Field label</span>
          <input className={inputClass} value={label} maxLength={60} required disabled={busy} onChange={(event) => {
            if (pending.current) return;
            buffer.current = { ...buffer.current, label: event.target.value }; generation.current += 1;
            setLabel(event.target.value); setValidation(null); setMessage("");
          }} /></label>
      </> : <p role="status">No authored field is available.</p>}
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} type="submit" disabled={busy || !dirty || selected === undefined}>Save field label</button>
        <button className={buttonClass} type="button" disabled={busy} onClick={reopen}>Reopen saved Module draft</button>
      </div>
      <p role="status" aria-live="polite">{dirty ? "Pending label changes. " : "The label matches the saved Module draft. "}{message}</p>
      {validation !== null && <ul className="space-y-2" aria-label="Module validation feedback">
        {validation.validation.errors.map((error, index) => <li key={`${error.code}:${index}`}>
          <p>{error.message} {error.guidance}</p>
          <p className="break-all text-sm">{error.location?.documentKind}: {error.location?.documentKey}
            {error.location?.segments.map((segment) => ` / ${segment.kind}:${segment.key}`).join("")}</p>
        </li>)}
      </ul>}
    </form>
  </main>;
}
