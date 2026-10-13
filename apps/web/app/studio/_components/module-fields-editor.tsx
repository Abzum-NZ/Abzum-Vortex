"use client";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect } from "@vortex/ui/components/native-select";

import { useMemo, useState, type FormEvent } from "react";
import { sameId, storedModuleDefinitionDraftSchema, type DefinitionValidationResult } from "@vortex/platform/schema";
import type { StoredModuleDefinitionDraft } from "@web/platform-server";
import type { StudioModuleFieldChangeResult } from "../../_lib/studio-module-field-label";
import { deriveFieldKey, offeredFieldTypes } from "../../_lib/studio-module-field-shape";
import { reopenModuleFields, saveModuleFieldChange } from "../modules/[organizationId]/[moduleRootId]/fields/actions";

const typeLabel = (type: string) => type.replaceAll("_", " ");
const selectionValue = (recordAlias: string, fieldAlias: string) => JSON.stringify([recordAlias, fieldAlias]);

/** What each stable refusal code means for the builder; the code itself is always shown with it. */
const reasonText = (kind: "conflict" | "refused", reason: string) => {
  switch (reason) {
    case "DEFINITION_DRAFT_STALE_OR_MISSING":
      return "This Module draft was changed somewhere else since you opened it, so nothing was saved. Reload the saved draft and make the change again.";
    case "DEFINITION_ROOT_MISSING":
      return "This Module no longer exists in the organization, so nothing was saved.";
    case "DEFINITION_IDENTITY_ALIAS_CONFLICT":
      return "Another field already uses this internal identity, so nothing was saved. Reload the saved draft and try again.";
    case "INVALID_DEFINITION_COMMAND":
      return "The record type or field you selected is not in the saved draft any more, so nothing was saved. Reload the saved draft.";
    case "SESSION_NOT_ACTIVE":
      return "Your session is no longer active. Sign in again; nothing was saved.";
    default:
      return kind === "conflict"
        ? "The draft could not be changed because of a conflict, so nothing was saved."
        : "The platform refused this change, so nothing was saved.";
  }
};

