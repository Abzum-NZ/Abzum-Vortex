"use client";
import { Spinner } from "@vortex/ui/components/spinner";
import { Item, ItemContent, ItemGroup } from "@vortex/ui/components/item";
import { useState } from "react";
import {
  authoredApplicationThemeSelection,
  canonicalApplicationThemeSelection,
  effectiveThemeSelection,
  type SourceApplicationThemeSelection,
} from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { InputGroup, InputGroupInput, InputGroupAddon } from "@vortex/ui/components/input-group";
import { Notice } from "@vortex/ui/components/notice";
import { RadioGroup, RadioGroupItem } from "@vortex/ui/components/radio-group";
import { ToggleGroup, ToggleGroupItem } from "@vortex/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { NavigationLink } from "@vortex/ui/routing";
import { studioNotice } from "./studio-save-state";
import { cn } from "@vortex/ui/lib/utils";
import {
  StudioInspectorGroup,
  StudioOptionControl,
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
  type StudioThemePreset,
} from "../_lib/studio-theme-options";
import { StudioThemeChoices } from "./studio-theme-choice";
import { StudioPanelShell } from "./studio-frame";
import { StudioField } from "./studio-field";

/** What a theme change came to: in the draft, or refused with the reason. */
export type StudioThemeChangeOutcome = Readonly<{ kind: "applied" | "refused"; message: string }>;
type Feedback = StudioThemeChangeOutcome & Readonly<{ problems?: readonly string[] }>;

const shuffleAttempts = 8;

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
                    value === option.id && "inset-ring-2 inset-ring-primary",
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
        {studioThemeOptionLabel({ dimensions: [dimension], presets: [] }, dimension.key, value)}
      </p>
    </div>
  );
}

/**
 * The Theme tab: the platform presets and shadcn create's settings for the whole application, kept
 * in the draft's one theme selection. Each change, a preset, a swatch, a pasted preset code or
 * Shuffle, is resolved with the checks publication runs before it reaches the draft, and the canvas
 * then draws it. Only options of the pinned shadcn 4.21.0 catalogue are offered. The organisation
 * theme editor is this same panel: it passes no `base` and no `onPreset` (an organisation theme is
 * a selection, never a platform release pin), so a preset applies its settings, and it names its
 * own title and help.
 */
