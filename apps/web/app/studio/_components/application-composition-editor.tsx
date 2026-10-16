"use client";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect } from "@vortex/ui/components/native-select";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
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
  onPendingChange: (pending: boolean) => void;
  onCommand: (expected: StudioCompositionContext, selection: StudioSemanticSelection,
    command: StudioCompositionCommand) => StudioCompositionOutcome;
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
const sameInputs = (left: LayoutInputs, right: LayoutInputs): boolean =>
  left.visible === right.visible && left.width === right.width && left.height === right.height &&
  (left.width !== "grid" || (left.startColumn === right.startColumn && left.span === right.span)) &&
  (left.height !== "bounded" || left.units === right.units);
/** The settings form's input: the block's set settings and the query it reads. */
type SettingsInputs = Readonly<{ settings: StudioCompositionSettings; query: string | null }>;
const settingsInputsFor = (model: StudioCompositionSettingsModel): SettingsInputs =>
  model.kind === "available" ? { settings: model.settings, query: model.query } : { settings: {}, query: null };
const sameSettingsInputs = (left: SettingsInputs, right: SettingsInputs): boolean =>
  left.query === right.query && canonicalJson(left.settings) === canonicalJson(right.settings);
const fieldClass = "w-full";

/** Stable option key of a move destination: its closed descriptor, not a serialised object. */
const destinationOptionKey = (destination: { readonly kind: string; readonly parentAlias?: string; readonly slotKey?: string }): string =>
  destination.kind === "child"
    ? `child:${encodeURIComponent(destination.parentAlias ?? "")}:${encodeURIComponent(destination.slotKey ?? "")}`
    : destination.kind;

/**
 * Controls edit the native source through the same command for pointer and keyboard. New blocks
 * come from the Blocks panel's palette, which adds them through the add command.
 */
export function ApplicationCompositionEditor(props: Props) {
  return <PlacementCompositionEditor {...props} />;
}

