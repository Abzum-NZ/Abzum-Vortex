"use client";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect } from "@vortex/ui/components/native-select";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import {
  changeInlineModuleField, deriveFieldKey, offeredFieldTypes, type ApplicationSourceDocument,
} from "@vortex/platform/schema";

const typeLabel = (type: string) => type.replaceAll("_", " ");
const selectionValue = (recordAlias: string, fieldAlias: string) => JSON.stringify([recordAlias, fieldAlias]);

/** An application in this organisation, for the link to the owner of a used module. */
export type StudioModuleOwnerApplication = Readonly<{ key: string; rootId: string; name: string }>;

/**
 * The open module in the Data tab. A module this application owns is edited in the application
 * draft: a field change is applied to the draft, and saved and published with the application. A
 * module used from another application is read-only here and is changed in its owner's Studio.
 */
export function ModuleFieldsEditor({ organizationId, source, moduleKey, applications, disabled, onPendingChange, onApply }: Readonly<{
  organizationId: string;
  source: ApplicationSourceDocument;
  moduleKey: string;
  applications: readonly StudioModuleOwnerApplication[];
  disabled: boolean;
  /** Whether the form holds input that is not applied to the draft yet. */
  onPendingChange: (pending: boolean) => void;
  /** Applies the changed source to the draft history; false when the draft moved on meanwhile. */
  onApply: (expected: ApplicationSourceDocument, next: ApplicationSourceDocument) => boolean;
}>) {
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const use = source.body.uses.find((item) => item.module === moduleKey);
  if (module === undefined) {
    const owner = applications.find((application) => application.key === use?.application);
    return <section className="mx-auto max-w-3xl space-y-3 p-6" aria-labelledby="module-read-only-heading">
      <h1 id="module-read-only-heading" className="text-2xl font-semibold">{moduleKey}</h1>
      {use === undefined
        ? <p role="status">This application does not own or use this module any more.</p>
        : <p role="note" className="rounded-md border border-border bg-card p-3 text-sm text-card-foreground">
          This module is owned by {owner?.name ?? use.application}. It is read-only here: change it in
          its owner&apos;s Studio, publish the owner, and then publish this application to use the new version.
          {owner === undefined ? null : <> <Link className="underline underline-offset-4"
            href={`/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(owner.rootId)}?tab=data&module=${encodeURIComponent(moduleKey)}`}>
            Open {owner.name} in Studio</Link></>}
        </p>}
    </section>;
  }
  return <OwnedModuleFieldsEditor source={source} module={module} disabled={disabled}
    onPendingChange={onPendingChange} onApply={onApply} />;
}

