"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import {
  describeStudioCompositionDestinations,
  describeStudioCompositionEdit,
  describeStudioCompositionPalette,
  describeStudioCompositionRemoval,
  studioSemanticSelectionKey,
  type StudioCompositionBreakpoint,
  type StudioCompositionCommand,
  type StudioCompositionCommandResult,
  type StudioCompositionContext,
  type StudioCompositionLayout,
  type StudioCompositionTextSettings,
  type StudioSemanticSelection,
} from "@vortex/studio";

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
const fieldClass = "w-full rounded border border-border bg-background px-3 py-2";
const buttonClass = "rounded border border-border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50";

/** Controls edit the native source through the same command for pointer and keyboard. */
export function ApplicationCompositionEditor(props: Props) {
  return props.selection.kind === "page" ? <ApplicationCompositionPalette {...props} />
    : <PlacementCompositionEditor {...props} />;
}

type AddInputs = Readonly<{
  search: string; releaseId: string; alias: string; settings: StudioCompositionTextSettings;
}>;
const emptyAddInputs = (): AddInputs => ({ search: "", releaseId: "", alias: "", settings: {} });
const addInputsPending = (inputs: AddInputs): boolean => inputs.search !== "" || inputs.releaseId !== "" ||
  inputs.alias !== "" || Object.keys(inputs.settings).length > 0;

