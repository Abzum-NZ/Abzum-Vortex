"use client";

import { useEffect, useId, useRef, useState } from "react";
import { platformIdSchema, type ApplicationSourceDocumentV2 } from "@vortex/contracts";
import {
  applyStudioAppearance,
  parseStudioAppearanceRequest,
  studioAppearanceValueKey,
  type StudioAppearanceResult,
  type StudioThemeTokenValue,
} from "@vortex/studio";
import { validateStudioApplicationAppearance } from "../actions";

type AvailableAppearance = Extract<StudioAppearanceResult, { kind: "available" }>;
type Props = Readonly<{
  organizationId: string; rootId: string; draftRevision: number;
  source: ApplicationSourceDocumentV2; disabled: boolean; validationEpoch: number;
  onPendingChange: (pending: boolean) => void;
  onApply: (expected: ApplicationSourceDocumentV2, next: ApplicationSourceDocumentV2) => boolean;
}>;
const inputClass = "w-full rounded border border-border bg-background px-3 py-2 text-foreground";
const buttonClass = "rounded border border-border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50";

function TokenControls({ value, disabled, colors, assets, change }: {
  value: StudioThemeTokenValue; disabled: boolean; colors: readonly string[];
  assets: readonly string[]; change: (value: StudioThemeTokenValue) => void;
}) {
  const text = (label: string, current: string, update: (next: string) => void) =>
    <label className="block space-y-1"><span>{label}</span>
      <input className={inputClass} value={current} disabled={disabled} onChange={(event) => update(event.target.value)} /></label>;
  const number = (label: string, current: number, minimum: number, step: string,
    update: (next: number) => void, maximum?: number) =>
    <label className="block space-y-1"><span>{label}</span>
      <input className={inputClass} type="number" value={Number.isFinite(current) ? current : ""}
        min={minimum} max={maximum} step={step} required disabled={disabled}
        onChange={(event) => update(event.target.valueAsNumber)} /></label>;
  const color = (current: string, update: (next: string) => void) =>
    <label className="block space-y-1"><span>Colour token</span>
      <select className={inputClass} value={current} disabled={disabled} onChange={(event) => update(event.target.value)}>
        {colors.map((key) => <option key={key} value={key}>{key}</option>)}
      </select></label>;
  switch (value.kind) {
    case "color_pair": return <>
      {text("Light colour", value.light, (light) => change({ ...value, light }))}
      {text("Dark colour", value.dark, (dark) => change({ ...value, dark }))}
      <p className="text-sm">Use a six-digit hex colour or oklch(). The registered colour role is preserved.</p>
    </>;
    case "typography": return <>
      {text("Font family key", value.family, (family) => change({ ...value, family }))}
      {number("Size (rem)", value.size_rem, 0, "any", (size_rem) => change({ ...value, size_rem }))}
      {number("Line height", value.line_height, 0, "any", (line_height) => change({ ...value, line_height }))}
      {number("Weight", value.weight, 100, "1", (weight) => change({ ...value, weight }), 900)}
      <p className="text-sm">Size and line height must be greater than zero.</p>
    </>;
    case "spacing":
    case "corners": return number("Size (rem)", value.rem, 0, "any", (rem) => change({ ...value, rem }));
    case "border": return <>
      {number("Width (rem)", value.width_rem, 0, "any", (width_rem) => change({ ...value, width_rem }))}
      <label className="block space-y-1"><span>Style</span>
        <select className={inputClass} value={value.style} disabled={disabled}
          onChange={(event) => change({ ...value, style: event.target.value === "dashed" ? "dashed" : "solid" })}>
          <option value="solid">Solid</option><option value="dashed">Dashed</option>
        </select></label>
      {color(value.color_token, (color_token) => change({ ...value, color_token }))}
    </>;
    case "elevation": return number("Elevation level", value.level, 0, "1", (level) => change({ ...value, level }));
    case "focus": return <>
      {color(value.color_token, (color_token) => change({ ...value, color_token }))}
      {number("Focus width (rem)", value.width_rem, 0, "any", (width_rem) => change({ ...value, width_rem }))}
      <p className="text-sm">Focus must remain visible. The server checks width and contrast.</p>
    </>;
    case "asset": return <label className="block space-y-1"><span>Public platform asset</span>
      <select className={inputClass} value={value.asset_id} disabled={disabled}
        onChange={(event) => {
          const chosen = assets.find((asset) => asset === event.target.value);
          const parsed = platformIdSchema.safeParse(chosen);
          if (parsed.success) change({ ...value, asset_id: parsed.data });
        }}>
        {assets.map((id, index) => <option key={id} value={id}>Platform asset {index + 1}</option>)}
      </select></label>;
    case "density": return <label className="block space-y-1"><span>Density</span>
      <select className={inputClass} value={value.value} disabled={disabled}
        onChange={(event) => change({ ...value, value: event.target.value === "compact" ? "compact" : "comfortable" })}>
        <option value="compact">Compact</option><option value="comfortable">Comfortable</option>
      </select></label>;
  }
}