function OwnedModuleFieldsEditor({ source, module, disabled, onPendingChange, onApply }: Readonly<{
  source: ApplicationSourceDocument;
  module: ApplicationSourceDocument["body"]["modules"][number];
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onApply: (expected: ApplicationSourceDocument, next: ApplicationSourceDocument) => boolean;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const first = module.record_types[0];
  const [selected, setSelected] = useState(first === undefined ? "" : selectionValue(first.id, ""));
  const [label, setLabel] = useState("");
  const [type, setType] = useState("");
  const [required, setRequired] = useState(false);
  const [maxLength, setMaxLength] = useState("");
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<readonly string[]>([]);

  const offered = useMemo(() => offeredFieldTypes(source, module.key), [source, module.key]);
  const [recordAlias, fieldAlias] = selected === "" ? ["", ""] : (JSON.parse(selected) as [string, string]);
  const record = module.record_types.find((item) => item.id === recordAlias);
  const existing = record?.fields.find((item) => item.id === fieldAlias);
  const adding = existing === undefined;
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

  const load = (value: string) => {
    const [nextRecord, nextField] = JSON.parse(value) as [string, string];
    const target = module.record_types.find((item) => item.id === nextRecord)?.fields.find((item) => item.id === nextField);
    setSelected(value);
    setLabel(target?.label ?? "");
    setType(target?.type ?? "");
    setRequired(target?.required ?? false);
    setMaxLength("");
    setIssues([]);
  };

  const choose = async (value: string) => {
    if (pending && !await confirm({
      title: "Select another field?",
      description: "Discard the field change you have not applied?",
      confirmLabel: "Discard changes",
    })) return;
    load(value);
    setMessage("");
  };

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || record === undefined || !pending) return;
    if (needsMaxLength && !/^\d+$/.test(maxLength.trim())) {
      setMessage("Enter the longest value this field may hold, as a whole number.");
      return;
    }
    const result = changeInlineModuleField(source, {
      moduleKey: module.key, recordAlias: record.id,
      ...(existing === undefined ? {} : { fieldAlias: existing.id }),
      label, type: effectiveType, required,
      ...(needsMaxLength ? { maxLength: Number(maxLength.trim()) } : {}),
    });
    if (result.kind === "invalid") {
      setIssues(result.issues);
      setMessage("The module does not accept this change. Your entries are kept; correct them using the reasons below.");
      return;
    }
    if (!onApply(source, result.source)) {
      setMessage("The draft changed or is busy, so the field was not applied. Try again in a moment.");
      return;
    }
    const value = selectionValue(record.id, result.fieldAlias);
    const applied = result.source.body.modules.find((item) => item.key === module.key)
      ?.record_types.find((item) => item.id === record.id)?.fields.find((item) => item.id === result.fieldAlias);
    setSelected(value);
    setLabel(applied?.label ?? "");
    setType(applied?.type ?? "");
    setRequired(applied?.required ?? false);
    setMaxLength("");
    setIssues([]);
    setMessage(`${adding ? "Field added to" : "Field changed in"} the draft. Save to keep it; it is published with the application.`);
  };

  return <section className="mx-auto max-w-3xl space-y-4 p-6" aria-labelledby="module-fields-heading">
    <header className="space-y-1">
      <h1 id="module-fields-heading" className="text-2xl font-semibold">Fields of {module.name}</h1>
      <p className="text-sm text-muted-foreground">This module is part of the application draft. Changes are saved and published with the application.</p>
    </header>
    {record === undefined && module.record_types.length === 0
      ? <p role="status">This module has no record types yet, so there is nothing to add a field to.</p> :
      <form className="space-y-4" onSubmit={apply}>
        <div className="space-y-1">
          <Label htmlFor="module-field-selection">Field</Label>
          <NativeSelect id="module-field-selection" className="w-full" value={selected} disabled={disabled}
            onChange={(event) => { void choose(event.target.value); }}>
            {module.record_types.map((item) => <optgroup key={item.id} label={item.name}>
              <option value={selectionValue(item.id, "")}>Add a new field to {item.name}</option>
              {item.fields.map((field) => <option key={field.id} value={selectionValue(item.id, field.id)}>{field.label} ({typeLabel(field.type)})</option>)}
            </optgroup>)}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="module-field-label">Label</Label>
          <Input id="module-field-label" className="w-full" value={label} disabled={disabled}
            onChange={(event) => { setLabel(event.target.value); setIssues([]); setMessage(""); }} />
          <p className="text-sm text-muted-foreground">{adding
            ? nextKey === undefined ? "The label is shown to people filling in the form. A short key is made from it."
              : `Its stable key will be "${nextKey}" and cannot be changed later.`
            : `Stable key: ${existing.key}. It does not change when the label does.`}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="module-field-type">Type</Label>
          <NativeSelect id="module-field-type" className="w-full" value={effectiveType} disabled={disabled}
            onChange={(event) => { setType(event.target.value); setIssues([]); setMessage(""); }}>
            {typeChoices.map((item) => <option key={item} value={item}>{typeLabel(item)}</option>)}
          </NativeSelect>
          {existing !== undefined && existing.type !== effectiveType ? <p className="text-sm text-muted-foreground">
            Changing the type replaces this field&apos;s type settings and removes its default value.</p> : null}
        </div>
        {needsMaxLength ? <div className="space-y-1">
          <Label htmlFor="module-field-max-length">Longest value allowed</Label>
          <Input id="module-field-max-length" className="w-full" inputMode="numeric" value={maxLength} disabled={disabled}
            onChange={(event) => setMaxLength(event.target.value)} />
          <p className="text-sm text-muted-foreground">The number of characters a person may enter.</p>
        </div> : null}
        <div className="flex items-center gap-2">
          <Checkbox id="module-field-required" checked={required} disabled={disabled} onCheckedChange={(checked) => setRequired(checked === true)} />
          <Label htmlFor="module-field-required">A value is required</Label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={disabled || !pending}>{adding ? "Add field" : "Apply change"}</Button>
          <Button type="button" variant="outline" disabled={disabled || !pending} onClick={() => { load(selected); setMessage(""); }}>Discard</Button>
        </div>
        <p role="status" aria-live="polite">{message}</p>
        {issues.length === 0 ? null : <ul className="space-y-1 text-sm" aria-label="Why the module refused this change" role="alert">
          {issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}
        </ul>}
      </form>}
    {confirmDialog}
  </section>;
}
