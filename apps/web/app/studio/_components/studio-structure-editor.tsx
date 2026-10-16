"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import type { StudioSemanticSelection } from "@vortex/ui/studio";
import {
  studioStructureShellChoices, type StudioStructureCommand, type StudioStructureResult,
} from "../_lib/application-structure";
import { StudioField } from "./studio-field";

type Feedback = Readonly<{ kind: "applied" | "refused"; message: string }>;
type Form = "none" | "page" | "shell";

/**
 * The Structure tab's controls: add a page or a layout, and rename, remove or make home the page or
 * layout selected in the tree. Each control sends one command; a refusal is shown here, where it was
 * asked for, and nothing changes.
 */
export function StudioStructureEditor({ source, selected, disabled, onCommand }: Readonly<{
  source: ApplicationSourceDocument;
  selected: StudioSemanticSelection | null;
  disabled: boolean;
  onCommand: (command: StudioStructureCommand) => StudioStructureResult;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const [form, setForm] = useState<Form>("none");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [newName, setNewName] = useState("");
  const [shellChoice, setShellChoice] = useState("");
  const [addToMenu, setAddToMenu] = useState(true);
  const choices = useMemo(() => studioStructureShellChoices(source), [source]);

  const page = selected?.kind === "page" ? source.body.pages.find((entry) => entry.id === selected.pageAlias) : undefined;
  const shell = selected?.kind === "shell" ? source.body.shells.find((entry) => entry.id === selected.shellAlias) : undefined;
  const target = page ?? shell;
  const what = page !== undefined ? "page" : "layout";
  const [rename, setRename] = useState(target?.name ?? "");
  useEffect(() => { setRename(target?.name ?? ""); }, [target?.id, target?.name]);

  const run = (command: StudioStructureCommand): boolean => {
    const result = onCommand(command);
    setFeedback({ kind: result.kind, message: result.message });
    return result.kind === "applied";
  };
  const openForm = (next: Form) => {
    setForm(next); setNewName(""); setFeedback(null); setAddToMenu(true);
    setShellChoice(choices.find((choice) => choice.unavailable === undefined)?.shellAlias ?? "");
  };
  const submitNew = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const applied = form === "page"
      ? run({ kind: "add_page", name: newName, shellAlias: shellChoice === "" ? null : shellChoice, addToMenu })
      : run({ kind: "add_shell", name: newName });
    if (applied) setForm("none");
  };
  const submitRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected?.kind === "page" || selected?.kind === "shell") run({ kind: "rename", selection: selected, name: rename });
  };
  const remove = async () => {
    if (target === undefined) return;
    if (!await confirm({
      title: `Remove the ${what} “${target.name}”?`,
      description: page !== undefined
        ? "The page, its blocks and its menu entries leave the draft. Undo brings them back until you save."
        : "The layout and its blocks leave the draft. Undo brings them back until you save.",
      confirmLabel: `Remove ${what}`,
    })) return;
    run(page !== undefined ? { kind: "remove_page", pageAlias: page.id } : { kind: "remove_shell", shellAlias: shell!.id });
  };

  return <div className="space-y-3 border-b border-border pb-3">
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant={form === "page" ? "secondary" : "outline"} disabled={disabled}
        aria-expanded={form === "page"} onClick={() => openForm(form === "page" ? "none" : "page")}>Add page</Button>
      <Button type="button" size="sm" variant={form === "shell" ? "secondary" : "outline"} disabled={disabled}
        aria-expanded={form === "shell"} onClick={() => openForm(form === "shell" ? "none" : "shell")}>Add layout</Button>
    </div>
    {form !== "none" && <form className="space-y-3 rounded-md border border-border p-3" onSubmit={submitNew}
      aria-label={form === "page" ? "New page" : "New layout"}>
      <StudioField label={form === "page" ? "Page name" : "Layout name"}>
        {(control) => <Input {...control} value={newName} maxLength={60} disabled={disabled} autoFocus
          onChange={(event) => setNewName(event.target.value)} />}
      </StudioField>
      {form === "page" && <>
        <StudioField label="Layout" hint="The frame the page is drawn in. People who can open the home page can open the new page.">
          {(control) => <NativeSelect {...control} value={shellChoice} disabled={disabled}
            onChange={(event) => setShellChoice(event.target.value)}>
            {choices.map((choice) => <NativeSelectOption key={choice.shellAlias ?? ""} value={choice.shellAlias ?? ""}
              disabled={choice.unavailable !== undefined}>
              {choice.unavailable === undefined ? choice.label : `${choice.label} (${choice.unavailable})`}
            </NativeSelectOption>)}
          </NativeSelect>}
        </StudioField>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={addToMenu} disabled={disabled} onCheckedChange={(checked) => setAddToMenu(checked === true)} />
          Show it in the menu
        </label>
      </>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={disabled || newName.trim().length === 0}>
          {form === "page" ? "Add page" : "Add layout"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setForm("none")}>Cancel</Button>
      </div>
    </form>}
    {target !== undefined && <form className="space-y-3 rounded-md border border-border p-3" onSubmit={submitRename}
      aria-label={`Selected ${what}`}>
      <p className="text-sm font-medium">
        {page !== undefined ? "Selected page" : "Selected layout"}
        {page !== undefined && page.key === source.body.home_page && <span className="text-muted-foreground"> · home page</span>}
      </p>
      <StudioField label="Name">
        {(control) => <Input {...control} value={rename} maxLength={60} disabled={disabled}
          onChange={(event) => setRename(event.target.value)} />}
      </StudioField>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={disabled || rename.trim().length === 0 || rename.trim() === target.name}>Rename</Button>
        {page !== undefined && page.key !== source.body.home_page &&
          <Button type="button" size="sm" variant="outline" disabled={disabled}
            onClick={() => run({ kind: "set_home_page", pageAlias: page.id })}>Make home page</Button>}
        <Button type="button" size="sm" variant="destructive" disabled={disabled} onClick={() => { void remove(); }}>
          {page !== undefined ? "Remove page" : "Remove layout"}</Button>
      </div>
    </form>}
    {feedback !== null && <p role={feedback.kind === "refused" ? "alert" : "status"}
      className={feedback.kind === "refused" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
      {feedback.message}</p>}
    {confirmDialog}
  </div>;
}
