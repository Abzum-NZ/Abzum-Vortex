"use client";
import { useMemo, useState, type FormEvent } from "react";
import { sourcePageShell, type ApplicationSourceDocument, type ApplicationUsePlace } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import type { StudioSemanticSelection } from "@vortex/ui/studio";
import {
  studioStructureDefaultShell, studioStructureShellChoices, type StudioStructureCommand, type StudioStructureResult,
} from "@vortex/ui/studio";
import { studioAccessGateChoices } from "@vortex/ui/studio";
import { StudioField } from "./studio-field";
import { StudioRecordPageForm } from "./studio-record-page-form";
import { StudioReferencesAlert } from "./studio-used-in";
import { useStudioDraftText } from "./use-studio-draft-text";

type Feedback = Readonly<{ kind: "applied" | "refused"; message: string; where?: readonly ApplicationUsePlace[] | undefined }>;
type Form = "none" | "page" | "record" | "shell";

/**
 * The Structure tab's controls: add a page or a layout, and rename, remove or make home the page or
 * layout selected in the tree. Each control sends one command; a refusal is shown here, where it was
 * asked for, and nothing changes.
 */
export function StudioStructureEditor({ source, selected, disabled, onCommand, onPreview, onOpenAccess }: Readonly<{
  source: ApplicationSourceDocument;
  selected: StudioSemanticSelection | null;
  disabled: boolean;
  /** One Structure edit; `merge` joins a run of edits to one value (typing a name) into one Undo step. */
  onCommand: (command: StudioStructureCommand, merge?: string) => StudioStructureResult;
  /** Runs a command on the current draft without keeping it, for a preview of what it adds. */
  onPreview: (command: StudioStructureCommand) => StudioStructureResult;
  /** Opens the Access tab, where who can open a page is set. */
  onOpenAccess: () => void;
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
  const gate = page === undefined ? undefined : studioAccessGateChoices(source).find((choice) => choice.key === page.permission);
  const pageShell = page === undefined ? null : sourcePageShell(page.composition);

  const run = (command: StudioStructureCommand, merge?: string): boolean => {
    const result = onCommand(command, merge);
    setFeedback(result.kind === "refused" ? { kind: "refused", message: result.message, where: result.where }
      : { kind: "applied", message: result.message });
    return result.kind === "applied";
  };
  const openForm = (next: Form) => {
    setForm(next); setNewName(""); setFeedback(null); setAddToMenu(true);
    setShellChoice(studioStructureDefaultShell(source) ?? "");
  };
  const submitNew = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const applied = form === "page"
      ? run({ kind: "add_page", name: newName, shellAlias: shellChoice === "" ? null : shellChoice, addToMenu })
      : run({ kind: "add_shell", name: newName });
    if (applied) setForm("none");
  };
  const rename = useStudioDraftText(target?.name ?? "", (next) => next.trim().length === 0 ? `Enter a name for the ${what}.`
    : selected?.kind === "page" || selected?.kind === "shell"
      ? run({ kind: "rename", selection: selected, name: next }, `structure-name:${target?.id ?? ""}`) || "" : "");
  const remove = async () => {
    if (target === undefined) return;
    if (!await confirm({
      title: `Remove the ${what} “${target.name}”?`,
      description: page !== undefined
        ? "The page, its blocks and its menu entries leave the draft. Undo brings them back."
        : "The layout and its blocks leave the draft. Undo brings them back.",
      confirmLabel: `Remove ${what}`,
    })) return;
    run(page !== undefined ? { kind: "remove_page", pageAlias: page.id } : { kind: "remove_shell", shellAlias: shell!.id });
  };

  return <div className="space-y-3 border-b border-border pb-3">
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant={form === "page" ? "secondary" : "outline"} disabled={disabled}
        aria-expanded={form === "page"} onClick={() => openForm(form === "page" ? "none" : "page")}>Add page</Button>
      <Button type="button" size="sm" variant={form === "record" ? "secondary" : "outline"} disabled={disabled}
        aria-expanded={form === "record"} onClick={() => openForm(form === "record" ? "none" : "record")}>
        Add page for a record type</Button>
      <Button type="button" size="sm" variant={form === "shell" ? "secondary" : "outline"} disabled={disabled}
        aria-expanded={form === "shell"} onClick={() => openForm(form === "shell" ? "none" : "shell")}>Add layout</Button>
    </div>
    {form === "record" && <StudioRecordPageForm source={source} disabled={disabled} onPreview={onPreview}
      onCommand={(command) => run(command)} onClose={() => setForm("none")} />}
    {(form === "page" || form === "shell") && <form className="space-y-3 rounded-md border border-border p-3" onSubmit={submitNew}
      aria-label={form === "page" ? "New page" : "New layout"}>
      <StudioField label={form === "page" ? "Page name" : "Layout name"}>
        {(control) => <Input {...control} value={newName} maxLength={60} disabled={disabled} autoFocus
          onChange={(event) => setNewName(event.target.value)} />}
      </StudioField>
      {form === "page" && <>
        <StudioField label="Layout" hint="The frame the page is drawn in. People who can open the home page can open the new page.">
          {(control) => <NativeSelect {...control} value={shellChoice} disabled={disabled}
            onChange={(event) => setShellChoice(event.target.value)}>
            {choices.map((choice) => <NativeSelectOption key={choice.shellAlias ?? ""} value={choice.shellAlias ?? ""}>
              {choice.label}</NativeSelectOption>)}
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
    {target !== undefined && <section key={target.id} className="space-y-3 rounded-md border border-border p-3"
      aria-label={`Selected ${what}`}>
      <p className="text-sm font-medium">
        {page !== undefined ? "Selected page" : "Selected layout"}
        {page !== undefined && page.key === source.body.home_page && <span className="text-muted-foreground"> · home page</span>}
      </p>
      <StudioField label="Name" error={rename.problem === "" ? undefined : rename.problem}>
        {(control) => <Input {...control} value={rename.text} maxLength={60} disabled={disabled}
          onChange={(event) => rename.change(event.target.value)} />}
      </StudioField>
      <div className="flex flex-wrap gap-2">
        {page !== undefined && page.key !== source.body.home_page &&
          <Button type="button" size="sm" variant="outline" disabled={disabled}
            onClick={() => run({ kind: "set_home_page", pageAlias: page.id })}>Make home page</Button>}
        <Button type="button" size="sm" variant="destructive" disabled={disabled} onClick={() => { void remove(); }}>
          {page !== undefined ? "Remove page" : "Remove layout"}</Button>
      </div>
      {page !== undefined && <StudioField label="Layout" hint="Blocks move to the area of the same name in the new layout.">
        {(control) => <NativeSelect {...control} value={pageShell ?? ""} disabled={disabled}
          onChange={(event) => run({ kind: "move_page", pageAlias: page.id, shellAlias: event.target.value === "" ? null : event.target.value })}>
          {choices.map((choice) => <NativeSelectOption key={choice.shellAlias ?? ""} value={choice.shellAlias ?? ""}>
            {choice.label}</NativeSelectOption>)}
        </NativeSelect>}
      </StudioField>}
      {page !== undefined && <div className="space-y-1">
        <p className="text-sm font-medium">Who can open it</p>
        <p className="text-sm text-muted-foreground">{gate === undefined
          ? "This page names a permission the application does not declare."
          : `People who hold “${gate.label}”: ${gate.roles.length === 0 ? "no role holds it yet" : gate.roles.join(", ")}.`}</p>
        <Button type="button" size="sm" variant="outline" onClick={onOpenAccess}><Icon name="shield" />Change in Access</Button>
      </div>}
    </section>}
    {feedback?.where !== undefined && feedback.where.length > 0
      ? <StudioReferencesAlert name="it" title="Nothing was changed" issue={feedback.message} references={feedback.where} />
      : feedback !== null && <p role={feedback.kind === "refused" ? "alert" : "status"}
      className={feedback.kind === "refused" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
      {feedback.message}</p>}
    {confirmDialog}
  </div>;
}