export function StudioThemePanel({
  title = "Theme",
  description = "How every page of this application looks. Changes show on the canvas and save automatically.",
  selection,
  base,
  options,
  disabled,
  hidden,
  onChange,
  onPreset,
  organizationThemeHref,
  shuffle: offerShuffle = true,
}: Readonly<{
  /** Whether Shuffle is offered; the organisation editor turns it off (one click would re-theme every application). */
  shuffle?: boolean;
  /** Where the organisation theme is edited; offered by an application's Theme tab, not by the editor itself. */
  organizationThemeHref?: string;
  title?: string;
  description?: string;
  selection: SourceApplicationThemeSelection;
  base?: Readonly<{ catalogue_theme_id: string; release_version: string }>;
  options: StudioThemeOptions;
  disabled: boolean;
  hidden: boolean;
  /** Puts a selection in the draft after it resolves, or says why it was refused. */
  onChange: (
    next: SourceApplicationThemeSelection,
    what: string,
  ) => Promise<StudioThemeChangeOutcome & Readonly<{ problems?: readonly string[] }>>;
  /** Puts a complete theme (its release and selection) in the draft after it resolves; without it a preset applies its settings. */
  onPreset?: (
    next: StudioThemePreset,
    what: string,
  ) => Promise<StudioThemeChangeOutcome & Readonly<{ problems?: readonly string[] }>>;
}>) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [code, setCode] = useState("");
  const locked = disabled || pending;
  const dimension = (key: StudioThemeDimensionKey) =>
    options.dimensions.find((entry) => entry.key === key)!;
  // What is drawn: a setting the application left at the platform default follows the organisation.
  const shown = authoredApplicationThemeSelection(
    effectiveThemeSelection(canonicalApplicationThemeSelection(selection), options.organization),
  );
  const follows = (...keys: StudioThemeDimensionKey[]) =>
    keys.filter((key) => shown[key] !== selection[key]);
  /** The marker of a group whose settings follow the organisation, with what they follow. */
  const followMarker = (...keys: StudioThemeDimensionKey[]) => {
    const following = follows(...keys);
    if (following.length === 0) return undefined;
    // A style is internal to a preset and never named.
    const names = following
      .filter((key) => key !== "style")
      .map((key) => studioThemeOptionLabel(options, key, shown[key]))
      .join(", ");
    return (
      <Tooltip>
        <TooltipTrigger render={<Badge variant="outline" />}>Organisation</TooltipTrigger>
        <TooltipContent>
          Follows the organisation theme{names.length === 0 ? "" : ` (${names})`}: a setting at the
          platform default follows it. Choose another value to override.
        </TooltipContent>
      </Tooltip>
    );
  };
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
        studioNotice(outcome.message, "success");
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
  // An application's preset is the release it pins; the organisation pins none, so its preset is
  // the one whose settings it holds.
  const selectedPreset =
    base === undefined
      ? options.presets.find((preset) =>
          options.dimensions.every((entry) => preset.selection[entry.key] === selection[entry.key]),
        )
      : options.presets.find(
          (preset) =>
            base.catalogue_theme_id === preset.base.catalogueThemeId &&
            base.release_version === preset.base.releaseVersion,
        );
  const applyPreset = async (preset: StudioThemePreset) => {
    if (locked) return;
    if (onPreset === undefined) {
      await change(preset.selection, `Theme ${preset.label} applied`);
      return;
    }
    setPending(true);
    try {
      const outcome = await onPreset(preset, `Theme ${preset.label} applied`);
      if (outcome.kind === "applied") {
        setFeedback(null);
        studioNotice(outcome.message, "success");
      } else setFeedback(outcome);
    } finally {
      setPending(false);
    }
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
          studioNotice(outcome.message, "success");
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
        <StudioOptionControl
          {...control}
          value={shown[entry.key]}
          options={entry.options.map((option) => ({ value: option.id, label: option.label }))}
          disabled={locked}
          onChange={(id) => pick(entry.key, id)}
        />
      )}
    </StudioField>
  );
  const segmented = (entry: StudioThemeDimension) => (
    <ToggleGroup
      aria-label={entry.label}
      variant="outline"
      value={[shown[entry.key]]}
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
      title={title}
      hidden={hidden}
      description={description}
      action={
        <div className="flex items-center gap-1">
          {organizationThemeHref !== undefined && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    nativeButton={false}
                    aria-label="Open the organisation theme"
                    render={<NavigationLink href={organizationThemeHref} />}
                  />
                }
              >
                <Icon name="palette" />
              </TooltipTrigger>
              <TooltipContent>
                Settings left at the platform default follow the organisation theme. Open it.
              </TooltipContent>
            </Tooltip>
          )}
          {offerShuffle && (
            <StudioIconButton
              label="Shuffle theme"
              disabled={locked}
              onClick={() => void shuffle()}
            >
              <Icon name="redo" />
            </StudioIconButton>
          )}
        </div>
      }
    >
      {feedback !== null && (
        <div className="space-y-1 text-sm">
          <Notice
            severity={feedback.kind === "refused" ? "error" : "info"}
            content={feedback.message}
          />
          {feedback.problems !== undefined && (
            <ItemGroup className="gap-0.5">
              {feedback.problems.map((problem) => (
                <Item key={problem} size="xs" role="listitem" className="p-0">
                  <ItemContent>{problem}</ItemContent>
                </Item>
              ))}
            </ItemGroup>
          )}
        </div>
      )}
      {pending && (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />
          Checking the theme…
        </div>
      )}
      <StudioInspectorGroup title="Presets" action={followMarker("style")}>
        <StudioThemeChoices
          presets={options.presets}
          selectedKey={selectedPreset?.key}
          disabled={locked}
          onPick={(preset) => void applyPreset(preset)}
        />
      </StudioInspectorGroup>
      {(["base_color", "theme", "chart_color"] as const).map((key) => (
        <StudioInspectorGroup key={key} title={dimension(key).label} action={followMarker(key)}>
          <Swatch
            dimension={dimension(key)}
            value={shown[key]}
            disabled={locked}
            onPick={(id) => pick(key, id)}
          />
        </StudioInspectorGroup>
      ))}
      <StudioInspectorGroup title="Radius" action={followMarker("radius")}>
        {segmented(dimension("radius"))}
      </StudioInspectorGroup>
      <StudioInspectorGroup title="Fonts" action={followMarker("body_font", "heading_font")}>
        {select(dimension("body_font"))}
        {select(dimension("heading_font"))}
      </StudioInspectorGroup>
      <StudioInspectorGroup title="Icons" action={followMarker("icon_library")}>
        {select(dimension("icon_library"))}
      </StudioInspectorGroup>
      <StudioInspectorGroup title="Menu" action={followMarker("menu_color", "menu_accent")}>
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