function ApplicationCompositionPalette(props: Props) {
  const [inputs, setInputs] = useState<AddInputs>(emptyAddInputs);
  const [message, setMessage] = useState("");
  const selectionKey = studioSemanticSelectionKey(props.selection);
  const model = useMemo(() => describeStudioCompositionPalette(props.context, props.selection),
    [props.context, props.selection]);
  const filtered = useMemo(() => describeStudioCompositionPalette(props.context, props.selection, inputs.search),
    [props.context, props.selection, inputs.search]);
  const formContext = useRef(props.context);
  const formSelection = useRef(selectionKey);
  const pending = useRef(false);
  const titleId = useId();
  const hintId = useId();

  // Disabling during Save/Reopen or filtering the palette cannot discard inputs.
  // Only an accepted source, lifetime or semantic selection change resets them.
  useEffect(() => {
    setInputs(emptyAddInputs());
    formContext.current = props.context;
    formSelection.current = selectionKey;
    pending.current = false;
    props.onPendingChange(false);
    setMessage("");
  }, [props.context, selectionKey, props.onPendingChange]);

  if (model.kind !== "available") return <section className="space-y-2 rounded border border-border p-4">
    <h3 className="font-semibold">Add a component</h3>
    <p role="status">{model.kind === "unsupported"
      ? "Adding is supported only in an ordinary private page's main region with known block releases. Its source is preserved."
      : "This page is not available in the current draft. Its source is preserved."}</p>
  </section>;

  const choices = filtered.kind === "available" ? filtered.choices : [];
  const chosen = model.choices.find((choice) => choice.id === inputs.releaseId);
  // Filtering never silently changes a selected exact release or its text inputs.
  const options = chosen !== undefined && !choices.some((choice) => choice.id === chosen.id)
    ? [...choices, chosen] : choices;
  const update = (next: AddInputs) => {
    if (props.disabled || formContext.current !== props.context || formSelection.current !== selectionKey) return;
    pending.current = addInputsPending(next);
    props.onPendingChange(pending.current);
    setInputs(next);
    setMessage("");
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (props.disabled || !pending.current || chosen === undefined) return;
    if (formContext.current !== props.context || formSelection.current !== selectionKey) {
      setMessage("The draft or selection changed. Your inputs are preserved.");
      return;
    }
    const result = props.onCommand(formContext.current, props.selection, {
      kind: "add", blockId: chosen.blockId, releaseVersion: chosen.releaseVersion,
      alias: inputs.alias, settings: inputs.settings,
    });
    if (result === "applied") {
      pending.current = false;
      props.onPendingChange(false);
      setInputs(emptyAddInputs());
      setMessage("Component added to one local history entry. Save to persist it.");
    } else setMessage(result === "stale" ? "The draft or selection changed. Your inputs are preserved."
      : result === "unsupported" ? "This release or region is unsupported. Your inputs are preserved."
        : "No component was added. Use a unique alias and valid optional text. Your inputs are preserved.");
  };

  return <section className="space-y-4 rounded border border-border p-4" aria-labelledby={titleId}>
    <h3 id={titleId} className="font-semibold">Add a component</h3>
    <p className="text-sm">Add an exact released presentation component to this page's main region. Existing components and responsive orders are retained.</p>
    <form className="space-y-3" onSubmit={submit} aria-describedby={hintId}>
      <fieldset className="space-y-3" disabled={props.disabled}>
        <legend className="font-medium">Released component palette</legend>
        <label className="block space-y-1"><span>Search components</span>
          <input className={fieldClass} type="search" value={inputs.search}
            onChange={(event) => update({ ...inputs, search: event.target.value })} /></label>
        <label className="block space-y-1"><span>Exact component release</span>
          <select className={fieldClass} required value={inputs.releaseId} onChange={(event) => {
            const releaseId = event.target.value;
            if (releaseId !== "" && !model.choices.some((choice) => choice.id === releaseId)) return;
            update({ ...inputs, releaseId, settings: {} });
          }}><option value="">Choose a release</option>
            {options.map((choice) => <option key={choice.id} value={choice.id}>
              {choice.name} ({choice.key}, {choice.releaseVersion})
            </option>)}
          </select></label>
        {choices.length === 0 && <p role="status">No supported releases match this search. Any selected release and its inputs are preserved.</p>}
        <label className="block space-y-1"><span>Placement alias</span>
          <input className={fieldClass} required minLength={1} maxLength={160} pattern="[a-z][a-z0-9_]*"
            value={inputs.alias} onChange={(event) => update({ ...inputs, alias: event.target.value })} /></label>
        <p className="text-sm">Enter a unique authored alias beginning with a lowercase letter, followed by lowercase letters, digits or underscores.</p>
        {chosen?.properties.map((property) => {
          const supplied = Object.hasOwn(inputs.settings, property.key) ? inputs.settings[property.key] : undefined;
          return <fieldset key={property.key} className="space-y-2 rounded border border-border p-3">
            <legend>{property.label}</legend>
            <label className="flex items-center gap-2"><input type="checkbox" checked={supplied !== undefined}
              onChange={(event) => {
                const settings = { ...inputs.settings };
                if (event.target.checked) settings[property.key] = { kind: "text", value: "" };
                else delete settings[property.key];
                update({ ...inputs, settings });
              }} />Supply this optional text</label>
            {supplied !== undefined && <label className="block space-y-1"><span>{property.label} text</span>
              <textarea className={fieldClass} required={property.minLength > 0}
                minLength={property.minLength} maxLength={property.maxLength} value={supplied.value}
                onChange={(event) => update({ ...inputs, settings: { ...inputs.settings,
                  [property.key]: { kind: "text", value: event.target.value } } })} /></label>}
            {property.help !== undefined && <p className="text-sm">{property.help}</p>}
          </fieldset>;
        })}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonClass} disabled={props.disabled || chosen === undefined || inputs.alias === ""}>Add component</button>
        <button type="button" className={buttonClass} disabled={props.disabled || !addInputsPending(inputs)}
          onClick={() => update(emptyAddInputs())}>Discard add inputs</button>
      </div>
    </form>
    <p id={hintId} className="text-sm">Optional text remains omitted until supplied. Enter or the Add button applies the same guarded command. Save persists the draft; adding does not run data or actions.</p>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}

