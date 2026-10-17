"use client";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect } from "@vortex/ui/components/native-select";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { canonicalJson } from "@vortex/platform/schema";
import { studioPlacementLabels } from "../_lib/studio-labels";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import {
  describeStudioCompositionDestinations,
  describeStudioCompositionEdit,
  describeStudioCompositionRemoval,
  describeStudioCompositionSettings,
  studioSemanticSelectionKey,
  studioBlockChoices,
  studioSettingProblems,
  StudioQueryPicker,
  StudioSettingFields,
  type StudioCompositionBreakpoint,
  type StudioCompositionCommand,
  type StudioCompositionContext,
  type StudioCompositionLayout,
  type StudioCompositionOutcome,
  type StudioCompositionSettings,
  type StudioCompositionSettingsModel,
  type StudioSemanticSelection,
  type StudioSettingChoices,
} from "@vortex/ui/studio";

type Props = Readonly<{
  context: StudioCompositionContext;
  selection: StudioSemanticSelection;
  disabled: boolean;
  /** What reference settings can point at, read from the draft being edited. */
  choices: StudioSettingChoices;
  /** The one composition edit; `merge` joins a run of edits to one value into one Undo step. */
  onCommand: (expected: StudioCompositionContext, selection: StudioSemanticSelection,
    command: StudioCompositionCommand, merge?: string) => StudioCompositionOutcome;
}>;

type LayoutInputs = Readonly<{
  visible: boolean;
  width: "content" | "fill" | "grid";
  startColumn: string;
  span: string;
  height: "content" | "bounded";
  units: string;
}>;
const inputsFor = (layout: StudioCompositionLayout): LayoutInputs => ({
  visible: layout.visible, width: layout.width.kind,
  startColumn: layout.width.kind === "grid" ? String(layout.width.start_column) : "1",
  span: layout.width.kind === "grid" ? String(layout.width.span) : "12",
  height: layout.height.kind, units: layout.height.kind === "bounded" ? String(layout.height.units) : "1",
});
const columnNumber = (text: string): number | undefined => {
  const value = Number(text);
  return text.trim() !== "" && Number.isInteger(value) && value >= 1 && value <= 12 ? value : undefined;
};
/** The layout the inputs describe, or the problem that keeps them from the draft. */
const layoutOf = (inputs: LayoutInputs): Readonly<{ layout: StudioCompositionLayout } | { problem: string }> => {
  const start = columnNumber(inputs.startColumn);
  const span = columnNumber(inputs.span);
  const units = Number(inputs.units);
  if (inputs.width === "grid" && (start === undefined || span === undefined))
    return { problem: "Columns are whole numbers from 1 to 12." };
  if (inputs.height === "bounded" && (inputs.units.trim() === "" || !Number.isFinite(units) || units < 0))
    return { problem: "A fixed height is a number of zero or more." };
  return { layout: {
    visible: inputs.visible,
    width: inputs.width === "grid" ? { kind: "grid", start_column: start!, span: span! }
      : inputs.width === "content" ? { kind: "content" } : { kind: "fill" },
    height: inputs.height === "bounded" ? { kind: "bounded", units } : { kind: "content" },
  } as StudioCompositionLayout };
};
/** The settings form's input: the block's set settings and the query it reads. */
type SettingsInputs = Readonly<{ settings: StudioCompositionSettings; query: string | null }>;
const settingsInputsFor = (model: StudioCompositionSettingsModel): SettingsInputs =>
  model.kind === "available" ? { settings: model.settings, query: model.query } : { settings: {}, query: null };
const settingsKey = (inputs: SettingsInputs): string => canonicalJson({ settings: inputs.settings, query: inputs.query });
const fieldClass = "w-full";

/** Stable option key of a move destination: its closed descriptor, not a serialised object. */
const destinationOptionKey = (destination: { readonly kind: string; readonly parentAlias?: string; readonly slotKey?: string }): string =>
  destination.kind === "child"
    ? `child:${encodeURIComponent(destination.parentAlias ?? "")}:${encodeURIComponent(destination.slotKey ?? "")}`
    : destination.kind;

const outcomeText = (result: StudioCompositionOutcome, fallback: string): string =>
  result.kind === "stale" ? "The draft or your selection changed. Try again."
    : result.kind === "unsupported" ? "This item does not support that change."
      : result.reason ?? fallback;

/**
 * The selected item's settings, order, size and area. Every control edits the draft as it changes,
 * through the one composition command; input that is not valid yet stays here with its problem and
 * never reaches the draft. New blocks come from the Blocks panel's palette.
 */
