"use client";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { NativeSelect } from "@vortex/ui/components/native-select";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { studioPlacementLabels } from "../_lib/studio-labels";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import {
  describeStudioCompositionDestinations,
  describeStudioCompositionEdit,
  describeStudioCompositionRemoval,
  describeStudioCompositionSettings,
  describeStudioCompositionScalarSettings,
  studioSemanticSelectionKey,
  type StudioCompositionBreakpoint,
  type StudioCompositionCommand,
  type StudioCompositionCommandResult,
  type StudioCompositionContext,
  type StudioCompositionLayout,
  type StudioCompositionTextSettings,
  type StudioCompositionScalarSettings,
  type StudioSemanticSelection,
} from "@vortex/ui/studio";

type Props = Readonly<{
  context: StudioCompositionContext;
  selection: StudioSemanticSelection;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onCommand: (expected: StudioCompositionContext, selection: StudioSemanticSelection,
    command: StudioCompositionCommand) => StudioCompositionCommandResult["kind"];
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
const sameSettings = (left: StudioCompositionTextSettings, right: StudioCompositionTextSettings): boolean =>
  Object.keys(left).length === Object.keys(right).length && Object.keys(left).every((key) =>
    Object.hasOwn(right, key) && left[key]?.value === right[key]?.value);
type ScalarInputs = Readonly<Record<string,
  Readonly<{ kind: "boolean"; value: boolean }> | Readonly<{ kind: "choice"; value: string }> |
  Readonly<{ kind: "number"; value: string }>>>;
const scalarInputsFor = (settings: StudioCompositionScalarSettings): ScalarInputs => {
  const inputs: Record<string, ScalarInputs[string]> = {};
  for (const [key, value] of Object.entries(settings))
    inputs[key] = value.kind === "number" ? { kind: "number", value: String(value.value) } : value;
  return inputs;
};
const sameScalarInputs = (left: ScalarInputs, right: ScalarInputs): boolean =>
  Object.keys(left).length === Object.keys(right).length && Object.keys(left).every((key) =>
    Object.hasOwn(right, key) && left[key]?.kind === right[key]?.kind && left[key]?.value === right[key]?.value);
const parseScalarInputs = (inputs: ScalarInputs): StudioCompositionScalarSettings | undefined => {
  const settings: Record<string, StudioCompositionScalarSettings[string]> = {};
  for (const [key, input] of Object.entries(inputs)) {
    if (input.kind !== "number") {
      settings[key] = input;
      continue;
    }
    const raw = input.value.trim();
    // Keep empty, malformed and non-finite buffers distinct from omission and zero.
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) return undefined;
    settings[key] = { kind: "number", value };
  }
  return settings;
};
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
  const [settingsInputs, setSettingsInputs] = useState<StudioCompositionTextSettings>(() =>
    settingsModel.kind === "available" ? settingsModel.settings : {});
  const settingsPending = useRef(false);
  const settingsContext = useRef(props.context);
  const selectionKey = studioSemanticSelectionKey(props.selection);
  const settingsSelection = useRef(selectionKey);
  const scalarModel = useMemo(() => describeStudioCompositionScalarSettings(props.context, props.selection),
    [props.context, props.selection]);
  const [scalarInputs, setScalarInputs] = useState<ScalarInputs>(() =>
    scalarModel.kind === "available" ? scalarInputsFor(scalarModel.settings) : {});
  const scalarPending = useRef(false);
  const scalarContext = useRef(props.context);
  const scalarSelection = useRef(selectionKey);
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

  // Only an accepted history source/selection/breakpoint change resets the form.
  // A failed or cancelled reopen leaves this exact context and these inputs intact.
  useEffect(() => {
    setInputs(model.kind === "available" ? inputsFor(model.layout) : null);
    formContext.current = props.context;
    formBreakpoint.current = breakpoint;
    pending.current = false;
    movePending.current = false;
    setDestinationKey("");
    props.onPendingChange(settingsPending.current || scalarPending.current);
    setMessage("");
  }, [model, props.context, breakpoint, props.onPendingChange]);

  // Text settings have no breakpoint buffer. Disabled/Save/Reopen changes do
  // not reset inputs; only an accepted source/lifetime/selection resets them.
  useEffect(() => {
    if (settingsContext.current === props.context && settingsSelection.current === selectionKey) return;
    setSettingsInputs(settingsModel.kind === "available" ? settingsModel.settings : {});
    settingsContext.current = props.context;
    settingsSelection.current = selectionKey;
    settingsPending.current = false;
    props.onPendingChange(pending.current || movePending.current || scalarPending.current);
  }, [settingsModel, props.context, selectionKey, props.onPendingChange]);

  // Scalar inputs share the accepted source/selection lifetime, not a breakpoint or disabled state.
  useEffect(() => {
    if (scalarContext.current === props.context && scalarSelection.current === selectionKey) return;
    setScalarInputs(scalarModel.kind === "available" ? scalarInputsFor(scalarModel.settings) : {});
    scalarContext.current = props.context;
    scalarSelection.current = selectionKey;
    scalarPending.current = false;
    props.onPendingChange(pending.current || movePending.current || settingsPending.current);
  }, [scalarModel, props.context, selectionKey, props.onPendingChange]);

  if (model.kind !== "available" || inputs === null) return <section className="space-y-2 rounded-xl border bg-card text-card-foreground border-border p-4">
    <h3 className="font-semibold">Item order and size</h3>
    <p role="status">{model.kind === "unsupported"
      ? "This area uses an item type that cannot be edited here. Nothing was changed."
      : "This item is not in the current draft."}</p>
  </section>;

  const baseline = inputsFor(model.layout);
  const dirty = !sameInputs(inputs, baseline);
  const moveDirty = destinationKey !== "";
  const settingsDirty = settingsModel.kind === "available" && !sameSettings(settingsInputs, settingsModel.settings);
  const scalarDirty = scalarModel.kind === "available" &&
    !sameScalarInputs(scalarInputs, scalarInputsFor(scalarModel.settings));
  const orderEditable = breakpoint === "desktop" || model.responsiveOrder;
  const selectedIndex = model.order.indexOf(model.placementAlias);
  const update = (next: LayoutInputs) => {
    if (props.disabled || movePending.current || settingsPending.current || scalarPending.current || formContext.current !== props.context || formBreakpoint.current !== breakpoint) return;
    const changed = !sameInputs(next, baseline);
    pending.current = changed;
    props.onPendingChange(changed || movePending.current || settingsPending.current || scalarPending.current);
    setInputs(next);
    setMessage("");
  };
  const run = async (command: StudioCompositionCommand) => {
    if (props.disabled || settingsPending.current || scalarPending.current) return;
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
      if (props.disabled || pending.current || movePending.current || settingsPending.current || scalarPending.current || formContext.current !== expected ||
        formBreakpoint.current !== breakpoint) {
        setMessage("The draft or your input changed. Nothing was removed.");
        return;
      }
    }
    const result = props.onCommand(expected, expectedSelection, command);
    if (result === "applied") {
      pending.current = false;
      movePending.current = false;
      setDestinationKey("");
      props.onPendingChange(settingsPending.current || scalarPending.current);
      setInputs(baseline);
      setMessage("Change made. Save to keep it.");
    } else setMessage(result === "stale" ? "The draft or your selection changed. What you typed is kept."
      : result === "unsupported" ? "This item does not support that change. What you typed is kept."
        : "Nothing changed. Use a valid size, order or destination.");
  };
  const move = (direction: -1 | 1) => {
    if (pending.current || movePending.current || settingsPending.current || scalarPending.current || !orderEditable || selectedIndex < 0) return;
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

  const updateSettings = (next: StudioCompositionTextSettings) => {
    if (props.disabled || pending.current || movePending.current || scalarPending.current || settingsModel.kind !== "available" ||
      settingsContext.current !== props.context || settingsSelection.current !== selectionKey) return;
    settingsPending.current = !sameSettings(next, settingsModel.settings);
    props.onPendingChange(settingsPending.current || pending.current || movePending.current || scalarPending.current);
    setSettingsInputs(next);
    setMessage("");
  };
  const applySettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (props.disabled || !settingsPending.current || pending.current || movePending.current || scalarPending.current) return;
    const expected = settingsContext.current;
    const expectedSelection = props.selection;
    if (expected !== props.context || settingsSelection.current !== selectionKey ||
      describeStudioCompositionSettings(expected, expectedSelection).kind !== "available") {
      setMessage("The draft or your selection changed. What you typed is kept.");
      return;
    }
    const result = props.onCommand(expected, expectedSelection, { kind: "settings", settings: settingsInputs });
    if (result === "applied") {
      settingsPending.current = false;
      props.onPendingChange(pending.current || movePending.current || scalarPending.current);
      setMessage("Text changed. Save to keep it.");
    } else setMessage(result === "stale" ? "The draft or your selection changed. What you typed is kept."
      : result === "unsupported" ? "This item has no text to change. What you typed is kept."
        : "Nothing changed. Use valid text within its length limits. What you typed is kept.");
  };

  const updateScalars = (next: ScalarInputs) => {
    if (props.disabled || pending.current || movePending.current || settingsPending.current || scalarModel.kind !== "available" ||
      scalarContext.current !== props.context || scalarSelection.current !== selectionKey) return;
    scalarPending.current = !sameScalarInputs(next, scalarInputsFor(scalarModel.settings));
    props.onPendingChange(scalarPending.current || pending.current || movePending.current || settingsPending.current);
    setScalarInputs(next);
    setMessage("");
  };
  const applyScalars = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (props.disabled || !scalarPending.current || pending.current || movePending.current || settingsPending.current) return;
    const expected = scalarContext.current;
    const expectedSelection = props.selection;
    if (expected !== props.context || scalarSelection.current !== selectionKey ||
      describeStudioCompositionScalarSettings(expected, expectedSelection).kind !== "available") {
      setMessage("The draft or your selection changed. What you typed is kept.");
      return;
    }
    const settings = parseScalarInputs(scalarInputs);
    if (settings === undefined) {
      setMessage("Enter a number for each numeric setting. What you typed is kept.");
      return;
    }
    const result = props.onCommand(expected, expectedSelection, { kind: "scalar_settings", settings });
    if (result === "applied") {
      scalarPending.current = false;
      props.onPendingChange(pending.current || movePending.current || settingsPending.current);
      setMessage("Settings changed. Save to keep them.");
    } else setMessage(result === "stale" ? "The draft or your selection changed. What you typed is kept."
      : result === "unsupported" ? "This item has no settings to change. What you typed is kept."
        : "Nothing changed. Enter valid values and fill the required settings. What you typed is kept.");
  };

  return <section className="space-y-4 rounded-xl border bg-card text-card-foreground border-border p-4" aria-labelledby={titleId}>
    <h3 id={titleId} className="font-semibold">Order and size</h3>
    <p className="text-sm">{names.get(model.placementAlias) ?? "This item"}. This changes the layout in your draft; nothing runs.</p>
    <label className="block space-y-1"><span>Screen size</span>
      <NativeSelect className={fieldClass} value={breakpoint} disabled={props.disabled || dirty || moveDirty || settingsDirty || scalarDirty}
        onChange={(event) => {
          if (pending.current || movePending.current || settingsPending.current || scalarPending.current || props.disabled) return;
          const value = event.target.value;
          if (value === "desktop" || value === "tablet" || value === "phone") setBreakpoint(value);
        }}>
        <option value="desktop">Desktop</option><option value="tablet">Tablet</option><option value="phone">Phone</option>
      </NativeSelect></label>
    <fieldset className="space-y-2" disabled={props.disabled || dirty || moveDirty || settingsDirty || scalarDirty || !orderEditable} aria-describedby={hintId}>
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
          onClick={() => { if (!pending.current) void run({ kind: "order", breakpoint, order: null }); }}>Use the larger screen's order</Button>}
      </div>
    </fieldset>
    <p id={hintId} className="text-sm">Use the buttons, or Alt+Up and Alt+Down. {breakpoint !== "desktop" && !model.responsiveOrder
      ? "This area uses one order at every screen size." : model.explicitOrder ? "This order is set for this screen size." : "This order is inherited from the larger screen size."}</p>
    <form className="space-y-3" onSubmit={applySize}>
      <fieldset className="space-y-3" disabled={props.disabled || moveDirty || settingsDirty || scalarDirty}>
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
        <Button type="submit" disabled={props.disabled || moveDirty || settingsDirty || scalarDirty || !dirty}>Apply</Button>
        <Button type="button" variant="outline" size="sm" disabled={props.disabled || moveDirty || settingsDirty || scalarDirty || !dirty} onClick={() => update(baseline)}>Discard</Button>
        {breakpoint !== "desktop" && <Button type="button" variant="outline" size="sm" disabled={props.disabled || dirty || moveDirty || settingsDirty || scalarDirty || !model.explicitLayout}
          onClick={() => { if (!pending.current) void run({ kind: "resize", breakpoint, layout: null }); }}>Use the larger screen's size</Button>}
      </div>
    </form>
    <form className="space-y-3" onSubmit={applyDestination}>
      <fieldset className="space-y-3" disabled={props.disabled || dirty || settingsDirty || scalarDirty || destinations.length === 0}>
        <legend className="font-medium">Move to another area</legend>
        <label className="block space-y-1"><span>Where to move it</span>
          <NativeSelect className={fieldClass} required value={destinationKey} onChange={(event) => {
            if (props.disabled || pending.current || settingsPending.current || scalarPending.current || formContext.current !== props.context) return;
            const key = event.target.value;
            if (key !== "" && !destinations.some((item) => destinationOptionKey(item.destination) === key)) return;
            movePending.current = key !== "";
            setDestinationKey(key);
            props.onPendingChange(movePending.current || pending.current || settingsPending.current || scalarPending.current);
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
          if (props.disabled || pending.current || settingsPending.current || scalarPending.current || formContext.current !== props.context) return;
          movePending.current = false;
          setDestinationKey("");
          props.onPendingChange(pending.current || settingsPending.current || scalarPending.current);
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
        disabled={props.disabled || dirty || moveDirty || settingsDirty || scalarDirty || removalModel.kind !== "available"}
        onClick={() => { void run({ kind: "remove" }); }}>Remove item</Button>
      {removalModel.kind === "blocked" && <p role="status">{removalModel.reason === "required_slot"
        ? "This area needs at least this item."
        : removalModel.reason === "unresolved_target"
          ? "Something this item points to cannot be found. It cannot be removed."
          : "A flow still uses this item. It cannot be removed."}</p>}
      {(removalModel.kind === "invalid" || removalModel.kind === "unsupported") &&
        <p role="status">Only display items in the main area of a list, detail or dashboard page can be removed.</p>}
    </section>
    {settingsModel.kind === "available" ? <form className="space-y-3" onSubmit={applySettings}>
      <fieldset className="space-y-3" disabled={props.disabled || dirty || moveDirty || scalarDirty}>
        <legend className="font-medium">Text</legend>
        {settingsModel.properties.map((property) => {
          const supplied = Object.hasOwn(settingsInputs, property.key) ? settingsInputs[property.key] : undefined;
          return <fieldset key={property.key} className="space-y-2 rounded-xl border bg-card text-card-foreground border-border p-3">
            <legend>{property.label}</legend>
            <label className="flex items-center gap-2"><Checkbox checked={supplied !== undefined}
              onCheckedChange={(checked) => {
                const next = { ...settingsInputs };
                if (checked) next[property.key] = { kind: "text", value: "" };
                else delete next[property.key];
                updateSettings(next);
              }} />Set this text</label>
            {supplied !== undefined && <label className="block space-y-1"><span>{property.label} text</span>
              <Textarea className={fieldClass} required={property.minLength > 0}
                minLength={property.minLength} maxLength={property.maxLength} value={supplied.value}
                onChange={(event) => updateSettings({ ...settingsInputs,
                  [property.key]: { kind: "text", value: event.target.value } })} /></label>}
            {property.help !== undefined && <p className="text-sm">{property.help}</p>}
          </fieldset>;
        })}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={props.disabled || dirty || moveDirty || scalarDirty || !settingsDirty}>Apply</Button>
        <Button type="button" variant="outline" size="sm" disabled={props.disabled || dirty || moveDirty || scalarDirty || !settingsDirty}
          onClick={() => updateSettings(settingsModel.settings)}>Discard</Button>
      </div>
      <p className="text-sm">Text you leave unset is not written to the draft. Apply puts the change in your draft; Save keeps it.</p>
      {settingsDirty && <p role="status">Apply or discard the text before changing anything else on this item.</p>}
    </form> : <p role="status">This item has no text that can be edited here.</p>}
    {scalarModel.kind === "available" && <form className="space-y-3" onSubmit={applyScalars}>
      <fieldset className="space-y-3" disabled={props.disabled || dirty || moveDirty || settingsDirty}>
        <legend className="font-medium">Settings</legend>
        {scalarModel.properties.map((property) => {
          const supplied = Object.hasOwn(scalarInputs, property.key) ? scalarInputs[property.key] : undefined;
          const canOmit = !property.required || property.defaultValue !== undefined;
          const defaultValue = property.defaultValue;
          const defaultLabel = defaultValue?.kind === "boolean" ? String(defaultValue.value)
            : defaultValue?.kind === "number" ? String(defaultValue.value)
            : defaultValue?.kind === "choice" && property.kind === "choice"
              ? property.options.find((option) => option.key === defaultValue.value)?.label : undefined;
          return <fieldset key={property.key} className="space-y-2 rounded-xl border bg-card text-card-foreground border-border p-3">
            <legend>{property.label}</legend>
            <p className="text-sm">{property.required ? "Required." : "Optional."} {defaultLabel !== undefined
              ? `If you leave it unset, ${defaultLabel} is used.`
              : canOmit ? "Not set until you choose a value." : "Choose a value."}</p>
            <label className="flex items-center gap-2"><Checkbox checked={supplied !== undefined}
              disabled={!canOmit} onCheckedChange={(checked) => {
                const next = { ...scalarInputs };
                if (checked) next[property.key] = property.kind === "boolean"
                  ? { kind: "boolean", value: false } : property.kind === "number"
                    ? { kind: "number", value: "" } : { kind: "choice", value: "" };
                else delete next[property.key];
                updateScalars(next);
              }} />Set this option</label>
            {property.kind === "boolean" && supplied?.kind === "boolean" &&
              <label className="flex items-center gap-2"><Checkbox checked={supplied.value}
                onCheckedChange={(checked) => updateScalars({ ...scalarInputs,
                  [property.key]: { kind: "boolean", value: checked } })} />{property.label}</label>}
            {property.kind === "choice" && supplied?.kind === "choice" &&
              <label className="block space-y-1"><span>{property.label}</span>
                <NativeSelect className={fieldClass} required value={supplied.value} onChange={(event) => {
                  const value = event.target.value;
                  if (value !== "" && !property.options.some((option) => option.key === value)) return;
                  updateScalars({ ...scalarInputs, [property.key]: { kind: "choice", value } });
                }}><option value="">Choose a value</option>
                  {property.options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                </NativeSelect></label>}
            {property.kind === "number" && <p className="text-sm">
              {property.integer ? "Whole numbers only." : "Fractional numbers are allowed."}
              {property.minimum !== undefined && ` Minimum: ${property.minimum}.`}
              {property.maximum !== undefined && ` Maximum: ${property.maximum}.`}
            </p>}
            {property.kind === "number" && supplied?.kind === "number" &&
              <label className="block space-y-1"><span>{property.label}</span>
                <Input className={fieldClass} type="text" inputMode={property.integer ? "numeric" : "decimal"}
                  value={supplied.value} onChange={(event) => updateScalars({ ...scalarInputs,
                    [property.key]: { kind: "number", value: event.target.value } })} />
              </label>}
            {property.help !== undefined && <p className="text-sm">{property.help}</p>}
          </fieldset>;
        })}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit"
          disabled={props.disabled || dirty || moveDirty || settingsDirty || !scalarDirty}>Apply</Button>
        <Button type="button" variant="outline" size="sm"
          disabled={props.disabled || dirty || moveDirty || settingsDirty || !scalarDirty}
          onClick={() => updateScalars(scalarInputsFor(scalarModel.settings))}>Discard</Button>
      </div>
      <p className="text-sm">A setting you leave unset uses its default. Apply puts the change in your draft; Save keeps it.</p>
      {scalarDirty && <p role="status">Apply or discard the settings before changing anything else on this item.</p>}
    </form>}
    <p role="status" aria-live="polite">{message}</p>
    {confirmDialog}
  </section>;
}
