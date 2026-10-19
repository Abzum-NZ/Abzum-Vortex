"use client";
import { useState } from "react";
import type { SourceApplicationThemeSelection } from "@vortex/platform/schema";
import { createVortexStyleRootProps, Icon, VORTEX_STYLES } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { InputGroup, InputGroupInput, InputGroupAddon } from "@vortex/ui/components/input-group";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { RadioGroup, RadioGroupItem } from "@vortex/ui/components/radio-group";
import { ToggleGroup, ToggleGroupItem } from "@vortex/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { toast } from "@vortex/ui/components/sonner";
import { cn } from "@vortex/ui/lib/utils";
import {
  StudioInspectorGroup,
  StudioIconButton,
  StudioCopyButton,
  decodeStudioThemePreset,
  encodeStudioThemePreset,
  shuffleStudioThemeSelection,
} from "@vortex/ui/studio";
import {
  studioThemeOptionLabel,
  studioThemeUnofferedSetting,
  type StudioThemeDimension,
  type StudioThemeDimensionKey,
  type StudioThemeOptions,
} from "../_lib/studio-theme-options";
import { StudioPanelShell } from "./studio-frame";
import { StudioField } from "./studio-field";

/** What a theme change came to: in the draft, or refused with the reason. */
export type StudioThemeChangeOutcome = Readonly<{ kind: "applied" | "refused"; message: string }>;
type Feedback = StudioThemeChangeOutcome & Readonly<{ problems?: readonly string[] }>;

const shuffleAttempts = 8;

// Use the runtime's complete style variables and shared components, including nested-scope resets.
const stylePreviews = new Map(
  VORTEX_STYLES.map((style) => [
    style as string,
    createVortexStyleRootProps({ style, menu: "default", menuAccent: "subtle" }),
  ]),
);

