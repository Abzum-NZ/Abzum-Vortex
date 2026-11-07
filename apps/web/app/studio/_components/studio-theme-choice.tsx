"use client";

import { ToggleGroup, ToggleGroupItem } from "@vortex/ui/components/toggle-group";
import type { StudioThemePreset } from "../_lib/studio-theme-options";

/** One theme's colours drawn as a header, a card, a badge and a button, in light and in dark. */
function PresetPreview({
  preset,
  mode,
}: Readonly<{ preset: StudioThemePreset; mode: "light" | "dark" }>) {
  const colours = preset.preview[mode];
  return (
    <span
      className="block space-y-2 rounded-md p-2"
      style={{ background: colours.background, color: colours.text }}
      aria-hidden="true"
    >
      <span className="flex flex-wrap items-center justify-between gap-1">
        <span className="text-xs font-semibold">Overview</span>
        <span
          className="rounded-full px-1.5 py-0.5 text-xs font-medium"
          style={{ background: colours.primary, color: colours.primaryForeground }}
        >
          {mode === "light" ? "Light" : "Dark"}
        </span>
      </span>
      <span className="block space-y-1 rounded p-1.5" style={{ background: colours.card }}>
        <span className="block text-xs opacity-70">A card in this theme.</span>
        <span
          className="inline-block rounded px-1.5 py-0.5 text-xs font-medium"
          style={{ background: colours.primary, color: colours.primaryForeground }}
        >
          Continue
        </span>
      </span>
    </span>
  );
}

/** One platform theme: its name, what it is for, and how it looks in light and dark. */
function StudioThemeChoice({ preset }: Readonly<{ preset: StudioThemePreset }>) {
  return (
    <ToggleGroupItem
      data-slot="theme-choice"
      value={preset.key}
      className="h-auto flex-col items-stretch justify-start gap-2 p-2 text-left whitespace-normal aria-pressed:inset-ring-2 aria-pressed:inset-ring-primary"
    >
      <span className="block text-sm font-medium">{preset.label}</span>
      <span className="block text-xs font-normal text-muted-foreground">{preset.description}</span>
      <span className="grid min-w-0 grid-cols-1 gap-2">
        <PresetPreview preset={preset} mode="light" />
        <PresetPreview preset={preset} mode="dark" />
      </span>
    </ToggleGroupItem>
  );
}

/**
 * The one way to choose a theme, on an application's Theme tab and on the organisation theme page:
 * the platform presets as cards. A preset's shadcn style is internal to it and is never named.
 */
export function StudioThemeChoices({
  presets,
  selectedKey,
  disabled,
  onPick,
}: Readonly<{
  presets: readonly StudioThemePreset[];
  selectedKey: string | undefined;
  disabled: boolean;
  onPick: (preset: StudioThemePreset) => void;
}>) {
  return (
    <ToggleGroup
      aria-label="Themes"
      variant="outline"
      spacing={3}
      value={selectedKey === undefined ? [] : [selectedKey]}
      disabled={disabled}
      onValueChange={(next) => {
        const preset = presets.find((candidate) => candidate.key === next[0]);
        if (preset !== undefined) onPick(preset);
      }}
      className="grid w-full grid-cols-1 sm:grid-cols-2"
    >
      {presets.map((preset) => (
        <StudioThemeChoice key={preset.key} preset={preset} />
      ))}
    </ToggleGroup>
  );
}