function PlacementCompositionEditor(props: Props) {
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
  const [settingsInputs, setSettingsInputs] = useState<SettingsInputs>(() => settingsInputsFor(settingsModel));
  const settingsPending = useRef(false);
  const settingsContext = useRef(props.context);
  const selectionKey = studioSemanticSelectionKey(props.selection);
  const settingsSelection = useRef(selectionKey);
  const destinations = moveModel.kind === "available" ? moveModel.destinations : [];
  const [destinationKey, setDestinationKey] = useState("");
  const movePending = useRef(false);
  const [inputs, setInputs] = useState<LayoutInputs | null>(() =>
    model.kind === "available" ? inputsFor(model.layout) : null);
  const pending = useRef(false);
  const formContext = useRef(props.context);
  const formBreakpoint = useRef(breakpoint);
  const [message, setMessage] = useState("");
  const titleId = useId();
  const hintId = useId();
  const settingsId = useId();

  // Only an accepted history source/selection/breakpoint change resets the form.
  // A failed or cancelled reopen leaves this exact context and these inputs intact.
  useEffect(() => {
    setInputs(model.kind === "available" ? inputsFor(model.layout) : null);
    formContext.current = props.context;
    formBreakpoint.current = breakpoint;
    pending.current = false;
    movePending.current = false;
    setDestinationKey("");
    props.onPendingChange(settingsPending.current);
    setMessage("");
  }, [model, props.context, breakpoint, props.onPendingChange]);

  // Settings have no breakpoint buffer. Disabled/Save/Reopen changes do
  // not reset inputs; only an accepted source/lifetime/selection resets them.
  useEffect(() => {
    if (settingsContext.current === props.context && settingsSelection.current === selectionKey) return;
    setSettingsInputs(settingsInputsFor(settingsModel));
    settingsContext.current = props.context;
    settingsSelection.current = selectionKey;
    settingsPending.current = false;
    props.onPendingChange(pending.current || movePending.current);
  }, [settingsModel, props.context, selectionKey, props.onPendingChange]);

  // The reference settings point at the fields of the data the block reads, or, for a block that
  // reads none, at the application's own fields.
  const choices = useMemo(() => studioBlockChoices(props.choices, settingsInputs.query),
    [props.choices, settingsInputs.query]);

  if (model.kind !== "available" || inputs === null) return <section className="space-y-2 rounded-xl border bg-card text-card-foreground border-border p-4">
    <h3 className="font-semibold">Item order and size</h3>
    <p role="status">{model.kind === "unsupported"
      ? "This area uses an item type that cannot be edited here. Nothing was changed."
      : "This item is not in the current draft."}</p>
  </section>;

  const baseline = inputsFor(model.layout);
  const dirty = !sameInputs(inputs, baseline);
  const moveDirty = destinationKey !== "";
  const settingsDirty = settingsModel.kind === "available" &&
    !sameSettingsInputs(settingsInputs, settingsInputsFor(settingsModel));
  const orderEditable = breakpoint === "desktop" || model.responsiveOrder;
  const selectedIndex = model.order.indexOf(model.placementAlias);
  const update = (next: LayoutInputs) => {
    if (props.disabled || movePending.current || settingsPending.current || formContext.current !== props.context || formBreakpoint.current !== breakpoint) return;
    const changed = !sameInputs(next, baseline);
    pending.current = changed;
    props.onPendingChange(changed || movePending.current || settingsPending.current);
    setInputs(next);
    setMessage("");
  };
  const run = async (command: StudioCompositionCommand) => {
    if (props.disabled || settingsPending.current) return;
    if (command.kind === "remove" && (pending.current || movePending.current)) return;
    if (command.kind === "move" ? pending.current : movePending.current) return;
    if (formContext.current !== props.context || formBreakpoint.current !== breakpoint) {
      setMessage("The draft changed. Wait a moment, then try again.");
      return;
    }
    const expected = formContext.current;
    const expectedSelection = props.selection;
    if (command.kind === "remove") {
      const removal = describeStudioCompositionRemoval(expected, expectedSelection);
      if (removal.kind !== "available") {
        setMessage("This item cannot be removed. Nothing was changed.");
        return;
      }
      const confirmed = await confirm({
        title: "Remove this item?",
        description: "The item is removed from your draft. Save keeps the change.",
        confirmLabel: "Remove item",
        cancelLabel: "Keep item",
        destructive: true,
      });
      if (!confirmed) return;
      if (props.disabled || pending.current || movePending.current || settingsPending.current || formContext.current !== expected ||
        formBreakpoint.current !== breakpoint) {
        setMessage("The draft or your input changed. Nothing was removed.");
        return;
      }
    }
    const result = props.onCommand(expected, expectedSelection, command);
    if (result.kind === "applied") {
      pending.current = false;
      movePending.current = false;
      setDestinationKey("");
      props.onPendingChange(settingsPending.current);
      setInputs(baseline);
      setMessage("Change made. Save to keep it.");
    } else setMessage(result.kind === "stale" ? "The draft or your selection changed. What you typed is kept."
      : result.kind === "unsupported" ? "This item does not support that change. What you typed is kept."
        : result.reason ?? "Nothing changed. Use a valid size, order or destination.");
  };
  const move = (direction: -1 | 1) => {
    if (pending.current || movePending.current || settingsPending.current || !orderEditable || selectedIndex < 0) return;
    const nextIndex = selectedIndex + direction;
    if (nextIndex < 0 || nextIndex >= model.order.length) return;
    const next = [...model.order];
    const moved = next.splice(selectedIndex, 1)[0];
    if (moved === undefined) return;
    next.splice(nextIndex, 0, moved);
    void run({ kind: "order", breakpoint, order: next });
  };
  const applySize = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pending.current) return;
    void run({ kind: "resize", breakpoint, layout: {
      visible: inputs.visible,
      width: inputs.width === "grid"
        ? { kind: "grid", start_column: Number(inputs.startColumn), span: Number(inputs.span) }
        : inputs.width === "content" ? { kind: "content" } : { kind: "fill" },
      height: inputs.height === "bounded"
        ? { kind: "bounded", units: Number(inputs.units) } : { kind: "content" },
    } });
  };
  const applyDestination = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!movePending.current || pending.current) return;
    // Option values identify a current closed descriptor, never a source path or
    // an array index. The pure command resolves it again against its snapshot.
    const chosen = destinations.find((item) => destinationOptionKey(item.destination) === destinationKey);
    if (chosen === undefined) {
      setMessage("This destination is no longer available. What you typed is kept.");
      return;
    }
    void run({ kind: "move", destination: chosen.destination });
  };

  const updateSettings = (next: SettingsInputs) => {
    if (props.disabled || pending.current || movePending.current || settingsModel.kind !== "available" ||
      settingsContext.current !== props.context || settingsSelection.current !== selectionKey) return;
    settingsPending.current = !sameSettingsInputs(next, settingsInputsFor(settingsModel));
    props.onPendingChange(settingsPending.current || pending.current || movePending.current);
    setSettingsInputs(next);
    setMessage("");
  };
  const applySettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (props.disabled || !settingsPending.current || pending.current || movePending.current ||
      settingsModel.kind !== "available") return;
    const expected = settingsContext.current;
    const expectedSelection = props.selection;
    if (expected !== props.context || settingsSelection.current !== selectionKey ||
      describeStudioCompositionSettings(expected, expectedSelection).kind !== "available") {
      setMessage("The draft or your selection changed. What you typed is kept.");
      return;
    }
    if (settingsModel.readsQuery && settingsInputs.query === null) {
      setMessage("Choose the data this block shows. What you typed is kept.");
      return;
    }
    const problems = studioSettingProblems(settingsInputs.settings, settingsModel.properties);
    if (problems.length > 0) {
      setMessage(`${problems.join(" ")} What you typed is kept.`);
      return;
    }
    const result = props.onCommand(expected, expectedSelection,
      { kind: "settings", settings: settingsInputs.settings, query: settingsInputs.query });
    if (result.kind === "applied") {
      settingsPending.current = false;
      props.onPendingChange(pending.current || movePending.current);
      setMessage("Settings changed. Save to keep them.");
    } else setMessage(result.kind === "stale" ? "The draft or your selection changed. What you typed is kept."
      : result.kind === "unsupported" ? "This item's settings can't be changed here. What you typed is kept."
        : `${result.reason ?? "Nothing changed. Enter valid values and fill the required settings."} What you typed is kept.`);
  };

  return <section className="space-y-4 rounded-xl border bg-card text-card-foreground border-border p-4" aria-labelledby={titleId}>
    {settingsModel.kind === "available" ? <form className="space-y-3" onSubmit={applySettings} aria-label="Settings">
      <fieldset className="space-y-3" disabled={props.disabled || dirty || moveDirty}>
        <legend className="font-medium">Settings</legend>
        {settingsModel.readsQuery && <StudioQueryPicker id={`${settingsId}-query`} queries={props.choices.queries}
          value={settingsInputs.query ?? ""} disabled={props.disabled || dirty || moveDirty}
          onChange={(query) => updateSettings({ ...settingsInputs, query: query === "" ? null : query })} />}
        <StudioSettingFields idPrefix={settingsId} properties={settingsModel.properties} values={settingsInputs.settings}
          choices={choices} disabled={props.disabled || dirty || moveDirty}
          onChange={(settings) => updateSettings({ ...settingsInputs, settings })} />
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={props.disabled || dirty || moveDirty || !settingsDirty}>Apply</Button>
        <Button type="button" variant="outline" size="sm" disabled={props.disabled || dirty || moveDirty || !settingsDirty}
          onClick={() => updateSettings(settingsInputsFor(settingsModel))}>Discard</Button>
      </div>
      <p className="text-sm">A setting you leave unset uses its default. Apply puts the change in your draft; Save keeps it.</p>
      {settingsDirty && <p role="status">Apply or discard the settings before changing anything else on this item.</p>}
    </form> : <p role="status">{settingsModel.kind === "unsupported"
      ? "This item's settings can't be changed here." : "This item's settings can't be read."}</p>}
    <h3 id={titleId} className="font-semibold">Order and size</h3>
    <p className="text-sm">{names.get(model.placementAlias) ?? "This item"}. This changes the layout in your draft; nothing runs.</p>
    <label className="block space-y-1"><span>Screen size</span>
      <NativeSelect className={fieldClass} value={breakpoint} disabled={props.disabled || dirty || moveDirty || settingsDirty}
        onChange={(event) => {
          if (pending.current || movePending.current || settingsPending.current || props.disabled) return;
          const value = event.target.value;
          if (value === "desktop" || value === "tablet" || value === "phone") setBreakpoint(value);
        }}>
        <option value="desktop">Desktop</option><option value="tablet">Tablet</option><option value="phone">Phone</option>
      </NativeSelect></label>
    <fieldset className="space-y-2" disabled={props.disabled || dirty || moveDirty || settingsDirty || !orderEditable} aria-describedby={hintId}>
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
          onClick={() => { if (!pending.current) void run({ kind: "order", breakpoint, order: null }); }}>Use the larger screen&apos;s order</Button>}
      </div>
    </fieldset>
    <p id={hintId} className="text-sm">Use the buttons, or Alt+Up and Alt+Down. {breakpoint !== "desktop" && !model.responsiveOrder
      ? "This area uses one order at every screen size." : model.explicitOrder ? "This order is set for this screen size." : "This order is inherited from the larger screen size."}</p>
    <form className="space-y-3" onSubmit={applySize}>
      <fieldset className="space-y-3" disabled={props.disabled || moveDirty || settingsDirty}>
        <legend className="font-medium">Size</legend>
        <label className="flex items-center gap-2"><Checkbox checked={inputs.visible}
          disabled={!model.capabilities.responsiveVisibility}
          onCheckedChange={(checked) => update({ ...inputs, visible: checked })} />Shown at this screen size</label>
        <label className="block space-y-1"><span>Width</span>
          <NativeSelect className={fieldClass} value={inputs.width} onChange={(event) => {
            const width = event.target.value;
            if (width === "content" || width === "fill" || width === "grid") update({ ...inputs, width });
          }}><option value="content">Content</option><option value="fill">Fill</option>
            {model.capabilities.gridWidth && <option value="grid">Columns</option>}</NativeSelect></label>
        {inputs.width === "grid" && <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1"><span>Starts at column</span><Input className={fieldClass} type="number" required min={1} max={12} step={1}
            value={inputs.startColumn} onChange={(event) => update({ ...inputs, startColumn: event.target.value })} /></label>
          <label className="block space-y-1"><span>Number of columns</span><Input className={fieldClass} type="number" required min={1} max={12} step={1}
            value={inputs.span} onChange={(event) => update({ ...inputs, span: event.target.value })} /></label>
        </div>}
        <label className="block space-y-1"><span>Height</span>
          <NativeSelect className={fieldClass} value={inputs.height} onChange={(event) => {
            const height = event.target.value;
            if (height === "content" || height === "bounded") update({ ...inputs, height });
          }}><option value="content">Content</option>
            {model.capabilities.height === "content_or_bounded" && <option value="bounded">Fixed height</option>}</NativeSelect></label>
        {inputs.height === "bounded" && <label className="block space-y-1"><span>Height</span>
          <Input className={fieldClass} type="number" required min={0} step="any" value={inputs.units}
            onChange={(event) => update({ ...inputs, units: event.target.value })} /></label>}
      </fieldset>
      <p className="text-sm">{model.explicitLayout ? "This size is set for this screen size." : "This size is inherited from the larger screen size."}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={props.disabled || moveDirty || settingsDirty || !dirty}>Apply</Button>
        <Button type="button" variant="outline" size="sm" disabled={props.disabled || moveDirty || settingsDirty || !dirty} onClick={() => update(baseline)}>Discard</Button>
        {breakpoint !== "desktop" && <Button type="button" variant="outline" size="sm" disabled={props.disabled || dirty || moveDirty || settingsDirty || !model.explicitLayout}
          onClick={() => { if (!pending.current) void run({ kind: "resize", breakpoint, layout: null }); }}>Use the larger screen&apos;s size</Button>}
      </div>
    </form>
    <form className="space-y-3" onSubmit={applyDestination}>
      <fieldset className="space-y-3" disabled={props.disabled || dirty || settingsDirty || destinations.length === 0}>
        <legend className="font-medium">Move to another area</legend>
        <label className="block space-y-1"><span>Where to move it</span>
          <NativeSelect className={fieldClass} required value={destinationKey} onChange={(event) => {
            if (props.disabled || pending.current || settingsPending.current || formContext.current !== props.context) return;
            const key = event.target.value;
            if (key !== "" && !destinations.some((item) => destinationOptionKey(item.destination) === key)) return;
            movePending.current = key !== "";
            setDestinationKey(key);
            props.onPendingChange(movePending.current || pending.current || settingsPending.current);
            setMessage("");
          }}>
            <option value="">Choose a destination</option>
            {destinations.map((item) => <option key={destinationOptionKey(item.destination)}
              value={destinationOptionKey(item.destination)}>{item.destination.kind === "child"
                ? `${names.get(item.destination.parentAlias) ?? "Item"} / ${item.label.slice(item.label.indexOf(" / ") + 3)}`
                : item.label}</option>)}
          </NativeSelect></label>
        <Button type="submit" disabled={!moveDirty}>Move</Button>
        <Button type="button" variant="outline" size="sm" disabled={!moveDirty} onClick={() => {
          if (props.disabled || pending.current || settingsPending.current || formContext.current !== props.context) return;
          movePending.current = false;
          setDestinationKey("");
          props.onPendingChange(pending.current || settingsPending.current);
          setMessage("");
        }}>Discard</Button>
      </fieldset>
      <p className="text-sm">Moves this item, with what is inside it, to the end of another area on this page. Required content and nesting limits are checked first.</p>
      {destinations.length === 0 && <p role="status">{moveModel.kind === "unsupported"
        ? "Items can only be moved within the main area of an ordinary page."
        : "There is no other area this item can move to."}</p>}
    </form>
    <section className="space-y-2" aria-label="Remove item">
      <p className="text-sm">Removes this item from the page. Flows and everything else stay as they are. Save keeps the change.</p>
      <Button type="button" variant="outline" size="sm"
        disabled={props.disabled || dirty || moveDirty || settingsDirty || removalModel.kind !== "available"}
        onClick={() => { void run({ kind: "remove" }); }}>Remove item</Button>
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