export function ApplicationAppearanceEditor(props: Props) {
  const id = useId();
  const active = useRef(false);
  const generation = useRef(0);
  const validationEpoch = useRef(props.validationEpoch);
  const cancelledEpoch = useRef(props.validationEpoch);
  const feedbackEpoch = useRef(props.validationEpoch);
  validationEpoch.current = props.validationEpoch;
  const valuesRef = useRef(props.source.body.theme.token_overrides);
  const [values, setValues] = useState(() => structuredClone(props.source.body.theme.token_overrides));
  const [descriptors, setDescriptors] = useState<AvailableAppearance>();
  const [feedback, setFeedback] = useState<AvailableAppearance>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const valueKey = studioAppearanceValueKey(values);
  const baselineKey = studioAppearanceValueKey(props.source.body.theme.token_overrides);
  const changed = valueKey !== baselineKey;

  // Reopen cancels feedback, not local values. Only a successful source replacement
  // runs the source-reset effect below; a refused read keeps this editor instance.
  useEffect(() => {
    if (cancelledEpoch.current === props.validationEpoch) return;
    cancelledEpoch.current = props.validationEpoch;
    generation.current += 1;
    setFeedback(undefined);
    setBusy(false);
    props.onPendingChange(studioAppearanceValueKey(valuesRef.current) !== baselineKey);
    setMessage("Appearance edits are preserved. Validate again after the saved-draft read finishes.");
  }, [props.validationEpoch, props.onPendingChange, baselineKey]);

  useEffect(() => {
    active.current = true;
    const ticket = ++generation.current;
    const epoch = validationEpoch.current;
    const initial = structuredClone(props.source.body.theme.token_overrides);
    valuesRef.current = initial;
    setValues(initial);
    setDescriptors(undefined);
    setFeedback(undefined);
    setBusy(true);
    props.onPendingChange(true);
    setMessage("Reading the pinned theme with current draft permissions…");
    const request = { rootId: props.rootId, expectedDraftRevision: props.draftRevision, tokenOverrides: initial };
    void validateStudioApplicationAppearance(props.organizationId, request).then((result) => {
      if (!active.current || ticket !== generation.current || epoch !== validationEpoch.current) return;
      if (result.kind === "available" && result.rootId === request.rootId &&
          result.draftRevision === request.expectedDraftRevision &&
          studioAppearanceValueKey(result.theme) === studioAppearanceValueKey(props.source.body.theme)) {
        setDescriptors(result);
        feedbackEpoch.current = epoch;
        setFeedback(result);
        setMessage(result.valid ? "Edit an override, then validate it before applying." : "The server found theme validation failures.");
      } else setMessage(result.kind === "conflict"
        ? "The saved revision changed. Reopen explicitly; local edits are preserved."
        : "Appearance is unavailable for the current draft, permission or pinned theme.");
    }).catch(() => {
      if (active.current && ticket === generation.current && epoch === validationEpoch.current)
        setMessage("Appearance could not be verified. Local edits are preserved.");
    }).finally(() => {
      if (active.current && ticket === generation.current && epoch === validationEpoch.current) {
        setBusy(false);
        props.onPendingChange(false);
      }
    });
    return () => { active.current = false; generation.current += 1; };
  }, [props.organizationId, props.rootId, props.draftRevision, props.source, props.onPendingChange]);

  useEffect(() => { props.onPendingChange(changed || busy); }, [changed, busy, props.onPendingChange]);
  useEffect(() => () => props.onPendingChange(false), [props.onPendingChange]);

  const update = (next: Record<string, StudioThemeTokenValue>) => {
    if (props.disabled) return;
    generation.current += 1;
    valuesRef.current = next;
    setValues(next);
    setFeedback(undefined);
    setBusy(false);
    props.onPendingChange(studioAppearanceValueKey(next) !== baselineKey);
    setMessage("Unapplied appearance edits. Validate before applying, or discard them.");
  };
  const validate = async () => {
    if (props.disabled || busy) return;
    const request = parseStudioAppearanceRequest({ rootId: props.rootId,
      expectedDraftRevision: props.draftRevision, tokenOverrides: values });
    if (request === undefined) { setFeedback(undefined); setMessage("Enter valid values for every edited token."); return; }
    const ticket = ++generation.current;
    const epoch = validationEpoch.current;
    setBusy(true);
    props.onPendingChange(true);
    setFeedback(undefined);
    setMessage("Validating contrast, focus, references and public assets…");
    try {
      const result = await validateStudioApplicationAppearance(props.organizationId, request);
      if (!active.current || ticket !== generation.current || epoch !== validationEpoch.current ||
          studioAppearanceValueKey(valuesRef.current) !== studioAppearanceValueKey(request.tokenOverrides)) return;
      if (result.kind === "available" && result.rootId === request.rootId &&
          result.draftRevision === request.expectedDraftRevision &&
          studioAppearanceValueKey(result.theme.base) === studioAppearanceValueKey(props.source.body.theme.base) &&
          studioAppearanceValueKey(result.theme.selection) === studioAppearanceValueKey(props.source.body.theme.selection) &&
          studioAppearanceValueKey(result.theme.token_overrides) === studioAppearanceValueKey(request.tokenOverrides)) {
        setDescriptors(result);
        feedbackEpoch.current = epoch;
        setFeedback(result);
        setMessage(result.valid ? "Server validation passed. Apply records one local history entry."
          : "The server found theme validation failures. No changes were applied.");
      } else setMessage(result.kind === "conflict"
        ? "The saved revision changed. Local edits are preserved; reopen explicitly."
        : "The current draft, permission or theme was refused. No changes were applied.");
    } catch {
      if (active.current && ticket === generation.current && epoch === validationEpoch.current)
        setMessage("Validation could not be verified. Local edits are preserved.");
    } finally {
      if (active.current && ticket === generation.current && epoch === validationEpoch.current) {
        setBusy(false);
        props.onPendingChange(studioAppearanceValueKey(valuesRef.current) !== baselineKey);
      }
    }
  };
  const apply = () => {
    if (props.disabled || busy || feedback === undefined || feedbackEpoch.current !== props.validationEpoch) return;
    const request = parseStudioAppearanceRequest({ rootId: props.rootId,
      expectedDraftRevision: props.draftRevision, tokenOverrides: values });
    const next = request === undefined ? undefined
      : applyStudioAppearance(props.source, props.rootId, props.draftRevision, request, feedback);
    if (next === undefined || !props.onApply(props.source, next)) {
      setFeedback(undefined);
      setMessage("The draft or submitted values changed. Validate the current appearance again.");
    }
  };
  const colors = descriptors?.tokens.filter((token) => token.inherited.kind === "color_pair").map((token) => token.key) ?? [];
  const failures = feedback?.failures ?? [];
  const describe = (code: string) => code.toLowerCase().replaceAll("_", " ");
  return <section className="space-y-4" aria-label="Application appearance" aria-busy={busy}>
    <h2 className="font-semibold">Appearance</h2>
    <p className="text-sm">Only the current pinned theme's tokens can be overridden. Its release, selection and colour roles remain unchanged.</p>
    <p role="status" aria-live="polite">{message}</p>
    {failures.filter((failure) => failure.tokenKey === undefined).length > 0 &&
      <ul role="alert" className="list-disc pl-5">
        {failures.filter((failure) => failure.tokenKey === undefined).map((failure, index) =>
          <li key={index}>Theme: {describe(failure.code)}.</li>)}
      </ul>}
    {descriptors?.tokens.map((token, index) => {
      const overridden = Object.hasOwn(values, token.key);
      const value = values[token.key] ?? token.inherited;
      const errors = failures.filter((failure) => failure.tokenKey === token.key);
      const errorId = `${id}-${index}-errors`;
      return <fieldset key={token.key} className="space-y-3 rounded border border-border p-4"
        aria-describedby={errors.length === 0 ? undefined : errorId}>
        <legend className="px-1 font-medium">{token.key} ({token.inherited.kind.replaceAll("_", " ")})</legend>
        <label className="flex items-center gap-2"><input type="checkbox" checked={overridden} disabled={props.disabled}
          onChange={(event) => {
            const next = { ...values };
            if (event.target.checked) next[token.key] = structuredClone(token.inherited);
            else delete next[token.key];
            update(next);
          }} />Override this token</label>
        {value.kind === token.inherited.kind ? <TokenControls value={value}
          disabled={props.disabled || !overridden} colors={colors} assets={descriptors.publicAssetIds}
          change={(next) => update({ ...values, [token.key]: next })} />
          : <p role="alert">The stored override has an invalid kind. Reset it to the inherited token.</p>}
        <button className={buttonClass} type="button" disabled={props.disabled || !overridden} onClick={() => {
          const next = { ...values }; delete next[token.key]; update(next);
        }}>Reset override</button>
        {errors.length > 0 && <ul id={errorId} role="alert" className="list-disc pl-5">
          {errors.map((failure, errorIndex) => <li key={errorIndex}>{describe(failure.code)}.</li>)}
        </ul>}
      </fieldset>;
    })}
    <div className="flex flex-wrap gap-2">
      <button className={buttonClass} type="button" disabled={props.disabled || busy}
        onClick={validate}>Validate appearance</button>
      <button className={buttonClass} type="button" disabled={props.disabled || busy || !changed || feedback?.valid !== true || feedbackEpoch.current !== props.validationEpoch}
        onClick={apply}>Apply appearance</button>
      <button className={buttonClass} type="button" disabled={props.disabled || (!changed && !busy)}
        onClick={() => update(structuredClone(props.source.body.theme.token_overrides))}>Discard appearance edits</button>
    </div>
    <p className="text-sm">Applying affects local history only. Save persists through the current protected writer; publication and installation remain separate.</p>
  </section>;
}