function StylePreview({ style }: Readonly<{ style: string }>) {
  const props = stylePreviews.get(style);
  if (props === undefined) throw new Error(`No preview for catalogue style ${style}`);
  return (
    <div {...props} data-vortex-theme="" aria-hidden="true" inert>
      <div style={{ zoom: 0.65 }}>
        <div className="space-y-3 bg-background p-3 text-foreground">
          <p className="text-sm font-semibold">Overview</p>

          <div className="flex items-center gap-2">
            <Input placeholder="Search" tabIndex={-1} />
            <Button type="button" tabIndex={-1}>
              Go
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Native radio semantics and arrow-key navigation, with colours supplied by the catalogue. */
function Swatch({
  dimension,
  value,
  disabled,
  onPick,
}: Readonly<{
  dimension: StudioThemeDimension;
  value: string;
  disabled: boolean;
  onPick: (id: string) => void;
}>) {
  return (
    <div className="space-y-3">
      <RadioGroup
        aria-label={dimension.label}
        value={value}
        disabled={disabled}
        onValueChange={(next) => onPick(String(next))}
        className="flex flex-wrap gap-3"
      >
        {dimension.options.map((option) => (
          <Tooltip key={option.id}>
            <TooltipTrigger
              render={
                <RadioGroupItem
                  value={option.id}
                  aria-label={option.label}
                  className={cn(
                    "size-7 overflow-hidden rounded-full [&_[data-slot=radio-group-indicator]]:hidden",
                    value === option.id &&
                      "ring-2 ring-primary ring-offset-2 ring-offset-background",
                  )}
                  style={
                    option.swatch === undefined
                      ? undefined
                      : {
                          background: `linear-gradient(135deg, ${option.swatch.light} 50%, ${option.swatch.dark} 50%)`,
                        }
                  }
                />
              }
            />
            <TooltipContent>{option.label}</TooltipContent>
          </Tooltip>
        ))}
      </RadioGroup>
      <p className="text-sm text-muted-foreground">
        {studioThemeOptionLabel({ dimensions: [dimension] }, dimension.key, value)}
      </p>
    </div>
  );
}

/**
 * The Theme tab: shadcn create's settings for the whole application, kept in the draft's one theme
 * selection. Each change, a swatch, a pasted preset code or Shuffle, is resolved with the checks
 * publication runs before it reaches the draft, and the canvas then draws it; Studio's own frame
 * keeps its Studio theme. Only options of the pinned shadcn 4.21.0 catalogue are offered.
 */
export function StudioThemePanel({
  selection,
  options,
  disabled,
  hidden,
  onChange,
}: Readonly<{
  selection: SourceApplicationThemeSelection;
  options: StudioThemeOptions;
  disabled: boolean;
  hidden: boolean;
  /** Puts a selection in the draft after it resolves, or says why it was refused. */
  onChange: (
    next: SourceApplicationThemeSelection,
    what: string,
  ) => Promise<StudioThemeChangeOutcome & Readonly<{ problems?: readonly string[] }>>;
}>) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [code, setCode] = useState("");
  const locked = disabled || pending;
  const dimension = (key: StudioThemeDimensionKey) =>
    options.dimensions.find((entry) => entry.key === key)!;
  let current = "";
  try {
    current = encodeStudioThemePreset(selection);
  } catch (error) {
    console.error("[studio] the theme has no preset code", error);
  }

  const change = async (next: SourceApplicationThemeSelection, what: string) => {
    if (locked) return false;
    const unoffered = studioThemeUnofferedSetting(options, next);
    if (unoffered !== undefined) {
      setFeedback({
        kind: "refused",
        message: `${unoffered.dimension.label} “${unoffered.value}” is not an available theme option, so nothing was changed.`,
      });
      return false;
    }
    setPending(true);
    try {
      const outcome = await onChange(next, what);
      if (outcome.kind === "applied") {
        setFeedback(null);
        toast.success(outcome.message);
      } else setFeedback(outcome);
      return outcome.kind === "applied";
    } finally {
      setPending(false);
    }
  };
  const pick = (key: StudioThemeDimensionKey, id: string) => {
    void change(
      { ...selection, [key]: id },
      `${dimension(key).label} set to ${studioThemeOptionLabel(options, key, id)}`,
    );
  };
  // A pasted code applies as soon as it reads as a preset; a code that does not is explained on Enter or when leaving the field.
  const paste = async (next: string, explain: boolean) => {
    setCode(next);
    if (next.trim().length === 0) return;
    const decoded = decodeStudioThemePreset(next);
    if (decoded.kind === "refused") {
      if (explain) setFeedback({ kind: "refused", message: decoded.message });
      return;
    }
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
        if (outcome.kind === "applied") {
          setFeedback(null);
          toast.success(outcome.message);
          return;
        }
        if (outcome.problems === undefined) {
          setFeedback(outcome);
          return;
        }
      } finally {
        setPending(false);
      }
    }
    setFeedback({
      kind: "refused",
      message: `Shuffle drew ${shuffleAttempts} combinations the readability checks refuse. Nothing was changed; try again.`,
    });
  };

  const select = (entry: StudioThemeDimension) => (
    <StudioField label={entry.label}>
      {(control) => (
        <NativeSelect
          {...control}
          value={selection[entry.key]}
          disabled={locked}
          onChange={(event) => pick(entry.key, event.target.value)}
        >
          {entry.options.some((option) => option.id === selection[entry.key]) ? null : (
            <NativeSelectOption value={selection[entry.key]}>Not offered</NativeSelectOption>
          )}
          {entry.options.map((option) => (
            <NativeSelectOption key={option.id} value={option.id}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
    </StudioField>
  );
  const segmented = (entry: StudioThemeDimension) => (
    <ToggleGroup
      aria-label={entry.label}
      variant="outline"
      value={[selection[entry.key]]}
      disabled={locked}
      className="max-w-full flex-wrap"
      onValueChange={(next) => {
        if (next[0] !== undefined) pick(entry.key, next[0]);
      }}
    >
      {entry.options.map((option) => (
        <ToggleGroupItem
          key={option.id}
          value={option.id}
          aria-label={`${entry.label}: ${option.label}`}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );

  return (
    <StudioPanelShell
      title="Theme"
      hidden={hidden}
      description="How every page of this application looks. Changes show on the canvas and save automatically."
      action={
        <StudioIconButton label="Shuffle theme" disabled={locked} onClick={() => void shuffle()}>
          <Icon name="redo" />
        </StudioIconButton>
      }
    >
      {feedback !== null && (
        <div
          role={feedback.kind === "refused" ? "alert" : "status"}
          className={
            feedback.kind === "refused"
              ? "space-y-1 text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          <p>{feedback.message}</p>
          {feedback.problems !== undefined && (
            <ul className="list-disc pl-5">
              {feedback.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          Checking the theme…
        </p>
      )}
      <StudioInspectorGroup title="Style">
        <RadioGroup
          aria-label="Style"
          value={selection.style}
          disabled={locked}
          onValueChange={(next) => pick("style", String(next))}
          className="grid grid-cols-2 gap-3"
        >
          {dimension("style").options.map((option) => (
            <div
              key={option.id}
              className={cn(
                "relative cursor-pointer space-y-2 rounded-lg p-2 hover:bg-accent focus-within:ring-2 focus-within:ring-ring",
                selection.style === option.id && "ring-2 ring-primary",
                locked && "cursor-not-allowed opacity-50",
              )}
            >
              <RadioGroupItem
                id={`studio-theme-style-${option.id}`}
                value={option.id}
                aria-labelledby={`studio-theme-style-${option.id}-caption`}
                className="sr-only"
              />
              <StylePreview style={option.id} />
              <span
                id={`studio-theme-style-${option.id}-caption`}
                className="block text-sm font-medium"
              >
                {option.label}
              </span>
              {/* The whole tile selects the radio; sample controls remain inert and outside its label. */}
              <label
                htmlFor={`studio-theme-style-${option.id}`}
                aria-hidden="true"
                className="absolute inset-0 cursor-inherit"
              />
            </div>
          ))}
        </RadioGroup>
      </StudioInspectorGroup>
      {(["base_color", "theme", "chart_color"] as const).map((key) => (
        <StudioInspectorGroup key={key} title={dimension(key).label}>
          <Swatch
            dimension={dimension(key)}
            value={selection[key]}
            disabled={locked}
            onPick={(id) => pick(key, id)}
          />
        </StudioInspectorGroup>
      ))}
      <StudioInspectorGroup title="Radius">{segmented(dimension("radius"))}</StudioInspectorGroup>
      <StudioInspectorGroup title="Fonts">
        {select(dimension("body_font"))}
        {select(dimension("heading_font"))}
      </StudioInspectorGroup>
      <StudioInspectorGroup title="Icons">{select(dimension("icon_library"))}</StudioInspectorGroup>
      <StudioInspectorGroup title="Menu">
        <div className="space-y-2">
          <p className="text-sm font-medium">Colour</p>
          {segmented(dimension("menu_color"))}
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Accent</p>
          {segmented(dimension("menu_accent"))}
        </div>
      </StudioInspectorGroup>
      <StudioInspectorGroup title="Preset code" defaultOpen={false}>
        <InputGroup>
          <InputGroupInput
            aria-label="Current preset code"
            value={current}
            readOnly
            className="tabular-nums"
          />
          <InputGroupAddon align="inline-end">
            <StudioCopyButton label="Copy preset code" value={current} />
          </InputGroupAddon>
        </InputGroup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void paste(code, true);
          }}
        >
          <StudioField label="Paste preset code" hint="Paste a preset code to apply it.">
            {(control) => (
              <InputGroup>
                <InputGroupInput
                  {...control}
                  value={code}
                  maxLength={12}
                  disabled={locked}
                  spellCheck={false}
                  onChange={(event) => {
                    void paste(event.target.value, false);
                  }}
                  onBlur={() => {
                    void paste(code, true);
                  }}
                />
              </InputGroup>
            )}
          </StudioField>
        </form>
      </StudioInspectorGroup>
    </StudioPanelShell>
  );
}
