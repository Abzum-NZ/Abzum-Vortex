"use client";
import { useState, type ReactNode } from "react";
import type { SourceApplicationThemeSelection } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { cn } from "@vortex/ui/lib/utils";
import { decodeStudioThemePreset, encodeStudioThemePreset, shuffleStudioThemeSelection } from "@vortex/ui/studio";
import {
  studioThemeOptionLabel, studioThemeUnofferedSetting,
  type StudioThemeDimension, type StudioThemeDimensionKey, type StudioThemeOptions,
} from "../_lib/studio-theme-options";
import { StudioPanelShell } from "./studio-frame";
import { StudioField } from "./studio-field";

/** What a theme change came to: in the draft, or refused with the reason. */
export type StudioThemeChangeOutcome = Readonly<{ kind: "applied" | "refused"; message: string }>;
type Feedback = StudioThemeChangeOutcome & Readonly<{ problems?: readonly string[] }>;

const shuffleAttempts = 8;

/** One colour option drawn as a swatch: its light colour over its dark one. */
function Swatch({ dimension, value, disabled, onPick }: Readonly<{
  dimension: StudioThemeDimension; value: string; disabled: boolean; onPick: (id: string) => void;
}>) {
  return <fieldset className="space-y-1">
    <legend className="text-sm font-medium">{dimension.label}</legend>
    <div role="radiogroup" aria-label={dimension.label} className="flex flex-wrap gap-1.5">
      {dimension.options.map((option) => <button key={option.id} type="button" role="radio" aria-checked={value === option.id}
        aria-label={option.label} title={option.label} disabled={disabled} onClick={() => { if (value !== option.id) onPick(option.id); }}
        className={cn("size-7 overflow-hidden rounded-full border-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          value === option.id ? "border-foreground" : "border-border")}
        style={option.swatch === undefined ? undefined
          : { background: `linear-gradient(135deg, ${option.swatch.light} 50%, ${option.swatch.dark} 50%)` }} />)}
    </div>
    <p className="text-xs text-muted-foreground">{studioThemeOptionLabel({ dimensions: [dimension] }, dimension.key, value)}. {dimension.hint}</p>
  </fieldset>;
}

/**
 * The Theme tab: shadcn create's settings for the whole application, kept in the draft's one theme
 * selection. Each change, a swatch, a pasted preset code or Shuffle, is resolved with the checks
 * publication runs before it reaches the draft, and the canvas then draws it; Studio's own frame
 * keeps the platform theme. Only options of the pinned shadcn 4.21.0 catalogue are offered.
 */
export function StudioThemePanel({ selection, options, disabled, hidden, onChange, advanced }: Readonly<{
  selection: SourceApplicationThemeSelection;
  options: StudioThemeOptions;
  disabled: boolean;
  hidden: boolean;
  /** Puts a selection in the draft after it resolves, or says why it was refused. */
  onChange: (next: SourceApplicationThemeSelection, what: string) => Promise<StudioThemeChangeOutcome & Readonly<{ problems?: readonly string[] }>>;
  /** The individual token settings, for fine adjustments. */
  advanced: ReactNode;
}>) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [code, setCode] = useState("");
  const locked = disabled || pending;
  const dimension = (key: StudioThemeDimensionKey) => options.dimensions.find((entry) => entry.key === key)!;
  let current = "";
  try { current = encodeStudioThemePreset(selection); } catch (error) { console.error("[studio] the theme has no preset code", error); }

  const change = async (next: SourceApplicationThemeSelection, what: string) => {
    if (locked) return false;
    const unoffered = studioThemeUnofferedSetting(options, next);
    if (unoffered !== undefined) {
      setFeedback({ kind: "refused", message: `${unoffered.dimension.label} “${unoffered.value}” is not an option of the pinned shadcn 4.21.0 catalogue, so nothing was changed.` });
      return false;
    }
    setPending(true);
    try {
      const outcome = await onChange(next, what);
      setFeedback(outcome);
      return outcome.kind === "applied";
    } finally { setPending(false); }
  };
  const pick = (key: StudioThemeDimensionKey, id: string) => {
    void change({ ...selection, [key]: id }, `${dimension(key).label} set to ${studioThemeOptionLabel(options, key, id)}`);
  };
  // A pasted code applies as soon as it reads as a preset; a code that does not is explained on Enter or when leaving the field.
  const paste = async (next: string, explain: boolean) => {
    setCode(next);
    if (next.trim().length === 0) return;
    const decoded = decodeStudioThemePreset(next);
    if (decoded.kind === "refused") { if (explain) setFeedback({ kind: "refused", message: decoded.message }); return; }
    if (await change(decoded.selection, `Preset ${next.trim()} applied`)) setCode("");
  };
  const shuffle = async () => {
    if (locked) return;
    for (let attempt = 0; attempt < shuffleAttempts; attempt += 1) {
      const next = shuffleStudioThemeSelection();
      if (studioThemeUnofferedSetting(options, next) !== undefined) continue;
      setPending(true);
      try {
        const outcome = await onChange(next, "Shuffled");
        if (outcome.kind === "applied") { setFeedback(outcome); return; }
        if (outcome.problems === undefined) { setFeedback(outcome); return; }
      } finally { setPending(false); }
    }
    setFeedback({ kind: "refused", message: `Shuffle drew ${shuffleAttempts} combinations the readability checks refuse. Nothing was changed; try again.` });
  };

  return <StudioPanelShell title="Theme" hidden={hidden}
    description="shadcn create settings for the whole application. The canvas shows each change at once, and it is saved automatically."
    action={<Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => { void shuffle(); }}>
      Shuffle</Button>}>
    <section aria-label="Preset code" className="space-y-2">
      <p className="text-sm">Preset code <span className="font-mono tabular-nums">{current}</span></p>
      <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void paste(code, true); }}>
        <StudioField label="Paste a shadcn preset code" hint="From ui.shadcn.com/create, for example b5eFaVxg0. It applies as soon as it is read.">
          {(control) => <Input {...control} value={code} maxLength={12} disabled={locked} spellCheck={false}
            onChange={(event) => { void paste(event.target.value, false); }}
            onBlur={() => { void paste(code, true); }} />}
        </StudioField>
      </form>
    </section>
    {feedback !== null && <div role={feedback.kind === "refused" ? "alert" : "status"}
      className={feedback.kind === "refused" ? "space-y-1 text-sm text-destructive" : "text-sm text-muted-foreground"}>
      <p>{feedback.message}</p>
      {feedback.problems !== undefined && <ul className="list-disc pl-5">{feedback.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
    </div>}
    {pending && <p role="status" className="text-sm text-muted-foreground">Checking the theme…</p>}
    <Swatch dimension={dimension("theme")} value={selection.theme} disabled={locked} onPick={(id) => pick("theme", id)} />
    <Swatch dimension={dimension("base_color")} value={selection.base_color} disabled={locked} onPick={(id) => pick("base_color", id)} />
    {options.dimensions.map((entry) => <StudioField key={entry.key} label={entry.label}
      hint={entry.options.find((option) => option.id === selection[entry.key])?.description ?? entry.hint}
      error={entry.options.some((option) => option.id === selection[entry.key]) ? undefined
        : `“${selection[entry.key]}” is not an option of the pinned catalogue. Choose another.`}>
      {(control) => <NativeSelect {...control} value={selection[entry.key]} disabled={locked}
        onChange={(event) => pick(entry.key, event.target.value)}>
        {entry.options.some((option) => option.id === selection[entry.key]) ? null
          : <NativeSelectOption value={selection[entry.key]}>Not offered</NativeSelectOption>}
        {entry.options.map((option) => <NativeSelectOption key={option.id} value={option.id}>{option.label}</NativeSelectOption>)}
      </NativeSelect>}
    </StudioField>)}
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Fine-tune individual colours and type</summary>
      <div className="mt-3">{advanced}</div>
    </details>
  </StudioPanelShell>;
}
