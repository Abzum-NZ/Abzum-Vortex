"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  canonicalJson, correlationIdSchema, moduleSourceDocumentSchema, sameId,
  storedModuleDefinitionDraftSchema,
  translateDefinitionSchemaError,
  type DefinitionValidationLocation, type DefinitionValidationResult,
} from "@vortex/contracts";
import type { StoredModuleDefinitionDraft } from "@vortex/definition";
import type {
  StudioModuleTextFieldDescriptor,
  StudioModuleTextFieldSettingsResult,
} from "../../_lib/studio-module-text-field-settings";
import { reopenModuleTextFieldSettings, saveModuleTextFieldSettings } from "../modules/[organizationId]/[moduleRootId]/fields/actions";

const inputClass = "w-full rounded border border-border bg-background px-3 py-2 text-foreground";
const buttonClass = "rounded border border-border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50";
const selectionKey = (field: StudioModuleTextFieldDescriptor) => JSON.stringify([field.recordAlias, field.fieldAlias]);
const descriptorsFor = (draft: StoredModuleDefinitionDraft): readonly StudioModuleTextFieldDescriptor[] =>
  draft.source.body.record_types.flatMap((record) => record.fields.flatMap((field) => field.type === "text" ? [{
    recordAlias: record.id,
    recordKey: record.key,
    recordName: record.name,
    fieldAlias: field.id,
    fieldKey: field.key,
    label: field.label,
    type: "text" as const,
    maxLength: field.settings.max_length,
    ...(field.settings.format === undefined ? {} : { format: field.settings.format }),
  }] : []));

const settingLocation = (
  draft: StoredModuleDefinitionDraft, recordKey: string, fieldKey: string, settingKey: string,
): DefinitionValidationLocation => ({
  documentKind: "module",
  documentKey: draft.key,
  segments: [
    { kind: "module", key: draft.key },
    { kind: "record_type", key: recordKey },
    { kind: "field", key: fieldKey },
    { kind: "setting", key: settingKey },
  ],
});

const responseDraft = (
  result: Extract<StudioModuleTextFieldSettingsResult, { kind: "available" }>,
  expected: StoredModuleDefinitionDraft,
) => {
  const parsed = storedModuleDefinitionDraftSchema.safeParse(result.draft);
  if (!parsed.success || !sameId(parsed.data.organizationId, expected.organizationId) || !sameId(parsed.data.rootId, expected.rootId) ||
      parsed.data.key !== expected.key || parsed.data.source.root_alias !== expected.source.root_alias ||
      parsed.data.createdAt !== expected.createdAt || !sameId(parsed.data.createdBy, expected.createdBy) ||
      canonicalJson(result.fields) !== canonicalJson(descriptorsFor(parsed.data))) return null;
  return parsed.data;
};

