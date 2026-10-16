"use client";
import { useEffect, useMemo, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import {
  DEFAULT_SHADCN_ICON_LIBRARY, isShadcnIconLibrary, VORTEX_ICON_NAMES, type ApplicationSourceDocument, type VortexIconName,
} from "@vortex/platform/schema";
import { Icon, IconLibraryProvider } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { cn } from "@vortex/ui/lib/utils";
import {
  studioMenuPageChoices, studioMenuPermissionChoices, studioMenuPosition,
  type StudioMenuCommand, type StudioMenuItem, type StudioMenuResult,
} from "../_lib/application-menu";
import { StudioPanelShell } from "./studio-frame";
import { StudioField } from "./studio-field";

type Feedback = Readonly<{ kind: "applied" | "refused"; message: string }>;

const kindWords = (item: StudioMenuItem) => item.type === "heading" ? "Heading" : item.type === "page" ? "Page" : "Link";

/**
 * The Menu tab: the application's navigation as an editable tree. An entry is selected with a
 * click, moved by dragging it onto another entry (onto a heading puts it under that heading) or with
 * Alt and the arrow keys, and changed in the form below the tree. Every change is one command on the
 * draft; a refusal is shown here and nothing changes.
 */
export function StudioMenuPanel({ source, selectedAlias, onSelect, onCommand, disabled, hidden }: Readonly<{
  source: ApplicationSourceDocument;
  selectedAlias: string | null;
  onSelect: (alias: string | null) => void;
  onCommand: (command: StudioMenuCommand) => StudioMenuResult;
  disabled: boolean;
  hidden: boolean;
}>) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [newPage, setNewPage] = useState("");
  const pages = useMemo(() => studioMenuPageChoices(source), [source]);
  const library = source.body.theme.selection.icon_library;

  const run = (command: StudioMenuCommand): boolean => {
    const result = onCommand(command);
    setFeedback({ kind: result.kind, message: result.message });
    return result.kind === "applied";
  };
  const selected = selectedAlias === null ? undefined : studioMenuPosition(source, selectedAlias);
  const selectedHeading = selected?.item.type === "heading" ? selected.item.id : selected?.headingAlias ?? null;

  const moveBy = (alias: string, key: string): boolean => {
    const position = studioMenuPosition(source, alias);
    if (position === undefined) return false;
    const { headingAlias, index, length, item } = position;
    if (key === "ArrowUp" && index > 0) return run({ kind: "move", alias, headingAlias, index: index - 1 });
    if (key === "ArrowDown" && index < length - 1) return run({ kind: "move", alias, headingAlias, index: index + 1 });
    if (key === "ArrowLeft" && headingAlias !== null) {
      const heading = studioMenuPosition(source, headingAlias)!;
      return run({ kind: "move", alias, headingAlias: null, index: heading.index + 1 });
    }
    if (key === "ArrowRight" && item.type !== "heading") {
      const siblings = headingAlias === null ? source.body.navigation : undefined;
      const previous = siblings?.[index - 1];
      if (previous?.type === "heading")
        return run({ kind: "move", alias, headingAlias: previous.id, index: previous.children.length });
    }
    setFeedback({ kind: "refused", message: key === "ArrowRight"
      ? "Alt and Right arrow puts an entry under the heading just above it; there is none."
      : "The entry is already at that end." });
    return false;
  };
  const keyMove = (event: KeyboardEvent<HTMLButtonElement>, alias: string) => {
    if (!event.altKey || disabled || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    moveBy(alias, event.key);
  };

  const drop = (event: DragEvent<HTMLElement>, target: StudioMenuItem | null) => {
    event.preventDefault();
    const alias = dragging ?? event.dataTransfer.getData("text/plain");
    setDragging(null); setDropTarget(null);
    if (disabled || alias.length === 0 || alias === target?.id) return;
    const moving = studioMenuPosition(source, alias);
    if (moving === undefined) return;
    if (target === null) { run({ kind: "move", alias, headingAlias: null, index: source.body.navigation.length }); return; }
    // Onto a heading: under it, at its end. Onto an entry: in its place, before it.
    if (target.type === "heading" && moving.item.type !== "heading") {
      run({ kind: "move", alias, headingAlias: target.id, index: target.children.length });
      return;
    }
    const at = studioMenuPosition(source, target.id)!;
    const shift = at.headingAlias === moving.headingAlias && moving.index < at.index ? 1 : 0;
    run({ kind: "move", alias, headingAlias: at.headingAlias, index: at.index - shift });
  };

  const row = (item: StudioMenuItem, depth: number) => {
    const isSelected = item.id === selectedAlias;
    const pageName = item.type === "page" ? source.body.pages.find((page) => page.key === item.page)?.name : undefined;
    return <li key={item.id} className="list-none">
      <button type="button" draggable={!disabled} disabled={disabled}
        aria-current={isSelected ? "true" : undefined}
        aria-description="Alt and the arrow keys move this entry."
        onClick={() => onSelect(item.id)} onKeyDown={(event) => keyMove(event, item.id)}
        onDragStart={(event) => { event.dataTransfer.setData("text/plain", item.id); event.dataTransfer.effectAllowed = "move"; setDragging(item.id); }}
        onDragEnd={() => { setDragging(null); setDropTarget(null); }}
        onDragOver={(event) => { if (dragging !== null && dragging !== item.id) { event.preventDefault(); setDropTarget(item.id); } }}
        onDragLeave={() => setDropTarget((current) => current === item.id ? null : current)}
        onDrop={(event) => drop(event, item)}
        style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
        className={cn("flex w-full items-center gap-2 rounded-md border border-transparent py-1.5 pr-2 text-left text-sm outline-none",
          "hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
          isSelected && "bg-accent text-accent-foreground",
          dropTarget === item.id && (item.type === "heading" ? "border-primary bg-primary/10" : "border-t-primary"),
          dragging === item.id && "opacity-50")}>
        <Icon name="more-vertical" className="size-3.5 shrink-0 text-muted-foreground" />
        <Icon name={item.icon} className="size-4 shrink-0" />
        <span className={cn("min-w-0 flex-1 truncate", item.type === "heading" && "font-medium")}>{item.label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{pageName ?? kindWords(item)}</span>
      </button>
      {item.type === "heading" && <ul className="space-y-0.5">{item.children.map((child) => row(child, depth + 1))}</ul>}
    </li>;
  };

  const addEntry = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPage.length === 0) { setFeedback({ kind: "refused", message: "Choose the page the new entry opens." }); return; }
    if (run({ kind: "add_entry", pageKey: newPage, headingAlias: selectedHeading })) setNewPage("");
  };

  return <StudioPanelShell title="Menu" hidden={hidden}
    description="The application's navigation. Changes show on the canvas at once; save to keep them.">
    <IconLibraryProvider library={isShadcnIconLibrary(library) ? library : DEFAULT_SHADCN_ICON_LIBRARY}>
      {!isShadcnIconLibrary(library) && <p role="alert" className="text-sm text-destructive">
        The theme names an icon library Studio does not offer, so icons here are drawn with Lucide. Choose an icon library in Theme.</p>}
      <form onSubmit={addEntry} className="flex items-end gap-2 border-b border-border pb-3" aria-label="New menu entry">
        <StudioField label={selectedHeading === null ? "Add an entry for a page" : "Add an entry under the selected heading"}>
          {(control) => <NativeSelect {...control} value={newPage} disabled={disabled} onChange={(event) => setNewPage(event.target.value)}>
            <NativeSelectOption value="">Choose a page</NativeSelectOption>
            {pages.map((page) => <NativeSelectOption key={page.key} value={page.key}>{page.label}</NativeSelectOption>)}
          </NativeSelect>}
        </StudioField>
        <Button type="submit" size="sm" disabled={disabled}>Add</Button>
      </form>
      {source.body.navigation.length === 0
        ? <p className="text-sm text-muted-foreground">This application has no menu entries yet.</p>
        : <ul aria-label="Menu entries" className="space-y-0.5">{source.body.navigation.map((item) => row(item, 0))}</ul>}
      {dragging !== null && <div onDragOver={(event) => { event.preventDefault(); setDropTarget("__end"); }}
        onDragLeave={() => setDropTarget(null)} onDrop={(event) => drop(event, null)}
        className={cn("rounded-md border border-dashed border-border p-2 text-center text-xs text-muted-foreground",
          dropTarget === "__end" && "border-primary text-foreground")}>Drop here to move it to the end of the menu</div>}
      {feedback !== null && <p role={feedback.kind === "refused" ? "alert" : "status"}
        className={feedback.kind === "refused" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{feedback.message}</p>}
      {selected !== undefined && <StudioMenuEntryEditor key={selected.item.id} source={source} item={selected.item}
        position={selected} disabled={disabled} run={run} moveBy={moveBy} />}
    </IconLibraryProvider>
  </StudioPanelShell>;
}

/** The selected entry's settings: label, icon, page, who can see it, where it sits, and removal. */
function StudioMenuEntryEditor({ source, item, position, disabled, run, moveBy }: Readonly<{
  source: ApplicationSourceDocument;
  item: StudioMenuItem;
  position: NonNullable<ReturnType<typeof studioMenuPosition>>;
  disabled: boolean;
  run: (command: StudioMenuCommand) => boolean;
  moveBy: (alias: string, key: string) => boolean;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const [label, setLabel] = useState(item.label);
  const [address, setAddress] = useState(item.type === "external" ? item.address : "");
  const [headingLabel, setHeadingLabel] = useState("");
  useEffect(() => { setLabel(item.label); }, [item.label]);
  const pages = useMemo(() => studioMenuPageChoices(source), [source]);
  const permissions = useMemo(() => studioMenuPermissionChoices(source), [source]);
  const headings = source.body.navigation.filter((entry) => entry.type === "heading");
  const permission = item.type === "heading" ? undefined : permissions.find((choice) => choice.key === item.permission);
  const change = (command: Extract<StudioMenuCommand, { kind: "change" }>) => run(command);
  const remove = async () => {
    if (!await confirm({
      title: `Remove “${item.label}” from the menu?`,
      description: item.type === "heading" ? "The heading goes; the entries under it stay in the menu." : "The page itself stays; only its menu entry goes. Undo brings it back until you save.",
      confirmLabel: "Remove entry",
    })) return;
    run({ kind: "remove", alias: item.id });
  };
  return <section aria-label={`Menu entry ${item.label}`} className="space-y-3 rounded-md border border-border p-3">
    <p className="text-sm font-medium">{kindWords(item)} “{item.label}”</p>
    <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); change({ kind: "change", alias: item.id, changes: { label } }); }}>
      <StudioField label="Label">
        {(control) => <Input {...control} value={label} maxLength={60} disabled={disabled} onChange={(event) => setLabel(event.target.value)} />}
      </StudioField>
      <Button type="submit" size="sm" disabled={disabled || label.trim().length === 0 || label.trim() === item.label}>Rename</Button>
    </form>
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">Icon</legend>
      <p className="text-xs text-muted-foreground">Drawn from the application&apos;s icon library, chosen in Theme.</p>
      <div role="radiogroup" aria-label="Icon" className="grid grid-cols-7 gap-1">
        {VORTEX_ICON_NAMES.map((name: VortexIconName) => <button key={name} type="button" role="radio" aria-checked={item.icon === name}
          aria-label={name.replaceAll("-", " ")} title={name.replaceAll("-", " ")} disabled={disabled}
          onClick={() => { if (item.icon !== name) change({ kind: "change", alias: item.id, changes: { icon: name } }); }}
          className={cn("flex aspect-square items-center justify-center rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring",
            item.icon === name ? "border-primary bg-accent" : "border-transparent hover:bg-accent")}>
          <Icon name={name} className="size-4" />
        </button>)}
      </div>
    </fieldset>
    {item.type === "page" && <StudioField label="Opens the page"
      error={pages.some((page) => page.key === item.page) ? undefined : "This entry's page is not in the application any more. Choose another page."}>
      {(control) => <NativeSelect {...control} value={item.page} disabled={disabled}
        onChange={(event) => change({ kind: "change", alias: item.id, changes: { page: event.target.value } })}>
        {pages.some((page) => page.key === item.page) ? null : <NativeSelectOption value={item.page}>Missing page</NativeSelectOption>}
        {pages.map((page) => <NativeSelectOption key={page.key} value={page.key}>{page.label}</NativeSelectOption>)}
      </NativeSelect>}
    </StudioField>}
    {item.type === "external" && <form className="flex items-end gap-2"
      onSubmit={(event) => { event.preventDefault(); change({ kind: "change", alias: item.id, changes: { address } }); }}>
      <StudioField label="Address">
        {(control) => <Input {...control} value={address} disabled={disabled} onChange={(event) => setAddress(event.target.value)} />}
      </StudioField>
      <Button type="submit" size="sm" disabled={disabled}>Set</Button>
    </form>}
    {item.type !== "heading" && <StudioField label="Who can see it"
      hint={permission === undefined ? undefined : permission.roles.length === 0
        ? "No role of this application holds this permission yet."
        : `Roles that see it: ${permission.roles.join(", ")}.`}
      error={permission === undefined ? "This entry names a permission the application does not declare. Choose who can see it." : undefined}>
      {(control) => <NativeSelect {...control} value={item.permission} disabled={disabled}
        onChange={(event) => change({ kind: "change", alias: item.id, changes: { permission: event.target.value } })}>
        {permission === undefined ? <NativeSelectOption value={item.permission}>Undeclared permission</NativeSelectOption> : null}
        {permissions.map((choice) => <NativeSelectOption key={choice.key} value={choice.key}>
          {choice.label}{choice.roles.length === 0 ? "" : ` (${choice.roles.join(", ")})`}</NativeSelectOption>)}
      </NativeSelect>}
    </StudioField>}
    {item.type === "heading" && <p className="text-xs text-muted-foreground">A heading shows when a person can see at least one entry under it.</p>}
    <div className="flex flex-wrap gap-2" role="group" aria-label="Move">
      <Button type="button" size="sm" variant="outline" disabled={disabled || position.index === 0} onClick={() => moveBy(item.id, "ArrowUp")}>
        <Icon name="arrow-up" />Up</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled || position.index >= position.length - 1}
        onClick={() => moveBy(item.id, "ArrowDown")}><Icon name="arrow-down" />Down</Button>
      {position.headingAlias !== null && <Button type="button" size="sm" variant="outline" disabled={disabled}
        onClick={() => moveBy(item.id, "ArrowLeft")}><Icon name="chevron-left" />Out of heading</Button>}
    </div>
    {item.type !== "heading" && headings.length > 0 && <StudioField label="Put under a heading">
      {(control) => <NativeSelect {...control} value={position.headingAlias ?? ""} disabled={disabled}
        onChange={(event) => {
          const target = headings.find((heading) => heading.id === event.target.value);
          run(target === undefined
            ? { kind: "move", alias: item.id, headingAlias: null, index: source.body.navigation.length }
            : { kind: "move", alias: item.id, headingAlias: target.id, index: target.type === "heading" ? target.children.length : 0 });
        }}>
        <NativeSelectOption value="">No heading (top level)</NativeSelectOption>
        {headings.map((heading) => <NativeSelectOption key={heading.id} value={heading.id}>{heading.label}</NativeSelectOption>)}
      </NativeSelect>}
    </StudioField>}
    {item.type !== "heading" && position.headingAlias === null && <form className="flex items-end gap-2"
      onSubmit={(event) => { event.preventDefault(); if (run({ kind: "add_heading", label: headingLabel, aroundAlias: item.id })) setHeadingLabel(""); }}>
      <StudioField label="Group under a new heading">
        {(control) => <Input {...control} value={headingLabel} maxLength={60} placeholder="Heading label" disabled={disabled}
          onChange={(event) => setHeadingLabel(event.target.value)} />}
      </StudioField>
      <Button type="submit" size="sm" variant="outline" disabled={disabled || headingLabel.trim().length === 0}>Group</Button>
    </form>}
    <Button type="button" size="sm" variant="destructive" disabled={disabled} onClick={() => { void remove(); }}>
      {item.type === "heading" ? "Remove heading" : "Remove entry"}</Button>
    {confirmDialog}
  </section>;
}