export function ModuleFieldsEditor({ draft: baseline, onDraftChange: setBaseline }: {
  draft: StoredModuleDefinitionDraft;
  onDraftChange: (draft: StoredModuleDefinitionDraft) => void;
}) {
  const first = baseline.source.body.record_types[0];
  const [selected, setSelected] = useState(first === undefined ? "" : selectionValue(first.id, ""));
  const [label, setLabel] = useState("");
  const [type, setType] = useState("");
  const [required, setRequired] = useState(false);
  const [maxLength, setMaxLength] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [validation, setValidation] = useState<DefinitionValidationResult | null>(null);

  const offered = useMemo(() => offeredFieldTypes(baseline.source), [baseline.source]);
  const [recordAlias, fieldAlias] = selected === "" ? ["", ""] : (JSON.parse(selected) as [string, string]);
  const record = baseline.source.body.record_types.find((item) => item.id === recordAlias);
  const existing = record?.fields.find((item) => item.id === fieldAlias);
  const adding = existing === undefined;
  const typeChoices = existing !== undefined && !offered.some((item) => item.type === existing.type)
    ? [existing.type, ...offered.map((item) => item.type)] : offered.map((item) => item.type);
  const effectiveType = type === "" ? offered[0]?.type ?? "" : type;
  const needsMaxLength = existing?.type === effectiveType ? false : offered.find((item) => item.type === effectiveType)?.needsMaxLength === true;
  const nextKey = adding && record !== undefined && label.trim() !== ""
    ? deriveFieldKey(label, new Set(record.fields.map((item) => item.key))) : undefined;
  const dirty = existing === undefined ? label.trim() !== "" : label !== existing.label || effectiveType !== existing.type || required !== existing.required;

  const choose = (value: string) => {
    const [nextRecord, nextField] = JSON.parse(value) as [string, string];
    const target = baseline.source.body.record_types.find((item) => item.id === nextRecord)?.fields.find((item) => item.id === nextField);
    if (dirty && !window.confirm("Discard your unsaved field changes?")) return;
    setSelected(value);
    setLabel(target?.label ?? "");
    setType(target?.type ?? offered[0]?.type ?? "");
    setRequired(target?.required ?? false);
    setMaxLength("");
    setValidation(null);
    setMessage("");
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || record === undefined || !dirty) return;
    if (needsMaxLength && !/^\d+$/.test(maxLength.trim())) {
      setMessage("Enter the longest value this field may hold, as a whole number.");
      return;
    }
    setBusy(true);
    setValidation(null);
    setMessage("Saving to the Module draft…");
    try {
      const result: StudioModuleFieldChangeResult = await saveModuleFieldChange(baseline.organizationId, {
        rootId: baseline.rootId,
        expectedDraftRevision: baseline.draftRevision,
        expectedSavedSourceFingerprint: baseline.sourceFingerprint,
        recordAlias: record.id,
        ...(existing === undefined ? {} : { fieldAlias: existing.id }),
        label, type: effectiveType, required,
        ...(needsMaxLength ? { maxLength: Number(maxLength.trim()) } : {}),
      });
      if (result.kind === "available") {
        const saved = storedModuleDefinitionDraftSchema.safeParse(result.draft);
        if (!saved.success || !sameId(saved.data.rootId, baseline.rootId) || saved.data.draftRevision !== baseline.draftRevision + 1) {
          setMessage("The server's answer could not be matched to this draft. Reload the saved draft before you continue.");
          return;
        }
        const savedRecord = saved.data.source.body.record_types.find((item) => item.id === record.id);
        const savedField = existing === undefined ? savedRecord?.fields.at(-1) : savedRecord?.fields.find((item) => item.id === existing.id);
        setBaseline(saved.data);
        setSelected(selectionValue(record.id, savedField?.id ?? ""));
        setLabel(savedField?.label ?? "");
        setType(savedField?.type ?? "");
        setRequired(savedField?.required ?? false);
        setMaxLength("");
        setMessage(`Saved Module draft revision ${saved.data.draftRevision}. Publish the Module on its publish page to release it.`);
      } else if (result.kind === "validation_failed") {
        setValidation(result.validation);
        setMessage("The Module does not accept this change. Your entries are kept; correct them using the reasons below.");
      } else if (result.kind === "temporarily_unavailable") {
        setMessage("The change could not be saved because of a platform problem, not because of your permissions. Your entries are kept; try again in a moment.");
      } else setMessage(`${reasonText(result.kind, result.reason)} (${result.reason})`);
    } catch {
      setMessage("The change could not be saved because the request did not complete. Your entries are kept; try again in a moment.");
    } finally { setBusy(false); }
  };

  const reload = async () => {
    if (busy) return;
    if (dirty && !window.confirm("Discard your unsaved field changes and reload the saved draft?")) return;
    setBusy(true);
    try {
      const result = await reopenModuleFields(baseline.organizationId, baseline.rootId);
      if (result.kind !== "available") {
        setMessage("The saved draft could not be read. Your entries are kept; try again in a moment.");
        return;
      }
      setBaseline(result.draft);
      setSelected(result.draft.source.body.record_types[0] === undefined ? "" : selectionValue(result.draft.source.body.record_types[0].id, ""));
      setLabel(""); setType(""); setRequired(false); setMaxLength(""); setValidation(null);
      setMessage(`Reloaded saved Module draft revision ${result.draft.draftRevision}.`);
    } catch {
      setMessage("The saved draft could not be read because the request did not complete. Try again in a moment.");
    } finally { setBusy(false); }
  };

  return <section className="mx-auto max-w-3xl space-y-4 p-6" aria-busy={busy} aria-labelledby="module-fields-heading">
    <header className="space-y-1">
      <h1 id="module-fields-heading" className="text-2xl font-semibold">Fields of {baseline.source.body.name}</h1>
      <p className="text-sm text-muted-foreground">Draft revision {baseline.draftRevision}. Changes are saved into the draft; publish the Module to release them.</p>
    </header>
    {record === undefined ? <p role="status">This Module has no record types yet, so there is nothing to add a field to.</p> :
      <form className="space-y-4" onSubmit={save}>
        <div className="space-y-1">
          <Label htmlFor="module-field-selection">Field</Label>
          <NativeSelect id="module-field-selection" className="w-full" value={selected} disabled={busy} onChange={(event) => choose(event.target.value)}>
            {baseline.source.body.record_types.map((item) => <optgroup key={item.id} label={item.name}>
              <option value={selectionValue(item.id, "")}>Add a new field to {item.name}</option>
              {item.fields.map((field) => <option key={field.id} value={selectionValue(item.id, field.id)}>{field.label} ({typeLabel(field.type)})</option>)}
            </optgroup>)}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="module-field-label">Label</Label>
          <Input id="module-field-label" className="w-full" value={label} disabled={busy} onChange={(event) => { setLabel(event.target.value); setValidation(null); setMessage(""); }} />
          <p className="text-sm text-muted-foreground">{adding
            ? nextKey === undefined ? "The label is shown to people filling in the form. A short key is made from it when you save."
              : `Its stable key will be "${nextKey}" and cannot be changed later.`
            : `Stable key: ${existing.key}. It does not change when the label does.`}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="module-field-type">Type</Label>
          <NativeSelect id="module-field-type" className="w-full" value={effectiveType} disabled={busy} onChange={(event) => { setType(event.target.value); setValidation(null); setMessage(""); }}>
            {typeChoices.map((item) => <option key={item} value={item}>{typeLabel(item)}</option>)}
          </NativeSelect>
          {existing !== undefined && existing.type !== effectiveType ? <p className="text-sm text-muted-foreground">
            Changing the type replaces this field&apos;s type settings and removes its default value. The Module is checked before anything is saved.</p> : null}
        </div>
        {needsMaxLength ? <div className="space-y-1">
          <Label htmlFor="module-field-max-length">Longest value allowed</Label>
          <Input id="module-field-max-length" className="w-full" inputMode="numeric" value={maxLength} disabled={busy} onChange={(event) => setMaxLength(event.target.value)} />
          <p className="text-sm text-muted-foreground">The number of characters a person may enter.</p>
        </div> : null}
        <div className="flex items-center gap-2">
          <Checkbox id="module-field-required" checked={required} disabled={busy} onCheckedChange={(checked) => setRequired(checked === true)} />
          <Label htmlFor="module-field-required">A value is required</Label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !dirty}>{adding ? "Add field" : "Save field"}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={reload}>Reload saved draft</Button>
        </div>
        <p role="status" aria-live="polite">{message}</p>
        {validation !== null ? <ul className="space-y-2" aria-label="Why the Module refused this change" role="alert">
          {validation.errors.map((error, index) => <li key={`${error.code}:${index}`}>
            <p>{error.message} {error.guidance}</p>
            <p className="break-all text-sm text-muted-foreground">{error.code}{error.location?.segments.map((segment) => ` / ${segment.kind}:${segment.key}`).join("")}</p>
          </li>)}
        </ul> : null}
      </form>}
  </section>;
}