export function ApplicationCompositionEditor(props: Props) {
  const [confirm, confirmDialog] = useConfirm();
  const [breakpoint, setBreakpoint] = useState<StudioCompositionBreakpoint>("desktop");
  const names = useMemo(() => studioPlacementLabels(props.context), [props.context]);
  const model = useMemo(() => describeStudioCompositionEdit(props.context, props.selection, breakpoint),
    [props.context, props.selection, breakpoint]);
  const moveModel = useMemo(() => describeStudioCompositionDestinations(props.context, props.selection),
    [props.context, props.selection]);
  const removalModel = useMemo(() => describeStudioCompositionRemoval(props.context, props.selection),
    [props.context, props.selection]);
  const settingsModel = useMemo(() => describeStudioCompositionSettings(props.context, props.selection),
    [props.context, props.selection]);
  const selectionKey = studioSemanticSelectionKey(props.selection);
  const draftSettings = settingsInputsFor(settingsModel);
  const draftSettingsKey = settingsKey(draftSettings);
  const draftLayout = model.kind === "available" ? inputsFor(model.layout) : null;
  const draftLayoutKey = draftLayout === null ? "" : JSON.stringify(draftLayout);
  // What the person typed that is not valid yet; null shows the draft's own value.
  const [settingsInput, setSettingsInput] = useState<Readonly<{ inputs: SettingsInputs; problems: readonly string[] }> | null>(null);
  const [layoutInput, setLayoutInput] = useState<Readonly<{ inputs: LayoutInputs; problem: string }> | null>(null);
  const [message, setMessage] = useState("");
  const titleId = useId();
  const hintId = useId();
  const settingsId = useId();

  // The draft changing under the input (Undo, Redo, another edit) or another item or screen size drops input that never applied.
  const shown = useRef({ selectionKey, breakpoint, draftSettingsKey, draftLayoutKey });
  useEffect(() => {
    const previous = shown.current;
    shown.current = { selectionKey, breakpoint, draftSettingsKey, draftLayoutKey };
    if (previous.selectionKey !== selectionKey || previous.draftSettingsKey !== draftSettingsKey) setSettingsInput(null);
    if (previous.selectionKey !== selectionKey || previous.breakpoint !== breakpoint || previous.draftLayoutKey !== draftLayoutKey)
      setLayoutInput(null);
    if (previous.selectionKey !== selectionKey) setMessage("");
  }, [selectionKey, breakpoint, draftSettingsKey, draftLayoutKey]);

  const settingsInputs = settingsInput?.inputs ?? draftSettings;
  // The reference settings point at the fields of the data the block reads, or, for a block that
  // reads none, at the application's own fields.
  const choices = useMemo(() => studioBlockChoices(props.choices, settingsInputs.query),
    [props.choices, settingsInputs.query]);

  if (model.kind !== "available" || draftLayout === null) return <section className="space-y-2 rounded-xl border bg-card text-card-foreground border-border p-4">
    <h3 className="font-semibold">Item order and size</h3>
    <p role="status">{model.kind === "unsupported"
      ? "This area uses an item type that cannot be edited here. Nothing was changed."
      : "This item is not in the current draft."}</p>
  </section>;

  const destinations = moveModel.kind === "available" ? moveModel.destinations : [];
  const inputs = layoutInput?.inputs ?? draftLayout;
  const orderEditable = breakpoint === "desktop" || model.responsiveOrder;
  const selectedIndex = model.order.indexOf(model.placementAlias);
  const command = (next: StudioCompositionCommand, merge?: string, done = "Changed."): boolean => {
    if (props.disabled) return false;
    const result = props.onCommand(props.context, props.selection, next, merge);
    setMessage(result.kind === "applied" ? done : outcomeText(result, "Nothing changed. Use a valid size, order or destination."));
    return result.kind === "applied";
  };
  const changeLayout = (next: LayoutInputs) => {
    const layout = layoutOf(next);
    if ("problem" in layout) { setLayoutInput({ inputs: next, problem: layout.problem }); return; }
    setLayoutInput(null);
    command({ kind: "resize", breakpoint, layout: layout.layout }, `size:${selectionKey}:${breakpoint}`, "Size changed.");
  };
  const changeSettings = (next: SettingsInputs) => {
    if (settingsModel.kind !== "available") return;
    const problems = [...(settingsModel.readsQuery && next.query === null ? ["Choose the data this block shows."] : []),
      ...studioSettingProblems(next.settings, settingsModel.properties)];
    if (problems.length > 0) { setSettingsInput({ inputs: next, problems }); return; }
    setSettingsInput(null);
    command({ kind: "settings", settings: next.settings, query: next.query }, `settings:${selectionKey}`, "Settings changed.");
  };
  const move = (direction: -1 | 1) => {
    if (!orderEditable || selectedIndex < 0) return;
    const nextIndex = selectedIndex + direction;
    if (nextIndex < 0 || nextIndex >= model.order.length) return;
    const next = [...model.order];
    const moved = next.splice(selectedIndex, 1)[0];
    if (moved === undefined) return;
    next.splice(nextIndex, 0, moved);
    command({ kind: "order", breakpoint, order: next }, undefined, "Order changed.");
  };
  const moveTo = (key: string) => {
    // Option values identify a current closed descriptor, never a source path or an array index.
    const chosen = destinations.find((item) => destinationOptionKey(item.destination) === key);
    if (chosen === undefined) { setMessage("This destination is no longer available."); return; }
    command({ kind: "move", destination: chosen.destination }, undefined, "Item moved.");
  };
  const remove = async () => {
    if (props.disabled || describeStudioCompositionRemoval(props.context, props.selection).kind !== "available") {
      setMessage("This item cannot be removed. Nothing was changed.");
      return;
    }
    const confirmed = await confirm({
      title: "Remove this item?",
      description: "The item is removed from your draft. Undo brings it back.",
      confirmLabel: "Remove item",
      cancelLabel: "Keep item",
      destructive: true,
    });
    if (confirmed) command({ kind: "remove" }, undefined, "Item removed.");
  };

  return <section className="space-y-4 rounded-xl border bg-card text-card-foreground border-border p-4" aria-labelledby={titleId}>
    {settingsModel.kind === "available" ? <section className="space-y-3" aria-label="Settings">
      <fieldset className="space-y-3" disabled={props.disabled}>
        <legend className="font-medium">Settings</legend>
        {settingsModel.readsQuery && <StudioQueryPicker id={`${settingsId}-query`} queries={props.choices.queries}
          value={settingsInputs.query ?? ""} disabled={props.disabled}
          onChange={(query) => changeSettings({ ...settingsInputs, query: query === "" ? null : query })} />}
        <StudioSettingFields idPrefix={settingsId} properties={settingsModel.properties} values={settingsInputs.settings}
          choices={choices} disabled={props.disabled}
          onChange={(settings) => changeSettings({ ...settingsInputs, settings })} />
      </fieldset>
      <p className="text-sm">A setting you leave unset uses its default.</p>
      {settingsInput !== null && <ul role="alert" className="list-disc pl-5 text-sm text-destructive">
        {settingsInput.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
    </section> : <p role="status">{settingsModel.kind === "unsupported"
      ? "This item's settings can't be changed here." : "This item's settings can't be read."}</p>}
    <h3 id={titleId} className="font-semibold">Order and size</h3>
    <p className="text-sm">{names.get(model.placementAlias) ?? "This item"}. This changes the layout in your draft; nothing runs.</p>
    <label className="block space-y-1"><span>Screen size</span>
      <NativeSelect className={fieldClass} value={breakpoint} disabled={props.disabled}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "desktop" || value === "tablet" || value === "phone") setBreakpoint(value);
        }}>
        <option value="desktop">Desktop</option><option value="tablet">Tablet</option><option value="phone">Phone</option>
      </NativeSelect></label>
    <fieldset className="space-y-2" disabled={props.disabled || !orderEditable} aria-describedby={hintId}>
      <legend className="font-medium">Order among its neighbours</legend>
      <ol className="list-decimal pl-6">{model.order.map((alias) => <li key={alias}
        aria-current={alias === model.placementAlias ? "true" : undefined}>{names.get(alias) ?? "Item"}</li>)}</ol>
      <div className="flex flex-wrap gap-2" onKeyDown={(event) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        move(event.key === "ArrowUp" ? -1 : 1);
      }}>
        <Button type="button" variant="outline" size="sm" disabled={selectedIndex <= 0} onClick={() => move(-1)}>Move earlier</Button>
        <Button type="button" variant="outline" size="sm" disabled={selectedIndex < 0 || selectedIndex >= model.order.length - 1}
          onClick={() => move(1)}>Move later</Button>
        {breakpoint !== "desktop" && <Button type="button" variant="outline" size="sm" disabled={!model.explicitOrder}
          onClick={() => { command({ kind: "order", breakpoint, order: null }, undefined, "Order changed."); }}>Use the larger screen&apos;s order</Button>}
      </div>
    </fieldset>
    <p id={hintId} className="text-sm">Use the buttons, or Alt+Up and Alt+Down. {breakpoint !== "desktop" && !model.responsiveOrder
      ? "This area uses one order at every screen size." : model.explicitOrder ? "This order is set for this screen size." : "This order is inherited from the larger screen size."}</p>
    <fieldset className="space-y-3" disabled={props.disabled}>
      <legend className="font-medium">Size</legend>
      <label className="flex items-center gap-2"><Checkbox checked={inputs.visible}
        disabled={!model.capabilities.responsiveVisibility}
        onCheckedChange={(checked) => changeLayout({ ...inputs, visible: checked })} />Shown at this screen size</label>
      <label className="block space-y-1"><span>Width</span>
        <NativeSelect className={fieldClass} value={inputs.width} onChange={(event) => {
          const width = event.target.value;
          if (width === "content" || width === "fill" || width === "grid") changeLayout({ ...inputs, width });
        }}><option value="content">Content</option><option value="fill">Fill</option>
          {model.capabilities.gridWidth && <option value="grid">Columns</option>}</NativeSelect></label>
      {inputs.width === "grid" && <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1"><span>Starts at column</span><Input className={fieldClass} type="number" required min={1} max={12} step={1}
          value={inputs.startColumn} onChange={(event) => changeLayout({ ...inputs, startColumn: event.target.value })} /></label>
        <label className="block space-y-1"><span>Number of columns</span><Input className={fieldClass} type="number" required min={1} max={12} step={1}
          value={inputs.span} onChange={(event) => changeLayout({ ...inputs, span: event.target.value })} /></label>
      </div>}
      <label className="block space-y-1"><span>Height</span>
        <NativeSelect className={fieldClass} value={inputs.height} onChange={(event) => {
          const height = event.target.value;
          if (height === "content" || height === "bounded") changeLayout({ ...inputs, height });
        }}><option value="content">Content</option>
          {model.capabilities.height === "content_or_bounded" && <option value="bounded">Fixed height</option>}</NativeSelect></label>
      {inputs.height === "bounded" && <label className="block space-y-1"><span>Height</span>
        <Input className={fieldClass} type="number" required min={0} step="any" value={inputs.units}
          onChange={(event) => changeLayout({ ...inputs, units: event.target.value })} /></label>}
    </fieldset>
    {layoutInput !== null && <p role="alert" className="text-sm text-destructive">{layoutInput.problem}</p>}
    <p className="text-sm">{model.explicitLayout ? "This size is set for this screen size." : "This size is inherited from the larger screen size."}</p>
    {breakpoint !== "desktop" && <Button type="button" variant="outline" size="sm" disabled={props.disabled || !model.explicitLayout}
      onClick={() => { command({ kind: "resize", breakpoint, layout: null }, undefined, "Size changed."); }}>Use the larger screen&apos;s size</Button>}
    <fieldset className="space-y-3" disabled={props.disabled || destinations.length === 0}>
      <legend className="font-medium">Move to another area</legend>
      <label className="block space-y-1"><span>Where to move it</span>
        <NativeSelect className={fieldClass} value="" onChange={(event) => { if (event.target.value !== "") moveTo(event.target.value); }}>
          <option value="">Choose a destination</option>
          {destinations.map((item) => <option key={destinationOptionKey(item.destination)}
            value={destinationOptionKey(item.destination)}>{item.destination.kind === "child"
              ? `${names.get(item.destination.parentAlias) ?? "Item"} / ${item.label.slice(item.label.indexOf(" / ") + 3)}`
              : item.label}</option>)}
        </NativeSelect></label>
      <p className="text-sm">Moves this item, with what is inside it, to the end of the area you choose on this page. Required content and nesting limits are checked first.</p>
      {destinations.length === 0 && <p role="status">{moveModel.kind === "unsupported"
        ? "Items can only be moved within the main area of an ordinary page."
        : "There is no other area this item can move to."}</p>}
    </fieldset>
    <section className="space-y-2" aria-label="Remove item">
      <p className="text-sm">Removes this item from the page. Flows and everything else stay as they are.</p>
      <Button type="button" variant="outline" size="sm"
        disabled={props.disabled || removalModel.kind !== "available"}
        onClick={() => { void remove(); }}>Remove item</Button>
      {removalModel.kind === "blocked" && <p role="status">{removalModel.reason === "required_slot"
        ? "This area needs at least this item."
        : removalModel.reason === "unresolved_target"
          ? "Something this item points to cannot be found. It cannot be removed."
          : "A flow still uses this item. It cannot be removed."}</p>}
      {(removalModel.kind === "invalid" || removalModel.kind === "unsupported") &&
        <p role="status">Only display items in the main area of a list, detail or dashboard page can be removed.</p>}
    </section>
    <p role="status" aria-live="polite">{message}</p>
    {confirmDialog}
  </section>;
}
