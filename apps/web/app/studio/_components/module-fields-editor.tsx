"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { StudioOptionControl } from "@vortex/ui/studio";
import {
  changeInlineModuleField, deriveFieldKey, offeredFieldTypes, type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import { StudioField } from "./studio-field";
import { fieldTypeLabel } from "../_lib/studio-data-model";

/** An application in this organisation, for the link to the owner of a used module. */
export type StudioModuleOwnerApplication = Readonly<{ key: string; rootId: string; name: string }>;

/**
 * One field of a record type of a module this application owns, or a new field of it, edited in the
 * application draft: the change is applied to the draft, and saved and published with the
 * application. What is edited is the workspace's one selection; this form holds only its input.
 */
export function ModuleFieldsEditor({ source, moduleKey, recordKey, fieldKey, disabled, onPendingChange, onApply, onApplied }: Readonly<{
  source: ApplicationSourceDocument;
  moduleKey: string;
  recordKey: string;
  /** The field to change; absent to add a new field. */
  fieldKey: string | undefined;
  disabled: boolean;
  /** Whether the form holds input that is not applied to the draft yet. */
  onPendingChange: (pending: boolean) => void;
  /** Applies the changed source to the draft history; false when the draft moved on meanwhile. */
  onApply: (expected: ApplicationSourceDocument, next: ApplicationSourceDocument) => boolean;
  /** Called with the key of the field the change applied to. */
  onApplied?: (fieldKey: string) => void;
}>) {
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const record = module?.record_types.find((item) => item.key === recordKey);
  const existing = fieldKey === undefined ? undefined : record?.fields.find((item) => item.key === fieldKey);
  const adding = existing === undefined;
  const [label, setLabel] = useState(existing?.label ?? "");
  const [type, setType] = useState(existing?.type ?? "");
  const [required, setRequired] = useState(existing?.required ?? false);
  const [maxLength, setMaxLength] = useState("");
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<readonly string[]>([]);

  const offered = useMemo(() => offeredFieldTypes(source, moduleKey), [source, moduleKey]);
  const typeChoices = existing !== undefined && !offered.some((item) => item.type === existing.type)
    ? [existing.type, ...offered.map((item) => item.type)] : offered.map((item) => item.type);
  const effectiveType = type === "" ? (existing?.type ?? offered[0]?.type ?? "") : type;
  const needsMaxLength = existing?.type === effectiveType ? false
    : offered.find((item) => item.type === effectiveType)?.needsMaxLength === true;
  const nextKey = adding && record !== undefined && label.trim() !== ""
    ? deriveFieldKey(label, new Set(record.fields.map((item) => item.key))) : undefined;
  const pending = existing === undefined ? label.trim() !== ""
    : label !== existing.label || effectiveType !== existing.type || required !== existing.required;
  useEffect(() => { onPendingChange(pending); }, [pending, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);

  if (module === undefined || record === undefined || (fieldKey !== undefined && existing === undefined))
    return <p role="status" className="text-sm">This field is not in the draft any more. Choose another item in the Data panel.</p>;

  const reset = () => {
    setLabel(existing?.label ?? ""); setType(existing?.type ?? ""); setRequired(existing?.required ?? false);
    setMaxLength(""); setIssues([]); setMessage("");
  };
  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !pending) return;
    if (needsMaxLength && !/^\d+$/.test(maxLength.trim())) {
      setMessage("Enter the longest value this field may hold, as a whole number.");
      return;
    }
    const result = changeInlineModuleField(source, {
      moduleKey, recordAlias: record.id,
      ...(existing === undefined ? {} : { fieldAlias: existing.id }),
      label, type: effectiveType, required,
      ...(needsMaxLength ? { maxLength: Number(maxLength.trim()) } : {}),
    });
    if (result.kind === "invalid") {
      setIssues(result.issues);
      setMessage("The field was not changed. Your entries are kept; correct them using the reasons below.");
      return;
    }
    if (!onApply(source, result.source)) {
      setMessage("The draft changed or is busy, so the field was not applied. Try again in a moment.");
      return;
    }
    const applied = result.source.body.modules.find((item) => item.key === moduleKey)
      ?.record_types.find((item) => item.id === record.id)?.fields.find((item) => item.id === result.fieldAlias);
    if (applied !== undefined) onApplied?.(applied.key);
  };

  return <form className="space-y-4" onSubmit={apply} aria-label={adding ? `New field of ${record.name}` : `Field ${existing.label}`}>
    <StudioField label="Label" hint={adding
      ? nextKey === undefined ? "The label people see on forms and lists. A short key is made from it."
        : `Its key will be "${nextKey}". It does not change later.`
      : `Key: ${existing.key}. It does not change when the label does.`}>
      {(control) => <Input {...control} className="w-full" value={label} disabled={disabled} maxLength={60}
        onChange={(event) => { setLabel(event.target.value); setIssues([]); setMessage(""); }} />}
    </StudioField>
    <StudioField label="Type" hint={existing !== undefined && existing.type !== effectiveType
      ? "Changing the type replaces this field's type settings and removes its default value." : undefined}>
      {(control) => <StudioOptionControl id={control.id} value={effectiveType} disabled={disabled}
        options={typeChoices.map((item) => ({ value: item, label: fieldTypeLabel(item) }))}
        onChange={(next) => { setType(next); setIssues([]); setMessage(""); }} />}
    </StudioField>
    {needsMaxLength ? <StudioField label="Longest value allowed" hint="The number of characters a person may enter.">
      {(control) => <Input {...control} className="w-full" inputMode="numeric" value={maxLength} disabled={disabled}
        onChange={(event) => setMaxLength(event.target.value)} />}
    </StudioField> : null}
    <div className="flex items-center gap-2">
      <Checkbox id="module-field-required" checked={required} disabled={disabled} onCheckedChange={(checked) => setRequired(checked === true)} />
      <Label htmlFor="module-field-required">A value is required</Label>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button type="submit" size="sm" disabled={disabled || !pending}>{adding ? "Add field" : "Apply"}</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled || !pending} onClick={reset}>Discard</Button>
    </div>
    <p role="status" aria-live="polite" className="text-sm">{message}</p>
    {issues.length === 0 ? null : <ul className="space-y-1 text-sm" aria-label="Why the field was not changed" role="alert">
      {issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}
    </ul>}
  </form>;
}
