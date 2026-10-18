"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { SourceApplicationThemeSelection } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vortex/ui/components/collapsible";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@vortex/ui/components/input-group";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { RadioGroup, RadioGroupItem } from "@vortex/ui/components/radio-group";
import { ToggleGroup, ToggleGroupItem } from "@vortex/ui/components/toggle-group";
import { toast } from "@vortex/ui/components/sonner";
import { cn } from "@vortex/ui/lib/utils";
import {
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

/** Remember each theme disclosure independently, including the closed preset-code form. */
function ThemeSection({
  title,
  children,
  initiallyOpen = true,
}: Readonly<{ title: string; children: ReactNode; initiallyOpen?: boolean }>) {
  const [open, setOpen] = useState(initiallyOpen);
  const key = `vortex.studio.theme-section:${title}`;
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) setOpen(stored === "true");
    } catch {
      /* Storage is optional for disclosure state. */
    }
  }, [key]);
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        try {
          localStorage.setItem(key, String(next));
        } catch {
          /* Keep this visit's state. */
        }
      }}
      className="space-y-3"
    >
      <CollapsibleTrigger className="flex min-h-8 w-full items-center justify-between rounded-md text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
        {title}
        <Icon name={open ? "chevron-down" : "chevron-right"} className="size-4" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4">{children}</CollapsibleContent>
    </Collapsible>
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
          <RadioGroupItem
            key={option.id}
            value={option.id}
            aria-label={option.label}
            title={option.label}
            className={cn(
              "size-7 overflow-hidden rounded-full [&_[data-slot=radio-group-indicator]]:hidden",
              value === option.id && "ring-2 ring-primary ring-offset-2 ring-offset-background",
            )}
            style={
              option.swatch === undefined
                ? undefined
                : {
                    background: `linear-gradient(135deg, ${option.swatch.light} 50%, ${option.swatch.dark} 50%)`,
                  }
            }
          />
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
        message: `${unoffered.dimension.label} “${unoffered.value}” is not an option of the pinned shadcn 4.21.0 catalogue, so nothing was changed.`,
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(current);
      setFeedback(null);
      toast.success("Preset code copied.");
    } catch (error) {
      console.error("[studio] could not copy the theme preset", error);
      setFeedback({
        kind: "refused",
        message: "Could not copy the preset code. Select and copy it below.",
      });
    }
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
      description="shadcn create settings for the whole application. The canvas shows each change at once, and it is saved automatically."
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={locked}
          onClick={() => {
            void shuffle();
          }}
        >
          Shuffle
        </Button>
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
      <ThemeSection title="Style">
        <RadioGroup
          aria-label="Style"
          value={selection.style}
          disabled={locked}
          onValueChange={(next) => pick("style", String(next))}
          className="grid grid-cols-2 gap-3"
        >
          {dimension("style").options.map((option) => (
            <label
              key={option.id}
              className={cn(
                "relative cursor-pointer space-y-2 rounded-lg border p-2 focus-within:ring-2 focus-within:ring-ring",
                selection.style === option.id && "ring-2 ring-primary",
                locked && "cursor-not-allowed opacity-50",
              )}
            >
              <RadioGroupItem value={option.id} className="sr-only" />
              <div
                aria-hidden="true"
                className="space-y-2 rounded-md bg-muted/50 p-2 text-foreground"
              >
                <div className="h-2 w-2/3 rounded-sm bg-foreground/30" />
                <div className="flex gap-1">
                  <div className="h-6 flex-1 rounded-md border bg-background" />
                  <div className="h-6 w-8 rounded-md bg-foreground/20" />
                </div>
              </div>
              <span className="block text-sm font-medium">{option.label}</span>
            </label>
          ))}
        </RadioGroup>
      </ThemeSection>
      {(["base_color", "theme", "chart_color"] as const).map((key) => (
        <ThemeSection key={key} title={dimension(key).label}>
          <Swatch
            dimension={dimension(key)}
            value={selection[key]}
            disabled={locked}
            onPick={(id) => pick(key, id)}
          />
        </ThemeSection>
      ))}
      <ThemeSection title="Radius">{segmented(dimension("radius"))}</ThemeSection>
      <ThemeSection title="Fonts">
        {select(dimension("body_font"))}
        {select(dimension("heading_font"))}
      </ThemeSection>
      <ThemeSection title="Icons">{select(dimension("icon_library"))}</ThemeSection>
      <ThemeSection title="Menu">
        <div className="space-y-2">
          <p className="text-sm font-medium">Colour</p>
          {segmented(dimension("menu_color"))}
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Accent</p>
          {segmented(dimension("menu_accent"))}
        </div>
      </ThemeSection>
      <ThemeSection title="Preset code" initiallyOpen={false}>
        <InputGroup>
          <InputGroupInput
            aria-label="Current preset code"
            value={current}
            readOnly
            className="tabular-nums"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label="Copy preset code"
              onClick={() => {
                void copy();
              }}
            >
              Copy
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void paste(code, true);
          }}
        >
          <StudioField label="Paste preset code" hint="Paste a shadcn create code to apply it.">
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
      </ThemeSection>
    </StudioPanelShell>
  );
}
