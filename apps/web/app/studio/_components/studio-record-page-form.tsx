"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import {
  studioRecordPageChoices, studioRecordPageKinds, type StudioRecordPageCommand, type StudioRecordPageKind,
} from "@vortex/ui/studio";
import {
  studioStructureDefaultShell, studioStructureShellChoices, type StudioStructureResult,
} from "@vortex/ui/studio";
import { StudioField } from "./studio-field";

/**
 * "Add page for a record type": pick one of the application's own record types and a page kind,
 * read in plain words what the one edit will write (the page, its blocks, query, flows and
 * bindings, and the links to the record type's other pages), then add it. The preview is the
 * generator's own result on the current draft, so it is exactly what Add writes, or why it is refused.
 */
export function StudioRecordPageForm({ source, disabled, onPreview, onCommand, onClose }: Readonly<{
  source: ApplicationSourceDocument;
  disabled: boolean;
  /** Runs the command on the current draft without keeping it. */
  onPreview: (command: StudioRecordPageCommand) => StudioStructureResult;
  onCommand: (command: StudioRecordPageCommand) => boolean;
  onClose: () => void;
}>) {
  const recordTypes = useMemo(() => studioRecordPageChoices(source), [source]);
  const choices = useMemo(() => studioStructureShellChoices(source), [source]);
  const [recordType, setRecordType] = useState(recordTypes[0]?.recordType ?? "");
  const [kind, setKind] = useState<StudioRecordPageKind>("list");
  const [shellChoice, setShellChoice] = useState(studioStructureDefaultShell(source) ?? "");
  const [addToMenu, setAddToMenu] = useState(true);
  // A detail page or edit form opens one record, so it is never a menu entry; a list starts in the menu.
  const menuAllowed = kind === "list" || kind === "form_create" || kind === "guided";
  const chooseKind = (next: StudioRecordPageKind) => { setKind(next); setAddToMenu(next === "list"); };
  const effectiveRecordType = recordTypes.some((entry) => entry.recordType === recordType) ? recordType : recordTypes[0]?.recordType ?? "";
  const command = useMemo((): StudioRecordPageCommand => ({ kind: "add_record_page", recordType: effectiveRecordType, type: kind,
    shellAlias: shellChoice === "" ? null : shellChoice, addToMenu: menuAllowed && addToMenu }),
  [effectiveRecordType, kind, shellChoice, addToMenu, menuAllowed]);
  // The preview runs the generator on the draft a moment after the choices settle (an edited draft
  // is a new source), not on every change, and not on the callback's identity.
  const [preview, setPreview] = useState<Readonly<{ command: StudioRecordPageCommand; result: StudioStructureResult }> | undefined>();
  useEffect(() => {
    if (effectiveRecordType === "") return;
    const timer = setTimeout(() => setPreview({ command, result: onPreview(command) }), 250);
    return () => clearTimeout(timer);
  }, [source, command, effectiveRecordType]);
  const current = preview?.command === command ? preview.result : undefined;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (onCommand(command)) onClose();
  };

  if (recordTypes.length === 0)
    return <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm text-muted-foreground">This application owns no record types yet. Add one in Data, then come back.</p>
      <Button type="button" size="sm" variant="ghost" onClick={onClose}>Close</Button>
    </div>;

  return <form className="space-y-3 rounded-md border border-border p-3" onSubmit={submit} aria-label="New page for a record type">
    <StudioField label="Record type">
      {(control) => <NativeSelect {...control} value={effectiveRecordType} disabled={disabled}
        onChange={(event) => setRecordType(event.target.value)}>
        {recordTypes.map((entry) => <NativeSelectOption key={entry.recordType} value={entry.recordType}>{entry.label}</NativeSelectOption>)}
      </NativeSelect>}
    </StudioField>
    <StudioField label="Page" hint={studioRecordPageKinds.find((entry) => entry.kind === kind)?.hint}>
      {(control) => <NativeSelect {...control} value={kind} disabled={disabled}
        onChange={(event) => chooseKind(event.target.value as StudioRecordPageKind)}>
        {studioRecordPageKinds.map((entry) => <NativeSelectOption key={entry.kind} value={entry.kind}>{entry.label}</NativeSelectOption>)}
      </NativeSelect>}
    </StudioField>
    <StudioField label="Layout" hint="The frame the page is drawn in.">
      {(control) => <NativeSelect {...control} value={shellChoice} disabled={disabled}
        onChange={(event) => setShellChoice(event.target.value)}>
        {choices.map((choice) => <NativeSelectOption key={choice.shellAlias ?? ""} value={choice.shellAlias ?? ""}>
          {choice.label}</NativeSelectOption>)}
      </NativeSelect>}
    </StudioField>
    {menuAllowed
      ? <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={addToMenu} disabled={disabled} onCheckedChange={(checked) => setAddToMenu(checked === true)} />
        Show it in the menu
      </label>
      : <p className="text-sm text-muted-foreground">It opens one record, so it is reached from the list, not the menu.</p>}
    <section aria-label="What will be added" aria-busy={current === undefined} className="space-y-1 rounded-md bg-muted p-2">
      <p className="text-sm font-medium">What will be added</p>
      {current === undefined ? <p className="text-sm text-muted-foreground">Working it out…</p> : current.kind === "refused"
        ? <p role="alert" className="text-sm text-destructive">{current.message}</p>
        : <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
          {current.details.map((detail, index) => <li key={index}>{detail}</li>)}
        </ul>}
    </section>
    <div className="flex gap-2">
      <Button type="submit" size="sm" disabled={disabled || current?.kind !== "applied"}>Add page</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
    </div>
  </form>;
}