/** A single semantic settings buffer; only a verified response replaces the saved baseline. */
export function ModuleTextFieldSettingsEditor({ draft, fields }: {
  draft: StoredModuleDefinitionDraft;
  fields: readonly StudioModuleTextFieldDescriptor[];
}) {
  const [baseline, setBaseline] = useState(draft);
  const [choices, setChoices] = useState(fields);
  const [selectedKey, setSelectedKey] = useState(() => fields[0] === undefined ? "" : selectionKey(fields[0]));
  const [maxLength, setMaxLength] = useState(fields[0] === undefined ? "" : String(fields[0].maxLength));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [validation, setValidation] = useState<DefinitionValidationResult | null>(null);
  const active = useRef(false);
  const lifetime = useRef(0);
  const generation = useRef(0);
  const pending = useRef(false);
  const buffer = useRef({ baseline, selectedKey, maxLength });
  const selected = choices.find((field) => selectionKey(field) === selectedKey);
  const dirty = selected !== undefined && maxLength !== String(selected.maxLength);

  useEffect(() => {
    active.current = true;
    lifetime.current += 1;
    return () => { active.current = false; lifetime.current += 1; generation.current += 1; };
  }, []);

  const replaceBuffer = (next: StoredModuleDefinitionDraft, nextChoices: readonly StudioModuleTextFieldDescriptor[], key: string) => {
    const choice = nextChoices.find((field) => selectionKey(field) === key) ?? nextChoices[0];
    const nextKey = choice === undefined ? "" : selectionKey(choice);
    const nextValue = choice === undefined ? "" : String(choice.maxLength);
    buffer.current = { baseline: next, selectedKey: nextKey, maxLength: nextValue };
    generation.current += 1;
    setBaseline(next);
    setChoices(nextChoices);
    setSelectedKey(nextKey);
    setMaxLength(nextValue);
    setValidation(null);
  };

  const schemaValidation = (source: StoredModuleDefinitionDraft["source"], field: StudioModuleTextFieldDescriptor) => {
    const recordIndexes = source.body.record_types.flatMap((record, index) => record.id === field.recordAlias ? [index] : []);
    const record = source.body.record_types[recordIndexes[0] ?? -1];
    const fieldIndexes = record?.fields.flatMap((candidate, index) => candidate.id === field.fieldAlias ? [index] : []) ?? [];
    const authoredField = record?.fields[fieldIndexes[0] ?? -1];
    if (recordIndexes.length !== 1 || record === undefined || fieldIndexes.length !== 1 || authoredField?.type !== "text") return null;
    const maxLengthLocation = settingLocation(baseline, record.key, authoredField.key, "max_length");
    const prefix = ["body", "record_types", recordIndexes[0]!, "fields", fieldIndexes[0]!] as (string | number)[];
    const parsed = moduleSourceDocumentSchema.safeParse(source);
    if (parsed.success) return null;
    return translateDefinitionSchemaError(parsed.error, {
      correlationId: correlationIdSchema.parse(globalThis.crypto.randomUUID()),
      rootLocation: maxLengthLocation,
      pathMap: [
        { sourcePath: [...prefix, "settings"], location: maxLengthLocation },
        { sourcePath: [...prefix, "settings", "max_length"], location: maxLengthLocation },
        { sourcePath: [...prefix, "default"], location: settingLocation(baseline, record.key, authoredField.key, "default") },
      ],
    }));
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!active.current || pending.current || selected === undefined || !dirty) return;
    const captured = buffer.current;
    const capturedField = selected;
    const wholeNumberText = captured.maxLength.trim();
    if (wholeNumberText === "" || !/^\d+$/.test(wholeNumberText)) {
      setMessage("Enter a whole number. Your pending value is preserved.");
      return;
    }
    const parsedMaxLength = Number(wholeNumberText);
    if (!Number.isSafeInteger(parsedMaxLength)) {
      setMessage("Enter a safe whole number. Your pending value is preserved.");
      return;
    }
    const proposed = structuredClone(captured.baseline.source);
    const proposalRecords = proposed.body.record_types.filter((record) => record.id === capturedField.recordAlias);
    const proposalFields = proposalRecords[0]?.fields.filter((field) => field.id === capturedField.fieldAlias);
    const proposalField = proposalFields?.[0];
    if (proposalRecords.length !== 1 || proposalFields?.length !== 1 || proposalField?.type !== "text") {
      setMessage("The selected authored text field could not be verified. Reopen the saved draft.");
      return;
    }
    proposalField.settings.max_length = parsedMaxLength;
    const advisory = schemaValidation(proposed, capturedField);
    if (advisory !== null) {
      setValidation(advisory);
      setMessage("The whole Module source does not accept this setting. Correct the located feedback; your pending value is preserved.");
      return;
    }

    const epoch = ++generation.current;
    const mounted = lifetime.current;
    const isCurrent = () => active.current && mounted === lifetime.current && epoch === generation.current &&
      buffer.current.baseline === captured.baseline && buffer.current.selectedKey === captured.selectedKey &&
      buffer.current.maxLength === captured.maxLength;
    pending.current = true;
    setBusy(true);
    setValidation(null);
    setMessage("Saving the selected Module text setting…");
    try {
      const result = await saveModuleTextFieldSettings(captured.baseline.organizationId, {
        rootId: captured.baseline.rootId,
        expectedDraftRevision: captured.baseline.draftRevision,
        expectedSavedSourceFingerprint: captured.baseline.sourceFingerprint,
        recordAlias: capturedField.recordAlias,
        fieldAlias: capturedField.fieldAlias,
        maxLength: parsedMaxLength,
      });
      if (!isCurrent()) return;
      if (result.kind === "available") {
        const saved = responseDraft(result, captured.baseline);
        const expected = structuredClone(captured.baseline.source);
        const expectedRecords = expected.body.record_types.filter((record) => record.id === capturedField.recordAlias);
        const expectedFields = expectedRecords[0]?.fields.filter((field) => field.id === capturedField.fieldAlias);
        const expectedField = expectedFields?.[0];
        if (saved === null || expectedRecords.length !== 1 || expectedFields?.length !== 1 || expectedField?.type !== "text") {
          setMessage("The saved result could not be verified. Your pending value is preserved.");
          return;
        }
        expectedField.settings.max_length = parsedMaxLength;
        if (saved.draftRevision !== captured.baseline.draftRevision + 1 ||
            canonicalJson(saved.source) !== canonicalJson(expected) ||
            saved.publishedRevision !== captured.baseline.publishedRevision ||
            Date.parse(saved.updatedAt) < Date.parse(captured.baseline.updatedAt) ||
            saved.restoredAt !== undefined || saved.restoredBy !== undefined ||
            saved.restoredFromReleaseRevision !== undefined || saved.restoredFromSourceFingerprint !== undefined ||
            saved.restoreCorrelationId !== undefined) {
          setMessage("The saved result could not be verified. Your pending value is preserved.");
          return;
        }
        replaceBuffer(saved, result.fields, captured.selectedKey);
        setMessage(`Saved Module draft revision ${saved.draftRevision}. Reopen to read the persisted draft again.`);
      } else if (result.kind === "validation_failed") {
        setValidation(result.validation);
        setMessage("The setting could not be saved. Correct the located validation feedback; your pending value is preserved.");
      } else setMessage(result.kind === "conflict"
        ? "The Module draft changed. Your pending value is preserved. Reopen explicitly before retrying."
        : result.kind === "refused" ? "This save was refused. Your pending value is preserved."
          : "The save could not be verified. Your pending value is preserved.");
    } catch {
      if (isCurrent()) setMessage("The save could not be verified. Your pending value is preserved.");
    } finally {
      pending.current = false;
      if (active.current && mounted === lifetime.current) setBusy(false);
    }
  };

  const reopen = async () => {
    if (!active.current || pending.current) return;
    if (dirty && !window.confirm("Discard the pending text setting and reopen this Module's saved draft?")) return;
    const captured = buffer.current;
    const epoch = ++generation.current;
    const mounted = lifetime.current;
    const isCurrent = () => active.current && mounted === lifetime.current && epoch === generation.current &&
      buffer.current.baseline === captured.baseline && buffer.current.selectedKey === captured.selectedKey &&
      buffer.current.maxLength === captured.maxLength;
    pending.current = true;
    setBusy(true);
    setValidation(null);
    setMessage("Reading the saved Module draft with current permissions…");
    try {
      const result = await reopenModuleTextFieldSettings(captured.baseline.organizationId, captured.baseline.rootId);
      if (!isCurrent()) return;
      const reopened = result.kind === "available" ? responseDraft(result, captured.baseline) : null;
      if (reopened === null || result.kind !== "available" || reopened.draftRevision < captured.baseline.draftRevision ||
          (reopened.draftRevision === captured.baseline.draftRevision &&
            (reopened.sourceFingerprint !== captured.baseline.sourceFingerprint ||
              canonicalJson(reopened.source) !== canonicalJson(captured.baseline.source)))) {
        setMessage("The Module draft could not be reopened. Your pending value is preserved.");
        return;
      }
      replaceBuffer(reopened, result.fields, captured.selectedKey);
      setMessage(`Reopened persisted Module draft revision ${reopened.draftRevision}.`);
    } catch {
      if (isCurrent()) setMessage("The Module draft could not be reopened. Your pending value is preserved.");
    } finally {
      pending.current = false;
      if (active.current && mounted === lifetime.current) setBusy(false);
    }
  };

  return <main className="mx-auto max-w-3xl space-y-6 p-6" aria-busy={busy}>
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold">Module draft: {baseline.source.body.name}</h1>
      <dl className="break-all text-sm">
        <div><dt className="inline font-medium">Organization: </dt><dd className="inline">{baseline.organizationId}</dd></div>
        <div><dt className="inline font-medium">Module root: </dt><dd className="inline">{baseline.rootId}</dd></div>
        <div><dt className="inline font-medium">Module key: </dt><dd className="inline">{baseline.key}</dd></div>
        <div><dt className="inline font-medium">Module draft revision: </dt><dd className="inline">{baseline.draftRevision}</dd></div>
        <div><dt className="inline font-medium">Saved source fingerprint: </dt><dd className="inline">{baseline.sourceFingerprint}</dd></div>
      </dl>
      <p>Change one authored text field&apos;s maximum length. Save explicitly updates this Module&apos;s draft only.</p>
    </header>
    <form className="space-y-4" onSubmit={save}>
      <label className="block space-y-1"><span>Module text field</span>
        <select className={inputClass} value={selectedKey} disabled={busy || choices.length === 0} onChange={(event) => {
          if (pending.current) return;
          const next = choices.find((field) => selectionKey(field) === event.target.value);
          if (next === undefined || (dirty && !window.confirm("Discard the pending setting and select another field?"))) return;
          const nextKey = selectionKey(next);
          const nextValue = String(next.maxLength);
          buffer.current = { baseline, selectedKey: nextKey, maxLength: nextValue };
          generation.current += 1;
          setSelectedKey(nextKey);
          setMaxLength(nextValue);
          setValidation(null);
          setMessage("");
        }}>
          {choices.map((field) => <option key={selectionKey(field)} value={selectionKey(field)}>
            {field.recordName} / {field.label} ({field.recordAlias}.{field.fieldAlias})</option>)}
        </select>
      </label>
      {selected !== undefined ? <>
        <p className="break-all text-sm">Type: text. Current format: {selected.format ?? "none"}. Authored path: body.record_types[{selected.recordAlias}].fields[{selected.fieldAlias}].settings.max_length</p>
        <label className="block space-y-1"><span>Maximum length</span>
          <input className={inputClass} type="text" inputMode="numeric" value={maxLength}
            disabled={busy} aria-describedby="module-text-max-length-help" onChange={(event) => {
              if (pending.current) return;
              buffer.current = { ...buffer.current, maxLength: event.target.value };
              generation.current += 1;
              setMaxLength(event.target.value);
              setValidation(null);
              setMessage("");
            }} />
        </label>
        <p id="module-text-max-length-help" className="text-sm">Use a whole number supported by the current Module schema. The saved default and format are preserved and validated with this setting.</p>
      </> : <p role="status">No authored text field is available.</p>}
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} type="submit" disabled={busy || !dirty || selected === undefined}>Save text setting</button>
        <button className={buttonClass} type="button" disabled={busy} onClick={reopen}>Reopen saved Module draft</button>
      </div>
      <p role="status" aria-live="polite">{dirty ? "Pending text setting changes. " : "The setting matches the saved Module draft. "}{message}</p>
      {validation !== null ? <ul className="space-y-2" aria-label="Module validation feedback" role="alert">
        {validation.errors.map((error, index) => <li key={`${error.code}:${index}`}>
          <p>{error.message} {error.guidance}</p>
          <p className="break-all text-sm">{error.location?.documentKind}: {error.location?.documentKey}
            {error.location?.segments.map((segment) => ` / ${segment.kind}:${segment.key}`).join("")}</p>
        </li>)}
      </ul> : null}
    </form>
  </main>;
}