function PlacementCompositionEditor(props: Props) {
  const [breakpoint, setBreakpoint] = useState<StudioCompositionBreakpoint>("desktop");
  const model = useMemo(() => describeStudioCompositionEdit(props.context, props.selection, breakpoint),
    [props.context, props.selection, breakpoint]);
  const moveModel = useMemo(() => describeStudioCompositionDestinations(props.context, props.selection),
    [props.context, props.selection]);
  const removalModel = useMemo(() => describeStudioCompositionRemoval(props.context, props.selection),
    [props.context, props.selection]);
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
    props.onPendingChange(false);
    setMessage("");
  }, [model, props.context, breakpoint, props.onPendingChange]);

  if (model.kind !== "available" || inputs === null) return <section className="space-y-2 rounded border border-border p-4">
    <h3 className="font-semibold">Placement order and size</h3>
    <p role="status">{model.kind === "unsupported"
      ? "This region uses an unsupported block release. Its source is preserved."
      : "This placement is not available in the current draft. Its source is preserved."}</p>
  </section>;

  const baseline = inputsFor(model.layout);
  const dirty = !sameInputs(inputs, baseline);
  const moveDirty = destinationKey !== "";
  const orderEditable = breakpoint === "desktop" || model.responsiveOrder;
  const selectedIndex = model.order.indexOf(model.placementAlias);
  const update = (next: LayoutInputs) => {
    if (props.disabled || movePending.current || formContext.current !== props.context || formBreakpoint.current !== breakpoint) return;
    const changed = !sameInputs(next, baseline);
    pending.current = changed;
    props.onPendingChange(changed);
    setInputs(next);
    setMessage("");
  };
  const run = (command: StudioCompositionCommand) => {
    if (props.disabled) return;
    if (command.kind === "remove" && (pending.current || movePending.current)) return;
    if (command.kind === "move" ? pending.current : movePending.current) return;
    if (formContext.current !== props.context || formBreakpoint.current !== breakpoint) {
      setMessage("The draft context changed. Wait for the current controls before applying.");
      return;
    }
    const expected = formContext.current;
    const expectedSelection = props.selection;
    if (command.kind === "remove") {
      const removal = describeStudioCompositionRemoval(expected, expectedSelection);
      if (removal.kind !== "available") {
        setMessage("This placement cannot be removed. Its source and your inputs are preserved.");
        return;
      }
      const confirmed = window.confirm(removal.willRemoveUnusedRelease
        ? "Remove this presentation placement and its now-unused exact release dependency from local history? Save remains separate."
        : "Remove this presentation placement from local history? Its release dependency is still used elsewhere. Save remains separate.");
      if (!confirmed) return;
      if (props.disabled || pending.current || movePending.current || formContext.current !== expected ||
        formBreakpoint.current !== breakpoint) {
        setMessage("The draft or inputs changed. No removal was applied.");
        return;
      }
    }
    const result = props.onCommand(expected, expectedSelection, command);
    if (result === "applied") {
      pending.current = false;
      movePending.current = false;
      setDestinationKey("");
      props.onPendingChange(false);
      setInputs(baseline);
      setMessage("Composition applied to one local history entry. Save to persist it.");
    } else setMessage(result === "stale" ? "The draft or selection changed. Your inputs are preserved."
      : result === "unsupported" ? "This edit is unsupported by the block release. Your inputs are preserved."
        : "No change was applied. Use a valid size, order or compatible destination.");
  };
  const move = (direction: -1 | 1) => {
    if (pending.current || movePending.current || !orderEditable || selectedIndex < 0) return;
    const nextIndex = selectedIndex + direction;
    if (nextIndex < 0 || nextIndex >= model.order.length) return;
    const next = [...model.order];
    const moved = next.splice(selectedIndex, 1)[0];
    if (moved === undefined) return;
    next.splice(nextIndex, 0, moved);
    run({ kind: "order", breakpoint, order: next });
  };
  const applySize = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pending.current) return;
    run({ kind: "resize", breakpoint, layout: {
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
    const chosen = destinations.find((item) => JSON.stringify(item.destination) === destinationKey);
    if (chosen === undefined) {
      setMessage("This destination is no longer available. Your inputs are preserved.");
      return;
    }
    run({ kind: "move", destination: chosen.destination });
  };

  return <section className="space-y-4 rounded border border-border p-4" aria-labelledby={titleId}>
    <h3 id={titleId} className="font-semibold">Placement composition</h3>
    <p className="text-sm">Existing placement: {model.placementAlias}. This edits authored layout without running its data or actions.</p>
    <label className="block space-y-1"><span>Breakpoint</span>
      <select className={fieldClass} value={breakpoint} disabled={props.disabled || dirty || moveDirty}
        onChange={(event) => {
          if (pending.current || movePending.current || props.disabled) return;
          const value = event.target.value;
          if (value === "desktop" || value === "tablet" || value === "phone") setBreakpoint(value);
        }}>
        <option value="desktop">Desktop</option><option value="tablet">Tablet</option><option value="phone">Phone</option>
      </select></label>
    <fieldset className="space-y-2" disabled={props.disabled || dirty || moveDirty || !orderEditable} aria-describedby={hintId}>
      <legend className="font-medium">Sibling order</legend>
      <ol className="list-decimal pl-6">{model.order.map((alias) => <li key={alias}
        aria-current={alias === model.placementAlias ? "true" : undefined}>{alias}</li>)}</ol>
      <div className="flex flex-wrap gap-2" onKeyDown={(event) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        move(event.key === "ArrowUp" ? -1 : 1);
      }}>
        <button type="button" className={buttonClass} disabled={selectedIndex <= 0} onClick={() => move(-1)}>Move earlier</button>
        <button type="button" className={buttonClass} disabled={selectedIndex < 0 || selectedIndex >= model.order.length - 1}
          onClick={() => move(1)}>Move later</button>
        {breakpoint !== "desktop" && <button type="button" className={buttonClass} disabled={!model.explicitOrder}
          onClick={() => { if (!pending.current) run({ kind: "order", breakpoint, order: null }); }}>Inherit wider order</button>}
      </div>
    </fieldset>
    <p id={hintId} className="text-sm">Focus an order button and use Alt+Up or Alt+Down, or activate its button. {breakpoint !== "desktop" && !model.responsiveOrder
      ? "The parent release uses one order at every breakpoint." : model.explicitOrder ? "This order is explicitly authored." : "This order inherits from the wider breakpoint."}</p>
    <form className="space-y-3" onSubmit={applySize}>
      <fieldset className="space-y-3" disabled={props.disabled || moveDirty}>
        <legend className="font-medium">Responsive size</legend>
        <label className="flex items-center gap-2"><input type="checkbox" checked={inputs.visible}
          disabled={!model.capabilities.responsiveVisibility}
          onChange={(event) => update({ ...inputs, visible: event.target.checked })} />Visible at this breakpoint</label>
        <label className="block space-y-1"><span>Width</span>
          <select className={fieldClass} value={inputs.width} onChange={(event) => {
            const width = event.target.value;
            if (width === "content" || width === "fill" || width === "grid") update({ ...inputs, width });
          }}><option value="content">Content</option><option value="fill">Fill</option>
            {model.capabilities.gridWidth && <option value="grid">Twelve-column grid</option>}</select></label>
        {inputs.width === "grid" && <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1"><span>Start column</span><input className={fieldClass} type="number" required min={1} max={12} step={1}
            value={inputs.startColumn} onChange={(event) => update({ ...inputs, startColumn: event.target.value })} /></label>
          <label className="block space-y-1"><span>Column span</span><input className={fieldClass} type="number" required min={1} max={12} step={1}
            value={inputs.span} onChange={(event) => update({ ...inputs, span: event.target.value })} /></label>
        </div>}
        <label className="block space-y-1"><span>Height</span>
          <select className={fieldClass} value={inputs.height} onChange={(event) => {
            const height = event.target.value;
            if (height === "content" || height === "bounded") update({ ...inputs, height });
          }}><option value="content">Content</option>
            {model.capabilities.height === "content_or_bounded" && <option value="bounded">Bounded</option>}</select></label>
        {inputs.height === "bounded" && <label className="block space-y-1"><span>Height units</span>
          <input className={fieldClass} type="number" required min={0} step="any" value={inputs.units}
            onChange={(event) => update({ ...inputs, units: event.target.value })} /></label>}
      </fieldset>
      <p className="text-sm">{model.explicitLayout ? "This layout is explicitly authored." : "This layout inherits from the wider breakpoint."} Applying size records one local history entry; Enter submits this same form.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonClass} disabled={props.disabled || moveDirty || !dirty}>Apply size</button>
        <button type="button" className={buttonClass} disabled={props.disabled || moveDirty || !dirty} onClick={() => update(baseline)}>Discard size inputs</button>
        {breakpoint !== "desktop" && <button type="button" className={buttonClass} disabled={props.disabled || dirty || moveDirty || !model.explicitLayout}
          onClick={() => { if (!pending.current) run({ kind: "resize", breakpoint, layout: null }); }}>Inherit wider size</button>}
      </div>
    </form>
    <form className="space-y-3" onSubmit={applyDestination}>
      <fieldset className="space-y-3" disabled={props.disabled || dirty || destinations.length === 0}>
        <legend className="font-medium">Move to another slot</legend>
        <label className="block space-y-1"><span>Existing destination in this page region</span>
          <select className={fieldClass} required value={destinationKey} onChange={(event) => {
            if (props.disabled || pending.current || formContext.current !== props.context) return;
            const key = event.target.value;
            if (key !== "" && !destinations.some((item) => JSON.stringify(item.destination) === key)) return;
            movePending.current = key !== "";
            setDestinationKey(key);
            props.onPendingChange(movePending.current);
            setMessage("");
          }}>
            <option value="">Choose a destination</option>
            {destinations.map((item) => <option key={JSON.stringify(item.destination)}
              value={JSON.stringify(item.destination)}>{item.label}</option>)}
          </select></label>
        <button type="submit" className={buttonClass} disabled={!moveDirty}>Move placement</button>
        <button type="button" className={buttonClass} disabled={!moveDirty} onClick={() => {
          if (props.disabled || pending.current || formContext.current !== props.context) return;
          movePending.current = false;
          setDestinationKey("");
          props.onPendingChange(false);
          setMessage("");
        }}>Discard destination</button>
      </fieldset>
      <p className="text-sm">Move the existing placement and its children to the end of an existing compatible slot in this page's main region. Use this select and Enter or the Move button. Required content, nesting limits and slot compatibility are checked before applying.</p>
      {destinations.length === 0 && <p role="status">{moveModel.kind === "unsupported"
        ? "Moves are supported only within an ordinary page's main region with known block releases."
        : "No other compatible existing destination is available for this placement."}</p>}
    </form>
    <section className="space-y-2" aria-label="Remove presentation placement">
      <p className="text-sm">Remove only an unreferenced released presentation placement. Flows and other source fields are retained. Save remains separate.</p>
      <button type="button" className={buttonClass}
        disabled={props.disabled || dirty || moveDirty || removalModel.kind !== "available"}
        onClick={() => run({ kind: "remove" })}>Remove placement</button>
      {removalModel.kind === "blocked" && <p role="status">{removalModel.reason === "required_slot"
        ? "This slot requires its remaining placement."
        : removalModel.reason === "unresolved_target"
          ? "A declared placement target cannot be resolved safely. Removal is unavailable."
          : "A Flow still refers to this placement. Removal is unavailable."}</p>}
      {(removalModel.kind === "invalid" || removalModel.kind === "unsupported") &&
        <p role="status">Removal is available only for supported presentation placements in private list, detail or dashboard main regions.</p>}
    </section>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
